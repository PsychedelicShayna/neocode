import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  NeoPiNativeSessionsError,
  ProjectId,
  ProviderInstanceId,
  type NeoPiNativeSessionsLaunchInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProjectWorkspacePreparation from "../../project/ProjectWorkspacePreparation.ts";
import { NeoPiNativeSessions } from "./NeoPiNativeSessions.ts";
import * as NativeTaskLaunch from "./NeoPiNativeTaskLaunch.ts";

const input: NeoPiNativeSessionsLaunchInput = {
  projectId: ProjectId.make("project"),
  modelSelection: { instanceId: ProviderInstanceId.make("neopi"), model: "test/model" },
  runtimeMode: "approval-required",
  workspaceStrategy: { type: "worktree", baseRef: "main", branch: "feature" },
};

const makeHarness = Effect.fn("NativeTaskLaunchTest.makeHarness")(function* (options: {
  readonly loseOpenReply?: boolean;
  readonly failSetup?: boolean;
  readonly checkoutReached?: Deferred.Deferred<void>;
}) {
  const workspaces = new Set(["/repo/other"]);
  const branches = new Set(["other"]);
  const nativeOwners = new Set<string>();
  const session = {
    ref: {
      providerInstanceId: input.modelSelection.instanceId,
      sessionFile: "/sessions/native.jsonl",
    },
    sessionId: "native",
    cwd: "/repo/feature",
    attachment: "owned" as const,
    capabilities: [],
    state: {},
  };
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(ProjectService.ProjectService)({
      getById: () =>
        Effect.succeedSome({
          id: input.projectId,
          title: "Project",
          workspaceRoot: "/repo",
          repositoryIdentity: null,
          faviconPath: null,
          defaultModelSelection: null,
          defaultThreadEnvMode: null,
          scripts: [],
          pinnedAt: null,
          archivedAt: null,
          deletedAt: null,
          createdAt: "2026-11-11T00:00:00.000Z",
          updatedAt: "2026-11-11T00:00:00.000Z",
        }),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      createWorktree: (request, observe) =>
        Effect.gen(function* () {
          if (request.newRefName === undefined)
            return yield* Effect.die("Native worktree launch must choose a branch");
          workspaces.add(session.cwd);
          branches.add(request.newRefName);
          yield* observe?.progress?.onWorktreeClaimed?.(session.cwd) ?? Effect.void;
          if (options.checkoutReached) {
            yield* Deferred.succeed(options.checkoutReached, undefined);
            return yield* Effect.never;
          }
          return { worktree: { path: session.cwd, refName: request.newRefName } };
        }),
      removeWorktree: ({ path }) =>
        Effect.sync(() => {
          workspaces.delete(path);
        }),
      deleteLocalBranch: ({ refName }) =>
        Effect.sync(() => {
          branches.delete(refName);
        }),
    }),
    Layer.mock(NeoPiNativeSessions)({
      open: () =>
        Effect.gen(function* () {
          nativeOwners.add(session.cwd);
          if (options.loseOpenReply)
            return yield* new NeoPiNativeSessionsError({
              message: "Native open response was lost.",
            });
          return session;
        }),
      request: () => Effect.succeed({ accepted: true }),
    }),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
      runForWorkspace: () =>
        options.failSetup
          ? Effect.fail(
              new ProjectSetupScriptRunner.ProjectSetupScriptUnsupportedShellError({
                shell: "cmd.exe",
              }),
            )
          : Effect.succeed({ status: "no-script" as const }),
    }),
  );
  const launcher = yield* NativeTaskLaunch.make.pipe(
    Effect.provide(ProjectWorkspacePreparation.layer.pipe(Layer.provideMerge(dependencies))),
  );
  return { launcher, workspaces, branches, nativeOwners, session };
});

it.effect(
  "retains the canonical session and its workspace when setup fails after native creation",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ failSetup: true });
      const result = yield* h.launcher.launch(input);
      expect(result.ref).toEqual(h.session.ref);
      expect(result.preparationError).toContain("cmd.exe");
      expect(h.nativeOwners.has(result.cwd)).toBe(true);
      expect(h.workspaces.has(result.cwd)).toBe(true);
    }),
);

it.effect(
  "does not delete a native owner's working directory after an ambiguous open failure",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ loseOpenReply: true });
      const result = yield* Effect.exit(h.launcher.launch(input));
      expect(Exit.isFailure(result)).toBe(true);
      expect([...h.nativeOwners]).toEqual([h.session.cwd]);
      expect([...h.workspaces]).toEqual(["/repo/other", h.session.cwd]);
      expect([...h.branches]).toEqual(["other", "feature"]);
    }),
);

it.effect(
  "cancelling checkout releases only the claimed worktree before a native owner can start",
  () =>
    Effect.gen(function* () {
      const checkoutReached = yield* Deferred.make<void>();
      const h = yield* makeHarness({ checkoutReached });
      const fiber = yield* Effect.forkChild(h.launcher.launch(input));
      yield* Deferred.await(checkoutReached);
      yield* Fiber.interrupt(fiber);
      expect([...h.workspaces]).toEqual(["/repo/other"]);
      expect([...h.branches]).toEqual(["other"]);
      expect([...h.nativeOwners]).toEqual([]);
    }),
);
