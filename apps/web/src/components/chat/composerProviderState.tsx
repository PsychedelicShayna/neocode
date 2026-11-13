import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionSelection,
  ScopedThreadRef,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
  resolveSelectableModel,
} from "@t3tools/shared/model";
import {
  getDescriptorStringValue,
  getTraitSelectChange,
  isReasoningSelect,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";
import type { DraftId } from "../../composerDraftStore";
import { getTraitsSectionVisibility, type TraitsSelectionInput } from "./TraitsPicker";

type ComposerProviderStateInput = {
  provider: ProviderDriverKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
};

export type ComposerProviderState = {
  provider: ProviderDriverKind;
  modelOptionsForDispatch: ReadonlyArray<ProviderOptionSelection> | undefined;
};

type ComposerTraitsTarget = {
  provider: ProviderDriverKind;
  instanceId: ProviderInstanceId;
  threadRef?: ScopedThreadRef | undefined;
  draftId?: DraftId | undefined;
  onDraftModelOptionsChange?: () => void;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  reportedModelSelection?: ModelSelection | null | undefined;
};

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  const { provider, model, models, modelOptions } = input;
  const slug = resolveSelectableModel(provider, model, models);
  const selectedModel = models.find((candidate) => candidate.slug === slug);
  if (!selectedModel) {
    return {
      provider,
      modelOptionsForDispatch: modelOptions?.length ? modelOptions : undefined,
    };
  }
  if (!selectedModel.capabilities) {
    return { provider, modelOptionsForDispatch: undefined };
  }
  const descriptors = getProviderOptionDescriptors({
    caps: selectedModel.capabilities,
    selections: modelOptions,
  });
  return {
    provider,
    modelOptionsForDispatch: buildExplicitProviderOptionSelectionsFromDescriptors(
      descriptors,
      modelOptions,
    ),
  };
}

export function getComposerReasoningStep(input: {
  provider: ProviderDriverKind;
  instanceId: ProviderInstanceId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  reportedModelSelection?: ModelSelection | null | undefined;
  direction: 1 | -1;
}): ReadonlyArray<ProviderOptionSelection> | null {
  const selected = getTraitsSectionVisibility(input);
  if (selected.modelIsUnavailable) return null;
  const descriptor = selected.selectDescriptors.find(isReasoningSelect);
  const choices = descriptor ? selectableProviderOptionChoices(descriptor) : [];
  if (!descriptor || choices.length < 2) return null;
  const current = getDescriptorStringValue(
    descriptor,
    { instanceId: input.instanceId, model: input.model, options: input.modelOptions ?? [] },
    input.reportedModelSelection,
  );
  const ordered = input.direction > 0 ? descriptor.options : descriptor.options.toReversed();
  const position =
    [current, getDescriptorStringValue(descriptor)]
      .map((value) => ordered.findIndex((option) => option.id === value))
      .find((index) => index >= 0) ?? -1;
  const next = [...ordered.slice(position + 1), ...ordered.slice(0, Math.max(position, 0))].find(
    (option) => choices.includes(option),
  );
  return next ? (getTraitSelectChange(selected.descriptors, descriptor, next.id) ?? null) : null;
}

export function resolveComposerTraitsInput(
  input: ComposerTraitsTarget,
): TraitsSelectionInput | null {
  const { threadRef, draftId, ...rest } = input;
  const persistence = threadRef ? { threadRef } : draftId ? { draftId } : null;
  if (!persistence) return null;
  return { ...rest, ...persistence };
}
