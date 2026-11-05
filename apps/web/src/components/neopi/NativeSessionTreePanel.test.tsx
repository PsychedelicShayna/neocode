import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { act } from "react";
import { create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectItem: "option",
  SelectPopup: "optgroup",
  SelectTrigger: "label",
  SelectValue: "span",
}));
vi.mock("./NeoPiJournalContent", () => ({ NeoPiJournalContent: () => null }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
      const renderer = await act(() =>
        create(
          <NativeSessionTreePanel
            target={target}
            request={request}
            execute={execute}
            onNavigated={onNavigated}
          />,
          { createNodeMock: () => ({ scrollTop: 0, clientHeight: 240, clientWidth: 480 }) },
        ),
      );
      try {
        await act(() => vi.advanceTimersByTimeAsync(0));
        await act(() =>
          renderer.root.findByProps({ title: "assistant: chosen reply" }).props.onClick(),
        );

        const changeVisibility = async (hide: boolean) => {
          await act(() => {
            if (hideWith === "search") {
              renderer.root.findByProps({ "aria-label": "Search session tree" }).props.onChange({
                target: { value: hide ? "no-matching-entry" : "" },
              });
            } else if (hideWith === "filter") {
              renderer.root.findByType("select").props.onValueChange(hide ? "user-only" : "all");
            } else {
              renderer.root
                .findByProps({ "aria-label": hide ? "Collapse branch" : "Expand branch" })
                .props.onClick({ stopPropagation() {} });
            }
          });
        };
        const pressEnter = async () => {
          const tree = renderer.root.findByProps({ role: "tree" });
          const element = {};
          await act(() =>
            tree.props.onKeyDown({
              key: "Enter",
              target: element,
              currentTarget: element,
              preventDefault() {},
            }),
          );
        };

        await changeVisibility(true);
        await pressEnter();
        expect(execute).not.toHaveBeenCalled();
        expect(onNavigated).not.toHaveBeenCalled();

        await changeVisibility(false);
        await pressEnter();
        expect(execute).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "navigate_tree",
            targetId: "chosen",
          }),
        );
        expect(onNavigated).toHaveBeenCalledOnce();
      } finally {
        await act(() => renderer.unmount());
      }
    },
  );
});
