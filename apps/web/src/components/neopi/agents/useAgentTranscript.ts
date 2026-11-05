import {
  foldAgentTranscript,
  type AgentHubAgent,
  type AgentHubSource,
  type AgentTranscript,
} from "@t3tools/client-runtime/neopi-native-agent-hub";
import { projectTranscript, type TranscriptRow } from "@t3tools/client-runtime/neopi-transcript";
import { useEffect, useMemo, useRef, useState } from "react";
import { createTranscriptCache } from "./agentTranscriptCache";

const REREAD_THROTTLE_MS = 400;
const cache = createTranscriptCache();

export interface AgentTranscriptState {
  readonly rows: readonly TranscriptRow[];
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY_ROWS: readonly TranscriptRow[] = [];

/**
 * An agent's transcript, read incrementally from NeoPi: once on selection, then again
 * (throttled) whenever the agent reports progress, a settled step, or a status change.
 */
export function useAgentTranscript(
  source: Pick<AgentHubSource, "key" | "readTranscript">,
  agent: AgentHubAgent | null,
): AgentTranscriptState {
  const agentId = agent?.id ?? null;
  const cacheKey = agentId === null ? null : `${source.key}\u0000${agentId}`;
  const { readTranscript } = source;
  const [transcript, setTranscript] = useState<AgentTranscript | null>(() =>
    cacheKey === null ? null : cache.get(cacheKey),
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // One reader per selection; a newer selection supersedes a read still in flight.
  const run = useRef({ epoch: 0, reading: 0, again: false });
  const latest = useRef<AgentTranscript | null>(transcript);
  const read = useRef<(() => Promise<void>) | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const epoch = ++run.current.epoch;
    const initial = cacheKey === null ? null : cache.get(cacheKey);
    latest.current = initial;
    setTranscript(initial);
    setError(null);
    if (agentId === null || cacheKey === null) {
      read.current = null;
      setLoading(false);
      return;
    }
    const execute = async () => {
      const state = run.current;
      if (state.reading === epoch) {
        state.again = true;
        return;
      }
      state.reading = epoch;
      setLoading(latest.current === null);
      try {
        do {
          state.again = false;
          const previous = latest.current;
          const result = await readTranscript(agentId, previous?.nextByte ?? 0);
          if (state.epoch !== epoch) return;
          const next = foldAgentTranscript(previous, agentId, result);
          if (next !== null && next !== previous) {
            latest.current = next;
            cache.set(cacheKey, next);
            setTranscript(next);
          }
          setError(null);
        } while (state.again);
      } catch (cause) {
        if (state.epoch === epoch) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (state.reading === epoch) state.reading = 0;
        if (state.epoch === epoch) setLoading(false);
      }
    };
    read.current = execute;
    void execute();
    return () => {
      read.current = null;
      clearTimeout(pending.current);
      pending.current = undefined;
    };
  }, [agentId, cacheKey, readTranscript]);

  const stamp = agent === null ? "" : `${agent.updatedAt}|${agent.ticks}|${agent.status}`;
  useEffect(() => {
    if (stamp === "" || pending.current !== undefined) return;
    // Throttle, not debounce: steady progress frames must not starve the re-read.
    pending.current = setTimeout(() => {
      pending.current = undefined;
      void read.current?.();
    }, REREAD_THROTTLE_MS);
  }, [stamp]);

  const rows = useMemo(
    () =>
      transcript === null
        ? EMPTY_ROWS
        : projectTranscript(
            {
              entries: transcript.entries,
              pending: [],
              leafId: transcript.entries.at(-1)?.id ?? null,
            },
            { debug: false },
          ),
    [transcript],
  );
  return { rows, loading, error };
}
