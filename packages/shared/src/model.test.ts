import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";

import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
  readCustomModelEntries,
  toCustomModelSetting,
  normalizeModelSlug,
  modelSelectionsEqual,
} from "./model.ts";

describe("native model normalization", () => {
  it("preserves native identifiers without applying retired harness aliases", () => {
    expect(normalizeModelSlug(" 5.4 ")).toBe("5.4");
    expect(normalizeModelSlug("openai-codex/gpt-6-astra")).toBe("openai-codex/gpt-6-astra");
    expect(normalizeModelSlug("anthropic/claude-fable-5-1")).toBe("anthropic/claude-fable-5-1");
    expect(normalizeModelSlug("5.4", ProviderDriverKind.make("codex"))).toBe("gpt-5.4");
  });
});

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

describe("descriptor helpers", () => {
  it.each(["ultrathink", "ultracode"])(
    "treats the native choice %s as data without rewriting it or adding a toggle",
    (value) => {
      const selections = [{ id: "effort", value }];
      const descriptors = getProviderOptionDescriptors({
        caps: createModelCapabilities({
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [{ id: value, label: value, isDefault: true }],
              promptInjectedValues: [value],
            },
            { id: "ultracode", label: "Native toggle", type: "boolean" },
          ],
        }),
        selections,
      });
      expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, selections)).toEqual(
        selections,
      );
    },
  );

  it("preserves native reasoning capability without inventing an effort selector", () => {
    for (const reasoning of [true, false]) {
      const capabilities = createModelCapabilities({ reasoning, optionDescriptors: [] });
      expect(capabilities).toEqual({ reasoning, optionDescriptors: [] });
      const stored = toCustomModelSetting({
        slug: "future-proxy/virtual/model",
        name: "future-proxy/virtual/model",
        capabilities,
      });
      expect(stored).toEqual({ slug: "future-proxy/virtual/model", capabilities });
      expect(readCustomModelEntries([stored])).toEqual([
        {
          slug: "future-proxy/virtual/model",
          name: "future-proxy/virtual/model",
          capabilities,
        },
      ]);
    }
  });

  it("builds dispatch options only from explicit selections", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [{ id: "fastMode", value: true }],
    });

    expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, undefined)).toBe(
      undefined,
    );
    expect(
      buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, [
        { id: "fastMode", value: true },
      ]),
    ).toEqual([{ id: "fastMode", value: true }]);
  });

  it("compares complete model selections independent of option ordering", () => {
    const left = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
    const reordered = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "fastMode", value: true },
      { id: "reasoningEffort", value: "high" },
    ]);

    expect(modelSelectionsEqual(left, reordered)).toBe(true);
    expect(
      modelSelectionsEqual(left, {
        ...reordered,
        options: [
          { id: "fastMode", value: true },
          { id: "reasoningEffort", value: "medium" },
        ],
      }),
    ).toBe(false);
    expect(modelSelectionsEqual(left, { ...reordered, model: "gpt-5.5" })).toBe(false);
  });
});

describe("readCustomModelEntries", () => {
  const capabilities: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
        currentValue: "high",
      },
    ],
  };

  it("resolves bare slugs and entries, trimming and deduplicating on slug", () => {
    expect(
      readCustomModelEntries([
        " bare ",
        { slug: "named", name: " Named ", capabilities },
        "bare",
        { slug: "named", name: "Second" },
        "",
        { name: "no slug" },
        42,
      ]),
    ).toEqual([
      { slug: "bare", name: "bare", capabilities: null },
      { slug: "named", name: "Named", capabilities },
    ]);
  });

  it("drops unparseable capabilities but keeps the entry", () => {
    expect(
      readCustomModelEntries([{ slug: "x", capabilities: { optionDescriptors: "nope" } }]),
    ).toEqual([{ slug: "x", name: "x", capabilities: null }]);
    expect(readCustomModelEntries("not a list")).toEqual([]);
  });
});

describe("provider-reported option display", () => {
  const selection = createModelSelection(ProviderInstanceId.make("opencode"), "ling");
  const reported = { ...selection, options: [{ id: "variant", value: "default" }] };
  const descriptor = {
    id: "variant",
    label: "Reasoning",
    type: "select" as const,
    options: [
      { id: "none", label: "None" },
      { id: "thinking", label: "Thinking" },
    ],
  };

  it("shows explicit reports without adding a choice or a dispatch option", () => {
    expect(getProviderOptionCurrentLabel(descriptor, selection, reported)).toBe("Default");
    expect(
      getProviderOptionCurrentLabel(descriptor, selection, {
        ...reported,
        options: [{ id: "variant", value: "thinking" }],
      }),
    ).toBe("Thinking");
    expect(
      getProviderOptionCurrentLabel(
        { ...descriptor, currentValue: "none" },
        { ...selection, options: [{ id: "variant", value: "none" }] },
        reported,
      ),
    ).toBe("None");
    expect(descriptor.options.map((option) => option.id)).toEqual(["none", "thinking"]);
    expect(buildProviderOptionSelectionsFromDescriptors([descriptor])).toBeUndefined();
    expect(getProviderOptionCurrentLabel(descriptor, selection)).toBe("Unknown");
    const effortDescriptor = { ...descriptor, id: "effort", currentValue: "default" };
    expect(getProviderOptionCurrentLabel(effortDescriptor, selection)).toBeUndefined();
    expect(
      getProviderOptionCurrentLabel(effortDescriptor, selection, {
        ...reported,
        model: "other",
        options: [{ id: "effort", value: "default" }],
      }),
    ).toBeUndefined();
    expect(
      getProviderOptionCurrentLabel(effortDescriptor, selection, {
        ...reported,
        options: [{ id: "effort", value: "default" }],
      }),
    ).toBe("Default");
    expect(
      getProviderOptionCurrentLabel({ ...descriptor, currentValue: "thinking" }, selection),
    ).toBe("Unknown");
  });

  it.each([
    { ...selection, model: "other" },
    { ...selection, instanceId: ProviderInstanceId.make("other") },
    { ...selection, options: [{ id: "variant", value: "none" }] },
  ])("ignores reports after changing the model, instance, or option: %j", (selected) => {
    expect(getProviderOptionCurrentLabel(descriptor, selected, reported)).toBe("Unknown");
  });
});
