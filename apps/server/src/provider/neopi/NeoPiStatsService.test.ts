// @effect-diagnostics nodeBuiltinImport:off -- fake captured children; no subprocesses are started.
import { EventEmitter } from "node:events";
import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ServerConfig } from "../../config.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { registerNeoPiSessionCatalogSource } from "./NeoPiSessionCatalogSource.ts";
import { NeoPiStatsService } from "./NeoPiStatsService.ts";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

class FakeStatsChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = { resume: vi.fn() };
  readonly closed = Deferred.makeUnsafe<void>();
  readonly kill = vi.fn(() => true);
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly stdin = {
    end: vi.fn(() => {
      this.exitCode = 0;
      this.emit("close", 0, null);
      Deferred.doneUnsafe(this.closed, Effect.void);
    }),
  };

  ready() {
    this.stdout.emit(
      "data",
      Buffer.from('{"type":"neopi_stats_ready","version":1,"port":12345}\n'),
    );
  }
}

const fixture = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<void>();
  const spawned = yield* Queue.unbounded<FakeStatsChild>();
  spawn.mockImplementation(() => {
    const child = new FakeStatsChild();
    Queue.offerUnsafe(spawned, child);
    return child;
  });
  const instance = registerNeoPiSessionCatalogSource({} as ProviderInstance, {
    binary: "fake-neopi",
    env: {},
    profile: "default",
    capabilities: new Set(),
    probe: { status: "compatible", version: "test" },
  });
  let instances: ReadonlyArray<ProviderInstance> = [instance];
  const registry = {
    getInstance: () => Effect.sync(() => instances[0]),
    listInstances: Effect.sync(() => instances),
    subscribeChanges: PubSub.subscribe(changes),
  } as unknown as ProviderInstanceRegistry["Service"];
  const lifetime = yield* Scope.fork(yield* Effect.scope);
  const context = yield* Layer.build(
    NeoPiStatsService.layer.pipe(
      Layer.provide(Layer.succeed(ProviderInstanceRegistry, registry)),
      Layer.provide(Layer.succeed(ServerConfig, { cwd: process.cwd() } as ServerConfig["Service"])),
    ),
  ).pipe(Effect.provideService(Scope.Scope, lifetime));
  return {
    service: Context.get(context, NeoPiStatsService),
    started: Queue.take(spawned),
    removeProvider: Effect.gen(function* () {
      instances = [];
      yield* PubSub.publish(changes, undefined);
    }),
    shutdown: Scope.close(lifetime, Exit.void),
  };
});

const hold = Effect.fnUntraced(function* (service: NeoPiStatsService["Service"], bootstrap = true) {
  const ready = yield* Deferred.make<void>();
  const fiber = yield* Effect.scoped(
    Effect.gen(function* () {
      yield* service.acquire("neopi", "view", "session", bootstrap);
      yield* Deferred.succeed(ready, undefined);
      yield* Effect.never;
    }),
  ).pipe(Effect.forkScoped);
  return { fiber, ready: Deferred.await(ready) };
});

beforeEach(() => spawn.mockReset());

describe("NeoPi stats process leases", () => {
  it.effect("reaps a bootstrap cancelled before readiness after the single idle debounce", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const request = yield* hold(test.service);
        const child = yield* test.started;
        yield* Fiber.interrupt(request.fiber);
        child.ready();
        yield* TestClock.adjust("29 seconds");
        expect(child.exitCode).toBeNull();
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(child.closed);
        expect(child.stdin.end).toHaveBeenCalledTimes(1);
        expect(child.kill).not.toHaveBeenCalled();
        const result = yield* test.service
          .acquire("neopi", "view", "session", false)
          .pipe(Effect.scoped, Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.code).toBe("closed");
      }),
    ),
  );

  it.effect("keeps a shared startup alive while another request still holds a lease", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const abandoned = yield* hold(test.service);
        const child = yield* test.started;
        const active = yield* hold(test.service);
        child.ready();
        yield* active.ready;
        yield* Fiber.interrupt(abandoned.fiber);
        yield* TestClock.adjust("30 seconds");
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(child.exitCode).toBeNull();
        yield* Fiber.interrupt(active.fiber);
        yield* TestClock.adjust("30 seconds");
        yield* Deferred.await(child.closed);
        expect(child.stdin.end).toHaveBeenCalledTimes(1);
      }),
    ),
  );

  it.effect("restarts the idle debounce from the last released reacquisition", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const initial = yield* hold(test.service);
        const child = yield* test.started;
        child.ready();
        yield* initial.ready;
        yield* Fiber.interrupt(initial.fiber);
        yield* TestClock.adjust("20 seconds");
        const returning = yield* hold(test.service, false);
        yield* returning.ready;
        yield* Fiber.interrupt(returning.fiber);
        yield* TestClock.adjust("10 seconds");
        expect(child.exitCode).toBeNull();
        yield* TestClock.adjust("20 seconds");
        yield* Deferred.await(child.closed);
        expect(spawn).toHaveBeenCalledTimes(1);
      }),
    ),
  );

  it.effect(
    "explicitly deleting a pending view closes its child without waiting for readiness",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture;
          const request = yield* hold(test.service);
          const child = yield* test.started;
          yield* test.service.release("neopi", "view", "session");
          yield* Deferred.await(child.closed);
          expect((yield* Fiber.await(request.fiber))._tag).toBe("Failure");
          const replacement = yield* hold(test.service);
          const nextChild = yield* test.started;
          nextChild.ready();
          yield* replacement.ready;
          expect(spawn).toHaveBeenCalledTimes(2);
          expect(nextChild.exitCode).toBeNull();
        }),
      ),
  );

  it.effect("removing a provider closes an in-flight bootstrap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        yield* hold(test.service);
        const child = yield* test.started;
        yield* test.removeProvider;
        yield* Deferred.await(child.closed);
        expect(child.stdin.end).toHaveBeenCalledTimes(1);
      }),
    ),
  );

  it.effect("server shutdown closes a pending child without waiting for readiness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        yield* hold(test.service);
        const child = yield* test.started;
        yield* test.shutdown;
        yield* Deferred.await(child.closed);
        expect(child.stdin.end).toHaveBeenCalledTimes(1);
      }),
    ),
  );
});
