import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  NATIVE_JOBS_CAPABILITY,
  type NativeJobEntry,
} from "@t3tools/client-runtime/neopi-native-jobs";
import {
  emptyNativeSessionFeed,
  type NativeSessionFeed,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  feed: null as NativeSessionFeed | null,
  request: vi.fn<(command: Record<string, unknown>) => Promise<unknown>>(),
}));
vi.mock("../../state/neopiNativeSessions", () => ({
  useNativeSessionRequest: () => state.request,
  useNativeSessionSlice: (_target: unknown, select: (feed: NativeSessionFeed) => unknown) =>
    select(state.feed!),
}));

import { NativeBackgroundTasksPanel } from "./NativeBackgroundTasksPanel";

const target = {
  environmentId: EnvironmentId.make("job-output-race"),
  ref: {
    providerInstanceId: ProviderInstanceId.make("neopi"),
    sessionFile: "/sessions/jobs.jsonl",
  },
};
const runningJob: NativeJobEntry = {
  id: "job-1",
  type: "bash",
  label: "Build",
  command: "build",
  status: "running",
  startedAt: 1000,
  finishedAt: null,
  exitCode: null,
  error: null,
  agentId: null,
  outputBytes: 0,
  revision: 1,
};

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<unknown>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const reads: Array<{
  command: Record<string, unknown>;
  response: ReturnType<typeof deferred>;
}> = [];
let renderer: ReactTestRenderer | undefined;

async function render(changes: Partial<NativeJobEntry> = {}) {
  state.feed = {
    ...state.feed!,
    jobs: { ...state.feed!.jobs, entries: [{ ...runningJob, ...changes }] },
  };
  await act(async () => {
    if (renderer) renderer.update(<NativeBackgroundTasksPanel target={target} />);
    else renderer = create(<NativeBackgroundTasksPanel target={target} />);
  });
}

function output(fromByte: number, nextByte: number, text: string) {
  return { jobId: runningJob.id, fromByte, nextByte, output: text };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  reads.length = 0;
  state.feed = {
    ...emptyNativeSessionFeed(),
    connected: true,
    session: {
      ref: target.ref,
      sessionId: "native-jobs",
      cwd: "/workspace",
      attachment: "owned",
      capabilities: [NATIVE_JOBS_CAPABILITY],
      state: {},
    },
  };
  state.request.mockReset().mockImplementation((command) => {
    if (command.type !== "get_job_output") return Promise.resolve({});
    const response = deferred();
    reads.push({ command, response });
    return response.promise;
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("background job output refresh", () => {
  it("coalesces progress and completion during a read and displays the final bytes", async () => {
    await render();
    expect(reads).toHaveLength(1);
    await render({ outputBytes: 6 });
    await render({ outputBytes: 11 });
    await render({ status: "completed", outputBytes: 11, finishedAt: 2000, exitCode: 0 });
    expect(reads).toHaveLength(1);

    await act(async () => reads[0]!.response.resolve(output(0, 6, "first\n")));
    expect(reads).toHaveLength(2);
    expect(reads[1]!.command).toEqual({
      type: "get_job_output",
      jobId: runningJob.id,
      fromByte: 6,
    });
    await act(async () => reads[1]!.response.resolve(output(6, 11, "last\n")));
    expect(renderer!.root.findByType("pre").children).toEqual(["first\nlast\n"]);

    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(reads).toHaveLength(2);
  });

  it("keeps a pending final refresh after the active read fails", async () => {
    await render();
    await render({ status: "failed", outputBytes: 5, finishedAt: 2000, exitCode: 1 });
    await act(async () => reads[0]!.response.reject(new Error("Output read failed")));
    expect(reads).toHaveLength(2);
    expect(reads[1]!.command.fromByte).toBe(0);
    expect(renderer!.root.findByProps({ role: "alert" }).children).toEqual(["Output read failed"]);

    await act(async () => reads[1]!.response.resolve(output(0, 5, "error")));
    expect(renderer!.root.findByType("pre").children).toEqual(["error"]);
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });

  it.each(["resolve", "reject"] as const)(
    "does not replay a pending refresh after unmount when the active read %ss",
    async (settlement) => {
      await render();
      await render({ status: "completed", outputBytes: 5, finishedAt: 2000 });
      await act(async () => renderer!.unmount());
      renderer = undefined;
      await act(async () => {
        if (settlement === "resolve") reads[0]!.response.resolve(output(0, 5, "final"));
        else reads[0]!.response.reject(new Error("Disconnected"));
      });
      await vi.advanceTimersByTimeAsync(6000);
      expect(reads).toHaveLength(1);
    },
  );
});
