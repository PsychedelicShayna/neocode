import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  emptyNativeSessionFeed,
  type NativeObserverPhase,
  type NativeSessionFeed,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { expect, it, vi } from "vite-plus/test";

const controller = vi.hoisted(() => ({
  cached: undefined as NativeSessionFeed | undefined,
  retried: 0,
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./nativeWorkspaceRelocation", () => ({ relocateNativeWorkspace: () => {} }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => () => Promise.resolve({}) }));
vi.mock("@t3tools/client-runtime/state/neopi-native-sessions", () => ({
  createNativeSessionAtoms: () => ({
    cached: () => controller.cached,
    retry: () => {
      controller.retried += 1;
    },
  }),
}));
import { retryStoppedNativeSession } from "./neopiNativeSessions";

const target = {
  environmentId: EnvironmentId.make("env"),
  ref: { providerInstanceId: ProviderInstanceId.make("neopi"), sessionFile: "/s.jsonl" },
};
const retriedAt = (phase: NativeObserverPhase) => {
  controller.cached = { ...emptyNativeSessionFeed(), observer: { phase, reason: null } };
  controller.retried = 0;
  retryStoppedNativeSession(target);
  return controller.retried;
};

it("re-attaches an observation stopped on its owner, never a detached or live one", () => {
  for (const phase of [
    "owner-stopped",
    "identity-changed",
    "incompatible",
    "unauthorized",
  ] as const)
    expect(retriedAt(phase)).toBe(1);
  // A detach stays until Reconnect; a live or recovering observation must not
  // be left a queued wake that would restart it after a later stop.
  for (const phase of ["detached", "observing", "attaching", "building", "transport-lost"] as const)
    expect(retriedAt(phase)).toBe(0);
});
