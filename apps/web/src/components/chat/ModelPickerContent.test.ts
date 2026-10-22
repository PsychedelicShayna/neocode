import { ProviderDriverKind, ProviderInstanceId, type ServerProvider, type ServerProviderModel } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import { filterNativeSwitcherModels, nativeSwitcherFactCells, nativeSwitcherModels } from "./neopiModelSwitcher";
import { modelPickerModelKey, parseModelPickerModelKey } from "./modelPickerKeys";

const instanceId = ProviderInstanceId.make("neopi-work");
function catalog(models: ReadonlyArray<ServerProviderModel>, status: ServerProvider["status"] = "ready") {
  const entries = deriveProviderInstanceEntries([{
    instanceId, driver: ProviderDriverKind.make("neopi"), enabled: true, installed: true,
    version: null, status, auth: { status: "authenticated" }, checkedAt: "2026-10-22T00:00:00.000Z",
    models, slashCommands: [], skills: [],
  }]);
  const options = new Map(entries.map((entry) => [entry.instanceId, getAppModelOptionsForInstance(DEFAULT_UNIFIED_SETTINGS, entry)]));
  return { entries, options, activeInstanceId: instanceId };
}
const nativeModel = (slug: string, facts?: ServerProviderModel["nativeFacts"]): ServerProviderModel => ({
  slug, name: "Review model", isCustom: false, capabilities: {}, ...(facts ? { nativeFacts: facts } : {}),
});

describe("native model switcher consumers", () => {
  it("carries catalog facts through composer options without inventing missing metrics", () => {
    const input = catalog([nativeModel("neoproxy/virtual/review", {
      intelligence: 43, tokensPerSecond: 118, contextWindow: 200000, inputCostPerMillion: 0, outputCostPerMillion: 15,
    })]);
    const rows = nativeSwitcherModels({ ...input, activeModel: "neoproxy/virtual/review" });
    expect(rows[0]?.group).toBe("neoproxy");
    expect(nativeSwitcherFactCells(rows[0]!)).toEqual(["43", "Unknown", "~118", "200K", "$0", "$15"]);
    expect(nativeSwitcherFactCells(nativeModel("local/unknown"))).toEqual(Array(6).fill("Unknown"));
  });

  it("keeps role aliases and raw virtual IDs distinct through filtering and selection", () => {
    const input = catalog([nativeModel("@review"), nativeModel("custom-route/Review.V2:blue"), nativeModel("other/basic")]);
    const rows = nativeSwitcherModels({ ...input, activeModel: "@review" });
    expect(rows.find((row) => row.slug === "@review")?.group).toBe("Roles");
    const filtered = filterNativeSwitcherModels(rows, "review.v2:blue");
    expect(filtered.map((row) => row.slug)).toEqual(["custom-route/Review.V2:blue"]);
    expect(parseModelPickerModelKey(modelPickerModelKey(filtered[0]!.instanceId, filtered[0]!.slug))).toEqual({ instanceId, slug: "custom-route/Review.V2:blue" });
    expect(filterNativeSwitcherModels(rows, "/review/JS")).toEqual([]);
  });

  it("keeps missing and inaccessible saved selections visible without silently substituting a model", () => {
    const input = catalog([nativeModel("openai/available")], "error");
    const rows = nativeSwitcherModels({ ...input, activeModel: "private-route/saved:exact" });
    expect(rows.map((row) => row.slug)).toEqual(["openai/available", "private-route/saved:exact"]);
    expect(rows.every((row) => row.isUnavailable)).toBe(true);
    expect(nativeSwitcherFactCells(rows[1]!)).toEqual(Array(6).fill("Unknown"));
  });
});

it("retains the exact saved native selection when its runtime entry disappears", () => {
  const rows = nativeSwitcherModels({
    entries: [],
    options: new Map(),
    activeInstanceId: instanceId,
    activeModel: "custom-proxy/virtual/model:Exact",
  });
  expect(rows.map((row) => [row.slug, row.group, row.isUnavailable])).toEqual([
    ["custom-proxy/virtual/model:Exact", "custom-proxy", true],
  ]);
});

it("retains descriptions for newly discovered roles through composer options and filtering", () => {
  const input = catalog([{
    ...nativeModel("@new-project-role"),
    description: "Find the preceding architecture decision",
  }]);
  const rows = nativeSwitcherModels({ ...input, activeModel: "@new-project-role" });
  expect(rows[0]?.description).toBe("Find the preceding architecture decision");
  expect(filterNativeSwitcherModels(rows, "preceding architecture").map((row) => row.slug)).toEqual([
    "@new-project-role",
  ]);
});
