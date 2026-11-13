import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  emptyNativeSessionFeed,
  type NativeSessionFeed,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { act, render } from "../../../test/render";
import "~/index.css";

const h = vi.hoisted(() => ({ feed: null as NativeSessionFeed | null, request: vi.fn() }));
vi.mock("../../state/neopiNativeSessions", () => ({
  useNativeSessionSlice: (_target: unknown, select: (feed: NativeSessionFeed) => unknown) =>
    select(h.feed!),
  useNativeSessionRequest: () => h.request,
}));
import { NativeBackgroundTasksPanel } from "./NativeBackgroundTasksPanel";
const target = {
  environmentId: EnvironmentId.make("local"),
  ref: { providerInstanceId: ProviderInstanceId.make("neopi"), sessionFile: "/session" },
};
const supported = (): NativeSessionFeed => ({
  ...emptyNativeSessionFeed(),
  connected: true,
  session: {
    ref: target.ref,
    sessionId: "session",
    cwd: "/workspace",
    attachment: "owned",
    capabilities: ["background_jobs"],
    state: {},
  },
});
const job = {
  id: "job",
  type: "bash",
  label: "Finished command",
  command: null,
  status: "completed" as const,
  startedAt: 1,
  finishedAt: 2,
  exitCode: 0,
  error: null,
  agentId: null,
  outputBytes: 0,
  revision: 1,
};
function setup() {
  h.feed = supported();
  h.request.mockReset();
}
const panel = () => <NativeBackgroundTasksPanel target={target} />;

describe("background job inventory knowledge", () => {
  it("waits for supported capabilities and an inventory response before displaying jobs", async () => {
    setup();
    h.feed = emptyNativeSessionFeed();
    let resolve!: (value: unknown) => void;
    h.request.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await using screen = await render(panel());
    expect(h.request).not.toHaveBeenCalled();
    h.feed = { ...supported(), session: { ...supported().session!, capabilities: [] } };
    await screen.rerender(panel());
    expect(h.request).not.toHaveBeenCalled();
    h.feed = supported();
    await screen.rerender(panel());
    expect(h.request).toHaveBeenCalledWith({ type: "get_jobs" });
    expect(screen.container.querySelector("li")).toBeNull();
    h.feed = { ...supported(), jobs: { entries: [job], runningCount: 0, revision: 1 } };
    await act(() => resolve({ running: [], recent: [job], runningCount: 0 }));
    h.request.mockResolvedValue({ jobId: "job", fromByte: 0, nextByte: 0, output: "" });
    await screen.rerender(panel());
    await expect.element(screen.getByRole("button", { name: /Finished command/ })).toBeVisible();
  });

  it("shows inventory failure and permits a successful retry", async () => {
    setup();
    h.request
      .mockRejectedValueOnce(new Error("Inventory unavailable"))
      .mockResolvedValue({ running: [], recent: [], runningCount: 0 });
    await using screen = await render(panel());
    await vi.waitFor(() =>
      expect(screen.getByRole("alert").element().textContent).toContain("Inventory unavailable"),
    );
    await screen.getByRole("button", { name: "Retry" }).click();
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("status")).toBeVisible();
  });

  it("does not issue inventory reads while disconnected", async () => {
    setup();
    h.feed = { ...supported(), connected: false };
    await using screen = await render(panel());
    await expect.element(screen.getByRole("status")).toBeVisible();
    expect(h.request).not.toHaveBeenCalled();
  });

  it("keeps cached jobs visible when refreshing their inventory fails", async () => {
    setup();
    h.feed = { ...supported(), jobs: { entries: [job], runningCount: 0, revision: 1 } };
    h.request.mockImplementation((command: { type: string }) =>
      command.type === "get_jobs"
        ? Promise.reject(new Error("Refresh offline"))
        : Promise.resolve({ jobId: "job", fromByte: 0, nextByte: 0, output: "" }),
    );
    await using screen = await render(panel());
    await expect.element(screen.getByRole("button", { name: /Finished command/ })).toBeVisible();
    await vi.waitFor(() =>
      expect(screen.getByRole("alert").element().textContent).toContain("Refresh offline"),
    );
  });
});
