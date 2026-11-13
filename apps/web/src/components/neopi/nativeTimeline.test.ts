import { RunId, type NeoPiJournalEntry } from "@t3tools/contracts";
import type { TranscriptRow } from "@t3tools/client-runtime/neopi-transcript";
import { describe, expect, it } from "vite-plus/test";
import { deriveMessagesTimelineRows, turnToolDisclosureKeys } from "../chat/MessagesTimeline.logic";
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

function renderedRows(rows: readonly TranscriptRow[]) {
  const timeline = projectNativeTimeline(rows, false);
  return deriveMessagesTimelineRows({
    timelineEntries: timeline.entries,
    latestRun: timeline.latestRun,
    runningRunId: timeline.runningRunId,
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  });
}

function foldLabels(rows: readonly TranscriptRow[]) {
  return renderedRows(rows).flatMap((row) => (row.kind === "turn-fold" ? [row.label] : []));
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

  it("expands only the current native run's work and keeps steering in that run", () => {
    const thought: Row<"thinking"> = {
      kind: "thinking",
      id: "thought",
      entry: entry("thought", "message"),
      timestamp: at(31),
      live: false,
      text: "Check the second result.",
      summary: false,
    };
    const rows = [
      user("u1", 0),
      tool("old-tool", 10),
      assistant("a1", 20),
      user("u2", 30),
      thought,
      tool("new-tool", 40),
      { ...user("steer", 50), steering: true },
      tool("steered-tool", 60),
      assistant("a2", 70),
    ];
    const timeline = projectNativeTimeline(rows, false);
    expect(turnToolDisclosureKeys(timeline.entries, RunId.make("native:u2")).workEntryIds).toEqual([
      "thought",
      "new-tool",
      "steered-tool",
    ]);
    expect(timeline.entries.find((item) => item.id === "steer")).toMatchObject({
      kind: "message",
      message: { runId: RunId.make("native:u2"), inputIntent: "steer" },
    });
  });

  it("re-derives rows when a prompt starts a new turn above them", () => {
    const rows = [assistant("a0", 0), user("u1", 5)];
    const first = projectNativeTimeline(rows, false);
    const again = projectNativeTimeline([user("u0", -1), ...rows], false);
    // The assistant row now belongs to turn u0, not the origin turn.
    expect(again.entries[1]).not.toBe(first.entries[0]);
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
      latestRun: timeline.latestRun,
      runningRunId: timeline.runningRunId,
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
