import { describe, expect, it } from "vite-plus/test";
import {
  EMPTY_NATIVE_JOBS,
  applyNativeJobOutput,
  emptyNativeJobOutput,
  nativeJobElapsedMs,
  nativeJobOutputRequest,
  orderNativeJobs,
  parseNativeJob,
  reduceNativeJobs,
  snapshotNativeJobs,
} from "./neopiNativeJobs.ts";

const job = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "bash",
  label: `run ${id}`,
  command: `sleep ${id}`,
  status: "running",
  startedAt: 1_000,
  outputBytes: 0,
  ...extra,
});
const frame = (event: string, value: unknown, runningCount?: number) => ({
  type: "job_lifecycle",
  event,
  job: value,
  ...(runningCount === undefined ? {} : { runningCount }),
});

describe("native job lifecycle", () => {
  it("registers, progresses and settles a job, tracking NeoPi's running count", () => {
    let jobs = reduceNativeJobs(EMPTY_NATIVE_JOBS, frame("registered", job("bg_1"), 1));
    jobs = reduceNativeJobs(jobs, frame("progress", job("bg_1", { outputBytes: 40 }), 1));
    expect(jobs.entries).toHaveLength(1);
    expect(jobs.entries[0]?.outputBytes).toBe(40);
    jobs = reduceNativeJobs(
      jobs,
      frame("completed", job("bg_1", { status: "completed", finishedAt: 5_000, exitCode: 0 }), 0),
    );
    expect(jobs.entries[0]).toMatchObject({ status: "completed", finishedAt: 5_000, exitCode: 0 });
    expect(jobs.runningCount).toBe(0);
  });

  it("does not let a late progress frame reopen a settled job", () => {
    let jobs = reduceNativeJobs(EMPTY_NATIVE_JOBS, frame("registered", job("bg_1")));
    jobs = reduceNativeJobs(jobs, frame("failed", job("bg_1", { status: "failed" })));
    const late = reduceNativeJobs(jobs, frame("progress", job("bg_1")));
    expect(late).toBe(jobs);
    expect(reduceNativeJobs(jobs, frame("registered", job("bg_1"))).entries[0]?.status).toBe(
      "running",
    );
  });

  it("ignores other frames and malformed jobs", () => {
    expect(reduceNativeJobs(EMPTY_NATIVE_JOBS, { type: "agent_end" })).toBe(EMPTY_NATIVE_JOBS);
    expect(reduceNativeJobs(EMPTY_NATIVE_JOBS, frame("registered", { id: "x" }))).toBe(
      EMPTY_NATIVE_JOBS,
    );
    expect(parseNativeJob(job("bg_1", { status: "paused" }))).toBeNull();
  });
});

describe("native job inventory", () => {
  it("replaces the list and takes NeoPi's running count", () => {
    const jobs = snapshotNativeJobs(
      EMPTY_NATIVE_JOBS,
      {
        running: [job("bg_2")],
        recent: [job("bg_1", { status: "completed", finishedAt: 2_000 })],
        runningCount: 1,
      },
      0,
    );
    expect(jobs.entries.map((entry) => entry.id)).toEqual(["bg_2", "bg_1"]);
    expect(jobs.runningCount).toBe(1);
  });

  it("keeps a frame that landed while the read was in flight", () => {
    const before = reduceNativeJobs(EMPTY_NATIVE_JOBS, frame("registered", job("bg_1"), 1));
    const readRevision = before.revision;
    const during = reduceNativeJobs(
      before,
      frame("completed", job("bg_1", { status: "completed", finishedAt: 3_000 }), 0),
    );
    const merged = snapshotNativeJobs(
      during,
      { running: [job("bg_1")], recent: [], runningCount: 1 },
      readRevision,
    );
    expect(merged.entries[0]?.status).toBe("completed");
    expect(merged.runningCount).toBe(0);
  });

  it("drops a running job the inventory no longer lists and ignores a malformed response", () => {
    const before = reduceNativeJobs(EMPTY_NATIVE_JOBS, frame("registered", job("bg_1"), 1));
    const merged = snapshotNativeJobs(
      before,
      { running: [], recent: [], runningCount: 0 },
      before.revision,
    );
    expect(merged.entries).toEqual([]);
    expect(snapshotNativeJobs(before, { error: "nope" }, before.revision)).toBe(before);
  });

  it("orders running jobs first, then the most recently finished", () => {
    const parsed = [
      job("old", { status: "completed", finishedAt: 2_000 }),
      job("new", { status: "failed", finishedAt: 9_000 }),
      job("live", { startedAt: 500 }),
    ].map((value) => parseNativeJob(value)!);
    expect(orderNativeJobs(parsed).map((entry) => entry.id)).toEqual(["live", "new", "old"]);
  });

  it("measures a running job to now and a settled job to its finish", () => {
    const running = parseNativeJob(job("bg_1"))!;
    const done = parseNativeJob(job("bg_2", { status: "completed", finishedAt: 4_000 }))!;
    expect(nativeJobElapsedMs(running, 6_000)).toBe(5_000);
    expect(nativeJobElapsedMs(done, 99_000)).toBe(3_000);
  });
});

describe("native job output", () => {
  const slice = (fromByte: number, nextByte: number, output: string, reset = false) => ({
    jobId: "bg_1",
    fromByte,
    nextByte,
    totalBytes: nextByte,
    reset,
    output,
  });

  it("appends each slice from the byte offset NeoPi returned", () => {
    let output = emptyNativeJobOutput("bg_1");
    output = applyNativeJobOutput(output, slice(0, 5, "hello"));
    output = applyNativeJobOutput(output, slice(5, 11, " world"));
    expect(output).toEqual({ jobId: "bg_1", text: "hello world", nextByte: 11, revision: null });
  });

  it("restarts when NeoPi resets, and drops stale or foreign slices", () => {
    let output = applyNativeJobOutput(emptyNativeJobOutput("bg_1"), slice(0, 5, "hello"));
    expect(applyNativeJobOutput(output, slice(0, 5, "hello"))).toBe(output);
    expect(applyNativeJobOutput(output, { ...slice(5, 9, "more"), jobId: "bg_2" })).toBe(output);
    output = applyNativeJobOutput(output, slice(99, 3, "new", true));
    expect(output).toEqual({ jobId: "bg_1", text: "new", nextByte: 3, revision: null });
  });

  it("returns the same value for an empty slice so nothing re-renders", () => {
    const output = applyNativeJobOutput(emptyNativeJobOutput("bg_1"), slice(0, 5, "hello"));
    expect(applyNativeJobOutput(output, slice(5, 5, ""))).toBe(output);
  });

  it("round-trips each revision with its byte cursor across Unicode output pages", () => {
    let output = emptyNativeJobOutput("bg_1");
    expect(nativeJobOutputRequest(output)).toEqual({
      type: "get_job_output",
      jobId: "bg_1",
      fromByte: 0,
    });
    output = applyNativeJobOutput(output, {
      ...slice(0, 4, "🌱"),
      totalBytes: 7,
      revision: "4:seed",
    });
    expect(nativeJobOutputRequest(output)).toEqual({
      type: "get_job_output",
      jobId: "bg_1",
      fromByte: 4,
      revision: "4:seed",
    });
    output = applyNativeJobOutput(output, {
      ...slice(4, 7, "花"),
      revision: "7:flower",
    });
    expect(output.text).toBe("🌱花");
    expect(nativeJobOutputRequest(output)).toEqual({
      type: "get_job_output",
      jobId: "bg_1",
      fromByte: 7,
      revision: "7:flower",
    });
  });

  it.each(["BBBB", "longer replacement", "短"])(
    "replaces a changed snapshot with %s and sends its new revision",
    (replacement) => {
      const before = applyNativeJobOutput(emptyNativeJobOutput("bg_1"), {
        ...slice(0, 4, "AAAA"),
        revision: "4:old",
      });
      const nextByte = new TextEncoder().encode(replacement).length;
      const output = applyNativeJobOutput(before, {
        ...slice(0, nextByte, replacement, true),
        revision: `${nextByte}:new`,
      });
      expect(output.text).toBe(replacement);
      expect(nativeJobOutputRequest(output)).toEqual({
        type: "get_job_output",
        jobId: "bg_1",
        fromByte: nextByte,
        revision: `${nextByte}:new`,
      });
    },
  );

  it("retains a new revision on an empty slice without changing displayed output", () => {
    const before = applyNativeJobOutput(emptyNativeJobOutput("bg_1"), slice(0, 5, "hello"));
    const output = applyNativeJobOutput(before, { ...slice(5, 5, ""), revision: "5:hello" });
    expect(output.text).toBe(before.text);
    expect(nativeJobOutputRequest(output)).toMatchObject({ fromByte: 5, revision: "5:hello" });
    expect(applyNativeJobOutput(output, { ...slice(5, 5, ""), revision: "5:hello" })).toBe(output);
    expect(applyNativeJobOutput(output, { ...slice(0, 5, "stale"), revision: "5:stale" })).toBe(
      output,
    );
    expect(
      applyNativeJobOutput(output, {
        ...slice(5, 9, "more"),
        jobId: "bg_2",
        revision: "9:foreign",
      }),
    ).toBe(output);
  });

  it("keeps offset-only reads for older NeoPi, clearing any previous revision", () => {
    let output = applyNativeJobOutput(emptyNativeJobOutput("bg_1"), {
      ...slice(0, 5, "hello"),
      revision: "5:hello",
    });
    output = applyNativeJobOutput(output, slice(5, 5, ""));
    expect(nativeJobOutputRequest(output)).toEqual({
      type: "get_job_output",
      jobId: "bg_1",
      fromByte: 5,
    });
    output = applyNativeJobOutput(output, slice(5, 11, " world"));
    expect(output.text).toBe("hello world");
    expect(nativeJobOutputRequest(output)).toEqual({
      type: "get_job_output",
      jobId: "bg_1",
      fromByte: 11,
    });
  });
});
