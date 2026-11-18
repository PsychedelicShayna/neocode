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
});
