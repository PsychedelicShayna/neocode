import type { NeoPiJournalEntry } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  emptyNativeConversation,
  reduceNativeConversation,
  type NativeConversation,
} from "./neopiConversation.ts";
import {
  emptyNativeSessionFeed,
  nativeInboxLossWarnings,
  nativeObservationNotice,
  nativeRowKeys,
  nativeTranscriptRows,
  type NativeObserverPhase,
  type NativeInboxItem,
  type NativeTranscriptRow,
} from "./neopiNativeSessions.ts";
import { createTranscriptProjector } from "./neopiTranscript.ts";

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

  it("keeps a streaming message's row when it gains its first call, through the join", () => {
    const feed = emptyNativeSessionFeed();
    const thinking = { type: "thinking", thinking: "Planning" };
    const streaming = (content: unknown[]) => ({
      ...feed,
      conversation: {
        ...feed.conversation,
        pending: [{ messageId: "m1", message: { role: "assistant", content } }],
      },
    });
    const before = nativeTranscriptRows(streaming([thinking]), false);
    // An open reasoning toggle lives in the row; a new key remounts it closed.
    const opened = before[0]!.id;
    const withCall = nativeTranscriptRows(streaming([thinking, ...message.content]), false, before);
    expect(withCall[0]!.id).toBe(opened);
    const durable = {
      ...feed,
      conversation: {
        ...feed.conversation,
        entries: [
          { ...entry, message: { role: "assistant", content: [thinking, ...message.content] } },
        ],
      },
    };
    const joined = nativeTranscriptRows(durable, false, withCall);
    expect(joined.map((row) => row.id)).toEqual([opened]);
    expect(nativeTranscriptRows(durable, false, joined).map((row) => row.id)).toEqual([opened]);
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

describe("a message keeps its row key when it persists", () => {
  const identity = { sessionId: "s1", sessionFile: "/s1.jsonl", leafId: null };
  const at = "2026-11-18T00:00:00Z";
  const durable = (id: string, parentId: string | null, message: unknown): NeoPiJournalEntry => ({
    id,
    parentId,
    type: "message",
    timestamp: at,
    message,
  });
  const reply = (n: number, withCall: boolean) => ({
    role: "assistant",
    content: [
      { type: "thinking", thinking: `planning ${n}` },
      { type: "text", text: `reply ${n}` },
      ...(withCall ? [{ type: "toolCall", id: `call-${n}`, name: "read", arguments: {} }] : []),
    ],
    stopReason: withCall ? "toolUse" : "stop",
  });
  const result = (n: number) => ({
    role: "toolResult",
    toolCallId: `call-${n}`,
    toolName: "read",
    content: [{ type: "text", text: "ok" }],
  });

  /** Drives a turn through the reducer; `views` sees every state a view renders. */
  function turn(withCall: boolean, view: (conversation: NativeConversation) => void) {
    let c = reduceNativeConversation(emptyNativeConversation(), { type: "identity", identity });
    const append = (entry: NeoPiJournalEntry) => {
      c = reduceNativeConversation(c, {
        type: "entry",
        identity: { ...identity, leafId: entry.id },
        entry,
      });
    };
    append(durable("u1", null, { role: "user", content: "go" }));
    let parent = "u1";
    for (const n of [1, 2]) {
      c = reduceNativeConversation(c, {
        type: "message",
        messageId: `m${n}`,
        message: reply(n, withCall),
      });
      view(c);
      // Native announces the persistence id with or after the entry; both orders occur.
      if (n === 1) {
        c = reduceNativeConversation(c, {
          type: "persisted",
          identity: c.identity!,
          messageId: "m1",
          entryId: "a1",
        });
        append(durable("a1", parent, reply(1, withCall)));
      } else {
        // One observation read applies both before the view renders.
        append(durable("a2", parent, reply(2, withCall)));
        c = reduceNativeConversation(c, {
          type: "persisted",
          identity: c.identity!,
          messageId: "m2",
          entryId: "a2",
        });
      }
      parent = `a${n}`;
      view(c);
      if (withCall) {
        append(durable(`r${n}`, parent, result(n)));
        parent = `r${n}`;
        view(c);
      }
    }
    // A rebase: the same branch read again as fresh objects.
    c = reduceNativeConversation(c, {
      type: "horizon",
      identity: c.identity!,
      entries: c.entries.map((entry) => ({ ...entry })),
      nextCursor: undefined,
      continuous: true,
    });
    view(c);
  }

  it.each([false, true])("web rows (tool calls: %s)", (withCall) => {
    const project = createTranscriptProjector();
    let rowKeys: ReadonlyMap<string, string> = new Map();
    const seen: string[][] = [];
    turn(withCall, (c) => {
      rowKeys = nativeRowKeys(c, rowKeys);
      seen.push(
        project(
          { entries: c.entries, pending: c.pending, leafId: c.identity?.leafId ?? null },
          {
            debug: false,
            rowKeys,
          },
        ).map((row) => row.id),
      );
    });
    // Each key, once shown, stays in every later list, in the same order and once.
    for (const [index, ids] of seen.entries()) {
      expect(new Set(ids).size).toBe(ids.length);
      for (const later of seen.slice(index + 1)) {
        const kept = later.filter((id) => ids.includes(id));
        expect(kept).toEqual(ids);
      }
    }
    expect(seen.at(-1)).toEqual(seen.at(-2));
  });

  it.each([false, true])("mobile rows (tool calls: %s)", (withCall) => {
    let previous: readonly NativeTranscriptRow[] = [];
    const seen: string[][] = [];
    turn(withCall, (conversation) => {
      previous = nativeTranscriptRows(
        { ...emptyNativeSessionFeed(), conversation },
        false,
        previous,
      );
      seen.push(previous.map((row) => row.id));
    });
    for (const [index, ids] of seen.entries()) {
      expect(new Set(ids).size).toBe(ids.length);
      for (const later of seen.slice(index + 1)) {
        const kept = later.filter((id) => ids.includes(id));
        expect(kept).toEqual(ids);
      }
    }
    expect(seen.at(-1)).toEqual(seen.at(-2));
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
        DateTime.formatLocal(DateTime.makeUnsafe(1000), { timeStyle: "medium" }),
        DateTime.formatLocal(DateTime.makeUnsafe(7000), { timeStyle: "medium" }),
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
