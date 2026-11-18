import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import { readNeoPiNativeOwnerCatalog, makeNeoPiThreadNativeRef } from "./NeoPiNativeOwner.ts";
import { registerNeoPiSessionCatalogSource } from "./NeoPiSessionCatalogSource.ts";
import { NeoPiRuntimeError } from "./NeoPiRuntimeError.ts";

const source = { binary: "/opt/npi", env: {} };
const catalog = { version: 1 as const, sessions: [] };
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

describe("thread native ref", () => {
  const threadId = ThreadId.make("thread-1");
  const providerInstanceId = ProviderInstanceId.make("neopi-main");
  const lookup = (input: {
    readonly binding: ProviderRuntimeBinding | undefined;
    readonly runtime: "gui" | "terminal" | undefined;
    readonly deleted?: boolean;
  }) => {
    const instance = registerNeoPiSessionCatalogSource(
      {
        instanceId: providerInstanceId,
        driverKind: "neopi",
        enabled: true,
      } as unknown as ProviderInstance,
      {
        binary: "/opt/npi",
        env: {},
        profile: "default",
        capabilities: new Set(),
        probe: { status: "compatible", version: "test" },
        nativeOwner: () =>
          Effect.succeed(
            input.runtime && {
              ownership: input.runtime,
              capabilities: new Set<string>(),
              request: () => Effect.die("no request expected"),
            },
          ),
      },
    );
    return Effect.gen(function* () {
      const nativeRef = yield* makeNeoPiThreadNativeRef();
      return yield* nativeRef(threadId);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ProviderSessionDirectory, {
            getBinding: () => Effect.succeed(Option.fromNullishOr(input.binding)),
          } as unknown as ProviderSessionDirectory["Service"]),
          Layer.succeed(ProviderInstanceRegistry, {
            getInstance: () => Effect.succeed(instance),
          } as unknown as ProviderInstanceRegistry["Service"]),
          // The thread projection holds active threads only; a deleted one reads as none.
          Layer.succeed(ProjectionSnapshotQuery, {
            getThreadShellById: () =>
              Effect.succeed(input.deleted ? Option.none() : Option.some({ id: threadId })),
          } as unknown as ProjectionSnapshotQuery["Service"]),
          FileSystem.layerNoop({ realPath: (path) => Effect.succeed(`/canonical${path}`) }),
        ),
      ),
    );
  };
  const binding: ProviderRuntimeBinding = {
    threadId,
    provider: "neopi" as ProviderRuntimeBinding["provider"],
    providerInstanceId,
    resumeCursor: { sessionId: "s-1", sessionFile: "/sessions/a.jsonl" },
  };

  // A view that finds no attachable owner needs this to say "control plane off, still running"
  // for a session NeoCode owns, and "stopped" otherwise; a runtime attached to a terminal owner
  // is labelled terminal.
  it.effect("names the canonical ref and what NeoCode's own runtime is for the session", () =>
    Effect.gen(function* () {
      const owned = yield* lookup({ binding, runtime: "gui" });
      assert.deepStrictEqual(owned, {
        status: "available",
        ref: { providerInstanceId, sessionFile: "/canonical/sessions/a.jsonl" },
        sessionId: "s-1",
        runtime: "gui",
      });
      const attached = yield* lookup({ binding, runtime: "terminal" });
      const stopped = yield* lookup({ binding, runtime: undefined });
      assert.isTrue(attached.status === "available" && attached.runtime === "terminal");
      assert.isTrue(stopped.status === "available" && stopped.runtime === "none");
    }),
  );

  it.effect("never discloses the retained binding of a deleted thread", () =>
    Effect.gen(function* () {
      const deleted = yield* lookup({ binding, runtime: undefined, deleted: true });
      assert.deepStrictEqual(deleted, {
        status: "unavailable",
        reason: "This thread does not exist.",
      });
    }),
  );

  it.effect(
    "is unavailable, without a connection, when the thread has no native session file",
    () =>
      Effect.gen(function* () {
        const none = yield* lookup({ binding: undefined, runtime: undefined });
        const relative = yield* lookup({
          binding: { ...binding, resumeCursor: { sessionId: "s-1", sessionFile: "a.jsonl" } },
          runtime: "gui",
        });
        assert.strictEqual(none.status, "unavailable");
        assert.strictEqual(relative.status, "unavailable");
      }),
  );
});
