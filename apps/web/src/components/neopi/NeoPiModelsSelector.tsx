import type {
  EnvironmentId,
  NeoPiModelsConfiguration,
  NeoPiModelsTarget,
  NeoPiNativeModel,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { useMemo } from "react";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { modelDisplayName, modelSelector, modelsIndex } from "./modelsPresentation";

type SelectorOptions = ReturnType<typeof buildSelectorOptions>;
const optionsByCatalog = new WeakMap<
  ReadonlyArray<NeoPiNativeModel>,
  Map<ProviderInstanceId, SelectorOptions>
>();

const buildSelectorOptions = (models: ReadonlyArray<NeoPiNativeModel>) =>
  models.map((model) => ({
    slug: modelSelector(model),
    name: modelDisplayName(model),
    provider: "neopi" as const,
    subProvider: model.provider,
    isUnavailable: !model.available,
  }));

/** Every role row offers the same catalog: build its options once per snapshot, not once per row. */
const selectorOptions = (
  models: ReadonlyArray<NeoPiNativeModel>,
  instanceId: ProviderInstanceId,
): ReadonlyMap<ProviderInstanceId, SelectorOptions> => {
  let byInstance = optionsByCatalog.get(models);
  if (!byInstance) optionsByCatalog.set(models, (byInstance = new Map()));
  let options = byInstance.get(instanceId);
  if (!options) byInstance.set(instanceId, (options = buildSelectorOptions(models)));
  return byInstance;
};

/** A Models assignment uses the stock native selector, scoped to the exact NeoPi connection. */
export function NeoPiModelsSelector({
  configuration,
  environmentId,
  target,
  provider,
  scope,
  label,
  value,
  onChange,
  disabled = false,
  open,
  onOpenChange,
  exactOnly = false,
  selectionLabel,
}: {
  configuration: NeoPiModelsConfiguration;
  environmentId: EnvironmentId;
  target: NeoPiModelsTarget;
  provider: ServerProvider;
  scope: "global" | "project";
  label: string;
  value: string;
  onChange: (selector: string) => void;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  exactOnly?: boolean;
  selectionLabel?: string;
}) {
  const entries = useMemo(() => deriveProviderInstanceEntries([provider]), [provider]);
  const options = selectorOptions(configuration.models, provider.instanceId);
  const index = modelsIndex(configuration.models);
  const selected = index.bySelector.get(value);
  const role = configuration.roles.find((role) => role.alias === value);
  const resolution = role?.scopedResolutions[scope];
  const resolved = resolution
    ? index.bySelector.get(`${resolution.provider}/${resolution.modelId}`)
    : undefined;
  const triggerLabel = !value
    ? "Automatic"
    : selected?.available
      ? modelDisplayName(selected)
      : resolved
        ? modelDisplayName(resolved)
        : "Not available";
  return (
    <ProviderModelPicker
      activeInstanceId={provider.instanceId}
      selectorContext={{
        environmentId,
        ...(target.projectId ? { projectId: target.projectId } : {}),
        ...(target.sessionFile
          ? {
              connectedSession: {
                providerInstanceId: target.providerInstanceId,
                sessionFile: target.sessionFile,
              },
            }
          : {}),
      }}
      model={value}
      instanceEntries={entries}
      modelOptionsByInstance={options}
      lockedProvider={provider.driver}
      size="sm"
      disabled={disabled}
      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
      triggerLabel={selectionLabel ?? triggerLabel}
      triggerAriaLabel={label}
      {...(exactOnly
        ? {
            getModelDisabledReason: (_: unknown, selector: string) =>
              index.bySelector.has(selector) ? null : "Choose an exact model.",
          }
        : {})}
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
      onInstanceModelChange={(_, selector) => onChange(selector)}
    />
  );
}
