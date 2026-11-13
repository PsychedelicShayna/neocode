import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import "~/index.css";
import { NativeSessionTreePanel } from "./NativeSessionTreePanel";

const target = {
  environmentId: EnvironmentId.make("test-environment"),
  ref: {
    providerInstanceId: ProviderInstanceId.make("neopi"),
    sessionFile: "/sessions/test.jsonl",
  },
};
vi.mock("../../hooks/useSettings", () => ({ useEnvironmentSettings: () => "locale" }));
vi.mock("../../timestampFormat", () => ({ formatShortTimestamp: () => "12:00" }));
vi.mock("../../state/neopiNativeSessions", () => ({
  useNativeSession: () => ({
    feed: { connected: true },
    conversation: {
      identity: { sessionId: "test-session", sessionFile: "/sessions/test.jsonl", leafId: "leaf" },
    },
    session: {
      ref: { providerInstanceId: "neopi", sessionFile: "/sessions/test.jsonl" },
      cwd: "/workspace",
    },
  }),
}));
vi.mock("./NeoPiJournalContent", () => ({ NeoPiJournalContent: () => null }));
const entry = (id: string, parentId: string | null, role: string, text: string) => ({
  id,
  parentId,
  type: "message",
  timestamp: "2026-01-01T12:00:00.000Z",
  message: { role, content: text },
});

describe("visible tree selection", () => {
  it.each(["search", "filter", "collapse"])(
    "does not navigate a selection hidden by %s, and restores it when visible again",
    async (hideWith) => {
      const request = vi.fn(async () => ({
        leafId: "leaf",
        tree: [
          {
            entry: entry("root", null, "user", "root prompt"),
            children: [
              { entry: entry("chosen", "root", "assistant", "chosen reply"), children: [] },
              { entry: entry("leaf", "root", "user", "current prompt"), children: [] },
            ],
          },
        ],
      }));
      const execute = vi.fn(async () => ({}));
      const onNavigated = vi.fn();
      await using screen = await render(
        <div style={{ height: 400, display: "flex" }}>
          <NativeSessionTreePanel
            target={target}
            request={request}
            execute={execute}
            onNavigated={onNavigated}
          />
        </div>,
      );
      const chosen = screen.getByRole("treeitem", { name: /chosen reply/ });
      await chosen.click();
      const changeVisibility = async (hide: boolean) => {
        if (hideWith === "search") {
          await screen
            .getByRole("searchbox", { name: "Search session tree" })
            .fill(hide ? "no-matching-entry" : "");
        } else if (hideWith === "filter") {
          await screen.getByRole("combobox", { name: "Filter session tree" }).click();
          await screen
            .getByRole("option", { name: hide ? "User only" : "All", exact: true })
            .click();
        } else {
          await screen
            .getByRole("button", { name: hide ? "Collapse branch" : "Expand branch" })
            .click();
        }
      };
      const pressEnter = async () => {
        await act(() => (screen.getByRole("tree").element() as HTMLElement).focus());
        await userEvent.keyboard("{Enter}");
      };
      await changeVisibility(true);
      await expect.element(chosen).not.toBeInTheDocument();
      await pressEnter();
      expect(execute).not.toHaveBeenCalled();
      expect(onNavigated).not.toHaveBeenCalled();
      await changeVisibility(false);
      await expect.element(chosen).toBeVisible();
      await pressEnter();
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ type: "navigate_tree", targetId: "chosen" }),
      );
      expect(onNavigated).toHaveBeenCalledOnce();
    },
  );
});
