import {
  EnvironmentAuthorizationError,
  NEOPI_NATIVE_OBSERVATION_ERROR_CODES,
  NeoPiNativeSessionsError,
  WS_METHODS,
  type NeoPiNativeDemandItem,
  type NeoPiNativeObservationLifecycle,
  type NeoPiNativeSessionRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request as rpcRequest } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  emptyNativeSessionFeed,
  nativeJournalPage,
  nativeRecord,
  nativeSessionKey,
  reduceNativeSessionFeed,
  type NativeSessionFeed,
  type NativeSessionTarget,
  type NativeSessionUpdate,
} from "../neopiNativeSessions.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

/** Lifecycle facts after which the server ends the watch and only an explicit route continues. */
const TERMINAL_LIFECYCLES: ReadonlySet<NeoPiNativeObservationLifecycle> = new Set([
  "owner-stopped",
  "incompatible",
  "detached",
  "identity-changed",
]);
/**
 * What every visible view of a session needs. The roster is part of it because
 * the workspace status bar shows the session's agents whenever the session is
 * visible; a child view adds `child` through `holdDemand`.
 */
export const DEFAULT_NATIVE_DEMAND: readonly NeoPiNativeDemandItem[] = [
  { kind: "summary" },
  { kind: "transcript" },
  { kind: "roster" },
];
/**
 * How long a released view's cached feed stays for a warm switch back; it holds
 * no lease. A view that is still mounted but concealed holds the feed (`view`),
 * so it is never evicted under that view.
 */
export const NATIVE_WARM_CACHE_MS = 5 * 60_000;
/** Re-attach and re-read backoff: 250 ms doubling to 5 s, reset by any lease or reply. */
const retryDelayMs = (failures: number) => Math.min(250 * 2 ** failures, 5_000);

type LeaseOutcome =
  | { readonly kind: "terminal" }
  | { readonly kind: "unauthorized"; readonly reason: string }
  | { readonly kind: "lost"; readonly leased: boolean };

const isObservationError = Schema.is(NeoPiNativeSessionsError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isUnauthorized = (error: unknown) =>
  isAuthorizationError(error) || (isObservationError(error) && error.code === "profile_changed");

export function createNativeSessionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const cache = new Map<string, NativeSessionFeed>();
  /** Live observations: updates published from outside the controller (commands). */
  const updates = new Map<string, Queue.Queue<NativeSessionUpdate>>();
  /** Demand held by views beyond `DEFAULT_NATIVE_DEMAND`, per session, one entry per hold. */
  const demandHolds = new Map<string, Set<readonly NeoPiNativeDemandItem[]>>();
  const demandOf = (key: string) => {
    const items = new Map(DEFAULT_NATIVE_DEMAND.map((item) => [JSON.stringify(item), item]));
    for (const held of demandHolds.get(key) ?? [])
      for (const item of held) items.set(JSON.stringify(item), item);
    return [...items.values()];
  };
  const demandSignals = new Map<string, Queue.Queue<void>>();
  /** Wakes an observation that stopped on a terminal lifecycle, after an explicit open. */
  const restarts = new Map<string, Queue.Queue<void>>();
  /** Concealed views per session: no lease, but their feed stays cached. */
  const holds = new Map<string, number>();
  /** Drops cached feeds that no lease and no concealed view holds, after the warm period. */
  const evictLater = (keys: readonly string[]) =>
    Effect.sleep(NATIVE_WARM_CACHE_MS).pipe(
      Effect.andThen(
        Effect.sync(() => {
          for (const key of keys) if (!updates.has(key) && !holds.has(key)) cache.delete(key);
        }),
      ),
    );
  /**
   * A concealed view's hold: keeps the cached feed from eviction and carries no
   * value of its own, because one hold is shared by every concealed view of the
   * session and a value taken when the first one mounted would be stale for the
   * next. A concealed view reads `cached` instead.
   */
  const concealed = Atom.family((key: string) =>
    Atom.make((get) => {
      holds.set(key, (holds.get(key) ?? 0) + 1);
      get.addFinalizer(() => {
        const count = (holds.get(key) ?? 1) - 1;
        if (count > 0) holds.set(key, count);
        else {
          holds.delete(key);
          if (!updates.has(key)) Effect.runFork(evictLater([key]));
        }
      });
      return AsyncResult.initial();
    }).pipe(Atom.setIdleTTL(0)),
  );
  const publish = (key: string, update: NativeSessionUpdate) =>
    Effect.sync(() => {
      const queue = updates.get(key);
      if (queue) Queue.offerUnsafe(queue, update);
      else {
        const feed = cache.get(key);
        if (feed) cache.set(key, reduceNativeSessionFeed(feed, update));
      }
    });
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "native-sessions:list",
    tag: WS_METHODS.neopiNativeSessionsList,
    staleTimeMs: 5_000,
  });
  /**
   * The observation controller (r12 C5). One essential `watch` per visible view
   * is its lease; bulk state comes through one cursor `read` at a time; credit
   * goes back for every envelope applied, so the socket reader never waits on
   * this stream. A lost read re-reads, a lost watch re-attaches (never Open),
   * and the feed carries on in place: the atom never fails or restarts.
   */
  const observation = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "native-sessions:watch",
    // A concealed view releases its lease at once; the cache stays warm without one.
    idleTtlMs: 0,
    subscribe: (input: { ref: NeoPiNativeSessionRef }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          const environmentId = supervisor.target.environmentId;
          const key = nativeSessionKey({ environmentId, ref: input.ref });
          const external = yield* Queue.unbounded<NativeSessionUpdate>();
          const demandSignal = yield* Queue.sliding<void>(1);
          const restart = yield* Queue.sliding<void>(1);
          // Only the latest feed is drawn: a backlog never replays frame by frame.
          const out = yield* Queue.sliding<NativeSessionFeed>(1);
          const handedOffKeys = new Set<string>();
          let current = cache.get(key) ?? emptyNativeSessionFeed();
          const apply = (update: NativeSessionUpdate) =>
            Effect.sync(() => {
              const wasMoved = current.movedTo != null;
              const next = reduceNativeSessionFeed(current, update);
              if (next === current) return;
              current = next;
              cache.set(key, next);
              // The moved session's own observation starts from what is already
              // known, so its transcript does not flash empty.
              if (next.movedTo && !wasMoved) {
                const movedKey = nativeSessionKey({ environmentId, ref: next.movedTo });
                if (!updates.has(movedKey)) {
                  handedOffKeys.add(movedKey);
                  cache.set(movedKey, { ...next, movedTo: null, connected: false });
                }
              }
              Queue.offerUnsafe(out, next);
            });
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              updates.set(key, external);
              demandSignals.set(key, demandSignal);
              restarts.set(key, restart);
            }),
            () =>
              Effect.suspend(() => {
                if (updates.get(key) !== external) return Effect.void;
                updates.delete(key);
                demandSignals.delete(key);
                restarts.delete(key);
                // Unobserved move handoffs live only as long as their source.
                return evictLater([key, ...handedOffKeys]).pipe(Effect.forkDetach, Effect.asVoid);
              }),
          );

          const read = (leaseId: string) =>
            Effect.gen(function* () {
              let failures = 0;
              while (true) {
                // The feed numbers the read and keeps it as its one outstanding read;
                // only the reply to that read applies.
                yield* apply({ type: "read-issued" });
                const outstanding = current.observation.outstanding;
                if (!outstanding) return;
                const reply = yield* rpcRequest(WS_METHODS.neopiNativeSessionsRead, {
                  leaseId,
                  readId: outstanding.readId,
                  cursor: outstanding.cursor,
                }).pipe(Effect.result);
                if (Result.isSuccess(reply)) {
                  failures = 0;
                  yield* apply({ type: "read", readId: outstanding.readId, result: reply.success });
                  continue;
                }
                const error = reply.failure;
                const code = isObservationError(error) ? error.code : undefined;
                // The lease is gone; its watch is ending and re-attach takes over.
                if (code === NEOPI_NATIVE_OBSERVATION_ERROR_CODES.leaseUnknown) return;
                // A newer read superseded this one: the next id reads again at once.
                if (code === NEOPI_NATIVE_OBSERVATION_ERROR_CODES.staleRead) continue;
                yield* Effect.sleep(retryDelayMs(failures++));
              }
            });

          const demand = (leaseId: string) =>
            Effect.gen(function* () {
              let generation = 0;
              const send = Effect.suspend(() =>
                rpcRequest(WS_METHODS.neopiNativeSessionsSetDemand, {
                  leaseId,
                  generation: ++generation,
                  demand: demandOf(key),
                }).pipe(Effect.ignore),
              );
              yield* send;
              yield* Stream.fromQueue(demandSignal).pipe(Stream.runForEach(() => send));
            });

          /** One watch stream: one lease. Resolves when the stream ends or fails. */
          const lease = (session: RpcSession) =>
            Effect.scoped(
              Effect.gen(function* () {
                let leased = false;
                let terminal = false;
                let applied = 0;
                const credit = yield* Queue.sliding<string>(1);
                // One credit call in flight, always carrying the latest cumulative count.
                yield* Stream.fromQueue(credit).pipe(
                  Stream.runForEach((leaseId) =>
                    rpcRequest(WS_METHODS.neopiNativeSessionsCredit, {
                      leaseId,
                      applied,
                    }).pipe(Effect.ignore),
                  ),
                  Effect.forkScoped,
                );
                let leaseId: string | null = null;
                return yield* session.client[WS_METHODS.neopiNativeSessionsWatch]({
                  ref: input.ref,
                }).pipe(
                  Stream.runForEach((envelope) =>
                    Effect.gen(function* () {
                      yield* apply(envelope);
                      applied++;
                      if (envelope.type === "leased") {
                        leased = true;
                        leaseId = envelope.leaseId;
                        yield* Effect.forkScoped(read(envelope.leaseId));
                        yield* Effect.forkScoped(demand(envelope.leaseId));
                      }
                      if (envelope.type === "lifecycle" && TERMINAL_LIFECYCLES.has(envelope.state))
                        terminal = true;
                      if (leaseId !== null) Queue.offerUnsafe(credit, leaseId);
                    }),
                  ),
                  Effect.map((): LeaseOutcome =>
                    terminal ? { kind: "terminal" } : { kind: "lost", leased },
                  ),
                  Effect.catch((error) =>
                    Effect.succeed<LeaseOutcome>(
                      isUnauthorized(error)
                        ? { kind: "unauthorized", reason: String(error.message) }
                        : terminal
                          ? { kind: "terminal" }
                          : { kind: "lost", leased },
                    ),
                  ),
                );
              }),
            );

          /** Keeps a lease on one socket session; re-attaches in place, never opens. */
          const attach = (session: RpcSession) =>
            Effect.gen(function* () {
              let failures = 0;
              while (true) {
                yield* apply({ type: "observer", phase: "attaching" });
                const outcome = yield* lease(session);
                if (outcome.kind === "lost") {
                  yield* apply({ type: "disconnected" });
                  yield* apply({ type: "observer", phase: "transport-lost" });
                  failures = outcome.leased ? 0 : failures + 1;
                  yield* Effect.sleep(retryDelayMs(failures));
                  continue;
                }
                if (outcome.kind === "unauthorized") {
                  yield* apply({ type: "disconnected" });
                  yield* apply({ type: "observer", phase: "unauthorized", reason: outcome.reason });
                }
                // Stopped, detached, incompatible, moved or unauthorized: wait for an explicit route.
                yield* Queue.take(restart);
                failures = 0;
              }
            });

          yield* Stream.fromQueue(external).pipe(Stream.runForEach(apply), Effect.forkScoped);
          yield* SubscriptionRef.changes(supervisor.session).pipe(
            Stream.switchMap((session) =>
              Stream.fromEffect(
                Option.isSome(session)
                  ? attach(session.value)
                  : apply({ type: "disconnected" }).pipe(
                      Effect.andThen(apply({ type: "observer", phase: "transport-lost" })),
                    ),
              ),
            ),
            Stream.runDrain,
            Effect.forkScoped,
          );
          Queue.offerUnsafe(out, current);
          return Stream.fromQueue(out);
        }),
      ),
  });
  const request = createEnvironmentRpcCommand(runtime, {
    label: "native-sessions:request",
    tag: WS_METHODS.neopiNativeSessionsRequest,
    execute: (input) =>
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor;
        const key = nativeSessionKey({
          environmentId: supervisor.target.environmentId,
          ref: input.ref,
        });
        const revision = cache.get(key)?.conversation.revision ?? 0;
        const cachedFeed = cache.get(key);
        const jobsRevision = cachedFeed?.jobs.revision ?? 0;
        const agentsRevision = cachedFeed?.agentsRevision ?? 0;
        const value = yield* rpcRequest(WS_METHODS.neopiNativeSessionsRequest, input);
        if (input.command.type === "get_jobs") {
          // A panel-initiated read folds into the feed.
          const session = cache.get(key)?.session;
          if (session)
            yield* publish(key, {
              type: "jobs",
              ref: session.ref,
              sessionId: session.sessionId,
              revision: jobsRevision,
              response: value,
            });
          yield* publish(key, { type: "reconciliation", operation: "jobs", error: null });
        }
        if (input.command.type === "get_subagents") {
          // Model, effort and fast changes emit no lifecycle frame; a command-driven re-read folds them in.
          const feed = cache.get(key);
          const agents = nativeRecord(value).subagents;
          if (feed?.session && Array.isArray(agents))
            yield* publish(key, {
              type: "subagents",
              ref: feed.session.ref,
              sessionId: feed.session.sessionId,
              epoch: cachedFeed?.agentsEpoch ?? feed.agentsEpoch,
              revision: agentsRevision,
              agents,
            });
        }
        if (input.command.type === "get_state") {
          yield* publish(key, { type: "state", state: nativeRecord(value) });
          yield* publish(key, { type: "reconciliation", operation: "state", error: null });
        }
        if (
          ["extension_ui_response", "tool_approval_response", "plan_proposal_response"].includes(
            input.command.type,
          ) &&
          typeof input.command.id === "string"
        )
          yield* publish(key, { type: "answered", id: input.command.id });
        if (input.command.type === "get_entries_page") {
          const page = nativeJournalPage(value);
          if (page)
            yield* publish(key, {
              type: "page",
              page,
              revision,
              older: typeof input.command.cursor === "string",
            });
        }
        return value;
      }),
  });
  const open = createEnvironmentRpcCommand(runtime, {
    label: "native-sessions:open",
    tag: WS_METHODS.neopiNativeSessionsOpen,
    onSuccess: (target, registry) =>
      Effect.sync(() => registry.refresh(list({ environmentId: target.environmentId, input: {} }))),
  });
  return {
    list,
    open,
    request,
    close: createEnvironmentRpcCommand(runtime, {
      label: "native-sessions:close",
      tag: WS_METHODS.neopiNativeSessionsClose,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(list({ environmentId: target.environmentId, input: {} })),
        ),
    }),
    setSettled: createEnvironmentRpcCommand(runtime, {
      label: "native-sessions:set-settled",
      tag: WS_METHODS.neopiNativeSessionsSetSettled,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(list({ environmentId: target.environmentId, input: {} })),
        ),
    }),
    watch: observation,
    cached: (target: NativeSessionTarget) => cache.get(nativeSessionKey(target)),
    /**
     * The atom a view subscribes to. Visible: the observation (its lease).
     * Concealed: only a hold on the cached feed, with no lease, read or demand;
     * the view shows `cached`, so it keeps its place, and returning to visible
     * resumes from that feed.
     */
    view: (target: NativeSessionTarget, visible: boolean) =>
      visible
        ? observation({ environmentId: target.environmentId, input: { ref: target.ref } })
        : concealed(nativeSessionKey(target)),
    /**
     * Adds `items` to what the session's views need (C4 demand) until the
     * returned release runs: a child view holds `child(id, runToken)` while open.
     * Holds compose; a live lease sends the union at once under a new generation.
     */
    holdDemand: (target: NativeSessionTarget, items: readonly NeoPiNativeDemandItem[]) => {
      const key = nativeSessionKey(target);
      const holds = demandHolds.get(key) ?? new Set();
      demandHolds.set(key, holds);
      // A fresh array per hold, so two holds of equal items release separately.
      const hold = [...items];
      holds.add(hold);
      const signal = () => {
        const queue = demandSignals.get(key);
        if (queue) Queue.offerUnsafe(queue, undefined);
      };
      signal();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds.delete(hold);
        if (holds.size === 0 && demandHolds.get(key) === holds) demandHolds.delete(key);
        signal();
      };
    },
    /**
     * The explicit route back for an owner-stopped or detached session: opens it
     * (the server attaches to a live terminal owner when there is one and
     * otherwise starts NeoCode's own, so this is also how a quit terminal is
     * taken over), then wakes a mounted observation. Rejects with the open
     * failure. It never subscribes itself, so a view concealed meanwhile holds no
     * lease; the visible view shows the owner once its watch reports it.
     */
    reconnect: async (registry: AtomRegistry.AtomRegistry, target: NativeSessionTarget) => {
      const result = await open.run(registry, {
        environmentId: target.environmentId,
        input: target.ref,
      });
      if (result._tag === "Failure") throw Cause.squash(result.cause);
      const restart = restarts.get(nativeSessionKey(target));
      if (restart) Queue.offerUnsafe(restart, undefined);
    },
  };
}
