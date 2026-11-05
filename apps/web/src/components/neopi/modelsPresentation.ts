import type { NeoPiModelsConfiguration, NeoPiNativeModel } from "@t3tools/contracts";

export const MODEL_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Editing scopes inherit authored values, but only NeoPi resolves selectors and role aliases. */
export function modelRoleForScope(
  role: Pick<NeoPiModelsConfiguration["roles"][number], "global" | "project" | "scopedResolutions">,
  scope: "global" | "project",
) {
  const scoped = role[scope];
  return {
    selector: scoped.selector ?? (scope === "project" ? role.global.selector : null) ?? "",
    effort: scoped.effort ?? (scope === "project" ? role.global.effort : null),
    resolution: role.scopedResolutions[scope],
  };
}

export function modelDisplayName(model: Pick<NeoPiNativeModel, "name" | "id">): string {
  const name = model.name.trim();
  return name.length === 0 || name.length > 48 ? model.id : name;
}

/** Runs are contiguous in the native effort scale, not merely adjacent in the selection. */
export function modelEffortLabel(efforts: ReadonlyArray<string>): string {
  const selected = new Set(efforts);
  const runs: string[] = [];
  let start = 0;
  while (start < MODEL_EFFORTS.length) {
    if (!selected.has(MODEL_EFFORTS[start]!)) {
      start += 1;
      continue;
    }
    let end = start;
    while (end + 1 < MODEL_EFFORTS.length && selected.has(MODEL_EFFORTS[end + 1]!)) end += 1;
    runs.push(
      end === start ? MODEL_EFFORTS[start]! : `${MODEL_EFFORTS[start]}–${MODEL_EFFORTS[end]}`,
    );
    start = end + 1;
  }
  return runs.join(", ") || "—";
}

export function modelContextLabel(tokens: number | null): string {
  if (tokens === null) return "—";
  if (tokens >= 1_000_000) return `${Number((tokens / 1_048_576).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(1))}K`;
  return tokens.toLocaleString();
}

const modelPriceFormatter = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });

export function modelPriceLabel(cost: Pick<NeoPiNativeModel["cost"], "input" | "output">): string {
  if (cost.input === 0 && cost.output === 0) return "—";
  const input = cost.input < 0 ? "-" : `$${modelPriceFormatter.format(cost.input)}`;
  const output = cost.output < 0 ? "-" : `$${modelPriceFormatter.format(cost.output)}`;
  return `${input} / ${output}`;
}

export function isModelRulePattern(selector: string): boolean {
  return selector.startsWith("re:") || /[*?[\]{}]/.test(selector);
}

/** Match NeoPi's regex syntax and provider/model requirement for exact and glob selectors. */
export function isModelRuleSelectorValid(selector: string): boolean {
  if (!selector.trim()) return false;
  if (selector.startsWith("re:")) {
    try {
      new RegExp(selector.slice(3));
      return true;
    } catch {
      return false;
    }
  }
  const slash = selector.indexOf("/");
  return slash > 0 && slash < selector.length - 1;
}

export function moveModelItem<T>(items: ReadonlyArray<T>, index: number, offset: -1 | 1): T[] {
  const next = [...items];
  const destination = index + offset;
  if (index < 0 || destination < 0 || index >= items.length || destination >= items.length)
    return next;
  [next[index], next[destination]] = [next[destination]!, next[index]!];
  return next;
}

/** Ready is native availability, not stored authentication; public providers can be ready.
 *  NeoProxy leads each group: it is the team's switch, not one vendor among many. */
export function modelProviderGroups(
  providers: NeoPiModelsConfiguration["providers"],
  query: string,
) {
  const search = query.trim().toLocaleLowerCase();
  const rank = (id: string) => (id === "neoproxy" ? 0 : 1);
  const matching = providers
    .filter((provider) => provider.id.toLocaleLowerCase().includes(search))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  return {
    ready: matching.filter((provider) => provider.available === true),
    notSetUp: matching.filter((provider) => provider.available !== true),
  };
}

export const modelSelector = (model: Pick<NeoPiNativeModel, "provider" | "id">) =>
  `${model.provider}/${model.id}`;

export interface ModelsIndex {
  /** `provider/id` to model; the catalog's one lookup, instead of a scan per row, role or rule. */
  readonly bySelector: ReadonlyMap<string, NeoPiNativeModel>;
  /** Lowercased `provider/id name`, parallel to the catalog, built on the first filter only. */
  searchKeys(): ReadonlyArray<string>;
}

const indexes = new WeakMap<ReadonlyArray<NeoPiNativeModel>, ModelsIndex>();

/** One linear pass per catalog snapshot, shared by every consumer of that snapshot. */
export function modelsIndex(models: ReadonlyArray<NeoPiNativeModel>): ModelsIndex {
  let index = indexes.get(models);
  if (index) return index;
  const bySelector = new Map<string, NeoPiNativeModel>();
  for (const model of models) {
    const selector = modelSelector(model);
    // A duplicated selector keeps its first row, matching the Array.find it replaces.
    if (!bySelector.has(selector)) bySelector.set(selector, model);
  }
  let keys: string[] | undefined;
  index = {
    bySelector,
    searchKeys: () =>
      (keys ??= models.map((model) => `${modelSelector(model)} ${model.name}`.toLocaleLowerCase())),
  };
  indexes.set(models, index);
  return index;
}

/** A provider page keeps its catalog even without credentials; All models follows Ready. */
export function modelsForView(
  configuration: Pick<NeoPiModelsConfiguration, "models" | "providers">,
  providerId: string | null,
  query: string,
) {
  const ready =
    providerId === null
      ? new Set(
          configuration.providers
            .filter((provider) => provider.available === true)
            .map((provider) => provider.id),
        )
      : null;
  const search = query.trim().toLocaleLowerCase();
  const keys = search === "" ? null : modelsIndex(configuration.models).searchKeys();
  const { models } = configuration;
  const matches: NeoPiNativeModel[] = [];
  for (let at = 0; at < models.length; at += 1) {
    const model = models[at]!;
    if (!(providerId === null ? ready!.has(model.provider) : model.provider === providerId))
      continue;
    if (keys === null || keys[at]!.includes(search)) matches.push(model);
  }
  return matches;
}
