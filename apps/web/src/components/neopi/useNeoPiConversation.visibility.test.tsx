// @vitest-environment jsdom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

const control = vi.hoisted(() => ({
  leases: 0,
  purposes: [] as Array<string | undefined>,
  visibility: "visible" as DocumentVisibilityState,
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/neopiSessions", () => ({ neopiSessionJournal: {} }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => () => Promise.resolve({ _tag: "Failure" }),
}));
vi.mock("../../state/nativeWorkspaceRelocation", () => ({ relocateNativeWorkspace: () => {} }));
// The thread's ref resolves at once; the controller's lease is an atom lifetime, as in the
// native session visibility test. The real thread observation atoms compose them. Imports
// are inside the hoisted mock factories because static bindings are not initialized yet.
vi.mock("@t3tools/client-runtime/state/runtime", async (original) => {
  const actual = await original<typeof import("@t3tools/client-runtime/state/runtime")>();
  const { Atom, AsyncResult } = await import("effect/unstable/reactivity");
  const { ProviderInstanceId } = await import("@t3tools/contracts");
  const ref = Atom.make(
    AsyncResult.success({
      status: "available" as const,
      ref: { providerInstanceId: ProviderInstanceId.make("neopi"), sessionFile: "/session" },
      sessionId: "s-1",
      runtime: "gui" as const,
    }),
  ).pipe(Atom.keepAlive);
  return { ...actual, createEnvironmentRpcQueryAtomFamily: () => () => ref };
});
vi.mock("../../state/neopiNativeSessions", async () => {
  const { Atom, AsyncResult } = await import("effect/unstable/reactivity");
  const { emptyNativeSessionFeed } = await import("@t3tools/client-runtime/neopi-native-sessions");
  const lease = Atom.make((get) => {
    control.leases++;
    get.addFinalizer(() => {
      control.leases--;
    });
    return AsyncResult.success(emptyNativeSessionFeed());
  }).pipe(Atom.setIdleTTL(0));
  const concealed = Atom.make(() => AsyncResult.initial()).pipe(Atom.setIdleTTL(0));
  const visible = () => control.visibility === "visible";
  const { useSyncExternalStore } = await import("react");
  const subscribe = (changed: () => void) => {
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  };
  return {
    usePageVisible: () => useSyncExternalStore(subscribe, visible),
    nativeSessionAtoms: {
      view: (_target: unknown, shown: boolean, purpose?: string) => {
        if (shown) control.purposes.push(purpose);
        return shown ? lease : concealed;
      },
      watch: () => lease,
      cached: () => undefined,
    },
  };
});
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { useThreadNativeObservation } from "./useNeoPiConversation";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
let renderer: ReactTestRenderer | undefined;
function ThreadView() {
  useThreadNativeObservation(threadRef);
  return null;
}
const setVisibility = async (value: DocumentVisibilityState) => {
  await act(async () => {
    control.visibility = value;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // The unsubscribed observation is released a microtask after `act` ends; drain once more.
  await act(async () => {
    await vi.runAllTimersAsync();
  });
};

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
    await vi.runAllTimersAsync();
  });
  appAtomRegistry.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("holds a thread lease only while the document is visible, never keyed on focus", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(
      <AppAtomRegistryProvider>
        <ThreadView />
      </AppAtomRegistryProvider>,
    );
    await vi.runAllTimersAsync();
  });
  expect(control.leases).toBe(1);
  expect(control.purposes.every((purpose) => purpose === "thread")).toBe(true);
  await act(async () => {
    window.dispatchEvent(new Event("blur"));
    await vi.runAllTimersAsync();
  });
  expect(control.leases).toBe(1);
  await setVisibility("hidden");
  expect(control.leases).toBe(0);
  await setVisibility("visible");
  expect(control.leases).toBe(1);
});
