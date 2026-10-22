import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type NeoPiModelSelectorFacts,
  type NeoPiModelSelectorItem,
  type NeoPiModelSelectorResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  nativeSelectorRequests,
  nativeSelectorTarget,
  nativeSwitcherFactCells,
  nativeSwitcherModels,
} from "./neopiModelSwitcher";
import { modelPickerModelKey, parseModelPickerModelKey } from "./modelPickerKeys";

const instanceId = ProviderInstanceId.make("neopi-work");
const otherInstanceId = ProviderInstanceId.make("neopi-personal");
const facts: NeoPiModelSelectorFacts = {
  intelligence: null,
  ttftMs: null,
  tokensPerSecond: null,
  contextWindow: null,
  effectiveContextWindow: null,
  inputCostPerMillion: null,
  outputCostPerMillion: null,
  performanceSource: null,
  serviceTier: null,
};
const item = (
  selector: string,
  overrides: Partial<NeoPiModelSelectorItem> = {},
): NeoPiModelSelectorItem => ({
  selector,
  provider: "custom-route",
  id: selector,
  name: selector,
  resolvedSelector: selector,
  facts,
  ...overrides,
});
const result = (
  items: ReadonlyArray<NeoPiModelSelectorItem>,
  roles: ReadonlyArray<NeoPiModelSelectorItem> = [],
): NeoPiModelSelectorResult => ({ items, roles, error: null });
const entries = deriveProviderInstanceEntries(
  [instanceId, otherInstanceId].map((instanceId) => ({
    instanceId,
    driver: ProviderDriverKind.make("neopi"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready" as const,
    auth: { status: "authenticated" as const },
    checkedAt: "2026-10-22T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  })),
);
const rows = (
  results: ReadonlyMap<ProviderInstanceId, NeoPiModelSelectorResult>,
  activeModel = "",
  includeUnavailableSelection = false,
) =>
  nativeSwitcherModels({
    entries,
    results,
    activeInstanceId: instanceId,
    activeModel,
    includeUnavailableSelection,
  });

describe("native model selector consumers", () => {
  it("preserves native ranked order and opaque selector IDs without a second name filter", () => {
    const models = rows(
      new Map([
        [
          instanceId,
          result([
            item("custom-route/Zed.V2:blue", { name: "Zed" }),
            item("custom-route/Alpha:Exact", { name: "Alpha" }),
          ]),
        ],
      ]),
    );
    expect(models.map((model) => model.slug)).toEqual([
      "custom-route/Zed.V2:blue",
      "custom-route/Alpha:Exact",
    ]);
    expect(
      parseModelPickerModelKey(modelPickerModelKey(models[0]!.instanceId, models[0]!.slug)),
    ).toEqual({ instanceId, slug: "custom-route/Zed.V2:blue" });
  });

  it("selects the role alias on its original instance instead of its resolved concrete model", () => {
    const models = rows(
      new Map([
        [
          instanceId,
          result(
            [],
            [
              item("@review", {
                resolvedSelector: "custom-route/first",
                description: "Review the change",
              }),
            ],
          ),
        ],
        [
          otherInstanceId,
          result([], [item("@review", { resolvedSelector: "custom-route/second" })]),
        ],
      ]),
    );
    expect(models.map((model) => [model.slug, model.group, model.resolvedSelector])).toEqual([
      ["@review", "Roles", "custom-route/first"],
      ["@review", "Roles", "custom-route/second"],
    ]);
    expect(models[0]?.description).toBe("Review the change");
    expect(
      models.map((model) =>
        parseModelPickerModelKey(modelPickerModelKey(model.instanceId, model.slug)),
      ),
    ).toEqual([
      { instanceId, slug: "@review" },
      { instanceId: otherInstanceId, slug: "@review" },
    ]);
  });

  it("uses effective context and nullable native facts, preserving genuine zero costs", () => {
    const models = rows(
      new Map([
        [
          instanceId,
          result([
            item("custom-route/model", {
              facts: {
                ...facts,
                intelligence: 43,
                tokensPerSecond: 118,
                contextWindow: 200000,
                effectiveContextWindow: 120000,
                inputCostPerMillion: 0,
                outputCostPerMillion: 15,
                performanceSource: "measured",
                serviceTier: "priority",
              },
            }),
          ]),
        ],
      ]),
    );
    expect(nativeSwitcherFactCells(models[0]!)).toEqual([
      "43",
      "Unknown",
      "~118",
      "120K",
      "$0",
      "$15",
    ]);
    expect(nativeSwitcherFactCells({ slug: "local/unknown", name: "Unknown" })).toEqual(
      Array(6).fill("Unknown"),
    );
    expect(
      nativeSwitcherFactCells({
        slug: "local/catalog-only",
        name: "Catalog",
        selectorFacts: { ...facts, contextWindow: 200000 },
      })[3],
    ).toBe("Unknown");
  });

  it("does not substitute catalog models after native errors or an empty enabled scope", () => {
    const models = rows(
      new Map([
        [instanceId, { ...result([item("private/hidden")]), error: "Invalid native query" }],
      ]),
      "private/saved:Exact",
      true,
    );
    expect(models.map((model) => [model.slug, model.isUnavailable])).toEqual([
      ["private/saved:Exact", true],
    ]);
    expect(rows(new Map())).toEqual([]);
    expect(rows(new Map(), "saved/model", false)).toEqual([]);
    expect(nativeSwitcherFactCells(models[0]!)).toEqual(Array(6).fill("Unknown"));
  });

  it("queries only the matching connected instance with the thread, and others with project context", () => {
    const projectId = ProjectId.make("project");
    const threadId = ThreadId.make("thread");
    const context = {
      environmentId: EnvironmentId.make("remote"),
      projectId,
      connectedThread: { threadId, providerInstanceId: instanceId },
    };
    expect(nativeSelectorTarget(context, instanceId)).toEqual({
      providerInstanceId: instanceId,
      projectId,
      threadId,
    });
    expect(nativeSelectorTarget(context, otherInstanceId)).toEqual({
      providerInstanceId: otherInstanceId,
      projectId,
    });
    expect(
      nativeSelectorTarget({ environmentId: context.environmentId, projectId }, instanceId),
    ).toEqual({ providerInstanceId: instanceId, projectId });
    expect(nativeSelectorTarget({ environmentId: context.environmentId }, instanceId)).toEqual({
      providerInstanceId: instanceId,
    });
  });

  it("queries only enabled, available native instances in the supplied scope", () => {
    const source = entries[0]!;
    const scopedEntries = [
      source,
      { ...source, instanceId: ProviderInstanceId.make("disabled"), enabled: false },
      { ...source, instanceId: ProviderInstanceId.make("unavailable"), isAvailable: false },
      { ...source, instanceId: ProviderInstanceId.make("error"), status: "error" as const },
      {
        ...source,
        instanceId: ProviderInstanceId.make("other"),
        driverKind: ProviderDriverKind.make("codex"),
      },
    ];
    expect(
      nativeSelectorRequests({ environmentId: EnvironmentId.make("remote") }, scopedEntries).map(
        (request) => request.target.providerInstanceId,
      ),
    ).toEqual([source.instanceId]);
  });
});
