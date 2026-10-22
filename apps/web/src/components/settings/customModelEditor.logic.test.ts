import { describe, expect, it } from "vite-plus/test";
import { type ModelCapabilities } from "@t3tools/contracts";

import {
  definitionFromDraft,
  descriptorsFromCapabilities,
  draftFromDefinition,
  validateDraft,
  type CustomModelDraft,
} from "./customModelEditor.logic";

const draft = (overrides: Partial<CustomModelDraft>): CustomModelDraft => ({
  slug: "my-model",
  name: "",
  descriptors: [],
  ...overrides,
});

describe("customModelEditor.logic", () => {
  it("preserves reasoning-only metadata when reopening and renaming a custom model", () => {
    for (const reasoning of [true, false]) {
      const capabilities = { reasoning, optionDescriptors: [] };
      const reopened = draftFromDefinition({
        slug: "proxy/virtual/reasoner",
        name: "Reasoner",
        capabilities,
      });
      expect(definitionFromDraft({ ...reopened, name: "Renamed" })).toEqual({
        slug: "proxy/virtual/reasoner",
        name: "Renamed",
        capabilities,
      });
    }
  });

  it("round-trips a definition through the draft, marking the current value as default", () => {
    const definition = definitionFromDraft(
      draft({
        name: " My Model ",
        descriptors: [
          {
            key: "a",
            type: "select",
            id: "reasoningEffort",
            label: "Reasoning",
            choices: [
              { key: "a1", id: "low", label: "Low", isDefault: false },
              { key: "a2", id: "high", label: "", isDefault: true },
            ],
          },
          { key: "b", type: "boolean", id: "fastMode", label: "Fast Mode", choices: [] },
        ],
      }),
    );

    expect(definition).toEqual({
      slug: "my-model",
      name: "My Model",
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "high", isDefault: true },
            ],
            currentValue: "high",
          },
          { id: "fastMode", label: "Fast Mode", type: "boolean" },
        ],
      },
    });

    const reopened = draftFromDefinition(definition);
    expect(reopened.name).toBe("My Model");
    expect(reopened.descriptors.map((descriptor) => descriptor.id)).toEqual([
      "reasoningEffort",
      "fastMode",
    ]);
    expect(reopened.descriptors[0]!.choices.map((choice) => choice.isDefault)).toEqual([
      false,
      true,
    ]);
  });

  it("preserves the current choice when it differs from the built-in default", () => {
    const descriptors = descriptorsFromCapabilities({
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          currentValue: "high",
          options: [
            { id: "low", label: "Low", isDefault: true },
            { id: "high", label: "High" },
          ],
        },
      ],
    });
    expect(descriptors[0]!.choices.map((choice) => choice.isDefault)).toEqual([false, true]);
    expect(
      definitionFromDraft(draft({ descriptors })).capabilities?.optionDescriptors?.[0],
    ).toMatchObject({ currentValue: "high" });
  });

  it("preserves advertised choices without applying retired prompt-injection rules", () => {
    const [copied] = descriptorsFromCapabilities({
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "high", label: "High", isDefault: true },
            { id: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        },
      ],
    });
    expect(copied!.choices.map((choice) => choice.id)).toEqual(["high", "ultrathink"]);
  });

  it.each([true, false, undefined])(
    "preserves boolean values through copy and edit: %s",
    (currentValue) => {
      const capabilities: ModelCapabilities = {
        optionDescriptors: [
          {
            id: "thinking",
            label: "Thinking",
            type: "boolean",
            ...(currentValue !== undefined ? { currentValue } : {}),
          },
        ],
      };
      const copied = definitionFromDraft(
        draft({
          descriptors: descriptorsFromCapabilities(capabilities),
        }),
      );
      expect(copied.capabilities).toEqual(capabilities);
      const reopened = draftFromDefinition(copied);
      expect(definitionFromDraft({ ...reopened, name: "Renamed" }).capabilities).toEqual(
        capabilities,
      );
    },
  );

  it("preserves advertised context choices through copy and edit", () => {
    const capabilities: ModelCapabilities = {
      optionDescriptors: [
        {
          id: "contextWindow",
          label: "Context",
          type: "select",
          options: [{ id: "1m", label: "1M", isDefault: true }],
        },
        { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
      ],
    };
    const copied = definitionFromDraft(
      draft({ descriptors: descriptorsFromCapabilities(capabilities) }),
    );
    expect(copied.capabilities?.optionDescriptors).toEqual(capabilities.optionDescriptors);
    const authored = { slug: "custom", name: "Custom", capabilities };
    expect(
      definitionFromDraft(draftFromDefinition(authored)).capabilities?.optionDescriptors?.[0],
    ).toMatchObject(capabilities.optionDescriptors![0]!);
  });

  it("preserves choice descriptions when copying, renaming, and saving", () => {
    const capabilities: ModelCapabilities = {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          description: "Choose a reasoning level.",
          type: "select",
          options: [
            { id: "high", label: "High", isDefault: true },
            { id: "ultracode", label: "Ultracode", description: "Uses additional reasoning." },
          ],
        },
      ],
    };
    const copied = definitionFromDraft(
      draft({
        descriptors: descriptorsFromCapabilities(capabilities),
      }),
    );
    const reopened = draftFromDefinition(copied);
    const saved = definitionFromDraft({ ...reopened, name: "Renamed" });
    expect(saved.capabilities?.optionDescriptors?.[0]).toMatchObject(
      capabilities.optionDescriptors![0]!,
    );
    expect(copied.capabilities?.optionDescriptors?.[0]).toMatchObject(
      capabilities.optionDescriptors![0]!,
    );
  });

  it("collapses a blank name and no options back to a bare definition", () => {
    expect(definitionFromDraft(draft({ name: "  " }))).toEqual({
      slug: "my-model",
      name: "my-model",
      capabilities: null,
    });
    expect(draftFromDefinition({ slug: "x", name: "x", capabilities: null }).name).toBe("");
  });

  it("rejects duplicate ids, blank ids, and selects without choices", () => {
    const select = (id: string, choices: Array<{ id: string }>) => ({
      key: id,
      type: "select" as const,
      id,
      label: "Label",
      choices: choices.map((choice) => ({
        key: choice.id,
        label: "",
        isDefault: false,
        ...choice,
      })),
    });

    expect(validateDraft(draft({ descriptors: [select("", [{ id: "a" }])] }))).toBe(
      "Option 1 needs an id.",
    );
    expect(
      validateDraft(
        draft({ descriptors: [select("effort", [{ id: "a" }]), select("effort", [{ id: "b" }])] }),
      ),
    ).toBe('Option 2: id "effort" is used twice.');
    expect(validateDraft(draft({ descriptors: [select("effort", [])] }))).toBe(
      "Option 1 needs at least one choice.",
    );
    expect(
      validateDraft(draft({ descriptors: [select("effort", [{ id: "a" }, { id: "a" }])] })),
    ).toBe('Option 1: choice "a" is used twice.');
    expect(validateDraft(draft({ descriptors: [select("effort", [{ id: "a" }])] }))).toBeNull();
  });
});
