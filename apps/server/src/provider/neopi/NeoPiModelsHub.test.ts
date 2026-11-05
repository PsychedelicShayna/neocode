import { describe, expect, it } from "@effect/vitest";
import {
  NeoPiModelsError,
  ProviderInstanceId,
  type NeoPiModelsConfiguration,
  type NeoPiModelsTarget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { makeNeoPiModelsHub } from "./NeoPiModelsHub.ts";
import type { NeoPiModelsConnection } from "./NeoPiModelsConnection.ts";

const target: NeoPiModelsTarget = { providerInstanceId: ProviderInstanceId.make("neopi") };
const snapshot = (marker: string) => ({ marker }) as unknown as NeoPiModelsConfiguration;
const marker = (configuration: NeoPiModelsConfiguration | undefined) =>
  (configuration as unknown as { marker: string } | undefined)?.marker;

const harness = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<void>();
  const counts = { connections: 0, reads: 0 };
  const native: NeoPiModelsConnection = {
    capabilities: new Set(["models_configuration"]),
    request: () => Effect.void,
    respondUi: () => Effect.void,
    validate: Effect.void,
    ui: Stream.empty,
    changes: Stream.fromPubSub(changes),
  };
  let failing = false;
  const hub = yield* makeNeoPiModelsHub(
    () =>
      Effect.acquireRelease(
        Effect.sync(() => {
          counts.connections++;
          return native;
        }),
        () => Effect.void,
      ),
    () =>
      failing
        ? Effect.fail(new NeoPiModelsError({ message: "read failed" }))
        : Effect.sync(() => snapshot(`read-${++counts.reads}`)),
  );
  return {
    hub,
    changes,
    counts,
    fail: () => {
      failing = true;
    },
  };
});

const first = (watch: Stream.Stream<NeoPiModelsConfiguration, NeoPiModelsError>) =>
  watch.pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map((items) => marker(items[0])),
  );

describe("native Models hub", () => {
  it.live("keeps serving watchers after the scope that built it has closed", () =>
    Effect.gen(function* () {
      // The server builds its handlers in a scope that closes once they exist.
      const hub = yield* Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* PubSub.unbounded<void>();
          const native: NeoPiModelsConnection = {
            capabilities: new Set(["models_configuration"]),
            request: () => Effect.void,
            respondUi: () => Effect.void,
            validate: Effect.void,
            ui: Stream.empty,
            changes: Stream.fromPubSub(changes),
          };
          return yield* makeNeoPiModelsHub(
            () => Effect.succeed(native),
            () => Effect.succeed(snapshot("built-in-closed-scope")),
          );
        }),
      );
      expect(marker((yield* hub.watch(target).pipe(Stream.take(1), Stream.runCollect))[0])).toBe(
        "built-in-closed-scope",
      );
    }),
  );

  it.live("shares one native connection and one read between concurrent watchers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { hub, counts } = yield* harness;
        const markers = yield* Effect.all([first(hub.watch(target)), first(hub.watch(target))], {
          concurrency: "unbounded",
        });
        expect(markers).toEqual(["read-1", "read-1"]);
        expect(counts).toEqual({ connections: 1, reads: 1 });
      }),
    ),
  );

  it.live("replays the cached snapshot to a later watcher without reading again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { hub, counts } = yield* harness;
        expect(yield* first(hub.watch(target))).toBe("read-1");
        expect(yield* first(hub.watch(target))).toBe("read-1");
        expect(counts).toEqual({ connections: 1, reads: 1 });
      }),
    ),
  );

  it.live("re-reads once for a burst of native change signals", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { hub, changes, counts } = yield* harness;
        const seen: Array<string | undefined> = [];
        yield* hub.watch(target).pipe(
          Stream.runForEach((configuration) => Effect.sync(() => seen.push(marker(configuration)))),
          Effect.forkScoped,
        );
        yield* Effect.sleep("50 millis");
        yield* PubSub.publish(changes, undefined);
        yield* PubSub.publish(changes, undefined);
        yield* PubSub.publish(changes, undefined);
        yield* Effect.sleep("400 millis");
        expect(seen).toEqual(["read-1", "read-2"]);
        expect(counts.reads).toBe(2);
      }),
    ),
  );

  it.live("publishes an update receipt to live watchers before NeoPi's signal arrives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { hub } = yield* harness;
        const seen: Array<string | undefined> = [];
        yield* hub.watch(target).pipe(
          Stream.runForEach((configuration) => Effect.sync(() => seen.push(marker(configuration)))),
          Effect.forkScoped,
        );
        yield* Effect.sleep("50 millis");
        yield* hub.publish(target, snapshot("receipt"));
        yield* Effect.sleep("50 millis");
        expect(seen).toEqual(["read-1", "receipt"]);
      }),
    ),
  );

  it.live("retires a hub whose native connection ended instead of freezing its catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const counts = { connections: 0 };
        const ended = yield* makeNeoPiModelsHub(
          () =>
            Effect.sync(() => {
              counts.connections++;
              return {
                capabilities: new Set(["models_configuration"]),
                request: () => Effect.void,
                respondUi: () => Effect.void,
                validate: Effect.void,
                ui: Stream.empty,
                changes: Stream.empty,
              } satisfies NeoPiModelsConnection;
            }),
          () => Effect.succeed(snapshot("only-read")),
        );
        const error = yield* ended.watch(target).pipe(Stream.runCollect, Effect.flip);
        expect(error.message).toBe("The native connection closed.");
        yield* ended.watch(target).pipe(Stream.runCollect, Effect.flip);
        expect(counts.connections).toBe(2);
      }),
    ),
  );

  it.live("fails watchers on a failed read and builds a fresh hub for the next watcher", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { hub, changes, counts, fail } = yield* harness;
        const watcher = yield* hub
          .watch(target)
          .pipe(Stream.runCollect, Effect.flip, Effect.forkScoped);
        yield* Effect.sleep("50 millis");
        fail();
        yield* PubSub.publish(changes, undefined);
        expect((yield* Fiber.join(watcher)).message).toBe("read failed");
        const retry = yield* hub.watch(target).pipe(Stream.runCollect, Effect.flip);
        expect(retry.message).toBe("read failed");
        expect(counts.connections).toBe(2);
      }),
    ),
  );
});
