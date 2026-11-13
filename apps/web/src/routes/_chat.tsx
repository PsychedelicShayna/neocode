import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { Outlet, createFileRoute, redirect, useMatches } from "@tanstack/react-router";
import { useState } from "react";

import { ThreadRouteView } from "../components/ThreadRouteView";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { SidebarInset } from "../components/ui/sidebar";
import { resolveThreadRouteTarget, type ThreadRouteTarget } from "../threadRoutes";
import { retainThreadFindForRoute } from "../components/chat/threadFindStore";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { NativeSessionWorkspace } from "../components/neopi/NativeSessionWorkspace";
import { HostedEmptyState } from "../components/HostedEmptyState";
import { useEnvironments } from "../state/environments";

const NATIVE_ROUTE_TARGET = { kind: "native" } as const;
type WorkspaceRouteTarget = ThreadRouteTarget | typeof NATIVE_ROUTE_TARGET;

function threadRouteTargetKey(target: WorkspaceRouteTarget | null) {
  if (!target) return null;
  if (target.kind === "native") return "native";
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
}

function ChatRouteLayout() {
  // Render both routes here so draft promotion keeps the same ChatView mounted.
  const threadTarget = useThreadRouteTarget();
  // Read matches, not location, so this agrees with the params useThreadRouteTarget reads.
  const modalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  const onNativeIndex = useMatches({
    select: (matches) => matches.at(-1)?.pathname === "/",
  });
  const workspaceTarget = onNativeIndex ? NATIVE_ROUTE_TARGET : threadTarget;
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();
  // Settings and Usage render over the thread that opened them, so ChatView never remounts.
  const [backgroundTarget, setBackgroundTarget] = useState(workspaceTarget);
  if (
    !modalOpen &&
    threadRouteTargetKey(backgroundTarget) !== threadRouteTargetKey(workspaceTarget)
  ) {
    setBackgroundTarget(workspaceTarget);
  }
  const shownTarget = modalOpen ? backgroundTarget : workspaceTarget;
  return (
    <>
      {shownTarget?.kind === "server" && !modalOpen ? (
        <ThreadLinkPrompt threadRef={shownTarget.threadRef} />
      ) : null}
      {shownTarget?.kind === "native" ? (
        authGateState.status === "hosted-static" && !isReady ? null : authGateState.status ===
            "hosted-static" && environments.length === 0 ? (
          <HostedEmptyState />
        ) : (
          <NativeSessionWorkspace background={modalOpen} />
        )
      ) : shownTarget ? (
        <ThreadRouteView target={shownTarget} background={modalOpen} />
      ) : modalOpen ? (
        <SidebarInset className="h-dvh" />
      ) : (
        <Outlet />
      )}
      {modalOpen ? <Outlet /> : null}
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    return { appModalPage: isAppModalPage(location.pathname) };
  },
  component: ChatRouteLayout,
  // Every match carries the whole location's params, so this layout sees the thread route's too.
  onEnter: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onStay: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onLeave: () => retainThreadFindForRoute({ modalPage: false, threadRef: null }),
});

function retainThreadFindForRouteMatch(
  modalPage: boolean,
  params: Partial<Record<"environmentId" | "threadId", string>>,
) {
  const target = resolveThreadRouteTarget(params);
  retainThreadFindForRoute({
    modalPage,
    threadRef: target?.kind === "server" ? target.threadRef : null,
  });
}
