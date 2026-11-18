import type { CommandHandler } from "../../commandTable";

/**
 * The Vim names, each standing for the existing command it maps to. A Map, so
 * a typed name never reaches Object.prototype.
 */
const EX_ALIASES: ReadonlyMap<string, string> = new Map([
  ["split", "terminal.split"],
  ["vsplit", "terminal.splitVertical"],
  ["new", "terminal.new"],
  ["ene", "chat.new"],
]);

export interface ExLineCommands {
  /** The dispatch table's handler for a command id. */
  readonly find: (command: string) => CommandHandler | undefined;
  /** Whether a terminal had focus at some point, so `:q` closes it rather than a panel tab. */
  readonly terminalFocusedLast: boolean;
}

export type ExLineAction =
  | { readonly kind: "run"; readonly command: string }
  | { readonly kind: "error"; readonly message: string };

export function parseExLine(text: string): { name: string; argument: string } | null {
  const match = /^:*\s*([^\s:]\S*)\s*(.*)$/s.exec(text.trim());
  if (!match) return null;
  return { name: match[1] ?? "", argument: (match[2] ?? "").trim() };
}

/**
 * What a typed line runs: one of the Vim names, or any command id the
 * dispatch table holds. `:b` is handled by session completion, not here.
 */
export function resolveExLine(text: string, commands: ExLineCommands): ExLineAction | null {
  const parsed = parseExLine(text);
  if (!parsed) return null;
  const { name, argument } = parsed;
  if (name === "b") return { kind: "error", message: "Type a space after :b to pick a session" };
  if (name === "q") {
    if (argument !== "") return { kind: "error", message: ":q takes no argument" };
    // The close action for the surface used last: its terminal while one is open, else the panel tab.
    const command =
      commands.terminalFocusedLast && commands.find("terminal.close")?.available()
        ? "terminal.close"
        : "rightPanel.close";
    return commands.find(command)?.available()
      ? { kind: "run", command }
      : { kind: "error", message: "Nothing to close" };
  }
  const command = EX_ALIASES.get(name) ?? name;
  const handler = commands.find(command);
  if (!handler) return { kind: "error", message: `Not a command: ${name}` };
  if (argument !== "") return { kind: "error", message: `:${name} takes no argument` };
  if (!handler.available()) {
    return { kind: "error", message: `${handler.label} is not available here` };
  }
  return { kind: "run", command };
}

/** The session search typed after `:b `, or null while the line is not a `:b` command. */
export function sessionCompletionQuery(text: string): string | null {
  const match = /^\s*:*\s*b\s(.*)$/s.exec(text);
  return match ? (match[1] ?? "").trim() : null;
}

export interface ExSessionOption {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
}

/** Sessions whose title or agent name holds every word of the query, in tab order. */
export function matchExSessions<T extends ExSessionOption>(
  options: readonly T[],
  query: string,
): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return options.filter((option) => {
    const haystack = `${option.title} ${option.detail}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export interface ExLineState {
  readonly text: string;
  readonly selected: number;
  readonly message: string | null;
  /** Position in the history while stepping through it, newest first; null when editing. */
  readonly historyIndex: number | null;
  /** What was typed before stepping into the history. */
  readonly draft: string;
}

export const EX_LINE_INITIAL: ExLineState = {
  text: "",
  selected: 0,
  message: null,
  historyIndex: null,
  draft: "",
};

export function editExLine(text: string): ExLineState {
  return { ...EX_LINE_INITIAL, text };
}

export type ExLineKey = "Enter" | "Escape" | "Tab" | "ShiftTab" | "ArrowUp" | "ArrowDown";

export type ExLineEffect =
  | { readonly kind: "close" }
  | { readonly kind: "run"; readonly command: string }
  | { readonly kind: "switchSession"; readonly key: string };

export interface ExLineContext {
  /** Sessions matching the `:b` query, empty while the line is not a `:b` command. */
  readonly matches: readonly ExSessionOption[];
  /** Earlier lines, newest first. */
  readonly history: readonly string[];
  readonly commands: ExLineCommands;
}

/**
 * Applies one key. Tab and the arrows only move through the `:b` matches or
 * the history; nothing runs before Enter.
 */
export function exLineKey(
  state: ExLineState,
  key: ExLineKey,
  context: ExLineContext,
): { state: ExLineState; effect: ExLineEffect | null } {
  const completing = sessionCompletionQuery(state.text) !== null;
  const count = context.matches.length;
  switch (key) {
    case "Escape":
      return { state, effect: { kind: "close" } };
    case "Tab":
    case "ShiftTab":
    case "ArrowUp":
    case "ArrowDown": {
      if (completing) {
        if (count === 0) return { state, effect: null };
        const step = key === "Tab" || key === "ArrowDown" ? 1 : -1;
        return {
          state: { ...state, selected: (state.selected + step + count) % count },
          effect: null,
        };
      }
      if (key === "Tab" || key === "ShiftTab") return { state, effect: null };
      return {
        state: stepHistory(state, key === "ArrowUp" ? 1 : -1, context.history),
        effect: null,
      };
    }
    case "Enter": {
      if (completing) {
        const match = context.matches[Math.min(state.selected, count - 1)];
        if (!match) return { state: { ...state, message: "No session matches" }, effect: null };
        return { state, effect: { kind: "switchSession", key: match.key } };
      }
      const action = resolveExLine(state.text, context.commands);
      if (!action) return { state, effect: { kind: "close" } };
      if (action.kind === "error")
        return { state: { ...state, message: action.message }, effect: null };
      return { state, effect: { kind: "run", command: action.command } };
    }
  }
}

function stepHistory(state: ExLineState, step: 1 | -1, history: readonly string[]): ExLineState {
  const next = (state.historyIndex ?? -1) + step;
  if (next >= history.length) return state;
  if (next < 0) return { ...state, text: state.draft, historyIndex: null, message: null };
  return {
    ...state,
    text: history[next] ?? "",
    historyIndex: next,
    draft: state.historyIndex === null ? state.text : state.draft,
    message: null,
  };
}
