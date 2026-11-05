import { act, createElement, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  emptyNativeSessionFeed,
  type NativeSessionFeed,
} from "@t3tools/client-runtime/neopi-native-sessions";

const h = vi.hoisted(() => ({ feed: null as NativeSessionFeed | null, request: vi.fn() }));
vi.mock("../../state/neopiNativeSessions", () => ({
  useNativeSessionSlice: (_target: unknown, select: (feed: NativeSessionFeed) => unknown) =>
    select(h.feed!),
  useNativeSessionRequest: () => h.request,
}));
vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => createElement("button", props),
}));
vi.mock("../ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => createElement("span", null, children),
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
let renderer: ReactTestRenderer | null = null;
const render = async () => {
  await act(() => {
    renderer = create(createElement(NativeBackgroundTasksPanel, { target }));
  });
};
const text = () => JSON.stringify(renderer!.toJSON());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.feed = supported();
  h.request.mockReset();
});
afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("background job inventory knowledge", () => {
  it("loads capabilities before deciding whether NeoPi is unsupported", async () => {
    h.feed = emptyNativeSessionFeed();
    await render();
    expect(text()).toContain("Loading background task capabilities");
    expect(text()).not.toContain("newer NeoPi");
    expect(h.request).not.toHaveBeenCalled();
  });

  it("reports unsupported only after capabilities are known", async () => {
    h.feed = { ...supported(), session: { ...supported().session!, capabilities: [] } };
    await render();
    expect(text()).toContain("newer NeoPi");
    expect(h.request).not.toHaveBeenCalled();
  });

  it("does not claim an unknown inventory is empty while its read is pending", async () => {
    let resolve!: (value: unknown) => void;
    h.request.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render();
    expect(text()).toContain("Loading background tasks");
    expect(text()).not.toContain("No background tasks yet");
    await act(() => resolve({ running: [], recent: [], runningCount: 0 }));
    expect(text()).toContain("No background tasks yet");
  });

  it("shows inventory failure and permits a successful retry", async () => {
    h.request
      .mockRejectedValueOnce(new Error("Inventory unavailable"))
      .mockResolvedValue({ running: [], recent: [], runningCount: 0 });
    await render();
    expect(text()).toContain("Inventory unavailable");
    expect(text()).not.toContain("No background tasks yet");
    await act(() => renderer!.root.findByType("button").props.onClick());
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(text()).toContain("No background tasks yet");
    expect(text()).not.toContain("Inventory unavailable");
  });

  it("distinguishes disconnected from an authoritative empty inventory", async () => {
    h.feed = { ...supported(), connected: false };
    await render();
    expect(text()).toContain("Disconnected");
    expect(text()).not.toContain("No background tasks yet");
    expect(h.request).not.toHaveBeenCalled();
  });

  it("keeps cached jobs visible when refreshing their inventory fails", async () => {
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
    h.feed = { ...supported(), jobs: { entries: [job], runningCount: 0, revision: 1 } };
    h.request.mockImplementation((command: { type: string }) =>
      command.type === "get_jobs"
        ? Promise.reject(new Error("Refresh offline"))
        : Promise.resolve({ jobId: "job", fromByte: 0, nextByte: 0, output: "" }),
    );
    await render();
    expect(text()).toContain("Finished command");
    expect(text()).toContain("Refresh offline");
  });
});
