import type { GitCommandError, VcsCreateWorktreeResult } from "@t3tools/contracts";
import {
  flattenTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  WORKTREE_BRANCH_PREFIX,
} from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export class ProjectWorkspacePreparation extends Context.Service<
  ProjectWorkspacePreparation,
  {
    readonly createWorktree: (
      input: {
        readonly cwd: string;
        readonly baseRef: string;
        readonly branch: string;
        readonly startFromOrigin?: boolean;
      },
      observe?: {
        readonly onFetchStatus?: (status: "running" | "done" | "skipped") => Effect.Effect<void>;
        readonly onCheckoutStarted?: Effect.Effect<void>;
        readonly onWorktreeClaimed?: (path: string, branch: string) => Effect.Effect<void>;
        readonly onCheckoutProgress?: GitVcsDriver.CreateWorktreeProgress["onCheckoutProgress"];
      },
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
  }
>()("t3/project/ProjectWorkspacePreparation") {}

const make = Effect.gen(function* () {
  const git = yield* GitWorkflow.GitWorkflowService;
  const createWorktree: ProjectWorkspacePreparation["Service"]["createWorktree"] = Effect.fn(
    "ProjectWorkspacePreparation.createWorktree",
  )(function* (input, observe) {
    let startRef = input.baseRef;
    let baseRefName = input.baseRef;
    const remote =
      input.startFromOrigin === true
        ? yield* git.resolveWorktreeBaseRemote({ cwd: input.cwd, refName: input.baseRef })
        : null;
    yield* observe?.onFetchStatus?.(remote === null ? "skipped" : "running") ?? Effect.void;
    if (remote !== null) {
      const base = yield* git.fetchWorktreeBaseCommit({
        cwd: input.cwd,
        refName: input.baseRef,
        remote,
      });
      if (base !== null) {
        startRef = base.commitSha;
        baseRefName = `refs/remotes/${base.remoteRefName}`;
      }
      yield* observe?.onFetchStatus?.("done") ?? Effect.void;
    }
    const branch =
      isTemporaryWorktreeBranch(input.branch) &&
      (yield* git.hasCommit({ cwd: input.cwd, refName: `refs/heads/${WORKTREE_BRANCH_PREFIX}` }))
        ? flattenTemporaryWorktreeBranchName(input.branch)
        : input.branch;
    yield* observe?.onCheckoutStarted ?? Effect.void;
    return yield* git.createWorktree(
      { cwd: input.cwd, refName: startRef, newRefName: branch, baseRefName, path: null },
      {
        progress: {
          onWorktreeClaimed: (path) => observe?.onWorktreeClaimed?.(path, branch) ?? Effect.void,
          ...(observe?.onCheckoutProgress
            ? { onCheckoutProgress: observe.onCheckoutProgress }
            : {}),
        },
      },
    );
  });
  return ProjectWorkspacePreparation.of({ createWorktree });
});

export const layer = Layer.effect(ProjectWorkspacePreparation, make);
