import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";

vi.mock(import("./useNeoPiModelSelector"), async () => {
  const { ProviderInstanceId } = await import("@t3tools/contracts");
  const items = ["Original", "Target"].map((name) => ({
    selector: name.toLowerCase(),
    provider: "original",
    id: name.toLowerCase(),
    name: `${name} model`,
    resolvedSelector: name.toLowerCase(),
    facts: {
      intelligence: null,
      ttftMs: null,
      tokensPerSecond: null,
      contextWindow: null,
      effectiveContextWindow: null,
      inputCostPerMillion: null,
      outputCostPerMillion: null,
      performanceSource: null,
      serviceTier: null,
    },
  }));
  const snapshot = (rows: typeof items) => ({
    results: new Map([[ProviderInstanceId.make("neopi"), { items: rows, roles: [], error: null }]]),
    errors: [],
    pending: false,
    hasResponse: true,
    scopeKey: "native-picker-composition",
  });
  const answers = new Map([
    ["", snapshot(items)],
    ["target", snapshot([items[1]!])],
  ]);
  const empty = snapshot([]);
  return {
    useNeoPiModelSelector: (_context: unknown, _entries: unknown, query: string) =>
      answers.get(query.toLowerCase()) ?? empty,
  };
});

const instanceId = ProviderInstanceId.make("neopi");

function Picker({ keybindings = [] }: { keybindings?: ResolvedKeybindingsConfig }) {
  const [model, setModel] = useState("original");
  return (
    <>
      <output aria-label="Selected model">{model}</output>
      <ProviderModelPicker
        environmentId={null}
        selectorContext={{ environmentId: null }}
        activeInstanceId={instanceId}
        model={model}
        lockedProvider={null}
        instanceEntries={deriveProviderInstanceEntries([
          {
            instanceId,
            driver: ProviderDriverKind.make("neopi"),
            enabled: true,
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ])}
        keybindings={keybindings}
        modelOptionsByInstance={
          new Map([
            [
              instanceId,
              [
                { slug: "original", name: "Original model" },
                { slug: "target", name: "Target model" },
              ],
            ],
          ])
        }
        triggerAriaLabel="Choose model"
        onInstanceModelChange={(_, selected) => setModel(selected)}
      />
    </>
  );
}

it("keeps composition keys out of model selection and dismissal", async () => {
  await using screen = await render(<Picker />);
  await page.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByRole("combobox");
  await search.fill("Target");
  await expect.element(page.getByRole("option", { name: /Target model/ })).toBeVisible();

  for (const nativeEvent of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const key of ["Enter", "Escape"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        ...nativeEvent,
        bubbles: true,
        cancelable: true,
      });
      await act(() => search.element().dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      await expect.element(search).toBeVisible();
      await expect
        .element(screen.getByRole("status", { name: "Selected model" }))
        .toHaveTextContent("original");
    }
  }

  await userEvent.keyboard("{Enter}");
  await expect.element(search).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("status", { name: "Selected model" }))
    .toHaveTextContent("target");
  await page.getByRole("button", { name: "Choose model" }).click();
  await expect.element(search).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
});

it("keeps composing keys from triggering model jump shortcuts", async () => {
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "enter", command: "modelPicker.jump.1", when: "modelPickerOpen" },
  ]);
  await using screen = await render(<Picker keybindings={keybindings} />);
  await page.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByRole("combobox");
  await search.fill("Target");
  await expect.element(page.getByRole("option", { name: /Target model/ })).toBeVisible();

  for (const nativeEvent of [{ isComposing: true }, { keyCode: 229 }]) {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      ...nativeEvent,
      bubbles: true,
      cancelable: true,
    });
    await act(() => search.element().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    await expect.element(search).toBeVisible();
    await expect
      .element(screen.getByRole("status", { name: "Selected model" }))
      .toHaveTextContent("original");
  }
});
