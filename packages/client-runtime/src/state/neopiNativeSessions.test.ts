import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  NeoPiNativeSessionsError,
  ProviderInstanceId,
  WS_METHODS,
  type NeoPiNativeCursor,
  type NeoPiNativeEntity,
  type NeoPiNativeEssentialEnvelope,
  type NeoPiNativeInboxRecord,
  type NeoPiNativeObservationDomain,
  type NeoPiNativeSessionsCreditInput,
  type NeoPiNativeSessionsReadInput,
  type NeoPiNativeSessionsReadResult,
  type NeoPiNativeSessionsSetDemandInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  NATIVE_INBOX_LIMIT,
  emptyNativeSessionFeed,
  nativeObservationStatus,
  reduceNativeSessionFeed,
  type NativeSession,
  type NativeSessionFeed,
} from "../neopiNativeSessions.ts";
import { DEFAULT_NATIVE_DEMAND, createNativeSessionAtoms } from "./neopiNativeSessions.ts";

const ref = {
  providerInstanceId: ProviderInstanceId.make("neopi"),
  sessionFile: "/sessions/feed.jsonl",
};
const session: NativeSession = {
  ref,
  sessionId: "session",
  cwd: "/workspace",
  attachment: "owned",
  capabilities: [],
  state: {},
};
const domain = (
  overrides: Partial<NeoPiNativeObservationDomain> = {},
): NeoPiNativeObservationDomain => ({
  serverIncarnation: "server-1",
  ownerEpoch: 1,
  projectionIncarnation: 1,
  buildAttempt: 1,
  branchGeneration: 0,
  ...overrides,
});
const cursorAt = (epoch: NeoPiNativeObservationDomain, base: number): NeoPiNativeCursor => ({
  epoch,
  base,
  pass: null,
  inboxSeq: 0,
  journalAt: null,
});
/** A pass answered completely in one reply. */
const pass = (input: {
  readonly epoch: NeoPiNativeObservationDomain;
  readonly watermark: number;
  readonly kind?: "full" | "incremental";
  readonly entities?: readonly NeoPiNativeEntity[];
  readonly inbox?: readonly NeoPiNativeInboxRecord[];
}): NeoPiNativeSessionsReadResult => ({
  type: "pass",
  passId: `pass-${input.watermark}`,
  kind: input.kind ?? "full",
  baseCursor: cursorAt(input.epoch, 0),
  coveredThrough: input.watermark,
  continuation: cursorAt(input.epoch, input.watermark),
  complete: true,
  promoted: false,
  entities: input.entities ?? [],
  tombstones: [],
  segments: [],
  inbox: input.inbox ?? [],
  journal: null,
});
const live = (messageId: string, content: string, revision: number): NeoPiNativeEntity => ({
  key: `message:${messageId}`,
  ordinal: 1,
  revision,
  value: {
    class: "message",
    messageId,
    phase: "open",
    entryId: null,
    message: { role: "assistant", content },
  },
});

type Item =
  | { readonly type: "envelope"; readonly envelope: NeoPiNativeEssentialEnvelope }
  | { readonly type: "fail"; readonly error: NeoPiNativeSessionsError }
  | { readonly type: "end" };
interface FakeLease {
  readonly id: string;
  readonly items: Queue.Queue<Item>;
  readonly applied: SubscriptionRef.SubscriptionRef<number>;
  readonly released: Deferred.Deferred<void>;
  readonly push: (...envelopes: readonly NeoPiNativeEssentialEnvelope[]) => Effect.Effect<void>;
}
interface FakeRead {
  readonly input: NeoPiNativeSessionsReadInput;
  readonly reply: Deferred.Deferred<NeoPiNativeSessionsReadResult, NeoPiNativeSessionsError>;
  readonly interrupted: Deferred.Deferred<void>;
}

/**
 * A server per the observation contract: every envelope takes one credit and
 * the stream never runs more than `creditWindow` ahead of applied credit.
 */
const makeHarness = Effect.fn("NativeObservationTest.makeHarness")(function* (
  options: { readonly creditWindow?: number } = {},
) {
  const creditWindow = options.creditWindow ?? 4;
  const leases = yield* Queue.unbounded<FakeLease>();
  const reads = yield* Queue.unbounded<FakeRead>();
  const demands = yield* Queue.unbounded<NeoPiNativeSessionsSetDemandInput>();
  const byId = new Map<string, FakeLease>();
  let leaseCount = 0;
  let revision = 0;
  let opens = 0;
  let prompts = 0;
  const client = {
    [WS_METHODS.neopiNativeSessionsOpen]: () =>
      Effect.sync(() => {
        opens++;
        return session;
      }),
    [WS_METHODS.neopiNativeSessionsRequest]: (input: {
      readonly command: { readonly type: string };
    }) =>
      Effect.sync(() => {
        if (input.command.type === "prompt") prompts++;
        return {};
      }),
    [WS_METHODS.neopiNativeSessionsWatch]: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const id = `lease-${++leaseCount}`;
          const items = yield* Queue.unbounded<Item>();
          const applied = yield* SubscriptionRef.make(0);
          const released = yield* Deferred.make<void>();
          const lease: FakeLease = {
            id,
            items,
            applied,
            released,
            push: (...envelopes) =>
              Queue.offerAll(
                items,
                envelopes.map((envelope) => ({ type: "envelope" as const, envelope })),
              ).pipe(Effect.asVoid),
          };
          yield* Effect.acquireRelease(
            Effect.sync(() => byId.set(id, lease)),
            () =>
              Effect.sync(() => byId.delete(id)).pipe(
                Effect.andThen(Deferred.succeed(released, undefined)),
              ),
          );
          yield* lease.push(
            { type: "leased", leaseId: id, domain: domain(), creditWindow, readDeadlineMs: 1_000 },
            { type: "session", revision: ++revision, session },
            { type: "lifecycle", revision: ++revision, state: "observing" },
          );
          yield* Queue.offer(leases, lease);
          let sent = 0;
          return Stream.fromQueue(items).pipe(
            Stream.takeWhile((item) => item.type !== "end"),
            Stream.mapEffect((item) =>
              item.type === "fail"
                ? Effect.fail(item.error)
                : SubscriptionRef.changes(applied).pipe(
                    Stream.filter((count) => sent - count < creditWindow),
                    Stream.runHead,
                    Effect.as(item.envelope),
                    Effect.tap(() => Effect.sync(() => sent++)),
                  ),
            ),
          );
        }),
      ),
    [WS_METHODS.neopiNativeSessionsCredit]: (input: NeoPiNativeSessionsCreditInput) =>
      Effect.suspend(() => {
        const lease = byId.get(input.leaseId);
        return lease ? SubscriptionRef.set(lease.applied, input.applied) : Effect.void;
      }),
    [WS_METHODS.neopiNativeSessionsRead]: (input: NeoPiNativeSessionsReadInput) =>
      Effect.gen(function* () {
        const reply = yield* Deferred.make<
          NeoPiNativeSessionsReadResult,
          NeoPiNativeSessionsError
        >();
        const interrupted = yield* Deferred.make<void>();
        yield* Queue.offer(reads, { input, reply, interrupted });
        return yield* Deferred.await(reply).pipe(
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        );
      }),
    [WS_METHODS.neopiNativeSessionsSetDemand]: (input: NeoPiNativeSessionsSetDemandInput) =>
      Queue.offer(demands, input).pipe(Effect.as({ outcome: "applied" as const })),
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
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make()),
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
    connection,
    sessionRef,
    leases,
    reads,
    /** The next read of one lease; reads of released leases are skipped. */
    readOf: (leaseId: string) =>
      Stream.fromQueue(reads).pipe(
        Stream.filter((read) => read.input.leaseId === leaseId),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      ),
    demands,
    nextRevision: () => ++revision,
    counts: () => ({ opens, prompts, active: byId.size }),
  };
});

describe("native observation controller", () => {
  it.effect("does not create orphan feeds for commands without an observation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const result = yield* Effect.promise(() =>
          h.atoms.request.run(h.registry, {
            environmentId: h.target.environmentId,
            input: { ref, command: { type: "get_state" } },
          }),
        );
        expect(result._tag).toBe("Success");
        expect(h.atoms.cached(h.target)).toBeUndefined();
      }),
    ),
  );

  it.effect("stale cursor and demand release", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const unmount = h.registry.mount(h.watch);
        const lease = yield* Queue.take(h.leases);
        const firstDemand = yield* Queue.take(h.demands);
        expect(firstDemand).toEqual({
          leaseId: lease.id,
          generation: 1,
          demand: DEFAULT_NATIVE_DEMAND,
        });

        const first = yield* Queue.take(h.reads);
        expect(first.input).toMatchObject({ leaseId: lease.id, readId: 1, cursor: null });
        const epochA = domain();
        yield* Deferred.succeed(
          first.reply,
          pass({ epoch: epochA, watermark: 5, entities: [live("m1", "Before", 5)] }),
        );
        yield* h.observe((feed) => feed.conversation.pending[0]?.message.content === "Before");

        // A superseded read is re-read under a newer id with the same cursor.
        const second = yield* Queue.take(h.reads);
        expect(second.input).toMatchObject({ readId: 2, cursor: cursorAt(epochA, 5) });
        yield* Deferred.fail(
          second.reply,
          new NeoPiNativeSessionsError({ message: "stale", code: "stale_read" }),
        );
        const third = yield* Queue.take(h.reads);
        expect(third.input).toMatchObject({ readId: 3, cursor: cursorAt(epochA, 5) });

        // The held cursor went stale (a new build): the full pass rebases in place.
        const epochB = domain({ buildAttempt: 2 });
        yield* Deferred.succeed(
          third.reply,
          pass({ epoch: epochB, watermark: 2, entities: [live("m1", "After", 2)] }),
        );
        const rebased = yield* h.observe(
          (feed) => feed.conversation.pending[0]?.message.content === "After",
        );
        expect(rebased.conversation.pending).toHaveLength(1);
        const fourth = yield* Queue.take(h.reads);
        expect(fourth.input).toMatchObject({ readId: 4, cursor: cursorAt(epochB, 2) });

        const child = [{ kind: "child" as const, childId: "child", runToken: "run" }];
        h.atoms.setDemand(h.target, child);
        expect(yield* Queue.take(h.demands)).toEqual({
          leaseId: lease.id,
          generation: 2,
          demand: child,
        });

        // Concealing the last view releases the lease at once and cancels its read.
        unmount();
        yield* Deferred.await(lease.released);
        yield* Deferred.await(fourth.interrupted);
        expect(h.counts().active).toBe(0);
        expect(yield* Queue.size(h.reads)).toBe(0);
        expect(yield* Queue.size(h.demands)).toBe(0);
        // The warm cache holds the feed, without a lease.
        expect(h.atoms.cached(h.target)?.conversation.pending[0]?.message.content).toBe("After");
      }),
    ),
  );

  it.effect(
    "socket stays responsive (Pong, unrelated requests) while bulk application is held",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness({ creditWindow: 4 });
          const unmount = h.registry.mount(h.watch);
          const lease = yield* Queue.take(h.leases);
          // The bulk read is held for the whole test.
          const held = yield* Queue.take(h.reads);
          const count = 40;
          yield* lease.push(
            ...Array.from({ length: count }, (_, index) => ({
              type: "obligation-opened" as const,
              revision: h.nextRevision(),
              id: `approval-${index}`,
              request: { type: "tool_approval_request", id: `approval-${index}` },
            })),
          );
          // Ten times the credit window arrives only if credit returns per envelope.
          const feed = yield* h.observe((feed) => feed.dialogs.length === count);
          expect(feed.dialogs.at(-1)?.id).toBe(`approval-${count - 1}`);
          const reply = yield* Effect.promise(() =>
            h.atoms.request.run(h.registry, {
              environmentId: h.target.environmentId,
              input: { ref, command: { type: "prompt", message: "Still here" } },
            }),
          );
          expect(reply._tag).toBe("Success");
          expect(h.counts().prompts).toBe(1);
          expect(yield* Deferred.isDone(held.reply)).toBe(false);
          expect(yield* Queue.size(h.reads)).toBe(0);
          unmount();
        }),
      ),
  );

  it.effect("draft, attachments, terminals, layout and scroll survive every transition", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        // Views stay mounted only while the atom never leaves a successful value.
        const results: AsyncResult.AsyncResult<NativeSessionFeed, unknown>[] = [];
        const unmount = h.registry.subscribe(h.watch, (value) => results.push(value), {
          immediate: true,
        });
        const first = yield* Queue.take(h.leases);
        const read = yield* Queue.take(h.reads);
        const epoch = domain();
        yield* Deferred.succeed(
          read.reply,
          pass({ epoch, watermark: 3, entities: [live("m1", "Kept", 3)] }),
        );
        const kept = (feed: NativeSessionFeed) =>
          feed.conversation.pending[0]?.message.content === "Kept";
        yield* h.observe((feed) => kept(feed) && feed.connected);

        // A lost watch re-attaches to the same owner and resumes from the held cursor.
        yield* Queue.offer(first.items, {
          type: "fail",
          error: new NeoPiNativeSessionsError({ message: "socket closed" }),
        });
        const lost = yield* h.observe((feed) => feed.observer.phase === "transport-lost");
        expect(kept(lost)).toBe(true);
        const second = yield* Queue.take(h.leases);
        const resumed = yield* h.readOf(second.id);
        expect(resumed.input).toMatchObject({ leaseId: second.id, cursor: cursorAt(epoch, 3) });
        yield* h.observe((feed) => feed.connected && feed.observer.phase === "observing");

        // A dropped socket session and its replacement.
        yield* SubscriptionRef.set(h.sessionRef, Option.none());
        yield* h.observe((feed) => !feed.connected);
        yield* SubscriptionRef.set(h.sessionRef, Option.some(h.connection));
        const third = yield* Queue.take(h.leases);
        const pending = yield* h.readOf(third.id);

        // A projection rebuild: the full pass rebases in place.
        yield* Deferred.succeed(
          pending.reply,
          pass({
            epoch: domain({ projectionIncarnation: 2 }),
            watermark: 1,
            entities: [live("m1", "Kept", 1)],
          }),
        );
        const rebased = yield* h.observe(
          (feed) => feed.observation.domain?.projectionIncarnation === 2,
        );
        expect(kept(rebased)).toBe(true);

        // The owner's successor.
        yield* third.push({ type: "lifecycle", revision: h.nextRevision(), state: "reconnecting" });
        yield* h.observe((feed) => feed.ownerLoss === "reconnecting");
        yield* third.push(
          { type: "session", revision: h.nextRevision(), session },
          { type: "lifecycle", revision: h.nextRevision(), state: "observing" },
        );
        const successor = yield* h.observe((feed) => feed.connected && feed.ownerLoss === null);
        expect(kept(successor)).toBe(true);

        // The owner stops: cached state stays and nothing reopens it automatically.
        yield* third.push({
          type: "lifecycle",
          revision: h.nextRevision(),
          state: "owner-stopped",
          reason: "The terminal quit.",
        });
        yield* Queue.offer(third.items, { type: "end" });
        const stopped = yield* h.observe((feed) => feed.ownerLoss === "orphaned");
        expect(stopped.connected).toBe(false);
        expect(kept(stopped)).toBe(true);
        yield* Deferred.await(third.released);
        expect(h.counts()).toMatchObject({ opens: 0, active: 0 });

        const firstSuccess = results.findIndex(AsyncResult.isSuccess);
        expect(firstSuccess).toBeGreaterThanOrEqual(0);
        expect(results.slice(firstSuccess).every((result) => AsyncResult.isSuccess(result))).toBe(
          true,
        );
        unmount();
      }),
    ),
  );
});

describe("native inbox bound", () => {
  it("keeps a tool that streams forever within the inbox bound and marks what it cut", () => {
    const epoch = domain();
    let feed = reduceNativeSessionFeed(emptyNativeSessionFeed(), {
      type: "session",
      revision: 1,
      session,
    });
    const total = NATIVE_INBOX_LIMIT * 4;
    for (let seq = 1; seq <= total; seq++)
      feed = reduceNativeSessionFeed(feed, {
        type: "read",
        sent: feed.observation.cursor,
        result: pass({
          epoch,
          watermark: seq,
          kind: seq === 1 ? "full" : "incremental",
          inbox: [
            {
              type: "tool_stream_update",
              seq,
              toolCallId: "bash-1",
              toolName: "bash",
              update: { chunk: seq },
            },
          ],
        }),
      });
    const inbox = feed.observation.inbox;
    expect(inbox.length).toBeLessThanOrEqual(NATIVE_INBOX_LIMIT);
    const gap = inbox[0];
    expect(gap?.type).toBe("gap");
    if (gap?.type !== "gap") return;
    const kept = inbox.slice(1);
    expect(gap).toMatchObject({ reason: "evicted", fromSeq: 1, toSeq: kept[0]!.seq - 1 });
    expect(gap.toolStreams).toEqual([
      { toolCallId: "bash-1", toolName: "bash", updates: total - kept.length },
    ]);
    expect(kept.every((record, index) => record.seq === gap.toSeq + 1 + index)).toBe(true);
    expect(kept.at(-1)?.seq).toBe(total);
  });
});

describe("native projection mapping", () => {
  const child = (revision: number, status: string): NeoPiNativeEntity => ({
    key: "roster:child",
    ordinal: 1,
    revision,
    value: {
      class: "roster",
      value: {
        id: "child",
        runToken: "run",
        inventory: { id: "child", status, runToken: "run" },
        ticks: revision,
      },
    },
  });
  const output: NeoPiNativeEntity = {
    key: "receipt:command:1",
    ordinal: 2,
    revision: 2,
    value: {
      class: "receipt",
      value: { kind: "command_output", text: "Printed", afterEntryId: null, afterMessageId: null },
    },
  };
  const read = (feed: NativeSessionFeed, result: NeoPiNativeSessionsReadResult) =>
    reduceNativeSessionFeed(feed, { type: "read", sent: feed.observation.cursor, result });

  it("keeps children and command output through a rebuild and drops a removed child", () => {
    let feed = reduceNativeSessionFeed(emptyNativeSessionFeed(), {
      type: "session",
      revision: 1,
      session,
    });
    feed = read(
      feed,
      pass({ epoch: domain(), watermark: 2, entities: [child(1, "running"), output] }),
    );
    expect(feed.agents.map((agent) => [agent.id, agent.status])).toEqual([["child", "running"]]);
    expect(feed.agentTicks).toEqual({ child: 1 });
    expect(feed.commandOutputs.map((item) => item.text)).toEqual(["Printed"]);

    // A rebuilt projection holds the child again but not the live-only receipt.
    const rebuilt = domain({ projectionIncarnation: 2 });
    feed = read(feed, pass({ epoch: rebuilt, watermark: 3, entities: [child(3, "running")] }));
    expect(feed.agents[0]?.status).toBe("running");
    expect(feed.agents[0]?.native.disconnected).toBe(false);
    expect(feed.agentTicks).toEqual({ child: 3 });
    expect(feed.commandOutputs.map((item) => item.text)).toEqual(["Printed"]);

    // A full pass that no longer holds the child removes it, never marks it interrupted.
    feed = read(feed, pass({ epoch: rebuilt, watermark: 4 }));
    expect(feed.agents).toEqual([]);
  });
});

describe("native observation status", () => {
  it("is catching up while attaching, building or in a full pass, and not after it", () => {
    const epoch = domain();
    let feed = reduceNativeSessionFeed(emptyNativeSessionFeed(), {
      type: "session",
      revision: 1,
      session,
    });
    expect(nativeObservationStatus(feed)).toEqual({ phase: "attaching", catchingUp: true });
    feed = reduceNativeSessionFeed(feed, { type: "lifecycle", revision: 2, state: "building" });
    expect(nativeObservationStatus(feed).catchingUp).toBe(true);
    feed = reduceNativeSessionFeed(feed, { type: "lifecycle", revision: 3, state: "observing" });
    expect(nativeObservationStatus(feed)).toEqual({ phase: "rebasing", catchingUp: true });
    feed = reduceNativeSessionFeed(feed, {
      type: "read",
      sent: null,
      result: pass({ epoch, watermark: 3 }),
    });
    expect(nativeObservationStatus(feed)).toEqual({ phase: "observing", catchingUp: false });
  });
});
