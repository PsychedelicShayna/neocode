import type { AgentTranscript } from "@t3tools/client-runtime/neopi-native-agent-hub";

export interface TranscriptCacheLimits {
  readonly maxEntries: number;
  /** Total bytes of transcript read so far (`nextByte`, the size of the source file), across entries. */
  readonly maxBytes: number;
  /** An entry untouched this long is dropped. */
  readonly ttlMs: number;
}

export const DEFAULT_TRANSCRIPT_CACHE_LIMITS: TranscriptCacheLimits = {
  maxEntries: 16,
  maxBytes: 4 * 1024 * 1024,
  ttlMs: 10 * 60_000,
};

/**
 * Transcripts already read, so switching back to an agent continues from its cursor, not
 * byte 0. Least recently used entries go first once the count or byte budget is exceeded
 * or an entry goes stale; the entry just written is always kept, so the agent on screen
 * never loses its cursor however large it grows.
 */
export function createTranscriptCache(
  limits: TranscriptCacheLimits = DEFAULT_TRANSCRIPT_CACHE_LIMITS,
  now: () => number = Date.now,
) {
  const entries = new Map<string, { transcript: AgentTranscript; touchedAt: number }>();
  const evict = () => {
    const at = now();
    // The newest entry is last; it is exempt from every rule below.
    const keys = [...entries.keys()];
    const newest = keys.at(-1);
    let bytes = 0;
    for (const key of keys) bytes += entries.get(key)!.transcript.nextByte;
    for (const key of keys) {
      if (key === newest) break;
      const entry = entries.get(key)!;
      if (
        at - entry.touchedAt > limits.ttlMs ||
        entries.size > limits.maxEntries ||
        bytes > limits.maxBytes
      ) {
        entries.delete(key);
        bytes -= entry.transcript.nextByte;
      }
    }
  };
  return {
    get(key: string): AgentTranscript | null {
      const entry = entries.get(key);
      if (!entry) return null;
      if (now() - entry.touchedAt > limits.ttlMs) {
        entries.delete(key);
        return null;
      }
      entries.delete(key);
      entries.set(key, { transcript: entry.transcript, touchedAt: now() });
      return entry.transcript;
    },
    set(key: string, transcript: AgentTranscript) {
      entries.delete(key);
      entries.set(key, { transcript, touchedAt: now() });
      evict();
    },
    get size() {
      return entries.size;
    },
  };
}
