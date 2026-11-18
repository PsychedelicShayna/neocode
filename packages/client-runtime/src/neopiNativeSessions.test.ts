import { describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderInstanceId,
  type NeoPiJournalEntry,
  type NeoPiNativeEntity,
  type NeoPiNativeJournalSlice,
  type NeoPiNativeObservationDomain,
  type NeoPiNativeInboxRecord,
  type NeoPiNativeSegment,
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
  nativeSlashArgument,
  nativeSlashCommands,
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
/** A feed whose watch described the session. */
const initial = () =>
  reduceNativeSessionFeed(emptyNativeSessionFeed(), { type: "session", revision: 1, session });

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
    // A lost stream keeps the last roster; only a stopped owner resets it.
    expect(reduceNativeSessionFeed(feed, { type: "disconnected" }).agentsKnown).toBe(true);
    expect(
      reduceNativeSessionFeed(feed, { type: "lifecycle", revision: 2, state: "owner-stopped" })
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
  interface Reply {
    epoch: NeoPiNativeObservationDomain;
    passId: string;
    kind?: "incremental" | "full";
    watermark: number;
    /** Completes the pass at `watermark`; otherwise `cut` names where it continues. */
    done?: boolean;
    cut?: number;
    entities?: readonly NeoPiNativeEntity[];
    tombstones?: readonly NeoPiNativeTombstone[];
    journal?: NeoPiNativeJournalSlice;
    inbox?: readonly NeoPiNativeInboxRecord[];
    segments?: readonly NeoPiNativeSegment[];
  }
  const reply = (input: Reply) => {
    const kind = input.kind ?? "full";
    const done = input.done ?? true;
    return {
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
              afterOrdinal: input.cut ?? 0,
              segment: null,
            },
      },
      complete: false,
      promoted: false,
      entities: input.entities ?? [],
      tombstones: input.tombstones ?? [],
      segments: input.segments ?? [],
      inbox: input.inbox ?? [],
      journal: input.journal ?? null,
    };
  };
  /** Issues a read; returns the feed with it outstanding and its id. */
  const issue = (feed: NativeSessionFeed) => {
    const next = reduceNativeSessionFeed(feed, { type: "read-issued" });
    return [next, next.observation.outstanding!.readId] as const;
  };
  const answer = (feed: NativeSessionFeed, readId: number, input: Reply) =>
    reduceNativeSessionFeed(feed, { type: "read", readId, result: reply(input) });
  /** Issues one read and applies its reply. */
  const step = (feed: NativeSessionFeed, input: Reply): NativeSessionFeed => {
    const [issued, readId] = issue(feed);
    return answer(issued, readId, input);
  };
  let receipts = 0;
  /** Command output as the projection records it: anchored after the last row held. */
  const output = (feed: NativeSessionFeed, text: string): NativeSessionFeed => {
    const cursor = feed.observation.cursor!;
    receipts += 1;
    const revision = cursor.base + 1;
    return step(feed, {
      epoch: cursor.epoch,
      passId: `out-${receipts}`,
      kind: "incremental",
      watermark: revision,
      entities: [
        {
          key: `receipt:command:${receipts}`,
          ordinal: 5000 + receipts,
          revision,
          value: {
            class: "receipt",
            value: {
              kind: "command_output",
              text,
              afterEntryId: feed.conversation.entries.at(-1)?.id ?? null,
              afterMessageId: feed.conversation.pending.at(-1)?.messageId ?? null,
            },
          },
        },
      ],
    });
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
  const keys = (feed: NativeSessionFeed) => [...feed.observation.entities.keys()].sort();
  const contents = (feed: NativeSessionFeed) =>
    feed.conversation.pending.map((row) => row.message.content);
  const transcript = (value: NativeSessionFeed) =>
    nativeTranscriptRows(value, false).flatMap((row) =>
      row.kind === "command"
        ? ["command"]
        : row.entry.message === undefined
          ? []
          : [String(nativeRecord(row.entry.message).content)],
    );
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
    let feed = step(observing(), {
      epoch,
      passId: "p1",
      watermark: 5,
      journal: horizon(chain(["e0", "e1", "e2"], null)),
    });
    // The viewport sits on e1 while the view falls behind by more than a page.
    const viewport = feed.conversation.entries[1];
    feed = step(feed, {
      epoch,
      passId: "p2",
      watermark: 40,
      journal: horizon(chain(["e9", "e10"], "e8"), "before-e9"),
    });
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
    feed = step(feed, {
      epoch: domain({ branchGeneration: 2 }),
      passId: "p3",
      watermark: 50,
      journal: horizon([journalEntry("e1", "e0"), journalEntry("x2", "e1")]),
    });
    expect(ids(feed)).toEqual(["e0", "e1", "x2"]);
  });

  it("keeps loaded history and a live row through a rebuild whose first page does not join", () => {
    const start = step(observing(), {
      epoch: domain(),
      passId: "p1",
      watermark: 5,
      journal: horizon(chain(["e0", "e1", "e2"], null)),
      entities: [message("m", 5, null, "streaming")],
    });
    const page = horizon(chain(["e9", "e10"], "e8"), "before-e9");
    // Same owner and branch, replaced observation connection; the message key comes later.
    let feed = step(start, {
      epoch: domain({ projectionIncarnation: 2, buildAttempt: 0 }),
      passId: "q",
      watermark: 30,
      done: false,
      journal: page,
    });
    expect(ids(feed)).toEqual(["e0", "e1", "e2", "e9", "e10"]);
    expect([...nativeConversationGaps(feed.conversation)]).toEqual(["e9"]);
    expect(contents(feed)).toEqual(["streaming"]);
    expect(feed.conversation.losses).toEqual([]);

    // A rebuild that cannot know the branch is continuous changes its generation:
    // history is replaced as for a navigation, but the live row waits for the pass.
    const unknown = domain({ projectionIncarnation: 2, buildAttempt: 0, branchGeneration: 2 });
    feed = step(start, { epoch: unknown, passId: "q", watermark: 30, done: false, journal: page });
    expect(ids(feed)).toEqual(["e9", "e10"]);
    expect(contents(feed)).toEqual(["streaming"]);
    feed = step(feed, {
      epoch: unknown,
      passId: "q",
      watermark: 30,
      entities: [message("m", 29, null, "streaming on")],
    });
    expect(contents(feed)).toEqual(["streaming on"]);
    expect(feed.conversation.losses).toEqual([]);
  });

  it("takes the entries a horizon supplies for a placeholder, not only those after its join", () => {
    const epoch = domain();
    let feed = step(observing(), {
      epoch,
      passId: "p1",
      watermark: 5,
      journal: horizon(chain(["A", "B"], null)),
    });
    feed = step(feed, {
      epoch,
      passId: "p2",
      watermark: 9,
      journal: horizon(chain(["E", "F"], "D"), "before-E"),
    });
    expect([...nativeConversationGaps(feed.conversation)]).toEqual(["E"]);
    feed = step(feed, {
      epoch,
      passId: "p3",
      watermark: 12,
      journal: horizon(chain(["B", "C", "D", "E", "F", "G"], "A"), "before-B"),
    });
    expect(ids(feed)).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
    expect(nativeConversationGaps(feed.conversation).size).toBe(0);
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
    let feed = step(observing(), {
      epoch: domain(),
      passId: "p1",
      watermark: 6,
      journal: horizon([user]),
      entities: [message("m1", 5, null, toolCall), tool],
    });
    feed = output(feed, "output after the reply");
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
    feed = step(feed, {
      epoch: rebuilt,
      passId: "q",
      watermark: 4,
      done: false,
      entities: [message("m1", 3, "r", toolCall)],
    });
    // The alias alone retires nothing; the tool is not dropped mid-pass.
    expect(replyRows(feed)).toEqual(["u", "live:m1", "command"]);
    expect(feed.observation.entities.get("tool:tool-1")?.value).toEqual(tool.value);

    feed = step(feed, {
      epoch: rebuilt,
      passId: "q",
      watermark: 4,
      journal: horizon([user, journalEntry("r", "u", toolCall)]),
      entities: [toolAt(4, "done")],
    });
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
    // The successor watch describes the same session again.
    feed = reduceNativeSessionFeed(feed, { type: "session", revision: 2, session });
    expect(feed.agents.map((agent) => [agent.status, agent.native.disconnected])).toEqual([
      ["running", false],
    ]);

    // Read path: the roster is replaced by key only when the rebase pass completes.
    let observed = step(observing(), {
      epoch: domain(),
      passId: "p1",
      watermark: 9,
      entities: [roster("a", 8), roster("b", 9)],
    });
    const successor = domain({ projectionIncarnation: 2 });
    observed = step(observed, {
      epoch: successor,
      passId: "q",
      watermark: 3,
      done: false,
      entities: [roster("a", 2, "running")],
    });
    expect(keys(observed)).toEqual(["roster:a", "roster:b"]);
    expect(observed.observation.entities.get("roster:b")?.value).toEqual(roster("b", 9).value);
    observed = step(observed, { epoch: successor, passId: "q", watermark: 3 });
    expect(keys(observed)).toEqual(["roster:a"]);
  });

  it("applies a multi-part rebase without deleting by absence or regressing a newer revision", () => {
    const epoch = domain();
    let feed = step(observing(), {
      epoch,
      passId: "p1",
      watermark: 10,
      journal: horizon([journalEntry("u", null)]),
      entities: [roster("a", 10), roster("b", 9), message("m1", 8, null, "body")],
    });
    // Behind the tombstone horizon: a full pass in the same domain, every key changing.
    feed = step(feed, {
      epoch,
      passId: "p2",
      watermark: 30,
      done: false,
      cut: 1,
      entities: [roster("a", 25), message("m1", 26, "r", "body")],
    });
    expect(keys(feed)).toEqual(["message:m1", "roster:a", "roster:b"]);
    expect(feed.conversation.pending.map((row) => row.messageId)).toEqual(["m1"]);
    // A value older than one already held does not regress it.
    feed = step(feed, {
      epoch,
      passId: "p2",
      watermark: 30,
      done: false,
      cut: 2,
      entities: [roster("a", 20, "stale")],
      journal: horizon([journalEntry("u", null), journalEntry("r", "u", "body")]),
    });
    expect(feed.observation.entities.get("roster:a")?.revision).toBe(25);
    // The durable entry joined with its alias: the body shows exactly once.
    expect(transcript(feed).filter((content) => content === "body")).toHaveLength(1);
    feed = step(feed, { epoch, passId: "p2", watermark: 30, entities: [roster("c", 31)] });
    // Completion removes `b`, which the pass did not return; never `a` or `c`.
    expect(keys(feed)).toEqual(["message:m1", "roster:a", "roster:c"]);
  });

  it("applies only the reply to the one outstanding read", () => {
    const epoch = domain();
    let feed = step(observing(), { epoch, passId: "p0", watermark: 2 });
    feed = step(feed, {
      epoch,
      passId: "F",
      watermark: 10,
      done: false,
      entities: [roster("a", 5)],
    });
    const [issued, readId] = issue(feed);
    // A reply to no outstanding read, or to an older one, changes nothing.
    expect(answer(issued, readId + 1, { epoch, passId: "G", watermark: 11 })).toBe(issued);
    expect(answer(issued, readId - 1, { epoch, passId: "G", watermark: 11 })).toBe(issued);
    feed = answer(issued, readId, {
      epoch,
      passId: "F",
      watermark: 10,
      entities: [roster("b", 6)],
    });
    expect(keys(feed)).toEqual(["roster:a", "roster:b"]);
    // A competing or repeated reply to that same read, after it applied, changes nothing.
    expect(answer(feed, readId, { epoch, passId: "F", watermark: 10 })).toBe(feed);
    expect(answer(feed, readId, { epoch, passId: "H", watermark: 12 })).toBe(feed);
  });

  it.each([
    ["reconnecting", { type: "lifecycle" as const, revision: 99, state: "reconnecting" as const }],
    [
      "owner-stopped",
      { type: "lifecycle" as const, revision: 99, state: "owner-stopped" as const },
    ],
    ["disconnected", { type: "disconnected" as const }],
  ])("drops the read outstanding when the owner or lease ends (%s)", (_name, lifecycle) => {
    const retired = domain();
    let feed = step(observing(), {
      epoch: retired,
      passId: "p1",
      watermark: 4,
      entities: [roster("a", 4)],
    });
    const held = feed.observation.cursor;
    const [issued, stale] = issue(feed);
    feed = reduceNativeSessionFeed(issued, lifecycle);
    const ended = feed;
    // The old owner's reply arrives late, sent with the cursor still held.
    expect(answer(feed, stale, { epoch: retired, passId: "p2", watermark: 9 })).toBe(ended);
    expect(feed.observation.cursor).toBe(held);
    const [again, readId] = issue(feed);
    feed = answer(again, readId, {
      epoch: domain({ ownerEpoch: 2 }),
      passId: "q",
      watermark: 3,
      entities: [roster("a", 2), message("n", 3, null, "successor")],
    });
    expect(feed.observation.cursor?.epoch.ownerEpoch).toBe(2);
    expect(contents(feed)).toEqual(["successor"]);
  });

  it("removes a key absent from a promoted full pass at exactly its watermark", () => {
    const epoch = domain();
    let feed = step(observing(), { epoch, passId: "p0", watermark: 10 });
    feed = step(feed, {
      epoch,
      passId: "inc",
      kind: "incremental",
      watermark: 14,
      done: false,
      entities: [roster("a", 14)],
    });
    // Promoted at 14; `a` is deleted before the scan reaches it, so the pass omits it.
    const [issued, readId] = issue(feed);
    feed = reduceNativeSessionFeed(issued, {
      type: "read",
      readId,
      result: { ...reply({ epoch, passId: "full", watermark: 14 }), promoted: true },
    });
    expect(keys(feed)).toEqual([]);
  });

  it("never resurrects a removed key from an older revision", () => {
    const epoch = domain();
    const incremental = { epoch, kind: "incremental" as const };
    let feed = step(observing(), {
      ...incremental,
      passId: "p1",
      watermark: 4,
      entities: [roster("a", 4)],
    });
    const [replayed, firstRead] = issue(feed);
    feed = answer(replayed, firstRead, { ...incremental, passId: "p0", watermark: 4 });
    feed = step(feed, {
      ...incremental,
      passId: "p2",
      watermark: 8,
      done: false,
      tombstones: [{ key: "roster:a", ordinal: roster("a", 0).ordinal, revision: 5 }],
    });
    expect(keys(feed)).toEqual([]);
    const replay = { ...incremental, passId: "p1", watermark: 4, entities: [roster("a", 4)] };
    expect(answer(feed, firstRead, replay)).toBe(feed);
    // An older value later in the same pass stays behind its tombstone.
    feed = step(feed, { ...incremental, passId: "p2", watermark: 8, entities: [roster("a", 4)] });
    expect(keys(feed)).toEqual([]);
  });

  it("turns rows it cannot identify into continuity losses, never matching identical text", () => {
    const epoch = domain();
    let feed = step(observing(), {
      epoch,
      passId: "p1",
      watermark: 1,
      journal: horizon([journalEntry("u", null)]),
    });
    // More live rows than the 256 recovery mappings, all with the same text.
    feed = step(feed, {
      epoch,
      passId: "p2",
      kind: "incremental",
      watermark: 2,
      entities: Array.from({ length: 300 }, (_, index) => message(`m${index}`, 2, null, "same")),
    });
    feed = output(feed, "after the last row");
    const durable = chain(
      Array.from({ length: 300 }, (_, index) => `d${index}`),
      "u",
    ).map((entry) => ({ ...entry, message: { content: "same" } }));
    feed = step(feed, {
      epoch: domain({ projectionIncarnation: 2 }),
      passId: "q",
      watermark: 4,
      journal: horizon([journalEntry("u", null), ...durable]),
    });
    expect(feed.conversation.pending).toEqual([]);
    expect(feed.conversation.losses).toHaveLength(300);
    expect(new Set(feed.conversation.losses.map((loss) => loss.afterEntryId))).toEqual(
      new Set(["d299"]),
    );
    expect(nativeTranscriptRows(feed, false).at(-1)).toMatchObject({ kind: "command" });
  });

  it("never carries the previous owner's message ids into the successor's", () => {
    let feed = step(observing(), {
      epoch: domain(),
      passId: "p1",
      watermark: 3,
      journal: horizon([journalEntry("u", null)]),
      entities: [message("saved", 2, "s", "saved"), message("m1", 3, null, "old owner")],
    });
    feed = step(feed, {
      epoch: domain({ ownerEpoch: 2, projectionIncarnation: 2 }),
      passId: "q",
      watermark: 2,
      journal: horizon([journalEntry("u", null), journalEntry("s", "u", "saved")]),
      entities: [message("m1", 2, null, "new owner")],
    });
    expect(contents(feed)).toEqual(["new owner"]);
    // The identified row retired on its entry; the unidentified one reads from history.
    expect(feed.conversation.losses).toEqual([{ messageId: "m1", afterEntryId: "s" }]);
    expect(feed.conversation.persisted.size).toBe(0);
  });

  it.each([
    { dropped: true, loaded: ["u", "x"] },
    { dropped: false, loaded: ["u"] },
  ])(
    "loses a row waiting for an unloaded entry when a navigation's full pass ends (dropped history: $dropped)",
    ({ loaded }) => {
      let feed = step(observing(), {
        epoch: domain(),
        passId: "p1",
        watermark: 3,
        journal: horizon(chain(loaded, null)),
        entities: [message("m", 3, "y", "abandoned reply")],
      });
      // Waiting on the same branch is indefinite: `y` may be in a range not loaded.
      feed = step(feed, { epoch: domain(), passId: "p2", watermark: 4 });
      expect(contents(feed)).toEqual(["abandoned reply"]);
      const navigated = domain({ branchGeneration: 2 });
      feed = step(feed, {
        epoch: navigated,
        passId: "q",
        watermark: 6,
        done: false,
        journal: horizon(chain(["u", "z"], null)),
      });
      // Absence from a partial reply deletes nothing.
      expect(contents(feed)).toEqual(["abandoned reply"]);
      feed = step(feed, { epoch: navigated, passId: "q", watermark: 6 });
      expect(feed.conversation.pending).toEqual([]);
      expect(feed.conversation.losses).toEqual([{ messageId: "m", afterEntryId: "z" }]);
    },
  );

  it("keeps a body whose durable entry is known but not loaded across an owner change", () => {
    const start = output(
      step(observing(), {
        epoch: domain(),
        passId: "p1",
        watermark: 3,
        journal: horizon([journalEntry("u", null)]),
        entities: [message("m", 3, "E", "saved body")],
      }),
      "after the saved body",
    );
    const successor = domain({ ownerEpoch: 2, projectionIncarnation: 2 });
    // The successor's own `m` is a different message.
    let feed = step(start, {
      epoch: successor,
      passId: "q",
      watermark: 2,
      done: false,
      journal: horizon([journalEntry("u", null)]),
      entities: [message("m", 2, null, "successor body")],
    });
    expect(transcript(feed)).toEqual(["u", "saved body", "command", "successor body"]);
    expect(feed.conversation.losses).toEqual([]);
    const partial = feed;
    // `E` joins before the pass ends: the row retires onto it with its output.
    feed = step(partial, {
      epoch: successor,
      passId: "q",
      watermark: 2,
      journal: horizon([journalEntry("u", null), journalEntry("E", "u", "saved body")]),
    });
    expect(transcript(feed)).toEqual(["u", "saved body", "command", "successor body"]);
    expect(ids(feed)).toEqual(["u", "E"]);
    expect(feed.conversation.losses).toEqual([]);
    // The successor's full pass ends with a disjoint page after `E`: `E` is in
    // history not yet loaded, so the row is held, neither dropped nor lost.
    feed = step(partial, {
      epoch: successor,
      passId: "q",
      watermark: 2,
      journal: horizon(chain(["F", "G"], "E"), "before-F"),
    });
    expect(transcript(feed)).toEqual(["u", "F", "G", "saved body", "command", "successor body"]);
    expect(feed.conversation.losses).toEqual([]);
    // A later page reaches `E`: the row retires onto it.
    feed = step(feed, {
      epoch: successor,
      passId: "r",
      kind: "incremental",
      watermark: 3,
      journal: horizon(chain(["E", "F", "G"], "u")),
    });
    expect(ids(feed)).toEqual(["u", "E", "F", "G"]);
    expect(transcript(feed)).toEqual(["u", "E", "command", "F", "G", "successor body"]);
    expect(feed.conversation.losses).toEqual([]);
  });

  it("loses a held row only once its whole branch is loaded without its entry", () => {
    let feed = step(observing(), {
      epoch: domain(),
      passId: "p1",
      watermark: 3,
      journal: horizon([journalEntry("u", null)]),
      entities: [message("m", 3, "E", "saved body")],
    });
    const successor = domain({ ownerEpoch: 2, projectionIncarnation: 2, branchGeneration: 2 });
    // A disjoint horizon with a placeholder before it: `E` may be in the gap.
    feed = step(feed, {
      epoch: successor,
      passId: "q",
      watermark: 4,
      journal: horizon(chain(["x", "y"], "w"), "before-x"),
    });
    expect(contents(feed)).toEqual(["saved body"]);
    // The branch is loaded back to its root without `E`: it is not on this branch.
    feed = step(feed, {
      epoch: successor,
      passId: "r",
      kind: "full",
      watermark: 5,
      journal: horizon(chain(["v", "w", "x", "y"], null)),
    });
    expect(feed.conversation.pending).toEqual([]);
    expect(feed.conversation.losses).toEqual([{ messageId: "durable:E", afterEntryId: "y" }]);
  });

  it("keeps command output visible when a successor turns its live row into a loss", () => {
    let feed = step(observing(), {
      epoch: domain(),
      passId: "p1",
      watermark: 3,
      journal: horizon([journalEntry("u", null)]),
      entities: [message("m", 3, null, "old owner")],
    });
    feed = output(feed, "after the old row");
    feed = step(feed, {
      epoch: domain({ ownerEpoch: 2, projectionIncarnation: 2 }),
      passId: "q",
      watermark: 2,
      done: false,
      entities: [message("m", 2, null, "successor body")],
    });
    expect(transcript(feed)).toEqual(["u", "command", "successor body"]);
    expect(feed.conversation.losses).toEqual([{ messageId: "m", afterEntryId: "u" }]);
  });

  it("shows a message once when its entry and its join arrive in one reply", () => {
    const epoch = domain();
    let feed = step(observing(), {
      epoch,
      passId: "p1",
      watermark: 3,
      journal: horizon([journalEntry("u", null)]),
      entities: [message("m", 3, null, "reply")],
    });
    feed = step(feed, {
      epoch,
      passId: "p2",
      kind: "incremental",
      watermark: 5,
      journal: { continuity: "append", leafId: "r", entries: [journalEntry("r", "u", "reply")] },
      tombstones: [{ key: "message:m", ordinal: 1, revision: 5, joinEntryId: "r" }],
    });
    expect(transcript(feed)).toEqual(["u", "reply"]);
  });

  it("drops segment data of a transfer its pass did not finish", () => {
    const epoch = domain();
    const part = { key: "big", revision: 12, index: 0, count: 2, encodedBytes: 10, data: "{" };
    let feed = step(observing(), { epoch, passId: "p0", watermark: 10 });
    feed = step(feed, {
      epoch,
      passId: "inc",
      kind: "incremental",
      watermark: 14,
      done: false,
      segments: [part],
    });
    expect(feed.observation.segments.size).toBe(1);
    // Promoted to a fresh full pass that never returns `big`.
    const [issued, readId] = issue(feed);
    feed = reduceNativeSessionFeed(issued, {
      type: "read",
      readId,
      result: { ...reply({ epoch, passId: "full", watermark: 15, done: false }), promoted: true },
    });
    expect(feed.observation.segments.size).toBe(0);
    feed = step(feed, { epoch, passId: "full", watermark: 15, done: false, segments: [part] });
    feed = step(feed, { epoch, passId: "full", watermark: 15 });
    expect(feed.observation.segments.size).toBe(0);
  });

  it("keeps a row retired by its durable entry until that entry is held", () => {
    const epoch = domain();
    let feed = step(observing(), {
      epoch,
      passId: "p1",
      watermark: 3,
      journal: horizon([journalEntry("u", null)]),
      entities: [message("m", 3, null, "reply")],
    });
    feed = step(feed, {
      epoch,
      passId: "p2",
      watermark: 5,
      tombstones: [{ key: "message:m", ordinal: 1, revision: 5, joinEntryId: "r" }],
    });
    expect(contents(feed)).toEqual(["reply"]);
    expect(feed.conversation.losses).toEqual([]);
    feed = step(feed, {
      epoch,
      passId: "p3",
      kind: "incremental",
      watermark: 6,
      journal: { continuity: "append", leafId: "r", entries: [journalEntry("r", "u", "reply")] },
    });
    expect(feed.conversation.pending).toEqual([]);
    expect(transcript(feed)).toEqual(["u", "reply"]);
  });

  it("keeps inbox gaps exact: what this view missed, once, in order", () => {
    const epoch = domain();
    const notice = (seq: number): NeoPiNativeInboxRecord => ({
      type: "notice",
      seq,
      level: "info",
      message: `notice ${seq}`,
    });
    const gap = (
      fromSeq: number,
      toSeq: number,
      reason: "evicted" | "not-observed",
      notices: number,
      updates = 0,
    ): NeoPiNativeInboxRecord => ({
      type: "gap",
      seq: toSeq,
      reason,
      fromSeq,
      toSeq,
      firstReceivedAt: fromSeq * 1000,
      lastReceivedAt: toSeq * 1000,
      notices,
      toolStreams: updates ? [{ toolCallId: "t", toolName: "bash", updates }] : [],
      toolStreamsTruncated: false,
    });
    const shape = (feed: NativeSessionFeed) =>
      feed.observation.inbox.map((record) =>
        record.type === "gap"
          ? [record.fromSeq, record.toSeq, record.reason, record.notices, record.toolStreams.length]
          : "seq" in record
            ? record.seq
            : record.type,
      );
    let feed = step(observing(), {
      epoch,
      passId: "p1",
      watermark: 1,
      inbox: [gap(1, 2, "evicted", 2), notice(3)],
    });
    // The server grew its gap over notice 3, which this view holds: only 4 was missed.
    feed = step(feed, { epoch, passId: "p2", watermark: 2, inbox: [gap(1, 4, "evicted", 4)] });
    expect(shape(feed)).toEqual([[1, 2, "evicted", 2, 0], 3, [4, 4, "evicted", 1, 0]]);
    // Gaps of two reasons stay apart; a grown one counts only its new records.
    feed = step(feed, {
      epoch,
      passId: "p3",
      watermark: 3,
      inbox: [gap(5, 6, "evicted", 2), gap(7, 8, "not-observed", 1, 1)],
    });
    feed = step(feed, {
      epoch,
      passId: "p4",
      watermark: 4,
      inbox: [gap(7, 9, "not-observed", 2, 1)],
    });
    expect(shape(feed).slice(3)).toEqual([
      [5, 6, "evicted", 2, 0],
      [7, 8, "not-observed", 1, 1],
      [9, 9, "not-observed", 1, 0],
    ]);
    // A consumer may drain mapped records: a replay is still recognised, and a
    // later grown gap still subtracts what this view held.
    const drained = { ...feed, observation: { ...feed.observation, inbox: [] } };
    feed = step(drained, {
      epoch,
      passId: "p5",
      watermark: 5,
      inbox: [notice(9), gap(7, 10, "not-observed", 3, 1)],
    });
    expect(shape(feed)).toEqual([[10, 10, "not-observed", 1, 0]]);
    // A navigation in the same projection keeps sequence numbers.
    feed = step(feed, {
      epoch: domain({ branchGeneration: 2 }),
      passId: "p6",
      watermark: 6,
      inbox: [gap(7, 10, "not-observed", 3, 1), notice(11)],
    });
    expect(shape(feed)).toEqual([[10, 10, "not-observed", 1, 0], 11]);
    const held = feed.observation.inbox;
    expect(step(feed, { epoch, passId: "p7", watermark: 7 }).observation.inbox).toBe(held);
  });
});
