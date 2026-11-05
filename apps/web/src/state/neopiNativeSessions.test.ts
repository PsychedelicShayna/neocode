import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/neopi-native-sessions", () => ({
  createNativeSessionAtoms: () => ({}),
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: vi.fn() }));

import {
  beginNativeSessionOpen,
  closeNativeSession,
  cycleNativeSession,
  replaceNativeSession,
  selectNativeSession,
  useNativeSessionSelection,
} from "./neopiNativeSessions";

const session = (environment: string, sessionFile: string) => ({
  environmentId: EnvironmentId.make(environment),
  ref: { providerInstanceId: ProviderInstanceId.make("neopi"), sessionFile },
});
const a = session("local", "a");
const b = session("remote", "b");

beforeEach(() => {
  useNativeSessionSelection.persist.setOptions({
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  useNativeSessionSelection.setState({ target: a, tabs: [a, b] });
});

describe("native session open selection intent", () => {
  it("allows an open to select while no newer intent exists", () => {
    expect(beginNativeSessionOpen()()).toBe(true);
  });

  it("lets only the newest open across environments select", () => {
    const first = beginNativeSessionOpen();
    const second = beginNativeSessionOpen();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    selectNativeSession(b);
    expect(first()).toBe(false);
    expect(useNativeSessionSelection.getState().target).toBe(b);
  });

  it.each([
    ["select", () => selectNativeSession(b)],
    ["reselect", () => selectNativeSession(a)],
    ["close", () => closeNativeSession(a)],
    ["cycle", () => cycleNativeSession("next")],
    ["relocate", () => replaceNativeSession(a, session("local", "moved"))],
  ] as const)("does not override a newer %s action", (_action, mutate) => {
    const pending = beginNativeSessionOpen();
    mutate();
    expect(pending()).toBe(false);
  });
});
