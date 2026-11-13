import { WS_METHODS, type NeoPiNativeSessionRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { requestGuarded as rpcRequest, subscribe } from "../rpc/client.ts";
import { NATIVE_JOBS_CAPABILITY } from "../neopiNativeJobs.ts";
import { SUBAGENT_HISTORY_CAPABILITY } from "../neopiNativeSubagents.ts";
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
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Frames after which NeoPi's `get_state` carries different telemetry: context
 * usage, cost, cache rate and output speed move with turns, compaction and any
 * journal commit (navigation included). A terminal-driven turn emits no
 * `prompt_result` to this client, so the turn and journal frames must trigger it.
 */
const stateReconciliationEvents = new Set([
  "model_changed",
  "models_configuration_changed",
  "thinking_level_changed",
  "chat_mode_changed",
  "mode_changed",
  "prompt_result",
  "agent_end",
  "session_settled",
  "manual_compaction_end",
  "auto_compaction_end",
  "advisor_cost_changed",
  "journal_state",
  "journal_entry",
]);
/**
 * Minimum spacing between telemetry reads, so a burst of journal commits costs
 * one trailing read. A read is always scheduled after the last trigger.
 */
const STATE_READ_MIN_GAP_MS = 1_000;
/**
 * A terminal-owned session's control connection carries no `job_lifecycle`
 * frames and can miss telemetry changes made elsewhere, so a visible tab
 * re-reads state, jobs and agents on this cadence.
 */
const TERMINAL_POLL_INTERVAL_MS = 5_000;
const branchReconciliationEvents = new Set([
  "journal_state",
  "journal_entry",
  "agent_end",
  "prompt_result",
]);

interface VisibilitySource {
  readonly visibilityState?: string;
  addEventListener?(type: "visibilitychange", listener: () => void): void;
  removeEventListener?(type: "visibilitychange", listener: () => void): void;
}
const visibilitySource = (): VisibilitySource | undefined =>
  (globalThis as unknown as { document?: VisibilitySource }).document;
/** Hosts without a document (mobile, server) count as visible. */
const tabVisible = () => visibilitySource()?.visibilityState !== "hidden";

/** Native reads run beside the event reducer, never in its delivery path. */
export function reconcileNativeSessionFeed<E, R, ReadE, ReadR>(
  source: Stream.Stream<NativeSessionUpdate, E, R>,
  read: (
    command: Record<string, unknown> & { type: string },
  ) => Effect.Effect<unknown, ReadE, ReadR>,
  initial: NativeSessionFeed,
  onFeed: (feed: NativeSessionFeed) => void,
  options: { readonly stateReadGapMs?: number; readonly pollIntervalMs?: number } = {},
) {
  const stateReadGapMs = options.stateReadGapMs ?? STATE_READ_MIN_GAP_MS;
  const pollIntervalMs = options.pollIntervalMs ?? TERMINAL_POLL_INTERVAL_MS;
  return Stream.unwrap(
    Effect.gen(function* () {
      const replies = yield* Effect.acquireRelease(
        Queue.unbounded<NativeSessionUpdate>(),
        Queue.shutdown,
      );
      const stateReads = yield* Effect.acquireRelease(Queue.sliding<void>(1), Queue.shutdown);
      const branchReads = yield* Effect.acquireRelease(Queue.sliding<void>(1), Queue.shutdown);
      const subagentReads = yield* Effect.acquireRelease(Queue.sliding<void>(1), Queue.shutdown);
      const jobReads = yield* Effect.acquireRelease(Queue.sliding<void>(1), Queue.shutdown);
      let current = initial;
      let divergentEntry = false;
      // Subagent progress is subscribed once per connection; polls only re-read the roster.
      let agentsSubscribed = false;
      const needsBranch = () => {
        const conversation = current.conversation;
        return (
          current.connected &&
          conversation.needsSnapshot &&
          conversation.identity !== null &&
          (divergentEntry ||
            !current.busy ||
            conversation.identity.leafId === null ||
            conversation.entries.some((entry) => entry.id === conversation.identity?.leafId))
        );
      };
      const recovered = (operation: "state" | "branch" | "subagents" | "jobs") =>
        Queue.offer(replies, { type: "reconciliation", operation, error: null });
      const failed = (operation: "state" | "branch" | "subagents" | "jobs", error: unknown) =>
        Queue.offer(replies, {
          type: "reconciliation",
          operation,
          error: error instanceof Error ? error.message : String(error),
        });
      yield* Stream.fromQueue(stateReads).pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            if (!current.connected) return;
            const state = nativeRecord(yield* read({ type: "get_state", includeDump: false }));
            yield* Queue.offer(replies, { type: "state", state });
            yield* recovered("state");
          }).pipe(
            Effect.catch((error) => failed("state", error)),
            // Triggers that land meanwhile wait in the sliding queue and run once after the gap.
            Effect.andThen(stateReadGapMs > 0 ? Effect.sleep(stateReadGapMs) : Effect.void),
          ),
        ),
        Effect.forkScoped,
      );
      yield* Stream.fromQueue(branchReads).pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            if (!needsBranch()) return;
            const { identity, revision } = current.conversation;
            if (!identity) return;
            const page = nativeJournalPage(
              yield* read({
                type: "get_entries_page",
                scope: "branch",
                direction: "backward",
                limit: 128,
              }),
            );
            if (!page)
              return yield* failed(
                "branch",
                new Error("NeoPi returned an invalid native branch page."),
              );
            yield* Queue.offer(replies, { type: "page", page, revision, identity, older: false });
          }).pipe(Effect.catch((error) => failed("branch", error))),
        ),
        Effect.forkScoped,
      );
      yield* Stream.fromQueue(subagentReads).pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            if (!current.connected || !current.session) return;
            const { ref, sessionId } = current.session;
            const epoch = current.agentsEpoch;
            // This is the existing native owner's control connection, not a
            // new session/stream. Control subscription levels are per peer.
            if (!agentsSubscribed) {
              yield* read({ type: "set_subagent_subscription", level: "progress" });
              agentsSubscribed = true;
            }
            if (!current.connected || current.agentsEpoch !== epoch) return;
            const revision = current.agentsRevision;
            // Finished and persisted children are only in the history; a failed read leaves
            // the live inventory to carry the roster, as for a NeoPi that cannot list them.
            const history = current.session.capabilities.includes(SUBAGENT_HISTORY_CAPABILITY)
              ? nativeRecord(
                  yield* read({ type: "get_subagent_history" }).pipe(
                    Effect.orElseSucceed(() => null),
                  ),
                ).subagents
              : undefined;
            const result = nativeRecord(yield* read({ type: "get_subagents" }));
            if (!Array.isArray(result.subagents))
              return yield* failed(
                "subagents",
                new Error("NeoPi returned an invalid subagent inventory."),
              );
            yield* Queue.offer(replies, {
              type: "subagents",
              ref,
              sessionId,
              epoch,
              revision,
              ...(Array.isArray(history) ? { history } : {}),
              agents: result.subagents,
            });
            yield* recovered("subagents");
          }).pipe(Effect.catch((error) => failed("subagents", error))),
        ),
        Effect.forkScoped,
      );
      const jobsSupported = () =>
        current.connected &&
        current.session?.capabilities.includes(NATIVE_JOBS_CAPABILITY) === true;
      yield* Stream.fromQueue(jobReads).pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            if (!jobsSupported() || !current.session) return;
            const { ref, sessionId } = current.session;
            const revision = current.jobs.revision;
            const response = yield* read({ type: "get_jobs" });
            yield* Queue.offer(replies, { type: "jobs", ref, sessionId, revision, response });
            yield* recovered("jobs");
          }).pipe(Effect.catch((error) => failed("jobs", error))),
        ),
        Effect.forkScoped,
      );
      const pollTerminalTelemetry = () => {
        if (current.session?.attachment !== "terminal" || !tabVisible()) return;
        Queue.offerUnsafe(stateReads, undefined);
        Queue.offerUnsafe(jobReads, undefined);
        Queue.offerUnsafe(subagentReads, undefined);
      };
      yield* Effect.sleep(pollIntervalMs).pipe(
        Effect.andThen(Effect.sync(pollTerminalTelemetry)),
        Effect.forever,
        Effect.forkScoped,
      );
      // A tab that was hidden catches up the moment it is shown again.
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          visibilitySource()?.addEventListener?.("visibilitychange", pollTerminalTelemetry),
        ),
        () =>
          Effect.sync(() =>
            visibilitySource()?.removeEventListener?.("visibilitychange", pollTerminalTelemetry),
          ),
      );
      return Stream.merge(source, Stream.fromQueue(replies), { haltStrategy: "left" }).pipe(
        Stream.map((event) => {
          current = reduceNativeSessionFeed(current, event);
          if (!current.conversation.needsSnapshot) divergentEntry = false;
          else if (event.type === "event" && event.frame.type === "journal_entry") {
            const entryId = nativeRecord(event.frame.entry).id;
            if (
              typeof entryId === "string" &&
              event.frame.sessionId === current.conversation.identity?.sessionId &&
              event.frame.sessionFile === current.conversation.identity?.sessionFile &&
              !current.conversation.entries.some((entry) => entry.id === entryId)
            )
              divergentEntry = true;
          }
          onFeed(current);
          if (event.type === "snapshot") {
            agentsSubscribed = false;
            Queue.offerUnsafe(subagentReads, undefined);
            Queue.offerUnsafe(jobReads, undefined);
          }
          if (event.type === "event" && event.frame.type === "agent_end")
            Queue.offerUnsafe(jobReads, undefined);
          if (event.type === "event") {
            if (stateReconciliationEvents.has(event.frame.type))
              Queue.offerUnsafe(stateReads, undefined);
            // Native uses `leaf` for both append and navigation. Active append
            // notifications resolve through durable parent-linked entries; known
            // ancestors and idle unknown branches need a bounded native page.
            if (needsBranch() && branchReconciliationEvents.has(event.frame.type))
              Queue.offerUnsafe(branchReads, undefined);
          } else if (
            event.type === "page" &&
            !event.older &&
            event.revision !== current.conversation.revision &&
            needsBranch()
          ) {
            Queue.offerUnsafe(branchReads, undefined);
          }
          return current;
        }),
        // Reconciliation and cache updates still consume every raw frame;
        // unchanged projections must not republish fresh stream-atom results.
        Stream.changes,
      );
    }),
  );
}

export function createNativeSessionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const cache = new Map<string, NativeSessionFeed>();
  const updates = new Map<string, Queue.Queue<NativeSessionUpdate>>();
  const endedObservations = new Set<string>();
  const restartingObservations = new Set<Queue.Queue<NativeSessionUpdate>>();
  /** Sessions the user detached from; a revisit leaves them detached until `reconnect`. */
  const detachedObservations = new Set<string>();
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
  const observation = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "native-sessions:watch",
    idleTtlMs: 5 * 60_000,
    subscribe: (input: { ref: NeoPiNativeSessionRef }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          const key = nativeSessionKey({
            environmentId: supervisor.target.environmentId,
            ref: input.ref,
          });
          const queue = yield* Queue.unbounded<NativeSessionUpdate>();
          const handedOffKeys = new Set<string>();
          yield* Effect.acquireRelease(
            Effect.sync(() => updates.set(key, queue)),
            () =>
              Effect.sync(() => {
                const restarting = restartingObservations.delete(queue);
                if (updates.get(key) !== queue) return;
                updates.delete(key);
                if (!restarting) cache.delete(key);
                endedObservations.delete(key);
                // Unobserved move handoffs live only as long as their source.
                // A mounted destination owns its own feed and must stay intact.
                for (const movedKey of handedOffKeys)
                  if (!updates.has(movedKey)) {
                    cache.delete(movedKey);
                    endedObservations.delete(movedKey);
                  }
              }),
          );
          return SubscriptionRef.changes(supervisor.session).pipe(
            Stream.switchMap((session) => {
              if (Option.isNone(session))
                return Stream.succeed({ type: "disconnected" } as const).pipe(
                  Stream.map((event) => {
                    const feed = reduceNativeSessionFeed(
                      cache.get(key) ?? emptyNativeSessionFeed(),
                      event,
                    );
                    cache.set(key, feed);
                    return feed;
                  }),
                );
              const remote = Stream.unwrap(
                rpcRequest(WS_METHODS.neopiNativeSessionsOpen, input.ref).pipe(
                  Effect.as(subscribe(WS_METHODS.neopiNativeSessionsWatch, input)),
                ),
              ).pipe(
                Stream.catch((error) => {
                  endedObservations.add(key);
                  return Stream.fromIterable<NativeSessionUpdate>([
                    { type: "disconnected" },
                    { type: "reconciliation", operation: "state", error: error.message },
                  ]);
                }),
                // The server closing the watch without a `closed` event still ends this
                // observation; a revisit must reopen it rather than reuse the dead feed.
                (source) =>
                  Stream.concat(
                    source,
                    Stream.fromEffect(Effect.sync(() => endedObservations.add(key))).pipe(
                      Stream.drain,
                    ),
                  ),
              );
              return reconcileNativeSessionFeed(
                Stream.merge(
                  // A remounted observer may have missed lifecycle frames while
                  // idle. Cached running status is unverified until inventory.
                  Stream.concat(
                    Stream.succeed<NativeSessionUpdate>({ type: "disconnected" }),
                    remote,
                  ),
                  Stream.fromQueue(queue),
                  { haltStrategy: "left" },
                ).pipe(
                  Stream.tap((event) => {
                    // The owner can emit more frames on the old file after relocating.
                    const moved = cache.get(key)?.movedTo;
                    if (!moved || event.type !== "event") return Effect.void;
                    const movedKey = nativeSessionKey({
                      environmentId: supervisor.target.environmentId,
                      ref: moved,
                    });
                    return cache.get(movedKey)?.connected ? Effect.void : publish(movedKey, event);
                  }),
                  Stream.takeUntil((event) => {
                    if (event.type === "closed") {
                      endedObservations.add(key);
                      if (event.code === "detached") detachedObservations.add(key);
                      return true;
                    }
                    if (event.type === "snapshot") {
                      endedObservations.delete(key);
                      detachedObservations.delete(key);
                    }
                    // Another session id on a different file is a new owner. The same
                    // session on a different file is a move, which the feed follows.
                    return (
                      event.type === "event" &&
                      event.frame.type === "journal_state" &&
                      typeof event.frame.sessionFile === "string" &&
                      event.frame.sessionFile !== input.ref.sessionFile &&
                      event.frame.sessionId !== cache.get(key)?.session?.sessionId
                    );
                  }),
                ),
                (command) =>
                  rpcRequest(WS_METHODS.neopiNativeSessionsRequest, { ref: input.ref, command }),
                cache.get(key) ?? emptyNativeSessionFeed(),
                (feed) => {
                  const wasMoved = cache.get(key)?.movedTo != null;
                  cache.set(key, feed);
                  // The moved session's own observation starts from what is
                  // already known, so the transcript does not flash empty.
                  if (feed.movedTo && !wasMoved) {
                    const movedKey = nativeSessionKey({
                      environmentId: supervisor.target.environmentId,
                      ref: feed.movedTo,
                    });
                    if (!updates.has(movedKey)) {
                      handedOffKeys.add(movedKey);
                      cache.set(movedKey, { ...feed, movedTo: null, connected: false });
                    }
                  }
                },
              );
            }),
          );
        }),
      ),
  });
  const mountedWatch = Atom.family((key: string) => {
    const target = JSON.parse(key) as Parameters<typeof observation>[0];
    const source = observation(target);
    const sessionKey = nativeSessionKey({
      environmentId: target.environmentId,
      ref: target.input.ref,
    });
    return Atom.make((get) => {
      const current = get.once(source);
      // Forward updates without recalculating this mount boundary: a close or
      // failure must not itself reopen the native owner.
      get.subscribe(source, (value) => get.setSelf(value));
      if (
        endedObservations.has(sessionKey) &&
        !detachedObservations.has(sessionKey) &&
        AsyncResult.isSuccess(current) &&
        !current.value.connected
      ) {
        const queue = updates.get(sessionKey);
        if (queue) restartingObservations.add(queue);
        get.refresh(source);
      }
      return get.once(source);
    }).pipe(Atom.setIdleTTL(0));
  });
  // Only the mount boundary expires immediately. The observation stays warm
  // for ordinary workspace switching; closed or failed sources restart on remount.
  const watch = (target: Parameters<typeof observation>[0]) => mountedWatch(JSON.stringify(target));
  const request = createEnvironmentRpcCommand(runtime, {
    label: "native-sessions:request",
    tag: WS_METHODS.neopiNativeSessionsRequest,
    execute: Effect.fn("nativeSessions.request")(function* (input) {
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
        // A panel-initiated read folds into the feed like the reconciler's own.
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
    tree: createEnvironmentQueryAtomFamily(runtime, {
      label: "native-sessions:tree",
      staleTimeMs: 0,
      idleTtlMs: 0,
      execute: (input: { readonly ref: NeoPiNativeSessionRef }) =>
        rpcRequest(WS_METHODS.neopiNativeSessionsRequest, {
          ref: input.ref,
          command: { type: "get_tree" },
        }),
    }),
    launch: createEnvironmentRpcCommand(runtime, {
      label: "native-sessions:launch",
      tag: WS_METHODS.neopiNativeSessionsLaunch,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(list({ environmentId: target.environmentId, input: {} })),
        ),
    }),
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
    watch,
    cached: (target: NativeSessionTarget) => cache.get(nativeSessionKey(target)),
    /**
     * Opens the session again after its owner is gone or the user detached, and restarts the
     * observation. The server attaches to a live terminal owner when there is one and otherwise
     * starts NeoCode's own, so this is also how a quit terminal is taken over. Rejects with the
     * open failure; otherwise resolves once the feed has a live owner, or after `timeoutMs`.
     */
    reconnect: async (
      registry: AtomRegistry.AtomRegistry,
      target: NativeSessionTarget,
      timeoutMs = 15_000,
    ) => {
      const result = await open.run(registry, {
        environmentId: target.environmentId,
        input: target.ref,
      });
      if (result._tag === "Failure") throw Cause.squash(result.cause);
      detachedObservations.delete(nativeSessionKey(target));
      const atom = watch({ environmentId: target.environmentId, input: { ref: target.ref } });
      registry.refresh(atom);
      await new Promise<void>((resolve) => {
        let unsubscribe: (() => void) | undefined;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          unsubscribe?.();
          resolve();
        };
        // @effect-diagnostics-next-line globalTimers:off - a bounded wait in this async UI action, outside an Effect runtime
        const timer = setTimeout(finish, timeoutMs);
        unsubscribe = registry.subscribe(
          atom,
          (value) => {
            if (AsyncResult.isSuccess(value) && value.value.connected) finish();
          },
          { immediate: true },
        );
        if (done) unsubscribe();
      });
    },
  };
}
