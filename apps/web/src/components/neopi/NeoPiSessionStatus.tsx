import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { projectNeoPiSessionStatus } from "@t3tools/client-runtime/neopi-session-status";
import { AsyncResult } from "effect/unstable/reactivity";
import { useThreadShell } from "../../state/entities";
import { neopiSessionConfigurationChanges } from "../../state/neopiSessions";

export function useNeoPiSessionStatus(threadRef: ScopedThreadRef) {
  const thread = useThreadShell(threadRef);
  const result = useAtomValue(neopiSessionConfigurationChanges({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  }));
  if (AsyncResult.isFailure(result)) {
    return { status: "unavailable" as const, reason: "Native session status is unavailable. Reconnect to read it again." };
  }
  if (!AsyncResult.isSuccess(result) || result.value === null) {
    return { status: "loading" as const, reason: "Reading native session status..." };
  }
  return projectNeoPiSessionStatus(result.value,
    thread?.session !== null && thread?.session !== undefined &&
    thread.session.status !== "stopped" && thread.session.status !== "error");
}

export function NeoPiSessionStatus({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  return threadRef ? <ConnectedStatus key={JSON.stringify(threadRef)} threadRef={threadRef} /> : null;
}

function ConnectedStatus({ threadRef }: { threadRef: ScopedThreadRef }) {
  const status = useNeoPiSessionStatus(threadRef);
  if (status.status !== "observed") {
    return <span className="text-xs text-muted-foreground" title={status.reason}>
      {status.status === "loading" ? "Reading session..." : status.status === "stale" ? "Session disconnected · stale status" : "Session status unavailable"}
    </span>;
  }
  const observed = `Observed ${new Date(status.observedAt).toLocaleTimeString()}. Native session ${status.sessionId}. ${status.attachment === "terminal" ? "Terminal-owned, NeoCode attached." : "NeoCode-owned."}`;
  const nativeModel = status.model ? `${status.model.provider}/${status.model.id}` : "Model not reported";
  return (
    <div role="group" aria-label="Native session status" tabIndex={0} className="flex min-w-0 items-center gap-3 overflow-x-auto whitespace-nowrap text-xs tabular-nums text-muted-foreground [&>span]:shrink-0" title={`${observed} ${nativeModel}, effort ${status.thinkingLevel ?? "not reported"}.`}>
      <span>{status.attachment === "terminal" ? "Attached" : "Owned"}</span>
      <span title={`Native output throughput. ${observed}`}>
        {status.tokensPerSecond === null ? "tok/s unavailable" : `${status.tokensPerSecond.toFixed(1)} tok/s`}
      </span>
      <span title={`Cache reads / all recorded prompt tokens, across the session journal. ${observed}`}>
        {status.cacheHitPercent === null ? "Cache unavailable" : `Cache ${status.cacheHitPercent.toFixed(0)}%`}
      </span>
      <span className="inline-flex items-center gap-1.5" title={status.context
        ? `${status.context.tokens?.toLocaleString() ?? "Unknown"} / ${status.context.contextWindow.toLocaleString()} context tokens. ${observed}`
        : `Native context utilization is not reported. ${observed}`}>
        {status.context ? <>
          <span role="meter" aria-label="Context utilization" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, status.context.percent)} aria-valuetext={`${status.context.percent.toFixed(1)}%`} className="h-1 w-10 overflow-hidden rounded-full bg-muted">
            <span className="block h-full bg-primary" style={{ width: `${Math.min(100, status.context.percent)}%` }} />
          </span>
          {status.context.percent.toFixed(0)}% context
        </> : "Context unavailable"}
      </span>
      <span title={`Recorded session cost across all branches, including completed task results and advisors. Unfinished child spend is not included. ${observed}`}>
        {status.recordedCost !== null ? `$${status.recordedCost.toFixed(2)} recorded` : status.costState === "restoring" ? "Cost restoring..." : "Cost unavailable"}
      </span>
      <time dateTime={status.observedAt} className="sr-only">{observed}</time>
    </div>
  );
}
