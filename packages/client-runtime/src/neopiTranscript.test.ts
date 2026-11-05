import type { NeoPiJournalEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  createTranscriptProjector,
  projectTranscript,
  type CommandRow,
  type TranscriptRow,
  type TranscriptSource,
} from "./neopiTranscript.ts";

const text = (value: string) => [{ type: "text", text: value }];
const entry = (id: string, type: string, extra: Record<string, unknown> = {}) =>
  ({ id, parentId: null, type, timestamp: `t${id}`, ...extra }) as unknown as NeoPiJournalEntry;
const message = (id: string, body: Record<string, unknown>) =>
  entry(id, "message", { message: body });
const user = (id: string, value = "hello") => message(id, { role: "user", content: text(value) });
const call = (id: string, callId: string) =>
  message(id, {
    role: "assistant",
    stopReason: "toolUse",
    content: [
      { type: "text", text: `calling ${callId}` },
      { type: "toolCall", id: callId, name: "bash", arguments: { command: `ls ${callId}` } },
    ],
  });
const result = (id: string, callId: string) =>
  message(id, { role: "toolResult", toolCallId: callId, toolName: "bash", content: text("out") });
const reply = (id: string) =>
  message(id, { role: "assistant", stopReason: "stop", content: text(`done ${id}`) });
const modelChange = (id: string) =>
  entry(id, "model_change", { model: "anthropic/claude-opus-5-5" });
const thinkingChange = (id: string) =>
  entry(id, "thinking_level_change", { thinkingLevel: "high" });
const live = (messageId: string, value: string) => ({
  messageId,
  message: { role: "assistant", content: text(value) } as Readonly<Record<string, unknown>>,
});

const source = (
  entries: readonly NeoPiJournalEntry[],
  pending: TranscriptSource["pending"] = [],
): TranscriptSource => ({ entries, pending, leafId: entries.at(-1)?.id ?? null });

/** What the one-shot projection says, with no memory of earlier updates. */
const fresh = (
  input: TranscriptSource,
  options: Parameters<typeof projectTranscript>[1] = { debug: false },
) => projectTranscript(input, options);

describe("createTranscriptProjector", () => {
  const history = [
    user("u1"),
    call("a1", "c1"),
    result("r1", "c1"),
    reply("a2"),
    user("u2"),
    call("a3", "c2"),
    result("r2", "c2"),
    reply("a4"),
  ];

  it("keeps every persisted row as it was while a live message streams", () => {
    const project = createTranscriptProjector();
    const first = project(source(history, [live("m1", "str")]), { debug: false });
    const persistedCount = first.length - 1;
    for (const growth of ["strea", "stream", "streaming on"]) {
      const next = project(source(history, [live("m1", growth)]), { debug: false });
      expect(next).toEqual(fresh(source(history, [live("m1", growth)])));
      expect(next).toHaveLength(first.length);
      for (let index = 0; index < persistedCount; index++) expect(next[index]).toBe(first[index]);
      expect(next.at(-1)).not.toBe(first.at(-1));
    }
  });

  it("keeps a live row while its message is unchanged", () => {
    const project = createTranscriptProjector();
    const pending = [live("m1", "same")];
    const first = project(source(history, pending), { debug: false });
    const second = project(source(history, pending), { debug: false });
    expect(second).toBe(first);
    // A new message object carrying equal content is still the same row.
    const third = project(source(history, [live("m1", "same")]), { debug: false });
    expect(third.at(-1)).toBe(first.at(-1));
  });

  it("returns the persisted rows themselves when nothing is live", () => {
    const project = createTranscriptProjector();
    const first = project(source(history), { debug: false });
    expect(project(source(history), { debug: false })).toBe(first);
  });

  it("resumes from the last entry when an entry is appended, matching a full projection", () => {
    const project = createTranscriptProjector();
    const first = project(source(history.slice(0, 4)), { debug: false });
    const next = project(source(history), { debug: false });
    expect(next).toEqual(fresh(source(history)));
    // Everything before the entry that was last keeps its identity.
    for (let index = 0; index < 2; index++) expect(next[index]).toBe(first[index]);
  });

  it("re-joins a tool result that lands after the call's entry was projected", () => {
    const project = createTranscriptProjector();
    const calls = [user("u1"), call("a1", "c1")];
    project(source(calls), { debug: false });
    const joined = project(source([...calls, result("r1", "c1")]), { debug: false });
    const tool = joined.find((row) => row.kind === "tool");
    expect(tool?.kind === "tool" && tool.result?.text).toBe("out");
    expect(joined).toEqual(fresh(source([...calls, result("r1", "c1")])));
  });

  it("keeps a result joined to its call when more entries follow the result", () => {
    const project = createTranscriptProjector();
    const joined = [user("u1"), call("a1", "c1"), result("r1", "c1")];
    const first = project(source(joined), { debug: false });
    const entries = [...joined, reply("a2")];
    const next = project(source(entries), { debug: false });
    expect(next).toEqual(fresh(source(entries)));
    expect(next.filter((row) => row.kind === "tool")).toHaveLength(1);
    // Nothing that was shown before is replaced by an equal copy.
    for (let index = 0; index < first.length; index++) expect(next[index]).toBe(first[index]);
  });

  it("joins a live tool result onto a persisted call without disturbing the cache", () => {
    const project = createTranscriptProjector();
    const calls = [user("u1"), call("a1", "c1")];
    const pending = [
      {
        messageId: "m2",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "bash",
          content: text("live out"),
        } as Readonly<Record<string, unknown>>,
      },
    ];
    const joined = project(source(calls, pending), { debug: false });
    expect(joined).toEqual(fresh(source(calls, pending)));
    const tool = joined.find((row) => row.kind === "tool");
    expect(tool?.kind === "tool" && tool.result?.text).toBe("live out");
    // Once the pending result is gone the call is open again.
    const open = project(source(calls), { debug: false });
    const openTool = open.find((row) => row.kind === "tool");
    expect(openTool?.kind === "tool" && openTool.result).toBeNull();
  });

  it("merges a model change with the reasoning change that arrives after it", () => {
    const project = createTranscriptProjector();
    const before = [user("u1"), reply("a1"), modelChange("m1")];
    const alone = project(source(before), { debug: false });
    expect(alone.at(-1)).toMatchObject({ kind: "divider", text: "Claude Opus 5.5" });
    const entries = [...before, thinkingChange("l1")];
    const merged = project(source(entries), { debug: false });
    expect(merged).toEqual(fresh(source(entries)));
    expect(merged.at(-1)).toMatchObject({ kind: "divider", text: "Claude Opus 5.5 · high" });
  });

  it("reprojects when the display options change", () => {
    const project = createTranscriptProjector();
    const entries = [user("u1"), entry("x1", "model_usage"), reply("a1")];
    const quiet = project(source(entries), { debug: false });
    const debug = project(source(entries), { debug: true });
    expect(quiet).toEqual(fresh(source(entries)));
    expect(debug).toEqual(fresh(source(entries), { debug: true }));
    expect(debug.length).toBeGreaterThan(quiet.length);
  });

  it("treats command outputs with equal content as unchanged, and picks up real changes", () => {
    const project = createTranscriptProjector();
    const output = (id: string, textValue: string): CommandRow => ({
      kind: "command",
      id,
      text: textValue,
    });
    const outputs = (value: string) =>
      new Map<string | null, ReadonlyArray<CommandRow>>([["a1", [output("c-1", value)]]]);
    const entries = [user("u1"), reply("a1")];
    const first = project(source(entries), { debug: false, commandOutputs: outputs("one") });
    const same = project(source(entries), { debug: false, commandOutputs: outputs("one") });
    expect(same).toBe(first);
    const changed = project(source(entries), { debug: false, commandOutputs: outputs("two") });
    expect(changed).toEqual(
      fresh(source(entries), { debug: false, commandOutputs: outputs("two") }),
    );
    expect(changed.at(-1)).toMatchObject({ kind: "command", text: "two" });
  });

  it("matches a full projection through random growth, branching and live tails", () => {
    let seed = 7;
    const random = (limit: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % limit;
    };
    for (let trial = 0; trial < 60; trial++) {
      const project = createTranscriptProjector();
      let entries: NeoPiJournalEntry[] = [];
      let counter = 0;
      const open: string[] = [];
      const next = () => `n${trial}-${counter++}`;
      for (let step = 0; step < 40; step++) {
        const roll = random(10);
        if (roll === 0) entries = entries.slice(0, random(entries.length + 1));
        else if (roll < 3) entries = [...entries, user(next())];
        else if (roll < 5) {
          const callId = next();
          open.push(callId);
          entries = [...entries, call(next(), callId)];
        } else if (roll < 7 && open.length > 0) {
          entries = [...entries, result(next(), open.splice(random(open.length), 1)[0]!)];
        } else if (roll === 7) entries = [...entries, modelChange(next())];
        else if (roll === 8) entries = [...entries, thinkingChange(next())];
        else entries = [...entries, reply(next())];
        const pending = random(3) === 0 ? [] : [live("p", "x".repeat(random(50)))];
        const debug = random(8) === 0;
        const options = { debug };
        expect(project(source(entries, pending), options)).toEqual(
          fresh(source(entries, pending), options),
        );
      }
    }
  });

  it("falls back to a full projection when a call id repeats", () => {
    const project = createTranscriptProjector();
    const entries = [
      user("u1"),
      call("a1", "dup"),
      result("r1", "dup"),
      call("a2", "dup"),
      reply("a3"),
    ];
    project(source(entries.slice(0, 4)), { debug: false });
    const next = project(source(entries), { debug: false });
    expect(next).toEqual(fresh(source(entries)));
    const tools = next.filter(
      (row): row is Extract<TranscriptRow, { kind: "tool" }> => row.kind === "tool",
    );
    expect(tools.map((row) => row.result !== null)).toEqual([true, false]);
  });
});
