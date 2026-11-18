/**
 * The server reader and the client reducer, together: real projections read by
 * the real cursor reader, and its actual replies applied by the real client
 * reducer (`read-issued` / `read`), for two independent viewers at once. After
 * every step each viewer's transcript, agents and gaps are checked against what
 * the user must see, and both sides against their bounds.
 */
import { ProviderInstanceId, type NeoPiNativeObservationDomain } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  emptyNativeSessionFeed,
  nativeTranscriptRows,
  reduceNativeSessionFeed,
  type NativeSession,
  type NativeSessionFeed,
  type NativeSessionUpdate,
} from "../../../../../packages/client-runtime/src/neopiNativeSessions.ts";
import { readNeoPiNativeObservation, type NeoPiNativeReadLimits } from "./NeoPiNativeCursor.ts";
import { NeoPiNativeProjection } from "./NeoPiNativeProjection.ts";

const sessionId = "native-id";
const sessionFile = "/sessions/conversation.jsonl";
const session: NativeSession = {
  ref: { providerInstanceId: ProviderInstanceId.make("neopi"), sessionFile },
  sessionId,
  cwd: "/workspace",
  attachment: "owned",
  capabilities: [],
  state: { isStreaming: false },
};
const domain: NeoPiNativeObservationDomain = {
  serverIncarnation: "server-1",
  ownerEpoch: 1,
  projectionIncarnation: 0,
  buildAttempt: 0,
  branchGeneration: 0,
};
const WIDE: NeoPiNativeReadLimits = { scanSteps: 1_000, replyBytes: 1_000_000 };
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const entry = (id: string, parentId: string | null, message?: Record<string, unknown>) => ({
  id,
  parentId,
  type: "message",
  timestamp: "2026-11-18T00:00:00Z",
  ...(message ? { message } : { message: assistant(id) }),
});

const buildPage = (projection: NeoPiNativeProjection, entries: unknown[]) => {
  projection.beginBuildAttempt();
  const mark = projection.mark();
  projection.applyStateReply({ sessionId }, mark);
  projection.applySubagentsReply({ subagents: [] }, mark);
  projection.applySubagentHistoryReply(null, mark);
  projection.applyJournalPage({ sessionId, entries }, mark);
};

const owner = (options: { journal?: number; tombstones?: number; inbox?: number } = {}) => {
  const projection = new NeoPiNativeProjection({
    domain,
    tombstoneCapacity: options.tombstones ?? 1_000,
    journalCapacity: options.journal ?? 512,
    inboxLimits: { records: options.inbox ?? 512, bytes: 1_000_000 },
    now: () => 1_000,
  });
  projection.fold({
    type: "journal_state",
    reason: "identity",
    sessionId,
    sessionFile,
    leafId: null,
  });
  buildPage(projection, []);
  let parent: string | null = null;
  const append = (id: string, message?: Record<string, unknown>) => {
    projection.fold({
      type: "journal_entry",
      sessionId,
      sessionFile,
      entry: entry(id, parent, message),
    });
    parent = id;
  };
  return { projection, append, setParent: (id: string | null) => (parent = id) };
};

class Viewer {
  feed: NativeSessionFeed = { ...emptyNativeSessionFeed(), session, connected: true };
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  /** Issues one read and applies the reader's actual reply. */
  read(projection: NeoPiNativeProjection, limits: NeoPiNativeReadLimits = WIDE) {
    this.feed = reduceNativeSessionFeed(this.feed, { type: "read-issued" });
    const outstanding = this.feed.observation.outstanding!;
    const result = readNeoPiNativeObservation(projection, outstanding.cursor, limits, this.name);
    this.feed = reduceNativeSessionFeed(this.feed, {
      type: "read",
      readId: outstanding.readId,
      result,
    });
    return result;
  }

  drain(projection: NeoPiNativeProjection, limits: NeoPiNativeReadLimits = WIDE) {
    for (let reads = 0; reads < 200; reads++)
      if (this.read(projection, limits).type === "unchanged") return;
    assert.fail(`${this.name} never caught up`);
  }

  /** What the user sees in the transcript, in order. */
  rows(): string[] {
    return nativeTranscriptRows(this.feed, true).map((row) => row.id);
  }

  agents(): string[] {
    return [...this.feed.observation.entities.entries()]
      .filter(([, entity]) => entity.value.class === "roster")
      .map(([key]) => key)
      .sort();
  }
}

/** Invariants that hold after every step, caught up or not. */
const visible = (viewer: Viewer, projection: NeoPiNativeProjection) => {
  const rows = viewer.rows();
  assert.equal(new Set(rows).size, rows.length, `${viewer.name}: a row shown twice`);
  const loaded = new Set(viewer.feed.conversation.entries.map((item) => item.id));
  for (const row of viewer.feed.conversation.pending) {
    const entryId = viewer.feed.conversation.persisted.get(row.messageId);
    assert.isFalse(
      entryId !== undefined && loaded.has(entryId),
      `${viewer.name}: ${row.messageId} shown beside its entry`,
    );
  }
  assert.isAtMost(viewer.feed.observation.segments.size, 1, `${viewer.name}: segment buffers`);
  assert.isAtMost(projection.store.tombstoneEntries, 4_000, "server tombstone queue");
};

/** When caught up, each viewer shows exactly what the projection holds. */
const converged = (viewer: Viewer, projection: NeoPiNativeProjection) => {
  visible(viewer, projection);
  const tail: string[] = [];
  for (
    let position = projection.journal.start;
    position < projection.deliverableJournalEnd;
    position++
  )
    tail.push(projection.journal.at(position)!.id);
  const entries = viewer.feed.conversation.entries.map((item) => item.id);
  assert.deepEqual(
    entries.slice(entries.length - tail.length),
    tail,
    `${viewer.name}: history tail`,
  );
  const live = [...projection.store.values()]
    .flatMap((record) => (record.value?.class === "message" ? [record.value.messageId] : []))
    .sort();
  assert.deepEqual(
    viewer.feed.conversation.pending.map((row) => row.messageId).sort(),
    live,
    `${viewer.name}: live rows`,
  );
  const roster = [...projection.store.values()]
    .filter((record) => record.value?.class === "roster")
    .map((record) => record.key)
    .sort();
  assert.deepEqual(viewer.agents(), roster, `${viewer.name}: agents`);
};

describe("server reader and client reducer, paired", () => {
  it("a hot oversized key, two viewers interleaved, both finish and agree", () => {
    const { projection } = owner();
    const big = (n: number) => ({
      class: "presentation" as const,
      value: { text: `${n}:`.padEnd(3_000, "x") },
    });
    projection.store.put("presentation:big", big(0));
    projection.fold({
      type: "subagent_lifecycle",
      payload: {
        id: "c1",
        runToken: "r1",
        status: "started",
        agent: "task",
        agentSource: "bundled",
        index: 0,
      },
    });
    const a = new Viewer("A");
    const b = new Viewer("B");
    const limits = { scanSteps: 100, replyBytes: 600 };
    for (let n = 1; n <= 40; n++) {
      projection.store.put("presentation:big", big(n));
      a.read(projection, limits);
      projection.store.put("presentation:big", big(n + 1000));
      b.read(projection, limits);
      visible(a, projection);
      visible(b, projection);
    }
    a.drain(projection, limits);
    b.drain(projection, limits);
    converged(a, projection);
    converged(b, projection);
    assert.deepEqual(
      a.feed.observation.entities.get("presentation:big")?.value,
      b.feed.observation.entities.get("presentation:big")?.value,
    );
  });

  it("a join that lands on a reply cut never shows both copies or loses the row", () => {
    const { projection, append } = owner();
    const a = new Viewer("A");
    const b = new Viewer("B");
    for (let n = 0; n < 15; n++)
      projection.store.put(`presentation:p${n}`, { class: "presentation", value: { n } });
    projection.fold({ type: "message_end", messageId: "m", message: assistant("answer") });
    a.drain(projection);
    b.drain(projection);
    for (let n = 0; n < 15; n++)
      projection.store.put(`presentation:p${n}`, { class: "presentation", value: { n: n + 1 } });
    append("e-m", assistant("answer"));
    const small = { scanSteps: 100, replyBytes: 500 };
    a.read(projection, small);
    visible(a, projection);
    projection.fold({
      type: "message_persisted",
      sessionId,
      sessionFile,
      messageId: "m",
      entryId: "e-m",
    });
    for (let n = 0; n < 4; n++) append(`f${n}`, { role: "custom", content: "y".repeat(150) });
    for (let step = 0; step < 30; step++) {
      a.read(projection, small);
      b.read(projection, small);
      visible(a, projection);
      visible(b, projection);
      for (const viewer of [a, b]) {
        const rows = viewer.rows();
        assert.isTrue(
          rows.includes("entry:live:m") || rows.includes("entry:e-m"),
          `${viewer.name}: the answer is never missing`,
        );
      }
    }
    a.drain(projection);
    b.drain(projection);
    converged(a, projection);
    converged(b, projection);
  });

  it("a NeoPi flush with reads in between stays one branch and never rebuilds (verifier's stall)", () => {
    const { projection, append, setParent } = owner();
    append("u");
    const a = new Viewer("A");
    const b = new Viewer("B");
    a.drain(projection);
    b.drain(projection);
    const generation = projection.domain.branchGeneration;
    // Three turns, each: streamed messages, then one flush in NeoPi's order.
    let parent = "u";
    for (let turn = 0; turn < 3; turn++) {
      const ids = [`t${turn}-a`, `t${turn}-b`, `t${turn}-c`];
      for (const id of ids) {
        for (let n = 0; n < 5; n++) {
          projection.fold({
            type: "message_update",
            messageId: id,
            message: assistant(`${id} ${n}`),
          });
          a.read(projection);
        }
        projection.fold({ type: "message_end", messageId: id, message: assistant(id) });
      }
      projection.fold({
        type: "journal_state",
        reason: "leaf",
        sessionId,
        sessionFile,
        leafId: ids[2],
      });
      for (const id of ids) {
        projection.fold({
          type: "journal_entry",
          sessionId,
          sessionFile,
          entry: entry(id, parent, assistant(id)),
        });
        a.read(projection);
        b.read(projection);
        visible(a, projection);
        visible(b, projection);
        projection.fold({
          type: "message_persisted",
          sessionId,
          sessionFile,
          messageId: id,
          entryId: id,
        });
        parent = id;
      }
      setParent(parent);
    }
    assert.equal(
      projection.domain.branchGeneration,
      generation,
      "no navigation in a linear session",
    );
    assert.isTrue(projection.published);
    for (const viewer of [a, b]) {
      assert.equal(viewer.feed.observation.domain?.branchGeneration, generation);
      viewer.drain(projection);
      converged(viewer, projection);
      assert.deepEqual(viewer.feed.conversation.pending, [], `${viewer.name}: no live row left`);
    }
  });

  it("a rebuild after the session moved to a sibling branch shows the new branch", () => {
    const { projection, append } = owner();
    append("A");
    append("B");
    const a = new Viewer("A");
    const b = new Viewer("B");
    a.drain(projection);
    b.drain(projection);
    projection.rebuild();
    projection.beginBuildAttempt();
    const mark = projection.mark();
    projection.fold({
      type: "journal_state",
      reason: "snapshot",
      sessionId,
      sessionFile,
      leafId: "C",
      messageEntryIds: [],
    });
    projection.applyStateReply({ sessionId }, mark);
    projection.applySubagentsReply({ subagents: [] }, mark);
    projection.applySubagentHistoryReply(null, mark);
    projection.applyJournalPage({ sessionId, entries: [entry("A", null), entry("C", "A")] }, mark);
    a.drain(projection);
    converged(a, projection);
    assert.deepEqual(
      a.feed.conversation.entries.map((item) => item.id),
      ["A", "C"],
    );
    b.read(projection);
    visible(b, projection);
    b.drain(projection);
    converged(b, projection);
  });

  it("a reconnect or close between a read and its reply never applies the stale reply", () => {
    const { projection, append } = owner();
    append("A");
    const losses: readonly NativeSessionUpdate[] = [
      { type: "disconnected" },
      { type: "lifecycle", state: "detached", reason: "bye" },
    ];
    for (const loss of losses) {
      const viewer = new Viewer(loss.type);
      viewer.drain(projection);
      append(`after-${loss.type}`);
      viewer.feed = reduceNativeSessionFeed(viewer.feed, { type: "read-issued" });
      const outstanding = viewer.feed.observation.outstanding!;
      const result = readNeoPiNativeObservation(projection, outstanding.cursor, WIDE, viewer.name);
      viewer.feed = reduceNativeSessionFeed(viewer.feed, loss);
      const before = viewer.feed;
      viewer.feed = reduceNativeSessionFeed(viewer.feed, {
        type: "read",
        readId: outstanding.readId,
        result,
      });
      assert.strictEqual(
        viewer.feed.observation,
        before.observation,
        "the stale reply changed nothing",
      );
      visible(viewer, projection);
    }
  });

  it("a deletion at exactly a promoted pass's watermark is removed for both viewers", () => {
    const { projection } = owner({ tombstones: 0 });
    for (const key of ["a", "b"])
      projection.store.put(`presentation:${key}`, { class: "presentation", value: { key } });
    const a = new Viewer("A");
    const b = new Viewer("B");
    a.drain(projection);
    b.drain(projection);
    projection.store.put("presentation:b", { class: "presentation", value: { key: "b2" } });
    const tiny = { scanSteps: 1, replyBytes: 100_000 };
    a.read(projection, tiny);
    // Deleted with the revision the promotion will capture as its watermark.
    projection.store.remove("presentation:b");
    const promoted = a.read(projection, tiny);
    assert.equal(
      promoted.type === "pass" ? promoted.coveredThrough : -1,
      projection.store.revision,
    );
    a.drain(projection);
    b.drain(projection);
    converged(a, projection);
    converged(b, projection);
    assert.isFalse(a.feed.observation.entities.has("presentation:b"));
  });

  it("an inbox gap that is later extended, then a detach and a re-attach", () => {
    const { projection } = owner({ inbox: 4 });
    const notice = (n: number) =>
      projection.fold({ type: "notice", level: "info", message: `n${n}` });
    const viewers = {
      early: new Viewer("early"),
      shorter: new Viewer("shorter"),
      behind: new Viewer("behind"),
    };
    for (const viewer of Object.values(viewers)) viewer.drain(projection);
    /** Every sequence number is shown once: as a record, or inside a gap with the given reason. */
    const covers = (viewer: Viewer, through: number, reasons: Record<number, string>) => {
      const seen = new Map<number, string>();
      for (const record of viewer.feed.observation.inbox)
        if (record.type === "gap" || record.type === "trimmed")
          for (let seq = record.fromSeq; seq <= record.toSeq; seq++) {
            if (!seen.has(seq)) seen.set(seq, record.type === "gap" ? record.reason : "trimmed");
          }
        else if (record.type === "older-details-trimmed") continue;
        else {
          assert.notEqual(
            seen.get(record.seq),
            "record",
            `${viewer.name}: record ${record.seq} twice`,
          );
          seen.set(record.seq, "record");
        }
      for (let seq = 1; seq <= through; seq++)
        assert.equal(
          seen.get(seq) ?? "missing",
          reasons[seq] ?? "record",
          `${viewer.name}: seq ${seq}`,
        );
      assert.isAtMost(
        viewer.feed.observation.inbox.length,
        16,
        `${viewer.name}: client inbox bound`,
      );
    };
    for (let n = 1; n <= 5; n++) notice(n);
    viewers.shorter.drain(projection); // gap 1–2, records 3–5
    notice(6);
    viewers.early.drain(projection); // gap 1–3, records 4–6
    for (let n = 7; n <= 9; n++) notice(n); // the server's gap grows to 1–6
    for (const viewer of Object.values(viewers)) viewer.drain(projection);
    covers(viewers.early, 9, { 1: "evicted", 2: "evicted", 3: "evicted" });
    covers(viewers.shorter, 9, { 1: "evicted", 2: "evicted", 6: "evicted" });
    covers(viewers.behind, 9, {
      1: "evicted",
      2: "evicted",
      3: "evicted",
      4: "evicted",
      5: "evicted",
      6: "evicted",
    });
    // The last watcher detaches; two records arrive unobserved; one re-attaches.
    projection.setInboxObserved(false);
    notice(10);
    projection.fold({ type: "tool_stream_update", toolCallId: "t", toolName: "ext", update: 1 });
    projection.setInboxObserved(true);
    const late = new Viewer("late");
    late.drain(projection);
    viewers.early.drain(projection);
    covers(viewers.early, 11, {
      1: "evicted",
      2: "evicted",
      3: "evicted",
      10: "not-observed",
      11: "not-observed",
    });
    const unobserved = Object.fromEntries([7, 8, 9, 10, 11].map((seq) => [seq, "not-observed"]));
    covers(late, 11, {
      1: "evicted",
      2: "evicted",
      3: "evicted",
      4: "evicted",
      5: "evicted",
      6: "evicted",
      ...unobserved,
    });
    for (const viewer of [viewers.early, late]) visible(viewer, projection);
  });
});
