import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  NATIVE_JOBS_CAPABILITY,
  type NativeJobEntry,
} from "@t3tools/client-runtime/neopi-native-jobs";
import {
  emptyNativeSessionFeed,
  type NativeSessionFeed,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";
import "~/index.css";

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
function setup() {
  const reads: Array<{ command: Record<string, unknown>; response: ReturnType<typeof deferred> }> =
    [];
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
  const panel = (changes: Partial<NativeJobEntry> = {}) => {
    state.feed = {
      ...state.feed!,
      jobs: { ...state.feed!.jobs, entries: [{ ...runningJob, ...changes }] },
    };
    return <NativeBackgroundTasksPanel target={target} />;
  };
  return { reads, panel };
}
const output = (fromByte: number, nextByte: number, text: string) => ({
  jobId: runningJob.id,
  fromByte,
  nextByte,
  output: text,
});

describe("background job output refresh", () => {
  it("coalesces progress and completion during a read and displays the final bytes", async () => {
    const h = setup();
    // Polling and the elapsed clock start during the first mount.
    using _timers = fakeTimers();
    await using screen = await render(h.panel());
    expect(h.reads).toHaveLength(1);
    await screen.rerender(h.panel({ outputBytes: 6 }));
    await screen.rerender(h.panel({ outputBytes: 11 }));
    await screen.rerender(
      h.panel({ status: "completed", outputBytes: 11, finishedAt: 2000, exitCode: 0 }),
    );
    expect(h.reads).toHaveLength(1);
    await act(() => h.reads[0]!.response.resolve(output(0, 6, "first\n")));
    expect(h.reads).toHaveLength(2);
    expect(h.reads[1]!.command).toEqual({
      type: "get_job_output",
      jobId: runningJob.id,
      fromByte: 6,
    });
    await act(() => h.reads[1]!.response.resolve(output(6, 11, "last\n")));
    expect(screen.container.querySelector("pre")?.textContent).toBe("first\nlast\n");
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(h.reads).toHaveLength(2);
  });

  it("keeps a pending final refresh after the active read fails", async () => {
    const h = setup();
    using _timers = fakeTimers();
    await using screen = await render(h.panel());
    await screen.rerender(
      h.panel({ status: "failed", outputBytes: 5, finishedAt: 2000, exitCode: 1 }),
    );
    await act(() => h.reads[0]!.response.reject(new Error("Output read failed")));
    expect(h.reads).toHaveLength(2);
    expect(h.reads[1]!.command.fromByte).toBe(0);
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Output read failed");
    await act(() => h.reads[1]!.response.resolve(output(0, 5, "error")));
    expect(screen.container.querySelector("pre")?.textContent).toBe("error");
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["resolve", "reject"] as const)(
    "does not replay a pending refresh after unmount when the active read %ss",
    async (settlement) => {
      const h = setup();
      using _timers = fakeTimers();
      await using screen = await render(h.panel());
      await screen.rerender(h.panel({ status: "completed", outputBytes: 5, finishedAt: 2000 }));
      await screen.unmount();
      await act(() => {
        if (settlement === "resolve") h.reads[0]!.response.resolve(output(0, 5, "final"));
        else h.reads[0]!.response.reject(new Error("Disconnected"));
      });
      await vi.advanceTimersByTimeAsync(6000);
      expect(h.reads).toHaveLength(1);
    },
  );
});
