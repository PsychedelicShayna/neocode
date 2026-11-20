import { describe, expect, it } from "vite-plus/test";
import type { NeoPiJournalEntry, NeoPiJournalPage } from "@t3tools/contracts";
import {
  emptyNativeConversation,
  nativeNavigationGuards,
  reduceNativeConversation,
} from "./neopiConversation.ts";

const identity = {
  sessionId: "native-session",
  sessionFile: "/sessions/native.jsonl",
  leafId: "b",
};
const entry = (id: string, parentId: string | null, type = "message"): NeoPiJournalEntry => ({
  id,
  parentId,
  type,
  timestamp: "2026-10-22T00:00:00Z",
  message: { role: "user", content: id },
});
const page = (
  entries = [entry("a", null), entry("b", "a")],
  overrides: Partial<NeoPiJournalPage> = {},
): NeoPiJournalPage => ({ ...identity, entries, totalEntries: entries.length, ...overrides });
const initial = () =>
  reduceNativeConversation(emptyNativeConversation(), { type: "snapshot", page: page() });

describe("native main conversation", () => {
  it("keeps complete older pages beyond 2000 entries, native boundaries and unknown fields", () => {
    const all = Array.from({ length: 2307 }, (_, index) =>
      entry(
        String(index),
        index ? String(index - 1) : null,
        index === 600
          ? "compaction"
          : index === 1200
            ? "reset_boundary"
            : index === 1800
              ? "branch_summary"
              : "message",
      ),
    );
    all[31] = { ...all[31]!, type: "future_extension", opaque: { preserved: true } };
    const current = {
      sessionId: identity.sessionId,
      sessionFile: identity.sessionFile,
      leafId: "2306",
    };
    let state = reduceNativeConversation(emptyNativeConversation(), {
      type: "snapshot",
      page: { ...current, entries: all.slice(-100), totalEntries: all.length, nextCursor: "2207" },
    });
    for (let end = 2207; end > 0; end -= 100)
      state = reduceNativeConversation(state, {
        type: "older",
        revision: state.revision,
        page: {
          ...current,
          entries: all.slice(Math.max(0, end - 100), end),
          totalEntries: all.length,
          ...(end > 100 ? { nextCursor: String(end - 100) } : {}),
        },
      });
    expect(state.entries).toEqual(all);
    expect(state.cursor).toBeUndefined();
    expect(state.entries[31]?.opaque).toEqual({ preserved: true });
    expect(
      state.entries.filter((value) => value.type !== "message").map((value) => value.type),
    ).toEqual(["future_extension", "compaction", "reset_boundary", "branch_summary"]);
  });

  it("changes nothing when an older page reply is replayed after later pages", () => {
    const all = Array.from({ length: 5 }, (_, index) =>
      entry(String(index), index ? String(index - 1) : null),
    );
    const current = { ...identity, leafId: "4" };
    let state = reduceNativeConversation(emptyNativeConversation(), {
      type: "snapshot",
      page: { ...current, entries: all.slice(3), totalEntries: 5, nextCursor: "3" },
    });
    const first = {
      type: "older" as const,
      revision: state.revision,
      page: { ...current, entries: all.slice(2, 3), totalEntries: 5, nextCursor: "2" },
    };
    state = reduceNativeConversation(state, first);
    state = reduceNativeConversation(state, {
      type: "older",
      revision: state.revision,
      page: { ...current, entries: all.slice(0, 2), totalEntries: 5 },
    });
    expect(state.cursor).toBeUndefined();
    expect(reduceNativeConversation(state, first)).toBe(state);
  });

  it.each([true, false])(
    "associates live messages with durable identities in either arrival order: ack first %s",
    (ackFirst) => {
      let state = reduceNativeConversation(initial(), {
        type: "message",
        messageId: "msg-1",
        message: { role: "assistant", content: [{ type: "text", text: "stream" }] },
      });
      const nextIdentity = { ...identity, leafId: "c" };
      const ack = {
        type: "persisted" as const,
        identity: nextIdentity,
        messageId: "msg-1",
        entryId: "c",
      };
      const durable = { type: "entry" as const, identity: nextIdentity, entry: entry("c", "b") };
      state = reduceNativeConversation(state, ackFirst ? ack : durable);
      state = reduceNativeConversation(state, ackFirst ? durable : ack);
      state = reduceNativeConversation(state, durable);
      state = reduceNativeConversation(state, {
        type: "message",
        messageId: "msg-1",
        message: { role: "assistant", content: "late message_end" },
      });
      expect(state.pending).toEqual([]);
      expect(state.entries.map((value) => value.id)).toEqual(["a", "b", "c"]);
    },
  );

  it("treats copied files with the same session ID as different identities", () => {
    let state = reduceNativeConversation(initial(), {
      type: "message",
      messageId: "msg-1",
      message: { role: "assistant" },
    });
    state = reduceNativeConversation(state, {
      type: "identity",
      identity: { ...identity, sessionFile: "/copies/native.jsonl" },
    });
    expect(state.pending).toEqual([]);
    expect(state.entries).toEqual([]);
    expect(state.needsSnapshot).toBe(true);
    expect(state.persisted.size).toBe(0);
  });

  it("rejects old paging responses across a branch switch and never splices alternate futures", () => {
    let state = initial();
    state = reduceNativeConversation(state, {
      type: "message",
      messageId: "old-stream",
      message: { role: "assistant", content: "Abandoned branch" },
    });
    const revision = state.revision;
    state = reduceNativeConversation(state, {
      type: "identity",
      identity: { ...identity, leafId: "alternate" },
    });
    state = reduceNativeConversation(state, {
      type: "snapshot",
      page: page([entry("a", null), entry("alternate", "a")], { leafId: "alternate" }),
    });
    state = reduceNativeConversation(state, {
      type: "older",
      revision,
      page: page([entry("old", null)], { nextCursor: "stale" }),
    });
    expect(state.entries.map((value) => value.id)).toEqual(["a", "alternate"]);
    expect(state.pending).toEqual([]);
    expect(state.persisted.size).toBe(0);
    expect(state.cursor).toBeUndefined();
  });

  it("accepts a native leaf notification before the durable append without losing prior entries", () => {
    let state = initial();
    const next = { ...identity, leafId: "c" };
    state = reduceNativeConversation(state, { type: "identity", identity: next });
    expect(state.needsSnapshot).toBe(true);
    state = reduceNativeConversation(state, {
      type: "entry",
      identity: next,
      entry: entry("c", "b", "compaction"),
    });
    expect(state.needsSnapshot).toBe(false);
    expect(state.entries.map((value) => value.id)).toEqual(["a", "b", "c"]);
  });

  it("renders streamed text while its native leaf is waiting for durable entries", () => {
    let state = reduceNativeConversation(initial(), {
      type: "identity",
      identity: { ...identity, leafId: "next-user" },
    });
    state = reduceNativeConversation(state, {
      type: "message",
      messageId: "live-reply",
      message: { role: "assistant", content: "Still arriving" },
    });
    expect(state.entries.map((value) => value.id)).toEqual(["a", "b"]);
    expect(state.pending[0]?.message.content).toBe("Still arriving");
  });

  it("joins a durable flush whose entries share the final leaf identity", () => {
    const finalIdentity = { ...identity, leafId: "reply" };
    let state = reduceNativeConversation(initial(), {
      type: "identity",
      identity: finalIdentity,
    });
    state = reduceNativeConversation(state, {
      type: "message",
      messageId: "live-reply",
      message: { role: "assistant", content: "Reply" },
    });
    state = reduceNativeConversation(state, {
      type: "persisted",
      identity: finalIdentity,
      messageId: "live-reply",
      entryId: "reply",
    });
    for (const item of [
      entry("user", "b"),
      entry("bookkeeping", "user", "custom"),
      { ...entry("reply", "bookkeeping"), message: { role: "assistant", content: "Reply" } },
    ]) {
      state = reduceNativeConversation(state, {
        type: "entry",
        identity: finalIdentity,
        entry: item,
      });
    }
    expect(state.entries.map((value) => value.id)).toEqual([
      "a",
      "b",
      "user",
      "bookkeeping",
      "reply",
    ]);
    expect(state.entries.at(-1)?.message).toEqual({ role: "assistant", content: "Reply" });
    expect(state.pending).toEqual([]);
    expect(state.needsSnapshot).toBe(false);
  });

  it("keeps the current branch when an incoming batch belongs to an alternate future", () => {
    const before = initial();
    const state = reduceNativeConversation(before, {
      type: "entry",
      identity: { ...identity, leafId: "other-reply" },
      entry: entry("other-user", "a"),
    });
    expect(state.entries).toBe(before.entries);
    expect(state.needsSnapshot).toBe(true);
  });

  it("deduplicates snapshot/live overlap and keeps already loaded ancestors", () => {
    let state = initial();
    state = reduceNativeConversation(state, {
      type: "snapshot",
      page: page([entry("b", "a"), entry("c", "b")], { leafId: "c" }),
    });
    state = reduceNativeConversation(state, {
      type: "entry",
      identity: { ...identity, leafId: "c" },
      entry: entry("c", "b"),
    });
    expect(state.entries.map((value) => value.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps a live row across a reconnect until its identified durable entry is present", () => {
    let state = reduceNativeConversation(initial(), {
      type: "message",
      messageId: "msg-1",
      message: { role: "assistant", content: "unsaved" },
    });
    state = reduceNativeConversation(state, { type: "disconnect" });
    expect(state.needsSnapshot).toBe(true);
    state = reduceNativeConversation(state, { type: "snapshot", page: page() });
    expect(state.pending.map((row) => row.messageId)).toEqual(["msg-1"]);
    const next = { ...identity, leafId: "c" };
    state = reduceNativeConversation(state, {
      type: "persisted",
      identity: next,
      messageId: "msg-1",
      entryId: "c",
    });
    expect(state.pending.map((row) => row.messageId)).toEqual(["msg-1"]);
    state = reduceNativeConversation(state, {
      type: "entry",
      identity: next,
      entry: entry("c", "b"),
    });
    expect(state.pending).toEqual([]);
    expect(state.entries.map((value) => value.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps root-leaf and canonical-file preconditions exact", () => {
    expect(nativeNavigationGuards({ ...identity, leafId: null })).toEqual({
      expectedSessionId: identity.sessionId,
      expectedSessionFile: identity.sessionFile,
      expectedLeafId: null,
    });
    expect(() => nativeNavigationGuards({ ...identity, sessionFile: null })).toThrow(
      "canonical native file",
    );
  });

  it("keeps a failed turn's error with that turn and off every later turn", () => {
    const failure = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "404 0 endpoints out of 5 requested are available",
    };
    const reply = { role: "assistant", content: "Fine", stopReason: "stop" };
    const message = (messageId: string, body: Record<string, unknown>) =>
      ({ type: "message", messageId, message: body }) as const;
    let conversation = initial();
    // The failed turn: its live copy shows while the turn is the latest.
    conversation = reduceNativeConversation(conversation, { type: "turn_started" });
    conversation = reduceNativeConversation(conversation, message("failed", failure));
    expect(conversation.pending.map((item) => item.messageId)).toEqual(["failed"]);
    // The next turn starts and succeeds: the failure is not carried into it.
    conversation = reduceNativeConversation(conversation, { type: "turn_started" });
    expect(conversation.pending).toEqual([]);
    conversation = reduceNativeConversation(conversation, message("ok", reply));
    expect(conversation.pending.map((item) => item.messageId)).toEqual(["ok"]);
    // A durable failed entry stays where the journal put it.
    const failed = { ...entry("c", "b"), message: failure };
    const settled = reduceNativeConversation(conversation, {
      type: "entry",
      identity: { ...identity, leafId: "c" },
      entry: failed,
    });
    expect(settled.entries.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
});
