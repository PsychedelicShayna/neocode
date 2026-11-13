import type { TranscriptRow } from "@t3tools/client-runtime/neopi-transcript";

export function formatCost(cost: number): string {
  if (cost === 0) return "$0";
  return cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Elapsed time up to `endIso`, or to now while the agent still runs; empty when unknown. */
export function elapsedBetween(startedAt: string, endIso: string | null): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  return formatDuration((end - start) / 1000);
}

export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface PreviewLine {
  readonly id: string;
  readonly kind: "user" | "assistant" | "tool" | "note";
  readonly text: string;
  readonly error: boolean;
}

const MAX_PREVIEW_CHARS = 600;

function clamp(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_PREVIEW_CHARS ? `${trimmed.slice(0, MAX_PREVIEW_CHARS)}…` : trimmed;
}

/** The last `limit` things worth glancing at in a transcript, oldest first. Reasoning and bookkeeping are skipped. */
export function previewLines(rows: readonly TranscriptRow[], limit: number): PreviewLine[] {
  const lines: PreviewLine[] = [];
  for (let index = rows.length - 1; index >= 0 && lines.length < limit; index--) {
    const row = rows[index]!;
    switch (row.kind) {
      case "user":
        if (row.text.trim())
          lines.push({ id: row.id, kind: "user", text: clamp(row.text), error: false });
        break;
      case "assistant":
        if (row.text.trim())
          lines.push({ id: row.id, kind: "assistant", text: clamp(row.text), error: false });
        break;
      case "tool":
        lines.push({
          id: row.id,
          kind: "tool",
          text: clamp(row.detail ? `${row.label} · ${row.detail}` : row.label),
          error: row.result?.isError === true,
        });
        break;
      case "note":
        lines.push({
          id: row.id,
          kind: "note",
          text: clamp(row.text ? `${row.label}: ${row.text}` : row.label),
          error: row.tone === "error",
        });
        break;
      default:
        break;
    }
  }
  return lines.toReversed();
}
