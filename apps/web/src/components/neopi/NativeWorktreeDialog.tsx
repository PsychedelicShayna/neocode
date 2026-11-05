import { sanitizeNewRefName } from "@t3tools/shared/git";
import { useState } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

/**
 * Create a worktree for the session's folder through NeoPi itself: `/wt` makes
 * the branch, carries uncommitted changes, and relocates the session, so NeoPi
 * stays the authority for where the session lives. Sending it as a prompt keeps
 * the progress and the summary in the transcript.
 */
export function NativeWorktreeDialog(props: {
  readonly cwd: string;
  readonly branch: string | null;
  /** The session already works in a linked worktree. */
  readonly linked: boolean;
  readonly lockReason: string | null;
  readonly onClose: () => void;
  readonly onSend: (message: string) => void;
  readonly onReturnFocus: () => void;
}) {
  const [name, setName] = useState("");
  const submit = () => {
    if (props.lockReason !== null) return;
    const branch = sanitizeNewRefName(name);
    props.onSend(branch ? `/wt ${branch}` : "/wt");
    props.onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup
        className="sm:max-w-md"
        aria-label="Create a worktree"
        finalFocus={props.onReturnFocus}
      >
        <DialogHeader>
          <DialogTitle>
            {props.linked ? "Move to another worktree" : "Work in a new worktree"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            NeoPi creates a git worktree of <span className="font-mono text-xs">{props.cwd}</span>
            {props.branch ? (
              <>
                {" "}
                (on <span className="font-mono text-xs">{props.branch}</span>)
              </>
            ) : null}
            , carries uncommitted changes along, and moves this session into it.
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">
              New branch (blank lets NeoPi name it)
            </span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="feature/name"
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                submit();
              }}
            />
          </label>
          {props.lockReason ? (
            <p role="status" className="text-xs text-muted-foreground">
              {props.lockReason}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={props.lockReason !== null} onClick={submit}>
            Create worktree
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
