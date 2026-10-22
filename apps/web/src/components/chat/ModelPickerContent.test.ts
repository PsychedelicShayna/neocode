import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  adjacentModelPickerProvider,
  shouldIncludeModelPickerOption,
  shouldOfferModelPickerSetup,
} from "./ModelPickerContent";

function entry(status: ServerProvider["status"], driver = "neopi", instanceId = `${driver}_work`) {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      version: null,
      status,
      auth: { status: "authenticated" },
      checkedAt: "2026-08-28T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ])[0]!;
}

describe("shouldIncludeModelPickerOption", () => {
  it.each(["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"])(
    "never offers a retired %s catalog even when its cached status is ready",
    (driver) => {
      const providerEntry = entry("ready", driver);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: { slug: "saved-model", name: "Saved model", isUnavailable: true },
          activeInstanceId: providerEntry.instanceId,
          activeModel: "saved-model",
        }),
      ).toBe(false);
    },
  );

  it("keeps only the active unavailable native model during a catalog failure", () => {
    const providerEntry = entry("warning");
    const input = {
      entry: providerEntry,
      activeInstanceId: providerEntry.instanceId,
      activeModel: "openai-codex/saved-model",
    };
    expect(
      shouldIncludeModelPickerOption({
        ...input,
        option: { slug: input.activeModel, name: "Saved model", isUnavailable: true },
      }),
    ).toBe(true);
    expect(
      shouldIncludeModelPickerOption({
        ...input,
        option: { slug: "anthropic/other-model", name: "Other model", isUnavailable: true },
      }),
    ).toBe(false);
    expect(
      shouldIncludeModelPickerOption({
        ...input,
        activeInstanceId: ProviderInstanceId.make("neopi_personal"),
        option: { slug: input.activeModel, name: "Saved model", isUnavailable: true },
      }),
    ).toBe(false);
  });
});

describe("shouldOfferModelPickerSetup", () => {
  const availableModel = { slug: "gemini-3.1-pro", name: "Gemini 3.1 Pro" };

  it("offers runtime setup before NeoPi has models", () => {
    expect(shouldOfferModelPickerSetup(entry("error"), [])).toBe(true);
  });

  it("offers setup after sign-out even if a model remains cached", () => {
    const providerEntry = entry("ready");
    expect(
      shouldOfferModelPickerSetup(
        {
          ...providerEntry,
          snapshot: { ...providerEntry.snapshot, auth: { status: "unauthenticated" } },
        },
        [availableModel],
      ),
    ).toBe(true);
  });

  it("offers setup when the only model is an unavailable saved selection", () => {
    expect(
      shouldOfferModelPickerSetup(entry("ready"), [
        { ...availableModel, isUnavailable: true },
      ]),
    ).toBe(true);
  });

  it("does not offer setup for a ready account with available models", () => {
    expect(shouldOfferModelPickerSetup(entry("ready"), [availableModel])).toBe(
      false,
    );
  });

  it("does not restore a disabled provider while its status snapshot is stale", () => {
    expect(
      shouldOfferModelPickerSetup({ ...entry("error"), enabled: false }, []),
    ).toBe(false);
  });

  it("keeps providers without integrated setup on their existing path", () => {
    expect(shouldOfferModelPickerSetup(entry("error", "codex"), [])).toBe(false);
  });

  it("does not offer retired runtime setup from cached capabilities", () => {
    const providerEntry = entry("error", "custom_driver");
    expect(
      shouldOfferModelPickerSetup(
        {
          ...providerEntry,
          snapshot: {
            ...providerEntry.snapshot,
            setup: { canAuthenticate: true, canInstall: false },
          },
        },
        [],
      ),
    ).toBe(false);
  });
});

describe("adjacentModelPickerProvider", () => {
  const codex = entry("ready", "neopi", "neopi_work");
  const claude = entry("ready", "neopi", "neopi_personal");
  const unavailable = entry("error", "neopi", "neopi_unavailable");
  const input = {
    entries: [codex, unavailable, claude],
    disabledInstanceIds: undefined,
    selectableUnavailableInstanceIds: undefined,
  };

  it("wraps through favorites and ready instances, skipping unavailable providers", () => {
    expect(
      adjacentModelPickerProvider({ ...input, selectedInstanceId: codex.instanceId, direction: 1 }),
    ).toBe(claude.instanceId);
    expect(
      adjacentModelPickerProvider({ ...input, selectedInstanceId: "favorites", direction: -1 }),
    ).toBe(claude.instanceId);
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectedInstanceId: claude.instanceId,
        direction: 1,
      }),
    ).toBe("favorites");
  });

  it("keeps thread locks and the selected unavailable catalog", () => {
    expect(
      adjacentModelPickerProvider({
        ...input,
        disabledInstanceIds: new Set([claude.instanceId]),
        selectedInstanceId: codex.instanceId,
        direction: 1,
      }),
    ).toBe("favorites");
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectableUnavailableInstanceIds: new Set([unavailable.instanceId]),
        selectedInstanceId: codex.instanceId,
        direction: 1,
      }),
    ).toBe(unavailable.instanceId);
  });

  it("handles an empty catalog and a removed selection in either direction", () => {
    expect(
      adjacentModelPickerProvider({
        ...input,
        entries: [],
        selectedInstanceId: codex.instanceId,
        direction: -1,
      }),
    ).toBe("favorites");
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectedInstanceId: unavailable.instanceId,
        direction: 1,
      }),
    ).toBe("favorites");
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectedInstanceId: unavailable.instanceId,
        direction: -1,
      }),
    ).toBe(claude.instanceId);
  });
});
