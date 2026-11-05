/**
 * NeoPi background jobs (`background_jobs` capability): the `get_jobs` inventory,
 * `job_lifecycle` frames and the incremental `get_job_output` reads. Pure
 * projections only; the feed reducer owns when they run.
 */

export const NATIVE_JOBS_CAPABILITY = "background_jobs";

export type NativeJobStatus = "running" | "completed" | "failed" | "cancelled";

export interface NativeJob {
  readonly id: string;
  /** `bash`, `task`, `eval`, `chronicle`, or whatever a newer NeoPi adds. */
  readonly type: string;
  readonly label: string;
  readonly command: string | null;
  readonly status: NativeJobStatus;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly exitCode: number | null;
  readonly error: string | null;
  readonly agentId: string | null;
  readonly outputBytes: number;
}

/** A job plus the feed revision that last observed it, so a late inventory never overwrites a newer frame. */
export interface NativeJobEntry extends NativeJob {
  readonly revision: number;
}

export interface NativeJobs {
  readonly entries: readonly NativeJobEntry[];
  /** NeoPi's own running count (TUI pill rule); null until it has reported one. */
  readonly runningCount: number | null;
  readonly revision: number;
}

export const EMPTY_NATIVE_JOBS: NativeJobs = { entries: [], runningCount: null, revision: 0 };

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : null);
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const JOB_STATUSES: ReadonlySet<unknown> = new Set(["running", "completed", "failed", "cancelled"]);

export function parseNativeJob(value: unknown): NativeJob | null {
  const job = record(value);
  const id = text(job.id);
  const startedAt = count(job.startedAt);
  if (!id || startedAt === null || !JOB_STATUSES.has(job.status)) return null;
  return {
    id,
    type: text(job.type) ?? "job",
    label: text(job.label) ?? text(job.command) ?? id,
    command: text(job.command),
    status: job.status as NativeJobStatus,
    startedAt,
    finishedAt: count(job.finishedAt),
    exitCode: typeof job.exitCode === "number" ? job.exitCode : null,
    error: text(job.error),
    agentId: text(job.agentId),
    outputBytes: count(job.outputBytes) ?? 0,
  };
}

/** A settled job is final; only a fresh registration may reopen its id. */
function supersedes(previous: NativeJobEntry | undefined, next: NativeJob, registered: boolean) {
  return !(previous && previous.status !== "running" && next.status === "running" && !registered);
}

function upsert(
  entries: readonly NativeJobEntry[],
  job: NativeJob,
  revision: number,
): readonly NativeJobEntry[] {
  const entry: NativeJobEntry = { ...job, revision };
  return entries.some((item) => item.id === job.id)
    ? entries.map((item) => (item.id === job.id ? entry : item))
    : [...entries, entry];
}

/** `job_lifecycle` frames: `{ event, job, runningCount }`. Anything else returns `jobs` unchanged. */
export function reduceNativeJobs(
  jobs: NativeJobs,
  frame: Readonly<Record<string, unknown>>,
): NativeJobs {
  if (frame.type !== "job_lifecycle") return jobs;
  const job = parseNativeJob(frame.job);
  if (!job) return jobs;
  const previous = jobs.entries.find((item) => item.id === job.id);
  if (!supersedes(previous, job, frame.event === "registered")) return jobs;
  const revision = jobs.revision + 1;
  return {
    entries: upsert(jobs.entries, job, revision),
    runningCount: count(frame.runningCount) ?? jobs.runningCount,
    revision,
  };
}

/**
 * `get_jobs` response `{ running, recent, runningCount }`. `readRevision` is the
 * feed revision when the read began; jobs a frame touched since then keep the
 * frame's newer state.
 */
export function snapshotNativeJobs(
  jobs: NativeJobs,
  response: unknown,
  readRevision: number,
): NativeJobs {
  const body = record(response);
  if (!Array.isArray(body.running) && !Array.isArray(body.recent)) return jobs;
  const inventory = [
    ...(Array.isArray(body.running) ? body.running : []),
    ...(Array.isArray(body.recent) ? body.recent : []),
  ]
    .map(parseNativeJob)
    .filter((job): job is NativeJob => job !== null);
  const revision = jobs.revision + 1;
  const listed = new Set(inventory.map((job) => job.id));
  const entries: NativeJobEntry[] = [];
  for (const job of inventory) {
    const previous = jobs.entries.find((item) => item.id === job.id);
    entries.push(previous && previous.revision > readRevision ? previous : { ...job, revision });
  }
  // Absent from both lists: it settled and aged out of `recent`, unless a frame just said otherwise.
  for (const previous of jobs.entries)
    if (!listed.has(previous.id) && previous.revision > readRevision) entries.push(previous);
  const reported = count(body.runningCount);
  // A frame that landed during the read carries a newer count than the inventory.
  const runningCount =
    jobs.revision > readRevision && jobs.runningCount !== null
      ? jobs.runningCount
      : (reported ??
        entries.filter((entry) => entry.status === "running" && entry.type !== "task").length);
  // A terminal attachment polls this every few seconds: an inventory that changed
  // nothing must not hand every subscriber a new value.
  if (
    runningCount === jobs.runningCount &&
    entries.length === jobs.entries.length &&
    entries.every((entry, index) => sameJob(entry, jobs.entries[index]!))
  )
    return jobs;
  return { entries, runningCount, revision };
}

function sameJob(a: NativeJobEntry, b: NativeJobEntry) {
  const { revision: _a, ...left } = a;
  const { revision: _b, ...right } = b;
  return (Object.keys(left) as (keyof NativeJob)[]).every((key) => left[key] === right[key]);
}

/** Running jobs first (newest first), then settled ones by most recent finish. */
export function orderNativeJobs(entries: readonly NativeJob[]): readonly NativeJob[] {
  return entries.toSorted((a, b) => {
    const aRunning = a.status === "running";
    const bRunning = b.status === "running";
    if (aRunning !== bRunning) return aRunning ? -1 : 1;
    return aRunning
      ? b.startedAt - a.startedAt
      : (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt);
  });
}

export function nativeJobElapsedMs(job: NativeJob, now: number): number {
  return Math.max(0, (job.finishedAt ?? now) - job.startedAt);
}

/** One job's output as the panel has accumulated it. */
export interface NativeJobOutput {
  readonly jobId: string;
  readonly text: string;
  /** Pass as `fromByte` on the next read. */
  readonly nextByte: number;
}

export const emptyNativeJobOutput = (jobId: string): NativeJobOutput => ({
  jobId,
  text: "",
  nextByte: 0,
});

/**
 * `get_job_output` response `{ jobId, fromByte, nextByte, reset, output }`:
 * the slice appends, unless NeoPi says the snapshot restarted. A response for
 * another job, or one that no longer lines up with what we hold, is dropped.
 */
export function applyNativeJobOutput(current: NativeJobOutput, response: unknown): NativeJobOutput {
  const body = record(response);
  const output = text(body.output);
  const fromByte = count(body.fromByte);
  const nextByte = count(body.nextByte);
  if (body.jobId !== current.jobId || output === null || nextByte === null) return current;
  if (body.reset === true) return { jobId: current.jobId, text: output, nextByte };
  if (fromByte !== current.nextByte) return current;
  return output === "" && nextByte === current.nextByte
    ? current
    : { jobId: current.jobId, text: current.text + output, nextByte };
}
