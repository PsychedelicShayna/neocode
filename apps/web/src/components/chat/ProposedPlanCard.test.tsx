import { EnvironmentId, ProjectWriteFileError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, type ComponentProps, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { writeFile, notify } = vi.hoisted(() => ({ writeFile: vi.fn(), notify: vi.fn() }));
vi.mock("~/state/projects", () => ({ projectEnvironment: { writeFileAtomic: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => writeFile }));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));
vi.mock("../ChatMarkdown", () => ({ default: () => null }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: notify },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("../ui/menu", () => {
  const Container = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return {
    Menu: Container,
    MenuPopup: Container,
    MenuTrigger: () => null,
    MenuItem: ({ children, onClick }: PropsWithChildren<{ onClick: () => void }>) => (
      <button onClick={onClick}>{children}</button>
    ),
  };
});
vi.mock("../ui/dialog", () => {
  const Container = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: PropsWithChildren<{ open: boolean }>) => (open ? children : null),
    DialogPopup: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DialogDescription: Container,
    DialogPanel: Container,
    DialogFooter: Container,
  };
});
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: PropsWithChildren<{
    onClick: () => void;
    disabled: boolean;
  }>) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("../ui/input", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

import { ProposedPlanCard } from "./ProposedPlanCard";

const environmentId = EnvironmentId.make("plan-save-test");
const conflict = () => ({
  _tag: "Failure",
  cause: Cause.fail(
    new ProjectWriteFileError({
      cwd: "/workspace",
      relativePath: "plan.md",
      failure: "already_exists",
    }),
  ),
});
let renderer: ReactTestRenderer;

async function click(label: string) {
  const button = renderer.root
    .findAllByType("button")
    .find((node) => node.children.join("") === label);
  expect(button, `Missing button: ${label}`).toBeDefined();
  await act(async () => button!.props.onClick());
}

function changePath(value: string) {
  act(() => renderer.root.findByType("input").props.onChange({ target: { value } }));
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  writeFile.mockReset().mockResolvedValue({ _tag: "Success", value: { relativePath: "plan.md" } });
  notify.mockReset();
  await act(async () => {
    renderer = create(
      <ProposedPlanCard
        planMarkdown={"# Plan\n\nDo the work.\n"}
        environmentId={environmentId}
        cwd="/workspace"
        workspaceRoot="/workspace"
      />,
    );
  });
  await click("Save to workspace");
});

afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("plan saves", () => {
  it("uses no-clobber creation even for the prefilled filename", async () => {
    const prefilledPath = renderer.root.findByType("input").props.value;
    expect(prefilledPath).not.toBe("");
    await click("Save");
    expect(writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/workspace",
        relativePath: prefilledPath,
        contents: "# Plan\n\nDo the work.\n",
        mode: "create",
      },
    });
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
  });

  it("keeps the conflict open without replacing anything until overwrite is chosen", async () => {
    changePath("plan.md");
    writeFile.mockResolvedValueOnce(conflict());
    await click("Save");
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain(
      "already exists",
    );
    await click("Overwrite file");
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile.mock.calls[1]![0].input).toMatchObject({
      relativePath: "plan.md",
      mode: "replace",
    });
  });

  it("returns to no-clobber creation after choosing a different name", async () => {
    changePath("plan.md");
    writeFile.mockResolvedValueOnce(conflict());
    await click("Save");
    await click("Choose another name");
    changePath("another-plan.md");
    await click("Save");
    expect(writeFile.mock.calls[1]![0].input).toMatchObject({
      relativePath: "another-plan.md",
      mode: "create",
    });
  });

  it("clears overwrite authorization when the path is edited", async () => {
    changePath("plan.md");
    writeFile.mockResolvedValueOnce(conflict());
    await click("Save");
    changePath("other.md");
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    await click("Save");
    expect(writeFile.mock.calls[1]![0].input.mode).toBe("create");
  });

  it.each([
    { environmentId: EnvironmentId.make("other-environment"), workspaceRoot: "/workspace" },
    { environmentId, workspaceRoot: "/other-workspace" },
  ])("does not carry overwrite authorization into another target: %j", async (target) => {
    writeFile.mockResolvedValueOnce(conflict());
    await click("Save");
    await act(async () => {
      renderer.update(
        <ProposedPlanCard
          planMarkdown={"# Plan\n\nDo the work.\n"}
          {...target}
          cwd={target.workspaceRoot}
        />,
      );
    });
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    await click("Save");
    expect(writeFile.mock.calls[1]![0]).toMatchObject({
      environmentId: target.environmentId,
      input: { cwd: target.workspaceRoot, mode: "create" },
    });
  });

  it("allows cancelling a conflict without any further write", async () => {
    writeFile.mockResolvedValueOnce(conflict());
    await click("Save");
    await click("Cancel");
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
  });

  it("fails closed with update guidance on an older server", async () => {
    writeFile.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.die("Unknown request tag: projects.writeFileAtomic"),
    });
    await click("Save");
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        description: "Update the server to save plans safely.",
      }),
    );
    expect(renderer.root.findAllByType("input")).toHaveLength(1);
  });
});
