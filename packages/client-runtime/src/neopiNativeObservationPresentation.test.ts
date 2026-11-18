import type { NeoPiJournalEntry } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  emptyNativeSessionFeed,
  nativeInboxLossWarnings,
  nativeObservationNotice,
  nativeTranscriptRows,
  type NativeObserverPhase,
  type NativeInboxItem,
} from "./neopiNativeSessions.ts";

const message = {
  role: "assistant",
  content: [{ type: "toolCall", id: "call-1", name: "edit", arguments: { path: "a.ts" } }],
};
const entry: NeoPiJournalEntry = {
  id: "durable-1",
  parentId: null,
  type: "message",
  timestamp: "2026-11-18T00:00:00Z",
  message,
};

describe("native observation presentation", () => {
  it.each<NativeObserverPhase>(["attaching", "building"])(
    "%s communicates loading without making it a conversation record",
    (phase) => {
      const feed = emptyNativeSessionFeed();
      const conversation = feed.conversation;
      expect(nativeObservationNotice({ ...feed, observer: { phase, reason: null } })?.kind).toBe(
        "catching-up",
      );
      expect(feed.conversation).toBe(conversation);
    },
  );

  it("keeps transport loss distinct from owner loss and full-pass catch-up", () => {
    const feed = emptyNativeSessionFeed();
    expect(
      nativeObservationNotice({ ...feed, observer: { phase: "transport-lost", reason: null } })
        ?.kind,
    ).toBe("reconnecting");
    expect(
      nativeObservationNotice({
        ...feed,
        observer: { phase: "authority-unresolved", reason: null },
      })?.kind,
    ).toBe("reconnecting");
    // Observing with no completed cursor is a full pass, not Ready.
    expect(
      nativeObservationNotice({ ...feed, observer: { phase: "observing", reason: null } })?.kind,
    ).toBe("catching-up");
    for (const phase of [
      "owner-stopped",
      "detached",
      "incompatible",
      "identity-changed",
      "unauthorized",
    ] as const)
      expect(nativeObservationNotice({ ...feed, observer: { phase, reason: "ended" } })).toBeNull();
    expect(nativeObservationNotice({ ...feed, ownerLoss: "reconnecting" })).toBeNull();
  });
});

describe("mobile tool disclosure identity", () => {
  it("keeps the expanded message row through its live-to-durable join and a rebase", () => {
    const feed = emptyNativeSessionFeed();
    const live = {
      ...feed,
      conversation: { ...feed.conversation, pending: [{ messageId: "m1", message }] },
    };
    const first = nativeTranscriptRows(live, false);
    const expanded = new Set([first[0]!.id]);
    const durable = { ...feed, conversation: { ...feed.conversation, entries: [entry] } };
    const joined = nativeTranscriptRows(durable, false);
    expect(joined).toHaveLength(1);
    expect(expanded.has(joined[0]!.id)).toBe(true);
    const rebased = nativeTranscriptRows(
      { ...durable, conversation: { ...durable.conversation, entries: [{ ...entry }] } },
      false,
    );
    expect(expanded.has(rebased[0]!.id)).toBe(true);
    expect(rebased[0]?.kind === "entry" && rebased[0].entry.message).toEqual(message);
  });

  it("never gives repeated tool call ids the same row key", () => {
    const feed = emptyNativeSessionFeed();
    const rows = nativeTranscriptRows(
      {
        ...feed,
        conversation: { ...feed.conversation, entries: [entry, { ...entry, id: "duplicate" }] },
      },
      false,
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });
});

describe("inbox loss presentation", () => {
  const gap: Extract<NativeInboxItem, { type: "gap" }> = {
    type: "gap",
    seq: 9,
    reason: "evicted",
    fromSeq: 4,
    toSeq: 9,
    firstReceivedAt: 1000,
    lastReceivedAt: 7000,
    notices: 2,
    toolStreams: [{ toolCallId: "call-1", toolName: "bash", updates: 4 }],
    toolStreamsTruncated: false,
  };

  it.each(["evicted", "not-observed", "mixed"] as const)(
    "keeps %s loss distinct and reports its exact kinds, interval and time span",
    (reason) => {
      const losses = nativeInboxLossWarnings([{ ...gap, reason }], new Set(["call-1"]));
      expect(losses.general).toHaveLength(1);
      expect(losses.general[0]).toMatchObject({
        loss: reason,
        fromSeq: 4,
        toSeq: 9,
        firstReceivedAt: 1000,
        lastReceivedAt: 7000,
        notices: 2,
        toolStreams: gap.toolStreams,
        moreToolCalls: false,
      });
      const marker = losses.byToolCall.get("call-1")!;
      expect(marker).toHaveLength(1);
      expect(marker[0]).toMatchObject({
        loss: reason,
        fromSeq: 4,
        toSeq: 9,
        firstReceivedAt: 1000,
        lastReceivedAt: 7000,
        notices: 0,
        toolStreams: gap.toolStreams,
      });
      expect(losses.byToolCall.has("another-call")).toBe(false);
      const text = losses.general[0]!.text;
      for (const fact of [
        "bash",
        "call-1",
        "4",
        "9",
        DateTime.formatIso(DateTime.makeUnsafe(1000)),
        DateTime.formatIso(DateTime.makeUnsafe(7000)),
      ])
        expect(text).toContain(fact);
    },
  );

  it("never describes a client cut as records the view did not receive", () => {
    const trimmed: NativeInboxItem = {
      type: "trimmed",
      projection: "first",
      fromSeq: 4,
      toSeq: 9,
      firstReceivedAt: 1000,
      lastReceivedAt: 7000,
      notices: 2,
      toolStreams: gap.toolStreams,
      toolStreamsTruncated: true,
    };
    const raw: NativeInboxItem = {
      type: "notice",
      seq: 10,
      level: "info",
      message: "Content is not fabricated for a gap",
      projection: "first",
      receivedAt: 8000,
    };
    const losses = nativeInboxLossWarnings([trimmed, raw], new Set());
    expect(losses.general).toHaveLength(1);
    expect(losses.general[0]).toMatchObject({
      loss: "trimmed",
      fromSeq: 4,
      toSeq: 9,
      firstReceivedAt: 1000,
      lastReceivedAt: 7000,
      moreToolCalls: true,
    });
    expect(losses.general[0]!.text).not.toContain(raw.message);
    expect(losses.byToolCall.size).toBe(0);
  });

  it("does not merge different causes or restarted sequence intervals in presentation", () => {
    const losses = nativeInboxLossWarnings(
      [gap, { ...gap, reason: "not-observed", firstReceivedAt: 9000, lastReceivedAt: 10000 }],
      new Set(),
    );
    expect(losses.general).toHaveLength(2);
    expect(new Set(losses.general.map((warning) => warning.key)).size).toBe(2);
    expect(losses.general.map((warning) => warning.loss)).toEqual(["evicted", "not-observed"]);
    expect(losses.general[0]!.text).not.toBe(losses.general[1]!.text);
  });

  it("shows an older-details marker without inventing a kind, cause, interval, time or count", () => {
    const losses = nativeInboxLossWarnings([{ type: "older-details-trimmed" }], new Set());
    expect(losses.general).toEqual([
      { key: "older-details-trimmed", loss: "older-details-trimmed", text: expect.any(String) },
    ]);
    expect(losses.byToolCall.size).toBe(0);
  });
});
