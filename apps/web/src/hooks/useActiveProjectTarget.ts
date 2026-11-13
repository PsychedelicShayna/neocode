import { scopeThreadRef, type WorkspaceRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useLocation } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { nativeSessionAtoms, useNativeSessionSelection } from "~/state/neopiNativeSessions";

import { useProjects } from "~/state/entities";

import { useHandleNewThread } from "./useHandleNewThread";

const noNativeWorkspaceAtom = Atom.make(null);

export interface ActiveProjectTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectName: string;
  readonly threadRef: WorkspaceRef;
}

/** Resolves a real workspace for file navigation; a native session needs no project record. */
export function useActiveProjectTarget(): ActiveProjectTarget | null {
  const { activeDraftThread, activeThread } = useHandleNewThread();
  const projects = useProjects();
  const pathname = useLocation({ select: (location) => location.pathname });
  const selection = useNativeSessionSelection((state) => state.target);
  const nativeTarget = pathname === "/" ? selection : null;
  const nativeResult = useAtomValue(
    nativeTarget
      ? nativeSessionAtoms.watch({
          environmentId: nativeTarget.environmentId,
          input: { ref: nativeTarget.ref },
        })
      : noNativeWorkspaceAtom,
  );
  if (nativeTarget) {
    const feed =
      nativeResult && AsyncResult.isSuccess(nativeResult)
        ? nativeResult.value
        : nativeSessionAtoms.cached(nativeTarget);
    const cwd = feed?.session?.cwd;
    return cwd
      ? {
          environmentId: nativeTarget.environmentId,
          cwd,
          projectName: cwd.split(/[\\/]/).at(-1) || cwd,
          threadRef: nativeTarget,
        }
      : null;
  }
  const thread = activeThread ?? activeDraftThread;
  const threadId = activeThread?.id ?? activeDraftThread?.threadId;
  const project = thread
    ? projects.find(
        (candidate) =>
          candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
      )
    : null;
  const cwd = thread?.worktreePath ?? project?.workspaceRoot;

  if (!thread || !threadId || !project || !cwd) return null;

  return {
    environmentId: project.environmentId,
    cwd,
    projectName: project.title,
    threadRef: scopeThreadRef(thread.environmentId, threadId),
  };
}
