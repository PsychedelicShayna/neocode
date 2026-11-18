import type { NeoPiNativeObservationDomain } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { readNeoPiNativeObservation } from "./NeoPiNativeCursor.ts";
import {
  NeoPiNativeProjection,
  type NeoPiNativeProjectionEnvelope,
} from "./NeoPiNativeProjection.ts";

const domain: NeoPiNativeObservationDomain = {
  serverIncarnation: "server-1",
  ownerEpoch: 1,
  projectionIncarnation: 0,
  buildAttempt: 0,
  branchGeneration: 0,
};
const sessionId = "session-1";
const WIDE = { scanSteps: 10_000, replyBytes: 1_000_000 };

const published = (capacity = { tombstones: 1000, journal: 512 }) => {
  const projection = new NeoPiNativeProjection({
    domain,
    tombstoneCapacity: capacity.tombstones,
    journalCapacity: capacity.journal,
  });
  projection.fold({
    type: "journal_state",
    reason: "identity",
    sessionId,
    sessionFile: "/s.jsonl",
    leafId: null,
  });
  projection.applyStateReply({ sessionId }, projection.mark());
  projection.applySubagentsReply({ subagents: [] }, projection.mark());
  projection.applySubagentHistoryReply(null, projection.mark());
  projection.applyJournalPage({ sessionId, entries: [] }, projection.mark());
  return projection;
};

const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const entry = (id: string, parentId: string | null, message?: Record<string, unknown>) => ({
  id,
  parentId,
  type: "message",
  timestamp: "2026-11-18T00:00:00Z",
  ...(message ? { message } : {}),
});

/** The message value a full read serves for `messageId`, if any. */
const servedMessage = (projection: NeoPiNativeProjection, messageId: string) => {
  const reply = readNeoPiNativeObservation(projection, null, WIDE, "reader");
  assert.equal(reply.type, "pass");
  if (reply.type !== "pass") return undefined;
  const entity = reply.entities.find(
    (candidate) => candidate.value.class === "message" && candidate.value.messageId === messageId,
  );
  return entity?.value.class === "message" ? entity.value : undefined;
};

const bodyText = (message: Record<string, unknown> | undefined) =>
  JSON.stringify((message?.content as unknown[] | undefined) ?? null);

describe("NeoPiNativeProjection", () => {
  it("S3 after message_end no read serves an open or shorter body until the durable entry joins", () => {
    const projection = published();
    const messageId = "live-1";
    projection.fold({ type: "message_start", messageId, message: assistant("") });
    projection.fold({ type: "message_update", messageId, message: assistant("Hello") });
    projection.fold({ type: "message_end", messageId, message: assistant("Hello world") });
    const final = bodyText(assistant("Hello world"));
    // Late or replayed frames for the same id after the end.
    projection.fold({ type: "message_update", messageId, message: assistant("Hel") });
    projection.fold({
      type: "message_start",
      messageId,
      snapshot: true,
      message: assistant("Hello"),
    });
    let served = servedMessage(projection, messageId);
    assert.deepEqual([served?.phase, bodyText(served?.message)], ["ended", final]);
    projection.fold({ type: "message_persisted", sessionId, messageId, entryId: "entry-1" });
    served = servedMessage(projection, messageId);
    assert.deepEqual(
      [served?.phase, served?.entryId, bodyText(served?.message)],
      ["durable", "entry-1", final],
    );
    projection.fold({
      type: "journal_entry",
      sessionId,
      entry: entry("entry-1", null, assistant("Hello world")),
    });
    assert.isUndefined(servedMessage(projection, messageId));
    assert.equal(projection.store.get(`message:${messageId}`)?.joinEntryId, "entry-1");
  });

  it("S8 out-of-order state and page replies cannot regress newer state", () => {
    const projection = published();
    const early = projection.mark();
    projection.fold({ type: "chat_mode_changed", mode: "plan", include: "" });
    const late = projection.mark();
    assert.isTrue(
      projection.applyStateReply({ sessionId, chatMode: "plan", thinkingLevel: "high" }, late),
    );
    // The older reply arrives last: it is refused, so neither the event nor
    // the newer reply regresses.
    assert.isFalse(
      projection.applyStateReply({ sessionId, chatMode: "code", thinkingLevel: "low" }, early),
    );
    const setting = (property: string) => {
      const value = projection.store.get(`setting:${property}`)?.value;
      return value?.class === "setting" ? value.value.value : undefined;
    };
    assert.deepEqual([setting("chatMode"), setting("thinkingLevel")], ["plan", "high"]);
    assert.isFalse(
      projection.applyStateReply({ sessionId: "other", chatMode: "code" }, projection.mark()),
    );

    // A page requested before appends arrived keeps the appends after it.
    const pageMark = projection.mark();
    projection.fold({ type: "journal_entry", sessionId, entry: entry("e3", "e2") });
    projection.fold({ type: "journal_entry", sessionId, entry: entry("e4", "e3") });
    assert.isTrue(
      projection.applyJournalPage(
        { sessionId, entries: [entry("e1", null), entry("e2", "e1")] },
        pageMark,
      ),
    );
    const ids = () => {
      const out: string[] = [];
      for (let position = projection.journal.start; position < projection.journal.end; position++)
        out.push(projection.journal.at(position)!.id);
      return out;
    };
    assert.deepEqual(ids(), ["e1", "e2", "e3", "e4"]);
    // A page from before a navigation, or from an earlier incarnation, is refused.
    const beforeNavigation = projection.mark();
    projection.fold({
      type: "journal_state",
      reason: "leaf",
      sessionId,
      sessionFile: "/s.jsonl",
      leafId: "e2",
    });
    assert.isFalse(
      projection.applyJournalPage({ sessionId, entries: [entry("e9", null)] }, beforeNavigation),
    );
    const beforeRebuild = projection.mark();
    projection.rebuild();
    assert.isFalse(projection.applyStateReply({ sessionId, chatMode: "code" }, beforeRebuild));
    assert.equal(setting("chatMode"), "plan");
  });

  it("S12 more than 256 lost associations with identical text never join by text", () => {
    const projection = published({ tombstones: 1000, journal: 1000 });
    const ids = Array.from({ length: 300 }, (_, index) => `live-${index}`);
    for (const messageId of ids)
      projection.fold({ type: "message_end", messageId, message: assistant("same") });
    // The snapshot carries only the newest 256 associations.
    projection.fold({
      type: "journal_state",
      reason: "snapshot",
      sessionId,
      sessionFile: "/s.jsonl",
      leafId: null,
      messageEntryIds: ids
        .slice(44)
        .map((messageId) => ({ messageId, entryId: `entry-${messageId}` })),
    });
    let parent: string | null = null;
    for (const messageId of ids) {
      projection.fold({
        type: "journal_entry",
        sessionId,
        entry: entry(`entry-${messageId}`, parent, assistant("same")),
      });
      parent = `entry-${messageId}`;
    }
    for (const messageId of ids.slice(0, 44)) {
      const value = projection.store.get(`message:${messageId}`)?.value;
      assert.deepEqual(
        value?.class === "message" ? [value.phase, value.entryId] : undefined,
        ["ended", null],
        `${messageId} kept with its body, unjoined`,
      );
    }
    for (const messageId of ids.slice(44)) {
      const record = projection.store.get(`message:${messageId}`);
      assert.deepEqual([record?.value, record?.joinEntryId], [null, `entry-${messageId}`]);
    }
  });

  it("S15 an ended message survives connection loss and rebuild, then joins once; persistence failure is a fault", () => {
    const projection = published();
    const messageId = "live-1";
    projection.fold({ type: "message_end", messageId, message: assistant("final answer") });
    projection.fold({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: {},
    });
    // Observation connection lost: a new incarnation builds while the message is not durable yet.
    projection.rebuild();
    assert.isFalse(projection.published);
    const mark = projection.mark();
    projection.fold({
      type: "journal_state",
      reason: "snapshot",
      sessionId,
      sessionFile: "/s.jsonl",
      leafId: null,
      messageEntryIds: [],
    });
    projection.fold({
      type: "message_start",
      messageId,
      snapshot: true,
      message: assistant("final"),
    });
    projection.applyStateReply({ sessionId }, mark);
    projection.applySubagentsReply({ subagents: [] }, mark);
    projection.applySubagentHistoryReply(null, mark);
    projection.applyJournalPage({ sessionId, entries: [] }, mark);
    assert.isTrue(projection.published);
    let served = servedMessage(projection, messageId);
    assert.deepEqual(
      [served?.phase, bodyText(served?.message)],
      ["ended", bodyText(assistant("final answer"))],
    );
    const tool = projection.store.get("tool:tool-1")?.value;
    assert.equal(tool?.class === "tool" ? tool.coverage : undefined, "unknown");

    projection.fold({
      type: "notice",
      level: "error",
      message: "Session persistence failed: disk full.",
      source: "session-persistence",
    });
    const fault = projection.store.get("fault:session-persistence")?.value;
    assert.equal(
      fault?.class === "fault" ? fault.value.message : undefined,
      "Session persistence failed: disk full.",
    );
    served = servedMessage(projection, messageId);
    assert.equal(bodyText(served?.message), bodyText(assistant("final answer")));

    // Commit lands: the entry joins once, by its own id.
    projection.fold({ type: "message_persisted", sessionId, messageId, entryId: "entry-1" });
    projection.fold({
      type: "journal_entry",
      sessionId,
      entry: entry("entry-1", null, assistant("final answer")),
    });
    projection.fold({
      type: "journal_entry",
      sessionId,
      entry: entry("entry-1", null, assistant("final answer")),
    });
    const record = projection.store.get(`message:${messageId}`);
    assert.deepEqual([record?.value, record?.joinEntryId], [null, "entry-1"]);
    assert.equal(projection.journal.end - projection.journal.start, 1);
  });

  describe("§3.7 live-only details", () => {
    it("an edit call written while the view is behind serves the latest preview, then the final result", () => {
      const projection = published();
      const toolCallId = "edit-1";
      const preview = (
        generation: number,
        streaming: boolean,
        extra: Record<string, unknown> = {},
      ) => ({
        type: "tool_stream_update",
        toolCallId,
        toolName: "edit",
        update: {
          generation,
          streaming,
          files: [{ path: "a.ts", diff: "+".repeat(generation), ...extra }],
        },
      });
      for (let generation = 0; generation < 500; generation++)
        projection.fold(preview(generation, true));
      projection.fold(preview(500, false, { error: "anchor not found" }));
      projection.fold(preview(499, true));
      projection.fold(preview(501, true));
      const reply = readNeoPiNativeObservation(projection, null, WIDE, "reader");
      assert.equal(reply.type, "pass");
      if (reply.type !== "pass") return;
      const previews = reply.entities.filter((entity) => entity.value.class === "editPreview");
      assert.equal(previews.length, 1, "one preview per call");
      assert.deepEqual(previews[0]?.value, {
        class: "editPreview",
        toolCallId,
        generation: 500,
        streaming: false,
        files: [{ path: "a.ts", diff: "+".repeat(500), error: "anchor not found" }],
      });
      assert.deepEqual(reply.inbox, [], "skipped tentative diffs raise nothing");

      projection.fold({ type: "tool_execution_start", toolCallId, toolName: "edit", args: {} });
      projection.fold({
        type: "tool_execution_end",
        toolCallId,
        toolName: "edit",
        result: { ok: true },
      });
      const tool = projection.store.get(`tool:${toolCallId}`)?.value;
      assert.deepEqual(
        tool?.class === "tool" ? [tool.state.status, tool.state.result] : undefined,
        ["ended", { ok: true }],
      );
      projection.fold({
        type: "journal_entry",
        sessionId,
        entry: entry("result-1", null, { role: "toolResult", toolCallId, content: [] }),
      });
      assert.isNull(projection.store.get(`tool:${toolCallId}`)?.value);
      assert.isNull(projection.store.get(`editPreview:${toolCallId}`)?.value);
    });

    it("a stream with no reducer keeps every update in order, interrupted or not", () => {
      for (const interrupted of [false, true]) {
        const projection = published();
        const update = (value: unknown) => ({
          type: "tool_stream_update",
          toolCallId: "ext-1",
          toolName: "extension_tool",
          update: value,
        });
        projection.fold(update({ diagnostic: "schema drift in field x" }));
        projection.fold(update({ partial: 1 }));
        if (!interrupted) projection.fold(update({ final: "done" }));
        const reply = readNeoPiNativeObservation(projection, null, WIDE, "reader");
        assert.equal(reply.type, "pass");
        if (reply.type !== "pass") return;
        assert.deepEqual(
          reply.inbox.map((record) =>
            record.type === "tool_stream_update" ? record.update : undefined,
          ),
          interrupted
            ? [{ diagnostic: "schema drift in field x" }, { partial: 1 }]
            : [{ diagnostic: "schema drift in field x" }, { partial: 1 }, { final: "done" }],
        );
        assert.isUndefined(projection.store.get("editPreview:ext-1"));
      }
    });
  });

  it("obligations open and settle as essential envelopes in the shared revision order", () => {
    const envelopes: NeoPiNativeProjectionEnvelope[] = [];
    const projection = new NeoPiNativeProjection({
      domain,
      tombstoneCapacity: 10,
      journalCapacity: 10,
      onEssential: (envelope) => envelopes.push(envelope),
    });
    projection.fold({ type: "extension_ui_request", id: "ask-1", method: "ask", questions: [] });
    projection.fold({ type: "tool_approval_request", id: "approve-1" });
    projection.fold({ type: "extension_ui_request", id: "c", method: "cancel", targetId: "ask-1" });
    projection.settleObligation("approve-1", "answered");
    projection.settleObligation("approve-1", "answered");
    assert.deepEqual(
      envelopes.map((envelope) => [
        envelope.type,
        envelope.type === "identity" ? null : envelope.id,
      ]),
      [
        ["obligation-opened", "ask-1"],
        ["obligation-opened", "approve-1"],
        ["obligation-settled", "ask-1"],
        ["obligation-settled", "approve-1"],
      ],
    );
    const revisions = envelopes.map((envelope) => envelope.revision);
    assert.deepEqual(
      revisions,
      [...revisions].sort((left, right) => left - right),
    );
    assert.equal(projection.obligations.size, 0);
  });

  it("an append never restarts; a move to an earlier entry is a navigation", () => {
    const projection = published();
    const fences = [
      projection.fold({
        type: "journal_state",
        reason: "leaf",
        sessionId,
        sessionFile: "/s.jsonl",
        leafId: "e1",
      }),
      projection.fold({ type: "journal_entry", sessionId, entry: entry("e1", null) }),
      projection.fold({
        type: "journal_state",
        reason: "leaf",
        sessionId,
        sessionFile: "/s.jsonl",
        leafId: "e2",
      }),
      projection.fold({ type: "journal_entry", sessionId, entry: entry("e2", "e1") }),
    ];
    assert.deepEqual(fences, ["none", "none", "none", "none"]);
    assert.equal(projection.domain.branchGeneration, 0);
    assert.equal(
      projection.fold({
        type: "journal_state",
        reason: "leaf",
        sessionId,
        sessionFile: "/s.jsonl",
        leafId: "e1",
      }),
      "navigated",
    );
    assert.equal(projection.domain.branchGeneration, 1);
    assert.equal(
      projection.fold({ type: "journal_entry", sessionId, entry: entry("e3", "e1") }),
      "none",
    );
    assert.equal(
      projection.fold({ type: "journal_entry", sessionId, entry: entry("e4", "e2") }),
      "navigated",
    );
  });

  describe("B2 review", () => {
    const tailIds = (projection: NeoPiNativeProjection) => {
      const ids: string[] = [];
      for (let position = projection.journal.start; position < projection.journal.end; position++)
        ids.push(projection.journal.at(position)!.id);
      return ids;
    };

    it("4 a delayed build page cannot roll the head back after the ring turned over", () => {
      const projection = published({ tombstones: 10, journal: 2 });
      const mark = projection.mark();
      projection.fold({ type: "journal_entry", sessionId, entry: entry("e2", "e1") });
      projection.fold({ type: "journal_entry", sessionId, entry: entry("e3", "e2") });
      projection.fold({ type: "journal_entry", sessionId, entry: entry("e4", "e3") });
      assert.deepEqual(tailIds(projection), ["e3", "e4"]);
      assert.isTrue(
        projection.applyJournalPage(
          { sessionId, entries: [entry("e0", null), entry("e1", "e0")] },
          mark,
        ),
      );
      assert.deepEqual(tailIds(projection), ["e3", "e4"]);
      assert.equal(projection.journal.head?.id, "e4");
    });

    it("5 a move to an evicted leaf, or to no leaf, is a navigation", () => {
      const projection = published({ tombstones: 10, journal: 2 });
      for (const [id, parent] of [
        ["e1", null],
        ["e2", "e1"],
        ["e3", "e2"],
      ] as const) {
        projection.fold({
          type: "journal_state",
          reason: "leaf",
          sessionId,
          sessionFile: "/s.jsonl",
          leafId: id,
        });
        assert.equal(
          projection.fold({ type: "journal_entry", sessionId, entry: entry(id, parent) }),
          "none",
        );
      }
      assert.equal(
        projection.domain.branchGeneration,
        0,
        "appends announced by leaf never navigate",
      );
      const generation = projection.domain.branchGeneration;
      assert.equal(
        projection.fold({
          type: "journal_state",
          reason: "leaf",
          sessionId,
          sessionFile: "/s.jsonl",
          leafId: "e1",
        }),
        "none",
      );
      // Other frames, such as a flush's message_persisted, never settle it.
      assert.equal(projection.fold({ type: "agent_start" }), "none");
      assert.isTrue(projection.pendingLeaf);
      // The owner side's timeout settles a quiet move.
      assert.equal(projection.settlePendingLeaf(), "navigated");
      assert.equal(projection.domain.branchGeneration, generation + 1);
      assert.deepEqual(tailIds(projection), []);
      assert.equal(projection.identity?.leafId, "e1");
      projection.fold({ type: "journal_entry", sessionId, entry: entry("e5", "e1") });
      projection.fold({
        type: "journal_state",
        reason: "leaf",
        sessionId,
        sessionFile: "/s.jsonl",
        leafId: "gone",
      });
      assert.equal(projection.settlePendingLeaf(), "navigated");
      assert.equal(
        projection.fold({
          type: "journal_state",
          reason: "leaf",
          sessionId,
          sessionFile: "/s.jsonl",
          leafId: null,
        }),
        "navigated",
      );
      assert.deepEqual(tailIds(projection), []);
    });

    it("6 an earlier build attempt's replies never publish a later attempt", () => {
      const projection = new NeoPiNativeProjection({
        domain,
        tombstoneCapacity: 10,
        journalCapacity: 10,
      });
      projection.fold({
        type: "journal_state",
        reason: "identity",
        sessionId,
        sessionFile: "/s.jsonl",
        leafId: null,
      });
      projection.beginBuildAttempt();
      const first = projection.mark();
      projection.beginBuildAttempt();
      assert.isFalse(projection.applyStateReply({ sessionId }, first));
      assert.isFalse(projection.applyJournalPage({ sessionId, entries: [] }, first));
      assert.isFalse(projection.published);
      const second = projection.mark();
      projection.applyStateReply({ sessionId }, second);
      projection.applySubagentsReply({ subagents: [] }, second);
      projection.applySubagentHistoryReply(null, second);
      assert.isFalse(projection.published);
      projection.applyJournalPage({ sessionId, entries: [] }, second);
      assert.isTrue(projection.published);
    });
  });

  describe("decision 8 inbox bound", () => {
    let clock = 0;
    const bounded = (records: number, bytes: number) => {
      const projection = new NeoPiNativeProjection({
        domain,
        tombstoneCapacity: 100,
        journalCapacity: 100,
        inboxLimits: { records, bytes },
        now: () => ++clock,
      });
      projection.fold({
        type: "journal_state",
        reason: "identity",
        sessionId,
        sessionFile: "/s.jsonl",
        leafId: null,
      });
      projection.applyStateReply({ sessionId }, projection.mark());
      projection.applySubagentsReply({ subagents: [] }, projection.mark());
      projection.applySubagentHistoryReply(null, projection.mark());
      projection.applyJournalPage({ sessionId, entries: [] }, projection.mark());
      return projection;
    };
    const stream = (toolCallId: string, n: number) => ({
      type: "tool_stream_update",
      toolCallId,
      toolName: "ext",
      update: { n },
    });
    const gaps = (reply: ReturnType<typeof readNeoPiNativeObservation>) =>
      reply.type === "pass" ? reply.inbox.filter((record) => record.type === "gap") : [];

    it("holds under a tool that streams forever, and evicts nothing but inbox records", () => {
      const projection = bounded(8, 2_000);
      projection.fold({ type: "message_end", messageId: "m", message: assistant("kept") });
      projection.fold({ type: "journal_entry", sessionId, entry: entry("e1", null) });
      projection.fold({ type: "extension_ui_request", id: "ask-1", method: "ask", questions: [] });
      for (let n = 0; n < 20_000; n++) {
        projection.fold(stream("forever", n));
        assert.isAtMost(projection.inbox.length, 8);
        assert.isAtMost(projection.inboxBytes, 2_000);
      }
      assert.equal(projection.store.get("message:m")?.value?.class, "message");
      assert.equal(projection.journal.head?.id, "e1");
      assert.isTrue(projection.obligations.has("ask-1"));
      assert.equal(projection.inbox.filter((record) => record.type === "gap").length, 1);
    });

    it("a reader behind the eviction receives one merged gap, once, with kinds, interval and time span", () => {
      const projection = bounded(4, 100_000);
      const reader = readNeoPiNativeObservation(projection, null, WIDE, "reader");
      assert.equal(reader.type, "pass");
      if (reader.type !== "pass") return;
      const start = clock;
      projection.fold({ type: "notice", level: "info", message: "retrying" });
      projection.fold(stream("call-a", 1));
      projection.fold(stream("call-a", 2));
      projection.fold(stream("call-b", 1));
      // Two evictions before the reader reads: adjacent, so one gap.
      projection.fold(stream("call-c", 1));
      projection.fold(stream("call-c", 2));
      const behind = readNeoPiNativeObservation(projection, reader.continuation, WIDE, "reader");
      assert.deepEqual(gaps(behind), [
        {
          type: "gap",
          seq: 3,
          reason: "evicted",
          fromSeq: 1,
          toSeq: 3,
          firstReceivedAt: start + 1,
          lastReceivedAt: start + 3,
          notices: 1,
          toolStreams: [{ toolCallId: "call-a", toolName: "ext", updates: 2 }],
          toolStreamsTruncated: false,
        },
      ]);
      assert.equal(behind.type === "pass" ? behind.inbox.length : 0, 4);
      const again = readNeoPiNativeObservation(
        projection,
        behind.type === "pass" ? behind.continuation : null,
        WIDE,
        "reader",
      );
      assert.deepEqual(gaps(again), [], "the gap is delivered once");
    });

    it("records dropped while unobserved reach the next viewer as one not-observed gap covering exactly them", () => {
      const projection = bounded(64, 100_000);
      projection.fold(stream("seen", 1));
      const first = readNeoPiNativeObservation(projection, null, WIDE, "reader");
      assert.equal(first.type, "pass");
      if (first.type !== "pass") return;
      // The last watcher detaches; B5 drives this hook.
      projection.setInboxObserved(false);
      projection.pruneInbox(first.continuation.inboxSeq);
      projection.fold(stream("call-x", 1));
      projection.fold({ type: "notice", level: "warning", message: "stopped auto-recovery" });
      projection.setInboxObserved(true);
      projection.fold(stream("after", 1));
      const attached = readNeoPiNativeObservation(projection, null, WIDE, "reader");
      assert.equal(attached.type, "pass");
      if (attached.type !== "pass") return;
      assert.deepEqual(
        attached.inbox.map((record) =>
          record.type === "gap"
            ? [
                record.reason,
                record.fromSeq,
                record.toSeq,
                record.notices,
                record.toolStreams.map((s) => s.toolCallId),
              ]
            : [record.type, record.seq],
        ),
        [
          ["not-observed", 2, 3, 1, ["call-x"]],
          ["tool_stream_update", 4],
        ],
      );
    });
  });

  describe("parity with today's feed", () => {
    const value = (projection: NeoPiNativeProjection, key: string) => {
      const held = projection.store.get(key)?.value;
      return held && "value" in held ? held.value : undefined;
    };

    it("the first build publishes only with the roster, complete from inventory and history", () => {
      const projection = new NeoPiNativeProjection({
        domain,
        tombstoneCapacity: 100,
        journalCapacity: 100,
      });
      projection.fold({
        type: "journal_state",
        reason: "identity",
        sessionId,
        sessionFile: "/s.jsonl",
        leafId: null,
      });
      const mark = projection.mark();
      // A child that starts during the build is newer than the inventory read.
      projection.fold({
        type: "subagent_lifecycle",
        payload: {
          id: "late",
          runToken: "r9",
          status: "started",
          agent: "task",
          agentSource: "bundled",
          index: 3,
        },
      });
      projection.applyStateReply({ sessionId }, mark);
      projection.applyJournalPage({ sessionId, entries: [] }, mark);
      assert.isFalse(projection.published, "no Agents view without the inventory");
      projection.applySubagentHistoryReply(
        {
          subagents: [
            { id: "done", status: "parked" },
            { id: "running", status: "running" },
          ],
        },
        mark,
      );
      projection.applySubagentsReply(
        {
          subagents: [
            { id: "running", status: "running", index: 1 },
            { id: "late", status: "running" },
          ],
        },
        mark,
      );
      assert.isTrue(projection.published);
      assert.deepEqual(value(projection, "roster:done"), {
        id: "done",
        ticks: 0,
        history: { id: "done", status: "parked" },
        // Not in the live inventory: finished, not interrupted.
        inventory: null,
      });
      assert.deepEqual(value(projection, "roster:running"), {
        id: "running",
        ticks: 0,
        history: { id: "running", status: "running" },
        inventory: { id: "running", status: "running", index: 1 },
      });
      const late = value(projection, "roster:late");
      assert.equal(late?.runToken, "r9");
      assert.isUndefined(
        late?.inventory,
        "the older inventory row does not overwrite the newer frame",
      );
      projection.fold({
        type: "subagent_event",
        payload: { id: "running", event: { type: "message_end" } },
      });
      projection.fold({
        type: "subagent_event",
        payload: { id: "running", event: { type: "message_update" } },
      });
      assert.equal(value(projection, "roster:running")?.ticks, 1);
    });

    it("folds jobs from frames and the inventory, keeping the newer of the two", () => {
      const projection = published();
      const mark = projection.mark();
      projection.fold({
        type: "job_lifecycle",
        event: "registered",
        job: { id: "j1", status: "running" },
        runningCount: 1,
      });
      projection.fold({
        type: "job_lifecycle",
        event: "updated",
        job: { id: "j1", status: "completed" },
        runningCount: 0,
      });
      projection.fold({
        type: "job_lifecycle",
        event: "updated",
        job: { id: "j1", status: "running" },
        runningCount: 1,
      });
      assert.deepEqual(value(projection, "job:j1"), { job: { id: "j1", status: "completed" } });
      projection.applyJobsReply(
        {
          running: [
            { id: "j1", status: "running" },
            { id: "j2", status: "running" },
          ],
          recent: [],
          runningCount: 2,
        },
        mark,
      );
      assert.deepEqual(value(projection, "job:j1"), { job: { id: "j1", status: "completed" } });
      assert.deepEqual(value(projection, "job:j2"), { job: { id: "j2", status: "running" } });
      // The stale running frame was refused, and so was its count.
      assert.deepEqual(value(projection, "presentation:jobs"), { runningCount: 0 });
      projection.applyJobsReply({ running: [], recent: [], runningCount: 0 }, projection.mark());
      assert.isNull(projection.store.get("job:j2")?.value, "aged out of both lists");
    });

    it("keeps the whole get_state record, and live frames in its field shapes", () => {
      const projection = published();
      projection.applyStateReply(
        {
          sessionId,
          contextUsage: { percent: 12 },
          sessionUsage: { cost: 1.5 },
          sessionName: "fix it",
          fastModeEnabled: true,
          isCompacting: false,
          systemPrompt: ["very long"],
          dumpTools: [],
        },
        projection.mark(),
      );
      assert.deepEqual(value(projection, "setting:state"), {
        property: "state",
        value: {
          sessionId,
          contextUsage: { percent: 12 },
          sessionUsage: { cost: 1.5 },
          sessionName: "fix it",
          fastModeEnabled: true,
          isCompacting: false,
        },
      });
      projection.fold({
        type: "thinking_level_changed",
        thinkingLevel: "high",
        configured: "auto",
      });
      projection.fold({ type: "queue_update", steering: ["a"], followUp: [], liveSteered: 0 });
      assert.deepEqual(value(projection, "setting:thinkingLevel"), {
        property: "thinkingLevel",
        value: "high",
      });
      assert.deepEqual(value(projection, "setting:queue"), {
        property: "queue",
        value: { steering: ["a"], followUp: [], liveSteered: 0 },
      });
    });

    it("folds command output, dictation, editor text, notify and prompt results as the feed shows them", () => {
      const projection = published();
      projection.fold({ type: "journal_entry", sessionId, entry: entry("e1", null) });
      projection.fold({ type: "message_start", messageId: "m1", message: assistant("x") });
      projection.fold({ type: "command_output", text: "first" });
      projection.fold({ type: "command_output", text: "" });
      projection.fold({ type: "command_output", text: "second" });
      assert.deepEqual(value(projection, "receipt:command:0"), {
        kind: "command_output",
        text: "first",
        afterEntryId: "e1",
        afterMessageId: "m1",
      });
      assert.equal(value(projection, "receipt:command:1")?.text, "second");
      projection.fold({ type: "dictation_state", captureId: "c1", state: "recording" });
      projection.fold({ type: "dictation_transcript", captureId: "c1", text: "hello" });
      projection.fold({ type: "dictation_transcript", captureId: "old", text: "straggler" });
      projection.fold({ type: "dictation_end", captureId: "c1", text: "hello world" });
      projection.fold({ type: "dictation_transcript", captureId: "c1", text: "late" });
      assert.deepEqual(value(projection, "presentation:dictation"), {
        captureId: "c1",
        phase: "ended",
        text: "hello world",
        error: null,
      });
      projection.fold({
        type: "extension_ui_request",
        id: "u1",
        method: "set_editor_text",
        text: "draft",
      });
      projection.fold({
        type: "extension_ui_request",
        id: "u2",
        method: "notify",
        message: "saved",
      });
      assert.deepEqual(value(projection, "presentation:editorText"), { id: "u1", text: "draft" });
      assert.equal(value(projection, "presentation:notify")?.message, "saved");
      projection.fold({ type: "prompt_result", status: "error", error: { message: "no model" } });
      assert.deepEqual(value(projection, "presentation:promptResult"), {
        status: "error",
        error: "no model",
      });
      projection.fold({ type: "prompt_result", status: "ok" });
      assert.deepEqual(value(projection, "presentation:promptResult"), {
        status: "ok",
        error: null,
      });
    });
  });

  describe("final review", () => {
    const tail = (projection: NeoPiNativeProjection) => {
      const ids: string[] = [];
      for (let position = projection.journal.start; position < projection.journal.end; position++)
        ids.push(projection.journal.at(position)!.id);
      return ids;
    };
    const rebuildWith = (
      projection: NeoPiNativeProjection,
      leafId: string | null,
      entries: unknown[],
    ) => {
      projection.rebuild();
      projection.beginBuildAttempt();
      const mark = projection.mark();
      projection.fold({
        type: "journal_state",
        reason: "snapshot",
        sessionId,
        sessionFile: "/s.jsonl",
        leafId,
        messageEntryIds: [],
      });
      projection.applyStateReply({ sessionId }, mark);
      projection.applySubagentsReply({ subagents: [] }, mark);
      projection.applySubagentHistoryReply(null, mark);
      projection.applyJournalPage({ sessionId, entries }, mark);
    };

    it("2 tool joins never expire a message's retained join", () => {
      const projection = published();
      projection.fold({ type: "message_end", messageId: "m", message: assistant("answer") });
      projection.fold({ type: "message_persisted", sessionId, messageId: "m", entryId: "e-m" });
      projection.fold({
        type: "journal_entry",
        sessionId,
        entry: entry("e-m", null, assistant("answer")),
      });
      let parent = "e-m";
      for (let n = 0; n < 300; n++) {
        const toolCallId = `edit-${n}`;
        projection.fold({ type: "tool_execution_start", toolCallId, toolName: "edit", args: {} });
        projection.fold({
          type: "tool_stream_update",
          toolCallId,
          toolName: "edit",
          update: { generation: 0, streaming: false, files: [{ path: "a.ts" }] },
        });
        const id = `r-${n}`;
        projection.fold({
          type: "journal_entry",
          sessionId,
          entry: entry(id, parent, { role: "toolResult", toolCallId, content: [] }),
        });
        parent = id;
      }
      const record = projection.store.get("message:m");
      assert.deepEqual([record?.value, record?.removed, record?.joinEntryId], [null, false, "e-m"]);
    });

    it("3 after an observation gap a build page never shows a live row beside its entry", () => {
      const projection = published();
      projection.fold({ type: "message_end", messageId: "m", message: assistant("answer") });
      // Observation lost; m was persisted meanwhile and its association is no
      // longer among the snapshot's 256.
      rebuildWith(projection, "e-m", [entry("e-m", null, assistant("answer"))]);
      assert.isTrue(projection.published);
      const reply = readNeoPiNativeObservation(projection, null, WIDE, "reader");
      assert.equal(reply.type, "pass");
      if (reply.type !== "pass") return;
      const entries = (reply.journal?.entries ?? []).map((item) => item.id);
      const live = reply.entities.filter((entity) => entity.value.class === "message");
      assert.isFalse(entries.includes("e-m") && live.length > 0, "both copies");
      assert.include(
        entries,
        "e-m",
        "history is not held back for an association that cannot come",
      );
      assert.deepEqual(live, []);
    });

    it("4 a rebuild after a move to a sibling follows parent identity", () => {
      const projection = published();
      projection.fold({ type: "journal_entry", sessionId, entry: entry("A", null) });
      projection.fold({ type: "journal_entry", sessionId, entry: entry("B", "A") });
      rebuildWith(projection, "C", [entry("A", null), entry("C", "A")]);
      assert.deepEqual(tail(projection), ["A", "C"]);
      assert.equal(projection.journal.head?.id, "C");
    });

    it("an append batch announced by one leaf is not a navigation", () => {
      const projection = published();
      projection.fold({ type: "journal_entry", sessionId, entry: entry("h", null) });
      const generation = projection.domain.branchGeneration;
      const fences = [
        projection.fold({
          type: "journal_state",
          reason: "leaf",
          sessionId,
          sessionFile: "/s.jsonl",
          leafId: "b2",
        }),
        projection.fold({ type: "journal_entry", sessionId, entry: entry("b1", "h") }),
        projection.fold({ type: "journal_entry", sessionId, entry: entry("b2", "b1") }),
        projection.fold({ type: "agent_end" }),
      ];
      assert.deepEqual(fences, ["none", "none", "none", "none"]);
      assert.equal(projection.domain.branchGeneration, generation);
      assert.deepEqual(tail(projection), ["h", "b1", "b2"]);
    });

    it("a NeoPi flush (leaf = last, each entry followed by its message_persisted) is never a navigation", () => {
      // The frame order of the verifier's stalled run (branchGeneration 1 → 10
      // in a linear session): NeoPi's `committed()` announces the manager's
      // current leaf, the LAST appended entry, then emits each committed entry,
      // each followed at once by its `message_persisted`, with streaming frames
      // and reads in between.
      const projection = published();
      const fences: string[] = [];
      projection.fold({ type: "journal_entry", sessionId, entry: entry("h", null) });
      const generation = projection.domain.branchGeneration;
      const fold = (frame: Record<string, unknown>) => fences.push(projection.fold(frame));
      for (const id of ["e1", "e2", "last"])
        fold({ type: "message_end", messageId: `m-${id}`, message: assistant(id) });
      fold({
        type: "journal_state",
        reason: "leaf",
        sessionId,
        sessionFile: "/s.jsonl",
        leafId: "last",
      });
      let parent = "h";
      for (const id of ["e1", "e2", "last"]) {
        fold({ type: "journal_entry", sessionId, entry: entry(id, parent, assistant(id)) });
        // A read lands inside the flush; it changes nothing.
        const before = projection.domain;
        readNeoPiNativeObservation(projection, null, WIDE, "reader");
        assert.deepEqual(projection.domain, before);
        fold({ type: "message_persisted", sessionId, messageId: `m-${id}`, entryId: id });
        fold({ type: "message_update", messageId: "m-next", message: assistant("…") });
        parent = id;
      }
      assert.isTrue(
        fences.every((fence) => fence === "none"),
        fences.join(","),
      );
      assert.isFalse(projection.pendingLeaf);
      assert.equal(projection.domain.branchGeneration, generation);
      assert.isTrue(projection.published);
      assert.deepEqual(tail(projection), ["h", "e1", "e2", "last"]);
    });

    it("the real npi frame order of a full run, read after every frame, never navigates", () => {
      // Captured from the installed npi (rpc, built-in MockModel) by the
      // verifier: every journal_state, journal_entry and message_persisted in
      // order, with the other frame types between them; message_update frames
      // (thousands) are left out. A leaf is announced long before its entry,
      // twice in a row, and each entry is followed by its message_persisted.
      const trace: ReadonlyArray<readonly (string | null)[]> = [
        ["agent_start"],
        ["turn_start"],
        ["message_start"],
        ["message_end"],
        ["leaf", "ddef4f16"],
        ["message_start"],
        ["message_end"],
        ["leaf", "c4cdc37d"],
        ["leaf", "acf6afb2"],
        ["entry", "bca429dc", null, "model_change", null],
        ["entry", "43aba11c", "bca429dc", "thinking_level_change", null],
        ["entry", "ddef4f16", "43aba11c", "message", "user"],
        ["persisted", "1", "ddef4f16"],
        ["entry", "c4cdc37d", "ddef4f16", "custom", null],
        ["entry", "acf6afb2", "c4cdc37d", "message", "assistant"],
        ["persisted", "2", "acf6afb2"],
        ["leaf", "0bedafd5"],
        ["entry", "0bedafd5", "acf6afb2", "custom", null],
        ["message_start"],
        ["message_end"],
        ["leaf", "2f3f99e6"],
        ["entry", "2f3f99e6", "0bedafd5", "message", "toolResult"],
        ["persisted", "3", "2f3f99e6"],
        ["turn_end"],
        ["turn_start"],
        ["message_start"],
        ["message_end"],
        ["leaf", "5567c050"],
        ["entry", "5567c050", "2f3f99e6", "message", "assistant"],
        ["persisted", "4", "5567c050"],
        ["leaf", "c05a7e6a"],
        ["entry", "c05a7e6a", "5567c050", "custom", null],
        ["message_start"],
        ["message_end"],
        ["leaf", "5a37f5a9"],
        ["entry", "5a37f5a9", "c05a7e6a", "message", "toolResult"],
        ["persisted", "5", "5a37f5a9"],
        ["turn_end"],
        ["turn_start"],
        ["message_start"],
        ["message_end"],
        ["leaf", "2b3013bb"],
        ["entry", "2b3013bb", "5a37f5a9", "message", "assistant"],
        ["persisted", "6", "2b3013bb"],
        ["leaf", "a47ab5b1"],
        ["entry", "a47ab5b1", "2b3013bb", "custom", null],
        ["message_start"],
        ["message_end"],
        ["leaf", "3c0bda21"],
        ["entry", "3c0bda21", "a47ab5b1", "message", "toolResult"],
        ["persisted", "7", "3c0bda21"],
        ["turn_end"],
        ["turn_start"],
        ["message_start"],
        ["message_end"],
        ["leaf", "9abd1e76"],
        ["entry", "9abd1e76", "3c0bda21", "message", "assistant"],
        ["persisted", "8", "9abd1e76"],
        ["turn_end"],
        ["agent_end"],
      ];
      const projection = published();
      const generation = projection.domain.branchGeneration;
      const fences: string[] = [];
      let message = 0;
      for (const [type, a, b, entryType, role] of trace) {
        if (type === "leaf")
          fences.push(
            projection.fold({
              type: "journal_state",
              reason: "leaf",
              sessionId,
              sessionFile: "/s.jsonl",
              leafId: a ?? null,
            }),
          );
        else if (type === "entry")
          fences.push(
            projection.fold({
              type: "journal_entry",
              sessionId,
              entry: {
                id: a,
                parentId: b,
                type: entryType,
                timestamp: "t",
                ...(role ? { message: { role, content: [] } } : {}),
              },
            }),
          );
        else if (type === "persisted")
          fences.push(
            projection.fold({
              type: "message_persisted",
              sessionId,
              messageId: `m${a}`,
              entryId: b,
            }),
          );
        else if (type === "message_start" || type === "message_end") {
          if (type === "message_start") message++;
          fences.push(
            projection.fold({
              type: type!,
              messageId: `m${message}`,
              message: assistant(`m${message}`),
            }),
          );
        } else fences.push(projection.fold({ type: type! }));
        const before = projection.domain;
        readNeoPiNativeObservation(projection, null, WIDE, "reader");
        assert.deepEqual(projection.domain, before, "a read changes nothing");
      }
      assert.isTrue(
        fences.every((fence) => fence === "none"),
        fences.join(","),
      );
      assert.equal(projection.domain.branchGeneration, generation);
      assert.isTrue(projection.published);
      assert.equal(tail(projection).length, 14);
      assert.equal(projection.journal.head?.id, "9abd1e76");
      assert.deepEqual(
        [...projection.store.values()].filter((record) => record.value?.class === "message"),
        [],
        "every live message joined its entry",
      );
    });

    it("entries folded after a page's request survive that page when it is empty", () => {
      // B4's case: the build's page is read from an empty branch, then a flush
      // arrives before the page is applied.
      const projection = new NeoPiNativeProjection({
        domain,
        tombstoneCapacity: 100,
        journalCapacity: 100,
      });
      projection.fold({
        type: "journal_state",
        reason: "identity",
        sessionId,
        sessionFile: "/s.jsonl",
        leafId: null,
      });
      projection.beginBuildAttempt();
      const mark = projection.mark();
      projection.fold({
        type: "journal_state",
        reason: "leaf",
        sessionId,
        sessionFile: "/s.jsonl",
        leafId: "last",
      });
      projection.fold({ type: "journal_entry", sessionId, entry: entry("first", null) });
      projection.fold({ type: "journal_entry", sessionId, entry: entry("last", "first") });
      projection.applyStateReply({ sessionId }, mark);
      projection.applySubagentsReply({ subagents: [] }, mark);
      projection.applySubagentHistoryReply(null, mark);
      projection.applyJournalPage({ sessionId, entries: [] }, mark);
      assert.isTrue(projection.published);
      assert.deepEqual(tail(projection), ["first", "last"]);
    });

    describe("a leaf still pending after the owner's timeout is decided by the fetched page", () => {
      const pending = () => {
        const projection = published();
        projection.fold({ type: "journal_entry", sessionId, entry: entry("A", null) });
        projection.fold({ type: "journal_entry", sessionId, entry: entry("B", "A") });
        projection.fold({
          type: "journal_state",
          reason: "leaf",
          sessionId,
          sessionFile: "/s.jsonl",
          leafId: "D",
        });
        assert.equal(projection.pendingLeafId, "D");
        return projection;
      };

      it("append: the page extends the held head; live entries join by id", () => {
        const projection = pending();
        const generation = projection.domain.branchGeneration;
        const mark = projection.mark();
        // An entry arrives live while the page is in flight.
        projection.fold({ type: "journal_entry", sessionId, entry: entry("C", "B") });
        const page = {
          sessionId,
          entries: [entry("A", null), entry("B", "A"), entry("C", "B"), entry("D", "C")],
        };
        assert.equal(projection.reconcilePendingLeaf("D", page, mark), "append");
        assert.deepEqual(tail(projection), ["A", "B", "C", "D"]);
        assert.equal(projection.domain.branchGeneration, generation);
        assert.isNull(projection.pendingLeafId);
      });

      it("navigated: the page does not hold the head; history is rebased once", () => {
        const projection = pending();
        const generation = projection.domain.branchGeneration;
        const mark = projection.mark();
        const page = { sessionId, entries: [entry("A", null), entry("D", "A")] };
        assert.equal(projection.reconcilePendingLeaf("D", page, mark), "navigated");
        assert.deepEqual(tail(projection), ["A", "D"]);
        assert.equal(projection.domain.branchGeneration, generation + 1);
        assert.isTrue(projection.published);
      });

      it("append by ancestry: an entry folded live after the page's mark is kept", () => {
        const projection = pending(); // tail A, B; leaf D pending
        const generation = projection.domain.branchGeneration;
        const mark = projection.mark();
        // X extends the head while the page (ending at B) is in flight.
        projection.fold({ type: "journal_entry", sessionId, entry: entry("X", "B") });
        const page = {
          sessionId,
          leafId: "D",
          entries: [entry("A", null), entry("B", "A"), entry("D", "B")],
        };
        assert.equal(
          projection.reconcilePendingLeaf(
            "D",
            { ...page, leafId: "B", entries: page.entries.slice(0, 2) },
            mark,
          ),
          "stale",
        );
        const ending = { sessionId, entries: [entry("A", null), entry("B", "A")] };
        assert.equal(projection.reconcilePendingLeaf("D", ending, mark), "append");
        assert.deepEqual(tail(projection), ["A", "B", "X"]);
        assert.equal(projection.domain.branchGeneration, generation);
        assert.isNull(projection.pendingLeafId);
      });

      it("stale: another leaf since, or a mark from before a fence", () => {
        const projection = pending();
        const mark = projection.mark();
        projection.fold({
          type: "journal_state",
          reason: "leaf",
          sessionId,
          sessionFile: "/s.jsonl",
          leafId: "E",
        });
        assert.equal(
          projection.reconcilePendingLeaf("D", { sessionId, entries: [] }, mark),
          "stale",
        );
        projection.settlePendingLeaf();
        assert.equal(
          projection.reconcilePendingLeaf("E", { sessionId, entries: [] }, mark),
          "stale",
        );
      });
    });

    it("every entry hold ends: an alias for an unheld message, the run's end, eviction from the ring", () => {
      const projection = published({ tombstones: 100, journal: 4 });
      projection.fold({ type: "message_end", messageId: "m1", message: assistant("refused") });
      projection.fold({
        type: "journal_entry",
        sessionId,
        entry: entry("E2", null, assistant("other")),
      });
      assert.equal(projection.deliverableJournalEnd, projection.journal.positionOf("E2"), "held");
      // Its alias names a message whose live frames were missed.
      projection.fold({ type: "message_persisted", sessionId, messageId: "m2", entryId: "E2" });
      assert.equal(projection.deliverableJournalEnd, projection.journal.end, "released");
      let parent = "E2";
      for (let n = 0; n < 50; n++) {
        const id = `x${n}`;
        projection.fold({
          type: "journal_entry",
          sessionId,
          entry: entry(id, parent, assistant(id)),
        });
        parent = id;
      }
      assert.isAtMost(
        projection.journal.end - projection.deliverableJournalEnd,
        4,
        "holds never outlive the ring",
      );
      projection.fold({ type: "agent_end" });
      assert.equal(
        projection.deliverableJournalEnd,
        projection.journal.end,
        "nothing waits past the run",
      );
    });

    it("a stale whole get_state reply never publishes a field older than a live frame", () => {
      const projection = published();
      const mark = projection.mark();
      projection.fold({ type: "thinking_level_changed", thinkingLevel: "high" });
      projection.applyStateReply({ sessionId, thinkingLevel: "low", sessionName: "n" }, mark);
      const state = projection.store.get("setting:state")?.value;
      assert.deepEqual(state?.class === "setting" ? state.value.value : undefined, {
        sessionId,
        thinkingLevel: "high",
        sessionName: "n",
      });
    });

    it("the roster publishes with both sources, ticks do not block replies, older replies never win", () => {
      const projection = new NeoPiNativeProjection({
        domain,
        tombstoneCapacity: 100,
        journalCapacity: 100,
      });
      projection.fold({
        type: "journal_state",
        reason: "identity",
        sessionId,
        sessionFile: "/s.jsonl",
        leafId: null,
      });
      const older = projection.mark();
      projection.fold({
        type: "subagent_event",
        payload: { id: "c", event: { type: "message_end" } },
      });
      const newer = projection.mark();
      projection.applyStateReply({ sessionId }, older);
      projection.applyJournalPage({ sessionId, entries: [] }, older);
      projection.applySubagentsReply({ subagents: [{ id: "c", status: "running", n: 2 }] }, newer);
      assert.isFalse(projection.published, "the history is part of the roster");
      projection.applySubagentHistoryReply({ subagents: [{ id: "c", status: "running" }] }, older);
      assert.isTrue(projection.published);
      assert.isFalse(
        projection.applySubagentsReply(
          { subagents: [{ id: "c", status: "running", n: 1 }] },
          older,
        ),
      );
      const value = projection.store.get("roster:c")?.value;
      assert.deepEqual(
        value?.class === "roster"
          ? [value.value.inventory, value.value.history, value.value.ticks]
          : [],
        [{ id: "c", status: "running", n: 2 }, { id: "c", status: "running" }, 1],
      );
    });

    it("finished children, settled jobs and command outputs leave the store by tombstone", () => {
      const projection = published();
      for (let n = 0; n < 400; n++) {
        projection.fold({
          type: "job_lifecycle",
          event: "registered",
          job: { id: `j${n}`, status: "running" },
        });
        projection.fold({
          type: "job_lifecycle",
          event: "updated",
          job: { id: `j${n}`, status: "completed" },
        });
        projection.fold({ type: "command_output", text: `out ${n}` });
        projection.applySubagentsReply(
          { subagents: [{ id: `c${n}`, status: "running" }] },
          projection.mark(),
        );
      }
      const live = (prefix: string) =>
        [...projection.store.values()].filter(
          (record) => record.value !== null && record.key.startsWith(prefix),
        ).length;
      assert.equal(live("job:"), 64);
      assert.equal(live("receipt:"), 256);
      assert.isAtMost(live("roster:"), 257);
      projection.applySubagentHistoryReply(
        { subagents: [{ id: "c399", status: "running" }] },
        projection.mark(),
      );
      assert.equal(live("roster:"), 1, "children absent from the whole roster are gone");
    });

    it("detach drops every payload, and later eviction stays confirmed eviction", () => {
      const projection = new NeoPiNativeProjection({
        domain,
        tombstoneCapacity: 10,
        journalCapacity: 10,
        inboxLimits: { records: 4, bytes: 100_000 },
        now: () => 1,
      });
      for (const n of [1, 2, 3])
        projection.fold({ type: "notice", level: "info", message: `n${n}` });
      projection.setInboxObserved(false);
      assert.deepEqual(
        projection.inbox.map((record) =>
          record.type === "gap" ? [record.reason, record.fromSeq, record.toSeq] : record.type,
        ),
        [["not-observed", 1, 3]],
      );
      projection.setInboxObserved(true);
      for (let n = 4; n < 20; n++)
        projection.fold({ type: "notice", level: "info", message: `n${n}` });
      const reasons = projection.inbox.flatMap((record) =>
        record.type === "gap" ? [[record.reason, record.fromSeq, record.toSeq]] : [],
      );
      // Four items: the two gaps and the two newest notices.
      assert.deepEqual(reasons, [
        ["not-observed", 1, 3],
        ["evicted", 4, 17],
      ]);
      assert.equal(projection.inbox.length, 4);
    });

    it("record only: a gap can exceed the byte bound when one tool name alone does", () => {
      const projection = new NeoPiNativeProjection({
        domain,
        tombstoneCapacity: 10,
        journalCapacity: 10,
        inboxLimits: { records: 8, bytes: 1_000 },
      });
      projection.fold({
        type: "tool_stream_update",
        toolCallId: "t",
        toolName: "n".repeat(5_000),
        update: 1,
      });
      assert.equal(projection.inbox.length, 1);
      assert.equal(projection.inbox[0]?.type, "gap");
      assert.isAbove(projection.inboxBytes, 1_000);
    });
  });

  describe("first review 7–12", () => {
    it("7 late frames never resurrect a retired message, tool or edit preview after its tombstone expires", () => {
      const projection = new NeoPiNativeProjection({
        domain,
        tombstoneCapacity: 1,
        journalCapacity: 1000,
      });
      projection.fold({
        type: "journal_state",
        reason: "identity",
        sessionId,
        sessionFile: "/s.jsonl",
        leafId: null,
      });
      projection.fold({ type: "message_end", messageId: "m", message: assistant("x") });
      projection.fold({ type: "message_persisted", sessionId, messageId: "m", entryId: "e" });
      projection.fold({ type: "tool_execution_start", toolCallId: "t", toolName: "edit" });
      projection.fold({
        type: "tool_stream_update",
        toolCallId: "t",
        toolName: "edit",
        update: { generation: 0, streaming: false, files: [] },
      });
      projection.fold({
        type: "journal_entry",
        sessionId,
        entry: entry("e", null, assistant("x")),
      });
      projection.fold({
        type: "journal_entry",
        sessionId,
        entry: entry("r", "e", { role: "toolResult", toolCallId: "t" }),
      });
      // Expire every join tombstone through other retirements.
      let parent = "r";
      for (let n = 0; n < 600; n++) {
        projection.fold({ type: "tool_execution_start", toolCallId: `o${n}`, toolName: "bash" });
        projection.fold({ type: "message_end", messageId: `p${n}`, message: assistant("y") });
        projection.fold({
          type: "message_persisted",
          sessionId,
          messageId: `p${n}`,
          entryId: `pe${n}`,
        });
        projection.fold({
          type: "journal_entry",
          sessionId,
          entry: entry(`pe${n}`, parent, assistant("y")),
        });
        projection.fold({
          type: "journal_entry",
          sessionId,
          entry: entry(`or${n}`, `pe${n}`, { role: "toolResult", toolCallId: `o${n}` }),
        });
        parent = `or${n}`;
      }
      assert.isUndefined(projection.store.get("message:m"), "its tombstone expired");
      projection.fold({ type: "message_update", messageId: "m", message: assistant("x") });
      projection.fold({
        type: "tool_execution_update",
        toolCallId: "t",
        toolName: "edit",
        partialResult: 1,
      });
      projection.fold({
        type: "tool_stream_update",
        toolCallId: "t",
        toolName: "edit",
        update: { generation: 1, streaming: true, files: [] },
      });
      for (const key of ["message:m", "tool:t", "editPreview:t"])
        assert.isUndefined(projection.store.get(key), key);
    });

    it("9 the holding area is bounded (decision 8): see 'holds under a tool that streams forever'", () => {
      const projection = new NeoPiNativeProjection({
        domain,
        tombstoneCapacity: 10,
        journalCapacity: 10,
        inboxLimits: { records: 16, bytes: 4_000 },
      });
      for (let n = 0; n < 5_000; n++)
        projection.fold({ type: "notice", level: "info", message: `turn ${n}` });
      assert.isAtMost(projection.inbox.length, 16);
    });

    it("10 one key put and removed forever keeps the tombstone queue bounded", () => {
      const projection = published({ tombstones: 1, journal: 10 });
      for (let n = 0; n < 10_000; n++) {
        projection.store.put("k", { class: "presentation", value: { n } });
        projection.store.remove("k");
      }
      assert.isAtMost(projection.store.tombstoneEntries, 200);
    });

    it("11 completed activations replace each other and aborted edit previews leave at the run's end", () => {
      const projection = published();
      for (let n = 0; n < 50; n++) {
        const payload = {
          id: "child",
          runToken: `r${n}`,
          agent: "task",
          agentSource: "bundled",
          index: 0,
        };
        projection.fold({ type: "subagent_lifecycle", payload: { ...payload, status: "started" } });
        projection.fold({
          type: "subagent_lifecycle",
          payload: { ...payload, status: "completed" },
        });
        projection.fold({
          type: "tool_stream_update",
          toolCallId: `aborted-${n}`,
          toolName: "edit",
          update: { generation: 0, streaming: false, files: [{ path: "a" }] },
        });
      }
      projection.fold({ type: "agent_end" });
      const keys = [...projection.store.values()]
        .filter((record) => record.value !== null)
        .map((record) => record.key);
      assert.deepEqual(
        keys.filter((key) => key.startsWith("roster:")),
        ["roster:child"],
      );
      assert.deepEqual(
        keys.filter((key) => key.startsWith("editPreview:")),
        [],
      );
    });

    it("12 an identity change settles the previous session's pending interactions", () => {
      const settled: string[] = [];
      const projection = new NeoPiNativeProjection({
        domain,
        tombstoneCapacity: 10,
        journalCapacity: 10,
        onEssential: (envelope) => {
          if (envelope.type === "obligation-settled")
            settled.push(`${envelope.id}:${envelope.outcome}`);
        },
      });
      projection.fold({
        type: "journal_state",
        reason: "identity",
        sessionId: "A",
        sessionFile: "/a.jsonl",
        leafId: null,
      });
      projection.fold({ type: "extension_ui_request", id: "d", method: "confirm", title: "?" });
      projection.fold({
        type: "journal_state",
        reason: "identity",
        sessionId: "B",
        sessionFile: "/b.jsonl",
        leafId: null,
      });
      assert.equal(projection.obligations.size, 0);
      assert.deepEqual(settled, ["d:cancelled"]);
    });
  });

  describe("confirmation", () => {
    it("replies are ordered by their own requests, even with no store write between them", () => {
      const projection = published();
      const older = projection.mark();
      const newer = projection.mark();
      assert.isTrue(
        projection.applySubagentsReply(
          { subagents: [{ id: "c", status: "running", n: 2 }] },
          newer,
        ),
      );
      assert.isFalse(
        projection.applySubagentsReply(
          { subagents: [{ id: "c", status: "running", n: 1 }] },
          older,
        ),
      );
      assert.isTrue(
        projection.applySubagentHistoryReply({ subagents: [{ id: "c", v: 2 }] }, newer),
      );
      assert.isFalse(
        projection.applySubagentHistoryReply({ subagents: [{ id: "c", v: 1 }] }, older),
      );
      assert.isTrue(projection.applyStateReply({ sessionId, sessionName: "new" }, newer));
      assert.isFalse(projection.applyStateReply({ sessionId, sessionName: "old" }, older));
      assert.isTrue(projection.applyJobsReply({ running: [], recent: [], runningCount: 2 }, newer));
      assert.isFalse(
        projection.applyJobsReply({ running: [], recent: [], runningCount: 1 }, older),
      );
      const roster = projection.store.get("roster:c")?.value;
      assert.deepEqual(
        roster?.class === "roster" ? [roster.value.inventory, roster.value.history] : [],
        [
          { id: "c", status: "running", n: 2 },
          { id: "c", v: 2 },
        ],
      );
      const state = projection.store.get("setting:state")?.value;
      const whole = state?.class === "setting" ? state.value.value : undefined;
      assert.deepEqual(whole, { sessionId, sessionName: "new" });
      const jobs = projection.store.get("presentation:jobs")?.value;
      assert.deepEqual(jobs?.class === "presentation" ? jobs.value : undefined, {
        runningCount: 2,
      });
    });

    it("record only: the retired-key ring remembers 4,096 keys", () => {
      const store = new NeoPiNativeProjection({ domain, tombstoneCapacity: 0, journalCapacity: 10 })
        .store;
      const retire = (key: string) => {
        store.put(key, { class: "presentation", value: {} });
        store.remove(key, `entry-${key}`);
      };
      retire("message:first");
      // Join tombstones expire into the ring once more than 256 are held; after
      // 4,096 more expirations the first key is forgotten, and a late frame for
      // it could create a live row again.
      for (let n = 0; n < 4_096 + 255; n++) retire(`message:${n}`);
      assert.isTrue(store.wasRetired("message:first"));
      retire("message:last");
      assert.isFalse(store.wasRetired("message:first"));
      assert.isTrue(store.wasRetired("message:0"));
    });

    it("when only gaps remain, a forced merge across reasons says the cause is no longer known", () => {
      const projection = new NeoPiNativeProjection({
        domain,
        tombstoneCapacity: 10,
        journalCapacity: 10,
        inboxLimits: { records: 2, bytes: 100_000 },
      });
      const notice = (message: string) =>
        projection.fold({ type: "notice", level: "info", message });
      notice("a");
      projection.setInboxObserved(false); // not-observed 1
      projection.setInboxObserved(true);
      notice("b");
      notice("c"); // evicted 2–3
      projection.setInboxObserved(false);
      notice("d"); // not-observed 4: three gaps over a bound of two
      assert.deepEqual(
        projection.inbox.map((record) =>
          record.type === "gap"
            ? [record.reason, record.fromSeq, record.toSeq, record.notices]
            : [],
        ),
        [
          ["mixed", 1, 3, 3],
          ["not-observed", 4, 4, 1],
        ],
      );
    });
  });
});
