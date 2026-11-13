import { createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { NoProjectsHero } from "../components/NoProjectsHero";
import { WelcomeWizard } from "../components/onboarding/WelcomeWizard";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";

const decodeEnvironmentId = Schema.decodeOption(EnvironmentId);

export const Route = createFileRoute("/welcome")({
  beforeLoad: ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: WelcomeRouteView,
});

function WelcomeRouteView() {
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  // Resume only on a computer still present in this client's catalog.
  const resumeEnvironmentId = hash.startsWith("agents:")
    ? Option.getOrUndefined(decodeEnvironmentId(hash.slice("agents:".length)))
    : undefined;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments, isReady } = useEnvironments();
  // Trust the id only once the catalog has it; an unknown computer falls back to this one.
  const waitingForCatalog =
    !isReady && (resumeEnvironmentId !== undefined || primaryEnvironmentId === null);
  const resumeKnown =
    resumeEnvironmentId !== undefined &&
    environments.some((environment) => environment.environmentId === resumeEnvironmentId);
  // The root can remount this pending outlet after navigation; do not reopen setup.
  const isWelcomeRoute = useLocation({ select: (location) => location.pathname === "/welcome" });
  const [dismissed, setDismissed] = useState(false);
  const { authGateState } = Route.useRouteContext();
  if (waitingForCatalog) return null;
  return (
    <>
      <NoProjectsHero />
      {isWelcomeRoute && !dismissed ? (
        <WelcomeWizard
          localAvailable={authGateState.status === "authenticated"}
          resumeEnvironmentId={resumeKnown ? resumeEnvironmentId : undefined}
          onDone={async (destination) => {
            if (destination.kind === "neocore") {
              await navigate({
                to: "/settings/neocore",
                search: {
                  machine: destination.environmentId,
                  ...(destination.instanceId ? { instanceId: destination.instanceId } : {}),
                },
                replace: true,
              });
            } else {
              await navigate({ to: "/", replace: true });
            }
            setDismissed(true);
          }}
        />
      ) : null}
    </>
  );
}
