import type { ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";

export type NativeSwitcherModel = ModelEsque & {
  instanceId: ProviderInstanceId;
  instanceDisplayName: string;
  group: string;
};

export function nativeSwitcherGroup(model: ModelEsque): string {
  if (model.slug.startsWith("@") && !model.slug.includes("/")) return "Roles";
  return model.subProvider || model.slug.split("/")[0] || "Unknown provider";
}

export function nativeSwitcherModels(input: {
  entries: ReadonlyArray<ProviderInstanceEntry>;
  options: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  activeInstanceId: ProviderInstanceId;
  activeModel: string;
}): NativeSwitcherModel[] {
  const models: NativeSwitcherModel[] = [];
  for (const entry of input.entries) {
    if (entry.driverKind !== "neopi") continue;
    const options = input.options.get(entry.instanceId) ?? [];
    for (const model of options) {
      models.push({
        ...model,
        instanceId: entry.instanceId,
        instanceDisplayName: entry.displayName,
        group: nativeSwitcherGroup(model),
        isUnavailable: model.isUnavailable || !entry.enabled || !entry.isAvailable || entry.status !== "ready",
      });
    }
  }
  if (input.activeModel && !models.some((model) => model.instanceId === input.activeInstanceId && model.slug === input.activeModel)) {
    models.push({
      slug: input.activeModel,
      name: input.activeModel,
      instanceId: input.activeInstanceId,
      instanceDisplayName: input.entries.find((entry) => entry.instanceId === input.activeInstanceId)?.displayName ?? input.activeInstanceId,
      group: nativeSwitcherGroup({ slug: input.activeModel, name: input.activeModel }),
      isUnavailable: true,
    });
  }
  return models;
}

// The modal slash/regex selector is native policy. Replace this plain-text seam
// only when NeoPi's selector API is available, rather than guessing its grammar.
export function filterNativeSwitcherModels(models: ReadonlyArray<NativeSwitcherModel>, query: string): ReadonlyArray<NativeSwitcherModel> {
  const text = query.trim().toLocaleLowerCase();
  if (!text) return models;
  return models.filter((model) => `${model.slug} ${model.name} ${model.description ?? ""} ${model.group} ${model.instanceDisplayName}`.toLocaleLowerCase().includes(text));
}

export const NATIVE_FACT_COLUMNS = ["Intelligence", "TTFT", "Tokens/s", "Context", "Input / M", "Output / M"] as const;

// Native facts enrichment belongs at this boundary, not in per-row renderers.
export function nativeSwitcherFactCells(model: ModelEsque): ReadonlyArray<string> {
  const facts = model.nativeFacts;
  const number = (value: number | undefined, format: (n: number) => string): string =>
    value !== undefined && Number.isFinite(value) && value >= 0 ? format(value) : "Unknown";
  return [
    number(facts?.intelligence, (n) => String(n)),
    number(facts?.ttftMs, (n) => `${(n / 1000).toFixed(1)}s`),
    number(facts?.tokensPerSecond, (n) => `~${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}`),
    number(facts?.contextWindow, (n) => n.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 })),
    number(facts?.inputCostPerMillion, (n) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`),
    number(facts?.outputCostPerMillion, (n) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`),
  ];
}
