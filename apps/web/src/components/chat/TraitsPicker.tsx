import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  getTraitSelectChange,
  replaceDescriptorCurrentValue,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";
import {
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
  resolveSelectableModel,
} from "@t3tools/shared/model";
import { memo } from "react";
import { GaugeIcon, ZapIcon } from "lucide-react";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { useComposerMenuState } from "./useComposerMenuState";
import { useComposerMenuProps } from "./composerEventScope";

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

const SAVED_OPTION_LABELS: Readonly<Record<string, string>> = {
  agent: "Agent",
  effort: "Effort",
  reasoningEffort: "Reasoning effort",
  variant: "Reasoning",
};

function savedOptionLabel(id: string): string {
  return (
    SAVED_OPTION_LABELS[id] ??
    id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase())
  );
}

/** Read-only descriptors for saved options when native model metadata is unavailable. */
export function buildUnavailableModelOptionDescriptors(
  selections: ProviderOptions | null | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return (selections ?? []).map((selection) =>
    typeof selection.value === "boolean"
      ? {
          id: selection.id,
          label: savedOptionLabel(selection.id),
          type: "boolean" as const,
          currentValue: selection.value,
        }
      : {
          id: selection.id,
          label: savedOptionLabel(selection.id),
          type: "select" as const,
          options: [{ id: selection.value, label: selection.value }],
          currentValue: selection.value,
        },
  );
}

type TraitsPersistence =
  | {
      threadRef?: ScopedThreadRef;
      draftId?: DraftId;
      /** Runs after a change is written to the draft. */
      onDraftModelOptionsChange?: () => void;
      onModelOptionsChange?: never;
    }
  | {
      threadRef?: undefined;
      onDraftModelOptionsChange?: never;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

function DefaultBadge() {
  return (
    <Badge variant="outline" size="sm" className="min-w-0">
      Default
    </Badge>
  );
}

const EMPTY_OPTION_DESCRIPTORS: ReadonlyArray<ProviderOptionDescriptor> = [];

function getSelectedTraits(
  provider: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  modelSelector: string | null | undefined,
  modelOptions: ProviderOptions | null | undefined,
) {
  const slug = resolveSelectableModel(provider, modelSelector, models);
  const model = slug === null ? undefined : models.find((candidate) => candidate.slug === slug);
  const descriptors =
    model === undefined
      ? buildUnavailableModelOptionDescriptors(modelOptions)
      : model.capabilities?.optionDescriptors?.length
        ? getProviderOptionDescriptors({ caps: model.capabilities, selections: modelOptions })
        : EMPTY_OPTION_DESCRIPTORS;
  const selectDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select",
  );
  const booleanDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "boolean" }> =>
      descriptor.type === "boolean",
  );
  const primarySelectDescriptor = selectDescriptors[0] ?? null;
  const contextWindowDescriptor =
    selectDescriptors.find((descriptor) => descriptor.id === "contextWindow") ?? null;
  const agentDescriptor = selectDescriptors.find((descriptor) => descriptor.id === "agent") ?? null;
  const fastModeDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const thinkingDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "thinking") ?? null;
  const effort = getDescriptorStringValue(primarySelectDescriptor);
  const thinkingEnabled =
    typeof thinkingDescriptor?.currentValue === "boolean" ? thinkingDescriptor.currentValue : null;
  const contextWindow = getDescriptorStringValue(contextWindowDescriptor);
  const selectedAgent = getDescriptorStringValue(agentDescriptor);
  const selectedAgentLabel = agentDescriptor
    ? getProviderOptionCurrentLabel(agentDescriptor)
    : null;
  return {
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    contextWindowDescriptor,
    agentDescriptor,
    fastModeDescriptor,
    thinkingDescriptor,
    effort,
    thinkingEnabled,
    contextWindow,
    selectedAgent,
    selectedAgentLabel,
    modelIsUnavailable: model === undefined,
    hasAnyControls: descriptors.length > 0,
  };
}

export function shouldRenderTraitsControls(
  input: Pick<TraitsMenuContentProps, "provider" | "models" | "model" | "modelOptions">,
): boolean {
  return getTraitsSectionVisibility(input).hasAnyControls;
}

export function getTraitsSectionVisibility(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  modelOptions?: ProviderOptions | null | undefined;
}) {
  const selected = getSelectedTraits(input.provider, input.models, input.model, input.modelOptions);

  const showEffort = selected.primarySelectDescriptor !== null;
  const showThinking = selected.thinkingDescriptor !== null;
  const showFastMode = selected.fastModeDescriptor !== null;
  const showContextWindow = selected.contextWindowDescriptor !== null;
  const showAgent = selected.agentDescriptor !== null;

  return {
    ...selected,
    showEffort,
    showThinking,
    showFastMode,
    showContextWindow,
    showAgent,
    hasAnyControls: selected.descriptors.length > 0,
  };
}

export interface TraitsMenuContentProps {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  modelOptions?: ProviderOptions | null | undefined;
  reportedModelSelection?: ModelSelection | null | undefined;
  triggerClassName?: string;
}

export type TraitsSelectionInput = TraitsMenuContentProps & TraitsPersistence;

/** The model's traits with their shown values, and writers that persist a change. */
export function useTraitsSelection({
  provider,
  instanceId,
  models,
  model,
  modelOptions,
  reportedModelSelection,
  triggerClassName: _triggerClassName,
  ...persistence
}: TraitsSelectionInput) {
  const modelSelection =
    instanceId && model ? { instanceId, model, options: modelOptions ?? [] } : null;
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const updateModelOptions = (nextOptions: ProviderOptions | undefined) => {
    if ("onModelOptionsChange" in persistence) {
      persistence.onModelOptionsChange(nextOptions);
      return;
    }
    const threadTarget = persistence.threadRef ?? persistence.draftId;
    if (!threadTarget) {
      return;
    }
    setProviderModelOptions(threadTarget, provider, nextOptions, {
      ...(instanceId ? { instanceId } : {}),
      model,
      persistSticky: true,
    });
    persistence.onDraftModelOptionsChange?.();
  };
  const selected = getTraitsSectionVisibility({
    provider,
    models,
    model,
    modelOptions,
  });
  return {
    ...selected,
    selectValue: (descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>) =>
      getDescriptorStringValue(descriptor, modelSelection, reportedModelSelection) ?? "",
    currentLabel: (descriptor: ProviderOptionDescriptor) =>
      getProviderOptionCurrentLabel(descriptor, modelSelection, reportedModelSelection),
    changeSelect: (
      descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
      value: string,
    ) => {
      const nextOptions = getTraitSelectChange(selected.descriptors, descriptor, value);
      if (nextOptions) updateModelOptions(nextOptions);
    },
    changeBoolean: (descriptorId: string, value: boolean) => {
      updateModelOptions(
        buildProviderOptionSelectionsFromDescriptors(
          replaceDescriptorCurrentValue(selected.descriptors, descriptorId, value),
        ),
      );
    },
  };
}

const TraitsMenuContent = memo(function TraitsMenuContentImpl(props: TraitsSelectionInput) {
  const traits = useTraitsSelection(props);
  const { descriptors, selectDescriptors, booleanDescriptors, hasAnyControls, modelIsUnavailable } =
    traits;

  if (!hasAnyControls) {
    return null;
  }

  if (modelIsUnavailable) {
    return (
      <>
        {descriptors.map((descriptor, index) => {
          const value = traits.currentLabel(descriptor);
          if (!value) return null;
          return (
            <div key={descriptor.id}>
              {index > 0 ? <MenuDivider /> : null}
              <MenuGroup>
                <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
                  {descriptor.label}
                </div>
                <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">{value}</div>
              </MenuGroup>
            </div>
          );
        })}
      </>
    );
  }

  return (
    <>
      {selectDescriptors.map((descriptor, index) => (
        <div key={descriptor.id}>
          {index > 0 ? <MenuDivider /> : null}
          <MenuGroup>
            <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
              {descriptor.label}
            </div>
            <MenuRadioGroup
              value={traits.selectValue(descriptor)}
              onValueChange={(value) => traits.changeSelect(descriptor, value)}
            >
              {selectableProviderOptionChoices(descriptor).map((option) => (
                <MenuRadioItem key={option.id} value={option.id} hideIndicator closeOnClick>
                  <span className="flex w-full min-w-0 flex-col">
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="min-w-0 truncate">{option.label}</span>
                      {option.isDefault ? <DefaultBadge /> : null}
                    </span>
                    {option.description ? (
                      <span className="max-w-56 text-pretty text-muted-foreground/80 text-xs">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </div>
      ))}
      {booleanDescriptors.map((descriptor, index) => (
        <div key={descriptor.id}>
          {index > 0 || selectDescriptors.length > 0 ? <MenuDivider /> : null}
          <MenuGroup>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
              {descriptor.label}
            </div>
            <MenuRadioGroup
              value={descriptor.currentValue === true ? "on" : "off"}
              onValueChange={(value) => traits.changeBoolean(descriptor.id, value === "on")}
            >
              {(["on", "off"] as const).map((value) => (
                <MenuRadioItem key={value} value={value} hideIndicator closeOnClick>
                  <span className="flex w-full min-w-0 items-center justify-between gap-3">
                    <span>{value === "on" ? "On" : "Off"}</span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </div>
      ))}
    </>
  );
});

export const TraitsPicker = memo(function TraitsPicker({
  size = "sm",
  hidden = false,
  disabled = false,
  isComposerOwned = false,
  ...props
}: TraitsSelectionInput & {
  size?: ComposerControlSize;
  hidden?: boolean;
  disabled?: boolean;
  isComposerOwned?: boolean;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [isMenuOpen, setIsMenuOpen] = useComposerMenuState(hidden || disabled);
  const traits = useTraitsSelection(props);
  if (!traits.hasAnyControls) {
    return null;
  }
  const { label: triggerLabel, speedLabel } = buildTraitsTriggerDisplay({
    descriptors: traits.descriptors,
    modelSelection:
      props.instanceId && props.model
        ? { instanceId: props.instanceId, model: props.model, options: props.modelOptions ?? [] }
        : null,
    reportedModelSelection: props.reportedModelSelection,
  });

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open && !disabled);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  disabled={disabled}
                  aria-label={triggerLabel}
                  size={size}
                  className={cn("shrink-0 whitespace-nowrap", props.triggerClassName)}
                />
              }
            />
          }
        >
          <>
            <ComposerControlIcon icon={speedLabel ? ZapIcon : GaugeIcon} size={size} />
            <span data-composer-control-label>{triggerLabel}</span>
          </>
        </TooltipTrigger>
        <TooltipPopup side="top">{triggerLabel}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" {...(isComposerOwned ? composerFloatingLayerProps : {})}>
        <TraitsMenuContent {...props} />
      </MenuPopup>
    </Menu>
  );
});
