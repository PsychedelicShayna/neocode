import {
  NeoPiNativeSessionsError,
  type NeoPiNativeSessionsLaunchInput,
  type NeoPiNativeSessionsLaunchResult,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProjectWorkspacePreparation from "../../project/ProjectWorkspacePreparation.ts";
import { NeoPiNativeSessions } from "./NeoPiNativeSessions.ts";
import { neoPiRoleFromModelSlug } from "./NeoPiModelCatalog.ts";

export class NeoPiNativeTaskLaunch extends Context.Service<
  NeoPiNativeTaskLaunch,
  {
    readonly launch: (
      input: NeoPiNativeSessionsLaunchInput,
    ) => Effect.Effect<NeoPiNativeSessionsLaunchResult, NeoPiNativeSessionsError>;
  }
>()("t3/provider/neopi/NeoPiNativeTaskLaunch") {}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const workspaces = yield* ProjectWorkspacePreparation.ProjectWorkspacePreparation;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const sessions = yield* NeoPiNativeSessions;
  const git = yield* GitWorkflow.GitWorkflowService;
  const launch: NeoPiNativeTaskLaunch["Service"]["launch"] = Effect.fn(
    "NeoPiNativeTaskLaunch.launch",
  )(
    function* (input) {
      const project = Option.getOrUndefined(yield* projects.getById(input.projectId));
      if (!project)
        return yield* new NeoPiNativeSessionsError({
          message: "The selected project no longer exists.",
        });
      const strategy = input.workspaceStrategy;
      let cwd =
        strategy.type === "existing_worktree" ? strategy.worktreePath : project.workspaceRoot;
      let claimed: { path: string; branch: string } | undefined;
      if (strategy.type === "worktree") {
        const uuid = yield* randomUuidV4;
        const branch =
          strategy.branch ?? buildTemporaryWorktreeBranchName(() => uuid.replaceAll("-", ""));
        const prepared = yield* workspaces
          .createWorktree(
            {
              cwd: project.workspaceRoot,
              baseRef: strategy.baseRef,
              branch,
              ...(strategy.startFromOrigin === undefined
                ? {}
                : { startFromOrigin: strategy.startFromOrigin }),
            },
            {
              onWorktreeClaimed: (path, claimedBranch) =>
                Effect.sync(() => {
                  claimed = { path, branch: claimedBranch };
                }),
            },
          )
          .pipe(
            Effect.onError(() =>
              claimed
                ? git
                    .removeWorktree({ cwd: project.workspaceRoot, path: claimed.path, force: true })
                    .pipe(
                      Effect.andThen(
                        git.deleteLocalBranch({
                          cwd: project.workspaceRoot,
                          refName: claimed.branch,
                          force: true,
                        }),
                      ),
                      Effect.ignoreCause({ log: true }),
                    )
                : Effect.void,
            ),
          );
        cwd = prepared.worktree.path;
      }
      // Once native opening starts, a lost reply cannot prove it is safe to remove its working directory.
      const session = yield* sessions.open({
        providerInstanceId: input.modelSelection.instanceId,
        cwd,
        runtimeMode: input.runtimeMode,
      });
      const preparation = yield* Effect.gen(function* () {
        const selection = input.modelSelection;
        const role = neoPiRoleFromModelSlug(selection.model);
        if (role) {
          yield* sessions.request({ ref: session.ref, command: { type: "set_role", role } });
        } else {
          const slash = selection.model.indexOf("/");
          if (slash <= 0 || slash === selection.model.length - 1)
            return yield* new NeoPiNativeSessionsError({
              message: "The selected native model has no provider/model identity.",
            });
          yield* sessions.request({
            ref: session.ref,
            command: {
              type: "set_model",
              provider: selection.model.slice(0, slash),
              modelId: selection.model.slice(slash + 1),
            },
          });
        }
        for (const option of selection.options ?? []) {
          if (option.id === "reasoningEffort" && typeof option.value === "string")
            yield* sessions.request({
              ref: session.ref,
              command: { type: "set_thinking_level", level: option.value },
            });
          if (option.id === "fastMode" && typeof option.value === "boolean")
            yield* sessions.request({
              ref: session.ref,
              command: { type: "set_fast_mode", enabled: option.value },
            });
        }
        if (strategy.type === "root") return;
        const setup = yield* setupScripts.runForWorkspace({
          ref: session.ref,
          worktreePath: session.cwd,
          project: {
            id: project.id,
            workspaceRoot: project.workspaceRoot,
            scripts: project.scripts,
          },
          observeCompletion: {},
        });
        if (setup.status === "started" && !setup.async && setup.completion) {
          const completed = yield* setup.completion;
          if (completed.exitCode !== 0)
            return yield* new NeoPiNativeSessionsError({
              message: `Setup script exited with ${completed.exitCode ?? "no exit code"}.`,
            });
        }
      }).pipe(Effect.result);
      return preparation._tag === "Failure"
        ? { ...session, preparationError: preparation.failure.message }
        : session;
    },
    Effect.mapError((cause) => new NeoPiNativeSessionsError({ message: cause.message })),
  );
  return NeoPiNativeTaskLaunch.of({ launch });
});

export const layer = Layer.effect(NeoPiNativeTaskLaunch, make).pipe(
  Layer.provide(ProjectWorkspacePreparation.layer),
  Layer.provide(ProjectSetupScriptRunner.layer),
);
