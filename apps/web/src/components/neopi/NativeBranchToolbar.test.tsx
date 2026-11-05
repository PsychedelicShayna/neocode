// @vitest-environment jsdom

import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { NativeBranchToolbar } from "./NativeBranchToolbar";

const fixture = vi.hoisted(() => ({
  switchRef: vi.fn(async () => ({ _tag: "Success" as const })),
  createRef: vi.fn(async () => ({ _tag: "Success" as const })),
  choose: undefined as ((value: string) => void) | undefined,
}));

vi.mock("../../state/vcs", () => ({
  vcsEnvironment: { status: () => "status", switchRef: "switch", createRef: "create" },
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { readFile: () => "git-file" } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: string) =>
    query === "status"
      ? { data: { isRepo: true, refName: "main" }, refresh: vi.fn() }
      : { data: { contents: null } },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "switch" ? fixture.switchRef : fixture.createRef),
}));
vi.mock("../../state/queries", () => ({
  usePaginatedBranches: () => ({
    refs: [
      { name: "main", current: true, worktreePath: null },
      { name: "feature/test", current: false, worktreePath: null },
    ],
    data: { nextCursor: null },
    refresh: vi.fn(),
  }),
}));
vi.mock("../chat/composerEventScope", () => ({ useComposerMenuProps: () => ({}) }));
vi.mock("../chat/ComposerControl", () => ({
  ComposerControl: ({ size: _size, ...props }: ComponentProps<"button"> & { size?: string }) => (
    <button {...props} />
  ),
}));
vi.mock("../chat/ComposerSurface", () => ({
  ComposerSurface: { ContextStrip: ({ children }: { children: ReactNode }) => <div>{children}</div> },
}));
vi.mock("../ui/middle-truncate", () => ({
  MiddleTruncate: ({ value }: { value: string }) => <span>{value}</span>,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() }, stackedThreadToast: vi.fn() }));
vi.mock("../ui/button", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
}));
vi.mock("../ui/input", () => ({ Input: (props: ComponentProps<"input">) => <input {...props} /> }));
vi.mock("../ui/dialog", () => {
  const Box = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { Dialog: Box, DialogPopup: Box, DialogHeader: Box, DialogFooter: Box, DialogTitle: Box };
});
vi.mock("../ui/combobox", async () => {
  const React = await import("react");
  type Menu = {
    items: string[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onValueChange: (value: string) => void;
  };
  const Context = React.createContext<Menu | null>(null);
  function useMenu() {
    const menu = React.useContext(Context);
    if (!menu) throw new Error("Missing combobox context");
    return menu;
  }
  return {
    Combobox: ({ children, ...menu }: Menu & { children: ReactNode }) => {
      fixture.choose = menu.onValueChange;
      return <Context.Provider value={menu}>{children}</Context.Provider>;
    },
    ComboboxTrigger: ({ children, render: _render, ...props }: ComponentProps<"button"> & { render: ReactNode }) => {
      const menu = useMenu();
      return <button {...props} onClick={() => menu.onOpenChange(!menu.open)}>{children}</button>;
    },
    ComboboxPopup: ({ children }: { children: ReactNode }) =>
      useMenu().open ? <div>{children}</div> : null,
    ComboboxSearchInput: (props: ComponentProps<"input">) => <input {...props} />,
    ComboboxEmpty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ComboboxStatus: ({ children }: { children: ReactNode }) => <div role="status">{children}</div>,
    ComboboxList: ({ children }: { children: (item: string) => ReactNode }) => (
      <div>{useMenu().items.map(children)}</div>
    ),
    ComboboxItem: ({ value, children, disabled }: { value: string; children: ReactNode; disabled: boolean }) => {
      const menu = useMenu();
      return <button disabled={disabled} onClick={() => menu.onValueChange(value)}>{children}</button>;
    },
  };
});

const environmentId = EnvironmentId.make("branch-lock-test");
const onRunCommand = vi.fn();
const onReturnFocus = vi.fn();
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.switchRef.mockClear();
  fixture.createRef.mockClear();
  onRunCommand.mockClear();
  onReturnFocus.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(connected: boolean, busy: boolean) {
  await act(async () => {
    root.render(
      <NativeBranchToolbar
        environmentId={environmentId}
        cwd="/repo"
        connected={connected}
        busy={busy}
        onRunCommand={onRunCommand}
        onReturnFocus={onReturnFocus}
      />,
    );
  });
}

function button(label: string) {
  const element = Array.from(container.querySelectorAll("button")).find(
    (item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}

const lockedStates = [
  { connected: true, busy: true, reason: "NeoPi is working" },
  { connected: false, busy: false, reason: "Reconnect NeoPi first." },
] as const;

describe("native branch controls while session state changes", () => {
  it.each(lockedStates)("blocks an already-open branch menu when $reason", async (locked) => {
    await render(true, false);
    await act(async () => button("Switch branch").click());
    expect(button("feature/test").disabled).toBe(false);

    await render(locked.connected, locked.busy);
    expect(button("feature/test").disabled).toBe(true);
    expect(container.textContent).toContain(locked.reason);
    await act(async () => {
      fixture.choose?.("feature/test");
      fixture.choose?.("__create_branch__:feature/new");
    });
    expect(fixture.switchRef).not.toHaveBeenCalled();
    expect(fixture.createRef).not.toHaveBeenCalled();

    await render(true, false);
    await act(async () => button("feature/test").click());
    expect(fixture.switchRef).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/repo", refName: "feature/test" },
    });
  });

  it.each(lockedStates)("preserves an open worktree name when $reason", async (locked) => {
    await render(true, false);
    await act(async () => button("Create a worktree").click());
    const input = container.querySelector<HTMLInputElement>('input[placeholder="feature/name"]');
    if (!input) throw new Error("Missing worktree branch input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "feature/draft");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await render(locked.connected, locked.busy);
    expect(button("Create worktree").disabled).toBe(true);
    expect(container.textContent).toContain(locked.reason);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onRunCommand).not.toHaveBeenCalled();
    expect(input.value).toBe("feature/draft");

    await render(true, false);
    await act(async () => button("Create worktree").click());
    expect(onRunCommand).toHaveBeenCalledWith("/wt feature/draft");
  });
});
