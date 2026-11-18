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
  const reply = readNeoPiNativeObservation(projection, null, WIDE);
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
    // The older reply arrives last: neither the event nor the newer reply regresses.
    assert.isTrue(
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
      const reply = readNeoPiNativeObservation(projection, null, WIDE);
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
        const reply = readNeoPiNativeObservation(projection, null, WIDE);
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
      assert.equal(projection.fold({ type: "agent_start" }), "navigated");
      assert.equal(projection.domain.branchGeneration, generation + 1);
      assert.deepEqual(tailIds(projection), []);
      assert.equal(projection.identity?.leafId, "e1");
      // A caller with no further frame settles it directly.
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
      const reader = readNeoPiNativeObservation(projection, null, WIDE);
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
      const behind = readNeoPiNativeObservation(projection, reader.continuation, WIDE);
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
      );
      assert.deepEqual(gaps(again), [], "the gap is delivered once");
    });

    it("records dropped while unobserved reach the next viewer as one not-observed gap covering exactly them", () => {
      const projection = bounded(64, 100_000);
      projection.fold(stream("seen", 1));
      const first = readNeoPiNativeObservation(projection, null, WIDE);
      assert.equal(first.type, "pass");
      if (first.type !== "pass") return;
      // The last watcher detaches; B5 drives this hook.
      projection.setInboxObserved(false);
      projection.pruneInbox(first.continuation.inboxSeq);
      projection.fold(stream("call-x", 1));
      projection.fold({ type: "notice", level: "warning", message: "stopped auto-recovery" });
      projection.setInboxObserved(true);
      projection.fold(stream("after", 1));
      const attached = readNeoPiNativeObservation(projection, null, WIDE);
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
      assert.deepEqual(value(projection, "presentation:jobs"), { runningCount: 1 });
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
});
