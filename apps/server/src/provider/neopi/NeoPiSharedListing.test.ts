import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";

import { makeSharedListing } from "./NeoPiSharedListing.ts";

const counted = () => {
  const state = { scans: 0 };
  const scan = (source: string) =>
    Effect.sync(() => {
      state.scans++;
      return `${source}#${state.scans}`;
    });
  return { state, scan };
};

describe("shared native session listing", () => {
  it.effect("serves every client from one scan inside the window", () =>
    Effect.gen(function* () {
      const { state, scan } = counted();
      const listing = yield* makeSharedListing({ scan, ttl: "8 seconds" });
      const first = yield* listing.get("a", "a");
      yield* TestClock.adjust("7 seconds");
      const second = yield* listing.get("a", "a");
      assert.deepEqual([first, second, state.scans], ["a#1", "a#1", 1]);
      yield* TestClock.adjust("2 seconds");
      assert.equal(yield* listing.get("a", "a"), "a#2");
    }),
  );

  it.effect("lets concurrent clients join the scan in flight", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      let scans = 0;
      const listing = yield* makeSharedListing({
        scan: (source: string) =>
          Effect.gen(function* () {
            scans++;
            yield* Deferred.await(release);
            return source;
          }),
        ttl: "8 seconds",
      });
      const clients = yield* Effect.all(
        Array.from({ length: 5 }, () => listing.get("a", "a").pipe(Effect.forkChild)),
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      const results = yield* Effect.forEach(clients, (fiber) => Fiber.await(fiber));
      assert.equal(scans, 1);
      assert.isTrue(results.every((exit) => Exit.isSuccess(exit)));
    }),
  );

  it.effect("rescans after invalidation and keeps profiles apart", () =>
    Effect.gen(function* () {
      const { state, scan } = counted();
      const listing = yield* makeSharedListing({ scan, ttl: "8 seconds" });
      yield* listing.get("a", "a");
      yield* listing.get("b", "b");
      assert.equal(state.scans, 2);
      yield* listing.invalidate;
      assert.equal(yield* listing.get("a", "a"), "a#3");
    }),
  );

  it.effect("never reuses a failed scan", () =>
    Effect.gen(function* () {
      let scans = 0;
      const listing = yield* makeSharedListing({
        scan: (_source: string) =>
          Effect.suspend(() => (++scans === 1 ? Effect.fail("boom") : Effect.succeed("ok"))),
        ttl: "8 seconds",
      });
      assert.isTrue(Exit.isFailure(yield* Effect.exit(listing.get("a", "a"))));
      assert.equal(yield* listing.get("a", "a"), "ok");
      assert.equal(scans, 2);
    }),
  );
});
