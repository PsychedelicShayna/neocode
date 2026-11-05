import {
  NeoPiModelsError,
  type NeoPiModelsConfiguration,
  type NeoPiModelsTarget,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { NeoPiModelsConnection } from "./NeoPiModelsConnection.ts";

/** Reading the catalog costs NeoPi seconds; a burst of change signals is one re-read. */
const CHANGE_COALESCE = Duration.millis(100);
/** Short: the hub pins a native connection, and a config process is hundreds of MB. Matches the adapter's own idle horizon. */
const HUB_IDLE_TTL = Duration.seconds(30);

type Entry =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly configuration: NeoPiModelsConfiguration }
  | { readonly _tag: "Failed"; readonly error: NeoPiModelsError };

interface Hub {
  readonly state: SubscriptionRef.SubscriptionRef<Entry>;
}

const LOADING: Entry = { _tag: "Loading" };

/** Stable identity for one native configuration source; undefined fields never alias. */
const hubKey = (target: NeoPiModelsTarget) =>
  JSON.stringify([
    target.providerInstanceId,
    target.projectId ?? null,
    target.sessionFile ?? null,
    target.threadId ?? null,
  ]);

const keyTarget = (key: string): NeoPiModelsTarget => {
  const [providerInstanceId, projectId, sessionFile, threadId] = JSON.parse(key) as [
    NeoPiModelsTarget["providerInstanceId"],
    NeoPiModelsTarget["projectId"] | null,
    string | null,
    NeoPiModelsTarget["threadId"] | null,
  ];
  return {
    providerInstanceId,
    ...(projectId === null ? {} : { projectId }),
    ...(sessionFile === null ? {} : { sessionFile }),
    ...(threadId === null ? {} : { threadId }),
  };
};

/**
 * One live, shared copy of each native Models configuration. The first watcher pays the native
 * read; later watchers (a reopened page, a second client) start from the cached snapshot, which
 * stays current because NeoPi's own change signal triggers the only re-read.
 */
export const makeNeoPiModelsHub = Effect.fn("makeNeoPiModelsHub")(function* (
  connection: (
    target: NeoPiModelsTarget,
  ) => Effect.Effect<NeoPiModelsConnection, NeoPiModelsError, Scope.Scope>,
  read: (
    native: NeoPiModelsConnection,
  ) => Effect.Effect<NeoPiModelsConfiguration, NeoPiModelsError>,
) {
  const live = new Map<string, SubscriptionRef.SubscriptionRef<Entry>>();
  // `makeNeoPiModels` runs in a construction scope that closes as soon as the handlers exist, and
  // an RcMap closed with it answers every `get` with a bare interrupt. The hub owns its lifetime:
  // entries evict themselves HUB_IDLE_TTL after their last watcher, so nothing outlives use.
  const lifetime = yield* Scope.make();
  const hubs: RcMap.RcMap<string, Hub, NeoPiModelsError> = yield* RcMap.make({
    lookup: (key: string) =>
      Effect.gen(function* () {
        const native = yield* connection(keyTarget(key));
        const state = yield* SubscriptionRef.make<Entry>(LOADING);
        live.set(key, state);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (live.get(key) === state) live.delete(key);
          }),
        );
        // A failed read leaves no trustworthy snapshot: retire the hub first so the next watcher builds
        // a fresh one (and a fresh native connection), then tell the current watchers.
        const fail = (error: NeoPiModelsError) =>
          RcMap.invalidate(hubs, key).pipe(
            Effect.andThen(SubscriptionRef.set(state, { _tag: "Failed", error })),
          );
        // Subscribe before the first read, so a change during that read is buffered rather than
        // lost. Reads are serialized; cancelling an in-flight native RPC would waste its work.
        const changes = yield* Stream.toPull(native.changes);
        yield* Stream.make(undefined).pipe(
          Stream.concat(
            Stream.fromPull(Effect.succeed(changes)).pipe(Stream.debounce(CHANGE_COALESCE)),
          ),
          Stream.mapEffect(() =>
            read(native).pipe(
              Effect.flatMap((configuration) =>
                SubscriptionRef.set(state, { _tag: "Ready", configuration }),
              ),
            ),
          ),
          Stream.runDrain,
          // NeoPi's change signal only ends with its connection (a closed or replaced session).
          // A hub that stopped following would serve a frozen catalog, so retire it instead.
          Effect.andThen(
            Effect.fail(new NeoPiModelsError({ message: "The native connection closed." })),
          ),
          Effect.catch((error) =>
            fail(
              Schema.is(NeoPiModelsError)(error)
                ? error
                : new NeoPiModelsError({ message: String(error) }),
            ),
          ),
          Effect.forkScoped,
        );
        return { state } satisfies Hub;
      }),
    idleTimeToLive: HUB_IDLE_TTL,
  }).pipe(Effect.provideService(Scope.Scope, lifetime));

  /** Every snapshot of the source, starting with the cached one; fails when a read fails. */
  const watch = (target: NeoPiModelsTarget) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const hub = yield* RcMap.get(hubs, hubKey(target));
        return SubscriptionRef.changes(hub.state).pipe(
          Stream.filter(
            (entry): entry is Exclude<Entry, { readonly _tag: "Loading" }> =>
              entry._tag !== "Loading",
          ),
          Stream.mapEffect((entry) =>
            entry._tag === "Failed"
              ? Effect.fail(entry.error)
              : Effect.succeed(entry.configuration),
          ),
        );
      }),
    );

  /** An authoritative mutation receipt is newer than the cache; replay it before NeoPi's signal lands. */
  const publish = (target: NeoPiModelsTarget, configuration: NeoPiModelsConfiguration) => {
    const state = live.get(hubKey(target));
    return state === undefined
      ? Effect.void
      : SubscriptionRef.set(state, { _tag: "Ready", configuration });
  };

  return { watch, publish };
});
