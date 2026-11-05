import { APP_BASE_NAME } from "~/branding";
import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ProviderDriverKind } from "@t3tools/contracts";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
  CloudIcon,
  CopyIcon,
  LinkIcon,
  MonitorIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { useCompleteOnboarding } from "../../onboarding/firstRun";
import {
  getOnboardingProviderState,
  selectOnboardingProvidersByDriver,
} from "../../onboarding/providerReadiness.logic";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { isOnboardingRelayEnvironment } from "../../onboarding/targetEnvironment.logic";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectPairing } from "../../connection/onboarding";
import { getProviderSummary } from "../settings/providerStatus";
import { getDriverOption } from "../settings/providerDriverMeta";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";
import { NeoPiInstallHelp } from "../neopi/NeoPiInstallHelp";
import { NeoProxyConnect } from "../neopi/NeoProxyConnect";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { WizardPanel, WizardSteps, WizardPopup, WizardHeader } from "../ui/wizard";
import { Dialog } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { cn } from "../../lib/utils";

/**
 * First-run flow: connect a computer, meet NeoProxy, confirm NeoPi. Project
 * folders are added explicitly from the workspace after setup; onboarding
 * never scans or imports history. Every step can be skipped.
 */

type WizardStep = "connection" | "neoproxy" | "agents";
const ONBOARDING_STAGES = ["Connect", "NeoProxy", "NeoPi"] as const;
const STEP_ORDER: readonly WizardStep[] = ["connection", "neoproxy", "agents"];

export type WelcomeWizardDestination =
  | { readonly kind: "workspace" }
  | {
      readonly kind: "neocore";
      readonly environmentId: EnvironmentId;
      readonly instanceId?: ProviderInstanceId;
    };

export function WelcomeWizard({
  localAvailable,
  onDone,
}: {
  /** Whether this client is authenticated to the server serving the app. */
  readonly localAvailable: boolean;
  readonly onDone: (destination: WelcomeWizardDestination) => void;
}) {
  const completeOnboarding = useCompleteOnboarding();
  const [step, setStep] = useState<WizardStep>("connection");
  const { environments } = useEnvironments();
  const [selection, setSelection] = useState<ReadonlySet<EnvironmentId> | null>(null);
  const autoSelectedComputers = useRef(new Set<EnvironmentId>());
  const [setupIds, setSetupIds] = useState<readonly EnvironmentId[]>([]);
  const finishingPromiseRef = useRef<Promise<boolean> | null>(null);
  const completionErrorToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const primaryEnvironment = usePrimaryEnvironment();
  useEffect(() => {
    const newComputers = environments.filter(
      (environment) => !autoSelectedComputers.current.has(environment.environmentId),
    );
    if (newComputers.length === 0) return;
    for (const environment of newComputers) {
      autoSelectedComputers.current.add(environment.environmentId);
    }
    setSelection(
      (current) =>
        new Set([
          ...(current ?? []),
          ...newComputers.map((environment) => environment.environmentId),
        ]),
    );
  }, [environments]);
  const selectedIds =
    selection ?? new Set(primaryEnvironment ? [primaryEnvironment.environmentId] : []);
  const startSetup = (ids: readonly EnvironmentId[]) => {
    if (ids.length === 0) return;
    setSetupIds(ids);
    setStep("neoproxy");
  };
  const stageIndex = STEP_ORDER.indexOf(step);
  const finish = useCallback(
    (destination: WelcomeWizardDestination) => {
      if (finishingPromiseRef.current !== null) return finishingPromiseRef.current;
      if (completionErrorToastIdRef.current !== null) {
        toastManager.close(completionErrorToastIdRef.current);
        completionErrorToastIdRef.current = null;
      }

      const completion = completeOnboarding()
        .then(() => {
          if (completionErrorToastIdRef.current !== null) {
            toastManager.close(completionErrorToastIdRef.current);
            completionErrorToastIdRef.current = null;
          }
          onDone(destination);
          return true;
        })
        .catch(() => {
          const errorToast = {
            type: "error",
            title: "Could not finish setup",
            description: "Your settings could not be saved. Try again.",
          } as const;
          if (completionErrorToastIdRef.current === null) {
            completionErrorToastIdRef.current = toastManager.add(errorToast);
          } else {
            toastManager.update(completionErrorToastIdRef.current, errorToast);
          }
          return false;
        })
        .finally(() => {
          if (finishingPromiseRef.current === completion) {
            finishingPromiseRef.current = null;
          }
        });
      finishingPromiseRef.current = completion;
      return completion;
    },
    [completeOnboarding, onDone],
  );

  const skip = () => void finish({ kind: "workspace" });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Closing the dialog is the same as skipping: the workspace is always reachable.
        if (!open) skip();
      }}
    >
      <WizardPopup
        bottomStickOnMobile={false}
        showCloseButton={false}
        initialFocus={() => document.getElementById("onboarding-pairing-url") ?? true}
      >
        <WizardHeader
          title={`Set up ${APP_BASE_NAME}`}
          identity={
            <div className="flex items-baseline gap-1.5" role="img" aria-label={APP_BASE_NAME}>
              <span className="text-2xl font-medium tracking-tight text-muted-foreground">
                {APP_BASE_NAME}
              </span>
            </div>
          }
        >
          <WizardSteps
            steps={ONBOARDING_STAGES}
            currentStep={stageIndex}
            isStepDisabled={(index) => index >= stageIndex}
            onStepChange={(index) => {
              if (index > stageIndex) return;
              setStep(STEP_ORDER[index] ?? "connection");
            }}
          />
        </WizardHeader>

        <WizardPanel>
          {step === "connection" ? (
            <ConnectionStep
              expandPairingInitially={!localAvailable && !hasCloudPublicConfig()}
              selectedIds={selectedIds}
              autoSelectedComputers={autoSelectedComputers.current}
              onSelectionChange={setSelection}
              onToggleEnvironment={(environmentId, checked) =>
                setSelection((current) => {
                  const next = new Set(current ?? selectedIds);
                  if (checked) next.add(environmentId);
                  else next.delete(environmentId);
                  return next;
                })
              }
              onContinue={() =>
                startSetup(
                  environments
                    .filter((environment) => selectedIds.has(environment.environmentId))
                    .map((environment) => environment.environmentId),
                )
              }
              onPaired={(environmentId) => {
                setSelection((current) => new Set([...(current ?? selectedIds), environmentId]));
              }}
            />
          ) : step === "neoproxy" ? (
            <NeoProxyStep
              environmentIds={setupIds}
              onBack={() => setStep("connection")}
              onContinue={() => setStep("agents")}
            />
          ) : (
            <AgentsStep
              environmentIds={setupIds}
              onContinue={() => void finish({ kind: "workspace" })}
              onOpenSettings={(environmentId, instanceId) =>
                void finish({
                  kind: "neocore",
                  environmentId,
                  ...(instanceId ? { instanceId } : {}),
                })
              }
            />
          )}
          <div className="mt-4 flex justify-center">
            <Button variant="link" size="sm" className="text-muted-foreground" onClick={skip}>
              Skip setup and open the workspace
            </Button>
          </div>
        </WizardPanel>
      </WizardPopup>
    </Dialog>
  );
}

// ── Step 2: NeoProxy ─────────────────────────────────────────

type NeoProxyChoice = "have" | "host" | "later";

/** NeoPi on the chosen computer runs the NeoProxy login; the step waits on it. */
function useNeoPiProviderFor(environmentId: EnvironmentId) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  return useMemo(() => {
    const provider = selectOnboardingProvidersByDriver(providers).get("neopi");
    return { provider, state: getOnboardingProviderState(provider) };
  }, [providers]);
}

function NeoProxyStep({
  environmentIds,
  onBack,
  onContinue,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly onBack: () => void;
  readonly onContinue: () => void;
}) {
  const environmentId = environmentIds[0];
  useEffect(() => {
    if (!environmentId) onContinue();
  }, [environmentId, onContinue]);
  if (!environmentId) return null;
  return <NeoProxyStepBody environmentId={environmentId} onBack={onBack} onContinue={onContinue} />;
}

function NeoProxyStepBody({
  environmentId,
  onBack,
  onContinue,
}: {
  readonly environmentId: EnvironmentId;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}) {
  const { provider, state } = useNeoPiProviderFor(environmentId);
  const [choice, setChoice] = useState<NeoProxyChoice | null>(null);
  const [connected, setConnected] = useState(false);
  const neoPiReady = state === "ready" || state === "signIn";
  const choices: ReadonlyArray<{ id: NeoProxyChoice; title: string; detail: string }> = [
    {
      id: "have",
      title: "Connect to a NeoProxy I already have",
      detail: "You have the address and a member key from whoever runs it.",
    },
    {
      id: "host",
      title: "I'll host one myself",
      detail: "Run it on this computer or a server, then connect from Models.",
    },
    {
      id: "later",
      title: "Not now",
      detail: "Use the provider accounts signed in to NeoPi. NeoProxy stays available in Models.",
    },
  ];
  return (
    <StepShell
      title="NeoCode and NeoProxy work together"
      description="NeoProxy is a model switch for a team: provider accounts and keys go in, and everyone gets neoproxy/… models with their own budget. NeoCode talks to it through NeoPi, so you can pick those models instead of local credentials."
    >
      <NeoProxyFlowFigure className="mt-5 w-full" />
      <fieldset className="mt-5 space-y-2">
        <legend className="sr-only">How will you use NeoProxy?</legend>
        {choices.map((option) => {
          const selected = choice === option.id;
          return (
            <div
              key={option.id}
              className={cn(
                "rounded-lg border bg-background transition-colors",
                selected ? "border-foreground/40" : "border-border",
              )}
            >
              <label className="flex cursor-pointer items-start gap-3 px-3 py-3">
                <input
                  type="radio"
                  name="neoproxy-choice"
                  className="mt-1 accent-foreground"
                  checked={selected}
                  onChange={() => setChoice(option.id)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">{option.title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                    {option.detail}
                  </span>
                </span>
              </label>
              {selected && option.id === "have" ? (
                <div className="border-t border-border px-3 py-3">
                  {environmentId && provider && neoPiReady ? (
                    <NeoProxyConnect
                      environmentId={environmentId}
                      providerInstanceId={provider.instanceId}
                      autoFocus
                      onConnected={() => setConnected(true)}
                    />
                  ) : state === "checking" ? (
                    <p role="status" className="text-xs text-muted-foreground">
                      Checking NeoPi…
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      NeoPi isn't ready on this computer yet, and the connection runs through it.
                      Finish the next step, then connect from Models.
                    </p>
                  )}
                </div>
              ) : null}
              {selected && option.id === "host" ? (
                <div className="space-y-2 border-t border-border px-3 py-3">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    NeoProxy is a single Go binary with its own web console. Build it, run it, and
                    open the console to add provider accounts and invite people.
                  </p>
                  <CommandBlock command="git clone https://github.com/PsychedelicShayna/neoproxy && cd neoproxy && CGO_ENABLED=1 go build -o neoproxy ./cmd/server" />
                  <CommandBlock command="./neoproxy" />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    The console answers at{" "}
                    <code className="font-mono">http://127.0.0.1:8317/neo/</code>. Once it runs,
                    connect from Models with the address and a member key you create there.
                  </p>
                </div>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      <div className="mt-6 flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onContinue} disabled={choice === null && !connected}>
          {choice === "have" && !connected ? "Continue without connecting" : "Continue"}
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </StepShell>
  );
}

/** Providers feed the switch; the switch serves `neoproxy/` models to people. */
function NeoProxyFlowFigure({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 600 96"
      className={className}
      role="img"
      aria-label="Provider accounts flow into NeoProxy, which serves neoproxy models to people"
    >
      <defs>
        <linearGradient id="neoproxy-ribbon" x1="0" x2="1">
          <stop offset="0" stopColor="#5ad8e6" />
          <stop offset="1" stopColor="#f068c8" />
        </linearGradient>
      </defs>
      <g fontSize="11" fontFamily="var(--font-sans)" fill="currentColor">
        <text x="0" y="20" opacity="0.7">
          Anthropic
        </text>
        <text x="0" y="50" opacity="0.7">
          Codex
        </text>
        <text x="0" y="80" opacity="0.7">
          xAI
        </text>
      </g>
      <g fill="none" stroke="url(#neoproxy-ribbon)" strokeLinecap="round" opacity="0.9">
        <path d="M70 16 C 140 16, 150 48, 215 48" strokeWidth="3" />
        <path d="M70 46 C 140 46, 150 48, 215 48" strokeWidth="5" />
        <path d="M70 76 C 140 76, 150 48, 215 48" strokeWidth="2" />
      </g>
      <rect
        x="215"
        y="30"
        width="118"
        height="36"
        rx="8"
        fill="#f068c8"
        fillOpacity="0.14"
        stroke="#f068c8"
        strokeOpacity="0.55"
      />
      <text x="274" y="52" textAnchor="middle" fontSize="12" fontWeight="600" fill="currentColor">
        NeoProxy
      </text>
      <g fill="none" stroke="#5ad8e6" strokeLinecap="round" opacity="0.85">
        <path d="M333 48 C 390 48, 400 16, 455 16" strokeWidth="4" />
        <path d="M333 48 C 390 48, 400 48, 455 48" strokeWidth="2.5" />
        <path d="M333 48 C 390 48, 400 80, 455 80" strokeWidth="2" />
      </g>
      <g fontSize="11" fontFamily="var(--font-mono)" fill="currentColor">
        <text x="462" y="20">
          <tspan opacity="0.6">neoproxy/</tspan>
          <tspan fill="#f068c8">heavy</tspan>
        </text>
        <text x="462" y="52">
          <tspan opacity="0.6">neoproxy/</tspan>
          <tspan fill="#f068c8">default</tspan>
        </text>
        <text x="462" y="84">
          <tspan opacity="0.6">neoproxy/</tspan>
          <tspan fill="#f068c8">small</tspan>
        </text>
      </g>
    </svg>
  );
}

// ── Step 1: connection choice ────────────────────────────────

function ConnectionStep({
  autoSelectedComputers,
  expandPairingInitially,
  selectedIds,
  onSelectionChange,
  onToggleEnvironment,
  onContinue,
  onPaired,
}: {
  readonly autoSelectedComputers: Set<EnvironmentId>;
  readonly expandPairingInitially: boolean;
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId>) => void;
  readonly onToggleEnvironment: (environmentId: EnvironmentId, checked: boolean) => void;
  readonly onContinue: () => void;
  readonly onPaired: (environmentId: EnvironmentId) => void;
}) {
  const { environments } = useEnvironments();
  const cloudEnabled = hasCloudPublicConfig();
  const directEnvironments = environments.filter(
    (environment) => !cloudEnabled || !isOnboardingRelayEnvironment(environment),
  );
  const [pairingOpen, setPairingOpen] = useState(expandPairingInitially);
  const [isPairing, setIsPairing] = useState(false);
  const ready =
    selectedIds.size > 0 &&
    [...selectedIds].every((id) =>
      environments.some(
        (environment) =>
          environment.environmentId === id && environment.connection.phase === "connected",
      ),
    );
  const continueRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (
      ready &&
      (document.activeElement === document.body ||
        document.activeElement?.getAttribute("role") === "dialog")
    ) {
      continueRef.current?.focus();
    }
  }, [ready]);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Connect your computers
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        Choose one or more computers. We’ll check NeoPi on each.
      </p>
      {directEnvironments.length > 0 ? (
        <fieldset className="mt-5 space-y-2">
          <legend className="sr-only">Computers to set up</legend>
          {directEnvironments.map((environment) => (
            <label
              key={environment.environmentId}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-3"
            >
              <Checkbox
                checked={selectedIds.has(environment.environmentId)}
                onCheckedChange={(checked) => {
                  const next = new Set(selectedIds);
                  if (checked) next.add(environment.environmentId);
                  else next.delete(environment.environmentId);
                  onSelectionChange(next);
                }}
              />
              <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-sm font-medium break-words">
                    {environment.label}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {environment.connection.phase === "connected" ? "Connected" : "Connecting…"}
                  </span>
                </span>
                {environment.displayUrl ? (
                  <span className="mt-0.5 block text-xs break-all text-muted-foreground">
                    {environment.displayUrl}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="mt-4 space-y-2">
        {cloudEnabled ? (
          <ConnectAccountOption
            autoSelectedComputers={autoSelectedComputers}
            disabled={isPairing}
            selectedIds={selectedIds}
            onToggleEnvironment={onToggleEnvironment}
          />
        ) : null}
        <div className="rounded-lg border border-border bg-background">
          <Collapsible open={pairingOpen} onOpenChange={setPairingOpen}>
            <CollapsibleTrigger
              disabled={isPairing}
              render={
                <Button
                  variant="ghost"
                  size="sm-multiline"
                  className="min-h-14 w-full justify-start"
                />
              }
            >
              <LinkIcon className="size-4 text-muted-foreground" />
              <span className="flex-1 text-left">Add a computer</span>
              <ChevronRightIcon
                className={cn("size-4 text-muted-foreground", pairingOpen && "rotate-90")}
              />
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="px-3 pb-3">
                <PairingForm
                  isPairing={isPairing}
                  setIsPairing={setIsPairing}
                  onPaired={(environmentId) => {
                    setPairingOpen(false);
                    onPaired(environmentId);
                    requestAnimationFrame(() => continueRef.current?.focus());
                  }}
                />
              </div>
            </CollapsiblePanel>
          </Collapsible>
        </div>
      </div>
      <div className="mt-6 flex items-center justify-end gap-3">
        <Button
          ref={continueRef}
          autoFocus={!expandPairingInitially}
          disabled={!ready || isPairing}
          onClick={onContinue}
        >
          Continue
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </>
  );
}

function ConnectAccountOption({
  autoSelectedComputers,
  disabled,
  selectedIds,
  onToggleEnvironment,
}: {
  readonly autoSelectedComputers: Set<EnvironmentId>;
  readonly disabled: boolean;
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  readonly onToggleEnvironment: (environmentId: EnvironmentId, checked: boolean) => void;
}) {
  const { environments } = useEnvironments();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const [expanded, setExpanded] = useState(true);
  const [discoveryReady, setDiscoveryReady] = useState(false);
  const onDiscoveryReady = useCallback(() => setDiscoveryReady(true), []);

  return (
    <div className="rounded-lg border border-border bg-background">
      <Collapsible open={expanded && !!isSignedIn && discoveryReady} onOpenChange={setExpanded}>
        <CollapsibleTrigger
          disabled={disabled || !isLoaded}
          onClick={(event) => {
            if (!isSignedIn) {
              event.preventDefault();
              setExpanded(true);
              openAuthPrompt();
            }
          }}
          render={
            <Button variant="ghost" size="sm-multiline" className="min-h-14 w-full justify-start" />
          }
        >
          <CloudIcon className="size-4 text-muted-foreground" />
          <span className="flex-1 text-left">T3 Connect</span>
          <span className="text-xs text-muted-foreground">
            {!isLoaded
              ? "Loading sign-in…"
              : !isSignedIn
                ? "Sign in"
                : !discoveryReady
                  ? "Loading computers…"
                  : null}
          </span>
          <ChevronRightIcon
            className={cn("size-4 text-muted-foreground", expanded && isSignedIn && "rotate-90")}
          />
        </CollapsibleTrigger>
        <CollapsiblePanel keepMounted>
          <div className="px-3 pb-3">
            <div className="mb-3 space-y-1.5">
              {isSignedIn ? (
                <CloudEnvironmentConnectRows
                  primaryEnvironmentId={null}
                  savedEnvironments={environments}
                  showSavedEnvironments
                  onDiscoveryReady={onDiscoveryReady}
                  selection={{ selectedIds, onChange: onToggleEnvironment, autoSelectedComputers }}
                  refreshWhileEmpty
                  empty={
                    <p className="py-3 text-sm text-muted-foreground">No computers linked yet.</p>
                  }
                />
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">
              Run this on each computer you want to connect.
            </p>
            <CommandBlock command="npx t3 connect" className="mt-3" />
            <p className="mt-3 text-xs text-muted-foreground">
              Keep {APP_BASE_NAME} running. Select the computers you want to set up above.
            </p>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

// ── Step 2′: Direct pairing ──────────────────────────────────

/**
 * Register a computer in this browser using a server-minted pairing link.
 */
function PairingForm({
  isPairing,
  setIsPairing,
  onPaired,
}: {
  readonly isPairing: boolean;
  readonly setIsPairing: (value: boolean) => void;
  readonly onPaired: (environmentId: EnvironmentId) => void;
}) {
  const connectPairingEnvironment = useAtomCommand(connectPairing, { reportFailure: false });
  const [pairingUrl, setPairingUrl] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async () => {
    if (isPairing || pairingUrl.trim().length === 0) return;
    setIsPairing(true);
    setErrorMessage("");
    const result = await connectPairingEnvironment({ pairingUrl: pairingUrl.trim() });
    if (!mountedRef.current) return;
    setIsPairing(false);
    if (result._tag === "Success") {
      onPaired(result.value);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    setErrorMessage(cause instanceof Error ? cause.message : "Pairing failed.");
  };

  return (
    <>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <label className="block text-sm text-muted-foreground" htmlFor="onboarding-pairing-url">
            Pairing link
          </label>
          <Input
            id="onboarding-pairing-url"
            autoFocus
            aria-invalid={errorMessage.length > 0}
            aria-describedby={errorMessage ? "onboarding-pairing-error" : undefined}
            className="mt-2"
            size="lg"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            nativeInput
            readOnly={isPairing}
            placeholder="https://your-server:5230/pair#token=…"
            value={pairingUrl}
            onChange={(event) => setPairingUrl(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.nativeEvent.isComposing || event.keyCode === 229)
              ) {
                event.preventDefault();
              }
            }}
          />
        </div>
        {errorMessage ? (
          <div
            id="onboarding-pairing-error"
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive"
          >
            {errorMessage}
          </div>
        ) : null}
        <Collapsible>
          <div className="flex items-center justify-between gap-3">
            <CollapsibleTrigger
              type="button"
              className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronRightIcon className="size-3.5 group-data-panel-open:rotate-90" />
              Need a pairing link?
            </CollapsibleTrigger>
            <Button type="submit" disabled={isPairing || pairingUrl.trim().length === 0}>
              {isPairing ? "Pairing..." : "Pair"}
            </Button>
          </div>
          <CollapsiblePanel>
            <p className="pt-3 text-sm text-muted-foreground">
              Run this on the computer with your code.
            </p>
            <CommandBlock command="npx t3 pair" className="mt-2" />
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Start {APP_BASE_NAME} first, or run <code className="font-mono">npx t3 serve</code>.
              Add <code className="font-mono">--tailscale</code> to use your tailnet.
            </p>
          </CollapsiblePanel>
        </Collapsible>
      </form>
    </>
  );
}

function AgentsStep({
  environmentIds,
  onContinue,
  onOpenSettings,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly onContinue: () => void;
  readonly onOpenSettings: (environmentId: EnvironmentId, instanceId?: ProviderInstanceId) => void;
}) {
  const { environments } = useEnvironments();
  return (
    <StepShell
      title="NeoPi"
      description="NeoPi runs your sessions. Start a thread from the workspace, or resume an existing NeoPi session."
    >
      <ScrollArea scrollFade className="mt-5 h-auto max-h-96">
        <div className="space-y-5 pr-3">
          {environmentIds.map((environmentId) => (
            <ConnectedAgentsStep
              key={environmentId}
              environmentId={environmentId}
              machineLabel={
                environments.find((environment) => environment.environmentId === environmentId)
                  ?.label ?? "Computer"
              }
              onOpenSettings={(instanceId) => onOpenSettings(environmentId, instanceId)}
            />
          ))}
        </div>
      </ScrollArea>
      <div className="mt-6 flex justify-end">
        <Button autoFocus onClick={onContinue}>
          Continue
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </StepShell>
  );
}

function ConnectedAgentsStep({
  environmentId,
  machineLabel,
  onOpenSettings,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly onOpenSettings: (instanceId?: ProviderInstanceId) => void;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  // Re-probe on entry so freshly installed CLIs show up without a manual
  // refresh; harmless when nothing changed (single-flighted per environment).
  useEffect(() => {
    void refreshProviders({ environmentId, input: {} });
  }, [environmentId, refreshProviders]);

  const byDriver = useMemo(() => selectOnboardingProvidersByDriver(providers), [providers]);

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">{machineLabel}</h2>
      <AgentCard
        environmentId={environmentId}
        provider={byDriver.get("neopi")}
        environmentLabel={machineLabel}
        onOpenSettings={onOpenSettings}
      />
    </section>
  );
}

function AgentCard({
  environmentId,
  provider,
  environmentLabel,
  onOpenSettings,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider | undefined;
  readonly environmentLabel: string;
  readonly onOpenSettings: (instanceId?: ProviderInstanceId) => void;
}) {
  const meta = getDriverOption(ProviderDriverKind.make("neopi"));
  const Icon = meta?.icon;
  const summary = getProviderSummary(provider);
  const providerState = getOnboardingProviderState(provider);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background px-3 py-2.5">
      <div className="flex items-center gap-3">
        {Icon ? <Icon className="size-5 shrink-0 fill-foreground" /> : null}
        <div className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">
            {provider?.displayName ?? "NeoPi"}
          </span>
          <p className="mt-0.5 text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
            {summary.headline}
            {summary.detail ? ` · ${summary.detail}` : ""}
          </p>
        </div>
        <div className="shrink-0">
          {providerState === "ready" ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
              <CheckIcon className="size-3.5" />
              Ready
            </span>
          ) : providerState === "checking" ? (
            <span className="text-xs text-muted-foreground">Checking...</span>
          ) : providerState === "disabled" ? (
            <span className="text-xs text-muted-foreground">Disabled</span>
          ) : (
            <span className="text-xs text-muted-foreground">{summary.headline}</span>
          )}
        </div>
      </div>
      {providerState !== "ready" && providerState !== "checking" ? (
        <>
          {providerState === "install" ? (
            <NeoPiInstallHelp environmentLabel={environmentLabel} />
          ) : null}
          <Button variant="outline" size="sm" onClick={() => onOpenSettings(provider?.instanceId)}>
            Open NeoPi settings
          </Button>
        </>
      ) : null}
    </div>
  );
}

// ── Shared bits ──────────────────────────────────────────────

function StepShell({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      {description ? (
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </>
  );
}

function CommandBlock({
  command,
  className,
  prominent = false,
}: {
  readonly command: string;
  readonly className?: string;
  readonly prominent?: boolean;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: "command",
  });
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/50 font-mono",
        prominent ? "px-4 py-3.5 text-base" : "px-3 py-2.5 text-sm",
        className,
      )}
    >
      <span className="min-w-0 truncate">
        <span className="mr-2 text-muted-foreground">$</span>
        {command}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Copy command"
        onClick={() => copyToClipboard(command, undefined)}
      >
        {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}
