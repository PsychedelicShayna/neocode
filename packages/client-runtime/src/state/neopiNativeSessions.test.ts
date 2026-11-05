import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  WS_METHODS,
  ProviderInstanceId,
  type NeoPiJournalEntry,
  type NeoPiJournalPage,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import * as TestClock from "effect/testing/TestClock";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  emptyNativeSessionFeed,
  reduceNativeSessionFeed,
  type NativeSession,
  type NativeSessionFeed,
  type NativeSessionUpdate,
} from "../neopiNativeSessions.ts";
import { createNativeSessionAtoms, reconcileNativeSessionFeed } from "./neopiNativeSessions.ts";

class StateReadError extends Schema.TaggedError<StateReadError>()("StateReadError", {
  message: Schema.String,
}) {}

const ref = {
  providerInstanceId: ProviderInstanceId.make("neopi"),
  sessionFile: "/sessions/feed.jsonl",
};
const session: NativeSession = {
  ref,
  sessionId: "session",
  cwd: "/workspace",
  attachment: "terminal",
  capabilities: [],
  state: {},
};
const user: NeoPiJournalEntry = {
  id: "user",
  parentId: null,
  timestamp: "2026-10-28T00:00:00Z",
  type: "message",
  message: { role: "user", content: "Question" },
};
const identity = (leafId: string | null) => ({
  sessionId: session.sessionId,
  sessionFile: ref.sessionFile,
  leafId,
});
const page = (entries: readonly NeoPiJournalEntry[]): NeoPiJournalPage => ({
  ...identity(entries.at(-1)?.id ?? null),
  entries,
  totalEntries: entries.length,
});
const initial = (busy = false, entries: readonly NeoPiJournalEntry[] = [user]) =>
  reduceNativeSessionFeed(emptyNativeSessionFeed(), {
    type: "snapshot",
    session: { ...session, state: { isStreaming: busy } },
    journal: page(entries),
  });
const event = (frame: Record<string, unknown> & { type: string }): NativeSessionUpdate => ({
  type: "event",
  frame,
});
const nextFeed = (
  feeds: Queue.Queue<NativeSessionFeed>,
  predicate: (feed: NativeSessionFeed) => boolean,
) =>
  Stream.fromQueue(feeds).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
const harness = <E, R>(
  read: (command: Record<string, unknown> & { type: string }) => Effect.Effect<unknown, E, R>,
  seed = initial(),
) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<NativeSessionUpdate>();
    const feeds = yield* Queue.unbounded<NativeSessionFeed>();
    yield* reconcileNativeSessionFeed(
      Stream.fromQueue(events).pipe(Stream.takeUntil((update) => update.type === "closed")),
      read,
      seed,
      () => {},
    ).pipe(
      Stream.runForEach((feed) => Queue.offer(feeds, feed)),
      Effect.forkScoped,
    );
    return { events, feeds };
  });

const makeAtomHarness = Effect.fn("NativeSessionAtomsTest.makeHarness")(function* () {
  const subscriptions = yield* Queue.unbounded<{
    readonly events: Queue.Queue<NativeSessionUpdate, StateReadError>;
    readonly detached: Deferred.Deferred<void>;
  }>();
  const active = new Set<Queue.Queue<NativeSessionUpdate, StateReadError>>();
  let opens = 0;
  let closes = 0;
  let prompts = 0;
  const client = {
    [WS_METHODS.neopiNativeSessionsOpen]: () =>
      Effect.sync(() => {
        opens++;
        return session;
      }),
    [WS_METHODS.neopiNativeSessionsClose]: () =>
      Effect.gen(function* () {
        closes++;
        for (const events of active)
          yield* Queue.offer(events, {
            type: "closed",
            reason: "The native connection was explicitly closed.",
          });
        return { closed: true };
      }),
    [WS_METHODS.neopiNativeSessionsRequest]: (input: {
      readonly command: Record<string, unknown> & { type: string };
    }) =>
      Effect.sync(() => {
        if (input.command.type === "get_subagents") return { subagents: [] };
        if (input.command.type === "prompt") {
          prompts++;
          return { userEntryId: "new-turn" };
        }
        return {};
      }),
    [WS_METHODS.neopiNativeSessionsWatch]: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<NativeSessionUpdate, StateReadError>();
          const detached = yield* Deferred.make<void>();
          yield* Effect.acquireRelease(
            Effect.sync(() => active.add(events)),
            () =>
              Effect.sync(() => active.delete(events)).pipe(
                Effect.andThen(Deferred.succeed(detached, undefined)),
              ),
          );
          yield* Queue.offer(subscriptions, { events, detached });
          return Stream.concat(
            Stream.succeed<NativeSessionUpdate>({
              type: "snapshot",
              session,
              journal: page([user]),
            }),
            Stream.fromQueue(events).pipe(Stream.takeUntil((update) => update.type === "closed")),
          );
        }),
      ),
  } as unknown as WsRpcProtocolClient;
  const connection = { client } as RpcSession;
  const environmentId = EnvironmentId.make("native-remote");
  const sessionRef = yield* SubscriptionRef.make(Option.some(connection));
  const supervisor = EnvironmentSupervisor.of({
    target: { environmentId },
    session: sessionRef,
  } as EnvironmentSupervisor["Service"]);
  const environments = EnvironmentRegistry.of({
    run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    followStream: (_id, stream) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"]);
  const atoms = createNativeSessionAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry, environments)),
  );
  // Normal work uses microtasks; tests can drain disposal deterministically
  // without advancing the old five-minute retention period.
  const scheduled = new Set<() => void>();
  const flush = () => {
    while (scheduled.size > 0) scheduled.values().next().value!();
  };
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() =>
      AtomRegistry.make({
        scheduleTask: (f) => {
          const task = () => {
            if (scheduled.delete(task)) f();
          };
          scheduled.add(task);
          queueMicrotask(task);
          return () => {
            scheduled.delete(task);
          };
        },
      }),
    ),
    (registry) => Effect.sync(() => registry.dispose()),
  );
  const target = { environmentId, ref };
  const watch = atoms.watch({ environmentId, input: { ref } });
  const observe = (predicate: (feed: NativeSessionFeed) => boolean) =>
    AtomRegistry.toStream(registry, watch).pipe(
      Stream.filter(AsyncResult.isSuccess),
      Stream.map((result) => result.value),
      Stream.filter(predicate),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  return {
    atoms,
    registry,
    watch,
    target,
    observe,
    flush,
    connection,
    sessionRef,
    subscriptions,
    counts: () => ({ opens, closes, prompts, active: active.size }),
  };
});

describe("native session observation lifetime", () => {
  it.effect(
    "reopens an explicitly closed canonical ref with cached history and command output",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeAtomHarness();
          const unmount = h.registry.mount(h.watch);
          const first = yield* Queue.take(h.subscriptions);
          yield* h.observe((feed) => feed.connected);
          yield* Queue.offer(
            first.events,
            event({ type: "command_output", text: "Retained native command output" }),
          );
          const before = yield* h.observe((feed) => feed.commandOutputs.length === 1);
          const closed = yield* Effect.promise(() =>
            h.atoms.close.run(h.registry, {
              environmentId: h.target.environmentId,
              input: { ref },
            }),
          );
          expect(closed._tag).toBe("Success");
          const stopped = yield* h.observe((feed) => !feed.connected && feed.error !== null);
          expect(stopped.error).toBe("The native connection was explicitly closed.");
          expect(stopped.conversation.entries).toEqual([user]);
          expect(stopped.commandOutputs).toEqual(before.commandOutputs);
          yield* Deferred.await(first.detached);
          expect(h.counts().opens).toBe(1);

          unmount();
          h.flush();
          expect(h.atoms.cached(h.target)?.conversation.entries).toEqual([user]);
          expect(h.atoms.cached(h.target)?.commandOutputs).toEqual(before.commandOutputs);

          const remount = h.registry.mount(h.watch);
          const second = yield* Queue.take(h.subscriptions);
          expect(second.events).not.toBe(first.events);
          const reopened = yield* h.observe((feed) => feed.connected);
          expect(reopened.error).toBeNull();
          expect(reopened.conversation.entries).toEqual([user]);
          expect(reopened.commandOutputs).toEqual(before.commandOutputs);
          expect(reopened.session?.ref).toEqual(ref);
          const reply = yield* Effect.promise(() =>
            h.atoms.request.run(h.registry, {
              environmentId: h.target.environmentId,
              input: { ref, command: { type: "prompt", message: "After reopen" } },
            }),
          );
          expect(reply).toMatchObject({ _tag: "Success", value: { userEntryId: "new-turn" } });
          yield* Queue.offer(
            second.events,
            event({
              type: "message_update",
              messageId: "new-live",
              message: { role: "assistant", content: "Live after reopen" },
            }),
          );
          const live = yield* h.observe(
            (feed) => feed.conversation.pending[0]?.message.content === "Live after reopen",
          );
          expect(live.connected).toBe(true);
          expect(live.commandOutputs).toEqual(before.commandOutputs);
          expect(h.counts()).toEqual({ opens: 2, closes: 1, prompts: 1, active: 1 });
          remount();
        }),
      ),
  );

  it.effect("recovers a failed observer when the same connected session is reopened", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeAtomHarness();
        const unmount = h.registry.mount(h.watch);
        const first = yield* Queue.take(h.subscriptions);
        yield* h.observe((feed) => feed.connected);
        yield* Queue.offer(
          first.events,
          event({ type: "command_output", text: "Before observer failure" }),
        );
        const before = yield* h.observe((feed) => feed.commandOutputs.length === 1);

        yield* Queue.fail(first.events, new StateReadError({ message: "Native observer failed." }));
        const failed = yield* h.observe((feed) => !feed.connected && feed.error !== null);
        yield* Deferred.await(first.detached);
        expect(failed.error).toContain("Native observer failed.");
        expect(failed.conversation.entries).toEqual([user]);
        expect(failed.commandOutputs).toEqual(before.commandOutputs);
        expect(h.counts()).toEqual({ opens: 1, closes: 0, prompts: 0, active: 0 });
        expect(yield* SubscriptionRef.get(h.sessionRef)).toEqual(Option.some(h.connection));

        unmount();
        h.flush();
        const opened = yield* Effect.promise(() =>
          h.atoms.open.run(h.registry, { environmentId: h.target.environmentId, input: ref }),
        );
        expect(opened).toMatchObject({ _tag: "Success", value: { ref } });
        const remount = h.registry.mount(h.watch);
        yield* Effect.yieldNow;
        const reopened = yield* AtomRegistry.getResult(h.registry, h.watch);
        expect(reopened.connected).toBe(true);
        expect(reopened.error).toBeNull();
        expect(reopened.conversation.entries).toEqual([user]);
        expect(reopened.commandOutputs).toEqual(before.commandOutputs);

        const second = yield* Queue.take(h.subscriptions);
        yield* Queue.offer(
          second.events,
          event({
            type: "message_update",
            messageId: "recovered-live",
            message: { role: "assistant", content: "Delivered after observer recovery" },
          }),
        );
        const live = yield* h.observe(
          (feed) =>
            feed.conversation.pending[0]?.message.content === "Delivered after observer recovery",
        );
        expect(live.connected).toBe(true);
        expect(h.counts()).toEqual({ opens: 3, closes: 0, prompts: 0, active: 1 });
        remount();
      }),
    ),
  );

  it.effect("keeps a running observation warm through switch-away and switch-back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeAtomHarness();
        const unmount = h.registry.mount(h.watch);
        const first = yield* Queue.take(h.subscriptions);
        yield* h.observe((feed) => feed.connected);
        yield* Queue.offer(first.events, event({ type: "agent_start" }));
        yield* h.observe((feed) => feed.busy);

        unmount();
        h.flush();
        expect(h.counts()).toEqual({ opens: 1, closes: 0, prompts: 0, active: 1 });
        const reply = {
          ...user,
          id: "background-reply",
          parentId: user.id,
          message: { role: "assistant", content: "Delivered while elsewhere" },
        };
        yield* Queue.offerAll(first.events, [
          event({ type: "journal_state", reason: "leaf", ...identity(reply.id) }),
          event({ type: "journal_entry", ...identity(reply.id), entry: reply }),
          event({ type: "command_output", text: "Background command output" }),
        ]);

        const remount = h.registry.mount(h.watch);
        const returned = yield* h.observe(
          (feed) => feed.busy && feed.commandOutputs[0]?.text === "Background command output",
        );
        expect(returned.connected).toBe(true);
        expect(returned.conversation.entries).toEqual([user, reply]);
        expect(returned.error).toBeNull();
        // No second open/watch or snapshot is needed: the background stream
        // delivered the durable reply and command output through the same peer.
        expect(h.counts()).toEqual({ opens: 1, closes: 0, prompts: 0, active: 1 });
        expect(yield* Deferred.isDone(first.detached)).toBe(false);
        yield* Queue.offer(first.events, event({ type: "agent_end" }));
        const settled = yield* h.observe((feed) => !feed.busy);
        expect(settled.conversation.entries).toEqual([user, reply]);
        remount();
      }),
    ),
  );

  it.effect("shares active observers and reconnects the environment without a native close", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeAtomHarness();
        const firstObserver = h.registry.mount(h.watch);
        const secondObserver = h.registry.mount(h.watch);
        const first = yield* Queue.take(h.subscriptions);
        yield* h.observe((feed) => feed.connected);
        firstObserver();
        h.flush();
        expect(h.counts()).toEqual({ opens: 1, closes: 0, prompts: 0, active: 1 });

        yield* SubscriptionRef.set(h.sessionRef, Option.none());
        const offline = yield* h.observe((feed) => !feed.connected);
        expect(offline.conversation.entries).toEqual([user]);
        yield* Deferred.await(first.detached);
        yield* SubscriptionRef.set(h.sessionRef, Option.some({ ...h.connection }));
        const second = yield* Queue.take(h.subscriptions);
        yield* h.observe((feed) => feed.connected);
        expect(h.counts()).toEqual({ opens: 2, closes: 0, prompts: 0, active: 1 });

        secondObserver();
        h.flush();
        expect(h.counts()).toEqual({ opens: 2, closes: 0, prompts: 0, active: 1 });
        // The underlying five-minute observation remains warm. Disposing the
        // client registry still must not invoke the native owner's close RPC.
        h.registry.dispose();
        yield* Deferred.await(second.detached);
        expect(h.counts()).toEqual({ opens: 2, closes: 0, prompts: 0, active: 0 });
      }),
    ),
  );
});

describe("native feed reconciliation lifetime", () => {
  it.effect(
    "delivers raw updates while get_state is blocked and coalesces subsequent state reads",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          const calls = yield* Queue.unbounded<number>();
          let count = 0;
          const read = Effect.gen(function* () {
            const call = ++count;
            yield* Queue.offer(calls, call);
            yield* Deferred.await(release);
            return { model: { id: `model-${call}` } };
          });
          const { events, feeds } = yield* harness(() => read, initial(true));
          yield* Queue.offer(events, event({ type: "model_changed" }));
          expect(yield* Queue.take(calls)).toBe(1);
          yield* Queue.offerAll(events, [
            event({ type: "thinking_level_changed" }),
            event({ type: "mode_changed" }),
            event({ type: "models_configuration_changed" }),
            event({
              type: "message_update",
              messageId: "live",
              message: { role: "assistant", content: "Visible before state reply" },
            }),
          ]);
          const streaming = yield* nextFeed(
            feeds,
            (feed) =>
              feed.conversation.pending[0]?.message.content === "Visible before state reply",
          );
          expect(streaming.conversation.entries).toEqual([user]);
          expect(streaming.conversation.pending).toEqual([
            {
              messageId: "live",
              message: { role: "assistant", content: "Visible before state reply" },
            },
          ]);
          yield* Deferred.succeed(release, undefined);
          expect(yield* Queue.take(calls)).toBe(2);
          const refreshed = yield* nextFeed(
            feeds,
            (feed) => (feed.session?.state.model as { id?: string } | undefined)?.id === "model-2",
          );
          expect(refreshed.conversation.pending).toEqual(streaming.conversation.pending);
          expect(count).toBe(2);
        }),
      ),
  );

  it.effect(
    "keeps a failed state read nonfatal and clears its error on a successful reconciliation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let calls = 0;
          const { events, feeds } = yield* harness(() =>
            Effect.suspend(() =>
              ++calls === 1
                ? Effect.fail(new StateReadError({ message: "State temporarily unavailable" }))
                : Effect.succeed({ model: { id: "recovered" } }),
            ),
          );
          yield* Queue.offer(events, event({ type: "model_changed" }));
          const failed = yield* nextFeed(
            feeds,
            (feed) => feed.error === "State temporarily unavailable",
          );
          expect(failed.conversation.entries).toEqual([user]);
          yield* Queue.offer(
            events,
            event({
              type: "message_update",
              messageId: "live",
              message: { role: "assistant", content: "Continues after failure" },
            }),
          );
          const live = yield* nextFeed(
            feeds,
            (feed) => feed.conversation.pending[0]?.message.content === "Continues after failure",
          );
          expect(live.connected).toBe(true);
          expect(live.error).toBe("State temporarily unavailable");
          yield* Queue.offer(events, event({ type: "prompt_result", status: "success" }));
          const recovered = yield* nextFeed(
            feeds,
            (feed) =>
              feed.error === null &&
              (feed.session?.state.model as { id?: string } | undefined)?.id === "recovered",
          );
          expect(recovered.conversation.pending).toEqual(live.conversation.pending);
          expect(recovered.reconciliationError).toBeNull();
        }),
      ),
  );

  it.effect("does not resnapshot ordinary active appends or their settlement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reads: string[] = [];
        const { events, feeds } = yield* harness(
          (command) =>
            Effect.sync(() => {
              reads.push(command.type);
              return {};
            }),
          initial(true),
        );
        const reply = {
          ...user,
          id: "reply",
          parentId: user.id,
          message: { role: "assistant", content: "Durable reply" },
        };
        yield* Queue.offerAll(events, [
          event({ type: "journal_state", reason: "leaf", ...identity(reply.id) }),
          event({ type: "journal_entry", ...identity(reply.id), entry: reply }),
          event({ type: "agent_end" }),
        ]);
        const settled = yield* nextFeed(
          feeds,
          (feed) => !feed.busy && feed.conversation.entries.at(-1)?.id === reply.id,
        );
        expect(settled.conversation.entries).toEqual([user, reply]);
        expect(settled.conversation.needsSnapshot).toBe(false);
        expect(reads).toEqual([]);
      }),
    ),
  );

  it.effect("hydrates an unknown idle branch without blanking the cached transcript", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const old = {
          ...user,
          id: "old",
          parentId: user.id,
          message: { role: "assistant", content: "Old branch" },
        };
        const branch = {
          ...user,
          id: "branch",
          parentId: user.id,
          message: { role: "assistant", content: "Native branch" },
        };
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<NeoPiJournalPage>();
        const { events, feeds } = yield* harness(
          () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              return yield* Deferred.await(release);
            }),
          initial(false, [user, old]),
        );
        yield* Queue.offer(
          events,
          event({ type: "journal_state", reason: "leaf", ...identity(branch.id) }),
        );
        yield* Deferred.await(started);
        const hydrating = yield* nextFeed(feeds, (feed) => feed.conversation.needsSnapshot);
        expect(hydrating.conversation.entries).toEqual([user, old]);
        yield* Deferred.succeed(release, { ...page([user, branch]), nextCursor: "branch-cursor" });
        const hydrated = yield* nextFeed(feeds, (feed) => !feed.conversation.needsSnapshot);
        expect(hydrated.conversation.entries).toEqual([user, branch]);
        expect(hydrated.conversation.cursor).toBe("branch-cursor");
        expect(hydrated.conversation.cursorLeaf).toBe(branch.id);
      }),
    ),
  );

  it.effect("hydrates a known ancestor move even if the previous stream was busy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const old = { ...user, id: "old", parentId: user.id };
        const { events, feeds } = yield* harness(
          () => Effect.succeed(page([user])),
          initial(true, [user, old]),
        );
        yield* Queue.offer(
          events,
          event({ type: "journal_state", reason: "leaf", ...identity(user.id) }),
        );
        const moved = yield* nextFeed(
          feeds,
          (feed) =>
            !feed.conversation.needsSnapshot && feed.conversation.entries.at(-1)?.id === user.id,
        );
        expect(moved.conversation.entries).toEqual([user]);
        expect(moved.conversation.identity?.leafId).toBe(user.id);
      }),
    ),
  );

  it.effect("does not roll newer durable appends back when an older branch read completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = { ...user, id: "first", parentId: user.id };
        const latest = { ...user, id: "latest", parentId: first.id };
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<NeoPiJournalPage>();
        const { events, feeds } = yield* harness(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            return yield* Deferred.await(release);
          }),
        );
        yield* Queue.offer(
          events,
          event({ type: "journal_state", reason: "leaf", ...identity(first.id) }),
        );
        yield* Deferred.await(started);
        yield* Queue.offerAll(events, [
          event({ type: "journal_entry", ...identity(first.id), entry: first }),
          event({ type: "journal_state", reason: "leaf", ...identity(latest.id) }),
          event({ type: "journal_entry", ...identity(latest.id), entry: latest }),
          event({ type: "agent_start" }),
        ]);
        const durable = yield* nextFeed(feeds, (feed) => feed.busy);
        expect(durable.conversation.entries).toEqual([user, first, latest]);
        yield* Deferred.succeed(release, { ...page([user, first]), nextCursor: "stale-cursor" });
        const afterReply = yield* Queue.take(feeds);
        expect(afterReply.conversation).toBe(durable.conversation);
        expect(afterReply.conversation.identity?.leafId).toBe(latest.id);
        expect(afterReply.conversation.cursor).not.toBe("stale-cursor");
      }),
    ),
  );

  it.effect(
    "hydrates divergent durable ancestry during a stream and retains messages received while reading",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const old = { ...user, id: "old", parentId: user.id };
          const branch = { ...user, id: "branch", parentId: user.id };
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<NeoPiJournalPage>();
          const { events, feeds } = yield* harness(
            () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                return yield* Deferred.await(release);
              }),
            initial(true, [user, old]),
          );
          yield* Queue.offerAll(events, [
            event({ type: "journal_state", reason: "leaf", ...identity(branch.id) }),
            event({ type: "journal_entry", ...identity(branch.id), entry: branch }),
          ]);
          yield* Deferred.await(started);
          yield* Queue.offer(
            events,
            event({
              type: "message_update",
              messageId: "branch-live",
              message: { role: "assistant", content: "Branch stream" },
            }),
          );
          const streaming = yield* nextFeed(
            feeds,
            (feed) => feed.conversation.pending[0]?.message.content === "Branch stream",
          );
          expect(streaming.conversation.entries).toEqual([user, old]);
          yield* Deferred.succeed(release, page([user, branch]));
          const hydrated = yield* nextFeed(feeds, (feed) => !feed.conversation.needsSnapshot);
          expect(hydrated.conversation.entries).toEqual([user, branch]);
          expect(hydrated.conversation.pending).toEqual(streaming.conversation.pending);
          expect(hydrated.busy).toBe(true);
        }),
      ),
  );

  it.effect("interrupts blocked reconciliation when the canonical feed closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const { events, feeds } = yield* harness(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
        );
        yield* Queue.offer(events, event({ type: "model_changed" }));
        yield* Deferred.await(started);
        yield* Queue.offer(events, { type: "closed", reason: "Native owner closed" });
        const closed = yield* nextFeed(
          feeds,
          (feed) => !feed.connected && feed.error === "Native owner closed",
        );
        expect(closed.conversation.entries).toEqual([user]);
        yield* Deferred.await(stopped);
      }),
    ),
  );

  it.effect(
    "reconciles active inventory beside live frames and retains completion across reconnect",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<unknown>();
          let inventories = 0;
          const { events, feeds } = yield* harness((command) => {
            if (command.type === "set_subagent_subscription")
              return Effect.succeed({ level: "progress" });
            if (command.type === "get_subagents")
              return Effect.gen(function* () {
                inventories++;
                if (inventories > 1) return { subagents: [] };
                yield* Deferred.succeed(started, undefined);
                return yield* Deferred.await(release);
              });
            return Effect.succeed({});
          });
          const reconnect: NativeSessionUpdate = {
            type: "snapshot",
            session,
            journal: page([user]),
          };
          yield* Queue.offer(events, reconnect);
          yield* Deferred.await(started);
          const payload = { id: "worker", agent: "scout", index: 0, parentToolCallId: "task" };
          yield* Queue.offerAll(events, [
            event({ type: "subagent_lifecycle", payload: { ...payload, status: "started" } }),
            event({
              type: "subagent_progress",
              payload: { ...payload, progress: { id: "worker", status: "running", tokens: 90 } },
            }),
            event({
              type: "message_update",
              messageId: "live",
              message: { role: "assistant", content: "Visible while inventory is blocked" },
            }),
            event({ type: "subagent_lifecycle", payload: { ...payload, status: "completed" } }),
          ]);
          const completed = yield* nextFeed(
            feeds,
            (feed) => feed.agents[0]?.status === "completed",
          );
          expect(completed.conversation.pending[0]?.message.content).toBe(
            "Visible while inventory is blocked",
          );
          expect(completed.agents[0]?.usage?.totalTokens).toBe(90);
          yield* Deferred.succeed(release, {
            subagents: [
              { ...payload, status: "running" },
              { id: "discovered", agent: "task", index: 1, status: "running" },
            ],
          });
          const hydrated = yield* nextFeed(feeds, (feed) =>
            feed.agents.some((agent) => agent.id === "discovered"),
          );
          expect(hydrated.agents.map((agent) => [agent.id, agent.status])).toEqual([
            ["worker", "completed"],
            ["discovered", "running"],
          ]);
          yield* Queue.offer(events, { type: "disconnected" });
          const disconnected = yield* nextFeed(feeds, (feed) => !feed.connected);
          expect(disconnected.agents.map((agent) => agent.status)).toEqual([
            "completed",
            "interrupted",
          ]);
          yield* Queue.offer(events, reconnect);
          const refreshed = yield* nextFeed(
            feeds,
            (feed) => feed.connected && feed.agentsRevision > disconnected.agentsRevision + 1,
          );
          expect(refreshed.agents.map((agent) => [agent.id, agent.status])).toEqual([
            ["worker", "completed"],
            ["discovered", "interrupted"],
          ]);
          expect(refreshed.agents[0]?.usage?.totalTokens).toBe(90);
          expect(refreshed.conversation.pending).toEqual(completed.conversation.pending);
        }),
      ),
  );

  it.effect("loads the whole roster once NeoPi advertises its history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requested: string[] = [];
        const history = [
          {
            id: "0-Finished",
            kind: "sub",
            status: "parked",
            agent: "scout",
            description: "Map the protocol",
            createdAt: 1_000,
            lastActivity: 5_000,
            metrics: { tokens: 300, tools: 4 },
          },
          { id: "1-Killed", kind: "sub", status: "aborted", createdAt: 2_000, lastActivity: 3_000 },
        ];
        const { events, feeds } = yield* harness((command) => {
          requested.push(command.type);
          if (command.type === "get_subagent_history")
            return Effect.succeed({ subagents: history });
          if (command.type === "get_subagents") return Effect.succeed({ subagents: [] });
          return Effect.succeed({});
        });
        yield* Queue.offer(events, {
          type: "snapshot",
          session: { ...session, capabilities: ["subagent_history"] },
          journal: page([user]),
        });
        const loaded = yield* nextFeed(feeds, (feed) => feed.agents.length === 2);
        expect(loaded.agents.map((agent) => [agent.id, agent.status])).toEqual([
          ["0-Finished", "completed"],
          ["1-Killed", "cancelled"],
        ]);
        expect(loaded.agents[0]?.usage?.totalTokens).toBe(300);
        expect(requested).toContain("get_subagent_history");
      }),
    ),
  );

  it.effect("keeps the live inventory alone for a NeoPi without history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requested: string[] = [];
        const { events, feeds } = yield* harness((command) => {
          requested.push(command.type);
          if (command.type === "get_subagents")
            return Effect.succeed({
              subagents: [{ id: "live", agent: "task", index: 0, status: "running" }],
            });
          return Effect.succeed({});
        });
        yield* Queue.offer(events, { type: "snapshot", session, journal: page([user]) });
        yield* nextFeed(feeds, (feed) => feed.agents.length === 1);
        expect(requested).not.toContain("get_subagent_history");
      }),
    ),
  );

  it.effect("polls jobs for a terminal-attached session and settles on zero", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let reads = 0;
        const job = { id: "bg_1", type: "bash", label: "sleep 9", status: "running", startedAt: 1 };
        const { events, feeds } = yield* harness((command) => {
          if (command.type === "get_subagents") return Effect.succeed({ subagents: [] });
          if (command.type !== "get_jobs") return Effect.succeed({});
          reads++;
          return Effect.succeed(
            reads === 1
              ? { running: [job], recent: [], runningCount: 1 }
              : {
                  running: [],
                  recent: [{ ...job, status: "completed", finishedAt: 2 }],
                  runningCount: 0,
                },
          );
        });
        yield* Queue.offer(events, {
          type: "snapshot",
          session: { ...session, attachment: "terminal", capabilities: ["background_jobs"] },
          journal: page([user]),
        });
        yield* nextFeed(feeds, (feed) => feed.jobs.runningCount === 1);
        // No job_lifecycle frame reaches a terminal attachment: only the poll can learn it ended.
        yield* TestClock.adjust("5 seconds");
        const settled = yield* nextFeed(feeds, (feed) => feed.jobs.runningCount === 0);
        expect(settled.jobs.entries.map((entry) => entry.status)).toEqual(["completed"]);
      }),
    ),
  );
});
