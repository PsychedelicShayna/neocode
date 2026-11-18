// @vitest-environment jsdom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  emptyNativeSessionFeed,
  type NativeSessionFeed,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { afterEach, expect, it, vi } from "vite-plus/test";

const control = vi.hoisted(() => ({
  leases: 0,
  cached: undefined as NativeSessionFeed | undefined,
  publish: undefined as ((feed: NativeSessionFeed) => void) | undefined,
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("./nativeWorkspaceRelocation", () => ({ relocateNativeWorkspace: () => {} }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => () => Promise.resolve({}) }));
// The controller's RPC boundary is covered by its lease/cancellation tests.
// Here the actual React hooks mount real atoms: a lease is an atom lifetime,
// and replies replace its feed without changing that lease's identity.
// Imports are inside the hoisted mock factory because static bindings are not initialized yet.
vi.mock("@t3tools/client-runtime/state/neopi-native-sessions", async () => {
  const { Atom, AsyncResult } = await import("effect/unstable/reactivity");
  const { emptyNativeSessionFeed } = await import("@t3tools/client-runtime/neopi-native-sessions");
  const { appAtomRegistry } = await import("../rpc/atomRegistry");
  const signal = Atom.make(AsyncResult.success(emptyNativeSessionFeed())).pipe(Atom.keepAlive);
  const lease = Atom.make((get) => {
    control.leases++;
    get.addFinalizer(() => {
      control.leases--;
    });
    return true;
  }).pipe(Atom.setIdleTTL(0));
  const watch = Atom.make((get) => {
    get(lease);
    return get(signal);
  }).pipe(Atom.setIdleTTL(0));
  // A concealed view only holds the cache; the hooks show `cached`.
  const concealed = Atom.make(() => AsyncResult.initial()).pipe(Atom.setIdleTTL(0));
  control.publish = (feed) => {
    control.cached = feed;
    appAtomRegistry.set(signal, AsyncResult.success(feed));
  };
  return {
    createNativeSessionAtoms: () => ({
      view: (_target: unknown, visible: boolean) => (visible ? watch : concealed),
      cached: () => control.cached,
      request: {},
    }),
  };
});
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { useNativeSession, useNativeSessionSlice } from "./neopiNativeSessions";

let renderer: ReactTestRenderer | undefined;
let displayed = "";
const target = {
  environmentId: EnvironmentId.make("visibility"),
  ref: {
    providerInstanceId: ProviderInstanceId.make("neopi"),
    sessionFile: "/session",
  },
};
const selectBusy = (feed: NativeSessionFeed) => feed.busy;
function View({ shown = true }: { shown?: boolean }) {
  const { feed } = useNativeSession(target, shown);
  const busy = useNativeSessionSlice(target, selectBusy, shown);
  displayed = `${feed.conversation.pending[0]?.message.content ?? ""}:${busy}`;
  return null;
}
const publish = (text: string, busy: boolean) =>
  control.publish!({
    ...emptyNativeSessionFeed(),
    busy,
    conversation: {
      ...emptyNativeSessionFeed().conversation,
      pending: [
        {
          messageId: "m1",
          message: { role: "assistant", content: text },
        },
      ],
    },
  });

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
    await vi.runAllTimersAsync();
  });
  appAtomRegistry.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("keeps applying replies while visible but blurred, and releases only when actually hidden", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let visibility: DocumentVisibilityState = "visible";
  let focused = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  publish("before", false);
  await act(async () => {
    renderer = create(
      <AppAtomRegistryProvider>
        <View />
      </AppAtomRegistryProvider>,
    );
    await vi.runAllTimersAsync();
  });
  expect(control.leases).toBe(1);
  await act(async () => {
    focused = false;
    window.dispatchEvent(new Event("blur"));
    await vi.runAllTimersAsync();
  });
  expect(control.leases).toBe(1);
  await act(async () => {
    publish("after blur", true);
    await vi.runAllTimersAsync();
  });
  expect(displayed).toBe("after blur:true");
  await act(async () => {
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.runAllTimersAsync();
  });
  expect(control.leases).toBe(0);
  expect(displayed).toBe("after blur:true");
  await act(async () => {
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.runAllTimersAsync();
  });
  expect(control.leases).toBe(1);
  expect(displayed).toBe("after blur:true");
  // A prop change commits its effects when `act` ends; the unsubscribed
  // observation is released a microtask later, so drain once more.
  const rerender = async (shown: boolean) => {
    await act(async () => {
      renderer!.update(
        <AppAtomRegistryProvider>
          <View shown={shown} />
        </AppAtomRegistryProvider>,
      );
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
  };
  // A collapsed panel is concealed while the page stays visible.
  await rerender(false);
  expect(control.leases).toBe(0);
  expect(displayed).toBe("after blur:true");
  await rerender(true);
  expect(control.leases).toBe(1);
  expect(displayed).toBe("after blur:true");
});
