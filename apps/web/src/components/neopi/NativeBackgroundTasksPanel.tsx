/**
 * Background tasks right-panel surface: NeoPi's background jobs (bash, task,
 * eval, ...) with live status, incremental output and cancel. Inventory and
 * `job_lifecycle` frames live in the session feed; this panel only reads output
 * and sends `cancel_job`.
 */
import {
  NATIVE_JOBS_CAPABILITY,
  applyNativeJobOutput,
  emptyNativeJobOutput,
  nativeJobElapsedMs,
  orderNativeJobs,
  type NativeJob,
} from "@t3tools/client-runtime/neopi-native-jobs";
import type {
  NativeSessionFeed,
  NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { formatActiveDuration } from "@t3tools/client-runtime/neopi-native-status";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { useNativeSessionRequest, useNativeSessionSlice } from "../../state/neopiNativeSessions";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

const selectJobs = (feed: NativeSessionFeed) => feed.jobs;
const selectCapabilities = (feed: NativeSessionFeed) => feed.session?.capabilities;
const selectConnected = (feed: NativeSessionFeed) => feed.connected;
const selectFeedError = (feed: NativeSessionFeed) => feed.error;
const selectJobsError = (feed: NativeSessionFeed) =>
  feed.reconciliationError?.operation === "jobs" ? feed.reconciliationError.message : null;

const STATUS_BADGE = {
  running: { variant: "info", label: "Running" },
  completed: { variant: "success", label: "Completed" },
  failed: { variant: "error", label: "Failed" },
  cancelled: { variant: "outline", label: "Cancelled" },
} as const;

/** While a job runs its output is read again this often, beside every progress frame. */
const OUTPUT_POLL_MS = 2000;

/** A running job's elapsed time self-ticks by DOM writes; a settled job freezes. */
function JobElapsed({ job }: { job: NativeJob }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const running = job.status === "running";
  useEffect(() => {
    if (!running) return;
    const update = () => {
      if (textRef.current)
        textRef.current.textContent = formatActiveDuration(nativeJobElapsedMs(job, Date.now()));
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [running, job]);
  return (
    <span ref={textRef} className="tabular-nums">
      {formatActiveDuration(nativeJobElapsedMs(job, Date.now()))}
    </span>
  );
}

function JobRow(props: {
  readonly job: NativeJob;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { job } = props;
  const status = STATUS_BADGE[job.status];
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      onClick={props.onSelect}
      className={cn(
        "flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        props.selected ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <span className="shrink-0 font-mono text-muted-foreground">{job.id}</span>
        <Badge variant="outline" size="sm">
          {job.type}
        </Badge>
        <Badge variant={status.variant} size="sm">
          {status.label}
        </Badge>
        <span className="ml-auto shrink-0 text-muted-foreground">
          <JobElapsed job={job} />
        </span>
      </span>
      <span className="truncate font-mono text-xs" title={job.command ?? job.label}>
        {job.label}
      </span>
    </button>
  );
}

function JobDetail(props: {
  readonly job: NativeJob;
  readonly request: ReturnType<typeof useNativeSessionRequest>;
  readonly cancellable: boolean;
}) {
  const { job, request } = props;
  const accumulated = useRef(emptyNativeJobOutput(job.id));
  const [outputText, setOutputText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const reading = useRef(false);
  const viewport = useRef<HTMLPreElement>(null);
  const stickToEnd = useRef(true);
  const running = job.status === "running";

  const read = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const response = await request({
        type: "get_job_output",
        jobId: job.id,
        fromByte: accumulated.current.nextByte,
      });
      setError(null);
      const next = applyNativeJobOutput(accumulated.current, response);
      if (next !== accumulated.current) {
        accumulated.current = next;
        setOutputText(next.text);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      reading.current = false;
    }
  }, [request, job.id]);

  // A progress frame or a status change means there is more output to read.
  useEffect(() => {
    void read();
  }, [read, job.status, job.outputBytes]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void read(), OUTPUT_POLL_MS);
    return () => clearInterval(timer);
  }, [running, read]);
  useEffect(() => {
    const element = viewport.current;
    if (element && stickToEnd.current) element.scrollTop = element.scrollHeight;
  }, [outputText]);

  const cancel = () => {
    setCancelling(true);
    setError(null);
    request({ type: "cancel_job", jobId: job.id })
      .then((response) => {
        const cancelled = (response as { cancelled?: unknown } | null)?.cancelled === true;
        if (!cancelled) setError("NeoPi did not cancel this job. It may already have finished.");
        // A terminal-attached session carries no lifecycle frame for the change.
        return request({ type: "get_jobs" });
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setCancelling(false));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 border-t border-border/60 p-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono" title={job.command ?? job.label}>
          {job.command ?? job.label}
        </span>
        {running ? (
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={!props.cancellable || cancelling}
            onClick={cancel}
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </Button>
        ) : null}
      </div>
      {job.status !== "running" && (job.exitCode !== null || job.error) ? (
        <p className="text-xs text-muted-foreground">
          {job.exitCode !== null ? `Exit code ${job.exitCode}. ` : ""}
          {job.error ?? ""}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      <pre
        ref={viewport}
        aria-label={`Output of ${job.id}`}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-xs break-words whitespace-pre-wrap"
      >
        {outputText || (running ? "No output yet." : "No output.")}
      </pre>
    </div>
  );
}

export function NativeBackgroundTasksPanel({ target }: { target: NativeSessionTarget }) {
  const capabilities = useNativeSessionSlice(target, selectCapabilities);
  const connected = useNativeSessionSlice(target, selectConnected);
  const jobs = useNativeSessionSlice(target, selectJobs);
  const feedError = useNativeSessionSlice(target, selectFeedError);
  const reconciliationError = useNativeSessionSlice(target, selectJobsError);
  const request = useNativeSessionRequest(target);
  const supported = capabilities?.includes(NATIVE_JOBS_CAPABILITY) === true;
  const ordered = useMemo(() => orderNativeJobs(jobs.entries), [jobs.entries]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = ordered.find((job) => job.id === selectedId) ?? ordered[0] ?? null;
  const [inventoryRead, setInventoryRead] = useState<{
    request: typeof request;
    pending: boolean;
    ready: boolean;
    error: string | null;
  } | null>(null);
  const readGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++readGeneration.current;
    setInventoryRead({ request, pending: true, ready: false, error: null });
    try {
      await request({ type: "get_jobs" });
      if (generation === readGeneration.current)
        setInventoryRead({ request, pending: false, ready: true, error: null });
    } catch (cause) {
      if (generation === readGeneration.current)
        setInventoryRead({
          request,
          pending: false,
          ready: false,
          error: cause instanceof Error ? cause.message : String(cause),
        });
    }
  }, [request]);

  // Opening the panel reads a fresh inventory; frames keep it current afterwards.
  useEffect(() => {
    if (supported && connected) void refresh();
    return () => {
      readGeneration.current++;
    };
  }, [supported, connected, refresh]);

  const currentRead = inventoryRead?.request === request ? inventoryRead : null;
  const error = currentRead?.error ?? reconciliationError;
  const known = currentRead?.ready === true;
  const retry = (
    <Button
      size="xs"
      variant="outline"
      disabled={!connected || currentRead?.pending}
      onClick={() => void refresh()}
    >
      Retry
    </Button>
  );
  const notice = error ? (
    <div role="alert" className="flex items-center gap-2 p-3 text-xs text-destructive-foreground">
      <span className="flex-1">Could not refresh background tasks: {error}</span>
      {retry}
    </div>
  ) : !connected ? (
    <p role="status" className="p-3 text-xs text-muted-foreground">
      Disconnected. Reconnect this session to refresh background tasks.
    </p>
  ) : null;

  if (capabilities === undefined)
    return (
      <div
        role={feedError ? "alert" : "status"}
        className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground"
      >
        {feedError
          ? `Could not load background tasks: ${feedError}`
          : "Loading background task capabilities…"}
      </div>
    );
  if (!supported)
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Background tasks need a newer NeoPi. Update NeoPi to list, inspect and cancel its background
        jobs here.
      </div>
    );
  if (ordered.length === 0) {
    if (notice) return notice;
    return (
      <div
        role="status"
        className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground"
      >
        {known
          ? "No background tasks yet. Commands NeoPi runs in the background appear here."
          : "Loading background tasks…"}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {notice}
      <div className="max-h-[40%] shrink-0 overflow-y-auto">
        <ul className="flex flex-col gap-0.5 p-1">
          {ordered.map((job) => (
            <li key={job.id}>
              <JobRow
                job={job}
                selected={job.id === selected?.id}
                onSelect={() => setSelectedId(job.id)}
              />
            </li>
          ))}
        </ul>
      </div>
      {selected ? (
        <JobDetail key={selected.id} job={selected} request={request} cancellable={connected} />
      ) : null}
    </div>
  );
}
