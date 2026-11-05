import { memo, useState, useId, useRef } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ProjectWriteFileError,
  WS_METHODS,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../../proposedPlan";
import ChatMarkdown from "../ChatMarkdown";
import { EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useAtomCommand } from "~/state/use-atom-command";

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  environmentId,
  threadRef,
  cwd,
  workspaceRoot,
}: {
  planMarkdown: string;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | undefined;
  cwd: string | undefined;
  workspaceRoot: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [savePath, setSavePath] = useState("");
  const [saveConflict, setSaveConflict] = useState<{
    environmentId: EnvironmentId;
    workspaceRoot: string;
    relativePath: string;
  } | null>(null);
  const conflictingSavePath =
    saveConflict?.environmentId === environmentId && saveConflict.workspaceRoot === workspaceRoot
      ? saveConflict.relativePath
      : null;
  const savePathInputRef = useRef<HTMLInputElement>(null);
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const writeProjectFile = useAtomCommand(projectEnvironment.writeFileAtomic, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "plan",
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy plan",
          description: error instanceof Error ? error.message : "An error occurred while copying.",
        }),
      );
    },
  });
  const savePathInputId = useId();
  const title = proposedPlanTitle(planMarkdown) ?? "Proposed plan";
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : null;
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown);
  const saveContents = normalizePlanMarkdownForExport(planMarkdown);

  const handleDownload = () => {
    downloadPlanAsTextFile(downloadFilename, saveContents);
  };

  const handleCopyPlan = () => {
    copyToClipboard(saveContents);
  };

  const openSaveDialog = () => {
    if (!workspaceRoot) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Workspace path is unavailable",
          description: "This thread does not have a workspace path to save into.",
        }),
      );
      return;
    }
    setSavePath((existing) => (existing.length > 0 ? existing : downloadFilename));
    setSaveConflict(null);
    setIsSaveDialogOpen(true);
  };

  const handleSaveToWorkspace = (mode: "create" | "replace" = "create") => {
    const relativePath = savePath.trim();
    if (
      !workspaceRoot ||
      isSavingToWorkspace ||
      (mode === "replace" && conflictingSavePath !== relativePath)
    ) {
      return;
    }
    if (!relativePath) {
      toastManager.add({
        type: "warning",
        title: "Enter a workspace path",
      });
      return;
    }

    setIsSavingToWorkspace(true);
    setSaveConflict(null);
    void (async () => {
      const result = await writeProjectFile({
        environmentId,
        input: {
          cwd: workspaceRoot,
          relativePath,
          contents: saveContents,
          mode,
        },
      });
      setIsSavingToWorkspace(false);
      if (result._tag === "Success") {
        setIsSaveDialogOpen(false);
        toastManager.add({
          type: "success",
          title: "Plan saved to workspace",
          description: result.value.relativePath,
        });
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        if (error instanceof ProjectWriteFileError && error.failure === "already_exists") {
          setSaveConflict({ environmentId, workspaceRoot, relativePath });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        const unsupported =
          message.includes("Unknown request tag") &&
          message.includes(WS_METHODS.projectsWriteFileAtomic);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save plan",
            description: unsupported
              ? "Update the server to save plans safely."
              : error instanceof Error
                ? error.message
                : "An error occurred while saving.",
          }),
        );
      }
    })();
  };

  return (
    <div className="rounded-3xl border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Plan</Badge>
          {/* Same heading level as the message author headings in the timeline,
              so a plan's own headings nest beneath it in the outline. */}
          <h3 className="truncate text-sm font-medium text-foreground">{title}</h3>
        </div>
        <Menu>
          <MenuTrigger
            render={<Button aria-label="Plan actions" size="icon-xs" variant="outline" />}
          >
            <EllipsisIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={handleCopyPlan}>
              {isCopied ? "Copied!" : "Copy to clipboard"}
            </MenuItem>
            <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
            <MenuItem onClick={openSaveDialog} disabled={!workspaceRoot || isSavingToWorkspace}>
              Save to workspace
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="mt-4">
        <div className={cn("relative", canCollapse && !expanded && "max-h-104 overflow-hidden")}>
          {canCollapse && !expanded ? (
            <ChatMarkdown
              text={collapsedPreview ?? ""}
              cwd={cwd}
              threadRef={threadRef}
              isStreaming={false}
              headingLevelOffset={3}
            />
          ) : (
            <ChatMarkdown
              text={displayedPlanMarkdown}
              cwd={cwd}
              threadRef={threadRef}
              isStreaming={false}
              headingLevelOffset={3}
            />
          )}
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Collapse plan" : "Expand plan"}
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={isSaveDialogOpen}
        onOpenChange={(open) => {
          if (!isSavingToWorkspace) {
            setIsSaveDialogOpen(open);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Save plan to workspace</DialogTitle>
            <DialogDescription>
              Enter a path relative to <code>{workspaceRoot ?? "the workspace"}</code>.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label htmlFor={savePathInputId} className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Workspace path</span>
              <Input
                id={savePathInputId}
                value={savePath}
                ref={savePathInputRef}
                onChange={(event) => {
                  setSavePath(event.target.value);
                  setSaveConflict(null);
                }}
                placeholder={downloadFilename}
                spellCheck={false}
                disabled={isSavingToWorkspace}
              />
            </label>
            {conflictingSavePath !== null ? (
              <p role="alert" className="mt-3 text-sm text-destructive">
                A file already exists at <code>{conflictingSavePath}</code>. It has not been
                changed. Choose another name or explicitly overwrite it.
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsSaveDialogOpen(false)}
              disabled={isSavingToWorkspace}
            >
              Cancel
            </Button>
            {conflictingSavePath !== null ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSaveConflict(null);
                    savePathInputRef.current?.focus();
                    savePathInputRef.current?.select();
                  }}
                  disabled={isSavingToWorkspace}
                >
                  Choose another name
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => handleSaveToWorkspace("replace")}
                  disabled={isSavingToWorkspace}
                >
                  Overwrite file
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                onClick={() => handleSaveToWorkspace()}
                disabled={isSavingToWorkspace}
              >
                {isSavingToWorkspace ? "Saving..." : "Save"}
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});
