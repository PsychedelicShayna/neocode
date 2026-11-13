import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { AsyncResult, type Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  providers: null as unknown as Atom.Writable<ReadonlyArray<ServerProvider>>,
  settings: null as unknown as UnifiedSettings,
  canManageProviders: true,
  canWriteSettings: true,
  searchTargetId: null as string | null,
  refresh: vi.fn(),
  updateSettings: vi.fn(),
  updateModelPreferences: vi.fn(),
  toggleFavorite: vi.fn(),
  mutateProviderInstance: vi.fn(),
  confirm: vi.fn<() => Promise<boolean>>(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const providers = Atom.make<ReadonlyArray<ServerProvider>>([]).pipe(Atom.keepAlive);
  state.providers = providers;
  const config = Atom.make(null);
  const refreshProviders = { ...actual.serverEnvironment.refreshProviders, label: "refresh" };
  return {
    ...actual,
    providersIgnoringCheckedAtAtom: (() => providers) as never,
    serverEnvironment: {
      ...actual.serverEnvironment,
      refreshProviders,
      configValueAtom: (() => config) as never,
      providersValueAtom: (() => providers) as never,
    } as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label?: string }) =>
    command.label === "refresh" ? state.refresh : vi.fn()) as never,
}));
vi.mock(import("~/localApi"), async (original) => {
  const api = { dialogs: { confirm: state.confirm } };
  return {
    ...(await original()),
    readLocalApi: (() => api) as never,
    ensureLocalApi: (() => api) as never,
  };
});
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => state.settings) as never,
  useUpdateEnvironmentSettings: (() => state.updateSettings) as never,
  useUpdateEnvironmentModelPreferences: (() => state.updateModelPreferences) as never,
  useToggleEnvironmentModelFavorite: (() => state.toggleFavorite) as never,
  usePersistEnvironmentProviderInstanceMutation: (() => state.mutateProviderInstance) as never,
}));
vi.mock(import("../../state/session"), async (original) => {
  const scope = (environmentId: string, requested: string) =>
    environmentId === "remote-device" &&
    (requested === "providers:manage"
      ? state.canManageProviders
      : requested === "settings:write"
        ? state.canWriteSettings
        : requested === "orchestration:read");
  return {
    ...(await original()),
    useEnvironmentScope: scope as never,
    readEnvironmentScope: scope as never,
  };
});
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  useSettingsSearchTargetId: () => state.searchTargetId,
  SettingsRow: (({
    id,
    title,
    description,
    status,
    control,
    children,
  }: {
    id?: string;
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div id={id}>
      <h4>{title}</h4>
      {description}
      {status}
      {control}
      {children}
    </div>
  )) as never,
}));
vi.mock(import("./UsageProviderSettings"), async (original) => ({
  ...(await original()),
  UsageProviderSettings: (() => null) as never,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
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
    models: [{ slug: "chosen", name: "Chosen", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  };
}

const setProviders = (providers: ReadonlyArray<ServerProvider>) =>
  act(async () => appAtomRegistry.set(state.providers, providers));

function panel(options?: {
  readonly readOnly?: boolean;
  readonly targetInstanceId?: ProviderInstanceId;
  readonly neoCore?: boolean;
}) {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <div className="@container/providers">
        <EnvironmentProviderSettings
          environmentId={environmentId}
          environmentLabel="Remote device"
          neoCore={options?.neoCore}
          {...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly })}
          {...(options?.targetInstanceId === undefined
            ? {}
            : { targetInstanceId: options.targetInstanceId })}
        />
      </div>
    </RegistryContext.Provider>
  );
}

async function setup() {
  await page.viewport(1280, 900);
  state.settings = DEFAULT_UNIFIED_SETTINGS;
  state.canManageProviders = true;
  state.canWriteSettings = true;
  state.searchTargetId = null;
  state.updateSettings.mockReset();
  state.updateModelPreferences.mockReset();
  state.toggleFavorite.mockReset();
  state.mutateProviderInstance.mockReset().mockResolvedValue(AsyncResult.success({}));
  state.confirm.mockReset().mockResolvedValue(false);
  state.refresh.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  await setProviders([]);
}

describe("EnvironmentProviderSettings routing", () => {
  it("does not substitute another account when the requested instance was removed", async () => {
    await setup();
    await setProviders([provider()]);
    await using _screen = await render(panel({ targetInstanceId: customId }));
    await expect
      .element(page.getByText("This provider instance is no longer available on this device."))
      .toBeVisible();
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("updates one provider instance without sending a stale whole map", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("neopi"),
          enabled: true,
          displayName: "Work",
        },
      },
    };
    await using _screen = await render(panel({ neoCore: true }));
    await userEvent.click(page.getByRole("switch", { name: "Enable Work" }).first());

    expect(state.mutateProviderInstance).toHaveBeenCalledWith(
      {
        operation: "upsert",
        instanceId: customId,
        instance: { driver: ProviderDriverKind.make("neopi"), enabled: false, displayName: "Work" },
      },
      {},
    );
  });
});

describe("EnvironmentProviderSettings instance removal", () => {
  it("resets a configured default instance only once the user confirms", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [neopiId]: {
          driver: ProviderDriverKind.make("neopi"),
          enabled: true,
          config: { binaryPath: "/opt/neopi/bin/npi" },
        },
      },
    };
    await setProviders([provider()]);
    await using _screen = await render(panel({ targetInstanceId: neopiId, neoCore: true }));
    const reset = page.getByRole("button", { name: "Reset NeoPi provider settings to default" });
    await userEvent.click(reset);

    expect(state.mutateProviderInstance).not.toHaveBeenCalled();
    expect(state.confirm).toHaveBeenCalledOnce();

    state.confirm.mockResolvedValue(true);
    await userEvent.click(reset);
    await vi.waitFor(() =>
      expect(state.mutateProviderInstance).toHaveBeenCalledWith({
        operation: "remove",
        instanceId: neopiId,
      }),
    );
  });

  it("deletes a custom instance only once the user confirms", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: { driver: ProviderDriverKind.make("neopi"), enabled: true },
      },
    };
    await using _screen = await render(panel({ targetInstanceId: customId }));
    const remove = page.getByRole("button", { name: `Delete instance ${customId}` });
    await userEvent.click(remove);

    expect(state.mutateProviderInstance).not.toHaveBeenCalled();
    expect(state.confirm).toHaveBeenCalledOnce();

    state.confirm.mockResolvedValue(true);
    await userEvent.click(remove);
    await vi.waitFor(() =>
      expect(state.mutateProviderInstance).toHaveBeenCalledWith({
        operation: "remove",
        instanceId: customId,
      }),
    );
  });
});

describe("EnvironmentProviderSettings health check interval", () => {
  it("commits interval drafts and allows retrying rejected edits", async () => {
    await setup();
    await using _screen = await render(panel());
    const input = page.getByRole("textbox", { name: "Provider health check interval in seconds" });

    await userEvent.type(input, "{ArrowUp}{ArrowDown}");
    expect(
      state.updateSettings.mock.calls.map(([patch]) =>
        Duration.toSeconds(patch.backgroundActivity.overrides.providerHealthRefreshInterval),
      ),
    ).toEqual([330, 300]);
    state.updateSettings.mockClear();

    // Replacing 300 with 120 passes through 30, 3, an empty field, 1 and 12.
    await userEvent.type(input, "{Backspace}{Backspace}{Backspace}120");
    await expect.element(input).toHaveValue("120");
    expect(state.updateSettings).not.toHaveBeenCalled();

    await userEvent.tab();
    expect(
      state.updateSettings.mock.calls.map(([patch]) =>
        Duration.toSeconds(patch.backgroundActivity.overrides.providerHealthRefreshInterval),
      ),
    ).toEqual([120]);

    await act(() => state.updateSettings.mock.calls.at(-1)?.[1]?.onFailed?.());
    await expect.element(input).toHaveValue("300");
    await userEvent.type(input, "{Backspace}{Backspace}{Backspace}120");
    await userEvent.tab();
    expect(
      state.updateSettings.mock.calls.map(([patch]) =>
        Duration.toSeconds(patch.backgroundActivity.overrides.providerHealthRefreshInterval),
      ),
    ).toEqual([120, 120]);

    const rejectPrevious = state.updateSettings.mock.calls.at(-1)?.[1]?.onFailed;
    await userEvent.type(input, "{ArrowUp}");
    await act(() => rejectPrevious?.());
    await expect.element(input).toHaveValue("150");
  });

  it("restores the saved interval when a cleared field loses focus", async () => {
    await setup();
    await using _screen = await render(panel());
    const input = page.getByRole("textbox", { name: "Provider health check interval in seconds" });

    await userEvent.type(input, "{Backspace}{Backspace}{Backspace}");
    await userEvent.tab();

    await expect.element(input).toHaveValue("300");
    expect(state.updateSettings).not.toHaveBeenCalled();
  });
});
