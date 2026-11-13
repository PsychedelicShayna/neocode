import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";

vi.mock(import("./useNeoPiModelSelector"), async () => {
  const { ProviderInstanceId } = await import("@t3tools/contracts");
  const items = ["Original", "Second", "Plain"].map((name) => ({
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
    scopeKey: "native-picker-focus",
  });
  const all = snapshot(items);
  const empty = snapshot([]);
  return {
    useNeoPiModelSelector: (_context: unknown, _entries: unknown, query: string) =>
      query === "" ? all : empty,
  };
});

it("keeps a docked picker open after a pick and hands focus to that model's effort", async () => {
  const instanceId = ProviderInstanceId.make("neopi");
  const entries = deriveProviderInstanceEntries([
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
  ]);
  const options = new Map([
    [
      instanceId,
      [
        { slug: "original", name: "Original model" },
        { slug: "second", name: "Second model" },
        { slug: "plain", name: "Plain model" },
      ],
    ],
  ]);
  // The last level is the selected one; "plain" has no effort to pick.
  const levels: Record<string, ReadonlyArray<string>> = {
    original: ["Low", "High"],
    second: ["Medium"],
    plain: [],
  };

  function Picker() {
    const [model, setModel] = useState("original");
    return (
      <ProviderModelPicker
        environmentId={null}
        selectorContext={{ environmentId: null }}
        activeInstanceId={instanceId}
        model={model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        triggerAriaLabel="Choose model"
        onInstanceModelChange={(_, selected) => setModel(selected)}
        effortColumn={(levels[model] ?? []).map((level, index, all) => (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={index === all.length - 1}
            data-effort-row
            data-effort-level
          >
            {level}
          </button>
        ))}
      />
    );
  }

  await using screen = await render(<Picker />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByRole("combobox");
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("radio", { name: "High" })).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(search).toHaveFocus();

  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();

  await page.getByRole("option", { name: /Plain model/ }).click();
  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
});
