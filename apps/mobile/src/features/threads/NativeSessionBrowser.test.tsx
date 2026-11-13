import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { NativeSessionBrowser } from "./NativeSessionBrowser";

vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
  useFocusEffect: () => {},
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => vi.fn(),
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
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
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
      } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
      }
    },
  );
});
