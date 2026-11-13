import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type {
  EnvironmentId,
  NeoPiEffortRule,
  NeoPiEffortSelection,
  NeoPiModelsConfiguration,
  NeoPiModelsAuthState,
  NeoPiModelsTarget,
  NeoPiModelsUpdate,
  ProviderInstanceId,
  ProjectId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { formatNeoPiModelTokenLimit } from "@t3tools/client-runtime/neopi-models";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import * as Linking from "expo-linking";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { FlatList, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useProjects, useServerConfigs } from "../../state/entities";
import { neopiModels } from "../../state/neopiModels";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { NativeChoice, NativeError, NativeField, NativeModal } from "./NativeNeoPiControls";
import { NeoPiModelsSelector } from "./NeoPiModelsSelector";

type Configuration = NeoPiModelsConfiguration;
type Role = Configuration["roles"][number];
type Scope = "global" | "project";
type Change = NeoPiModelsUpdate["change"];
export type NeoPiModelsScreenParams =
  | { environmentId?: EnvironmentId; target?: NeoPiModelsTarget }
  | undefined;
const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function NeoPiModelsEntry(props: {
  environmentId?: EnvironmentId;
  target?: NeoPiModelsTarget;
}) {
  const navigation = useNavigation();
  return <Button label="Models" tone="text" onPress={() => navigation.navigate("Models", props)} />;
}

export function NeoPiModelsScreen({ route }: StaticScreenProps<NeoPiModelsScreenParams>) {
  const { connectedEnvironments: environments } = useRemoteConnectionStatus();
  const configs = useServerConfigs();
  const projects = useProjects();
  const [selection, setSelection] = useState(() => ({
    environmentId: route.params?.environmentId ?? null,
    instanceId: route.params?.target?.providerInstanceId ?? null,
    projectId: route.params?.target?.projectId ?? null,
    sessionFile: route.params?.target?.sessionFile,
  }));
  const environmentId = selection.environmentId ?? environments[0]?.environmentId;
  const environment = environments.find((value) => value.environmentId === environmentId);
  const providers =
    (environmentId ? configs.get(environmentId)?.providers : [])?.filter(
      (provider) => provider.driver === "neopi" && provider.enabled,
    ) ?? [];
  const provider =
    selection.instanceId === null
      ? providers[0]
      : providers.find((provider) => provider.instanceId === selection.instanceId);
  const target: NeoPiModelsTarget | null = provider
    ? {
        providerInstanceId: provider.instanceId,
        ...(selection.projectId ? { projectId: selection.projectId } : {}),
        ...(selection.sessionFile ? { sessionFile: selection.sessionFile } : {}),
      }
    : null;
  return (
    <SettingsScreen title="Models">
      <View className="gap-3 px-4 py-3">
        <NativeChoice
          label="Environment"
          value={environmentId ?? ""}
          options={environments.map((value) => ({
            value: value.environmentId,
            label: value.environmentLabel,
          }))}
          onChange={(value) =>
            setSelection({
              environmentId: value as EnvironmentId,
              instanceId: null,
              projectId: null,
              sessionFile: undefined,
            })
          }
        />
        <NativeChoice
          label="NeoPi runtime"
          value={provider?.instanceId ?? ""}
          options={providers.map((value) => ({
            value: value.instanceId,
            label: value.displayName ?? value.instanceId,
          }))}
          onChange={(value) =>
            setSelection((previous) => ({
              ...previous,
              instanceId: value as ProviderInstanceId,
              sessionFile: undefined,
            }))
          }
        />
        <NativeChoice
          label="Project settings"
          value={selection.projectId ?? ""}
          options={[
            { value: "", label: "Server working directory" },
            ...projects
              .filter((value) => value.environmentId === environmentId)
              .map((value) => ({ value: value.id, label: value.title })),
          ]}
          onChange={(value) =>
            setSelection((previous) => ({
              ...previous,
              projectId: value ? (value as ProjectId) : null,
              sessionFile: undefined,
            }))
          }
        />
        <Text className="text-xs text-foreground-muted">
          {selection.sessionFile
            ? "Configuration from this session. Changing project or runtime leaves session-bound settings."
            : "NeoPi owns these settings. Native clients share changes; model and effort selection stay native."}
        </Text>
      </View>
      {!target || !environmentId ? (
        <NativeError message="No enabled NeoPi runtime is available for this environment." />
      ) : environment?.connectionState !== "connected" || !environment.isEnabled ? (
        <NativeError message="Reconnect the selected environment to manage native Models." />
      ) : (
        <ModelsSnapshot
          key={JSON.stringify([environmentId, target])}
          environmentId={environmentId}
          target={target}
        />
      )}
    </SettingsScreen>
  );
}

function ModelsSnapshot({
  environmentId,
  target,
}: {
  environmentId: EnvironmentId;
  target: NeoPiModelsTarget;
}) {
  const atom = neopiModels.changes({ environmentId, input: target });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  if (AsyncResult.isFailure(result))
    return (
      <View className="gap-3 p-4">
        <NativeError message={errorMessage(Cause.squash(result.cause))} />
        <Button label="Retry native connection" onPress={refresh} />
      </View>
    );
  if (!AsyncResult.isSuccess(result) || result.value === null)
    return (
      <Text className="p-4 text-foreground-muted">
        Reading native Models configuration… Reconnect this environment if it is disconnected.
      </Text>
    );
  return (
    <ModelsContent
      environmentId={environmentId}
      target={target}
      configuration={result.value}
      catalogReady={!result.waiting}
      refresh={refresh}
    />
  );
}

function EffortChoices({
  choices,
  selected,
  onChange,
  disabled = false,
}: {
  choices: ReadonlyArray<string>;
  selected: ReadonlyArray<string>;
  onChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {choices.map((choice) => (
        <Button
          key={choice}
          label={choice}
          tone={selected.includes(choice) ? "primary" : "secondary"}
          disabled={disabled}
          onPress={() =>
            onChange(
              selected.includes(choice)
                ? selected.filter((value) => value !== choice)
                : [...selected, choice],
            )
          }
        />
      ))}
    </View>
  );
}

function ModelsContent({
  environmentId,
  target,
  configuration,
  refresh,
  catalogReady,
}: {
  environmentId: EnvironmentId;
  target: NeoPiModelsTarget;
  configuration: Configuration;
  refresh: () => void;
  catalogReady: boolean;
}) {
  const update = useAtomCommand(neopiModels.update, { reportFailure: false });
  const [section, setSection] = useState("all");
  const [query, setQuery] = useState("");
  const [assignment, setAssignment] = useState<{ role: Role | null; selector: string } | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rulesRevision, setRulesRevision] = useState(0);
  const active = useRef(true);
  const inFlight = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Ignore native mutation replies after this scoped Models view unmounts.
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function save(change: Change) {
    if (inFlight.current) return false;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await update({ environmentId, input: { target, change } });
      if (!active.current) return false;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      refresh();
      return true;
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
      return false;
    } finally {
      inFlight.current = false;
      if (active.current) setPending(false);
    }
  }
  const provider = section.startsWith("provider:")
    ? configuration.providers.find((value) => value.id === section.slice(9))
    : null;
  const models = configuration.models.filter(
    (model) =>
      (!provider || model.provider === provider.id) &&
      `${model.provider}/${model.id} ${model.name}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const sectionChoices = [
    { value: "effort", label: "Effort rules" },
    { value: "all", label: "All models" },
    { value: "roles", label: "Roles" },
    ...[...configuration.providers]
      .sort((a, b) => Number(b.authenticated) - Number(a.authenticated) || a.id.localeCompare(b.id))
      .map((value) => ({
        value: `provider:${value.id}`,
        label: `${value.authenticated ? "●" : "○"} ${value.id} · ${
          value.id === "neoproxy"
            ? value.authenticated
              ? "Connected"
              : "Not connected"
            : value.authenticated
              ? "Signed in"
              : "Not signed in"
        }`,
      })),
  ];
  return (
    <View className="flex-1 gap-3">
      <View className="gap-3 px-4">
        <NativeChoice
          label="Native Models"
          value={section}
          options={sectionChoices}
          onChange={setSection}
        />
        <NativeError message={error} />
        <Button label="Refresh native state" disabled={pending} onPress={refresh} />
      </View>
      {assignment ? (
        <NativeModal title="Assign a native role" onClose={() => setAssignment(null)}>
          <ScrollView contentContainerClassName="gap-4 p-4">
            <RoleEditor
              configuration={configuration}
              initial={assignment}
              pending={pending}
              save={async (change) => {
                if (await save(change)) setAssignment(null);
              }}
              close={() => setAssignment(null)}
            />
          </ScrollView>
        </NativeModal>
      ) : null}
      {section === "effort" ? (
        <ScrollView contentContainerClassName="gap-4 p-4">
          <RulesEditor
            key={rulesRevision}
            configuration={configuration}
            pending={pending}
            save={async (change) => {
              if (await save(change)) setRulesRevision((value) => value + 1);
            }}
          />
        </ScrollView>
      ) : section === "roles" ? (
        <FlatList
          data={configuration.roles}
          keyExtractor={(role) => role.id}
          contentContainerClassName="gap-3 p-4"
          ListHeaderComponent={
            <View className="gap-3 pb-3">
              <NativeChoice
                label="Native role storage"
                value={configuration.roleStorage}
                options={[
                  { value: "global", label: "Global" },
                  { value: "project", label: "Project with global fallback" },
                ]}
                disabled={pending}
                onChange={(value) =>
                  void save({ operation: "storage", value, expected: configuration.roleStorage })
                }
              />
              <Button
                label="Create role"
                disabled={pending}
                onPress={() => setAssignment({ role: null, selector: "" })}
              />
            </View>
          }
          renderItem={({ item: role }) => (
            <View className="gap-2 border-b border-border-subtle pb-3">
              <Text className="font-t3-medium text-foreground">{role.alias}</Text>
              {role.description ? (
                <Text className="text-sm text-foreground-muted">{role.description}</Text>
              ) : null}
              <Text selectable className="text-sm text-foreground-muted">
                {role.configured ?? "Native automatic selection"}
                {"\n"}
                {role.provenance}
                {role.resolved
                  ? ` · ${role.resolved.provider}/${role.resolved.modelId} · ${role.resolved.thinkingLevel ?? "Native effort"}`
                  : " · Unresolved"}
              </Text>
              <Button
                label={`Configure ${role.alias}`}
                disabled={pending}
                onPress={() => setAssignment({ role, selector: role.configured ?? "" })}
              />
            </View>
          )}
        />
      ) : section.startsWith("provider:") && !provider ? (
        <NativeError message="This inference provider is no longer in the native catalog. Choose another provider." />
      ) : (
        <FlatList
          data={models}
          keyExtractor={(model) => `${model.provider}/${model.id}`}
          contentContainerClassName="gap-3 p-4"
          ListHeaderComponent={
            <View className="gap-4 pb-3">
              {provider ? (
                <ProviderAccounts
                  key={JSON.stringify([environmentId, target, provider.id])}
                  environmentId={environmentId}
                  target={target}
                  provider={provider}
                  hasAvailableCatalogModels={configuration.models.some(
                    (model) => model.provider === provider.id && model.available,
                  )}
                  catalogReady={catalogReady}
                  refresh={refresh}
                  pending={pending}
                  save={save}
                />
              ) : null}
              <NativeField label="Filter native models" value={query} onChange={setQuery} />
            </View>
          }
          ListEmptyComponent={
            <Text className="text-foreground-muted">No native models match this view.</Text>
          }
          renderItem={({ item: model }) => (
            <View className="gap-2 border-b border-border-subtle pb-3">
              <Text className="font-t3-medium text-foreground">{model.name}</Text>
              <Text selectable className="text-xs text-foreground-muted">
                {model.provider}/{model.id}
                {"\n"}
                {model.kind}
                {!model.available ? " · Not available" : ""}
                {model.supportsFastMode ? " · Native fast mode" : ""}
                {"\n"}Context effective/native: {model.effectiveContextWindow.toLocaleString()} /{" "}
                {formatNeoPiModelTokenLimit(model.contextWindow)} · Output{" "}
                {formatNeoPiModelTokenLimit(model.maxTokens)}
                {"\n"}Input/output per million: ${model.cost.input} / ${model.cost.output}
                {"\n"}Efforts: {model.permittedEfforts.join(", ") || "No controllable effort"}
              </Text>
              <Button
                label={`Assign role to ${model.name}`}
                disabled={pending}
                onPress={() =>
                  setAssignment({ role: null, selector: `${model.provider}/${model.id}` })
                }
              />
            </View>
          )}
        />
      )}
    </View>
  );
}

function RoleEditor({
  configuration,
  initial,
  pending,
  save,
  close,
}: {
  configuration: Configuration;
  initial: { role: Role | null; selector: string };
  pending: boolean;
  save: (change: Change) => Promise<void>;
  close: () => void;
}) {
  const [roleId, setRoleId] = useState(initial.role?.id ?? "");
  const [scope, setScope] = useState<Scope>("global");
  const [expected, setExpected] = useState(
    initial.role?.global ?? { selector: null, effort: null },
  );
  const [selector, setSelector] = useState(
    initial.role ? (initial.role.global.selector ?? "") : initial.selector,
  );
  const [mode, setMode] = useState<"selector" | "inherit" | "fixed" | "auto">(
    initial.role?.global.effort?.mode ?? "selector",
  );
  const [level, setLevel] = useState(
    initial.role?.global.effort?.mode === "fixed"
      ? initial.role.global.effort.level
      : (configuration.effortChoices[0] ?? "off"),
  );
  const [allowed, setAllowed] = useState<ReadonlyArray<string>>(
    initial.role?.global.effort?.mode === "auto"
      ? (initial.role.global.effort.allowed ?? configuration.effortChoices)
      : configuration.effortChoices,
  );
  const load = (id: string, nextScope: Scope) => {
    const value = configuration.roles.find((role) => role.id === id)?.[nextScope] ?? {
      selector: null,
      effort: null,
    };
    setRoleId(id);
    setScope(nextScope);
    setExpected(value);
    setSelector(initial.role ? (value.selector ?? "") : initial.selector || value.selector || "");
    setMode(value.effort?.mode ?? "selector");
    if (value.effort?.mode === "fixed") setLevel(value.effort.level);
    setAllowed(
      value.effort?.mode === "auto"
        ? (value.effort.allowed ?? configuration.effortChoices)
        : configuration.effortChoices,
    );
  };
  const effort: NeoPiEffortSelection | undefined =
    mode === "fixed"
      ? { mode: "fixed", level }
      : mode === "auto"
        ? { mode: "auto", allowed, selector }
        : mode === "inherit"
          ? { mode: "inherit" }
          : undefined;
  return (
    <View className="gap-4">
      <NativeChoice
        label="Native role"
        value={configuration.roles.some((role) => role.id === roleId) ? roleId : ""}
        options={[
          { value: "", label: "New role…" },
          ...configuration.roles.map((role) => ({ value: role.id, label: role.alias })),
        ]}
        disabled={pending}
        onChange={(value) => load(value, scope)}
      />
      {!configuration.roles.some((role) => role.id === roleId) ? (
        <NativeField
          label="New role name"
          value={roleId}
          disabled={pending}
          onChange={(value) => load(value, scope)}
        />
      ) : null}
      <NativeChoice
        label="Save scope"
        value={scope}
        options={[
          { value: "global", label: "Global" },
          ...(configuration.roleStorage === "project"
            ? [{ value: "project" as const, label: "Project" }]
            : []),
        ]}
        disabled={pending}
        onChange={(value) => load(roleId, value)}
      />
      <NeoPiModelsSelector
        configuration={configuration}
        label="Model or native selector"
        value={selector}
        disabled={pending}
        onChange={setSelector}
      />
      <Text className="text-xs text-foreground-muted">
        NeoPi validates and resolves this selector. Clearing this scope restores its inherited
        selection. Concurrent native edits are checked before saving.
      </Text>
      <NativeChoice
        label="Effort policy"
        value={mode}
        options={[
          { value: "selector", label: "From selector or native default" },
          { value: "inherit", label: "Inherit" },
          { value: "fixed", label: "Fixed" },
          { value: "auto", label: "Auto within allowed efforts" },
        ]}
        disabled={pending}
        onChange={setMode}
      />
      {mode === "fixed" ? (
        <NativeChoice
          label="Fixed effort"
          value={level}
          options={configuration.effortChoices.map((value) => ({ value, label: value }))}
          disabled={pending}
          onChange={setLevel}
        />
      ) : mode === "auto" ? (
        <EffortChoices
          choices={configuration.effortChoices}
          selected={allowed}
          onChange={setAllowed}
          disabled={pending}
        />
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Save role"
          disabled={
            pending || !roleId.trim() || !selector.trim() || (mode === "auto" && !allowed.length)
          }
          onPress={() =>
            void save({
              operation: "role",
              role: roleId,
              scope,
              selector,
              ...(effort ? { effort } : {}),
              expected,
            })
          }
        />
        <Button
          label="Clear this scope"
          disabled={pending || !roleId.trim()}
          onPress={() => void save({ operation: "role", role: roleId, scope, expected })}
        />
        <Button label="Cancel" tone="text" onPress={close} />
      </View>
    </View>
  );
}

function RulesEditor({
  configuration,
  pending,
  save,
}: {
  configuration: Configuration;
  pending: boolean;
  save: (change: Change) => Promise<void>;
}) {
  const [scope, setScope] = useState<Scope>("global");
  const [expected, setExpected] = useState(configuration.effortRuleScopes.global);
  const [draft, setDraft] = useState(() => {
    const rules = configuration.effortRuleScopes.global ?? [];
    return { rows: rules.map((rule, id) => ({ id, rule })), nextId: rules.length };
  });
  const rules = draft.rows.map(({ rule }) => rule);
  const replace = (index: number, rule: NeoPiEffortRule) =>
    setDraft((value) => ({
      ...value,
      rows: value.rows.map((row, at) => (at === index ? { ...row, rule } : row)),
    }));
  const move = (index: number, delta: number) =>
    setDraft((value) => {
      const rows = [...value.rows];
      [rows[index], rows[index + delta]] = [rows[index + delta]!, rows[index]!];
      return { ...value, rows };
    });
  return (
    <View className="gap-4">
      <Text className="text-sm text-foreground-muted">
        Native policy: {configuration.effortMode}. Effective rules from{" "}
        {configuration.effortRulesProvenance}. NeoPi owns selector precedence, matching and tie
        order.
      </Text>
      <NativeChoice
        label="Rule save scope"
        value={scope}
        options={[
          { value: "global", label: "Global" },
          { value: "project", label: "Project" },
        ]}
        disabled={pending}
        onChange={(value) => {
          setScope(value);
          setExpected(configuration.effortRuleScopes[value]);
          const rules = configuration.effortRuleScopes[value] ?? [];
          setDraft(({ nextId }) => ({
            rows: rules.map((rule, index) => ({ id: nextId + index, rule })),
            nextId: nextId + rules.length,
          }));
        }}
      />
      {draft.rows.map(({ id, rule }, index) => (
        <View key={id} className="gap-3 border-b border-border-subtle pb-4">
          <NativeField
            label={`Rule ${index + 1} selector`}
            value={rule.selector}
            disabled={pending}
            onChange={(selector) => replace(index, { ...rule, selector })}
          />
          <EffortChoices
            choices={configuration.effortChoices}
            selected={rule.allowed}
            disabled={pending}
            onChange={(allowed) => replace(index, { ...rule, allowed })}
          />
          <View className="flex-row flex-wrap gap-2">
            <Button
              label="Move up"
              disabled={pending || index === 0}
              onPress={() => move(index, -1)}
            />
            <Button
              label="Move down"
              disabled={pending || index === rules.length - 1}
              onPress={() => move(index, 1)}
            />
            <Button
              label="Remove rule"
              disabled={pending}
              onPress={() =>
                setDraft((value) => ({
                  ...value,
                  rows: value.rows.filter((row) => row.id !== id),
                }))
              }
            />
          </View>
        </View>
      ))}
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Add rule"
          disabled={pending}
          onPress={() =>
            setDraft((value) => ({
              rows: [
                ...value.rows,
                {
                  id: value.nextId,
                  rule: { selector: "", allowed: [...configuration.effortChoices] },
                },
              ],
              nextId: value.nextId + 1,
            }))
          }
        />
        <Button
          label="Save rules"
          disabled={pending || rules.some((rule) => !rule.selector.trim() || !rule.allowed.length)}
          onPress={() => void save({ operation: "rules", scope, rules, expected })}
        />
        <Button
          label="Clear this scope"
          disabled={pending}
          onPress={() => void save({ operation: "rules", scope, expected })}
        />
      </View>
    </View>
  );
}

function ProviderAccounts({
  environmentId,
  target,
  provider,
  hasAvailableCatalogModels,
  catalogReady,
  refresh,
  pending,
  save,
}: {
  environmentId: EnvironmentId;
  target: NeoPiModelsTarget;
  provider: Configuration["providers"][number];
  hasAvailableCatalogModels: boolean;
  catalogReady: boolean;
  refresh: () => void;
  pending: boolean;
  save: (change: Change) => Promise<boolean>;
}) {
  const isNeoProxy = provider.id === "neoproxy";
  const accountsQuery = useEnvironmentQuery(
    neopiModels.accountsQuery({ environmentId, input: { target, providerId: provider.id } }),
  );
  const accounts = accountsQuery.data?.accounts ?? [];
  const accountsReady = accountsQuery.isSuccess && !accountsQuery.isPending && !accountsQuery.error;
  const loadAccounts = accountsQuery.refresh;
  const start = useAtomCommand(neopiModels.startAuth, { reportFailure: false });
  const cancel = useAtomCommand(neopiModels.cancelAuth, { reportFailure: false });
  const [key, setKey] = useState("");
  const [flowId, setFlowId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const startingRef = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancel a late native login start if its scoped account view has closed.
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function login(providerId: string) {
    if (startingRef.current || flowId !== null) return;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const result = await start({
        environmentId,
        input: { target, providerId: isNeoProxy ? "neoproxy" : providerId },
      });
      if (result._tag === "Failure") {
        if (active.current) setError(errorMessage(squashAtomCommandFailure(result)));
        return;
      }
      if (!active.current) {
        void cancel({ environmentId, input: result.value });
        return;
      }
      setFlowId(result.value.flowId);
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      startingRef.current = false;
      if (active.current) setStarting(false);
    }
  }
  return (
    <View className="gap-3 border-b border-border-subtle pb-4">
      <Text className="text-sm text-foreground">
        {provider.authenticated ? "●" : "○"}{" "}
        {provider.authenticated
          ? isNeoProxy
            ? "Connected"
            : "Signed in"
          : isNeoProxy
            ? "Not connected"
            : "Not signed in"}
      </Text>
      <Text className="text-sm text-foreground-muted">
        {provider.disabled
          ? "Disabled in native NeoPi settings"
          : (provider.authSource ??
            (provider.available
              ? "Models available without stored credentials"
              : "No models available"))}
      </Text>
      {provider.envVars.length ? (
        <Text className="text-xs text-foreground-muted">
          Native environment keys: {provider.envVars.join(", ")}
        </Text>
      ) : null}
      <NativeError message={error ?? accountsQuery.error} />
      <View className="flex-row flex-wrap gap-2">
        {provider.loginProviders.map((value) => (
          <Button
            key={value.id}
            label={isNeoProxy ? "Connect to NeoProxy" : `Log in to ${value.name}`}
            disabled={!value.available || pending || starting || flowId !== null}
            onPress={() => void login(value.id)}
          />
        ))}
        <Button
          label="Show native accounts"
          disabled={pending}
          onPress={() => void loadAccounts()}
        />
      </View>
      {flowId ? (
        <NativeLogin
          key={flowId}
          environmentId={environmentId}
          flowId={flowId}
          providerId={provider.id}
          refresh={() => {
            refresh();
            loadAccounts();
          }}
          close={() => {
            setFlowId(null);
            void loadAccounts();
          }}
        />
      ) : null}
      {isNeoProxy && !provider.disabled && provider.discovery?.error ? (
        <Text className="text-sm text-foreground-muted">
          Last model discovery report: {provider.discovery.error}
        </Text>
      ) : null}
      {isNeoProxy &&
      catalogReady &&
      accountsReady &&
      provider.authenticated &&
      !provider.disabled &&
      accounts.length > 0 &&
      !hasAvailableCatalogModels ? (
        <Text className="text-sm text-foreground-muted">
          No NeoProxy models are available in this configuration. Check the connection, model
          discovery and selected scope in NeoPi, then refresh. If NeoPi's connection flow explicitly
          reports that this member has no granted models, ask your administrator to grant access.
        </Text>
      ) : null}
      {!isNeoProxy ? (
        <>
          <NativeField
            label={`Native ${provider.id} API key`}
            value={key}
            onChange={setKey}
            secret
            disabled={pending}
          />
          <Button
            label="Save native key"
            disabled={pending || !key.trim()}
            onPress={() => {
              const apiKey = key;
              setKey("");
              void save({ operation: "key", providerId: provider.id, apiKey });
            }}
          />
        </>
      ) : null}
      {accounts.map((account) => (
        <View key={account.credentialId} className="gap-2">
          <Text className="text-sm text-foreground">
            {account.label}
            {account.active ? " · Active in native session" : ""}
          </Text>
          <Text className="text-xs text-foreground-muted">{account.detail}</Text>
          <Button
            label={isNeoProxy ? "Disconnect" : "Remove this account"}
            disabled={pending}
            onPress={() =>
              void save({
                operation: "logout",
                providerId: provider.id,
                credentialId: account.credentialId,
              }).then((saved) => {
                if (saved) void loadAccounts();
              })
            }
          />
        </View>
      ))}
    </View>
  );
}

function NativeLogin({
  environmentId,
  flowId,
  providerId,
  refresh,
  close,
}: {
  environmentId: EnvironmentId;
  flowId: string;
  providerId: string;
  refresh: () => void;
  close: () => void;
}) {
  const state = useAtomValue(neopiModels.authChanges({ environmentId, input: { flowId } }));
  const respond = useAtomCommand(neopiModels.respondAuth, { reportFailure: false });
  const cancel = useAtomCommand(neopiModels.cancelAuth, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const active = useRef(false);
  const result = AsyncResult.isSuccess(state) ? state.value : null;
  const completed = useRef(false);
  const refreshCompleted = useEffectEvent(refresh);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Ignore cancellation replies after this native authentication flow closes.
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh native catalog and accounts once the authentication stream reports completion.
  useEffect(() => {
    if (result?.status === "complete" && !completed.current) {
      completed.current = true;
      refreshCompleted();
    }
  }, [result?.status]);
  const send = async (requestId: string, answer: { value: string } | { confirmed: boolean }) => {
    const response = await respond({ environmentId, input: { flowId, requestId, ...answer } });
    if (response._tag === "Failure") throw squashAtomCommandFailure(response);
  };
  if (AsyncResult.isFailure(state))
    return (
      <View className="gap-3">
        <NativeError message={errorMessage(Cause.squash(state.cause))} />
        <Button label="Close login" onPress={close} />
      </View>
    );
  const url = result?.url && /^https?:\/\//i.test(result.url) ? result.url : null;
  return (
    <View className="gap-3 border-y border-border-subtle py-3">
      {result?.message || !result?.prompt ? (
        <Text className="text-sm text-foreground">
          {providerId === "neoproxy" && result?.status === "complete"
            ? "Connected"
            : (result?.message ??
              (providerId === "neoproxy" ? "Connecting…" : "Waiting for native login"))}
        </Text>
      ) : null}
      {url ? (
        <Button
          label="Open native authorization page"
          onPress={() => void Linking.openURL(url).catch((cause) => setError(errorMessage(cause)))}
        />
      ) : null}
      {result?.userCode ? (
        <Text selectable className="font-t3-medium text-foreground">
          {result.userCode}
        </Text>
      ) : null}
      {result?.instructions ? (
        <Text selectable className="text-sm text-foreground-muted">
          {result.instructions}
        </Text>
      ) : null}
      <NativeError message={error} />
      {result?.prompt ? (
        <NativeLoginPrompt
          key={JSON.stringify([result.prompt.id, result.prompt.kind])}
          prompt={result.prompt}
          providerId={providerId}
          disabled={cancelling || result.status !== "running"}
          send={send}
        />
      ) : null}
      <Button
        label={!result || result.status === "running" ? "Cancel login" : "Close login"}
        disabled={(!result || result.status === "running") && cancelling}
        onPress={() => {
          if (!result || result.status === "running") {
            if (cancelling) return;
            setCancelling(true);
            void cancel({ environmentId, input: { flowId } }).then((response) => {
              if (!active.current) return;
              if (response._tag === "Failure") {
                setError(errorMessage(squashAtomCommandFailure(response)));
                setCancelling(false);
              }
            });
          } else close();
        }}
      />
    </View>
  );
}

function NativeLoginPrompt({
  prompt,
  providerId,
  disabled,
  send,
}: {
  prompt: NonNullable<NeoPiModelsAuthState["prompt"]>;
  providerId: string;
  disabled: boolean;
  send: (requestId: string, answer: { value: string } | { confirmed: boolean }) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const active = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Ignore answer replies after the native prompt ID or kind changes.
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const answer = (response: { value: string } | { confirmed: boolean }) => {
    if (pending.current || disabled) return;
    pending.current = true;
    setSubmitting(true);
    setError(null);
    void send(prompt.id, response).then(
      () => {
        if (active.current) setValue("");
      },
      (cause) => {
        if (!active.current) return;
        setError(errorMessage(cause));
        pending.current = false;
        setSubmitting(false);
      },
    );
  };
  return (
    <View className="gap-3">
      <NativeError message={error} />
      {prompt.kind === "input" ? (
        <View className="gap-2">
          <NativeField
            label={prompt.title}
            value={value}
            onChange={setValue}
            secret={prompt.secret}
            placeholder={prompt.placeholder ?? undefined}
            disabled={submitting || disabled}
          />
          <Button
            label="Send to native login"
            disabled={!value.trim() || submitting || disabled}
            onPress={() => answer({ value })}
          />
        </View>
      ) : (
        <View className="gap-3 rounded-lg border border-border-subtle p-3">
          <Text accessibilityRole="header" className="font-t3-medium text-foreground">
            {prompt.title}
          </Text>
          <Text selectable className="text-sm text-foreground-muted">
            {prompt.message}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Button
              label={providerId === "neoproxy" ? "Don't trust" : "Decline"}
              disabled={submitting || disabled}
              onPress={() => answer({ confirmed: false })}
            />
            <Button
              label={providerId === "neoproxy" ? "Trust this server" : "Confirm"}
              tone="primary"
              disabled={submitting || disabled}
              onPress={() => answer({ confirmed: true })}
            />
          </View>
        </View>
      )}
    </View>
  );
}
