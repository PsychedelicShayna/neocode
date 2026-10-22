import {
  ProviderInstanceId,
  type NeoPiJournalEntry,
  type NeoPiSessionJournalResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  extendNeoPiJournalSnapshot,
  journalEntryCategory,
  journalTreeRows,
  type NeoPiJournalSnapshot,
} from "@t3tools/client-runtime/neopi-journal";

type Available = Extract<NeoPiSessionJournalResult, { status: "available" }>;
const entry = (id: string, parentId: string | null, type = "message"): NeoPiJournalEntry => ({
  id,
  parentId,
  type,
  timestamp: "2026-10-22T00:00:00.000Z",
  message: { role: "user", content: id },
});
const response = (entries: NeoPiJournalEntry[], nextCursor?: string): Available => ({
  status: "available",
  providerInstanceId: ProviderInstanceId.make("neopi-default"),
  page: {
    sessionId: "native",
    sessionFile: "/native/session.jsonl",
    leafId: "2500",
    totalEntries: 2501,
    entries,
    ...(nextCursor ? { nextCursor } : {}),
  },
});

describe("native journal inspection", () => {
  it("pages beyond 2000 without dropping markers or reversing entries inside a page", () => {
    const all = Array.from({ length: 2501 }, (_, index) =>
      entry(
        String(index),
        index > 0 ? String(index - 1) : null,
        index === 100
          ? "compaction"
          : index === 500
            ? "reset_boundary"
            : index === 2000
              ? "branch_summary"
              : "message",
      ),
    );
    let snapshot: NeoPiJournalSnapshot | null = null;
    for (let end = all.length; end > 0; end -= 100) {
      const start = Math.max(0, end - 100);
      snapshot = extendNeoPiJournalSnapshot(
        snapshot,
        response(all.slice(start, end), start > 0 ? `cursor-${start}` : undefined),
      );
    }
    expect(snapshot?.entries).toEqual(all);
    expect(snapshot?.page.nextCursor).toBeUndefined();
    expect(journalTreeRows(snapshot!.entries)).toHaveLength(2501);
  });

  it("refuses mixed leaves, files, sessions, providers, counts and repeated cursors", () => {
    const snapshot = extendNeoPiJournalSnapshot(null, response([entry("2500", "2499")], "cursor"));
    for (const patch of [
      { leafId: "other" },
      { sessionId: "other" },
      { sessionFile: "/other" },
      { totalEntries: 1 },
      { nextCursor: "cursor" },
    ]) {
      const next = response([entry("2499", "2498")], "next");
      expect(() =>
        extendNeoPiJournalSnapshot(snapshot, { ...next, page: { ...next.page, ...patch } }),
      ).toThrow();
    }
    expect(() =>
      extendNeoPiJournalSnapshot(snapshot, {
        ...response([], "next"),
        providerInstanceId: ProviderInstanceId.make("other"),
      }),
    ).toThrow();
    expect(() =>
      extendNeoPiJournalSnapshot(snapshot, response([entry("2500", "2499")], "next")),
    ).toThrow();
  });

  it("shows alternate branches, unloaded parents and unknown canonical entries", () => {
    const records = [
      entry("root", "older"),
      entry("left", "root", "compaction"),
      entry("right", "root", "future_native_kind"),
    ];
    const rows = journalTreeRows(records);
    expect(rows.map(({ entry: item, depth }) => [item.id, depth])).toEqual([
      ["root", 0],
      ["left", 1],
      ["right", 1],
    ]);
    expect(rows[0]?.missingParent).toBe(true);
    expect(rows[0]?.childCount).toBe(2);
    expect(rows[2]?.entry).toBe(records[2]);
  });

  it("filters display categories without changing the canonical journal", () => {
    const records = [
      entry("user", null),
      {
        ...entry("result", "user"),
        message: {
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: "full output" }],
        },
      },
      entry("reset", "result", "reset_boundary"),
    ];
    expect(records.map(journalEntryCategory)).toEqual(["message", "tool", "system"]);
    expect(records).toHaveLength(3);
    expect(journalTreeRows(records).map((row) => row.entry)).toEqual(records);
  });
});
