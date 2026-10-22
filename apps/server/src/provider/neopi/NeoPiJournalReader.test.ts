import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NeoPiRpcError } from "effect-neopi-rpc/errors";
import type { NeoPiRpcClient } from "effect-neopi-rpc/client";
import { decodeNeoPiJournalCli, readNeoPiJournalPeer } from "./NeoPiJournalReader.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const identity = { sessionId: "native-session", sessionFile: "/sessions/native.jsonl" };
const entry = {
  id: "entry-1",
  parentId: null,
  type: "custom",
  timestamp: "2026-10-22T00:00:00.000Z",
  customType: "extension-record",
  data: { nested: ["preserve", 123] },
};
const page = {
  ...identity,
  entries: [entry],
  leafId: entry.id,
  totalEntries: 2501,
  nextCursor: "opaque-native-cursor",
};
const peer = (
  request: NeoPiRpcClient["request"],
  capabilities = new Set(["session_journal"]),
): Pick<NeoPiRpcClient, "request" | "capabilities"> => ({ request, capabilities });

const readPeer = (
  client: Pick<NeoPiRpcClient, "capabilities" | "request">,
  expected: Parameters<typeof readNeoPiJournalPeer>[1],
  options: Parameters<typeof readNeoPiJournalPeer>[2],
) => readNeoPiJournalPeer(client, expected, options, (file) => Effect.succeed(file));
describe("native journal readers", () => {
  it.effect("preserves canonical CLI entries and native paging metadata", () =>
    Effect.gen(function* () {
      const result = yield* decodeNeoPiJournalCli(encodeJson(page), 0, identity);
      assert.deepEqual(result, { status: "available", page });
    }),
  );

  it.effect("matches a live owner's symlink path to the canonical journal file", () =>
    Effect.gen(function* () {
      const alias = "/alias/native.jsonl";
      const result = yield* readNeoPiJournalPeer(
        peer((command) =>
          Effect.succeed(command.type === "get_state" ? { ...identity, sessionFile: alias } : page),
        ),
        identity,
        {},
        (file) => Effect.succeed(file === alias ? identity.sessionFile : file),
      );
      assert.deepEqual(result, { status: "available", page });
    }),
  );

  it.effect("discards a read if a live owner's symlink changes target", () =>
    Effect.gen(function* () {
      let resolved = 0;
      const result = yield* readNeoPiJournalPeer(
        peer((command) =>
          Effect.succeed(
            command.type === "get_state"
              ? { ...identity, sessionFile: "/alias/native.jsonl" }
              : page,
          ),
        ),
        identity,
        {},
        () => Effect.succeed(++resolved === 1 ? identity.sessionFile : "/sessions/other.jsonl"),
      );
      assert.equal(result.status, "error");
      if (result.status === "error") assert.equal(result.code, "stale_cursor");
    }),
  );

  it.effect("retains a whole entry larger than the native soft page budget", () =>
    Effect.gen(function* () {
      const text = "x".repeat(800 * 1024);
      const large = {
        ...page,
        entries: [{ ...entry, type: "message", message: { role: "user", content: text } }],
      };
      const result = yield* decodeNeoPiJournalCli(encodeJson(large), 0, identity);
      assert.deepEqual(result, { status: "available", page: large });
    }),
  );

  it.effect("decodes machine-readable errors despite a nonzero CLI exit", () =>
    Effect.gen(function* () {
      for (const code of [
        "leaf_changed",
        "stale_cursor",
        "legacy_history_identity_required",
        "invalid_cursor",
        "session_busy",
      ]) {
        const result = yield* decodeNeoPiJournalCli(
          encodeJson({ error: { code, message: "native explanation" } }),
          1,
          identity,
        );
        assert.deepEqual(result, { status: "error", code, message: "native explanation" });
      }
    }),
  );

  it.effect("does not treat failed or incomplete output as a successful partial page", () =>
    Effect.gen(function* () {
      assert.equal((yield* decodeNeoPiJournalCli(encodeJson(page), 7, identity)).status, "error");
      assert.equal((yield* decodeNeoPiJournalCli("{", 0, identity)).status, "error");
      assert.equal(
        (yield* decodeNeoPiJournalCli(
          encodeJson({ ...page, entries: [{ type: "message" }] }),
          0,
          identity,
        )).status,
        "error",
      );
    }),
  );

  it.effect("rejects a page returned for a different session or file", () =>
    Effect.gen(function* () {
      for (const altered of [
        { ...page, sessionId: "other" },
        { ...page, sessionFile: "/sessions/other.jsonl" },
      ]) {
        const result = yield* decodeNeoPiJournalCli(encodeJson(altered), 0, identity);
        assert.equal(result.status, "error");
        if (result.status === "error") assert.equal(result.code, "stale_cursor");
      }
    }),
  );

  it.effect("does not read an owner that lacks the native capability", () =>
    Effect.gen(function* () {
      let requested = false;
      const result = yield* readPeer(
        peer(() => {
          requested = true;
          return Effect.succeed(page);
        }, new Set()),
        identity,
        {},
      );
      assert.equal(result.status, "unavailable");
      assert.equal(requested, false);
    }),
  );

  it.effect("refuses an identity mismatch before reading journal content", () =>
    Effect.gen(function* () {
      let journalRead = false;
      const result = yield* readPeer(
        peer((command) => {
          if (command.type !== "get_state") journalRead = true;
          return Effect.succeed({ ...identity, sessionId: "other" });
        }),
        identity,
        {},
      );
      assert.equal(journalRead, false);
      assert.equal(result.status, "error");
      if (result.status === "error") assert.equal(result.code, "stale_cursor");
    }),
  );

  it.effect("discards a native page if the owner changes identity during its read", () =>
    Effect.gen(function* () {
      let stateRead = 0;
      const result = yield* readPeer(
        peer((command) =>
          Effect.succeed(
            command.type === "get_state"
              ? ++stateRead === 1
                ? identity
                : { ...identity, sessionId: "other" }
              : page,
          ),
        ),
        identity,
        { scope: "branch", direction: "backward", cursor: "native" },
      );
      assert.equal(result.status, "error");
      if (result.status === "error") assert.equal(result.code, "stale_cursor");
    }),
  );

  it.effect("keeps native branch errors and still validates the owner's identity afterward", () =>
    Effect.gen(function* () {
      let stateRead = 0;
      const result = yield* readPeer(
        peer((command) =>
          command.type === "get_state"
            ? Effect.sync(() => {
                stateRead++;
                return identity;
              })
            : Effect.fail(
                new NeoPiRpcError({ code: "leaf_changed", message: "The native leaf moved" }),
              ),
        ),
        identity,
        { scope: "branch", cursor: "previous" },
      );
      assert.deepEqual(result, {
        status: "error",
        code: "leaf_changed",
        message: "The native leaf moved",
      });
      assert.equal(stateRead, 2);
    }),
  );
});
