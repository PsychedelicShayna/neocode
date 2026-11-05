import type { NeoPiJournalEntry } from "@t3tools/contracts";
import type { TranscriptRow } from "@t3tools/client-runtime/neopi-transcript";
import { describe, expect, it } from "vite-plus/test";
import { deriveMessagesTimelineRows } from "../chat/MessagesTimeline.logic";
import { projectNativeTimeline } from "./nativeTimeline";

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
const entry = (id: string, type: string) => ({ id, type }) as unknown as NeoPiJournalEntry;

const user = (id: string, second: number): TranscriptRow => ({
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
const assistant = (id: string, second: number): TranscriptRow => ({
  kind: "assistant",
  id,
  entry: entry(id, "message"),
  timestamp: at(second),
  live: false,
  text: "done",
  images: [],
  meta: null,
});
const tool = (id: string, second: number): TranscriptRow => ({
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
const divider = (id: string, second: number): TranscriptRow => ({
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
