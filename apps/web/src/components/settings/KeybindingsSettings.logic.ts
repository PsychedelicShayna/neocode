import {
  STATIC_KEYBINDING_COMMANDS,
  type KeybindingCommand,
  keybindingRuleSteps,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  parseKeybindingSteps,
  parseKeybindingWhenExpression,
} from "@t3tools/shared/keybindings";

import {
  isTerminalKeybindingCommand,
  shortcutConflictKey,
  shortcutKeyFromEvent,
} from "../../keybindings";
import { isMacPlatform } from "../../lib/utils";

export type KeybindingSource = "Default" | "Custom" | "Project";

export interface KeybindingRow {
  readonly id: string;
  readonly command: KeybindingCommand;
  readonly key: string;
  readonly when: string;
  readonly source: KeybindingSource;
  readonly defaultKey: string | null;
  readonly defaultWhen: string;
  readonly binding: ResolvedKeybindingRule;
  /** Position among the resolved rules: of two matching rules, the later one wins. */
  readonly order: number;
  readonly conflicts: ReadonlyArray<string>;
}

export type WhenVariableOption = string;
export type KeybindingCommandOption = KeybindingCommand;

const CORE_WHEN_VARIABLES = [
  "terminalFocus",
  "terminalOpen",
  "isWeb",
  "isDesktop",
  "true",
  "false",
] as const;

const DEFAULT_WHEN_VARIABLES = new Set<string>(CORE_WHEN_VARIABLES);
for (const binding of DEFAULT_RESOLVED_KEYBINDINGS) {
  collectWhenIdentifiersFromNode(binding.whenAst, DEFAULT_WHEN_VARIABLES);
}

export const DEFAULT_WHEN_VARIABLE =
  [...DEFAULT_WHEN_VARIABLES].find(
    (identifier) => identifier !== "true" && identifier !== "false",
  ) ?? "terminalFocus";
const KNOWN_WHEN_VARIABLES = new Set(DEFAULT_WHEN_VARIABLES);

export function shortcutToKeybindingInput(shortcut: KeybindingShortcut): string {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("mod");
  if (shortcut.metaKey) parts.push("meta");
  if (shortcut.ctrlKey) parts.push("ctrl");
  if (shortcut.altKey) parts.push("alt");
  if (shortcut.shiftKey) parts.push("shift");
  parts.push(shortcut.key === " " ? "space" : shortcut.key === "escape" ? "esc" : shortcut.key);
  return parts.join("+");
}

export function whenAstToExpression(node: KeybindingWhenNode | undefined): string {
  if (!node) return "";
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!${wrapWhenExpression(node.node)}`;
    case "and":
      return `${wrapWhenExpression(node.left)} && ${wrapWhenExpression(node.right)}`;
    case "or":
      return `${wrapWhenExpression(node.left)} || ${wrapWhenExpression(node.right)}`;
  }
}

export function whenNodeRemoveLabel(node: KeybindingWhenNode, depth: number): string {
  if (depth === 0) return "Clear all conditions";
  if (node.type === "identifier" || (node.type === "not" && node.node.type === "identifier")) {
    return "Remove condition";
  }
  return "Remove group and its conditions";
}

function wrapWhenExpression(node: KeybindingWhenNode): string {
  if (node.type === "identifier" || node.type === "not") return whenAstToExpression(node);
  return `(${whenAstToExpression(node)})`;
}

export function parseWhenExpressionDraft(
  expression: string,
): { ok: true; value: KeybindingWhenNode | undefined } | { ok: false; message: string } {
  const trimmed = expression.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };

  const ast = parseKeybindingWhenExpression(trimmed);
  if (!ast) {
    return {
      ok: false,
      message: "Use variables with !, &&, ||, and parentheses.",
    };
  }

  return { ok: true, value: ast };
}

function sourceForBinding(binding: ResolvedKeybindingRule): KeybindingSource {
  if (String(binding.command).startsWith("script.")) {
    return "Project";
  }

  const bindingKey = keybindingRuleInput(binding);
  const bindingWhen = whenAstToExpression(binding.whenAst);
  const isDefault = DEFAULT_RESOLVED_KEYBINDINGS.some(
    (entry) =>
      entry.command === binding.command &&
      keybindingRuleInput(entry) === bindingKey &&
      whenAstToExpression(entry.whenAst) === bindingWhen,
  );

  return isDefault ? "Default" : "Custom";
}

function defaultBindingForBinding(
  binding: ResolvedKeybindingRule,
): ResolvedKeybindingRule | undefined {
  const bindingKey = keybindingRuleInput(binding);
  const bindingWhen = whenAstToExpression(binding.whenAst);

  return (
    DEFAULT_RESOLVED_KEYBINDINGS.find(
      (entry) =>
        entry.command === binding.command &&
        keybindingRuleInput(entry) === bindingKey &&
        whenAstToExpression(entry.whenAst) === bindingWhen,
    ) ??
    DEFAULT_RESOLVED_KEYBINDINGS.find(
      (entry) =>
        entry.command === binding.command && whenAstToExpression(entry.whenAst) === bindingWhen,
    ) ??
    DEFAULT_RESOLVED_KEYBINDINGS.find((entry) => entry.command === binding.command)
  );
}

/** One chord's keycaps (`mod+shift+k` → mod, shift, k), keeping a literal `+` key whole. */
export function keybindingChordParts(chord: string): ReadonlyArray<string> {
  if (chord === "+") return ["+"];
  if (chord.endsWith("++")) return [...chord.slice(0, -2).split("+"), "+"];
  return chord.split("+");
}

/** A rule's `key` as the settings show and save it; a sequence's chords are space-separated. */
export function keybindingRuleInput(binding: ResolvedKeybindingRule): string {
  return keybindingRuleSteps(binding).map(shortcutToKeybindingInput).join(" ");
}

function keybindingRowId(command: KeybindingCommand, key: string, when: string): string {
  return `${command}\u0000${key}\u0000${when}`;
}

function evaluateWhen(
  node: KeybindingWhenNode | undefined,
  values: Readonly<Record<string, boolean>>,
): boolean {
  if (!node) return true;
  switch (node.type) {
    case "identifier":
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      return values[node.name] === true;
    case "not":
      return !evaluateWhen(node.node, values);
    case "and":
      return evaluateWhen(node.left, values) && evaluateWhen(node.right, values);
    case "or":
      return evaluateWhen(node.left, values) || evaluateWhen(node.right, values);
  }
}

// Beyond this many distinct variables in a pair of conditions, they are
// assumed to overlap rather than enumerated.
const MAX_ENUMERATED_WHEN_VARIABLES = 12;

/**
 * Every state the context keys of two conditions can be in together. The
 * app never reports the web and desktop app at once, nor keyboard focus in a
 * terminal and the preview at once, so those states are left out. Null when
 * there are too many variables to enumerate.
 */
function whenStates(
  left: KeybindingWhenNode | undefined,
  right: KeybindingWhenNode | undefined,
): Array<Record<string, boolean>> | null {
  const identifiers = new Set<string>();
  collectWhenIdentifiersFromNode(left, identifiers);
  collectWhenIdentifiersFromNode(right, identifiers);
  identifiers.delete("true");
  identifiers.delete("false");
  const names = [...identifiers];
  if (names.length > MAX_ENUMERATED_WHEN_VARIABLES) return null;
  const states: Array<Record<string, boolean>> = [];
  for (let mask = 0; mask < 1 << names.length; mask += 1) {
    const values: Record<string, boolean> = {};
    names.forEach((name, index) => {
      values[name] = (mask & (1 << index)) !== 0;
    });
    const webAndDesktop = identifiers.has("isWeb") && identifiers.has("isDesktop");
    if (webAndDesktop && values.isWeb === values.isDesktop) continue;
    if (values.terminalFocus && values.previewFocus) continue;
    states.push(values);
  }
  return states;
}

interface ConflictCandidate {
  readonly command: KeybindingCommand | null;
  readonly steps: ReadonlyArray<string>;
  readonly whenAst: KeybindingWhenNode | undefined;
  readonly order: number;
}

/**
 * Whether two rules compete for the same keypress: the same chords, or one
 * rule's chord is the first chord of the other's sequence, under conditions
 * that can hold at once. A focused terminal acts only on its own commands
 * (leaving it, font size), so a key one of those holds there is reserved:
 * any other rule on it conflicts. Otherwise the later rule wins, and a later
 * rule whose condition only narrows the earlier one's is a deliberate
 * override, not a conflict.
 */
function rulesConflict(left: ConflictCandidate, right: ConflictCandidate): boolean {
  const [shorter, longer] = left.steps.length <= right.steps.length ? [left, right] : [right, left];
  const clash =
    shorter.steps.length === longer.steps.length
      ? shorter.steps.every((step, index) => step === longer.steps[index])
      : shorter.steps[0] === longer.steps[0];
  if (!clash) return false;

  const states = whenStates(left.whenAst, right.whenAst);
  if (!states) return true;
  const applyTogether = states.some(
    (values) => evaluateWhen(left.whenAst, values) && evaluateWhen(right.whenAst, values),
  );
  if (!applyTogether) return false;

  const leftTerminal = left.command !== null && isTerminalKeybindingCommand(left.command);
  const rightTerminal = right.command !== null && isTerminalKeybindingCommand(right.command);
  if (leftTerminal !== rightTerminal) return true;

  const [earlier, later] = left.order <= right.order ? [left, right] : [right, left];
  const laterImpliesEarlier = states.every(
    (values) => !evaluateWhen(later.whenAst, values) || evaluateWhen(earlier.whenAst, values),
  );
  const earlierAlone = states.some(
    (values) => evaluateWhen(earlier.whenAst, values) && !evaluateWhen(later.whenAst, values),
  );
  return !(laterImpliesEarlier && earlierAlone);
}

/**
 * Labels of the commands whose rules compete with a binding being edited, as
 * `rulesConflict` defines it. A draft has no command until one is chosen and
 * is saved as the last rule unless `order` says otherwise.
 */
export function keybindingConflictLabels(
  rows: ReadonlyArray<KeybindingRow>,
  input: {
    readonly rowId: string;
    readonly key: string;
    readonly when: string;
    readonly command?: KeybindingCommand | null;
    readonly order?: number;
  },
  platform = navigator.platform,
): ReadonlyArray<string> {
  const steps = input.key.trim().length === 0 ? null : parseKeybindingSteps(input.key);
  if (!steps) return [];
  const when = input.when.trim();
  const whenAst = when.length === 0 ? undefined : parseKeybindingWhenExpression(when);
  if (whenAst === null) return [];
  const draft: ConflictCandidate = {
    command: input.command ?? null,
    steps: steps.map((step) => shortcutConflictKey(step, platform)),
    whenAst,
    order: input.order ?? Number.POSITIVE_INFINITY,
  };
  const conflicts: Array<string> = [];
  for (const candidate of rows) {
    if (candidate.id === input.rowId) continue;
    const other: ConflictCandidate = {
      command: candidate.command,
      steps: keybindingRuleSteps(candidate.binding).map((step) =>
        shortcutConflictKey(step, platform),
      ),
      whenAst: candidate.binding.whenAst,
      order: candidate.order,
    };
    if (rulesConflict(draft, other)) conflicts.push(commandLabel(candidate.command));
  }
  return [...new Set(conflicts)].toSorted();
}

export function buildKeybindingRows(
  keybindings: ResolvedKeybindingsConfig,
  query: string,
): ReadonlyArray<KeybindingRow> {
  const normalizedQuery = query.trim().toLowerCase();
  const rows = keybindings.map((binding, index) => {
    const defaultBinding = defaultBindingForBinding(binding);
    const key = keybindingRuleInput(binding);
    const when = whenAstToExpression(binding.whenAst);
    return {
      id: `${keybindingRowId(binding.command, key, when)}\u0000${index}`,
      command: binding.command,
      key,
      when,
      source: sourceForBinding(binding),
      defaultKey: defaultBinding ? keybindingRuleInput(defaultBinding) : null,
      defaultWhen: whenAstToExpression(defaultBinding?.whenAst),
      binding,
      order: index,
      conflicts: [],
    } satisfies KeybindingRow;
  });

  const rowsWithConflicts = rows.map((row) => {
    const conflicts = keybindingConflictLabels(rows, {
      rowId: row.id,
      key: row.key,
      when: row.when,
      command: row.command,
      order: row.order,
    });
    return conflicts.length > 0
      ? Object.assign({}, row, { conflicts: [...new Set(conflicts)].toSorted() })
      : row;
  });

  rowsWithConflicts.sort((left, right) => {
    const commandCompare = left.command.localeCompare(right.command);
    if (commandCompare !== 0) return commandCompare;
    return left.key.localeCompare(right.key);
  });

  if (normalizedQuery.length === 0) {
    return rowsWithConflicts;
  }

  return rowsWithConflicts.filter((row) => {
    return (
      row.command.toLowerCase().includes(normalizedQuery) ||
      commandLabel(row.command).toLowerCase().includes(normalizedQuery) ||
      row.key.toLowerCase().includes(normalizedQuery) ||
      row.when.toLowerCase().includes(normalizedQuery) ||
      row.source.toLowerCase().includes(normalizedQuery)
    );
  });
}

function collectWhenIdentifiersFromNode(
  node: KeybindingWhenNode | undefined,
  identifiers: Set<string>,
): void {
  if (!node) return;
  switch (node.type) {
    case "identifier":
      identifiers.add(node.name);
      return;
    case "not":
      collectWhenIdentifiersFromNode(node.node, identifiers);
      return;
    case "and":
    case "or":
      collectWhenIdentifiersFromNode(node.left, identifiers);
      collectWhenIdentifiersFromNode(node.right, identifiers);
      return;
  }
}

export function isKnownWhenVariable(identifier: string): boolean {
  return KNOWN_WHEN_VARIABLES.has(identifier);
}

export function unknownWhenVariables(node: KeybindingWhenNode | undefined): ReadonlyArray<string> {
  const identifiers = new Set<string>();
  collectWhenIdentifiersFromNode(node, identifiers);
  return [...identifiers].filter((identifier) => !isKnownWhenVariable(identifier)).toSorted();
}

export function buildWhenVariableOptions(): ReadonlyArray<WhenVariableOption> {
  return [...KNOWN_WHEN_VARIABLES].toSorted((left, right) => {
    const leftCoreIndex = CORE_WHEN_VARIABLES.indexOf(left as (typeof CORE_WHEN_VARIABLES)[number]);
    const rightCoreIndex = CORE_WHEN_VARIABLES.indexOf(
      right as (typeof CORE_WHEN_VARIABLES)[number],
    );
    if (leftCoreIndex !== -1 || rightCoreIndex !== -1) {
      return (
        (leftCoreIndex === -1 ? Number.MAX_SAFE_INTEGER : leftCoreIndex) -
        (rightCoreIndex === -1 ? Number.MAX_SAFE_INTEGER : rightCoreIndex)
      );
    }
    return left.localeCompare(right);
  });
}

export function buildKeybindingCommandOptions(
  keybindings: ResolvedKeybindingsConfig,
): ReadonlyArray<KeybindingCommandOption> {
  const commands = new Set<KeybindingCommand>(STATIC_KEYBINDING_COMMANDS);
  for (const binding of keybindings) {
    commands.add(binding.command);
  }
  return [...commands].toSorted((left, right) =>
    commandLabel(left).localeCompare(commandLabel(right)),
  );
}

export function commandLabel(command: KeybindingCommand): string {
  if (command === "thread.copyReference") return "Pull Request: Copy Link or Thread ID";
  const raw = String(command);
  if (raw.startsWith("script.") && raw.endsWith(".run")) {
    return `Run Script: ${titleCaseCommandSegment(raw.slice("script.".length, -".run".length))}`;
  }
  return raw.split(".").map(titleCaseCommandSegment).join(": ");
}

function titleCaseCommandSegment(segment: string): string {
  const words: Array<string> = [];
  for (const part of segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[-_\s]+/)) {
    if (part.length > 0) {
      words.push(part.slice(0, 1).toUpperCase() + part.slice(1));
    }
  }
  return words.join(" ");
}

function normalizeShortcutKeyToken(key: string): string | null {
  const normalized = key.toLowerCase();
  if (
    normalized === "meta" ||
    normalized === "control" ||
    normalized === "ctrl" ||
    normalized === "shift" ||
    normalized === "alt" ||
    normalized === "option"
  ) {
    return null;
  }
  if (normalized === " ") return "space";
  if (normalized === "escape") return "esc";
  if (normalized === "arrowup") return "arrowup";
  if (normalized === "arrowdown") return "arrowdown";
  if (normalized === "arrowleft") return "arrowleft";
  if (normalized === "arrowright") return "arrowright";
  if (normalized.length === 1) return normalized;
  if (/^f\d{1,2}$/.test(normalized)) return normalized;
  if (normalized === "enter" || normalized === "tab" || normalized === "backspace") {
    return normalized;
  }
  if (normalized === "delete" || normalized === "home" || normalized === "end") {
    return normalized;
  }
  if (normalized === "pageup" || normalized === "pagedown") return normalized;
  return null;
}

type RecordedKeyEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

function chordFromKeyboardEvent(
  event: RecordedKeyEvent,
  platform: string,
  requireModifier: boolean,
): string | null {
  const keyToken = normalizeShortcutKeyToken(shortcutKeyFromEvent(event));
  if (!keyToken) return null;

  const parts: string[] = [];
  if (isMacPlatform(platform)) {
    if (event.metaKey) parts.push("mod");
    if (event.ctrlKey) parts.push("ctrl");
  } else {
    if (event.ctrlKey) parts.push("mod");
    if (event.metaKey) parts.push("meta");
  }
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (requireModifier && parts.length === 0) {
    return null;
  }
  parts.push(keyToken);
  return parts.join("+");
}

export function keybindingFromKeyboardEvent(
  event: RecordedKeyEvent,
  platform: string,
): string | null {
  return chordFromKeyboardEvent(event, platform, true);
}

/**
 * One keypress while recording a binding. The first chord needs a modifier;
 * the press after it becomes the second chord of a sequence (`ctrl+w h`), or
 * plain Enter keeps the first chord alone. `done` ends the recording. Null
 * for a press that records nothing, such as a bare modifier or an
 * auto-repeat of a held key.
 */
export function recordKeybindingStep(
  firstStep: string | null,
  event: RecordedKeyEvent & { readonly repeat?: boolean },
  platform: string,
): { readonly key: string; readonly done: boolean } | null {
  if (event.repeat) return null;
  if (firstStep === null) {
    const chord = chordFromKeyboardEvent(event, platform, true);
    return chord ? { key: chord, done: false } : null;
  }
  const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  if (bare && event.key === "Enter") return { key: firstStep, done: true };
  const chord = chordFromKeyboardEvent(event, platform, false);
  return chord ? { key: `${firstStep} ${chord}`, done: true } : null;
}
