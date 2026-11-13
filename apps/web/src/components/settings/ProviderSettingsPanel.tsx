import { SettingsGroup } from "./SettingsGroup";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import { useEnvironmentScope, readEnvironmentScope } from "../../state/session";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProjectId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  resolveEnvironmentMachineKind,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import {
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Result from "effect/Result";
import { PlusIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
  useUpdateEnvironmentSettings,
  useUpdateEnvironmentModelPreferences,
  useToggleEnvironmentModelFavorite,
} from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { ensureLocalApi } from "../../localApi";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { NeoPiBinarySelectionNote } from "../neopi/NeoPiBinarySelectionNote";
import { NeoPiInstallHelp } from "../neopi/NeoPiInstallHelp";
import { cn } from "../../lib/utils";
import { resolveAppModelSelectionState } from "../../modelSelection";
import { getOnboardingProviderState } from "../../onboarding/providerReadiness.logic";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import {
  EMPTY_SERVER_PROVIDERS,
  providersIgnoringCheckedAtAtom,
  serverEnvironment,
} from "../../state/server";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import { useManagedPolicy } from "~/state/managedPolicy";
import { ExpandableText } from "./ExpandableText";
import { IntervalSecondsField } from "./IntervalSecondsField";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { useSecretSources } from "./SecretSourceInput";
import { TextGeneratorsSettings } from "./TextGeneratorsSettings";
import { UsageProviderSettings } from "./UsageProviderSettings";
import { providerClients } from "./providerDriverMeta";
import { searchableSetting } from "./settingsSearch";
import {
  backgroundActivityOverrideSettings,
  durationToSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
} from "./SettingsPanels.logic";
import {
  PolicyTooltip,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import {
  buildProviderEnvironmentOptions,
  buildProviderInstanceOverridePatch,
  classifyProviderEnvironmentAccess,
  isProviderSettingsEnvironmentAvailable,
  type ProviderEnvironmentAccess,
  type ProviderOperateAccess,
  resolveRemoteOperateAccess,
  resolveSelectedProviderEnvironmentId,
} from "./ProviderSettingsPanel.logic";

function providerInstanceName(instance: ProviderInstanceConfig): string {
  return (
    instance.displayName?.trim() ||
    providerClients.get(instance.driver)?.label ||
    String(instance.driver)
  );
}

async function confirmProviderInstanceRemoval(
  question: string,
  consequence = "",
): Promise<boolean> {
  const message = `${question}\nIts saved settings, including any custom binary path, will be removed.${consequence}`;
  const confirmed = await settlePromise(() =>
    ensureLocalApi().dialogs.confirm(message, { variant: "destructive" }),
  );
  return confirmed._tag === "Success" && confirmed.value;
}

function modelListChanges(current: ReadonlyArray<string>, next: ReadonlyArray<string>) {
  const currentSet = new Set(current);
  const nextSet = new Set(next.map((model) => model.trim()).filter(Boolean));
  return [...new Set([...currentSet, ...nextSet])]
    .filter((model) => currentSet.has(model) !== nextSet.has(model))
    .map((model) => ({ model, selected: nextSet.has(model) }));
}

const PROVIDER_SETTINGS = providerClients.definitions.map((definition) => ({
  provider: definition.driverKind,
  hasDefaultInstance: definition.hasDefaultInstance !== false,
}));

function configuredBinaryPath(config: unknown): string {
  if (config === null || typeof config !== "object" || !("binaryPath" in config)) return "";
  return typeof config.binaryPath === "string" ? config.binaryPath.trim() : "";
}

// Subscribe only in the label because every status push restamps all providers' checkedAt.
function ProviderLastChecked({ environmentId }: { environmentId: EnvironmentId }) {
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;
  const lastCheckedRelative = useRelativeTimeState(lastCheckedAt);

  if (lastCheckedRelative.status === "missing") {
    return null;
  }

  if (lastCheckedRelative.status === "invalid") {
    return <span>Checked unavailable</span>;
  }

  return (
    <span>
      {lastCheckedRelative.suffix ? (
        <>
          Checked <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>Checked {lastCheckedRelative.value}</>
      )}
    </span>
  );
}

function providerEnvironmentDetail(environment: EnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "Primary device";
  if (environment.relayManaged) return "T3 Connect";
  if (environment.entry.target._tag === "SshConnectionTarget") return "SSH";
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return "Local device";
  return environment.displayUrl ?? "Remote device";
}

const providerCardHeightClassName =
  "@min-[48rem]/providers:h-[min(44rem,calc(100dvh-11rem))] @min-[48rem]/providers:min-h-[32rem]";

function ProviderSettingsPlaceholder({
  deviceTabs,
  icon,
  title,
  description,
  children,
}: {
  readonly deviceTabs?: ReactNode;
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
}) {
  return (
    <SettingsSection {...searchableSetting("providers")} variant="plain">
      {deviceTabs ? (
        <div className="flex min-h-11 min-w-0 items-center px-3 sm:px-4">{deviceTabs}</div>
      ) : null}
      <SettingsGroup
        divided={false}
        className={cn(
          providerCardHeightClassName,
          "scrollbar-gutter-both flex overflow-x-hidden overflow-y-auto",
        )}
      >
        <Empty>
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{title}</EmptyTitle>
            <EmptyDescription>{description}</EmptyDescription>
          </EmptyHeader>
          {children ? <EmptyContent className="max-w-xl">{children}</EmptyContent> : null}
        </Empty>
      </SettingsGroup>
    </SettingsSection>
  );
}

function EnvironmentUnavailablePlaceholder({
  environment,
  access,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly access: Exclude<ProviderEnvironmentAccess, { kind: "editable" | "read-only" }>;
  readonly deviceTabs?: ReactNode;
}) {
  const isLoading = access.kind === "loading";
  const title = isLoading
    ? "Loading provider settings"
    : access.kind === "error"
      ? "Could not connect to this device"
      : "Provider settings are unavailable";
  const description = isLoading
    ? access.reason === "permissions"
      ? "Checking what this session is allowed to change."
      : `Waiting for ${environment.label}'s configuration.`
    : connectionStatusTitle(environment.connection);
  const error = isLoading ? null : environment.connection.error;
  // Wedged devices can remain here indefinitely; a spinner would continuously repaint.
  return (
    <ProviderSettingsPlaceholder
      deviceTabs={deviceTabs}
      icon={
        <EnvironmentMachineIcon kind={resolveEnvironmentMachineKind(environment.serverConfig)} />
      }
      title={title}
      description={description}
    >
      {error ? (
        <ExpandableText
          key={environment.environmentId}
          text={error}
          className="w-full text-left font-mono text-xs leading-relaxed text-muted-foreground"
        />
      ) : null}
    </ProviderSettingsPlaceholder>
  );
}

interface ProviderSettingsView {
  readonly neoCore?: boolean | undefined;
}

interface ProviderSettingsTarget extends ProviderSettingsView {
  readonly environmentId?: EnvironmentId;
  readonly instanceId?: ProviderInstanceId;
  readonly scoped?: boolean;
  readonly environmentIds?: readonly EnvironmentId[];
  readonly projectIds?: readonly ProjectId[];
}

export function ProviderSettingsPanel(target: ProviderSettingsTarget) {
  return (
    <SettingsPageContainer className="@container/providers gap-8">
      <ProviderSettingsPanelContent
        key={`${target.environmentId ?? ""}:${target.instanceId ?? ""}`}
        {...target}
      />
    </SettingsPageContainer>
  );
}

function ProviderSettingsPanelContent(target: ProviderSettingsTarget) {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const searchTargetId = useSettingsSearchTargetId();
  const options = buildProviderEnvironmentOptions(
    environments,
    primaryEnvironmentId,
    target.environmentIds,
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    target.environmentId ?? primaryEnvironmentId,
  );
  const targetEnvironmentMissing =
    target.environmentId !== undefined &&
    selectedEnvironmentId === target.environmentId &&
    !options.some((environment) => environment.environmentId === target.environmentId);
  const effectiveEnvironmentId =
    target.scoped || targetEnvironmentMissing
      ? target.environmentId
      : resolveSelectedProviderEnvironmentId(options, selectedEnvironmentId, primaryEnvironmentId);
  const selectedEnvironment =
    options.find((environment) => environment.environmentId === effectiveEnvironmentId) ?? null;
  const selectedEnvironmentCanRenderSettings =
    selectedEnvironment !== null &&
    isProviderSettingsEnvironmentAvailable({
      connectionPhase: selectedEnvironment.connection.phase,
      hasServerConfig: selectedEnvironment.serverConfig !== null,
    });
  const searchableEnvironmentId = options.find((environment) =>
    isProviderSettingsEnvironmentAvailable({
      connectionPhase: environment.connection.phase,
      hasServerConfig: environment.serverConfig !== null,
    }),
  )?.environmentId;
  let searchRedirectEnvironmentId: EnvironmentId | undefined;
  {
    if (
      !target.scoped &&
      (searchTargetId === searchableSetting("provider-health-check-interval").id ||
        searchTargetId === searchableSetting("usage-providers").id) &&
      !selectedEnvironmentCanRenderSettings &&
      searchableEnvironmentId !== undefined
    ) {
      searchRedirectEnvironmentId = searchableEnvironmentId;
    }
  }
  if (
    searchRedirectEnvironmentId !== undefined &&
    searchRedirectEnvironmentId !== selectedEnvironmentId
  ) {
    setSelectedEnvironmentId(searchRedirectEnvironmentId);
  }
  const onlyPrimaryDevice =
    options.length === 1 && options[0]?.entry.target._tag === "PrimaryConnectionTarget";
  const deviceTabs =
    !target.scoped && !onlyPrimaryDevice && options.length > 0 ? (
      <ScrollArea radius="none" hideScrollbars scrollFade className="h-11 min-w-0 flex-1">
        <ToggleGroup
          aria-label="Devices"
          variant="segmented"
          className="my-2"
          value={effectiveEnvironmentId ? [effectiveEnvironmentId] : []}
          onValueChange={(next) => {
            const environment = options.find((option) => option.environmentId === next[0]);
            if (environment) setSelectedEnvironmentId(environment.environmentId);
          }}
        >
          {options.map((environment) => {
            const machine = resolveEnvironmentMachineKind(environment.serverConfig);
            const detail = providerEnvironmentDetail(environment);
            const statusText = connectionStatusTitle(environment.connection);
            return (
              <Tooltip key={environment.environmentId}>
                <TooltipTrigger
                  render={
                    <Toggle value={environment.environmentId}>
                      <EnvironmentMachineIcon
                        kind={machine}
                        className="size-3.5 shrink-0"
                        aria-hidden
                      />
                      <span className="max-w-40 truncate">{environment.label}</span>
                      {environment.connection.phase !== "connected" ? (
                        <ConnectionStatusDot
                          dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                          pingClassName={connectionPhasePingClassName(environment.connection.phase)}
                        />
                      ) : null}
                      <span className="sr-only">
                        {detail}, {statusText}
                      </span>
                    </Toggle>
                  }
                />
                <TooltipPopup side="top">
                  {detail} · {statusText}
                </TooltipPopup>
              </Tooltip>
            );
          })}
        </ToggleGroup>
      </ScrollArea>
    ) : null;

  return (
    <>
      {targetEnvironmentMissing ? (
        <ProviderSettingsPlaceholder
          deviceTabs={deviceTabs}
          icon={<EnvironmentMachineIcon kind={resolveEnvironmentMachineKind(null)} />}
          title="Device unavailable"
          description="Reconnect this device to set up its provider, or select another device."
        />
      ) : null}
      {options.length === 0 && !targetEnvironmentMissing ? (
        <ProviderSettingsPlaceholder
          icon={<EnvironmentMachineIcon kind={resolveEnvironmentMachineKind(null)} />}
          title={isReady ? "No connected devices" : "Loading devices"}
          description={
            isReady
              ? "Connect an execution environment before configuring providers."
              : "Reading connected execution environments."
          }
        />
      ) : null}

      {selectedEnvironment ? (
        <RemoteSessionGatedProviderSettings
          key={selectedEnvironment.environmentId}
          environment={selectedEnvironment}
          deviceTabs={deviceTabs}
          neoCore={target.neoCore}
          targetInstanceId={
            target.environmentId === undefined ||
            selectedEnvironment.environmentId === target.environmentId
              ? target.instanceId
              : undefined
          }
          projectIds={target.projectIds ?? []}
        />
      ) : null}
    </>
  );
}

function RemoteSessionGatedProviderSettings({
  environment,
  deviceTabs,
  targetInstanceId,
  neoCore,
  projectIds,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs?: ReactNode;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
  readonly projectIds: readonly ProjectId[];
} & ProviderSettingsView) {
  const sessionState = useEnvironmentSessionState(environment.environmentId);
  const operateAccess = resolveRemoteOperateAccess({
    session: sessionState.data,
    isPending: sessionState.isPending,
    hasError: sessionState.hasError,
  });
  return (
    <AccessGatedProviderSettings
      environment={environment}
      operateAccess={operateAccess}
      deviceTabs={deviceTabs}
      targetInstanceId={targetInstanceId}
      neoCore={neoCore}
      projectIds={projectIds}
    />
  );
}

function AccessGatedProviderSettings({
  environment,
  operateAccess,
  deviceTabs,
  targetInstanceId,
  neoCore,
  projectIds,
}: {
  readonly environment: EnvironmentPresentation;
  readonly operateAccess: ProviderOperateAccess;
  readonly deviceTabs?: ReactNode;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
  readonly projectIds: readonly ProjectId[];
} & ProviderSettingsView) {
  const access = classifyProviderEnvironmentAccess({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    operateAccess,
  });
  if (access.kind !== "editable" && access.kind !== "read-only") {
    return (
      <EnvironmentUnavailablePlaceholder
        environment={environment}
        access={access}
        deviceTabs={deviceTabs}
      />
    );
  }
  return (
    <EnvironmentProviderSettings
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
      readOnly={access.kind === "read-only"}
      deviceTabs={deviceTabs}
      targetInstanceId={targetInstanceId}
      neoCore={neoCore}
      projectIds={projectIds}
    />
  );
}

const NO_PROJECT_IDS: readonly ProjectId[] = [];
const NO_FAVORITES: UnifiedSettings["favorites"] = [];

export function EnvironmentProviderSettings({
  environmentId,
  environmentLabel,
  readOnly = false,
  deviceTabs,
  targetInstanceId,
  neoCore = false,
  projectIds = NO_PROJECT_IDS,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly deviceTabs?: ReactNode;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
  readonly projectIds?: readonly ProjectId[];
  readonly readOnly?: boolean;
} & ProviderSettingsView) {
  const settings = useEnvironmentSettings(environmentId);
  const managedPolicy = useManagedPolicy(environmentId);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  // A policy that allows no provider leaves nothing to add.
  const canAddProvider =
    !readOnly &&
    canManageProviders &&
    managedPolicy?.limits?.providers?.allowedDrivers?.length !== 0;
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canRefreshProviders = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const updateModelPreferences = useUpdateEnvironmentModelPreferences(environmentId);
  const toggleModelFavorite = useToggleEnvironmentModelFavorite(environmentId);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const serverProviders = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  // Hide overrides on older servers that silently ignore providerInstances patches.
  const supportsProjectProviderOverrides = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) =>
      config?.environment.capabilities.projectProviderInstanceOverrides === true &&
      config.environment.capabilities.projectSettingsOverridePatches === true,
  );
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId | null>(
    targetInstanceId ?? null,
  );
  const refreshingRef = useRef(false);
  const visibleProviderSettings = PROVIDER_SETTINGS;
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const providerHealthPreset = getBackgroundActivityPresetSettings(
    resolvedBackgroundActivity.profile,
  ).providerHealthRefreshInterval;
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const defaultProviderHealthRefreshIntervalSeconds = durationToSeconds(providerHealthPreset);

  const refreshProviders = () => {
    if (refreshingRef.current || !readEnvironmentScope(environmentId, AuthOrchestrationReadScope))
      return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void (async () => {
      const result = await refreshServerProviders({
        environmentId,
        input: { refreshModels: true, reloadSecrets: true },
      });
      refreshingRef.current = false;
      setIsRefreshingProviders(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        console.warn("Failed to refresh providers", {
          operation: "refresh-providers",
          environmentId,
          ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
        });
      }
    })();
  };

  interface InstanceRow {
    readonly instanceId: ProviderInstanceId;
    /** Undefined for a default slot the user never configured. */
    readonly explicitInstance: ProviderInstanceConfig | undefined;
    readonly driver: ProviderDriverKind;
    readonly isDefault: boolean;
    readonly isDirty?: boolean;
  }

  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    if (instance.driver !== "neopi") continue;
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const rows: InstanceRow[] = [];

  for (const providerSettings of visibleProviderSettings) {
    const driver = providerSettings.provider;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = settings.providerInstances?.[defaultInstanceId];
    const isDirty = explicitInstance !== undefined;
    const hasDefaultSlot = providerSettings.hasDefaultInstance || explicitInstance !== undefined;
    if (hasDefaultSlot) {
      rows.push({
        instanceId: defaultInstanceId,
        explicitInstance,
        driver,
        isDefault: true,
        isDirty,
      });
    }
    for (const [id, instance] of instancesByDriver.get(providerSettings.provider) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({
        instanceId: id,
        explicitInstance: instance,
        driver: instance.driver,
        isDefault: false,
      });
    }
  }

  const targetInstanceMissing =
    targetInstanceId !== undefined &&
    selectedInstanceId === targetInstanceId &&
    !rows.some((row) => row.instanceId === targetInstanceId);
  const selectedRow =
    rows.find((row) => row.instanceId === selectedInstanceId) ??
    (targetInstanceMissing ? null : (rows[0] ?? null));

  const persistInstance = async (
    instanceId: ProviderInstanceId,
    next: ProviderInstanceConfig,
    textGenerationModelSelection?: UnifiedSettings["textGenerationModelSelection"],
  ) => {
    const result = await persistProviderInstance(
      { operation: "upsert", instanceId, instance: next },
      textGenerationModelSelection === undefined ? {} : { textGenerationModelSelection },
    );
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not update provider instance",
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
    }
  };

  const updateInstance = useStableCallback(
    (
      instanceId: ProviderInstanceId,
      previous: ProviderInstanceConfig,
      next: ProviderInstanceConfig,
    ) => {
      const isDisabling = next.enabled === false && resolveProviderInstanceEnabled(previous);
      const shouldClearTextGen =
        isDisabling &&
        resolveAppModelSelectionState(settings, serverProviders).instanceId === instanceId &&
        readEnvironmentScope(environmentId, AuthSettingsWriteScope);
      void persistInstance(
        instanceId,
        next,
        shouldClearTextGen ? DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection : undefined,
      );
    },
  );

  const deleteInstance = useStableCallback(
    async (instanceId: ProviderInstanceId, instance: ProviderInstanceConfig) => {
      const confirmed = await confirmProviderInstanceRemoval(
        `Remove the ${providerInstanceName(instance)} provider instance?`,
      );
      if (!confirmed) return;
      const updateResult = await persistProviderInstance({
        operation: "remove",
        instanceId,
      });
      if (updateResult._tag === "Failure") {
        const error = squashAtomCommandFailure(updateResult);
        toastManager.add({
          type: "error",
          title: "Could not delete provider instance",
          description: error instanceof Error ? error.message : "The settings update failed.",
        });
        return;
      }
    },
  );

  const resetDefaultInstance = useStableCallback(async (driverKind: ProviderDriverKind) => {
    const instanceId = defaultInstanceIdForDriver(driverKind);
    const instance = settings.providerInstances?.[instanceId] ?? { driver: driverKind };
    const turnsOff =
      resolveProviderInstanceEnabled(instance) &&
      !resolveProviderInstanceEnabled({ driver: driverKind });
    const confirmed = await confirmProviderInstanceRemoval(
      `Reset the ${providerInstanceName(instance)} provider to its defaults?`,
      turnsOff ? " It will also be turned off." : "",
    );
    if (!confirmed) return;
    const result = await persistProviderInstance({ operation: "remove", instanceId });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not reset provider instance",
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
    }
  });

  const writeProjectOverride = useStableCallback(
    (instanceId: ProviderInstanceId, next: boolean | undefined) => {
      const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
      if (
        config?.environment.capabilities.projectProviderInstanceOverrides !== true ||
        config.environment.capabilities.projectSettingsOverridePatches !== true
      ) {
        toastManager.add({
          type: "error",
          title: "Update this environment before editing project provider overrides.",
        });
        return;
      }
      updateSettings({
        projectSettingsOverrides: buildProviderInstanceOverridePatch(
          settings,
          projectIds,
          instanceId,
          next,
        ),
      });
    },
  );

  const stableUpdateModelPreferences = useStableCallback(updateModelPreferences);
  const stableToggleModelFavorite = useStableCallback(toggleModelFavorite);
  const actions: ProviderInstanceRowActions = {
    updateInstance,
    deleteInstance,
    resetDefaultInstance,
    writeProjectOverride,
    updateModelPreferences: stableUpdateModelPreferences,
    toggleModelFavorite: stableToggleModelFavorite,
    selectInstance: setSelectedInstanceId,
  };
  // resolveModelPreferences falls back to a fresh `[]`; keep it stable for the rows.
  const favorites = settings.favorites.length > 0 ? settings.favorites : NO_FAVORITES;

  const representativeProjectId = projectIds[0];
  const renderProviderInstance = (row: InstanceRow, mode: "list" | "editor") => {
    const showProjectOverride =
      representativeProjectId !== undefined && supportsProjectProviderOverrides;
    return (
      <ProviderInstanceRow
        key={row.instanceId}
        environmentId={environmentId}
        environmentLabel={environmentLabel}
        instanceId={row.instanceId}
        driver={row.driver}
        explicitInstance={row.explicitInstance}
        isDefault={row.isDefault}
        isDirty={row.isDirty === true}
        mode={mode}
        neoCore={neoCore}
        selected={mode === "list" && selectedRow?.instanceId === row.instanceId}
        readOnly={readOnly}
        canWriteSettings={canWriteSettings}
        liveProvider={serverProviders.find((candidate) => candidate.instanceId === row.instanceId)}
        showProjectOverride={showProjectOverride}
        projectOverrideValue={
          showProjectOverride
            ? settings.projectSettingsOverrides[representativeProjectId]?.providerInstances?.[
                row.instanceId
              ]?.enabled
            : undefined
        }
        projectOverrideEffectiveEnabled={
          showProjectOverride
            ? resolveProjectProviderInstanceEnabled(
                settings,
                representativeProjectId,
                row.instanceId,
              )
            : false
        }
        modelPreferences={settings.providerModelPreferences?.[row.instanceId]}
        favorites={favorites}
        actions={actions}
      />
    );
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting(neoCore ? "neocore" : "providers")}
        variant="plain"
        titleAction={
          canAddProvider ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    onClick={() => setIsAddInstanceDialogOpen(true)}
                    aria-label="Add provider"
                  >
                    <PlusIcon />
                  </Button>
                }
              />
              <TooltipPopup side="top">Add provider</TooltipPopup>
            </Tooltip>
          ) : null
        }
        headerAction={
          <div className="-me-2 flex min-w-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={isRefreshingProviders || !canRefreshProviders}
                    aria-busy={isRefreshingProviders}
                    onClick={() => void refreshProviders()}
                  >
                    <RefreshIcon refreshing={isRefreshingProviders} />
                    <span className="sr-only">Refresh provider status</span>
                    <span className="hidden min-w-0 truncate sm:inline">
                      {isRefreshingProviders ? (
                        "Refreshing providers"
                      ) : (
                        <ProviderLastChecked environmentId={environmentId} />
                      )}
                    </span>
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh provider status</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {deviceTabs ? (
          <div className="flex min-h-11 min-w-0 items-center gap-2 px-3 sm:px-4">{deviceTabs}</div>
        ) : null}
        {readOnly ? (
          <SettingsGroup divided={false} className="overflow-hidden">
            <SettingsRow
              title="Limited permissions"
              description={`This session can view ${environmentLabel}'s providers but can't change their settings.`}
            />
          </SettingsGroup>
        ) : null}
        <SettingsGroup
          divided={false}
          className={cn(
            providerCardHeightClassName,
            "overflow-hidden @min-[48rem]/providers:grid @min-[48rem]/providers:grid-cols-[17rem_minmax(0,1fr)]",
          )}
        >
          <div className="border-b border-border/60 bg-muted/10 @min-[48rem]/providers:flex @min-[48rem]/providers:min-h-0 @min-[48rem]/providers:flex-col @min-[48rem]/providers:border-r @min-[48rem]/providers:border-b-0">
            <ScrollArea
              scrollFade
              chainVerticalScroll
              className="@min-[48rem]/providers:min-h-0 @min-[48rem]/providers:flex-1"
            >
              <div className="divide-y divide-border/50">
                {rows.map((row) => renderProviderInstance(row, "list"))}
                {canAddProvider ? (
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left text-sm text-muted-foreground transition-colors outline-none hover:bg-muted/25 hover:text-foreground focus-visible:bg-muted/25 focus-visible:text-foreground sm:px-4"
                    onClick={() => setIsAddInstanceDialogOpen(true)}
                  >
                    <PlusIcon className="size-4 shrink-0" />
                    Add provider
                  </button>
                ) : null}
              </div>
            </ScrollArea>
          </div>

          <div data-provider-detail className="min-w-0 @min-[48rem]/providers:min-h-0">
            {selectedRow ? (
              <ScrollArea scrollFade chainVerticalScroll className="@min-[48rem]/providers:h-full">
                {/* Flat sections run dividers edge to edge and inset text like the list beside them. */}
                <div className="space-y-6 py-4">
                  {renderProviderInstance(selectedRow, "editor")}
                </div>
              </ScrollArea>
            ) : (
              <div className="p-6 text-sm text-muted-foreground">
                {targetInstanceMissing
                  ? "This provider instance is no longer available on this device."
                  : "No providers configured."}
              </div>
            )}
          </div>
        </SettingsGroup>
      </SettingsSection>

      {!neoCore ? (
        <>
          <UsageProviderSettings
            key={environmentId}
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            sources={settings.usageLimitSources}
            readOnly={readOnly}
          />

          {managedPolicy?.limits?.providers?.allowedDrivers === undefined ? (
            <TextGeneratorsSettings
              key={`text-generators:${environmentId}`}
              environmentId={environmentId}
              environmentLabel={environmentLabel}
              providers={serverProviders}
              readOnly={readOnly}
            />
          ) : null}

          <SettingsSection title="Advanced">
            <SettingsRow
              id={searchableSetting("provider-health-check-interval").id}
              title={
                <span className="inline-flex items-center gap-1.5">
                  {searchableSetting("provider-health-check-interval").title}
                  <PolicyTooltip>
                    This interval is configured here, then the shared Background activity policy
                    decides whether provider probes may run when the timer fires. Custom intervals
                    appear as Advanced in Maintenance settings.
                  </PolicyTooltip>
                </span>
              }
              description="Refresh provider status, versions, and models in the background. Set to 0 to disable."
              resetAction={
                providerHealthRefreshIntervalSeconds !==
                defaultProviderHealthRefreshIntervalSeconds ? (
                  <span
                    inert={!canWriteSettings}
                    className={!canWriteSettings ? "opacity-50" : undefined}
                  >
                    <SettingResetButton
                      label="provider health check interval"
                      onClick={() =>
                        updateSettings(
                          backgroundActivityOverrideSettings(
                            settings.backgroundActivity,
                            resolvedBackgroundActivity,
                            { providerHealthRefreshInterval: undefined },
                          ),
                        )
                      }
                    />
                  </span>
                ) : null
              }
              control={
                <div
                  inert={!canWriteSettings}
                  aria-disabled={!canWriteSettings || undefined}
                  className={cn(
                    "flex shrink-0 items-center gap-2",
                    !canWriteSettings && "opacity-50 select-none",
                  )}
                >
                  <IntervalSecondsField
                    label="provider health check interval"
                    value={providerHealthRefreshIntervalSeconds}
                    min={0}
                    step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                    onCommit={(seconds, options) =>
                      updateSettings(
                        backgroundActivityOverrideSettings(
                          settings.backgroundActivity,
                          resolvedBackgroundActivity,
                          { providerHealthRefreshInterval: Duration.seconds(seconds) },
                        ),
                        options,
                      )
                    }
                  />
                  <span className="text-xs text-muted-foreground">seconds</span>
                </div>
              }
            />
          </SettingsSection>
        </>
      ) : null}

      {isAddInstanceDialogOpen && !readOnly ? (
        <AddProviderInstanceDialog
          open
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          onOpenChange={setIsAddInstanceDialogOpen}
          onCreated={setSelectedInstanceId}
        />
      ) : null}
    </>
  );
}

interface ProviderInstanceRowActions {
  readonly updateInstance: (
    instanceId: ProviderInstanceId,
    previous: ProviderInstanceConfig,
    next: ProviderInstanceConfig,
  ) => void;
  readonly deleteInstance: (
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
  ) => Promise<void>;
  readonly resetDefaultInstance: (driverKind: ProviderDriverKind) => Promise<void>;
  readonly writeProjectOverride: (
    instanceId: ProviderInstanceId,
    next: boolean | undefined,
  ) => void;
  readonly updateModelPreferences: ReturnType<typeof useUpdateEnvironmentModelPreferences>;
  readonly toggleModelFavorite: ReturnType<typeof useToggleEnvironmentModelFavorite>;
  readonly selectInstance: (instanceId: ProviderInstanceId) => void;
}

const NO_MODELS: ReadonlyArray<string> = [];

/** Stable props let this boundary return cached cards even when settings rebuild parent row elements. */
function ProviderInstanceRow({
  environmentId,
  environmentLabel,
  instanceId,
  driver,
  explicitInstance,
  isDefault,
  isDirty,
  mode,
  selected,
  readOnly,
  canWriteSettings,
  liveProvider,
  showProjectOverride,
  projectOverrideValue,
  projectOverrideEffectiveEnabled,
  modelPreferences,
  favorites,
  actions,
  neoCore,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly explicitInstance: ProviderInstanceConfig | undefined;
  readonly isDefault: boolean;
  readonly isDirty: boolean;
  readonly mode: "list" | "editor";
  readonly selected: boolean;
  readonly readOnly: boolean;
  readonly canWriteSettings: boolean;
  readonly liveProvider: ServerProvider | undefined;
  readonly showProjectOverride: boolean;
  readonly projectOverrideValue: boolean | undefined;
  readonly projectOverrideEffectiveEnabled: boolean;
  readonly modelPreferences:
    | { readonly hiddenModels: ReadonlyArray<string>; readonly modelOrder: ReadonlyArray<string> }
    | undefined;
  readonly favorites: UnifiedSettings["favorites"];
  readonly actions: ProviderInstanceRowActions;
  readonly neoCore: boolean;
}) {
  const secretSources = useSecretSources(environmentId);
  const instance = explicitInstance ?? { driver };
  const driverOption = providerClients.get(driver);
  const hiddenModels = modelPreferences?.hiddenModels ?? NO_MODELS;
  const modelOrder = modelPreferences?.modelOrder ?? NO_MODELS;
  const favoriteModels = Arr.filterMap(favorites, (favorite) =>
    favorite.provider === instanceId ? Result.succeed(favorite.model) : Result.failVoid,
  );
  const resetLabel = driverOption?.label ?? String(driver);
  const projectOverride = showProjectOverride
    ? {
        value: projectOverrideValue,
        effectiveEnabled: projectOverrideEffectiveEnabled,
        onChange: (next: boolean) => actions.writeProjectOverride(instanceId, next),
        onReset: () => actions.writeProjectOverride(instanceId, undefined),
      }
    : undefined;
  const showInstallHelp = neoCore && getOnboardingProviderState(liveProvider) === "install";
  const savedBinaryPath = configuredBinaryPath(instance.config);

  return (
    <ProviderInstanceCard
      environmentId={environmentId}
      secretSources={secretSources}
      projectOverride={projectOverride}
      instanceId={instanceId}
      instance={instance}
      driverOption={driverOption}
      liveProvider={liveProvider}
      mode={mode}
      section={neoCore ? "runtime" : "models"}
      selected={selected}
      onSelect={mode === "list" ? () => actions.selectInstance(instanceId) : undefined}
      readOnly={readOnly}
      canWriteSettings={canWriteSettings}
      setup={
        mode === "editor" ? (
          neoCore ? (
            <>
              {showInstallHelp ? (
                <div className="space-y-3 px-3 py-3 sm:px-4">
                  {savedBinaryPath && savedBinaryPath !== "npi" ? (
                    <p className="text-xs text-muted-foreground">
                      NeoCode couldn’t use the saved Binary path on {environmentLabel}. Correct it
                      below or clear it to search automatically.
                    </p>
                  ) : null}
                  <NeoPiInstallHelp environmentLabel={environmentLabel} />
                </div>
              ) : null}
              <NeoPiBinarySelectionNote config={instance.config} />
            </>
          ) : (
            <Link to="/settings/neocore" search={{ machine: environmentId, instanceId }}>
              Configure this runtime profile in NeoCore
            </Link>
          )
        ) : null
      }
      onUpdate={(next) => actions.updateInstance(instanceId, instance, next)}
      onDelete={
        mode === "editor" && !isDefault
          ? () => actions.deleteInstance(instanceId, instance)
          : undefined
      }
      headerAction={
        mode === "editor" && isDefault && isDirty ? (
          <SettingResetButton
            label={`${resetLabel} provider settings`}
            onClick={() => actions.resetDefaultInstance(driver)}
          />
        ) : null
      }
      hiddenModels={hiddenModels}
      favoriteModels={favoriteModels}
      modelOrder={modelOrder}
      onHiddenModelsChange={(next, affectedModels) => {
        const hidden = new Set(next);
        void actions.updateModelPreferences({
          setModelsHidden: affectedModels.map((model) => ({
            provider: instanceId,
            model,
            hidden: hidden.has(model),
          })),
        });
      }}
      onToggleFavorite={(model) => {
        void actions.toggleModelFavorite(instanceId, model);
      }}
      onFavoriteModelsChange={(next) => {
        void actions.updateModelPreferences({
          setModelFavorites: modelListChanges(favoriteModels, next).map(({ model, selected }) => ({
            provider: instanceId,
            model,
            favorite: selected,
          })),
        });
      }}
      onModelOrderChange={(nextOrder) => {
        void actions.updateModelPreferences({
          setProviderModelOrder: { provider: instanceId, modelOrder: nextOrder },
        });
      }}
    />
  );
}
