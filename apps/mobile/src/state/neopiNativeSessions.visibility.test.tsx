// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

const screen = vi.hoisted(() => ({
  focused: true,
  appState: "active",
  appStateListeners: new Set<() => void>(),
  shown: [] as boolean[],
}));
vi.mock("@react-navigation/native", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useIsFocused: () =>
      useSyncExternalStore(
        (changed) => {
          screen.appStateListeners.add(changed);
          return () => screen.appStateListeners.delete(changed);
        },
        () => screen.focused,
      ),
  };
});
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return screen.appState;
    },
    addEventListener: (_event: "change", changed: () => void) => {
      screen.appStateListeners.add(changed);
      return { remove: () => screen.appStateListeners.delete(changed) };
    },
  },
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => () => Promise.resolve({}) }));
// The lease itself is the controller's (its tests cover release); here only
// what the screen asks for: a lease while shown, the cache otherwise.
vi.mock("@t3tools/client-runtime/state/neopi-native-sessions", async () => {
  const { Atom, AsyncResult } = await import("effect/unstable/reactivity");
  const leased = Atom.make(AsyncResult.initial());
  const cached = Atom.make(AsyncResult.initial());
  return {
    createNativeSessionAtoms: () => ({
      view: (_target: unknown, shown: boolean) => {
        screen.shown.push(shown);
        return shown ? leased : cached;
      },
      cached: () => undefined,
      request: {},
      reconnect: () => Promise.resolve(),
    }),
  };
});
import { useNativeSession } from "./neopiNativeSessions";

const target = {
  environmentId: EnvironmentId.make("env"),
  ref: { providerInstanceId: ProviderInstanceId.make("neopi"), sessionFile: "/s.jsonl" },
};
function Screen() {
  useNativeSession(target);
  return null;
}
const change = (apply: () => void) =>
  act(() => {
    apply();
    for (const listener of [...screen.appStateListeners]) listener();
  });

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  screen.focused = true;
  screen.appState = "active";
  screen.shown = [];
});

it("asks for a lease only while the screen is focused and the app is in the foreground", () => {
  root = createRoot(document.createElement("div"));
  act(() => root!.render(<Screen />));
  expect(screen.shown.at(-1)).toBe(true);
  // Another screen pushed over this one.
  change(() => {
    screen.focused = false;
  });
  expect(screen.shown.at(-1)).toBe(false);
  change(() => {
    screen.focused = true;
  });
  expect(screen.shown.at(-1)).toBe(true);
  // The app sent to the background, then brought back.
  change(() => {
    screen.appState = "background";
  });
  expect(screen.shown.at(-1)).toBe(false);
  change(() => {
    screen.appState = "active";
  });
  expect(screen.shown.at(-1)).toBe(true);
});
