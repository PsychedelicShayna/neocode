import { describe, expect, it } from "vite-plus/test";
import type { NeoPiJournalEntry, NeoPiJournalPage } from "@t3tools/contracts";
import { emptyNativeConversation, nativeNavigationGuards, reduceNativeConversation } from "./neopiConversation.ts";
import { applyNativeConversationEvent, emptyNativeConversationFeed } from "./state/neopiConversation.ts";

const identity = { sessionId: "native-session", sessionFile: "/sessions/native.jsonl", leafId: "b" };
const entry = (id: string, parentId: string | null, type = "message"): NeoPiJournalEntry => ({ id, parentId, type, timestamp: "2026-10-22T00:00:00Z", message: { role: "user", content: id } });
const page = (entries = [entry("a", null), entry("b", "a")], overrides: Partial<NeoPiJournalPage> = {}): NeoPiJournalPage => ({ ...identity, entries, totalEntries: entries.length, ...overrides });
const initial = () => reduceNativeConversation(emptyNativeConversation(), { type: "snapshot", page: page() });

describe("native main conversation", () => {
  it("accepts the producer's unsaved snapshot and rejects another canonical file", () => {
    let feed = applyNativeConversationEvent(emptyNativeConversationFeed(), { type: "snapshot", page: page() });
    feed = applyNativeConversationEvent(feed, { type: "native", event: { type: "message_start", snapshot: true,
      ...identity, messageId: "msg-current", message: { role: "assistant", content: [{ type: "text", text: "Already running" }] } } });
    expect(feed.conversation.pending[0]?.messageId).toBe("msg-current");
    expect(feed.busy).toBe(true);
    const previous = feed;
    feed = applyNativeConversationEvent(feed, { type: "native", event: { type: "message_start", snapshot: true,
      ...identity, sessionFile: "/other/session.jsonl", messageId: "msg-old-binding", message: { role: "assistant", content: "Wrong owner" } } });
    expect(feed).toBe(previous);
    feed = applyNativeConversationEvent(feed, { type: "native", event: { type: "agent_end" } });
    expect(feed.busy).toBe(false);
  });
  it("keeps complete older pages beyond 2000 entries, native boundaries and unknown fields", () => {
    const all = Array.from({ length: 2307 }, (_, index) => entry(String(index), index ? String(index - 1) : null,
      index === 600 ? "compaction" : index === 1200 ? "reset_boundary" : index === 1800 ? "branch_summary" : "message"));
    all[31] = { ...all[31]!, type: "future_extension", opaque: { preserved: true } };
    const current = { sessionId: identity.sessionId, sessionFile: identity.sessionFile, leafId: "2306" };
    let state = reduceNativeConversation(emptyNativeConversation(), { type: "snapshot", page: { ...current, entries: all.slice(-100), totalEntries: all.length, nextCursor: "2207" } });
    for (let end = 2207; end > 0; end -= 100) state = reduceNativeConversation(state, { type: "older", revision: state.revision, page: {
      ...current, entries: all.slice(Math.max(0, end - 100), end), totalEntries: all.length, ...(end > 100 ? { nextCursor: String(end - 100) } : {}),
    } });
    expect(state.entries).toEqual(all);
    expect(state.cursor).toBeUndefined();
    expect(state.entries[31]?.opaque).toEqual({ preserved: true });
    expect(state.entries.filter((value) => value.type !== "message").map((value) => value.type)).toEqual(["future_extension", "compaction", "reset_boundary", "branch_summary"]);
  });

  it.each([true, false])("associates live messages with durable identities in either arrival order: ack first %s", (ackFirst) => {
    let state = reduceNativeConversation(initial(), { type: "message", messageId: "msg-1", message: { role: "assistant", content: [{ type: "text", text: "stream" }] } });
    const nextIdentity = { ...identity, leafId: "c" };
    const ack = { type: "persisted" as const, identity: nextIdentity, messageId: "msg-1", entryId: "c" };
    const durable = { type: "entry" as const, identity: nextIdentity, entry: entry("c", "b") };
    state = reduceNativeConversation(state, ackFirst ? ack : durable);
    state = reduceNativeConversation(state, ackFirst ? durable : ack);
    state = reduceNativeConversation(state, durable);
    state = reduceNativeConversation(state, { type: "message", messageId: "msg-1", message: { role: "assistant", content: "late message_end" } });
    expect(state.pending).toEqual([]);
    expect(state.entries.map((value) => value.id)).toEqual(["a", "b", "c"]);
  });

  it("treats copied files with the same session ID as different identities", () => {
    let state = reduceNativeConversation(initial(), { type: "message", messageId: "msg-1", message: { role: "assistant" } });
    state = reduceNativeConversation(state, { type: "identity", identity: { ...identity, sessionFile: "/copies/native.jsonl" } });
    expect(state.pending).toEqual([]);
    expect(state.entries).toEqual([]);
    expect(state.needsSnapshot).toBe(true);
    expect(state.persisted.size).toBe(0);
  });

  it("rejects old paging responses across a branch switch and never splices alternate futures", () => {
    let state = initial();
    const revision = state.revision;
    state = reduceNativeConversation(state, { type: "identity", identity: { ...identity, leafId: "alternate" } });
    state = reduceNativeConversation(state, { type: "snapshot", page: page([entry("a", null), entry("alternate", "a")], { leafId: "alternate" }) });
    state = reduceNativeConversation(state, { type: "older", revision, page: page([entry("old", null)], { nextCursor: "stale" }) });
    expect(state.entries.map((value) => value.id)).toEqual(["a", "alternate"]);
    expect(state.cursor).toBeUndefined();
  });

  it("accepts a native leaf notification before the durable append without losing prior entries", () => {
    let state = initial();
    const next = { ...identity, leafId: "c" };
    state = reduceNativeConversation(state, { type: "identity", identity: next });
    expect(state.needsSnapshot).toBe(true);
    state = reduceNativeConversation(state, { type: "entry", identity: next, entry: entry("c", "b", "compaction") });
    expect(state.needsSnapshot).toBe(false);
    expect(state.entries.map((value) => value.id)).toEqual(["a", "b", "c"]);
  });

  it("deduplicates snapshot/live overlap and keeps already loaded ancestors", () => {
    let state = initial();
    state = reduceNativeConversation(state, { type: "snapshot", page: page([entry("b", "a"), entry("c", "b")], { leafId: "c" }) });
    state = reduceNativeConversation(state, { type: "entry", identity: { ...identity, leafId: "c" }, entry: entry("c", "b") });
    expect(state.entries.map((value) => value.id)).toEqual(["a", "b", "c"]);
  });

  it("clears process-local stream identities on reconnect without emitting a send", () => {
    let state = reduceNativeConversation(initial(), { type: "message", messageId: "msg-1", message: { role: "assistant", content: "unsaved" } });
    state = reduceNativeConversation(state, { type: "disconnect" });
    expect(state.pending).toEqual([]);
    expect(state.needsSnapshot).toBe(true);
    state = reduceNativeConversation(state, { type: "snapshot", page: page() });
    state = reduceNativeConversation(state, { type: "message", messageId: "msg-1", message: { role: "user", content: "new process" } });
    expect(state.pending[0]?.message.content).toBe("new process");
  });

  it("reduces all frames before consumers observe the latest subscription value", () => {
    let feed = applyNativeConversationEvent(emptyNativeConversationFeed(), { type: "snapshot", page: page() });
    for (const text of ["a", "ab", "abc"]) feed = applyNativeConversationEvent(feed, { type: "native", event: { type: "message_update", messageId: "msg-4", message: { role: "assistant", content: text } } });
    feed = applyNativeConversationEvent(feed, { type: "native", event: { type: "journal_entry", ...identity, leafId: "c", entry: entry("c", "b") } });
    feed = applyNativeConversationEvent(feed, { type: "native", event: { type: "message_persisted", ...identity, leafId: "c", messageId: "msg-4", entryId: "c" } });
    expect(feed.conversation.pending).toEqual([]);
    expect(feed.conversation.entries.at(-1)?.id).toBe("c");
  });

  it("keeps root-leaf and canonical-file preconditions exact", () => {
    expect(nativeNavigationGuards({ ...identity, leafId: null })).toEqual({ expectedSessionId: identity.sessionId, expectedSessionFile: identity.sessionFile, expectedLeafId: null });
    expect(() => nativeNavigationGuards({ ...identity, sessionFile: null })).toThrow("canonical native file");
  });
});
