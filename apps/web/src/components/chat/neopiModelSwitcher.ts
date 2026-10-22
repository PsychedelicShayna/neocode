import type {
  EnvironmentId,
  NeoPiModelSelectorFacts,
  NeoPiModelSelectorResult,
  NeoPiModelsTarget,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";

export interface NativeSelectorContext {
  environmentId: EnvironmentId | null;
  projectId?: ProjectId;
  connectedThread?: { threadId: ThreadId; providerInstanceId: ProviderInstanceId };
}

export function nativeSelectorTarget(
  context: NativeSelectorContext,
  providerInstanceId: ProviderInstanceId,
): NeoPiModelsTarget {
  return {
    providerInstanceId,
    ...(context.projectId ? { projectId: context.projectId } : {}),
    ...(context.connectedThread?.providerInstanceId === providerInstanceId
      ? { threadId: context.connectedThread.threadId }
      : {}),
  };
}

export function nativeSelectorRequests(
  context: NativeSelectorContext,
  entries: ReadonlyArray<ProviderInstanceEntry>,
) {
  return entries
    .filter(
      (entry) =>
        entry.driverKind === "neopi" &&
        entry.enabled &&
        entry.isAvailable &&
        entry.status === "ready",
    )
    .map((entry) => ({
      target: nativeSelectorTarget(context, entry.instanceId),
      displayName: entry.displayName,
    }));
}

export type NativeSwitcherModel = ModelEsque & {
  instanceId: ProviderInstanceId;
  instanceDisplayName: string;
  group: string;
  selectorFacts?: NeoPiModelSelectorFacts;
  resolvedSelector?: string | null;
};

export function nativeSwitcherGroup(model: ModelEsque): string {
  if (model.slug.startsWith("@") && !model.slug.includes("/")) return "Roles";
  return model.subProvider || model.slug.split("/")[0] || "Unknown provider";
}

/** Keep each native response in its returned order. Selector IDs are opaque routing keys. */
export function nativeSwitcherModels(input: {
  entries: ReadonlyArray<ProviderInstanceEntry>;
  results: ReadonlyMap<ProviderInstanceId, NeoPiModelSelectorResult>;
  activeInstanceId: ProviderInstanceId;
  activeModel: string;
  activeOption?: ModelEsque | undefined;
  includeUnavailableSelection: boolean;
}): NativeSwitcherModel[] {
  const models: NativeSwitcherModel[] = [];
  for (const entry of input.entries) {
    const result = input.results.get(entry.instanceId);
    if (!result || result.error !== null) continue;
    for (const [rows, role] of [
      [result.roles, true],
      [result.items, false],
    ] as const) {
      for (const row of rows) {
        models.push({
          slug: row.selector,
          name: row.name,
          description: row.description,
          subProvider: row.provider,
          selectorFacts: row.facts,
          resolvedSelector: row.resolvedSelector,
          instanceId: entry.instanceId,
          instanceDisplayName: entry.displayName,
          group: role ? "Roles" : row.provider,
          isUnavailable:
            !entry.enabled ||
            !entry.isAvailable ||
            entry.status !== "ready" ||
            (role && row.resolvedSelector === null),
        });
      }
    }
  }
  if (
    input.includeUnavailableSelection &&
    input.activeModel &&
    !models.some(
      (model) => model.instanceId === input.activeInstanceId && model.slug === input.activeModel,
    )
  ) {
    models.push({
      ...input.activeOption,
      slug: input.activeModel,
      name: input.activeOption?.name ?? input.activeModel,
      instanceId: input.activeInstanceId,
      instanceDisplayName:
        input.entries.find((entry) => entry.instanceId === input.activeInstanceId)?.displayName ??
        input.activeInstanceId,
      group: nativeSwitcherGroup({ slug: input.activeModel, name: input.activeModel }),
      isUnavailable: true,
    });
  }
  return models;
}

export const NATIVE_FACT_COLUMNS = [
  "Intelligence",
  "TTFT",
  "Tokens/s",
  "Context",
  "Input / M",
  "Output / M",
] as const;

export function nativeSwitcherFactCells(
  model: ModelEsque & { selectorFacts?: NeoPiModelSelectorFacts },
): ReadonlyArray<string> {
  const facts = model.selectorFacts;
  const number = (value: number | null | undefined, format: (n: number) => string): string =>
    value != null && Number.isFinite(value) && value >= 0 ? format(value) : "Unknown";
  return [
    number(facts?.intelligence, (n) => String(n)),
    number(facts?.ttftMs, (n) => `${(n / 1000).toFixed(1)}s`),
    number(
      facts?.tokensPerSecond,
      (n) => `~${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}`,
    ),
    number(facts?.effectiveContextWindow, (n) =>
      n.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 }),
    ),
    number(
      facts?.inputCostPerMillion,
      (n) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`,
    ),
    number(
      facts?.outputCostPerMillion,
      (n) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`,
    ),
  ];
}
