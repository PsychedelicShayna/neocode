import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type DeviceServiceState,
} from "@t3tools/contracts";
import { workspaceResourceId } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import { selectedThreadDevicePreview, threadDevicePreviews } from "./threadDevicePreviews";

const threadId = ThreadId.make("thread");
const state: DeviceServiceState = {
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "Local",
      platforms: [],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
    {
      id: "remote",
      kind: "ssh",
      label: "Mac mini",
      platforms: [],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [
    {
      hostId: "local",
      id: "emulator-5554",
      platform: "android",
      name: "Pixel 9",
      version: "Android 16",
      booted: true,
      physical: false,
    },
    {
      hostId: "remote",
      id: "emulator-5554",
      platform: "android",
      name: "Pixel 8",
      version: "Android 15",
      booted: true,
      physical: false,
    },
  ],
  sessions: [
    {
      threadId,
      hostId: "local",
      deviceId: "emulator-5554",
      platform: "android",
      openedAt: "2026-09-18T00:00:00Z",
    },
    {
      threadId,
      hostId: "remote",
      deviceId: "emulator-5554",
      platform: "android",
      openedAt: "2026-09-18T00:01:00Z",
    },
    {
      threadId: ThreadId.make("another-thread"),
      hostId: "local",
      deviceId: "iphone",
      platform: "ios",
      openedAt: "2026-09-18T00:02:00Z",
    },
  ],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
};

describe("thread device previews", () => {
  it("keeps device names and selection distinct when hosts have the same Android serial", () => {
    const previews = threadDevicePreviews(state, threadId);
    expect(previews.map((preview) => preview.name)).toEqual(["Pixel 9", "Pixel 8"]);
    expect(new Set(previews.map((preview) => preview.key)).size).toBe(2);
    expect(selectedThreadDevicePreview(previews, previews[1]!.key)?.description).toBe(
      "Android 15 · Mac mini",
    );
  });

  it("selects another open device when the agent closes the selected session", () => {
    const previews = threadDevicePreviews(state, threadId);
    const selectedKey = previews[1]!.key;
    const afterClose = threadDevicePreviews({ ...state, sessions: [state.sessions[0]!] }, threadId);
    expect(selectedThreadDevicePreview(afterClose, selectedKey)?.name).toBe("Pixel 9");
    expect(selectedThreadDevicePreview([], selectedKey)).toBeNull();
  });
  it("selects native device resources without a SQL thread and isolates profiles and files", () => {
    const target = {
      environmentId: EnvironmentId.make("environment"),
      ref: {
        providerInstanceId: ProviderInstanceId.make("neopi"),
        sessionFile: "/sessions/one.jsonl",
      },
    };
    const namespace = workspaceResourceId(target);
    const nativeState = {
      ...state,
      sessions: [...state.sessions, { ...state.sessions[0]!, threadId: namespace }],
    };
    expect(threadDevicePreviews(nativeState, namespace).map((preview) => preview.name)).toEqual([
      "Pixel 9",
    ]);
    expect(
      threadDevicePreviews(
        nativeState,
        workspaceResourceId({
          ...target,
          ref: { ...target.ref, providerInstanceId: ProviderInstanceId.make("other") },
        }),
      ),
    ).toEqual([]);
    expect(
      threadDevicePreviews(
        nativeState,
        workspaceResourceId({
          ...target,
          ref: { ...target.ref, sessionFile: "/sessions/two.jsonl" },
        }),
      ),
    ).toEqual([]);
    expect(threadDevicePreviews(nativeState, threadId)).toHaveLength(2);
  });
});
