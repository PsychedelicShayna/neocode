// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { NativeSessionBrowser } from "./NativeSessionBrowser";

const fixture = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: fixture.navigate }),
  useFocusEffect: () => {},
}));
vi.mock("react-native", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View: Box,
    ScrollView: Box,
    TextInput: () => <input />,
    Pressable: Box,
    AppState: { addEventListener: () => ({ remove: () => {} }) },
  };
});
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/MaterialButton", () => ({
  MaterialButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: "a", label: "Environment A" },
      { environmentId: "b", label: "Environment B" },
    ],
  }),
}));
vi.mock("../../state/entities", () => ({
  useServerConfigs: () => new Map(),
  useThreadShells: () => [
    { environmentId: "a", id: "thread-a", title: "Workspace A" },
    { environmentId: "b", id: "thread-b", title: "Workspace B" },
  ],
}));
vi.mock("../../state/neopiNativeSessions", () => ({ nativeSessionAtoms: { list: () => null } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { sessions: [], diagnostics: [] },
    isPending: false,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./NeoPiModelsScreen", () => ({ NeoPiModelsEntry: () => null }));

describe("NativeSessionBrowser environment scope", () => {
  it.each(["a", "b", undefined])(
    "scopes saved workspaces alongside native sessions (%s)",
    async (id) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      fixture.navigate.mockClear();
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(
            <NativeSessionBrowser {...(id ? { environmentId: EnvironmentId.make(id) } : {})} />,
          );
        });
        expect(container.textContent?.includes("Workspace A")).toBe(id !== "b");
        expect(container.textContent?.includes("Workspace B")).toBe(id !== "a");
        expect(container.textContent?.includes("Environment A")).toBe(id !== "b");
        expect(container.textContent?.includes("Environment B")).toBe(id !== "a");
        const expectedId = id ?? "a";
        const button = Array.from(container.querySelectorAll("button")).find(
          (item) => item.textContent === `Workspace ${expectedId.toUpperCase()}`,
        );
        expect(button).toBeDefined();
        await act(async () => button!.click());
        expect(fixture.navigate).toHaveBeenCalledWith("Thread", {
          environmentId: expectedId,
          threadId: `thread-${expectedId}`,
        });
      } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
      }
    },
  );
});
