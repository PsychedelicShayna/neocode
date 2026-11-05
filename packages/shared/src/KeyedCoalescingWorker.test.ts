import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeKeyedCoalescingWorker } from "./KeyedCoalescingWorker.ts";

describe("makeKeyedCoalescingWorker", () => {
  for (const firstFails of [false, true]) {
    it.live(
      `drains queued keys before recursive same-key work after ${firstFails ? "failure" : "success"}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const processed: string[] = [];
            const firstStarted = yield* Deferred.make<void>();
            const releaseFirst = yield* Deferred.make<void>();
            const continuationStarted = yield* Deferred.make<void>();
            const releaseContinuation = yield* Deferred.make<void>();

            const worker = yield* makeKeyedCoalescingWorker<string, number, string, never>({
              merge: Math.max,
              process: (key, value): Effect.Effect<void, string> =>
                Effect.gen(function* () {
                  processed.push(`${key}:${value}`);

                  if (key === "busy") {
                    if (value === 0) {
                      yield* Deferred.succeed(firstStarted, undefined);
                      yield* Deferred.await(releaseFirst);
                    }
                    if (value === 2) {
                      yield* Deferred.succeed(continuationStarted, undefined);
                      yield* Deferred.await(releaseContinuation);
                    }
                    if (value < 4) {
                      yield* worker.enqueue(key, value + 1);
                      yield* worker.enqueue(key, value + 2);
                    }
                    if (value === 0 && firstFails) {
                      return yield* Effect.fail("boom");
                    }
                  } else if (key === "closing") {
                    // Merge into the busy key while it is queued for another turn.
                    yield* worker.enqueue("busy", 1);
                  }
                }),
            });

            yield* worker.enqueue("busy", 0);
            yield* Deferred.await(firstStarted);
            yield* worker.enqueue("closing", 1);
            yield* worker.enqueue("closing", 0);
            yield* worker.enqueue("other", 7);
            yield* Deferred.succeed(releaseFirst, undefined);
            yield* Deferred.await(continuationStarted);

            expect(processed).toEqual(["busy:0", "closing:1", "other:7", "busy:2"]);
            yield* worker.drainKey("closing");
            yield* worker.drainKey("other");

            yield* Deferred.succeed(releaseContinuation, undefined);
            yield* worker.drainKey("busy");
            expect(processed).toEqual(["busy:0", "closing:1", "other:7", "busy:2", "busy:4"]);
          }),
        ),
    );
  }

  it.live("waits for latest work enqueued during active processing before draining the key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, never, never>({
          merge: (_current, next) => next,
          process: (key, value) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);

              if (value === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFirst);
              }

              if (value === "second") {
                yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseSecond);
              }
            }),
        });

        yield* worker.enqueue("terminal-1", "first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker
            .drainKey("terminal-1")
            .pipe(Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie))),
        );

        yield* worker.enqueue("terminal-1", "second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["terminal-1:first", "terminal-1:second"]);
      }),
    ),
  );

  it.live("requeues pending work for a key after a processor failure and keeps draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFailure = yield* Deferred.make<void>();
        const secondProcessed = yield* Deferred.make<void>();

        const worker = yield* makeKeyedCoalescingWorker<string, string, string, never>({
          merge: (_current, next) => next,
          process: (key, value) =>
            Effect.gen(function* () {
              processed.push(`${key}:${value}`);

              if (value === "first") {
                yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseFailure);
                return yield* Effect.fail("boom");
              }

              if (value === "second") {
                yield* Deferred.succeed(secondProcessed, undefined).pipe(Effect.orDie);
              }
            }),
        });

        yield* worker.enqueue("terminal-1", "first");
        yield* Deferred.await(firstStarted);
        yield* worker.enqueue("terminal-1", "second");
        yield* Deferred.succeed(releaseFailure, undefined);
        yield* Deferred.await(secondProcessed);
        yield* worker.drainKey("terminal-1");

        expect(processed).toEqual(["terminal-1:first", "terminal-1:second"]);
      }),
    ),
  );
});
