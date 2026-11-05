import { WS_METHODS, type NeoPiNativeSessionRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request as rpcRequest, subscribe } from "../rpc/client.ts";
import { NATIVE_JOBS_CAPABILITY } from "../neopiNativeJobs.ts";
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

const stateReconciliationEvents = new Set([
  "model_changed",
  "models_configuration_changed",
  "thinking_level_changed",
  "chat_mode_changed",
  "mode_changed",
  "prompt_result",
]);
/** A terminal-owned session's control connection carries no `job_lifecycle` frames. */
const JOBS_POLL_INTERVAL = "5 seconds";
const branchReconciliationEvents = new Set([
  "journal_state",
  "journal_entry",
  "agent_end",
  "prompt_result",
]);

/** Native reads run beside the event reducer, never in its delivery path. */
export function reconcileNativeSessionFeed<E, R, ReadE, ReadR>(
  source: Stream.Stream<NativeSessionUpdate, E, R>,
  read: (
    command: Record<string, unknown> & { type: string },
  ) => Effect.Effect<unknown, ReadE, ReadR>,
  initial: NativeSessionFeed,
  onFeed: (feed: NativeSessionFeed) => void,
) {
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
          }).pipe(Effect.catch((error) => failed("state", error))),
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
            yield* read({ type: "set_subagent_subscription", level: "progress" });
            if (!current.connected || current.agentsEpoch !== epoch) return;
            const revision = current.agentsRevision;
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
      yield* Effect.sync(() => {
        if (current.session?.attachment === "terminal") Queue.offerUnsafe(jobReads, undefined);
      }).pipe(Effect.repeat(Schedule.spaced(JOBS_POLL_INTERVAL)), Effect.forkScoped);
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
  const publish = (key: string, update: NativeSessionUpdate) =>
    Effect.sync(() => {
      const queue = updates.get(key);
      if (queue) Queue.offerUnsafe(queue, update);
      else
        cache.set(key, reduceNativeSessionFeed(cache.get(key) ?? emptyNativeSessionFeed(), update));
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
          yield* Effect.acquireRelease(
            Effect.sync(() => updates.set(key, queue)),
            () =>
              Effect.sync(() => {
                if (updates.get(key) === queue) updates.delete(key);
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
                  Stream.tap((event) =>
                    Effect.sync(() => {
                      // A move leaves this observation on the old file, but the
                      // owner keeps talking on it (`/wt` prints its summary after
                      // relocating). Hand those frames to the moved file's feed
                      // until that feed has its own connection.
                      const moved = cache.get(key)?.movedTo;
                      if (!moved || event.type !== "event") return;
                      const movedKey = nativeSessionKey({
                        environmentId: supervisor.target.environmentId,
                        ref: moved,
                      });
                      if (!cache.get(movedKey)?.connected)
                        publish(movedKey, event).pipe(Effect.runSync);
                    }),
                  ),
                  Stream.takeUntil((event) => {
                    if (event.type === "closed") {
                      endedObservations.add(key);
                      return true;
                    }
                    if (event.type === "snapshot") endedObservations.delete(key);
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
                  if (feed.movedTo && !wasMoved)
                    cache.set(
                      nativeSessionKey({
                        environmentId: supervisor.target.environmentId,
                        ref: feed.movedTo,
                      }),
                      { ...feed, movedTo: null, connected: false },
                    );
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
        AsyncResult.isSuccess(current) &&
        !current.value.connected
      )
        get.refresh(source);
      return get.once(source);
    }).pipe(Atom.setIdleTTL(0));
  });
  // Only the mount boundary expires immediately. The observation stays warm
  // for ordinary workspace switching; closed or failed sources restart on remount.
  const watch = (target: Parameters<typeof observation>[0]) => mountedWatch(JSON.stringify(target));
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
  return {
    list,
    open: createEnvironmentRpcCommand(runtime, {
      label: "native-sessions:open",
      tag: WS_METHODS.neopiNativeSessionsOpen,
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
  };
}
