import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { CheckIcon } from "lucide-react";
import { useState } from "react";
import {
  deriveAvailableInstanceId,
  deriveInstanceId,
} from "@t3tools/client-runtime/provider-instance-ids";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ProviderClientDefinition } from "@t3tools/provider-core/client";
import {
  AuthProvidersManageScope,
  ProviderInstanceId,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  isManagedDriverAllowed,
} from "@t3tools/contracts";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";

import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { managedInstanceLocks, useManagedPolicy } from "../../state/managedPolicy";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { providerClients } from "./providerDriverMeta";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";
import { ProviderSettingsForm, deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { WizardPanel, WizardPopup, WizardHeader, WizardFooter } from "../ui/wizard";
import {
  ADD_PROVIDER_WIZARD_STEPS,
  resolveWizardNavigation,
  type ProviderIdentityDraft,
  type WizardNavigation,
} from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";
import { ProviderEnvironmentSection } from "./ProviderInstanceCard";
import { useSecretSources } from "./SecretSourceInput";

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("neopi");
const DEFAULT_DRIVER_OPTION = providerClients.get(DEFAULT_DRIVER_KIND)!;
const DRIVER_OPTIONS = providerClients.definitions.filter(
  (option) => option.driverKind === DEFAULT_DRIVER_KIND,
);
const EMPTY_CONFIG_DRAFT: Record<string, unknown> = {};
function validateInstanceId(id: string, existing: ReadonlySet<string>): string | null {
  if (id.length === 0) return "Instance ID is required.";
  if (id.length > 64) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (existing.has(id)) return `An instance named '${id}' already exists.`;
  return null;
}

function ProviderOptionGrid({
  options,
  value,
  disabled,
  onValueChange,
  ...labelProps
}: {
  readonly options: ReadonlyArray<ProviderClientDefinition>;
  readonly value: ProviderDriverKind;
  readonly disabled: boolean;
  readonly onValueChange: (value: string) => void;
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
}) {
  return (
    <RadioGroup
      {...labelProps}
      disabled={disabled}
      value={value}
      onValueChange={onValueChange}
      className="grid grid-cols-1 sm:grid-cols-2"
    >
      {options.map((option) => (
        <RadioPrimitive.Root
          key={option.driverKind}
          value={option.driverKind}
          className="relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-inset data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
        >
          <ProviderInstanceIcon
            driverKind={option.driverKind}
            displayName={option.label}
            iconClassName="size-4"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {option.label}
          </span>
          <RadioPrimitive.Indicator
            className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
            aria-hidden
          >
            <CheckIcon className="size-3.5 shrink-0" />
          </RadioPrimitive.Indicator>
          {option.badgeLabel ? (
            <Badge variant="warning" size="sm">
              {option.badgeLabel}
            </Badge>
          ) : null}
        </RadioPrimitive.Root>
      ))}
    </RadioGroup>
  );
}

interface AddProviderInstanceDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated?: (instanceId: ProviderInstanceId, driver: ProviderDriverKind) => void;
}

export function AddProviderInstanceDialog({
  open,
  environmentId,
  environmentLabel,
  onOpenChange,
  onCreated,
}: AddProviderInstanceDialogProps) {
  const settings = useEnvironmentSettings(environmentId);
  const secretSources = useSecretSources(environmentId);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);

  const [wizardStep, setWizardStep] = useState(0);
  // Drivers the administrator's policy leaves out are not offered at all.
  const managedPolicy = useManagedPolicy(environmentId);
  const driverOptions = DRIVER_OPTIONS.filter((option) =>
    isManagedDriverAllowed(managedPolicy, option.driverKind),
  );
  const [driver, setDriver] = useState(DEFAULT_DRIVER_KIND);
  const driverAllowed = isManagedDriverAllowed(managedPolicy, driver);
  const [identityByDriver, setIdentityByDriver] = useState<Record<string, ProviderIdentityDraft>>(
    {},
  );
  const [instanceEnvironment, setInstanceEnvironment] = useState<
    ReadonlyArray<ProviderInstanceEnvironmentVariable>
  >([]);
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>({});
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const existingIds = new Set(Object.keys(settings.providerInstances ?? {}));

  const driverOption = providerClients.get(driver) ?? DEFAULT_DRIVER_OPTION;
  const defaultIdentity: ProviderIdentityDraft = {
    label: driverOption.label,
    accentColor: "",
    instanceIdOverride: null,
  };
  const { label, accentColor, instanceIdOverride } = identityByDriver[driver] ?? defaultIdentity;
  const instanceId =
    instanceIdOverride ??
    deriveAvailableInstanceId(
      (candidateLabel) => {
        if (!candidateLabel.trim() || candidateLabel === driverOption.label) {
          return driver;
        }
        return deriveInstanceId(driver, candidateLabel);
      },
      label,
      existingIds,
    );
  const driverSettingsFields = deriveProviderSettingsFields(driverOption);
  const instanceIdError = validateInstanceId(instanceId, existingIds);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  const identityStep = 1;
  const previewLabel = label.trim() || `${driverOption.label} Workspace`;

  const configDraft = configByDriver[driver] ?? EMPTY_CONFIG_DRAFT;
  const wizardStepSummaries = [driverOption.label, previewLabel, null] as const;
  const setConfigDraft = (config: Record<string, unknown> | undefined) => {
    setConfigByDriver((existing) => {
      const next = { ...existing };
      if (config === undefined || Object.keys(config).length === 0) {
        delete next[driver];
      } else {
        next[driver] = config;
      }
      return next;
    });
  };
  const selectDriver = (value: string) => {
    setDriver(ProviderDriverKind.make(value));
    setHasAttemptedSubmit(false);
  };
  const setIdentityDraft = (update: Partial<ProviderIdentityDraft>) => {
    setIdentityByDriver((existing) => ({
      ...existing,
      [driver]: { ...(existing[driver] ?? defaultIdentity), ...update },
    }));
  };

  const applyWizardNavigation = (navigation: WizardNavigation) => {
    if (isSaving) return;
    if (navigation.kind === "blocked") {
      setHasAttemptedSubmit(true);
    }
    setWizardStep(navigation.step);
  };

  const navigateToStep = (requestedStep: number) => {
    applyWizardNavigation(
      resolveWizardNavigation(wizardStep, requestedStep, ADD_PROVIDER_WIZARD_STEPS.length, {
        instanceIdError,
      }),
    );
  };

  const driverLocks = managedInstanceLocks(managedPolicy, driver);

  const handleSave = async () => {
    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    if (isSaving) return;
    setHasAttemptedSubmit(true);
    if (instanceIdError !== null || !driverAllowed) return;

    const config = configByDriver[driver] ?? EMPTY_CONFIG_DRAFT;
    const hasConfig = Object.keys(config).length > 0;
    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);

    const nextInstance: ProviderInstanceConfig = {
      driver,
      enabled: true,
      ...(label.trim().length > 0 ? { displayName: label.trim() } : {}),
      ...(normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      ...(hasConfig ? { config } : {}),
      ...(instanceEnvironment.length > 0 ? { environment: instanceEnvironment } : {}),
    };
    const brandedId = ProviderInstanceId.make(instanceId);
    setIsSaving(true);
    const result = await persistProviderInstance({
      operation: "create",
      instanceId: brandedId,
      instance: nextInstance,
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setIsSaving(false);
      toastManager.add({
        type: "error",
        title: "Could not add provider instance",
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
      return;
    }
    onCreated?.(brandedId, driver);
    toastManager.add({
      type: "success",
      title: "Provider instance added",
      description: `${driverOption.label} instance '${instanceId}' was added.`,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <WizardPopup size="wide">
        <WizardHeader
          title="Add provider instance"
          description={
            <>
              Configure an additional NeoPi instance on {environmentLabel}, such as a separate
              profile or executable.
            </>
          }
        >
          <AddProviderInstanceWizardSteps
            currentStep={wizardStep}
            summaries={wizardStepSummaries}
            instanceIdError={instanceIdError}
            disabled={isSaving || !canManageProviders || !driverAllowed}
            onNavigation={applyWizardNavigation}
          />
        </WizardHeader>

        <WizardPanel>
          <div className={cn("grid gap-2", wizardStep !== 0 && "hidden")}>
            <div id="add-instance-driver-label" className="text-sm font-medium text-foreground">
              Provider
            </div>
            <ProviderOptionGrid
              options={driverOptions}
              value={driver}
              disabled={isSaving || !canManageProviders}
              onValueChange={selectDriver}
              aria-labelledby="add-instance-driver-label"
            />
          </div>

          <SettingsGroup
            variant="plain"
            className={cn(wizardStep !== identityStep && "hidden")}
            inert={!canManageProviders || isSaving}
          >
            <SettingsRow
              title={<label htmlFor="add-provider-label">Label</label>}
              description={
                <span id="add-provider-label-description">Shown in the provider list.</span>
              }
              control={
                <Input
                  id="add-provider-label"
                  aria-describedby="add-provider-label-description"
                  size="sm"
                  className="w-full @min-[32rem]/settings-row:w-56"
                  placeholder="e.g. Work"
                  value={label}
                  onChange={(event) => setIdentityDraft({ label: event.target.value })}
                />
              }
            />
            <SettingsRow
              title={<label htmlFor="add-provider-instance-id">Instance ID</label>}
              description={
                <span id="add-provider-instance-id-description">Letters, digits, '-', or '_'.</span>
              }
              status={
                showInstanceIdError ? (
                  <span
                    id="add-provider-instance-id-error"
                    role="alert"
                    className="text-destructive"
                  >
                    {instanceIdError}
                  </span>
                ) : undefined
              }
              control={
                <Input
                  id="add-provider-instance-id"
                  aria-describedby={
                    showInstanceIdError
                      ? "add-provider-instance-id-description add-provider-instance-id-error"
                      : "add-provider-instance-id-description"
                  }
                  size="sm"
                  className="w-full @min-[32rem]/settings-row:w-56"
                  placeholder={`${driver}_work`}
                  value={instanceId}
                  onChange={(event) => {
                    setIdentityDraft({ instanceIdOverride: event.target.value });
                  }}
                  aria-invalid={showInstanceIdError}
                />
              }
            />
            <SettingsRow
              title="Accent color"
              description="Optional marker shown in the picker."
              control={
                <ProviderAccentColorPicker
                  displayName={label || driverOption.label}
                  value={accentColor || undefined}
                  onCommit={(value) => setIdentityDraft({ accentColor: value })}
                  layout="inline"
                />
              }
            />
          </SettingsGroup>

          <SettingsGroup
            variant="plain"
            className={cn(wizardStep !== 2 && "hidden")}
            inert={!canManageProviders || isSaving}
          >
            {driverSettingsFields.length > 0 ? (
              <ProviderSettingsForm
                definition={driverOption}
                value={configDraft}
                idPrefix={`add-provider-${driver}`}
                variant="settings"
                onChange={setConfigDraft}
                managed={
                  driverLocks && { keys: driverLocks.configKeys, reason: driverLocks.reason }
                }
                environmentId={environmentId}
              />
            ) : null}
            <div inert={driverLocks?.wholeEnvironment}>
              <ProviderEnvironmentSection
                environment={instanceEnvironment}
                onChange={setInstanceEnvironment}
                secretSources={secretSources}
                managed={
                  driverLocks && {
                    names: driverLocks.environmentNames,
                    reason: driverLocks.reason,
                  }
                }
              />
            </div>
          </SettingsGroup>
        </WizardPanel>

        <WizardFooter>
          <Button
            variant={wizardStep === 0 ? "ghost-muted" : "outline"}
            size="sm"
            disabled={isSaving}
            onClick={() => {
              if (wizardStep === 0) {
                onOpenChange(false);
                return;
              }
              setWizardStep((step) => Math.max(0, step - 1));
            }}
          >
            {wizardStep === 0 ? "Cancel" : "Back"}
          </Button>
          {wizardStep < 2 ? (
            <Button
              size="sm"
              disabled={isSaving || !canManageProviders || !driverAllowed}
              onClick={() => navigateToStep(wizardStep + 1)}
            >
              Next
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={isSaving || !canManageProviders || !driverAllowed}
              onClick={() => void handleSave()}
            >
              {isSaving ? "Adding..." : "Add instance"}
            </Button>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
