import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  dispatchCommand,
  dispatchKeybindingCommand,
  findCommand,
  registerCommand,
  type CommandHandler,
} from "../../commandTable";
import {
  EX_LINE_INITIAL,
  editExLine,
  exLineKey,
  matchExSessions,
  parseExLine,
  resolveExLine,
  sessionCompletionQuery,
  type ExLineCommands,
  type ExLineContext,
} from "./exLine.logic";

function table(entries: Record<string, Partial<CommandHandler>>, terminalFocusedLast = false) {
  return {
    find: (command: string) => {
      const entry = Object.hasOwn(entries, command) ? entries[command] : undefined;
      return entry ? { label: command, available: () => true, run: vi.fn(), ...entry } : undefined;
    },
    terminalFocusedLast,
  } satisfies ExLineCommands;
}

const sessions = [
  { key: "a", title: "Fix the login form", detail: "Ada" },
  { key: "b", title: "Release notes", detail: "Grace" },
  { key: "c", title: "Login telemetry", detail: "Linus" },
];

function context(overrides: Partial<ExLineContext> = {}): ExLineContext {
  return { matches: [], history: [], commands: table({}), ...overrides };
}

describe("parseExLine", () => {
  it("splits the name from its argument and ignores a typed colon", () => {
    expect(parseExLine("split")).toEqual({ name: "split", argument: "" });
    expect(parseExLine(" :b  login form ")).toEqual({ name: "b", argument: "login form" });
    expect(parseExLine("sidebar.toggle")).toEqual({ name: "sidebar.toggle", argument: "" });
    expect(parseExLine("")).toBeNull();
    expect(parseExLine(" : ")).toBeNull();
  });
});

describe("resolveExLine", () => {
  const commands = table({
    "terminal.split": {},
    "terminal.splitVertical": {},
    "terminal.new": {},
    "chat.new": {},
    "sidebar.toggle": {},
    "diff.toggle": { label: "Toggle diff", available: () => false },
  });

  it("maps the Vim names to the commands they stand for", () => {
    expect(resolveExLine("split", commands)).toEqual({ kind: "run", command: "terminal.split" });
    expect(resolveExLine(":vsplit", commands)).toEqual({
      kind: "run",
      command: "terminal.splitVertical",
    });
    expect(resolveExLine("new", commands)).toEqual({ kind: "run", command: "terminal.new" });
    expect(resolveExLine("ene", commands)).toEqual({ kind: "run", command: "chat.new" });
  });

  it("runs any command id the table holds, and nothing else", () => {
    expect(resolveExLine("sidebar.toggle", commands)).toEqual({
      kind: "run",
      command: "sidebar.toggle",
    });
    expect(resolveExLine("wq", commands)).toEqual({ kind: "error", message: "Not a command: wq" });
    expect(resolveExLine("constructor", commands)).toEqual({
      kind: "error",
      message: "Not a command: constructor",
    });
    expect(resolveExLine("split now", commands)).toEqual({
      kind: "error",
      message: ":split takes no argument",
    });
  });

  it("names a command that is unavailable here instead of running it", () => {
    expect(resolveExLine("diff.toggle", commands)).toEqual({
      kind: "error",
      message: "Toggle diff is not available here",
    });
  });

  it("closes the last-focused terminal with :q, else the panel tab", () => {
    const both = { "terminal.close": {}, "rightPanel.close": {} };
    expect(resolveExLine("q", table(both, true))).toEqual({
      kind: "run",
      command: "terminal.close",
    });
    expect(resolveExLine("q", table(both, false))).toEqual({
      kind: "run",
      command: "rightPanel.close",
    });
    const terminalGone = { "terminal.close": { available: () => false }, "rightPanel.close": {} };
    expect(resolveExLine("q", table(terminalGone, true))).toEqual({
      kind: "run",
      command: "rightPanel.close",
    });
    expect(resolveExLine("q", table({ "rightPanel.close": { available: () => false } }))).toEqual({
      kind: "error",
      message: "Nothing to close",
    });
  });
});

describe(":b session completion", () => {
  it("starts once a space follows b", () => {
    expect(sessionCompletionQuery("b ")).toBe("");
    expect(sessionCompletionQuery(":b login  ")).toBe("login");
    expect(sessionCompletionQuery("b")).toBeNull();
    expect(sessionCompletionQuery("bn")).toBeNull();
    expect(sessionCompletionQuery("split")).toBeNull();
  });

  it("matches every word against the title and agent, keeping tab order", () => {
    expect(matchExSessions(sessions, "LOGIN").map((session) => session.key)).toEqual(["a", "c"]);
    expect(matchExSessions(sessions, "login ada").map((session) => session.key)).toEqual(["a"]);
    expect(matchExSessions(sessions, "grace").map((session) => session.key)).toEqual(["b"]);
    expect(matchExSessions(sessions, "")).toHaveLength(3);
    expect(matchExSessions(sessions, "nothing")).toEqual([]);
  });

  it("only moves the pick on Tab and the arrows, and switches on Enter", () => {
    const run = vi.fn();
    const ctx = context({ matches: sessions, commands: table({ "terminal.split": { run } }) });
    let state = editExLine("b ");
    for (const key of ["Tab", "ArrowDown", "ShiftTab", "Tab", "ArrowUp", "Tab"] as const) {
      const step = exLineKey(state, key, ctx);
      expect(step.effect).toBeNull();
      state = step.state;
    }
    expect(state.selected).toBe(2);
    expect(run).not.toHaveBeenCalled();

    expect(exLineKey(state, "Enter", ctx).effect).toEqual({ kind: "switchSession", key: "c" });
  });

  it("says so, and stays open, when no session matches", () => {
    const step = exLineKey(editExLine("b zzz"), "Enter", context());
    expect(step.effect).toBeNull();
    expect(step.state.message).toBe("No session matches");
  });
});

describe("exLineKey", () => {
  it("keeps the line open with the reason when a command cannot run", () => {
    const step = exLineKey(editExLine("wq"), "Enter", context());
    expect(step.effect).toBeNull();
    expect(step.state).toMatchObject({ text: "wq", message: "Not a command: wq" });
    expect(editExLine("w").message).toBeNull();
  });

  it("runs on Enter, closes on Escape and on an empty line", () => {
    const ctx = context({ commands: table({ "terminal.split": {} }) });
    expect(exLineKey(editExLine("split"), "Enter", ctx).effect).toEqual({
      kind: "run",
      command: "terminal.split",
    });
    expect(exLineKey(editExLine("split"), "Escape", ctx).effect).toEqual({ kind: "close" });
    expect(exLineKey(EX_LINE_INITIAL, "Enter", ctx).effect).toEqual({ kind: "close" });
  });

  it("steps back through earlier lines and returns to what was typed", () => {
    const ctx = context({ history: ["vsplit", "split"] });
    let state = editExLine("ne");
    state = exLineKey(state, "ArrowUp", ctx).state;
    expect(state.text).toBe("vsplit");
    state = exLineKey(state, "ArrowUp", ctx).state;
    expect(state.text).toBe("split");
    state = exLineKey(state, "ArrowUp", ctx).state;
    expect(state.text).toBe("split");
    state = exLineKey(state, "ArrowDown", ctx).state;
    state = exLineKey(state, "ArrowDown", ctx).state;
    expect(state.text).toBe("ne");
  });
});

describe("one handler behind every entry point", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it("reaches the same handler from a keybinding and from :split", () => {
    const run = vi.fn();
    cleanups.push(
      registerCommand("terminal.split", "workspace", {
        label: "Split terminal",
        available: () => true,
        run,
      }),
    );
    const event = { repeat: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    dispatchKeybindingCommand("terminal.split", event, "workspace");

    const step = exLineKey(
      editExLine("split"),
      "Enter",
      context({ commands: { find: findCommand, terminalFocusedLast: false } }),
    );
    expect(step.effect).toEqual({ kind: "run", command: "terminal.split" });
    if (step.effect?.kind === "run") dispatchCommand(step.effect.command);

    expect(run).toHaveBeenCalledTimes(2);
  });
});
