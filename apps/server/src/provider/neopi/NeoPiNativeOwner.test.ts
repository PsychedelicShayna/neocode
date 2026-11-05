import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import { readNeoPiNativeOwnerCatalog } from "./NeoPiNativeOwner.ts";
import { NeoPiRuntimeError } from "./NeoPiRuntimeError.ts";

const source = { binary: "/opt/npi", env: {} };
const catalog = { version: 1, sessions: [] };
const makeHandle = (
  exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>,
  stdout = Stream.encodeText(Stream.make(JSON.stringify(catalog))),
) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const readCatalog = readNeoPiNativeOwnerCatalog(source, "/workspace", "/sessions/native.jsonl");

describe("native owner discovery lifetime", () => {
  it.effect("releases a completed catalog child before its caller scope ends", () =>
    Effect.gen(function* () {
      let released = false;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.acquireRelease(
          Effect.succeed(makeHandle(Effect.succeed(ChildProcessSpawner.ExitCode(0)))),
          () =>
            Effect.sync(() => {
              released = true;
            }),
        ),
      );
      const result = yield* readCatalog.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.deepEqual(result, catalog);
      assert.equal(released, true);
    }).pipe(Effect.scoped),
  );

  it.effect("times out and releases a discovery child that never exits", () =>
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>();
      let released = false;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.acquireRelease(
          Effect.succeed(
            makeHandle(Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never))),
          ),
          () =>
            Effect.sync(() => {
              released = true;
            }),
        ),
      );
      const fiber = yield* readCatalog.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(waiting);
      yield* TestClock.adjust("30 seconds");
      const result = yield* Fiber.join(fiber);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, NeoPiRuntimeError);
        assert.equal(result.failure.code, "rpc");
      }
      assert.equal(released, true);
    }).pipe(Effect.scoped),
  );

  it.effect("bounds pipe collection even after the discovery child exits", () =>
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>();
      let released = false;
      const stdout = Stream.fromEffect(
        Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const spawner = ChildProcessSpawner.make(() =>
        Effect.acquireRelease(
          Effect.succeed(makeHandle(Effect.succeed(ChildProcessSpawner.ExitCode(0)), stdout)),
          () =>
            Effect.sync(() => {
              released = true;
            }),
        ),
      );
      const fiber = yield* readCatalog.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(waiting);
      yield* TestClock.adjust("30 seconds");
      const result = yield* Fiber.join(fiber);
      assert.equal(result._tag, "Failure");
      assert.equal(released, true);
    }).pipe(Effect.scoped),
  );
});
