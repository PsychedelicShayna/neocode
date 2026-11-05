import { assert, describe, it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";

import {
  makeNeoPiNativeSettledStore,
  resolveNativeSettlement,
  type NeoPiNativeSettledRecord,
} from "./NeoPiNativeSettlement.ts";

const DAY = 24 * 60 * 60 * 1_000;
const modifiedAt = "2026-10-01T00:00:00.000Z";
const now = Date.parse(modifiedAt) + 10 * DAY;
const settled: NeoPiNativeSettledRecord = {
  state: "settled",
  settledAt: "2026-10-02T00:00:00.000Z",
  modifiedAt,
};
const resolve = (overrides: Partial<Parameters<typeof resolveNativeSettlement>[0]> = {}) =>
  resolveNativeSettlement({
    record: undefined,
    modifiedAt,
    live: undefined,
    autoSettleAfterDays: null,
    now,
    ...overrides,
  });

describe("resolveNativeSettlement", () => {
  it("keeps a manual settle while the file is unchanged and the owner is idle", () => {
    assert.deepEqual(resolve({ record: settled, live: { state: "idle" } }), {
      settledAt: settled.settledAt,
      retain: true,
    });
  });

  it("wakes a settled session on newer activity or a busy or blocked owner", () => {
    const woken = { settledAt: null, retain: false };
    assert.deepEqual(resolve({ record: settled, modifiedAt: "2026-10-02T00:00:00.000Z" }), woken);
    assert.deepEqual(resolve({ record: settled, live: { state: "busy" } }), woken);
    assert.deepEqual(resolve({ record: settled, live: { state: "waiting" } }), woken);
  });

  it("auto-settles once idle past the window, dated from when the window elapsed", () => {
    assert.deepEqual(resolve({ autoSettleAfterDays: 3 }), {
      settledAt: "2026-10-04T00:00:00.000Z",
      retain: false,
    });
    assert.equal(resolve({ autoSettleAfterDays: 14 }).settledAt, null);
    assert.equal(resolve({ autoSettleAfterDays: null }).settledAt, null);
  });

  it("never auto-settles a session whose owner is working or blocked", () => {
    assert.equal(resolve({ autoSettleAfterDays: 3, live: { state: "busy" } }).settledAt, null);
    assert.equal(resolve({ autoSettleAfterDays: 3, live: { state: "waiting" } }).settledAt, null);
    assert.equal(
      resolve({ autoSettleAfterDays: 3, live: { state: "idle" } }).settledAt !== null,
      true,
    );
  });

  it("lets an explicit un-settle hold off auto-settling until new activity", () => {
    const unsettled: NeoPiNativeSettledRecord = { ...settled, state: "unsettled" };
    assert.deepEqual(resolve({ record: unsettled, autoSettleAfterDays: 3 }), {
      settledAt: null,
      retain: true,
    });
    assert.equal(
      resolve({
        record: unsettled,
        autoSettleAfterDays: 3,
        modifiedAt: "2026-10-05T00:00:00.000Z",
      }).settledAt,
      "2026-10-08T00:00:00.000Z",
    );
  });
});

describe("makeNeoPiNativeSettledStore", () => {
  it.effect("persists decisions across restarts and survives an unreadable file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const filePath = `${dir}/settled.json`;
      const first = yield* makeNeoPiNativeSettledStore(filePath);
      yield* first.update([
        ["/a.jsonl", settled],
        ["/b.jsonl", { ...settled, state: "unsettled" }],
      ]);
      yield* first.update([["/b.jsonl", null, (yield* first.read).get("/b.jsonl")!]]);
      const second = yield* makeNeoPiNativeSettledStore(filePath);
      assert.deepEqual(Array.from(yield* second.read), [["/a.jsonl", settled]]);

      yield* fs.writeFileString(filePath, "{not json");
      assert.equal((yield* (yield* makeNeoPiNativeSettledStore(filePath)).read).size, 0);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );

  it.effect("checks a stale cleanup after a pending decision finishes writing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const filePath = `${dir}/settled.json`;
      const writing = yield* Deferred.make<void>();
      const releaseWrite = yield* Deferred.make<void>();
      let blockWrite = false;
      const store = yield* makeNeoPiNativeSettledStore(filePath).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.FileSystem.of({
            ...fs,
            writeFileString: (path, contents, options) =>
              Effect.gen(function* () {
                if (blockWrite) {
                  blockWrite = false;
                  yield* Deferred.succeed(writing, undefined);
                  yield* Deferred.await(releaseWrite);
                }
                yield* fs.writeFileString(path, contents, options);
              }),
          }),
        ),
      );
      yield* store.update([
        ["/a.jsonl", settled],
        ["/b.jsonl", settled],
      ]);
      const snapshot = yield* store.read;
      // Even an identical decision is newer than the snapshot used by cleanup.
      const newer = { ...settled };
      blockWrite = true;
      const decision = yield* store.update([["/a.jsonl", newer]]).pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      assert.equal((yield* store.read).get("/a.jsonl"), snapshot.get("/a.jsonl"));
      const cleanup = yield* store
        .update([
          ["/a.jsonl", null, snapshot.get("/a.jsonl")!],
          ["/b.jsonl", null, snapshot.get("/b.jsonl")!],
        ])
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(releaseWrite, undefined);
      yield* Fiber.join(decision);
      yield* Fiber.join(cleanup);

      assert.equal((yield* store.read).get("/a.jsonl"), newer);
      assert.equal((yield* store.read).has("/b.jsonl"), false);
      const restarted = yield* makeNeoPiNativeSettledStore(filePath);
      assert.deepEqual(Array.from(yield* restarted.read), [["/a.jsonl", newer]]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );
});
