import {
  TurnId,
  type NeoPiJournalEntry,
  type NeoPiNativeObservationDomain,
} from "@t3tools/contracts";
import {
  createTranscriptProjector,
  type TranscriptRow,
} from "@t3tools/client-runtime/neopi-transcript";
import { describe, expect, it } from "vite-plus/test";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
  type MessagesTimelineRow,
  type MessagesTimelineRowsProjection,
  type StableMessagesTimelineRowsState,
} from "../chat/MessagesTimeline.logic";
import {
  emptyNativeSessionFeed,
  reduceNativeSessionFeed,
  type NativeSessionFeed,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { projectNativeTimeline } from "./nativeTimeline";

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
const entry = (id: string, type: string) => ({ id, type }) as unknown as NeoPiJournalEntry;
type Row<Kind extends TranscriptRow["kind"]> = Extract<TranscriptRow, { kind: Kind }>;

const user = (id: string, second: number): Row<"user"> => ({
  kind: "user",
  id,
  entry: entry(id, "message"),
  timestamp: at(second),
  live: false,
  text: "go",
  images: [],
  files: [],
  steering: false,
});
const assistant = (id: string, second: number): Row<"assistant"> => ({
  kind: "assistant",
  id,
  entry: entry(id, "message"),
  timestamp: at(second),
  live: false,
  text: "done",
  images: [],
  meta: null,
});
const tool = (id: string, second: number): Row<"tool"> => ({
  kind: "tool",
  id,
  entry: entry(id, "message"),
  timestamp: at(second),
  live: false,
  call: { id, name: "bash", intent: null, arguments: {} },
  result: null,
  label: "Ran command",
  detail: null,
});
const divider = (id: string, second: number): Row<"divider"> => ({
  kind: "divider",
  id,
  entry: entry(id, "model_change"),
  timestamp: at(second),
  live: false,
  text: "Other model",
});

function foldLabels(rows: readonly TranscriptRow[]) {
  const timeline = projectNativeTimeline(rows, false);
  const derived = deriveMessagesTimelineRows({
    timelineEntries: timeline.entries,
    latestTurn: timeline.latestTurn,
    runningTurnId: timeline.runningTurnId,
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  });
  return derived.flatMap((row) => (row.kind === "turn-fold" ? [row.label] : []));
}

describe("native turn duration", () => {
  const settled = [user("u1", 0), tool("t1", 20), assistant("a1", 69)];

  it("ends at the last assistant activity, not at settings changed afterwards", () => {
    expect(foldLabels(settled)).toEqual(["Worked for 1m 9s"]);
    expect(foldLabels([...settled, divider("d1", 900), divider("d2", 976)])).toEqual([
      "Worked for 1m 9s",
    ]);
  });

  it("keeps an earlier turn's duration fixed when settings change before the next prompt", () => {
    const labels = foldLabels([
      ...settled,
      divider("d1", 976),
      user("u2", 1000),
      tool("t2", 1010),
      assistant("a2", 1020),
    ]);
    expect(labels).toEqual(["Worked for 1m 9s", "Worked for 20s"]);
  });
});

describe("native timeline entry identity", () => {
  const streaming = (textValue: string): TranscriptRow => ({
    ...assistant("live:a9", 0),
    live: true,
    text: textValue,
  });
  const finished = tool("t0", 5);
  const answered: TranscriptRow = {
    ...finished,
    result: {
      entry: entry("r0", "message"),
      text: "ok",
      images: [],
      isError: false,
      details: null,
    },
  };
  const history = [
    user("u1", 0),
    answered,
    divider("d1", 30),
    divider("d2", 31),
    assistant("a1", 40),
  ];

  it("hands back the same entries for rows it has seen, so only the streaming tail changes", () => {
    const first = projectNativeTimeline([...history, streaming("a")], true);
    const second = projectNativeTimeline([...history, streaming("ab")], true);
    expect(second.entries).toHaveLength(first.entries.length);
    for (let index = 0; index < first.entries.length - 1; index++)
      expect(second.entries[index]).toBe(first.entries[index]);
    expect(second.entries.at(-1)).not.toBe(first.entries.at(-1));
  });

  it("keeps the merged settings line stable across updates", () => {
    const model: TranscriptRow = {
      ...divider("d1", 30),
      entry: { id: "d1", type: "model_change", model: "anthropic/claude-opus-5-5" } as never,
    };
    const level: TranscriptRow = {
      ...divider("d2", 31),
      text: "Reasoning high",
      entry: { id: "d2", type: "thinking_level_change", thinkingLevel: "high" } as never,
    };
    const rows = [user("u1", 0), model, level];
    const first = projectNativeTimeline(rows, false);
    const second = projectNativeTimeline(rows, false);
    expect(first.entries.at(-1)).toMatchObject({ entry: { label: "Claude Opus 5.5 · high" } });
    expect(second.entries.at(-1)).toBe(first.entries.at(-1));
  });

  it("only re-derives a call that is still waiting for its result when the run starts or stops", () => {
    const open = tool("t1", 50);
    const rows = [user("u1", 0), answered, open];
    const running = projectNativeTimeline(rows, true);
    const stopped = projectNativeTimeline(rows, false);
    expect(stopped.entries[1]).toBe(running.entries[1]);
    expect(stopped.entries[2]).not.toBe(running.entries[2]);
    expect(stopped.entries[2]).toMatchObject({ entry: { toolLifecycleStatus: "stopped" } });
    expect(running.entries[2]).toMatchObject({ entry: { toolLifecycleStatus: "inProgress" } });
  });

  it("re-derives rows when a prompt starts a new turn above them", () => {
    const rows = [assistant("a0", 0), user("u1", 5)];
    const first = projectNativeTimeline(rows, false);
    const again = projectNativeTimeline([user("u0", -1), ...rows], false);
    // The assistant row now belongs to turn u0, not the origin turn.
    expect(again.entries[1]).not.toBe(first.entries[0]);
  });
});

describe("native tool disclosure across persistence", () => {
  it("keeps an expanded call's identity from a live message through its durable join and rebase", () => {
    const projectRows = createTranscriptProjector();
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "pwd" } }],
    };
    const prompt: NeoPiJournalEntry = {
      id: "u1",
      parentId: null,
      type: "message",
      timestamp: at(0),
      message: { role: "user", content: "Go" },
    };
    const options = { debug: false };
    const live = projectNativeTimeline(
      projectRows(
        {
          entries: [prompt],
          pending: [{ messageId: "m1", message: call }],
          leafId: prompt.id,
        },
        options,
      ),
      true,
    );
    const liveCall = live.entries.find(
      (item) => item.kind === "work" && item.entry.toolCallId === "call",
    )!;
    // This is the key MessagesTimeline uses to remember expanded tool entries.
    const expanded = new Set([liveCall.id]);
    const durable: NeoPiJournalEntry = {
      id: "a1",
      parentId: prompt.id,
      type: "message",
      timestamp: at(1),
      message: call,
    };
    const result: NeoPiJournalEntry = {
      id: "r1",
      parentId: durable.id,
      type: "message",
      timestamp: at(2),
      message: { role: "toolResult", toolCallId: "call", content: "/workspace" },
    };
    const shown = () =>
      projectNativeTimeline(
        projectRows(
          {
            entries: [prompt, { ...durable }, { ...result }],
            pending: [],
            leafId: result.id,
          },
          options,
        ),
        false,
      );
    for (const timeline of [shown(), shown()]) {
      const joined = timeline.entries.filter(
        (item) => item.kind === "work" && item.entry.toolCallId === "call",
      );
      expect(joined).toHaveLength(1);
      expect(expanded.has(joined[0]!.id)).toBe(true);
      expect(joined[0]).toMatchObject({ entry: { toolLifecycleStatus: "completed" } });
    }
  });

  it("shows a missing-output marker inside its call without regrouping or folding the row", () => {
    const finished = (id: string, second: number): Row<"tool"> => ({
      ...tool(id, second),
      result: {
        entry: entry(`${id}:r`, "message"),
        text: "ok",
        images: [],
        isError: false,
        details: null,
      },
    });
    const rows = [
      user("u1", 0),
      finished("call-a", 10),
      assistant("a1", 11),
      finished("call-b", 12),
    ];
    const derive = (losses?: ReadonlyMap<string, readonly { readonly text: string }[]>) => {
      const timeline = projectNativeTimeline(rows, false, losses);
      return deriveMessagesTimelineRows({
        timelineEntries: timeline.entries,
        latestTurn: timeline.latestTurn,
        runningTurnId: timeline.runningTurnId,
        // The reader opened the finished turn to see its calls.
        expandedTurnIds: new Set([TurnId.make("native:u1")]),
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
    };
    const shape = (derived: readonly MessagesTimelineRow[]) =>
      derived.map((row) => `${row.kind}:${row.id}`);
    const marked = derive(new Map([["call-a", [{ text: "missing output facts" }]]]));
    // The standalone call keeps its own row (and so the disclosure keyed by its id).
    expect(shape(marked)).toEqual(shape(derive()));
    const callA = marked.find((row) => row.id === "tool:call-a");
    expect(callA?.kind === "work" && callA.groupedEntries[0]?.detail).toContain(
      "missing output facts",
    );
    const callB = marked.find((row) => row.id === "tool:call-b");
    expect(callB?.kind).toBe("work");
    expect((callB?.kind === "work" && callB.groupedEntries[0]?.detail) || "").not.toContain(
      "missing output facts",
    );
  });
});

describe("native compaction row", () => {
  it("expands to the compaction summary through the context-compaction row", () => {
    const compaction: TranscriptRow = {
      kind: "divider",
      id: "c1:divider",
      entry: entry("c1", "compaction"),
      timestamp: at(100),
      live: false,
      text: "Context compacted · 31k → 29k tokens",
      summary: "Kept the plan.",
    };
    const timeline = projectNativeTimeline([user("u1", 0), assistant("a1", 10), compaction], false);
    const rows = deriveMessagesTimelineRows({
      timelineEntries: timeline.entries,
      latestTurn: timeline.latestTurn,
      runningTurnId: timeline.runningTurnId,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.find((row) => row.kind === "context-compaction")).toMatchObject({
      label: "Context compacted · 31k → 29k tokens",
      detail: "Kept the plan.",
    });
  });
});

describe("projection reads through the incremental timeline window", () => {
  it("shows every current message revision at a fixed row count without a reload", () => {
    const epoch: NeoPiNativeObservationDomain = {
      serverIncarnation: "server",
      ownerEpoch: 1,
      projectionIncarnation: 1,
      buildAttempt: 1,
      branchGeneration: 1,
    };
    const empty = emptyNativeSessionFeed();
    let feed: NativeSessionFeed = {
      ...empty,
      busy: true,
      conversation: {
        ...empty.conversation,
        identity: { sessionId: "session", sessionFile: "/session", leafId: "u1" },
        entries: [
          {
            id: "u1",
            parentId: null,
            type: "message",
            timestamp: at(0),
            message: { role: "user", content: "Go" },
          },
        ],
      },
    };
    const projectRows = createTranscriptProjector();
    let previous: MessagesTimelineRowsProjection | null = null;
    let stable: StableMessagesTimelineRowsState = {
      byId: new Map(),
      result: [],
    };
    let count = 0;
    for (const [index, text] of ["a", "ab", "abc", "final body"].entries()) {
      const revision = index + 1;
      feed = reduceNativeSessionFeed(feed, { type: "read-issued" });
      feed = reduceNativeSessionFeed(feed, {
        type: "read",
        readId: feed.observation.outstanding!.readId,
        result: {
          type: "pass",
          kind: index === 0 ? "full" : "incremental",
          promoted: false,
          passId: `pass-${revision}`,
          baseCursor: feed.observation.outstanding!.cursor ?? {
            epoch,
            base: 0,
            pass: null,
            inboxSeq: 0,
            journalAt: null,
          },
          complete: true,
          coveredThrough: revision,
          continuation: { epoch, base: revision, pass: null, inboxSeq: 0, journalAt: null },
          entities: [
            {
              key: "message:m1",
              ordinal: 1,
              revision,
              value: {
                class: "message",
                messageId: "m1",
                phase: "open",
                entryId: null,
                message: { role: "assistant", content: [{ type: "text", text }] },
              },
            },
          ],
          tombstones: [],
          segments: [],
          inbox: [],
          journal: null,
        },
      });
      const timeline = projectNativeTimeline(
        projectRows(
          {
            entries: feed.conversation.entries,
            pending: feed.conversation.pending,
            leafId: null,
          },
          { debug: false },
        ),
        feed.busy,
      );
      previous = deriveMessagesTimelineRowsWithState(
        {
          timelineEntries: timeline.entries,
          latestTurn: timeline.latestTurn,
          runningTurnId: timeline.runningTurnId,
          isWorking: true,
          activeTurnStartedAt: null,
          turnDiffSummaries: [],
          supportsConversationRollback: false,
        },
        previous,
      );
      const next = computeStableMessagesTimelineRows(previous.rows, stable);
      const shown = next.result.find(
        (row) => row.kind === "message" && row.message.role === "assistant",
      );
      expect(shown?.kind === "message" && shown.message.text).toBe(text);
      expect(next).not.toBe(stable);
      if (index === 0) count = next.result.length;
      else expect(next.result).toHaveLength(count);
      stable = next;
    }
  });
});
