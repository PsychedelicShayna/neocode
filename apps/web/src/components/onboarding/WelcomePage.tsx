import { useAuth } from "@clerk/react";
import { AuthRelayReadScope, AuthRelayWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, SmartphoneIcon, TerminalIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";

import { APP_BASE_NAME, MOBILE_APP_URL } from "../../branding";
import { useCloudLinkState } from "../../cloud/cloudLinkState";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { PRIVACY_POLICY_URL } from "../../legalLinks";
import { cn } from "../../lib/utils";
import { welcomeOffersPhone } from "../../onboarding/welcomePage.logic";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { managedTelemetryOffMessage, useManagedPolicy } from "../../state/managedPolicy";
import { useEnvironmentScope } from "../../state/session";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { useDesktopCliCommand } from "../settings/CliCommandSettingsRow";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { QRCodeSvg } from "../ui/qr-code";

export function WelcomeExtras({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const isPrimary = usePrimaryEnvironmentId() === environmentId;
  const canReadRelay = useEnvironmentScope(environmentId, AuthRelayReadScope);
  const canWriteRelay = useEnvironmentScope(environmentId, AuthRelayWriteScope);
  const showPhone = welcomeOffersPhone({
    isPrimary,
    cloud: hasCloudPublicConfig(),
    canShare: canReadRelay && canWriteRelay,
    policy: useManagedPolicy(environmentId),
  });
  return (
    <>
      {isPrimary ? <CliPathSetup /> : null}
      {showPhone ? <PhoneSection environmentId={environmentId} /> : null}
      <TelemetryNotice environmentId={environmentId} />
    </>
  );
}

function TelemetryNotice({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const telemetryOff = managedTelemetryOffMessage(useManagedPolicy(environmentId));
  return (
    <p className="mt-auto pt-12 text-2xs leading-relaxed text-muted-foreground/70">
      {telemetryOff ?? `${APP_BASE_NAME} collects anonymous usage data to improve the app.`}{" "}
      {telemetryOff === undefined ? "To opt out, see the" : "See the"}{" "}
      <a
        className="underline decoration-current/40 underline-offset-2 hover:text-muted-foreground"
        href={PRIVACY_POLICY_URL}
        target="_blank"
        rel="noreferrer noopener"
      >
        privacy policy
      </a>
      .
    </p>
  );
}

// Each part of the page is one band: its label on the left, its rows on the right.
function WelcomeSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="grid gap-x-10 border-b border-border/60 py-4 sm:grid-cols-[6rem_minmax(0,1fr)]">
      <h2 className="text-sm leading-10 text-muted-foreground">{title}</h2>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

// Rows share one icon column, so names, checkboxes, and steps line up down the page.
function RowIcon({ children }: { readonly children: ReactNode }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
      {children}
    </span>
  );
}

function PhoneSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [open, setOpen] = useState(false);
  return (
    <WelcomeSection title="Phone">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex min-h-10 items-center gap-3 py-1">
          <RowIcon>
            <SmartphoneIcon className="size-4" />
          </RowIcon>
          <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
            Use {APP_BASE_NAME} on your phone
          </span>
          <CollapsibleTrigger render={<Button variant="ghost-muted" size="xs" />}>
            {open ? "Hide" : "Set up"}
            <ChevronDownIcon className={cn("size-3.5", open && "rotate-180")} />
          </CollapsibleTrigger>
        </div>
        <CollapsiblePanel>
          <div className="flex items-center gap-8 pt-2 pb-3 pl-8">
            <ol className="min-w-0 flex-1 space-y-5">
              <PhoneStep step={1}>
                <p className="text-sm text-foreground">Scan with your phone to get the app.</p>
              </PhoneStep>
              <PhoneStep step={2}>
                <PhoneConnectLink environmentId={environmentId} />
              </PhoneStep>
            </ol>
            {/* One code for both stores: the link opens the store that matches the phone. */}
            <div className="shrink-0 rounded-lg bg-white p-1.5">
              <QRCodeSvg
                value={MOBILE_APP_URL}
                size={124}
                level="M"
                marginSize={2}
                title={`${APP_BASE_NAME} app for iPhone and Android`}
              />
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </WelcomeSection>
  );
}

function PhoneStep({ step, children }: { readonly step: number; readonly children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="w-3 shrink-0 text-sm text-muted-foreground tabular-nums">{step}</span>
      <div className="flex min-w-0 flex-col items-start gap-2">{children}</div>
    </li>
  );
}

function PhoneConnectLink({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const linkState = useCloudLinkState(environmentId);
  const refreshLinkState = useEffectEvent(linkState.refresh);
  // The server rechecks the tunnel every 30 s; read its latest result while this panel is open.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 30 s interval that refreshes the cloud link reachability while mounted
  useEffect(() => {
    const interval = window.setInterval(() => refreshLinkState(), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  const link = linkState.data;
  // The phone reaches this computer through its tunnel; older servers leave that flag out.
  const shared =
    link !== null &&
    link.linked &&
    link.linkRevoked !== true &&
    link.cloudUserId === userId &&
    link.managedTunnelActive !== false;
  // The server checks the tunnel on its own; until it has, the result is unknown.
  const reachability = shared ? link.reachability?.status : undefined;
  const settingsLink = (label: string) => (
    <Button variant="outline" size="xs" render={<Link to="/settings/access" />}>
      {label}
    </Button>
  );
  if (isSignedIn && link === null && linkState.isPending) {
    return <p className="text-sm text-muted-foreground">Checking T3 Connect…</p>;
  }
  if (isSignedIn && linkState.error !== null) {
    return (
      <>
        <p className="text-sm text-foreground">Could not check T3 Connect.</p>
        {settingsLink("Check T3 Connect")}
      </>
    );
  }
  if (isSignedIn && reachability === "reachable") {
    return (
      <p className="flex gap-1.5 text-sm text-foreground">
        <CheckIcon className="mt-0.5 size-4 shrink-0 text-success-foreground" />
        Your phone can reach this computer. Sign in to the app with the same account.
      </p>
    );
  }
  if (isSignedIn && shared && reachability === undefined) {
    return (
      <p className="text-sm text-foreground">
        T3 Connect is on for this computer. Sign in to the app with the same account.
      </p>
    );
  }
  if (isSignedIn) {
    // Signing in alone does not share this computer, for example after "Not now".
    return (
      <>
        <p className="text-sm text-foreground">
          {shared
            ? "T3 Connect is on, but the app cannot reach this computer."
            : "Signed in. Share this computer so the app can reach it."}
        </p>
        {settingsLink(shared ? "Check T3 Connect" : "Set up T3 Connect")}
      </>
    );
  }
  return (
    <>
      <p className="text-sm text-foreground">
        Sign in to T3 Connect here, then in the app with the same account.
      </p>
      <Button variant="outline" size="xs" disabled={!isLoaded} onClick={openAuthPrompt}>
        Sign in to T3 Connect
      </Button>
    </>
  );
}

/** The desktop app links `t3` on a fresh install; this puts its folder on PATH when it is not. */
function CliPathSetup() {
  const { state, busy, run } = useDesktopCliCommand();
  const setup = state?.pathSetup;
  if (!setup) return null;
  return (
    <div className="flex min-h-10 items-center gap-3">
      <RowIcon>
        <TerminalIcon className="size-4" />
      </RowIcon>
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        {setup.added ? (
          <>
            Added to {setup.file}. Open a new terminal to use <code className="font-mono">t3</code>.
          </>
        ) : (
          <>
            Use <code className="font-mono">t3</code> from any terminal. Adds one line to{" "}
            {setup.file}.
          </>
        )}
      </p>
      {setup.added ? null : (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => run("addToPath")}>
          Add to PATH
        </Button>
      )}
    </div>
  );
}
