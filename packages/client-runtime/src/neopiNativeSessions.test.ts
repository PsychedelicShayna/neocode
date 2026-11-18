import { describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderInstanceId,
  type NeoPiJournalEntry,
  type NeoPiJournalPage,
  type NeoPiNativeEntity,
  type NeoPiNativeJournalSlice,
  type NeoPiNativeObservationDomain,
  type NeoPiNativeTombstone,
} from "@t3tools/contracts";
import { nativeConversationGaps } from "./neopiConversation.ts";
import {
  emptyNativeSessionFeed,
  deferNativeEditorText,
  executeNativeSessionCommand,
  nativeCommandCompletions,
  nativeCommandNeedsTerminal,
  nativeRecord,
  nativeSessionKey,
  nativeSlashArgument,
  nativeSlashCommands,
  nativeTranscriptEntries,
  nativeTranscriptRows,
  reduceNativeSessionFeed,
  type NativeSessionFeed,
  type NativeSession,
} from "./neopiNativeSessions.ts";

describe("deferred native editor text", () => {
  function fixture(initialDraft: string) {
    let draft = initialDraft;
    const listeners = new Set<() => void>();
    const deferred = vi.fn();
    const applied = vi.fn();
    const setDraft = (value: string) => {
      draft = value;
      for (const changed of listeners) changed();
    };
    const cancel = deferNativeEditorText({
      hasDraft: () => draft.length > 0,
      apply: () => {
        applied();
        setDraft("Native requested text");
      },
      onDeferred: deferred,
      subscribe: (changed) => {
        listeners.add(changed);
        return () => listeners.delete(changed);
      },
    });
    return { applied, deferred, setDraft, cancel, listeners, draft: () => draft };
  }

  it("inserts immediately into an empty draft without retaining a subscription", () => {
    const test = fixture("");
    expect(test.draft()).toBe("Native requested text");
    expect(test.applied).toHaveBeenCalledTimes(1);
    expect(test.deferred).not.toHaveBeenCalled();
    expect(test.listeners.size).toBe(0);
  });

  it("preserves a draft and its further edits, then applies exactly once after it is cleared", () => {
    const test = fixture("Unsent draft");
    expect(test.draft()).toBe("Unsent draft");
    expect(test.applied).not.toHaveBeenCalled();
    expect(test.deferred).toHaveBeenCalledTimes(1);
    test.setDraft("Still editing the unsent draft");
    expect(test.applied).not.toHaveBeenCalled();
    test.setDraft("");
    expect(test.draft()).toBe("Native requested text");
    expect(test.applied).toHaveBeenCalledTimes(1);
    expect(test.listeners.size).toBe(0);
    test.setDraft("");
    expect(test.applied).toHaveBeenCalledTimes(1);
  });

  it("stops a superseded or unmounted request without consuming it", () => {
    const test = fixture("Draft");
    test.cancel();
    test.setDraft("");
    expect(test.applied).not.toHaveBeenCalled();
    expect(test.listeners.size).toBe(0);
    test.cancel();
  });

  it("handles an empty-draft notification delivered synchronously during subscription", () => {
    let occupied = true;
    const apply = vi.fn();
    const unsubscribe = vi.fn();
    const cancel = deferNativeEditorText({
      hasDraft: () => occupied,
      apply,
      onDeferred: vi.fn(),
      subscribe: (changed) => {
        occupied = false;
        changed();
        return unsubscribe;
      },
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    cancel();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("native command acceptance and observation", () => {
  it("returns the original acceptance receipt when the follow-up read disconnects", async () => {
    const receipt = { accepted: true, commandId: "native-command" };
    const submit = vi.fn().mockResolvedValue(receipt);
    const readState = vi.fn().mockRejectedValue(new Error("Disconnected"));
    const onState = vi.fn();
    const onRefreshError = vi.fn();

    const result = await executeNativeSessionCommand({
      command: { type: "set_model" },
      submit,
      readState,
      onState,
      onRefreshError,
    });

    expect(result).toBe(receipt);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(readState).toHaveBeenCalledTimes(1);
    expect(onState).not.toHaveBeenCalled();
    expect(onRefreshError).toHaveBeenCalledWith(
      "Command accepted, but the state refresh failed. Reconnect to refresh session details.",
    );
  });

  it("still rejects the command's own failure without reading state or claiming acceptance", async () => {
    const failure = new Error("The selected model is unavailable");
    const readState = vi.fn();
    const onRefreshError = vi.fn();
    await expect(
      executeNativeSessionCommand({
        command: { type: "set_role" },
        submit: vi.fn().mockRejectedValue(failure),
        readState,
        onState: vi.fn(),
        onRefreshError,
      }),
    ).rejects.toBe(failure);
    expect(readState).not.toHaveBeenCalled();
    expect(onRefreshError).not.toHaveBeenCalled();
  });

  it("applies a successful authoritative refresh and returns the acceptance receipt", async () => {
    const state = { model: { id: "selected-model" }, role: "reviewer" };
    const receipt = { accepted: true };
    const onState = vi.fn();
    const onRefreshError = vi.fn();
    expect(
      await executeNativeSessionCommand({
        command: { type: "set_role" },
        submit: async () => receipt,
        readState: async () => state,
        onState,
        onRefreshError,
      }),
    ).toBe(receipt);
    expect(onState).toHaveBeenCalledWith(state);
    expect(onRefreshError).not.toHaveBeenCalled();
  });

  it.each(["prompt", "extension_ui_response"])(
    "does not add a state read after %s",
    async (type) => {
      const receipt = { accepted: true };
      const readState = vi.fn();
      const onState = vi.fn();
      const onRefreshError = vi.fn();
      expect(
        await executeNativeSessionCommand({
          command: { type },
          submit: async () => receipt,
          readState,
          onState,
          onRefreshError,
        }),
      ).toBe(receipt);
      expect(readState).not.toHaveBeenCalled();
      expect(onState).not.toHaveBeenCalled();
      expect(onRefreshError).not.toHaveBeenCalled();
    },
  );
});

const ref = {
  providerInstanceId: ProviderInstanceId.make("neopi"),
  sessionFile: "/sessions/conversation.jsonl",
};
const session: NativeSession = {
  ref,
  sessionId: "native-id",
  cwd: "/workspace",
  attachment: "terminal",
  capabilities: [],
  state: { isStreaming: true },
};
const user: NeoPiJournalEntry = {
  id: "user-a",
  parentId: null,
  timestamp: "2026-10-28T00:00:00Z",
  type: "message",
  message: { role: "user", content: "Question" },
};
const initial = () =>
  reduceNativeSessionFeed(emptyNativeSessionFeed(), {
    type: "snapshot",
    session,
    journal: {
      sessionId: session.sessionId,
      sessionFile: ref.sessionFile,
      leafId: user.id,
      entries: [user],
      totalEntries: 1,
    },
  });

describe("canonical native client projection", () => {
  it.each(["message_start", "message_update", "tool_execution_update", "unknown"])(
    "retains feed identity for ignored child %s frames",
    (type) => {
      const feed = initial();
      const next = reduceNativeSessionFeed(feed, {
        type: "event",
        frame: { type: "subagent_event", payload: { id: "child", event: { type } } },
      });
      expect(next).toBe(feed);
    },
  );

  it.each(["message_end", "tool_execution_end", "agent_end"])(
    "publishes a child refresh tick for settled %s frames",
    (type) => {
      const feed = initial();
      const update = {
        type: "event" as const,
        frame: { type: "subagent_event", payload: { id: "child", event: { type } } },
      };
      const next = reduceNativeSessionFeed(feed, update);
      expect(next).not.toBe(feed);
      expect(next.agentTicks.child).toBe(1);
      expect(next.conversation).toBe(feed.conversation);
      expect(next.busy).toBe(feed.busy);
      expect(reduceNativeSessionFeed(next, update).agentTicks.child).toBe(2);
    },
  );

  it("keeps command output between messages across hidden entries and reconnect", () => {
    let feed = initial();
    const bookkeeping = { ...user, id: "config", parentId: user.id, type: "model_change" };
    const identity = {
      sessionId: session.sessionId,
      sessionFile: ref.sessionFile,
      leafId: bookkeeping.id,
    };
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: { type: "journal_entry", ...identity, entry: bookkeeping },
    });
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: { type: "command_output", text: "Context\n42% used" },
    });
    const nextUser = { ...user, id: "user-b", parentId: bookkeeping.id };
    feed = reduceNativeSessionFeed(feed, { type: "disconnected" });
    feed = reduceNativeSessionFeed(feed, {
      type: "snapshot",
      session,
      journal: {
        ...identity,
        leafId: nextUser.id,
        entries: [user, bookkeeping, nextUser],
        totalEntries: 3,
      },
    });
    expect(
      nativeTranscriptRows(feed, false).map((row) =>
        row.kind === "command" ? row.text : row.entry.id,
      ),
    ).toEqual([user.id, "Context\n42% used", nextUser.id]);
    expect(feed.conversation.entries).toEqual([user, bookkeeping, nextUser]);
    expect(
      nativeTranscriptRows(feed, true).map((row) =>
        row.kind === "command" ? row.text : row.entry.id,
      ),
    ).toEqual([user.id, bookkeeping.id, "Context\n42% used", nextUser.id]);
  });

  it("keeps command output visible when the announced journal leaf is not loaded", () => {
    const bookkeeping = { ...user, id: "unloaded-config", parentId: user.id, type: "chat_mode" };
    const identity = {
      sessionId: session.sessionId,
      sessionFile: ref.sessionFile,
      leafId: bookkeeping.id,
    };
    let feed = reduceNativeSessionFeed(initial(), {
      type: "event",
      frame: { type: "journal_state", reason: "append", ...identity },
    });
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: { type: "command_output", text: "Chat mode: chat" },
    });
    expect(feed.commandOutputs.map((output) => output.text)).toEqual(["Chat mode: chat"]);
    for (const debug of [false, true])
      expect(
        nativeTranscriptRows(feed, debug).map((row) =>
          row.kind === "command" ? row.text : row.entry.id,
        ),
      ).toEqual([user.id, "Chat mode: chat"]);

    const nextUser = { ...user, id: "user-b", parentId: bookkeeping.id };
    feed = reduceNativeSessionFeed(feed, { type: "disconnected" });
    feed = reduceNativeSessionFeed(feed, {
      type: "snapshot",
      session,
      journal: {
        ...identity,
        leafId: nextUser.id,
        entries: [user, bookkeeping, nextUser],
        totalEntries: 3,
      },
    });
    expect(
      nativeTranscriptRows(feed, false).map((row) =>
        row.kind === "command" ? row.text : row.entry.id,
      ),
    ).toEqual([user.id, "Chat mode: chat", nextUser.id]);
    const otherBranch = { ...user, id: "other-branch" };
    feed = reduceNativeSessionFeed(feed, {
      type: "snapshot",
      session,
      journal: { ...identity, leafId: otherBranch.id, entries: [otherBranch], totalEntries: 1 },
    });
    expect(nativeTranscriptRows(feed, false).map((row) => row.id)).toEqual(["entry:other-branch"]);
  });

  it("shows command output after a streamed turn is durable and idle", () => {
    const message = { role: "assistant", content: "Finished reply" };
    const reply = { ...user, id: "durable-reply", parentId: user.id, message };
    const identity = {
      sessionId: session.sessionId,
      sessionFile: ref.sessionFile,
      leafId: reply.id,
    };
    let feed = initial();
    for (const frame of [
      { type: "agent_start" },
      { type: "message_start", messageId: "reply-live", message },
      { type: "message_update", messageId: "reply-live", message },
      { type: "message_end", messageId: "reply-live", message },
      { type: "journal_entry", ...identity, entry: reply },
      { type: "message_persisted", ...identity, messageId: "reply-live", entryId: reply.id },
      { type: "agent_end" },
    ])
      feed = reduceNativeSessionFeed(feed, { type: "event", frame });
    const snapshot = {
      type: "snapshot" as const,
      session: { ...session, state: { isStreaming: false } },
      journal: { ...identity, entries: [user, reply], totalEntries: 2 },
    };
    feed = reduceNativeSessionFeed(feed, snapshot);
    const results = ["Current model: provider/model", "Context\n42% used"];
    for (const text of results)
      feed = reduceNativeSessionFeed(feed, {
        type: "event",
        frame: { type: "command_output", text },
      });
    const visibleRows = () =>
      nativeTranscriptRows(feed, false).map((row) =>
        row.kind === "command" ? row.text : row.entry.id,
      );
    expect(feed.busy).toBe(false);
    expect(feed.conversation.pending).toEqual([]);
    expect(visibleRows()).toEqual([user.id, reply.id, ...results]);
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: { type: "journal_state", reason: "snapshot", ...identity },
    });
    feed = reduceNativeSessionFeed(feed, { type: "disconnected" });
    feed = reduceNativeSessionFeed(feed, snapshot);
    expect(visibleRows()).toEqual([user.id, reply.id, ...results]);
  });

  it("keeps repeated command results after their live message becomes durable", () => {
    let feed = initial();
    const message = { role: "assistant", content: "Answer" };
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: { type: "message_update", messageId: "live-answer", message },
    });
    for (let i = 0; i < 2; i++)
      feed = reduceNativeSessionFeed(feed, {
        type: "event",
        frame: { type: "command_output", text: "Current model: provider/model" },
      });
    expect(nativeTranscriptRows(feed, false).map((row) => row.id)).toEqual([
      "entry:user-a",
      "entry:live:live-answer",
      "command:0",
      "command:1",
    ]);
    const reply = { ...user, id: "reply", parentId: user.id, message };
    const identity = {
      sessionId: session.sessionId,
      sessionFile: ref.sessionFile,
      leafId: reply.id,
    };
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: {
        type: "message_persisted",
        ...identity,
        messageId: "live-answer",
        entryId: reply.id,
      },
    });
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: { type: "journal_entry", ...identity, entry: reply },
    });
    expect(nativeTranscriptRows(feed, false).map((row) => row.id)).toEqual([
      "entry:user-a",
      "entry:reply",
      "command:0",
      "command:1",
    ]);
    expect(feed.conversation.entries).toEqual([user, reply]);
    expect(feed.conversation.pending).toEqual([]);
  });

  it("hides output from another branch and clears it when the session changes", () => {
    let feed = reduceNativeSessionFeed(initial(), {
      type: "event",
      frame: { type: "command_output", text: "Usage for the original branch" },
    });
    const branch = { ...user, id: "other-branch" };
    const snapshot = {
      type: "snapshot" as const,
      session,
      journal: {
        sessionId: session.sessionId,
        sessionFile: ref.sessionFile,
        leafId: branch.id,
        entries: [branch],
        totalEntries: 1,
      },
    };
    feed = reduceNativeSessionFeed(feed, snapshot);
    expect(nativeTranscriptRows(feed, false).map((row) => row.id)).toEqual(["entry:other-branch"]);
    feed = reduceNativeSessionFeed(feed, {
      ...snapshot,
      journal: { ...snapshot.journal, leafId: user.id, entries: [user] },
    });
    expect(nativeTranscriptRows(feed, false).map((row) => row.id)).toEqual([
      "entry:user-a",
      "command:0",
    ]);
    feed = reduceNativeSessionFeed(feed, {
      ...snapshot,
      session: { ...session, sessionId: "replacement" },
      journal: { ...snapshot.journal, sessionId: "replacement", leafId: user.id, entries: [user] },
    });
    expect(nativeTranscriptRows(feed, false).map((row) => row.id)).toEqual(["entry:user-a"]);
  });

  it("recovers missed persistence from an idle snapshot without matching message content", () => {
    let feed = initial();
    const message = { role: "assistant", content: "Identical text is not an identity" };
    for (const messageId of ["finished-live", "unmatched-live"]) {
      feed = reduceNativeSessionFeed(feed, {
        type: "event",
        frame: { type: "message_update", messageId, message },
      });
    }
    feed = reduceNativeSessionFeed(feed, { type: "disconnected" });
    const reply = { ...user, id: "finished-entry", parentId: user.id, message };
    const identity = {
      sessionId: session.sessionId,
      sessionFile: ref.sessionFile,
      leafId: reply.id,
    };
    feed = reduceNativeSessionFeed(feed, {
      type: "snapshot",
      session: { ...session, state: { isStreaming: false } },
      journal: { ...identity, entries: [user, reply], totalEntries: 2 },
    });
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: {
        type: "journal_state",
        reason: "snapshot",
        ...identity,
        messageEntryIds: [{ messageId: "finished-live", entryId: reply.id }],
      },
    });
    expect(feed.conversation.pending).toEqual([{ messageId: "unmatched-live", message }]);
    expect(nativeTranscriptEntries(feed.conversation, false).map((entry) => entry.id)).toEqual([
      user.id,
      reply.id,
      "live:unmatched-live",
    ]);
    expect(feed.busy).toBe(false);
  });

  it("retains recovery associations until their durable entries arrive on an older page", () => {
    const message = { role: "assistant", content: "Finished before newer turns" };
    let feed = reduceNativeSessionFeed(initial(), {
      type: "event",
      frame: {
        type: "message_update",
        messageId: "missed-live",
        message,
      },
    });
    const reply = { ...user, id: "missed-entry", parentId: user.id, message };
    const latest = { ...user, id: "latest-entry", parentId: reply.id };
    const identity = {
      sessionId: session.sessionId,
      sessionFile: ref.sessionFile,
      leafId: latest.id,
    };
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: {
        type: "journal_state",
        reason: "snapshot",
        ...identity,
        messageEntryIds: [{ messageId: "missed-live", entryId: reply.id }],
      },
    });
    expect(feed.conversation.pending).toEqual([{ messageId: "missed-live", message }]);
    feed = reduceNativeSessionFeed(feed, {
      type: "snapshot",
      session,
      journal: { ...identity, entries: [latest], totalEntries: 3, nextCursor: "older" },
    });
    expect(feed.conversation.pending).toEqual([{ messageId: "missed-live", message }]);
    feed = reduceNativeSessionFeed(feed, {
      type: "page",
      older: true,
      revision: feed.conversation.revision,
      page: { ...identity, entries: [user, reply], totalEntries: 3 },
    });
    expect(feed.conversation.pending).toEqual([]);
    expect(feed.conversation.entries.map((entry) => entry.id)).toEqual([
      user.id,
      reply.id,
      latest.id,
    ]);
  });

  it("does not infer discarded output from an absent or empty recovery window", () => {
    const message = { role: "assistant", content: "Retained output" };
    const seeded = reduceNativeSessionFeed(initial(), {
      type: "event",
      frame: {
        type: "message_update",
        messageId: "outside-window",
        message,
      },
    });
    for (const recovery of [{}, { messageEntryIds: [] }]) {
      const feed = reduceNativeSessionFeed(seeded, {
        type: "event",
        frame: {
          type: "journal_state",
          reason: "snapshot",
          sessionId: session.sessionId,
          sessionFile: ref.sessionFile,
          leafId: user.id,
          ...recovery,
        },
      });
      expect(feed.conversation.pending).toEqual([{ messageId: "outside-window", message }]);
    }
    const otherFile = reduceNativeSessionFeed(seeded, {
      type: "event",
      frame: {
        type: "journal_state",
        reason: "snapshot",
        sessionId: session.sessionId,
        sessionFile: "/sessions/another.jsonl",
        leafId: user.id,
        messageEntryIds: [{ messageId: "outside-window", entryId: user.id }],
      },
    });
    expect(otherFile.conversation.pending).toEqual([{ messageId: "outside-window", message }]);
    expect(otherFile.conversation.persisted.has("outside-window")).toBe(false);
  });

  it("uses snapshot recovery IDs without rewinding an already hydrated leaf", () => {
    const message = { role: "assistant", content: "Finished" };
    let feed = reduceNativeSessionFeed(initial(), {
      type: "event",
      frame: {
        type: "message_update",
        messageId: "finished-live",
        message,
      },
    });
    const reply = { ...user, id: "finished-entry", parentId: user.id, message };
    const identity = {
      sessionId: session.sessionId,
      sessionFile: ref.sessionFile,
      leafId: reply.id,
    };
    feed = reduceNativeSessionFeed(feed, {
      type: "snapshot",
      session,
      journal: { ...identity, entries: [user, reply], totalEntries: 2 },
    });
    const entries = feed.conversation.entries;
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: {
        type: "journal_state",
        reason: "snapshot",
        ...identity,
        leafId: user.id,
        messageEntryIds: [{ messageId: "finished-live", entryId: reply.id }],
      },
    });
    expect(feed.conversation.identity?.leafId).toBe(reply.id);
    expect(feed.conversation.entries).toBe(entries);
    expect(feed.conversation.pending).toEqual([]);
  });

  it("retains durable and live content across disconnect and unavailable hydration", () => {
    let feed = reduceNativeSessionFeed(initial(), {
      type: "event",
      frame: {
        type: "message_update",
        messageId: "live-a",
        message: { role: "assistant", content: "Still working" },
      },
    });
    const conversation = feed.conversation;
    feed = reduceNativeSessionFeed(feed, { type: "disconnected" });
    expect(feed.connected).toBe(false);
    expect(feed.conversation).toBe(conversation);
    feed = reduceNativeSessionFeed(feed, { type: "snapshot", session, journal: null });
    expect(nativeTranscriptEntries(feed.conversation, false).map((entry) => entry.message)).toEqual(
      [user.message, { role: "assistant", content: "Still working" }],
    );
  });

  it("continues live updates between a native leaf notification and its durable entry", () => {
    let feed = initial();
    const identity = {
      sessionId: session.sessionId,
      sessionFile: ref.sessionFile,
      leafId: "assistant-b",
    };
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: { type: "journal_state", reason: "leaf", ...identity },
    });
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: {
        type: "message_update",
        messageId: "live-b",
        message: { role: "assistant", content: "Answer" },
      },
    });
    expect(feed.conversation.pending[0]?.message.content).toBe("Answer");
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: {
        type: "message_persisted",
        ...identity,
        messageId: "live-b",
        entryId: "assistant-b",
      },
    });
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: {
        type: "journal_entry",
        ...identity,
        entry: {
          ...user,
          id: "assistant-b",
          parentId: user.id,
          message: { role: "assistant", content: "Answer" },
        },
      },
    });
    expect(feed.conversation.entries.map((entry) => entry.id)).toEqual(["user-a", "assistant-b"]);
    expect(feed.conversation.pending).toEqual([]);
  });

  it("does not retire pending messages from a pre-turn idle state on reconnect", () => {
    let feed = reduceNativeSessionFeed(initial(), {
      type: "event",
      frame: {
        type: "message_update",
        messageId: "reply-live",
        message: { role: "assistant", content: "Partial reply" },
      },
    });
    feed = reduceNativeSessionFeed(feed, { type: "disconnected" });
    feed = reduceNativeSessionFeed(feed, {
      type: "snapshot",
      session: { ...session, state: { isStreaming: false } },
      journal: {
        sessionId: session.sessionId,
        sessionFile: ref.sessionFile,
        leafId: user.id,
        entries: [user],
        totalEntries: 1,
      },
    });
    expect(nativeTranscriptEntries(feed.conversation, false).map((entry) => entry.message)).toEqual(
      [user.message, { role: "assistant", content: "Partial reply" }],
    );
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: {
        type: "message_start",
        snapshot: true,
        sessionId: session.sessionId,
        sessionFile: ref.sessionFile,
        leafId: user.id,
        messageId: "reply-live",
        message: { role: "assistant", content: "Reconnected reply" },
      },
    });
    expect(feed.conversation.pending).toEqual([
      { messageId: "reply-live", message: { role: "assistant", content: "Reconnected reply" } },
    ]);
    expect(feed.busy).toBe(true);
  });

  it("reconciles persisted IDs without dropping unrelated pending messages on a stream snapshot", () => {
    let feed = initial();
    for (const [messageId, content] of [
      ["reply-done", "Finished"],
      ["reply-next", "Working"],
    ]) {
      feed = reduceNativeSessionFeed(feed, {
        type: "event",
        frame: {
          type: "message_update",
          messageId,
          message: { role: "assistant", content },
        },
      });
    }
    const reply = {
      ...user,
      id: "reply-entry",
      parentId: user.id,
      message: { role: "assistant", content: "Finished" },
    };
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: {
        type: "message_persisted",
        sessionId: session.sessionId,
        sessionFile: ref.sessionFile,
        leafId: reply.id,
        messageId: "reply-done",
        entryId: reply.id,
      },
    });
    feed = reduceNativeSessionFeed(feed, {
      type: "snapshot",
      session,
      journal: {
        sessionId: session.sessionId,
        sessionFile: ref.sessionFile,
        leafId: reply.id,
        entries: [user, reply],
        totalEntries: 2,
      },
    });
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: {
        type: "message_start",
        snapshot: true,
        messageId: "reply-next",
        message: { role: "assistant", content: "Still working" },
      },
    });
    expect(nativeTranscriptEntries(feed.conversation, false).map((entry) => entry.message)).toEqual(
      [user.message, reply.message, { role: "assistant", content: "Still working" }],
    );
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: {
        type: "message_start",
        snapshot: true,
        messageId: "reply-done",
        message: reply.message,
      },
    });
    expect(feed.conversation.pending.map((message) => message.messageId)).toEqual(["reply-next"]);
  });

  it("rejects an older hydration response after a newer durable append", () => {
    let feed = initial();
    const identity = {
      sessionId: session.sessionId,
      sessionFile: ref.sessionFile,
      leafId: "reply-entry",
    };
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: { type: "journal_state", reason: "leaf", ...identity },
    });
    const revision = feed.conversation.revision;
    const reply = {
      ...user,
      id: identity.leafId,
      parentId: user.id,
      message: { role: "assistant", content: "Durable" },
    };
    const page: NeoPiJournalPage = { ...identity, entries: [user, reply], totalEntries: 2 };
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: { type: "journal_entry", ...identity, entry: reply },
    });
    const latest = { ...reply, id: "latest-entry", parentId: reply.id };
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: { type: "journal_entry", ...identity, leafId: latest.id, entry: latest },
    });
    const durable = feed.conversation;
    feed = reduceNativeSessionFeed(feed, { type: "page", page, revision, identity, older: false });
    expect(feed.conversation).toBe(durable);
    expect(feed.conversation.entries.map((entry) => entry.id)).toEqual([
      user.id,
      reply.id,
      latest.id,
    ]);
    expect(feed.conversation.needsSnapshot).toBe(false);
  });

  it("does not let an older reconnect boundary move a hydrated leaf backwards", () => {
    let feed = initial();
    const identity = {
      sessionId: session.sessionId,
      sessionFile: ref.sessionFile,
      leafId: "reply-entry",
    };
    const reply = { ...user, id: identity.leafId, parentId: user.id };
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: { type: "journal_entry", ...identity, entry: reply },
    });
    const conversation = feed.conversation;
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: {
        type: "journal_state",
        reason: "snapshot",
        ...identity,
        leafId: user.id,
      },
    });
    expect(feed.conversation).toBe(conversation);
    expect(feed.conversation.identity?.leafId).toBe(reply.id);
  });

  it("rejects branch pages from a different leaf and stale older-page cursors", () => {
    let feed = initial();
    const identity = feed.conversation.identity!;
    const revision = feed.conversation.revision;
    const page: NeoPiJournalPage = {
      ...identity,
      sessionFile: ref.sessionFile,
      leafId: "other-leaf",
      entries: [user],
      totalEntries: 1,
      nextCursor: "wrong-branch",
    };
    const conversation = feed.conversation;
    feed = reduceNativeSessionFeed(feed, { type: "page", page, revision, identity, older: false });
    expect(feed.conversation).toBe(conversation);
    feed = reduceNativeSessionFeed(feed, {
      type: "page",
      page: { ...page, leafId: identity.leafId },
      revision: revision - 1,
      older: true,
    });
    expect(feed.conversation).toBe(conversation);
    feed = reduceNativeSessionFeed(feed, { type: "page", page, revision, older: true });
    expect(feed.conversation).toBe(conversation);
  });

  it("does not relabel cached content or the command ref when a terminal changes files", () => {
    let feed = initial();
    const conversation = feed.conversation;
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: {
        type: "journal_state",
        reason: "identity",
        sessionId: "other-session",
        sessionFile: "/sessions/other.jsonl",
        leafId: "other-entry",
      },
    });
    expect(feed.session?.ref).toEqual(ref);
    expect(feed.conversation).toBe(conversation);
    expect(feed.conversation.entries).toEqual([user]);
    expect(feed.connected).toBe(false);
    expect(feed.error).not.toBeNull();
  });

  it("follows a same-session move to a new file and keeps the transcript", () => {
    const moved = "/sessions/worktree/moved.jsonl";
    const feed = reduceNativeSessionFeed(initial(), {
      type: "event",
      frame: {
        type: "journal_state",
        reason: "identity",
        sessionId: session.sessionId,
        sessionFile: moved,
        leafId: user.id,
      },
    });
    expect(feed.movedTo).toEqual({ ...ref, sessionFile: moved });
    expect(feed.session?.ref).toEqual({ ...ref, sessionFile: moved });
    expect(feed.conversation.identity?.sessionFile).toBe(moved);
    expect(feed.conversation.entries).toEqual([user]);
    expect(feed.connected).toBe(true);
    expect(feed.error).toBeNull();
  });

  it("does not follow a move that carries a different session id", () => {
    const feed = reduceNativeSessionFeed(initial(), {
      type: "event",
      frame: {
        type: "journal_state",
        reason: "identity",
        sessionId: "someone-else",
        sessionFile: "/sessions/worktree/other.jsonl",
        leafId: user.id,
      },
    });
    expect(feed.movedTo).toBeNull();
    expect(feed.session?.ref).toEqual(ref);
    expect(feed.error).not.toBeNull();
  });

  it("resets the transcript and old dialogs when native replaces identity within the same file", () => {
    let feed = reduceNativeSessionFeed(initial(), {
      type: "event",
      frame: {
        type: "tool_approval_request",
        id: "old-approval",
        toolName: "bash",
      },
    });
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: {
        type: "message_update",
        messageId: "old-live",
        message: { role: "assistant", content: "Old session" },
      },
    });
    const identity = { sessionId: "replacement", sessionFile: ref.sessionFile, leafId: null };
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: { type: "journal_state", reason: "identity", ...identity },
    });
    expect(feed.session?.sessionId).toBe(identity.sessionId);
    expect(feed.session?.ref).toEqual(ref);
    expect(feed.conversation.entries).toEqual([]);
    expect(feed.conversation.pending).toEqual([]);
    expect(feed.dialogs).toEqual([]);
    expect(feed.busy).toBe(false);
    feed = reduceNativeSessionFeed(feed, {
      type: "page",
      revision: feed.conversation.revision,
      identity,
      older: false,
      page: { ...identity, entries: [], totalEntries: 0 },
    });
    expect(feed.conversation.identity).toMatchObject(identity);
    expect(feed.conversation.needsSnapshot).toBe(false);
  });

  it("does not clear a newer command error when branch reconciliation recovers", () => {
    let feed = reduceNativeSessionFeed(initial(), {
      type: "reconciliation",
      operation: "branch",
      error: "Branch read failed",
    });
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: { type: "prompt_result", status: "error", error: { message: "Prompt rejected" } },
    });
    feed = reduceNativeSessionFeed(feed, {
      type: "page",
      revision: feed.conversation.revision,
      older: false,
      page: {
        sessionId: session.sessionId,
        sessionFile: ref.sessionFile,
        leafId: user.id,
        entries: [user],
        totalEntries: 1,
      },
    });
    expect(feed.reconciliationError).toBeNull();
    expect(feed.error).toBe("Prompt rejected");
    expect(feed.conversation.entries).toEqual([user]);
  });

  it("preserves native approval payloads and removes only the native cancellation target", () => {
    const approval = {
      type: "tool_approval_request",
      id: "approval",
      toolCallId: "tool-1",
      toolName: "computer",
      args: { action: "publish" },
      tier: "exec",
      approvalMode: "ask",
      details: ["Publish"],
      safetyChecks: [{ id: "check-1", code: "confirmation", message: "Confirm publish" }],
      timeout: 600_000,
    };
    const plan = {
      type: "plan_proposal_request",
      id: "plan",
      title: "Proposal",
      planFilePath: "/plans/proposal.md",
      planMarkdown: "Plan",
    };
    let feed = reduceNativeSessionFeed(initial(), { type: "event", frame: approval });
    feed = reduceNativeSessionFeed(feed, { type: "event", frame: plan });
    feed = reduceNativeSessionFeed(feed, { type: "event", frame: approval });
    expect(feed.dialogs).toEqual([plan, approval]);
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: { type: "tool_approval_cancel", id: "new-cancel-id", targetId: approval.id },
    });
    expect(feed.dialogs).toEqual([plan]);
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: { type: "plan_proposal_cancel", id: plan.id, reason: "mode_change" },
    });
    expect(feed.dialogs).toEqual([]);
  });

  it("clears answered approval IDs without answering another native dialog", () => {
    const approval = { type: "tool_approval_request", id: "approval", toolName: "bash" };
    const plan = { type: "plan_proposal_request", id: "plan", title: "Review" };
    let feed = reduceNativeSessionFeed(initial(), { type: "event", frame: approval });
    feed = reduceNativeSessionFeed(feed, { type: "event", frame: plan });
    feed = reduceNativeSessionFeed(feed, { type: "answered", id: approval.id });
    expect(feed.dialogs).toEqual([plan]);
    feed = reduceNativeSessionFeed(feed, { type: "answered", id: plan.id });
    expect(feed.dialogs).toEqual([]);
  });

  it.each([
    ["disconnected", true],
    ["disconnected", false],
    ["closed", true],
    ["closed", false],
  ] as const)(
    "%s drops obsolete dialogs while preserving pending replay (replay first: %s)",
    (type, replayFirst) => {
      const answered = {
        type: "tool_approval_request",
        id: "answered-elsewhere",
        toolName: "bash",
      };
      const cancelled = { type: "plan_proposal_request", id: "cancelled-elsewhere", title: "Plan" };
      const pending = {
        type: "extension_ui_request",
        id: "still-pending",
        method: "input",
        title: "Name",
      };
      let feed = initial();
      for (const frame of [answered, cancelled, pending])
        feed = reduceNativeSessionFeed(feed, { type: "event", frame });
      expect(feed.dialogs).toEqual([answered, cancelled, pending]);

      feed = reduceNativeSessionFeed(
        feed,
        type === "closed" ? { type, reason: "Connection closed." } : { type },
      );
      expect(feed.dialogs).toEqual([]);
      const snapshot = { type: "snapshot", session, journal: null } as const;
      const replay = { type: "event", frame: pending } as const;
      for (const update of replayFirst ? [replay, snapshot] : [snapshot, replay])
        feed = reduceNativeSessionFeed(feed, update);

      expect(feed.connected).toBe(true);
      expect(feed.dialogs).toEqual([pending]);
      expect(feed.conversation.entries).toEqual([user]);
    },
  );

  it("keeps bookkeeping inspectable without adding it to ordinary conversation", () => {
    const feed = initial();
    const entries = [
      user,
      { ...user, id: "model", type: "model_change" },
      { ...user, id: "digest", type: "custom", customType: "system-prompt-digest" },
      { ...user, id: "tool", message: { role: "toolResult", content: "Tool output" } },
    ];
    const conversation = { ...feed.conversation, entries };
    expect(nativeTranscriptEntries(conversation, false).map((entry) => entry.id)).toEqual([
      "user-a",
      "tool",
    ]);
    expect(nativeTranscriptEntries(conversation, true)).toEqual(entries);
  });

  it("does not share cache identity across configured profiles or environments", () => {
    const target = { environmentId: "host-a" as import("@t3tools/contracts").EnvironmentId, ref };
    expect(nativeSessionKey(target)).not.toBe(
      nativeSessionKey({
        ...target,
        ref: { ...ref, providerInstanceId: ProviderInstanceId.make("other-profile") },
      }),
    );
    expect(nativeSessionKey(target)).not.toBe(
      nativeSessionKey({
        ...target,
        environmentId: "host-b" as import("@t3tools/contracts").EnvironmentId,
      }),
    );
  });

  it("isolates agent inventory by profile, canonical file, identity and reconnect epoch", () => {
    let feed = initial();
    const inventory = {
      type: "subagents" as const,
      ref,
      sessionId: session.sessionId,
      epoch: feed.agentsEpoch,
      revision: feed.agentsRevision,
      agents: [{ id: "worker", status: "running", agent: "scout", index: 0 }],
    };
    feed = reduceNativeSessionFeed(feed, inventory);
    expect(feed.agents[0]?.status).toBe("running");
    const original = feed.agents;
    for (const stale of [
      { ...inventory, sessionId: "other-session" },
      { ...inventory, ref: { ...ref, sessionFile: "/sessions/other.jsonl" } },
      { ...inventory, ref: { ...ref, providerInstanceId: ProviderInstanceId.make("other") } },
    ]) {
      feed = reduceNativeSessionFeed(feed, stale);
      expect(feed.agents).toBe(original);
    }
    feed = reduceNativeSessionFeed(feed, { type: "disconnected" });
    // Losing the stream does not stop the owner's agents.
    expect(feed.agents).toBe(original);
    feed = reduceNativeSessionFeed(feed, {
      type: "snapshot",
      session,
      journal: {
        sessionId: session.sessionId,
        sessionFile: ref.sessionFile,
        leafId: user.id,
        entries: [user],
        totalEntries: 1,
      },
    });
    // Even an id not previously observed cannot leak from an old connection.
    feed = reduceNativeSessionFeed(feed, {
      ...inventory,
      agents: [{ id: "stale-worker", status: "running" }],
    });
    expect(feed.agents.map((agent) => agent.id)).toEqual(["worker"]);
    expect(feed.agents).toBe(original);
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: {
        type: "journal_state",
        sessionId: "replacement",
        sessionFile: ref.sessionFile,
        leafId: null,
      },
    });
    expect(feed.agents).toEqual([]);
    expect(feed.conversation.entries).toEqual([]);
  });

  it("tracks NeoPi's prompt queue until the session closes", () => {
    let feed = reduceNativeSessionFeed(emptyNativeSessionFeed(), {
      type: "snapshot",
      session: {
        ...session,
        state: {
          isStreaming: true,
          queuedMessages: { steering: ["steer now"], followUp: [], liveSteered: 1 },
        },
      },
      journal: null,
    });
    expect(feed.queue).toEqual({ steering: ["steer now"], followUp: [], liveSteered: 1 });
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: { type: "queue_update", steering: [], followUp: ["after the run"], liveSteered: 0 },
    });
    expect(feed.queue).toEqual({ steering: [], followUp: ["after the run"], liveSteered: 0 });
    // A state read without a queue (older NeoPi) keeps the last known queue.
    feed = reduceNativeSessionFeed(feed, { type: "state", state: { isStreaming: true } });
    expect(feed.queue.followUp).toEqual(["after the run"]);
    feed = reduceNativeSessionFeed(feed, { type: "closed", reason: "gone" });
    expect(feed.queue).toEqual({ steering: [], followUp: [], liveSteered: 0 });
  });

  it("projects one native dictation capture and ignores stragglers", () => {
    const frame = (value: { type: string } & Record<string, unknown>) => ({
      type: "event" as const,
      frame: value,
    });
    let feed = initial();
    expect(feed.dictation).toBeNull();
    feed = reduceNativeSessionFeed(
      feed,
      frame({ type: "dictation_state", captureId: "a", state: "starting" }),
    );
    feed = reduceNativeSessionFeed(
      feed,
      frame({ type: "dictation_state", captureId: "a", state: "recording" }),
    );
    feed = reduceNativeSessionFeed(
      feed,
      frame({ type: "dictation_transcript", captureId: "a", text: "hello wor" }),
    );
    expect(feed.dictation).toEqual({
      captureId: "a",
      phase: "recording",
      text: "hello wor",
      error: null,
    });
    // A preview replaces the previous one, and another capture's frames are not ours.
    feed = reduceNativeSessionFeed(
      feed,
      frame({ type: "dictation_transcript", captureId: "b", text: "intruder" }),
    );
    feed = reduceNativeSessionFeed(
      feed,
      frame({ type: "dictation_state", captureId: "a", state: "transcribing" }),
    );
    expect(feed.dictation).toMatchObject({ phase: "transcribing", text: "hello wor" });
    feed = reduceNativeSessionFeed(
      feed,
      frame({ type: "dictation_end", captureId: "a", text: "hello world" }),
    );
    expect(feed.dictation).toEqual({
      captureId: "a",
      phase: "ended",
      text: "hello world",
      error: null,
    });
    // Nothing revives a finished capture; the next capture starts with its state frame.
    feed = reduceNativeSessionFeed(
      feed,
      frame({ type: "dictation_transcript", captureId: "a", text: "late" }),
    );
    expect(feed.dictation?.text).toBe("hello world");
    feed = reduceNativeSessionFeed(
      feed,
      frame({ type: "dictation_state", captureId: "b", state: "starting" }),
    );
    expect(feed.dictation).toEqual({ captureId: "b", phase: "starting", text: "", error: null });
    feed = reduceNativeSessionFeed(
      feed,
      frame({
        type: "dictation_end",
        captureId: "b",
        text: "",
        error: "Speech-to-text is disabled",
      }),
    );
    expect(feed.dictation).toMatchObject({ phase: "ended", error: "Speech-to-text is disabled" });
  });

  it("ends a live dictation capture when the native connection closes", () => {
    let feed = reduceNativeSessionFeed(initial(), {
      type: "event",
      frame: { type: "dictation_state", captureId: "a", state: "recording" },
    });
    feed = reduceNativeSessionFeed(feed, {
      type: "closed",
      reason: "The native connection closed.",
    });
    expect(feed.dictation).toMatchObject({
      captureId: "a",
      phase: "ended",
      error: "The native connection closed.",
    });
  });

  describe("owner loss", () => {
    it("keeps a feed connected but idle while a terminal owner is replaced, then clears on its snapshot", () => {
      const live = initial();
      expect(live.busy).toBe(true);
      let feed = reduceNativeSessionFeed(live, { type: "reconnecting", reason: "exited (0)" });
      expect(feed).toMatchObject({
        connected: true,
        ownerLoss: "reconnecting",
        busy: false,
        dialogs: [],
        error: null,
      });
      expect(feed.queue).toEqual({ steering: [], followUp: [], liveSteered: 0 });
      expect(feed.activity.openedAt).toBeNull();

      feed = reduceNativeSessionFeed(feed, {
        type: "snapshot",
        session: live.session!,
        journal: null,
      });
      expect(feed).toMatchObject({ connected: true, ownerLoss: null, error: null });
    });

    it("reads a detach and an exited terminal as states, not errors", () => {
      const detached = reduceNativeSessionFeed(initial(), {
        type: "closed",
        reason: "The native connection was explicitly closed.",
        code: "detached",
      });
      expect(detached).toMatchObject({ connected: false, ownerLoss: "detached", error: null });
      const orphaned = reduceNativeSessionFeed(
        reduceNativeSessionFeed(initial(), { type: "reconnecting", reason: "x" }),
        {
          type: "closed",
          reason: "No NeoPi is running this session now.",
          code: "owner_exited",
        },
      );
      expect(orphaned).toMatchObject({ connected: false, ownerLoss: "orphaned", error: null });
      // A restarted observation begins with `disconnected`; the state stands until a snapshot.
      expect(reduceNativeSessionFeed(orphaned, { type: "disconnected" }).ownerLoss).toBe(
        "orphaned",
      );
    });

    it("still reports an unexpected close as an error", () => {
      const feed = reduceNativeSessionFeed(initial(), {
        type: "closed",
        reason: "Profile replaced",
      });
      expect(feed).toMatchObject({ connected: false, ownerLoss: null, error: "Profile replaced" });
    });
  });

  it("accumulates working time across turns and closes the window with the connection", () => {
    const frame = (type: string) => ({ type: "event" as const, frame: { type } });
    // The snapshot's state is streaming, so the first window is already open.
    let feed = initial();
    expect(feed.activity.openedAt).not.toBeNull();
    feed = reduceNativeSessionFeed(feed, frame("agent_end"));
    expect(feed.activity.openedAt).toBeNull();
    const idle = feed.activity.accumulatedMs;
    feed = reduceNativeSessionFeed(feed, frame("agent_start"));
    expect(feed.activity.openedAt).not.toBeNull();
    feed = reduceNativeSessionFeed(feed, { type: "disconnected" });
    expect(feed.activity.openedAt).toBeNull();
    expect(feed.activity.accumulatedMs).toBeGreaterThanOrEqual(idle);
  });

  it("clears a failed prompt's banner when the next turn starts, but keeps a failed read", () => {
    const failedPrompt = {
      type: "event" as const,
      frame: { type: "prompt_result", status: "error", error: { message: "404 no endpoints" } },
    };
    let feed = reduceNativeSessionFeed(initial(), failedPrompt);
    expect(feed.error).toBe("404 no endpoints");
    feed = reduceNativeSessionFeed(feed, { type: "event", frame: { type: "agent_start" } });
    expect(feed.error).toBeNull();
    feed = reduceNativeSessionFeed(feed, {
      type: "reconciliation",
      operation: "state",
      error: "State read failed",
    });
    feed = reduceNativeSessionFeed(feed, { type: "event", frame: { type: "agent_start" } });
    expect(feed.error).toBe("State read failed");
  });

  it("adopts NeoPi's reported active time and restarts it for another session", () => {
    let feed = reduceNativeSessionFeed(initial(), {
      type: "state",
      state: { activeTimeMs: 90_000, isStreaming: false },
    });
    expect(feed.activity.accumulatedMs).toBe(90_000);
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: {
        type: "journal_state",
        sessionFile: ref.sessionFile,
        sessionId: "another-session",
        leafId: null,
      },
    });
    expect(feed.activity).toEqual({ accumulatedMs: 0, openedAt: null });
    expect(feed.jobs.entries).toEqual([]);
  });

  it("tracks background job frames and reads an inventory for the same session only", () => {
    const registered = {
      id: "bg_1",
      type: "bash",
      label: "sleep 60",
      status: "running",
      startedAt: 1_000,
      outputBytes: 0,
    };
    let feed = reduceNativeSessionFeed(initial(), {
      type: "event",
      frame: { type: "job_lifecycle", event: "registered", job: registered, runningCount: 1 },
    });
    expect(feed.jobs.entries.map((job) => job.id)).toEqual(["bg_1"]);
    expect(feed.jobs.runningCount).toBe(1);
    const stale = reduceNativeSessionFeed(feed, {
      type: "jobs",
      ref,
      sessionId: "other-session",
      revision: 0,
      response: { running: [], recent: [], runningCount: 0 },
    });
    expect(stale).toBe(feed);
    feed = reduceNativeSessionFeed(feed, {
      type: "jobs",
      ref,
      sessionId: session.sessionId,
      revision: feed.jobs.revision,
      response: { running: [], recent: [], runningCount: 0 },
    });
    expect(feed.jobs.entries).toEqual([]);
  });
});

describe("native slash commands", () => {
  it("offers NeoPi's own list with hints, aliases and terminal-only marks", () => {
    const commands = nativeSlashCommands({
      commands: [
        {
          name: "personality",
          description: "Switch personality",
          input: { hint: "<name>" },
          source: "builtin",
          availability: "tui",
        },
        { name: "usage", aliases: ["u"], availability: "headless", source: "skill" },
        { name: " " },
        "garbage",
      ],
    });
    expect(commands).toEqual([
      {
        name: "personality",
        description: "Switch personality",
        input: { hint: "<name>" },
        source: "builtin",
        availability: "tui",
      },
      { name: "usage", aliases: ["u"] },
    ]);
    expect(nativeCommandNeedsTerminal(commands[0]!, "owned")).toBe(true);
    expect(nativeCommandNeedsTerminal(commands[0]!, "terminal")).toBe(false);
    expect(nativeCommandNeedsTerminal(commands[1]!, "owned")).toBe(false);
  });

  it("finds the argument of a command at the start of the draft", () => {
    expect(nativeSlashArgument("/personality An")).toEqual({
      command: "personality",
      prefix: "An",
      start: 13,
    });
    expect(nativeSlashArgument("/personality ")?.prefix).toBe("");
    expect(nativeSlashArgument("/personality An", 5)).toBeNull();
    expect(nativeSlashArgument("/personality")).toBeNull();
    expect(nativeSlashArgument("/tmp/x y")).toBeNull();
    expect(nativeSlashArgument("say /personality An")).toBeNull();
    expect(nativeSlashArgument("/personality An\nmore")).toBeNull();
  });

  it("drops the completion the argument already spells", () => {
    expect(
      nativeCommandCompletions(
        {
          items: [
            { value: "Angel", label: "Angel" },
            { value: "Angela", label: "Angela", description: "Warm", submitsCommand: true },
            { label: "no value" },
          ],
        },
        "Angel",
      ),
    ).toEqual([{ value: "Angela", label: "Angela", description: "Warm", submitsCommand: true }]);
  });

  it("counts command list announcements so readers re-request the list", () => {
    const feed = reduceNativeSessionFeed(initial(), {
      type: "event",
      frame: { type: "available_commands_update", commands: [] },
    });
    expect(feed.commandsRevision).toBe(initial().commandsRevision + 1);
  });
});

describe("subagent roster knowledge", () => {
  it("is unknown until the live inventory is read, and unknown again when the owner closes", () => {
    let feed = initial();
    expect(feed.agentsKnown).toBe(false);
    feed = reduceNativeSessionFeed(feed, {
      type: "subagents",
      ref,
      sessionId: session.sessionId,
      epoch: feed.agentsEpoch,
      revision: feed.agentsRevision,
      agents: [],
    });
    expect(feed.agentsKnown).toBe(true);
    expect(feed.agents).toEqual([]);
    // A lost stream keeps the last roster; only a close resets it.
    expect(reduceNativeSessionFeed(feed, { type: "disconnected" }).agentsKnown).toBe(true);
    expect(
      reduceNativeSessionFeed(feed, { type: "closed", reason: "gone", code: "owner_exited" })
        .agentsKnown,
    ).toBe(false);
  });
});

describe("observation rebase", () => {
  const domain = (
    overrides: Partial<NeoPiNativeObservationDomain> = {},
  ): NeoPiNativeObservationDomain => ({
    serverIncarnation: "server-1",
    ownerEpoch: 1,
    projectionIncarnation: 1,
    buildAttempt: 1,
    branchGeneration: 1,
    ...overrides,
  });
  const cursorAt = (epoch: NeoPiNativeObservationDomain, base: number) => ({
    epoch,
    base,
    pass: null,
    inboxSeq: 0,
    journalAt: null,
  });
  /** One read reply; `done` completes the pass at `watermark`. */
  const read = (input: {
    epoch: NeoPiNativeObservationDomain;
    passId: string;
    kind?: "incremental" | "full";
    watermark: number;
    done?: boolean;
    entities?: readonly NeoPiNativeEntity[];
    tombstones?: readonly NeoPiNativeTombstone[];
    journal?: NeoPiNativeJournalSlice;
  }) => {
    const kind = input.kind ?? "full";
    const done = input.done ?? true;
    return {
      type: "read" as const,
      result: {
        type: "pass" as const,
        passId: input.passId,
        kind,
        baseCursor: cursorAt(input.epoch, 0),
        coveredThrough: input.watermark,
        continuation: {
          ...cursorAt(input.epoch, done ? input.watermark : 0),
          pass: done
            ? null
            : {
                kind,
                passId: input.passId,
                watermark: input.watermark,
                lastOrdinal: 1000,
                afterKey: "cut",
                segment: null,
              },
        },
        complete: false,
        promoted: false,
        entities: input.entities ?? [],
        tombstones: input.tombstones ?? [],
        segments: [],
        inbox: [],
        journal: input.journal ?? null,
      },
    };
  };
  const journalEntry = (
    id: string,
    parentId: string | null,
    content: unknown = id,
  ): NeoPiJournalEntry => ({
    id,
    parentId,
    type: "message",
    timestamp: "2026-11-18T00:00:00Z",
    message: { role: "assistant", content },
  });
  const chain = (ids: readonly string[], parentId: string | null) =>
    ids.map((id, index) => journalEntry(id, index ? ids[index - 1]! : parentId));
  const horizon = (
    entries: readonly NeoPiJournalEntry[],
    nextCursor?: string,
  ): NeoPiNativeJournalSlice => ({
    continuity: "horizon",
    leafId: entries.at(-1)?.id ?? null,
    entries,
    ...(nextCursor ? { nextCursor } : {}),
  });
  let ordinal = 0;
  const message = (
    messageId: string,
    revision: number,
    entryId: string | null,
    content: unknown = "live text",
  ): NeoPiNativeEntity => ({
    key: `message:${messageId}`,
    ordinal: (ordinal += 1),
    revision,
    value: {
      class: "message",
      messageId,
      phase: entryId === null ? "open" : "durable",
      entryId,
      message: { role: "assistant", content },
    },
  });
  const roster = (id: string, revision: number, status = "running"): NeoPiNativeEntity => ({
    key: `roster:${id}`,
    ordinal: id.charCodeAt(0),
    revision,
    value: { class: "roster", value: { id, status } },
  });
  const observing = (): NativeSessionFeed => ({
    ...emptyNativeSessionFeed(),
    session,
    connected: true,
  });
  const ids = (feed: NativeSessionFeed) => feed.conversation.entries.map((entry) => entry.id);
  const older = (feed: NativeSessionFeed, entries: readonly NeoPiJournalEntry[], next?: string) =>
    reduceNativeSessionFeed(feed, {
      type: "page",
      older: true,
      revision: feed.conversation.revision,
      page: {
        sessionId: session.sessionId,
        sessionFile: ref.sessionFile,
        leafId: feed.conversation.cursorLeaf,
        entries,
        totalEntries: 100,
        ...(next ? { nextCursor: next } : {}),
      },
    });

  it("keeps the history being read and leaves a placeholder for a gap larger than one page", () => {
    const epoch = domain();
    let feed = reduceNativeSessionFeed(
      observing(),
      read({
        epoch,
        passId: "p1",
        watermark: 5,
        journal: horizon(chain(["e0", "e1", "e2"], null)),
      }),
    );
    // The viewport sits on e1 while the view falls behind by more than a page.
    const viewport = feed.conversation.entries[1];
    feed = reduceNativeSessionFeed(
      feed,
      read({
        epoch,
        passId: "p2",
        watermark: 40,
        journal: horizon(chain(["e9", "e10"], "e8"), "before-e9"),
      }),
    );
    expect(ids(feed)).toEqual(["e0", "e1", "e2", "e9", "e10"]);
    expect(feed.conversation.entries[1]).toBe(viewport);
    expect([...nativeConversationGaps(feed.conversation)]).toEqual(["e9"]);
    expect(feed.conversation.cursor).toBe("before-e9");

    // On demand, page by page, the placeholder fills and closes where it joins.
    feed = older(feed, chain(["e6", "e7", "e8"], "e5"), "before-e6");
    expect([...nativeConversationGaps(feed.conversation)]).toEqual(["e6"]);
    feed = older(feed, chain(["e2", "e3", "e4", "e5"], "e1"));
    expect(ids(feed)).toEqual(["e0", "e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10"]);
    expect(nativeConversationGaps(feed.conversation).size).toBe(0);
    expect(feed.conversation.entries[1]).toBe(viewport);

    // A navigation keeps only the shared ancestry; no placeholder joins branches.
    feed = reduceNativeSessionFeed(
      feed,
      read({
        epoch: domain({ branchGeneration: 2 }),
        passId: "p3",
        watermark: 50,
        journal: horizon([journalEntry("e1", "e0"), journalEntry("x2", "e1")]),
      }),
    );
    expect(ids(feed)).toEqual(["e0", "e1", "x2"]);
  });

  it("keeps a live row and its output anchor until the durable entry joins, across a rebuild", () => {
    const toolCall = [{ type: "toolCall", id: "tool-1", name: "read" }];
    const toolAt = (revision: number, status: string): NeoPiNativeEntity => ({
      key: "tool:tool-1",
      ordinal: 900,
      revision,
      value: { class: "tool", toolCallId: "tool-1", coverage: "since-build", state: { status } },
    });
    const tool = toolAt(6, "running");
    const user = journalEntry("u", null);
    let feed = reduceNativeSessionFeed(
      observing(),
      read({
        epoch: domain(),
        passId: "p1",
        watermark: 6,
        journal: horizon([user]),
        entities: [message("m1", 5, null, toolCall), tool],
      }),
    );
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: { type: "command_output", text: "output after the reply" },
    });
    const replyRows = (value: NativeSessionFeed) =>
      nativeTranscriptRows(value, false).flatMap((row) =>
        row.kind === "entry" && row.entry.message !== undefined
          ? [row.entry.id]
          : row.kind === "command"
            ? ["command"]
            : [],
      );
    expect(replyRows(feed)).toEqual(["u", "live:m1", "command"]);

    // The observation connection was replaced: revisions restart in a new domain.
    const rebuilt = domain({ projectionIncarnation: 2 });
    feed = reduceNativeSessionFeed(
      feed,
      read({
        epoch: rebuilt,
        passId: "q",
        watermark: 4,
        done: false,
        entities: [message("m1", 3, "r", toolCall)],
      }),
    );
    // The alias alone retires nothing; the tool is not dropped mid-pass.
    expect(replyRows(feed)).toEqual(["u", "live:m1", "command"]);
    expect(feed.observation.entities.get("tool:tool-1")?.value).toEqual(tool.value);

    feed = reduceNativeSessionFeed(
      feed,
      read({
        epoch: rebuilt,
        passId: "q",
        watermark: 4,
        journal: horizon([user, journalEntry("r", "u", toolCall)]),
        entities: [toolAt(4, "done")],
      }),
    );
    expect(replyRows(feed)).toEqual(["u", "r", "command"]);
    expect(feed.conversation.losses).toEqual([]);
    expect(feed.conversation.entries.at(-1)?.message).toEqual({
      role: "assistant",
      content: toolCall,
    });
    expect(feed.observation.entities.get("tool:tool-1")?.revision).toBe(4);
  });

  it("does not show agents as interrupted when the stream is lost or the view rebuilds", () => {
    let feed = reduceNativeSessionFeed(initial(), {
      type: "subagents",
      ref,
      sessionId: session.sessionId,
      epoch: initial().agentsEpoch,
      revision: initial().agentsRevision,
      agents: [{ id: "worker", status: "running", agent: "scout", index: 0 }],
    });
    feed = reduceNativeSessionFeed(feed, { type: "disconnected" });
    feed = reduceNativeSessionFeed(feed, {
      type: "snapshot",
      session,
      journal: {
        sessionId: session.sessionId,
        sessionFile: ref.sessionFile,
        leafId: user.id,
        entries: [user],
        totalEntries: 1,
      },
    });
    expect(feed.agents.map((agent) => [agent.status, agent.native.disconnected])).toEqual([
      ["running", false],
    ]);

    // Read path: the roster is replaced by key only when the rebase pass completes.
    let observed = reduceNativeSessionFeed(
      observing(),
      read({
        epoch: domain(),
        passId: "p1",
        watermark: 9,
        entities: [roster("a", 8), roster("b", 9)],
      }),
    );
    const successor = domain({ projectionIncarnation: 2 });
    observed = reduceNativeSessionFeed(
      observed,
      read({
        epoch: successor,
        passId: "q",
        watermark: 3,
        done: false,
        entities: [roster("a", 2, "running")],
      }),
    );
    expect([...observed.observation.entities.keys()]).toEqual(["roster:a", "roster:b"]);
    expect(observed.observation.entities.get("roster:b")?.value).toEqual(roster("b", 9).value);
    observed = reduceNativeSessionFeed(
      observed,
      read({ epoch: successor, passId: "q", watermark: 3 }),
    );
    expect([...observed.observation.entities.keys()]).toEqual(["roster:a"]);
  });

  it("applies a multi-part rebase without deleting by absence or regressing a newer revision", () => {
    const epoch = domain();
    let feed = reduceNativeSessionFeed(
      observing(),
      read({
        epoch,
        passId: "p1",
        watermark: 10,
        journal: horizon([journalEntry("u", null)]),
        entities: [roster("a", 10), roster("b", 9), message("m1", 8, null, "body")],
      }),
    );
    // Behind the tombstone horizon: a full pass in the same domain, every key changing.
    feed = reduceNativeSessionFeed(
      feed,
      read({
        epoch,
        passId: "p2",
        watermark: 30,
        done: false,
        entities: [roster("a", 25), message("m1", 26, "r", "body")],
      }),
    );
    expect([...feed.observation.entities.keys()]).toEqual(["roster:a", "roster:b", "message:m1"]);
    expect(feed.conversation.pending.map((row) => row.messageId)).toEqual(["m1"]);
    // A value older than one already held does not regress it.
    feed = reduceNativeSessionFeed(
      feed,
      read({
        epoch,
        passId: "p2",
        watermark: 30,
        done: false,
        entities: [roster("a", 20, "stale")],
        journal: horizon([journalEntry("u", null), journalEntry("r", "u", "body")]),
      }),
    );
    expect(feed.observation.entities.get("roster:a")?.revision).toBe(25);
    // The durable entry joined with its alias: the body shows exactly once.
    expect(
      nativeTranscriptEntries(feed.conversation, false).filter(
        (entry) => nativeRecord(entry.message).content === "body",
      ),
    ).toHaveLength(1);
    feed = reduceNativeSessionFeed(
      feed,
      read({ epoch, passId: "p2", watermark: 30, entities: [roster("c", 31)] }),
    );
    // Completion removes `b`, which the pass did not return; never `a` or `c`.
    expect([...feed.observation.entities.keys()].sort()).toEqual([
      "message:m1",
      "roster:a",
      "roster:c",
    ]);
  });

  it("turns rows it cannot identify into continuity losses, never matching identical text", () => {
    const epoch = domain();
    let feed = reduceNativeSessionFeed(
      observing(),
      read({ epoch, passId: "p1", watermark: 1, journal: horizon([journalEntry("u", null)]) }),
    );
    // More live rows than the 256 recovery mappings, all with the same text.
    for (let index = 0; index < 300; index += 1)
      feed = reduceNativeSessionFeed(feed, {
        type: "event",
        frame: { type: "message_end", messageId: `m${index}`, message: { content: "same" } },
      });
    feed = reduceNativeSessionFeed(feed, {
      type: "event",
      frame: { type: "command_output", text: "after the last row" },
    });
    const durable = chain(
      Array.from({ length: 300 }, (_, index) => `d${index}`),
      "u",
    ).map((entry) => ({ ...entry, message: { content: "same" } }));
    feed = reduceNativeSessionFeed(
      feed,
      read({
        epoch: domain({ projectionIncarnation: 2 }),
        passId: "q",
        watermark: 4,
        journal: horizon([journalEntry("u", null), ...durable]),
      }),
    );
    expect(feed.conversation.pending).toEqual([]);
    expect(feed.conversation.losses).toHaveLength(300);
    expect(new Set(feed.conversation.losses.map((loss) => loss.afterEntryId))).toEqual(
      new Set(["d299"]),
    );
    expect(nativeTranscriptRows(feed, false).at(-1)).toMatchObject({ kind: "command" });
  });

  it("never carries the previous owner's message ids into the successor's", () => {
    let feed = reduceNativeSessionFeed(
      observing(),
      read({
        epoch: domain(),
        passId: "p1",
        watermark: 3,
        journal: horizon([journalEntry("u", null)]),
        entities: [message("saved", 2, "s", "saved"), message("m1", 3, null, "old owner")],
      }),
    );
    feed = reduceNativeSessionFeed(
      feed,
      read({
        epoch: domain({ ownerEpoch: 2, projectionIncarnation: 2 }),
        passId: "q",
        watermark: 2,
        journal: horizon([journalEntry("u", null), journalEntry("s", "u", "saved")]),
        entities: [message("m1", 2, null, "new owner")],
      }),
    );
    expect(feed.conversation.pending.map((row) => row.message.content)).toEqual(["new owner"]);
    // The identified row retired on its entry; the unidentified one reads from history.
    expect(feed.conversation.losses).toEqual([{ messageId: "m1", afterEntryId: "s" }]);
    expect(feed.conversation.persisted.size).toBe(0);
  });
});
