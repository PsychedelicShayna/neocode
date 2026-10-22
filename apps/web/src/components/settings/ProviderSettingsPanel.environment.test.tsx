import type { ReactElement } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  providers: null as ReadonlyArray<ServerProvider> | null,
  providersAtom: Symbol("providers"),
  refreshProviders: Symbol("refreshProviders"),
}));

const commands = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

const settingsState = vi.hoisted(() => ({
  value: null as UnifiedSettings | null,
  updateSettings: vi.fn(),
  updateClientSettings: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("./SettingsScopeSentence", () => ({ SettingsScopeSentence: () => null }));
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => atoms.providers,
}));

vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => atoms.providersAtom,
    refreshProviders: atoms.refreshProviders,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => commands.refresh,
}));

vi.mock("../../hooks/useSettings", () => ({
  useUpdateClientSettings: () => settingsState.updateClientSettings,
  useEnvironmentSettings: () => settingsState.value,
  useUpdateEnvironmentSettings: () => settingsState.updateSettings,
}));

vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));

vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: null, hasError: false, isPending: true }),
}));

import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";

const environmentId = EnvironmentId.make("remote-device");
const neopiId = ProviderInstanceId.make("neopi");
const customId = ProviderInstanceId.make("neopi_work");

function provider(): ServerProvider {
  return {
    instanceId: neopiId,
    driver: ProviderDriverKind.make("neopi"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-24T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

function renderPanel(options?: {
  readonly readOnly?: boolean;
  readonly targetInstanceId?: ProviderInstanceId;
  readonly neoCore?: boolean;
}): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return EnvironmentProviderSettings({
    environmentId,
    environmentLabel: "Remote device",
    ...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options?.targetInstanceId === undefined
      ? {}
      : { targetInstanceId: options.targetInstanceId }),
    ...(options?.neoCore === undefined ? {} : { neoCore: options.neoCore }),
  }) as ReactElement<Record<string, unknown>>;
}

function isRefreshButton(element: ReactElement<Record<string, unknown>>): boolean {
  const children = element.props.children;
  return (
    Array.isArray(children) &&
    children.some(
      (child) =>
        typeof child === "object" &&
        child !== null &&
        (child as ReactElement<Record<string, unknown>>).props?.className === "sr-only" &&
        (child as ReactElement<Record<string, unknown>>).props?.children ===
          "Refresh provider status",
    )
  );
}

function isAddProviderButton(element: ReactElement<Record<string, unknown>>): boolean {
  return element.props["aria-label"] === "Add provider";
}

describe("EnvironmentProviderSettings routing", () => {
  beforeEach(() => {
    hooks.reset();
    atoms.providers = null;
    settingsState.value = DEFAULT_UNIFIED_SETTINGS;
    settingsState.updateSettings.mockReset();
    settingsState.updateClientSettings.mockReset();
    commands.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
  });

  it("opens the requested provider instance instead of the first provider", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: { driver: ProviderDriverKind.make("neopi"), enabled: true },
      },
    };
    atoms.providers = [provider()];
    const panel = renderPanel({ targetInstanceId: customId });
    const editor = visitElements(panel, (element) => element.props.mode === "editor");
    expect(editor?.props.instanceId).toBe(customId);
  });

  it("keeps every NeoPi profile selectable without writing settings on navigation", () => {
    const firstId = ProviderInstanceId.make("neopi_personal");
    const secondId = ProviderInstanceId.make("neopi_work");
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [firstId]: { driver: ProviderDriverKind.make("neopi"), enabled: true },
        [secondId]: {
          driver: ProviderDriverKind.make("neopi"),
          enabled: false,
          config: { binaryPath: "/opt/work/npi", profile: "work", launchArgs: "--no-extensions" },
          environment: [{ name: "API_KEY", value: "", sensitive: true, valueRedacted: true }],
        },
        [customId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
    };
    let panel = renderPanel({ neoCore: true, targetInstanceId: firstId });
    expect(visitElements(panel, (element) => element.props.instanceId === customId)).toBeNull();
    const workRow = visitElements(
      panel,
      (element) => element.props.instanceId === secondId && element.props.mode === "list",
    );
    (workRow?.props.onSelect as () => void)();
    panel = renderPanel({ neoCore: true, targetInstanceId: firstId });
    const editor = visitElements(panel, (element) => element.props.mode === "editor");
    expect(editor?.props.instanceId).toBe(secondId);
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
    expect(commands.refresh).not.toHaveBeenCalled();

    const instance = settingsState.value.providerInstances![secondId]!;
    (editor?.props.onUpdate as (next: typeof instance) => void)({ ...instance, enabled: true });
    expect(settingsState.updateSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        providerInstances: expect.objectContaining({
          [secondId]: { ...instance, enabled: true },
          [firstId]: settingsState.value.providerInstances![firstId],
          [customId]: settingsState.value.providerInstances![customId],
        }),
      }),
    );
  });

  it("normalizes one account's favorites without erasing another account's choices", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: { driver: ProviderDriverKind.make("neopi"), enabled: true },
      },
      favorites: [
        { provider: neopiId, model: "other-account" },
        { provider: customId, model: "old-favorite" },
      ],
    };
    const panel = renderPanel({ targetInstanceId: customId });
    const editor = visitElements(panel, (element) => element.props.mode === "editor");
    const changeFavorites = editor?.props.onFavoriteModelsChange as (models: string[]) => void;

    changeFavorites([" chosen ", "", "chosen", "  "]);
    expect(settingsState.updateClientSettings).toHaveBeenLastCalledWith({
      favorites: [
        { provider: neopiId, model: "other-account" },
        { provider: customId, model: "chosen" },
      ],
    });
    changeFavorites([]);
    expect(settingsState.updateClientSettings).toHaveBeenLastCalledWith({
      favorites: [{ provider: neopiId, model: "other-account" }],
    });
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("preserves other accounts and drops an empty model-preference override", () => {
    const otherPreferences = { hiddenModels: ["other-hidden"], modelOrder: ["other-model"] };
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: { driver: ProviderDriverKind.make("neopi"), enabled: true },
      },
      providerModelPreferences: {
        [neopiId]: otherPreferences,
        [customId]: { hiddenModels: [], modelOrder: ["old-order"] },
      },
    };
    const panel = renderPanel({ targetInstanceId: customId });
    const editor = visitElements(panel, (element) => element.props.mode === "editor");
    const changeHidden = editor?.props.onHiddenModelsChange as (models: string[]) => void;
    const changeOrder = editor?.props.onModelOrderChange as (models: string[]) => void;

    changeHidden(["hidden", "", "hidden", " "]);
    expect(settingsState.updateClientSettings).toHaveBeenLastCalledWith({
      providerModelPreferences: {
        [neopiId]: otherPreferences,
        [customId]: { hiddenModels: ["hidden"], modelOrder: ["old-order"] },
      },
    });
    changeOrder(["ordered", "", "ordered", " "]);
    expect(settingsState.updateClientSettings).toHaveBeenLastCalledWith({
      providerModelPreferences: {
        [neopiId]: otherPreferences,
        [customId]: { hiddenModels: [], modelOrder: ["ordered"] },
      },
    });
    changeOrder([]);
    expect(settingsState.updateClientSettings).toHaveBeenLastCalledWith({
      providerModelPreferences: { [neopiId]: otherPreferences },
    });
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("does not substitute another account when the requested instance was removed", () => {
    atoms.providers = [provider()];
    const panel = renderPanel({ targetInstanceId: customId });
    expect(visitElements(panel, (element) => element.props.mode === "editor")).toBeNull();
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("keeps provider selection available while write controls are read only", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("neopi"),
          enabled: true,
        },
      },
    };
    atoms.providers = [provider()];
    let panel = renderPanel({ readOnly: true });

    const inertWrapper = visitElements(panel, (element) => element.props.inert === true);
    expect(inertWrapper).not.toBeNull();

    const customRow = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "list",
    );
    expect(customRow?.props.readOnly).toBe(true);
    expect(customRow?.props.onSelect).toBeTypeOf("function");
    (customRow?.props.onSelect as (() => void) | undefined)?.();

    panel = renderPanel({ readOnly: true });
    const customEditor = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "editor",
    );
    expect(customEditor).not.toBeNull();

    expect(visitElements(panel, isRefreshButton)).toBeNull();
    expect(visitElements(panel, isAddProviderButton)).toBeNull();
  });

  it("deletes and resets provider configuration without erasing shared preferences", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [neopiId]: {
          driver: ProviderDriverKind.make("neopi"),
          enabled: false,
        },
        [customId]: {
          driver: ProviderDriverKind.make("neopi"),
          enabled: true,
        },
      },
      providerModelPreferences: {
        [customId]: { hiddenModels: ["hidden"], modelOrder: ["model"] },
      },
      favorites: [{ provider: customId, model: "favorite" }],
    };
    let panel = renderPanel();
    const customRow = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "list",
    );
    (customRow?.props.onSelect as (() => void) | undefined)?.();
    panel = renderPanel();
    const customCard = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "editor",
    );
    expect(customCard).not.toBeNull();
    (customCard?.props.onDelete as (() => void) | undefined)?.();

    expect(settingsState.updateSettings).toHaveBeenLastCalledWith({
      providerInstances: {
        [neopiId]: settingsState.value.providerInstances?.[neopiId],
      },
    });

    settingsState.updateSettings.mockClear();
    const defaultRow = visitElements(
      panel,
      (element) => element.props.instanceId === neopiId && element.props.mode === "list",
    );
    (defaultRow?.props.onSelect as (() => void) | undefined)?.();
    panel = renderPanel();
    const defaultCard = visitElements(
      panel,
      (element) => element.props.instanceId === neopiId && element.props.mode === "editor",
    );
    const resetAction = defaultCard?.props.headerAction;
    const resetButton = visitElements(
      resetAction,
      (element) => typeof element.props.onClick === "function",
    );
    expect(resetButton).not.toBeNull();
    (resetButton?.props.onClick as (() => void) | undefined)?.();

    const resetPatch = settingsState.updateSettings.mock.lastCall?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(Object.keys(resetPatch ?? {}).sort()).toEqual(["providerInstances", "providers"]);
    expect(resetPatch).not.toHaveProperty("favorites");
    expect(resetPatch).not.toHaveProperty("providerModelPreferences");
  });
});
