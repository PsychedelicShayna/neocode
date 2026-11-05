/** Where a dictation started, so its text lands there however long the capture ran. */
export interface ComposerDictationAnchor {
  readonly prompt: string;
  /** A cursor in the prompt's expanded coordinates, as `readSnapshot()` reports it. */
  readonly cursor: number;
}

export type ComposerDictationPhase = "idle" | "starting" | "recording" | "transcribing";

/** The composer renders this; the native session owns the capture. */
export interface ComposerDictationControl {
  readonly phase: ComposerDictationPhase;
  /** NeoPi's full live transcript while the capture runs. */
  readonly preview: string;
  readonly notice: string | null;
  /** Why dictation cannot start now and what fixes it; null when it can. */
  readonly unavailableReason: string | null;
  readonly toggle: () => void;
  readonly dismissNotice: () => void;
}

/**
 * The text to splice in at `cursor`. Spoken words never glue onto a neighbouring
 * word; a space is added only where the draft has none.
 */
export function dictationInsertion(prompt: string, cursor: number, text: string): string {
  const spoken = text.trim();
  if (!spoken) return "";
  const before = prompt.slice(0, cursor);
  const after = prompt.slice(cursor);
  return `${before && !/\s$/.test(before) ? " " : ""}${spoken}${after && !/^\s/.test(after) ? " " : ""}`;
}

/** Use the cursor from the start when the draft is unchanged; otherwise the live caret. */
export function dictationCursor(
  anchor: ComposerDictationAnchor,
  prompt: string,
  liveCursor: number,
): number {
  return anchor.prompt === prompt ? Math.min(anchor.cursor, prompt.length) : liveCursor;
}

export function dictationStatusLabel(
  phase: Exclude<ComposerDictationPhase, "idle">,
  shortcut: string | null,
): string {
  switch (phase) {
    case "starting":
      return "Starting the microphone…";
    case "recording":
      return `Listening on this computer · click${shortcut ? ` or ${shortcut}` : ""} to stop, Esc to cancel`;
    case "transcribing":
      return "Finishing the transcript…";
  }
}
