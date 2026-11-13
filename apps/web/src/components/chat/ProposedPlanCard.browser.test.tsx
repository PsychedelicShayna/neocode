import { EnvironmentId, ProjectWriteFileError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render, type Screen } from "../../../test/render";
import "~/index.css";

const { writeFile, notify, permission } = vi.hoisted(() => ({
  writeFile: vi.fn(),
  notify: vi.fn(),
  permission: { allowed: true },
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: { writeFileAtomic: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => writeFile }));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: () => permission.allowed,
  readEnvironmentScope: () => permission.allowed,
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));
vi.mock("../ChatMarkdown", () => ({ default: () => null }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: notify },
  stackedThreadToast: (value: unknown) => value,
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
const plan = (target = { environmentId, workspaceRoot: "/workspace" }) => (
  <ProposedPlanCard
    planMarkdown={"# Plan\n\nDo the work.\n"}
    {...target}
    cwd={target.workspaceRoot}
  />
);
const pathInput = () => page.getByRole("textbox", { name: "Workspace path" });
const click = (label: string) => page.getByRole("button", { name: label, exact: true }).click();

function setup() {
  writeFile.mockReset().mockResolvedValue({ _tag: "Success", value: { relativePath: "plan.md" } });
  notify.mockReset();
  permission.allowed = true;
}

async function openSave(screen: Screen) {
  await screen.getByRole("button", { name: "Plan actions" }).click();
  await page.getByRole("menuitem", { name: "Save to workspace" }).click();
  await expect.element(pathInput()).toBeVisible();
}

describe("plan saves", () => {
  it("uses no-clobber creation even for the prefilled filename", async () => {
    setup();
    await using screen = await render(plan());
    await openSave(screen);
    const prefilledPath = (pathInput().element() as HTMLInputElement).value;
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
    await expect.element(pathInput()).not.toBeInTheDocument();
  });

  it("keeps the conflict open without replacing anything until overwrite is chosen", async () => {
    setup();
    await using screen = await render(plan());
    await openSave(screen);
    await pathInput().fill("plan.md");
    writeFile.mockResolvedValueOnce(conflict());
    await click("Save");
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    await click("Overwrite file");
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(writeFile.mock.calls[1]![0].input).toMatchObject({
      relativePath: "plan.md",
      mode: "replace",
    });
  });

  it("returns to no-clobber creation after choosing a different name", async () => {
    setup();
    await using screen = await render(plan());
    await openSave(screen);
    await pathInput().fill("plan.md");
    writeFile.mockResolvedValueOnce(conflict());
    await click("Save");
    await click("Choose another name");
    await pathInput().fill("another-plan.md");
    await click("Save");
    expect(writeFile.mock.calls[1]![0].input).toMatchObject({
      relativePath: "another-plan.md",
      mode: "create",
    });
  });

  it("clears overwrite authorization when the path is edited", async () => {
    setup();
    await using screen = await render(plan());
    await openSave(screen);
    await pathInput().fill("plan.md");
    writeFile.mockResolvedValueOnce(conflict());
    await click("Save");
    await pathInput().fill("other.md");
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await click("Save");
    expect(writeFile.mock.calls[1]![0].input.mode).toBe("create");
  });

  it("rechecks filesystem permission before saving from an open dialog", async () => {
    setup();
    await using screen = await render(plan());
    await openSave(screen);
    permission.allowed = false;
    await click("Save");
    expect(writeFile).not.toHaveBeenCalled();
    await expect.element(pathInput()).toBeVisible();
  });

  it.each([
    { environmentId: EnvironmentId.make("other-environment"), workspaceRoot: "/workspace" },
    { environmentId, workspaceRoot: "/other-workspace" },
  ])("does not carry overwrite authorization into another target: %j", async (target) => {
    setup();
    await using screen = await render(plan());
    await openSave(screen);
    writeFile.mockResolvedValueOnce(conflict());
    await click("Save");
    await screen.rerender(plan(target));
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await click("Save");
    expect(writeFile.mock.calls[1]![0]).toMatchObject({
      environmentId: target.environmentId,
      input: { cwd: target.workspaceRoot, mode: "create" },
    });
  });

  it("allows cancelling a conflict without any further write", async () => {
    setup();
    await using screen = await render(plan());
    await openSave(screen);
    writeFile.mockResolvedValueOnce(conflict());
    await click("Save");
    await click("Cancel");
    expect(writeFile).toHaveBeenCalledTimes(1);
    await expect.element(pathInput()).not.toBeInTheDocument();
  });

  it("fails closed on an older server without falling back to an in-place write", async () => {
    setup();
    await using screen = await render(plan());
    await openSave(screen);
    writeFile.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.die("Unknown request tag: projects.writeFileAtomic"),
    });
    await click("Save");
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
      }),
    );
    await expect.element(pathInput()).toBeVisible();
  });
});
