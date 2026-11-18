import {
  type KeybindingCommand,
  keybindingRuleSteps,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type ModelPickerJumpKeybindingCommand,
  type ThreadJumpKeybindingCommand,
} from "@t3tools/contracts";
import { isElectron } from "./env";
import { isMacPlatform } from "./lib/utils";
import { isEditableFocused } from "./lib/editableFocus";
import { isExLineFocused, isGuardedRepeat } from "./lib/exLineFocus";
import { getTerminalFocusOwner, isTerminalInputFocused } from "./lib/terminalFocus";

export interface ShortcutEventLike {
  getModifierState?: (key: "AltGraph") => boolean;
  type?: string;
  code?: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** Called for a keypress that begins a bound sequence, which no other handler should act on. */
  preventDefault?: () => void;
  /** An auto-repeat of a held key: it never starts or completes a sequence. */
  repeat?: boolean;
  /** Present on React's synthetic events: the browser event they wrap. */
  nativeEvent?: unknown;
}

export interface ShortcutModifierStateLike {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutMatchContext {
  terminalFocus: boolean;
  terminalOpen: boolean;
  previewFocus: boolean;
  previewOpen: boolean;
  isWeb: boolean;
  isDesktop: boolean;
  /** A text field, textarea, select or rich-text editor owns the keyboard.
      Optional: only chords that collide with native editing consult it. */
  editableFocus?: boolean;
  [key: string]: boolean;
}

interface ShortcutMatchOptions {
  platform?: string;
  context?: Partial<ShortcutMatchContext>;
}

interface ResolvedShortcutLabelOptions extends ShortcutMatchOptions {
  platform?: string;
}

const TERMINAL_WORD_BACKWARD = "\u001bb";
const TERMINAL_WORD_FORWARD = "\u001bf";
const TERMINAL_LINE_START = "\u0001";
const TERMINAL_LINE_END = "\u0005";
const TERMINAL_DELETE_TO_LINE_START = "\u0015";
const EVENT_CODE_SHORTCUT_KEYS: Readonly<Record<string, string>> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

function normalizeEventKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized === "esc") return "escape";
  return normalized;
}

export function shortcutKeyFromEvent(event: Pick<ShortcutEventLike, "key" | "code">): string {
  const layoutKey = normalizeEventKey(event.key);
  if (/^[a-z]$/.test(layoutKey)) return layoutKey;
  const physicalKey = event.code ? EVENT_CODE_SHORTCUT_KEYS[event.code] : undefined;
  return physicalKey ?? layoutKey;
}

function resolveEventKeys(event: ShortcutEventLike): Set<string> {
  const layoutKey = normalizeEventKey(event.key);
  const keys = new Set([layoutKey]);
  // The physical-position fallback exists for layouts that type non-Latin
  // letters (Cyrillic, Greek) and for Option-modified symbols on macOS.
  // When the layout already produces a Latin letter, match on it alone;
  // otherwise a remapped physical key triggers shortcuts for two different
  // letters at once and shadows system shortcuts on non-QWERTY layouts.
  const letterCode = event.code?.match(/^Key([A-Z])$/)?.[1];
  if (letterCode && !/^[a-z]$/.test(layoutKey)) {
    keys.add(letterCode.toLowerCase());
  }
  keys.add(shortcutKeyFromEvent(event));
  return keys;
}

function matchesShortcutModifiers(
  event: ShortcutModifierStateLike,
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): boolean {
  const useMetaForMod = isMacPlatform(platform);
  const expectedMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const expectedCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  return (
    event.metaKey === expectedMeta &&
    event.ctrlKey === expectedCtrl &&
    event.shiftKey === shortcut.shiftKey &&
    event.altKey === shortcut.altKey
  );
}

export function matchesShortcut(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): boolean {
  if (
    !isMacPlatform(platform) &&
    event.getModifierState?.("AltGraph") &&
    !/^[a-z0-9]$/i.test(event.key)
  )
    return false;
  if (!matchesShortcutModifiers(event, shortcut, platform)) return false;
  return resolveEventKeys(event).has(shortcut.key);
}

function resolvePlatform(options: ShortcutMatchOptions | undefined): string {
  return options?.platform ?? navigator.platform;
}

function resolveContext(options: ShortcutMatchOptions | undefined): ShortcutMatchContext {
  return {
    terminalFocus: false,
    terminalOpen: false,
    previewFocus: false,
    previewOpen: false,
    isWeb: !isElectron,
    isDesktop: isElectron,
    editableFocus: false,
    ...options?.context,
  };
}

function evaluateWhenNode(node: KeybindingWhenNode, context: ShortcutMatchContext): boolean {
  switch (node.type) {
    case "identifier":
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      return Boolean(context[node.name]);
    case "not":
      return !evaluateWhenNode(node.node, context);
    case "and":
      return evaluateWhenNode(node.left, context) && evaluateWhenNode(node.right, context);
    case "or":
      return evaluateWhenNode(node.left, context) || evaluateWhenNode(node.right, context);
  }
}

function matchesWhenClause(
  whenAst: KeybindingWhenNode | undefined,
  context: ShortcutMatchContext,
): boolean {
  if (!whenAst) return true;
  return evaluateWhenNode(whenAst, context);
}

export function shortcutConflictKey(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): string {
  const useMetaForMod = isMacPlatform(platform);
  const metaKey = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const ctrlKey = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  return [
    shortcut.key,
    metaKey ? "meta" : "",
    ctrlKey ? "ctrl" : "",
    shortcut.shiftKey ? "shift" : "",
    shortcut.altKey ? "alt" : "",
  ].join("|");
}

function stepsConflictKey(
  steps: ReadonlyArray<KeybindingShortcut>,
  platform = navigator.platform,
): string {
  return steps.map((step) => shortcutConflictKey(step, platform)).join(" ");
}

function findEffectiveStepsForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): ReadonlyArray<KeybindingShortcut> | null {
  const platform = resolvePlatform(options);
  const context = resolveContext(options);
  const claimedShortcuts = new Set<string>();

  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;

    const steps = keybindingRuleSteps(binding);
    const conflictKey = stepsConflictKey(steps, platform);
    if (claimedShortcuts.has(conflictKey)) {
      continue;
    }

    claimedShortcuts.add(conflictKey);
    if (binding.command === command) {
      return steps;
    }
  }

  return null;
}

const MODIFIER_KEYS: Readonly<Record<string, true>> = {
  Control: true,
  Shift: true,
  Alt: true,
  Meta: true,
  AltGraph: true,
};

/** Whether the keydown is a bare modifier, which never ends or breaks a sequence. */
export function isModifierKeyEvent(event: Pick<ShortcutEventLike, "key">): boolean {
  return MODIFIER_KEYS[event.key] === true;
}

interface PageFocus {
  readonly editableFocus: boolean;
  readonly terminalFocus: boolean;
}

function readPageFocus(): PageFocus {
  if (typeof document === "undefined") return { editableFocus: false, terminalFocus: false };
  return {
    editableFocus: isEditableFocused(),
    terminalFocus: getTerminalFocusOwner() !== null,
  };
}

type SequenceRule = Extract<ResolvedKeybindingRule, { readonly sequence: unknown }>;

/**
 * Sequence state shared by every caller. Several listeners resolve the same
 * keydown, each with its own context, so state advances once per keydown
 * (keyed by the browser event): every listener sees the same held chord and
 * the same page focus, read once from the page rather than from a caller's
 * context, which may omit it.
 */
let sequenceKeydown: unknown = null;
let sequenceKeydownFocus: PageFocus = { editableFocus: false, terminalFocus: false };
/** Rules the previous keydown armed: the only ones this keydown may complete. */
let sequenceKeydownHeld: ReadonlyArray<SequenceRule> = [];
/** Rules this keydown arms, in priority order, across all its listeners. */
let sequenceKeydownArmed: SequenceRule[] = [];

/**
 * Any focus change cancels a first chord before its second: nothing armed so
 * far carries over to the next keydown. A keydown already being resolved
 * keeps what it holds, so its listeners still agree.
 */
function dropArmedSequences(): void {
  sequenceKeydownArmed = [];
}

let focusWatchedDocument: Document | null = null;

function watchFocusChanges(): void {
  if (typeof document === "undefined" || document === focusWatchedDocument) return;
  if (typeof document.addEventListener !== "function") return;
  focusWatchedDocument = document;
  document.addEventListener("focusin", dropArmedSequences, true);
  document.addEventListener("focusout", dropArmedSequences, true);
  document.defaultView?.addEventListener("blur", dropArmedSequences);
}

/** Moves the state to this keydown: what the previous keydown armed is now held. */
function advanceSequence(event: ShortcutEventLike): PageFocus {
  watchFocusChanges();
  const identity = event.nativeEvent ?? event;
  if (identity !== sequenceKeydown) {
    sequenceKeydown = identity;
    sequenceKeydownFocus = readPageFocus();
    sequenceKeydownHeld = sequenceKeydownArmed;
    sequenceKeydownArmed = [];
  }
  return sequenceKeydownFocus;
}

/** A key that types a character into a focused field, which a sequence must never take. */
function typesText(event: ShortcutEventLike): boolean {
  return !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1;
}

/**
 * The command bound to this keypress, or null. A focused terminal takes every
 * key for the program running in it, so nothing resolves while it has focus;
 * this is read from the page, whatever the caller's context claims.
 *
 * A keypress that begins a two-chord sequence resolves to null, is prevented
 * and arms exactly the sequence rules eligible at that moment. The next
 * keypress completes one of those if it still applies and matches the second
 * chord. Any other keypress, or a focus change in between, drops the held
 * chord. There is no timeout. Sequence rules see `editableFocus` and
 * `terminalFocus` as the page reports them, so every listener agrees, and a
 * plain character typed into a field never begins a sequence.
 */
export function resolveShortcutCommand(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): KeybindingCommand | null {
  if (event.type !== undefined && event.type !== "keydown") return null;
  if (isModifierKeyEvent(event)) return null;
  const focus = advanceSequence(event);
  if (isTerminalInputFocused()) return null;
  // Listeners on the window run before the document's repeat guard.
  if (isGuardedRepeat(event)) return null;
  // The Ex line's keys are its own: there, only a modified single chord resolves.
  const exLineFocus = isExLineFocused();
  if (exLineFocus && !event.ctrlKey && !event.metaKey && !event.altKey) return null;
  const platform = resolvePlatform(options);
  const context = resolveContext(options);
  const sequenceContext = {
    ...context,
    editableFocus: focus.editableFocus,
    terminalFocus: focus.terminalFocus,
  };

  if (event.repeat && !exLineFocus) {
    // Holding the first chord down keeps it held, as the terminal escape does.
    const stillHeld = sequenceKeydownHeld.filter((binding) =>
      matchesShortcut(event, binding.sequence[0], platform),
    );
    if (stillHeld.length > 0) {
      for (const rule of stillHeld) {
        if (!sequenceKeydownArmed.includes(rule)) sequenceKeydownArmed.push(rule);
      }
      event.preventDefault?.();
      return null;
    }
  } else if (!exLineFocus) {
    for (const binding of sequenceKeydownHeld) {
      if (!matchesWhenClause(binding.whenAst, sequenceContext)) continue;
      if (!matchesShortcut(event, binding.sequence[1], platform)) continue;
      return binding.command;
    }
  }

  const armable = (binding: ResolvedKeybindingRule | undefined): binding is SequenceRule =>
    binding !== undefined &&
    "sequence" in binding &&
    matchesWhenClause(binding.whenAst, sequenceContext) &&
    matchesShortcut(event, binding.sequence[0], platform);
  const mayBeginSequence = !exLineFocus && !(focus.editableFocus && typesText(event));
  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding) continue;
    if ("sequence" in binding) {
      if (event.repeat || !mayBeginSequence || !armable(binding)) continue;
      for (let armed = index; armed >= 0; armed -= 1) {
        const rule = keybindings[armed];
        if (armable(rule) && !sequenceKeydownArmed.includes(rule)) sequenceKeydownArmed.push(rule);
      }
      event.preventDefault?.();
      return null;
    }
    if (!matchesWhenClause(binding.whenAst, context)) continue;
    if (!matchesShortcut(event, binding.shortcut, platform)) continue;
    return binding.command;
  }
  return null;
}

/**
 * Commands a focused terminal still acts on, as terminal emulators own them
 * rather than pass them to the program: leaving the terminal and its font size.
 */
export const TERMINAL_KEYBINDING_COMMANDS = [
  "terminal.leaveFocus",
  "terminal.fontSize.increase",
  "terminal.fontSize.decrease",
  "terminal.fontSize.reset",
] as const satisfies ReadonlyArray<KeybindingCommand>;
export type TerminalKeybindingCommand = (typeof TERMINAL_KEYBINDING_COMMANDS)[number];

export function isTerminalKeybindingCommand(
  command: KeybindingCommand,
): command is TerminalKeybindingCommand {
  return (TERMINAL_KEYBINDING_COMMANDS as ReadonlyArray<KeybindingCommand>).includes(command);
}

export type TerminalKeybindingRule = ResolvedKeybindingRule & {
  readonly command: TerminalKeybindingCommand;
};

/**
 * The terminal-owned rules that apply while a terminal has focus, most
 * recent first, so the first match wins as it does for every other rule.
 */
export function terminalKeybindingRules(
  keybindings: ResolvedKeybindingsConfig,
): ReadonlyArray<TerminalKeybindingRule> {
  const context = resolveContext({ context: { terminalFocus: true, terminalOpen: true } });
  const rules: TerminalKeybindingRule[] = [];
  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding || !isTerminalKeybindingCommand(binding.command)) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;
    rules.push({ ...binding, command: binding.command });
  }
  return rules;
}

export function formatShortcutKeyLabel(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  if (key === "escape") return "Esc";
  if (key === "arrowup") return "Up";
  if (key === "arrowdown") return "Down";
  if (key === "arrowleft") return "Left";
  if (key === "arrowright") return "Right";
  return key.slice(0, 1).toUpperCase() + key.slice(1);
}

export function formatShortcutLabel(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): string {
  const keyLabel = formatShortcutKeyLabel(shortcut.key);
  const useMetaForMod = isMacPlatform(platform);
  const showMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const showCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  const showAlt = shortcut.altKey;
  const showShift = shortcut.shiftKey;

  if (useMetaForMod) {
    return `${showCtrl ? "\u2303" : ""}${showAlt ? "\u2325" : ""}${showShift ? "\u21e7" : ""}${showMeta ? "\u2318" : ""}${keyLabel}`;
  }

  const parts: string[] = [];
  if (showCtrl) parts.push("Ctrl");
  if (showAlt) parts.push("Alt");
  if (showShift) parts.push("Shift");
  if (showMeta) parts.push("Meta");
  parts.push(keyLabel);
  return parts.join("+");
}

/** A rule's chords as one label, a sequence's chords separated by a space. */
export function formatKeybindingStepsLabel(
  steps: ReadonlyArray<KeybindingShortcut>,
  platform = navigator.platform,
): string {
  return steps.map((step) => formatShortcutLabel(step, platform)).join(" ");
}

export function shortcutLabelForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand | null,
  options?: string | ResolvedShortcutLabelOptions,
): string | null {
  if (command === null) return null;
  const resolvedOptions =
    typeof options === "string"
      ? ({ platform: options } satisfies ResolvedShortcutLabelOptions)
      : options;
  const platform = resolvePlatform(resolvedOptions);
  const steps = findEffectiveStepsForCommand(keybindings, command, resolvedOptions);
  return steps ? formatKeybindingStepsLabel(steps, platform) : null;
}

export function threadJumpCommandForIndex(index: number): ThreadJumpKeybindingCommand | null {
  return THREAD_JUMP_KEYBINDING_COMMANDS[index] ?? null;
}

export function threadJumpIndexFromCommand(command: string): number | null {
  const index = THREAD_JUMP_KEYBINDING_COMMANDS.indexOf(command as ThreadJumpKeybindingCommand);
  return index === -1 ? null : index;
}

export function threadTraversalDirectionFromCommand(
  command: string | null,
): "previous" | "next" | null {
  if (command === "thread.previous") return "previous";
  if (command === "thread.next") return "next";
  return null;
}

export function shouldShowThreadJumpHintsForModifiers(
  modifiers: ShortcutModifierStateLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  // The embedded terminal owns keystrokes while it has focus: the Ghostty
  // surface encodes the keydown and can write the pressed key into the shell
  // before our window-level shortcut handling ever runs, regardless of any
  // configured `when` clause on the jump command. Advertising jump hints
  // here would promise a shortcut that instead types into the terminal, so
  // never show them while the terminal is focused.
  if (resolveContext(options).terminalFocus) {
    return false;
  }

  const platform = resolvePlatform(options);

  for (const command of THREAD_JUMP_KEYBINDING_COMMANDS) {
    const steps = findEffectiveStepsForCommand(keybindings, command, options);
    const first = steps?.[0];
    // Holding a modifier previews single-chord jumps only.
    if (first === undefined || steps?.length !== 1) continue;
    if (matchesShortcutModifiers(modifiers, first, platform)) {
      return true;
    }
  }

  return false;
}

export function modelPickerJumpCommandForIndex(
  index: number,
): ModelPickerJumpKeybindingCommand | null {
  return MODEL_PICKER_JUMP_KEYBINDING_COMMANDS[index] ?? null;
}

export function modelPickerJumpIndexFromCommand(command: string): number | null {
  const index = MODEL_PICKER_JUMP_KEYBINDING_COMMANDS.indexOf(
    command as ModelPickerJumpKeybindingCommand,
  );
  return index === -1 ? null : index;
}

/**
 * Whether the keypress is the rich-text bold chord (Mod+B without extra
 * modifiers). Tiptap binds the same chord, so app shortcuts captured ahead
 * of the editor must yield when the rich-text composer is focused.
 */
export function isRichTextBoldShortcut(event: ShortcutEventLike): boolean {
  if (event.type !== undefined && event.type !== "keydown") {
    return false;
  }
  return (
    resolveEventKeys(event).has("b") &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

export function isTerminalClearShortcut(
  event: ShortcutEventLike,
  platform = navigator.platform,
): boolean {
  if (event.type !== undefined && event.type !== "keydown") {
    return false;
  }

  const key = event.key.toLowerCase();

  if (key === "l" && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    return true;
  }

  return (
    isMacPlatform(platform) &&
    key === "k" &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

export function terminalDeleteShortcutData(
  event: ShortcutEventLike,
  platform = navigator.platform,
): string | null {
  if (event.type !== undefined && event.type !== "keydown") {
    return null;
  }

  if (!isMacPlatform(platform)) {
    return null;
  }

  const key = normalizeEventKey(event.key);
  if (key !== "backspace") {
    return null;
  }

  return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    ? TERMINAL_DELETE_TO_LINE_START
    : null;
}

/**
 * The bytes to send for a macOS Cmd/Option+Arrow, which a terminal would not
 * otherwise receive. Elsewhere the program gets the real Ctrl/Alt+Arrow.
 */
export function terminalNavigationShortcutData(
  event: ShortcutEventLike,
  platform = navigator.platform,
): string | null {
  if (event.type !== undefined && event.type !== "keydown") {
    return null;
  }

  if (event.shiftKey || !isMacPlatform(platform)) return null;

  const key = normalizeEventKey(event.key);
  if (key !== "arrowleft" && key !== "arrowright") {
    return null;
  }

  if (event.altKey && !event.metaKey && !event.ctrlKey) {
    return key === "arrowleft" ? TERMINAL_WORD_BACKWARD : TERMINAL_WORD_FORWARD;
  }
  if (event.metaKey && !event.altKey && !event.ctrlKey) {
    return key === "arrowleft" ? TERMINAL_LINE_START : TERMINAL_LINE_END;
  }
  return null;
}
