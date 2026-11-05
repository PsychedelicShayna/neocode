import type { EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronDownIcon, GitBranchIcon, GitBranchPlusIcon } from "lucide-react";
import { useDeferredValue, useMemo, useState, useTransition } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { usePaginatedBranches } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { projectEnvironment } from "../../state/projects";
import { vcsEnvironment } from "../../state/vcs";
import { ComposerControl } from "../chat/ComposerControl";
import { ComposerSurface } from "../chat/ComposerSurface";
import { useComposerMenuProps } from "../chat/composerEventScope";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxStatus,
  ComboboxTrigger,
} from "../ui/combobox";
import { MiddleTruncate } from "../ui/middle-truncate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { NativeWorktreeDialog } from "./NativeWorktreeDialog";
import {
  CREATE_BRANCH_PREFIX,
  isLinkedWorktreeGitFile,
  nativeBranchPickerItems,
} from "./nativeBranchToolbar.logic";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "An error occurred.";

/**
 * The native session's branch and worktree controls, under the composer like
 * T3's branch toolbar. The branch is the session folder's own checkout, read
 * and switched through NeoCode's VCS operations by cwd; the worktree action is
 * NeoPi's `/wt`, which relocates the session itself.
 */
export function NativeBranchToolbar(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly busy: boolean;
  readonly connected: boolean;
  /** Sends a slash command to NeoPi as a prompt. */
  readonly onRunCommand: (message: string) => void;
  readonly onReturnFocus: () => void;
}) {
  const { environmentId, cwd } = props;
  const menuProps = useComposerMenuProps();
  const status = useEnvironmentQuery(
    cwd ? vcsEnvironment.status({ environmentId, input: { cwd } }) : null,
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  const [switching, startSwitching] = useTransition();
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const createRef = useAtomCommand(vcsEnvironment.createRef, { reportFailure: false });
  const branches = usePaginatedBranches(
    useMemo(
      () => ({ environmentId, cwd: open ? cwd : null, query: deferredQuery }),
      [environmentId, cwd, open, deferredQuery],
    ),
  );
  // A linked worktree's `.git` is a file; the primary checkout's is a directory,
  // which reads as an error here.
  const gitFile = useEnvironmentQuery(
    cwd
      ? projectEnvironment.readFile({ environmentId, input: { cwd, relativePath: ".git" } })
      : null,
  );
  const linkedWorktree = isLinkedWorktreeGitFile(gitFile.data?.contents);
  const picker = useMemo(
    () => nativeBranchPickerItems(branches.refs, deferredQuery),
    [branches.refs, deferredQuery],
  );
  const refByName = useMemo(
    () => new Map(branches.refs.map((ref) => [ref.name, ref] as const)),
    [branches.refs],
  );
  if (!cwd || !status.data?.isRepo) return null;
  const branch = status.data.refName;
  const lockReason = !props.connected
    ? "Reconnect NeoPi first."
    : props.busy
      ? "NeoPi is working. Wait for it or interrupt it first."
      : null;
  const hasMore = branches.data?.nextCursor != null;
  const refresh = () => {
    branches.refresh();
    status.refresh();
  };
  const report = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: errorMessage(squashAtomCommandFailure(result)),
      }),
    );
  };
  const choose = (item: string) => {
    if (lockReason !== null || switching) return;
    setOpen(false);
    setQuery("");
    props.onReturnFocus();
    startSwitching(async () => {
      if (item.startsWith(CREATE_BRANCH_PREFIX)) {
        const result = await createRef({
          environmentId,
          input: { cwd, refName: item.slice(CREATE_BRANCH_PREFIX.length), switchRef: true },
        });
        if (result._tag !== "Success") report("Failed to create branch.", result);
      } else if (item !== branch) {
        const result = await switchRef({ environmentId, input: { cwd, refName: item } });
        if (result._tag !== "Success") report("Failed to switch branch.", result);
      }
      refresh();
    });
  };
  return (
    <>
      <ComposerSurface.ContextStrip className="gap-1 text-xs font-normal text-muted-foreground/70">
        {/* The span carries the reason: a disabled button swallows hover. */}
        <span
          title={
            lockReason ??
            (linkedWorktree
              ? "This session works in a worktree. Move it into another one."
              : "Move this session into a new git worktree")
          }
          className="flex"
        >
          <ComposerControl
            size="xs"
            aria-label="Create a worktree"
            disabled={lockReason !== null}
            onClick={() => setWorktreeOpen(true)}
          >
            <GitBranchPlusIcon className="size-3 shrink-0 opacity-70" />
            <span>{linkedWorktree ? "Worktree" : "New worktree"}</span>
          </ComposerControl>
        </span>
        <Combobox
          items={picker.items}
          filteredItems={picker.items}
          autoHighlight
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setQuery("");
          }}
          value={branch}
          onValueChange={(value) => {
            if (typeof value === "string") choose(value);
          }}
        >
          <span title={lockReason ?? undefined} className="ml-auto flex min-w-0">
            <ComboboxTrigger
              render={<ComposerControl size="xs" />}
              className="min-w-0 max-w-full active:scale-100"
              aria-label="Switch branch"
              disabled={lockReason !== null || switching}
            >
              <GitBranchIcon className="size-3 shrink-0 opacity-70" />
              <span className="min-w-0 max-w-60">
                <MiddleTruncate value={branch ?? "detached HEAD"} />
              </span>
              <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
            </ComboboxTrigger>
          </span>
          <ComboboxPopup align="end" side="top" className="flex w-80 flex-col" {...menuProps}>
            <ComboboxSearchInput
              aria-label="Search branches"
              placeholder="Search or create a branch..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <ComboboxEmpty>No branches found.</ComboboxEmpty>
            <ComboboxList>
              {(item: string) => {
                const create = item.startsWith(CREATE_BRANCH_PREFIX);
                const ref = refByName.get(item);
                // Git refuses to check a branch out where another worktree holds it.
                const heldElsewhere = !create && ref?.worktreePath != null && !ref.current;
                return (
                  <ComboboxItem
                    key={item}
                    hideIndicator
                    value={item}
                    disabled={heldElsewhere || lockReason !== null || switching}
                  >
                    {create ? (
                      <span className="truncate">
                        Create and switch to &quot;{item.slice(CREATE_BRANCH_PREFIX.length)}&quot;
                      </span>
                    ) : (
                      <>
                        <MiddleTruncate value={item} className="flex-1" />
                        {ref?.current ? (
                          <span className="shrink-0 text-3xs text-muted-foreground/45">
                            current
                          </span>
                        ) : heldElsewhere ? (
                          <span className="shrink-0 text-3xs text-muted-foreground/45">
                            in worktree
                          </span>
                        ) : ref?.isDefault ? (
                          <span className="shrink-0 text-3xs text-muted-foreground/45">
                            default
                          </span>
                        ) : null}
                      </>
                    )}
                  </ComboboxItem>
                );
              }}
            </ComboboxList>
            {lockReason ? (
              <ComboboxStatus>{lockReason}</ComboboxStatus>
            ) : branches.error ? (
              <ComboboxStatus>{branches.error}</ComboboxStatus>
            ) : hasMore ? (
              <ComboboxStatus>
                Showing {branches.refs.length} of {branches.data?.totalCount ?? 0}. Type to narrow.
              </ComboboxStatus>
            ) : null}
          </ComboboxPopup>
        </Combobox>
      </ComposerSurface.ContextStrip>
      {worktreeOpen ? (
        <NativeWorktreeDialog
          cwd={cwd}
          branch={branch}
          linked={linkedWorktree}
          lockReason={lockReason}
          onClose={() => setWorktreeOpen(false)}
          onSend={props.onRunCommand}
          onReturnFocus={props.onReturnFocus}
        />
      ) : null}
    </>
  );
}
