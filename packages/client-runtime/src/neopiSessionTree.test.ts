import type { NeoPiJournalEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  decodeSessionTree,
  describeSessionTreeEntry,
  filterSessionTree,
  projectSessionTree,
  sessionTreePrefix,
  sessionTreeScrollOffset,
  type SessionTreeItem,
} from "./neopiSessionTree.ts";

const entry = (
  id: string,
  parentId: string | null,
  extra: Record<string, unknown> = {},
): NeoPiJournalEntry => ({
  id,
  parentId,
  type: "message",
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "user", content: id },
  ...extra,
});
const item = (
  id: string,
  parentId: string | null,
  extra: Record<string, unknown> = {},
  label?: string,
): SessionTreeItem => ({ entry: entry(id, parentId, extra), label });

/** a ─ b ─ c, with b forking into c ─ d and e ─ f ─ g, and e forking too. */
const forked = [
  item("a", null),
  item("b", "a"),
  item("c", "b"),
  item("d", "c"),
  item("e", "b"),
  item("f", "e"),
  item("g", "f"),
];
const lines = (
  items: readonly SessionTreeItem[],
  leafId: string | null,
  collapsed = new Set<string>(),
) =>
  projectSessionTree(items, leafId, collapsed).rows.map(
    (row) => `${sessionTreePrefix(row, 0)}${row.id}`,
  );

describe("projectSessionTree", () => {
  it("keeps a linear chain in one column", () => {
    expect(lines([item("a", null), item("b", "a"), item("c", "b")], "c")).toEqual(["a", "b", "c"]);
  });

  it("draws connectors and gutters only at real forks, active branch first", () => {
    expect(lines(forked, "g")).toEqual(["a", "b", "├─ e", "│  f", "│  g", "└─ c", "   d"]);
  });

  it("closes a gutter once its fork's last sibling has been drawn", () => {
    const rows = lines(
      [item("a", null), item("b", "a"), item("c", "a"), item("d", "c"), item("e", "c")],
      "b",
    );
    expect(rows).toEqual(["a", "├─ b", "└─ c", "   ├─ d", "   └─ e"]);
  });

  it("marks the active path and the current leaf", () => {
    const rows = projectSessionTree(forked, "d").rows;
    expect(rows.filter((row) => row.onActivePath).map((row) => row.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(rows.filter((row) => row.isLeaf).map((row) => row.id)).toEqual(["d"]);
    expect(rows.slice(0, 4).map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("folds a collapsed branch and counts what it hides", () => {
    const rows = projectSessionTree(forked, "g", new Set(["e"])).rows;
    expect(rows.map((row) => row.id)).toEqual(["a", "b", "e", "c", "d"]);
    expect(rows.find((row) => row.id === "e")).toMatchObject({ collapsed: true, hiddenCount: 2 });
  });

  it("indents session roots under a virtual root without drawing connectors", () => {
    expect(lines([item("a", null), item("b", "a"), item("x", null), item("y", "x")], "y")).toEqual([
      "x",
      "   y",
      "a",
      "   b",
    ]);
  });

  it("keeps orphaned and cyclic entries visible as roots", () => {
    const rows = projectSessionTree(
      [item("a", null), item("o", "missing"), item("p", "q"), item("q", "p")],
      null,
    ).rows;
    expect(rows.map((row) => row.id).toSorted()).toEqual(["a", "o", "p", "q"]);
  });

  it("walks a very long chain without recursion", () => {
    const chain = Array.from({ length: 50_000 }, (_, index) =>
      item(`n${index}`, index === 0 ? null : `n${index - 1}`),
    );
    expect(projectSessionTree(chain, "n49999").rows).toHaveLength(50_000);
  });
});

describe("sessionTreePrefix", () => {
  it("drops outer levels so the deepest row still fits, keeping connectors", () => {
    const rows = projectSessionTree(
      [item("a", null), item("b", "a"), item("c", "a"), item("d", "c"), item("e", "c")],
      "b",
    ).rows;
    const deepest = Math.max(...rows.map((row) => row.depth));
    const offset = sessionTreeScrollOffset(deepest, 1);
    expect(offset).toBe(1);
    expect(rows.map((row) => sessionTreePrefix(row, offset))).toEqual(["", "", "", "├─ ", "└─ "]);
    expect(sessionTreePrefix(rows[3]!, 0)).toBe("   ├─ ");
    expect(sessionTreePrefix(rows[3]!, 1)).toBe("├─ ");
  });
});

describe("decodeSessionTree", () => {
  it("flattens nested get_tree nodes in sibling order and keeps labels", () => {
    const node = (
      id: string,
      parentId: string | null,
      children: unknown[] = [],
      label?: string,
    ) => ({
      entry: entry(id, parentId),
      children,
      ...(label ? { label } : {}),
    });
    const snapshot = decodeSessionTree({
      leafId: "c",
      tree: [node("a", null, [node("b", "a", [], "keep"), node("c", "a")]), { entry: { id: 1 } }],
    });
    expect(snapshot.items.map(({ entry: value, label }) => [value.id, label])).toEqual([
      ["a", undefined],
      ["b", "keep"],
      ["c", undefined],
    ]);
    expect(snapshot.leafId).toBe("c");
  });
});

describe("filterSessionTree", () => {
  const toolTurn = item("t", "u", {
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "src/a.ts" } }],
      stopReason: "toolUse",
    },
  });
  const items = [
    item("u", null, { message: { role: "user", content: "fix the parser" } }),
    toolTurn,
    item("r", "t", {
      message: { role: "toolResult", toolCallId: "call", toolName: "read", content: "ok" },
    }),
    item("m", "r", { type: "model_change", model: "x/y" }),
    item("s", "m", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        stopReason: "stop",
      },
    }),
  ];
  const projection = projectSessionTree(items, "s");
  const ids = (filter: Parameters<typeof filterSessionTree>[1], query = "") =>
    filterSessionTree(projection, filter, query).map((row) => row.id);

  it("hides tool-only assistant turns and settings entries by default", () => {
    expect(ids("default")).toEqual(["u", "r", "s"]);
  });
  it("shows everything but bare tool turns for all", () => {
    expect(ids("all")).toEqual(["u", "r", "m", "s"]);
  });
  it("drops tool results for no-tools and keeps only prompts for user-only", () => {
    expect(ids("no-tools")).toEqual(["u", "s"]);
    expect(ids("user-only")).toEqual(["u"]);
  });
  it("searches kind and text, including the tool call a result answers", () => {
    expect(ids("default", "parser")).toEqual(["u"]);
    expect(ids("default", "src/a.ts read")).toEqual(["r"]);
  });
  it("shows the current leaf even when it is a bare tool turn", () => {
    expect(
      filterSessionTree(projectSessionTree(items, "t"), "default", "").map((row) => row.id),
    ).toContain("t");
  });
  it("keeps bookmarked tool-only turns navigable in Labeled, including label searches", () => {
    const bookmarked = projectSessionTree(
      items.map((value) =>
        value === toolTurn ? { ...value, label: "inspect parser bookmark" } : value,
      ),
      "s",
    );
    const bookmarkedIds = (filter: Parameters<typeof filterSessionTree>[1], query = "") =>
      filterSessionTree(bookmarked, filter, query).map((row) => row.id);
    expect(bookmarkedIds("labeled-only")).toEqual(["t"]);
    expect(bookmarkedIds("labeled-only", "parser bookmark")).toEqual(["t"]);
    expect(bookmarkedIds("labeled-only", "unmatched")).toEqual([]);
    expect(ids("labeled-only")).toEqual([]);
    // Ordinary browsing still folds bare turns, even when they have a bookmark.
    expect(bookmarkedIds("default")).toEqual(["u", "r", "s"]);
    expect(bookmarkedIds("all")).toEqual(["u", "r", "m", "s"]);
  });
});

describe("describeSessionTreeEntry", () => {
  const none = new Map();
  it("flags assistant errors and failed tool results", () => {
    expect(
      describeSessionTreeEntry(
        entry("x", null, {
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "rate\nlimited",
          },
        }),
        none,
      ),
    ).toMatchObject({ kind: "assistant", text: "rate limited", error: true });
    expect(
      describeSessionTreeEntry(
        entry("y", null, { message: { role: "toolResult", toolName: "bash", isError: true } }),
        none,
      ),
    ).toMatchObject({ kind: "tool", error: true });
  });
  it("describes non-message entries by their kind", () => {
    expect(
      describeSessionTreeEntry(
        entry("z", null, { type: "compaction", tokensBefore: 12_400 }),
        none,
      ),
    ).toMatchObject({
      kind: "summary",
      text: "12k tokens",
    });
  });
});
