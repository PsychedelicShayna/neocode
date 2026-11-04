import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  NeoPiEffortRule,
  NeoPiEffortSelection,
  NeoPiModelsAccounts,
  NeoPiModelsConfiguration,
  NeoPiModelsTarget,
  NeoPiModelsUpdate,
  NeoPiNativeModel,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { createModelCapabilities } from "@t3tools/shared/model";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  MoreHorizontalIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatEnvironmentQueryError } from "../../state/query";
import { nativeSessionAtoms } from "../../state/neopiNativeSessions";
import { useEscapeToGoBack, useNavigateBack } from "../../hooks/useNavigateBack";
import { isElectron } from "../../env";
import { SidebarUpdatePill } from "../sidebar/SidebarUpdatePill";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarInset,
} from "../ui/sidebar";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Group } from "../ui/group";
import { Input } from "../ui/input";
import { InputGroup, InputGroupInput } from "../ui/input-group";
import { Kbd } from "../ui/kbd";
import { Textarea } from "../ui/textarea";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { TraitsPicker } from "../chat/TraitsPicker";
import {
  PolicyTooltip,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../settings/settingsLayout";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { neopiModels, useModelsPageTarget } from "./modelsPageState";
import { NeoPiModelsSelector } from "./NeoPiModelsSelector";
import {
  MODEL_EFFORTS,
  isModelRulePattern,
  isModelRuleSelectorValid,
  modelContextLabel,
  modelDisplayName,
  modelEffortLabel,
  modelPriceLabel,
  modelProviderGroups,
  modelRoleForScope,
  modelsForView,
  moveModelItem,
} from "./modelsPresentation";

type Configuration = NeoPiModelsConfiguration;
type Role = Configuration["roles"][number];
type Provider = Configuration["providers"][number];
type Scope = "global" | "project";
type Save = (
  change: NeoPiModelsUpdate["change"],
  onFailure?: (cause: unknown) => void,
) => Promise<boolean>;
type PickerContext = {
  configuration: Configuration;
  environmentId: EnvironmentId;
  target: NeoPiModelsTarget;
  provider: ServerProvider;
  scope: Scope;
};

function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-xs text-destructive">
      {children}
    </p>
  );
}

function ModelsLoading() {
  return (
    <SettingsSection title="Models">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-12" />
      ))}
    </SettingsSection>
  );
}

function ModelsSnapshot({
  environmentId,
  target,
  children,
}: {
  environmentId: EnvironmentId;
  target: NeoPiModelsTarget;
  children: (configuration: Configuration, refresh: () => void) => ReactNode;
}) {
  const atom = neopiModels.changes({ environmentId, input: target });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  if (AsyncResult.isFailure(result))
    return (
      <SettingsSection title="Models">
        <SettingsRow
          title="Couldn't read models from NeoPi"
          description={formatEnvironmentQueryError(result.cause)}
          control={
            <Button variant="outline" size="sm" onClick={refresh}>
              Retry
            </Button>
          }
        />
      </SettingsSection>
    );
  if (!AsyncResult.isSuccess(result) || result.value === null) return <ModelsLoading />;
  return children(result.value, refresh);
}

function ProviderRailRow({
  provider,
  modelCount,
  environmentId,
  target,
  active,
  select,
}: {
  provider: Provider;
  modelCount: number;
  environmentId: EnvironmentId;
  target: NeoPiModelsTarget;
  active: boolean;
  select: () => void;
}) {
  const accountsCommand = useAtomCommand(neopiModels.accounts, { reportFailure: false });
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    setLabel(null);
    if (provider.authenticated)
      void accountsCommand({ environmentId, input: { target, providerId: provider.id } }).then(
        (result) => {
          if (mounted && result._tag === "Success")
            setLabel(
              result.value.accounts.find((account) => account.active)?.label ??
                result.value.accounts[0]?.label ??
                null,
            );
        },
      );
    return () => {
      mounted = false;
    };
  }, [accountsCommand, environmentId, target, provider.id, provider.authenticated]);
  const ready = provider.available === true;
  const status = provider.authenticated
    ? label
      ? `Signed in as ${label}`
      : "Signed in"
    : ready
      ? "Works without sign-in"
      : "Not signed in";
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={active} onClick={select}>
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={status}
                className={`size-1.5 shrink-0 rounded-full ${ready ? "bg-success" : "border border-muted-foreground/60"}`}
              />
            }
          />
          <TooltipPopup>{status}</TooltipPopup>
        </Tooltip>
        <span className="min-w-0 flex-1 truncate text-sidebar-foreground">{provider.id}</span>
        {ready ? (
          <span className="text-xs tabular-nums text-muted-foreground/55">{modelCount}</span>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function ModelsRail({
  environmentId,
  target,
  section,
  query,
  select,
}: {
  environmentId: EnvironmentId;
  target: NeoPiModelsTarget;
  section: string;
  query: string;
  select: (section: string) => void;
}) {
  const result = useAtomValue(neopiModels.changes({ environmentId, input: target }));
  const configuration = AsyncResult.isSuccess(result) ? result.value : null;
  const item = (id: string, label: string, count?: number) => (
    <SidebarMenuItem key={id}>
      <SidebarMenuButton isActive={section === id} onClick={() => select(id)}>
        <span className="min-w-0 flex-1 truncate text-sidebar-foreground">{label}</span>
        {count === undefined ? null : (
          <span className="text-xs tabular-nums text-muted-foreground/55">{count}</span>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
  const groups = useMemo(
    () => modelProviderGroups(configuration?.providers ?? [], query),
    [configuration?.providers, query],
  );
  const counts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const model of configuration?.models ?? [])
      counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
    return counts;
  }, [configuration?.models]);
  return (
    <>
      <SidebarGroup>
        <SidebarMenu>
          {item("roles", "Roles")}
          {item(
            "all",
            "All models",
            configuration?.providers.reduce(
              (total, provider) =>
                total + (provider.available === true ? (counts.get(provider.id) ?? 0) : 0),
              0,
            ),
          )}
          {item("effort", "Effort rules", configuration?.effortRules.length)}
        </SidebarMenu>
      </SidebarGroup>
      {configuration
        ? [
            { label: "Ready", providers: groups.ready },
            { label: "Not set up", providers: groups.notSetUp },
          ]
            .filter((group) => group.providers.length > 0)
            .map((group) => (
              <SidebarGroup key={group.label}>
                <p className="mb-2 text-xs text-muted-foreground">{group.label}</p>
                <SidebarMenu>
                  {group.providers.map((provider) => (
                    <ProviderRailRow
                      key={provider.id}
                      provider={provider}
                      modelCount={counts.get(provider.id) ?? 0}
                      environmentId={environmentId}
                      target={target}
                      active={section === `provider:${provider.id}`}
                      select={() => select(`provider:${provider.id}`)}
                    />
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            ))
        : null}
    </>
  );
}

export function NeoPiModelsSidebar() {
  const { target, environmentId, search, changeSearch } = useModelsPageTarget();
  const [query, setQuery] = useState("");
  const back = useNavigateBack();
  return (
    <>
      <SidebarContent>
        <SidebarGroup>
          <SidebarInput
            placeholder="Filter providers"
            aria-label="Filter providers"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </SidebarGroup>
        {target && environmentId ? (
          <ModelsRail
            environmentId={environmentId}
            target={target}
            section={search.section ?? "roles"}
            query={query}
            select={(section) => changeSearch({ section })}
          />
        ) : null}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu className="flex-row items-center">
          <SidebarMenuItem className="min-w-0 flex-1">
            <SidebarMenuButton onClick={back}>
              <ArrowLeftIcon />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarUpdatePill />
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}

export function NeoPiModelsPage() {
  const state = useModelsPageTarget();
  const [scope, setScope] = useState<Scope>("global");
  const back = useNavigateBack();
  useEscapeToGoBack(back);
  const providerId = state.search.section?.startsWith("provider:")
    ? state.search.section.slice(9)
    : null;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <h1 className="text-sm font-semibold">Models</h1>
          {providerId ? <span className="text-sm text-muted-foreground">{providerId}</span> : null}
        </WorkspacePageHeader>
        <SettingsPageContainer>
          {state.target && state.environmentId && state.provider ? (
            <ModelsSnapshot environmentId={state.environmentId} target={state.target}>
              {(configuration, refresh) => (
                <ModelsContent
                  key={JSON.stringify([state.environmentId, state.target])}
                  state={state}
                  environmentId={state.environmentId!}
                  target={state.target!}
                  provider={state.provider!}
                  configuration={configuration}
                  refresh={refresh}
                  scope={scope}
                  setScope={setScope}
                />
              )}
            </ModelsSnapshot>
          ) : (
            <SettingsSection title="Models">
              <SettingsRow
                title="No NeoPi connection"
                description="Enable a NeoPi connection in Settings → NeoCore to choose models."
              />
            </SettingsSection>
          )}
        </SettingsPageContainer>
      </div>
    </SidebarInset>
  );
}

function ModelsScope({
  state,
  scope,
  selectScope,
  pending,
}: {
  state: ReturnType<typeof useModelsPageTarget>;
  scope: Scope;
  selectScope: (scope: Scope, project?: string) => void;
  pending: boolean;
}) {
  const connected = state.environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const project = state.projects.find((project) => project.id === state.projectId);
  const environment = state.environments.find(
    (environment) => environment.environmentId === state.environmentId,
  );
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-3 text-base text-muted-foreground sm:px-4">
      <span>Editing</span>
      <Menu>
        <MenuTrigger render={<InlineButton tone="picker" disabled={pending} />}>
          {scope === "global" ? "global" : (project?.title ?? "this project")}
          <ChevronDownIcon className="size-3" />
        </MenuTrigger>
        <MenuPopup>
          <MenuItem onClick={() => selectScope("global")}>Global</MenuItem>
          {state.projects.map((project) => (
            <MenuItem key={project.id} onClick={() => selectScope("project", project.id)}>
              This project · {project.title}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <span>settings</span>
      {connected.length > 1 ? (
        <>
          <span>on</span>
          <Menu>
            <MenuTrigger render={<InlineButton tone="picker" disabled={pending} />}>
              {environment?.label ?? "Choose environment"}
              <ChevronDownIcon className="size-3" />
            </MenuTrigger>
            <MenuPopup>
              {connected.map((environment) => (
                <MenuItem
                  key={environment.environmentId}
                  onClick={() => {
                    selectScope("global");
                    state.changeSearch({
                      environment: environment.environmentId,
                      instance: undefined,
                      project: undefined,
                      sessionFile: undefined,
                    });
                  }}
                >
                  {environment.label}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        </>
      ) : null}
      {state.providers.length > 1 ? (
        <>
          <span>using</span>
          <Menu>
            <MenuTrigger render={<InlineButton tone="picker" disabled={pending} />}>
              {state.provider?.displayName ?? "NeoPi"}
              <ChevronDownIcon className="size-3" />
            </MenuTrigger>
            <MenuPopup>
              {state.providers.map((provider) => (
                <MenuItem
                  key={provider.instanceId}
                  onClick={() =>
                    state.changeSearch({ instance: provider.instanceId, sessionFile: undefined })
                  }
                >
                  {provider.displayName ?? "NeoPi"}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        </>
      ) : null}
    </p>
  );
}

function ModelsContent({
  state,
  environmentId,
  target,
  provider: connection,
  configuration: snapshot,
  refresh,
  scope,
  setScope,
}: {
  state: ReturnType<typeof useModelsPageTarget>;
  environmentId: EnvironmentId;
  target: NeoPiModelsTarget;
  provider: ServerProvider;
  configuration: Configuration;
  refresh: () => void;
  scope: Scope;
  setScope: (scope: Scope) => void;
}) {
  const update = useAtomCommand(neopiModels.update, { reportFailure: false });
  const request = useAtomCommand(nativeSessionAtoms.request, { reportFailure: false });
  const [configuration, setConfiguration] = useState(snapshot);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const [query, setQuery] = useState("");
  const section = state.search.section ?? "roles";
  useEffect(() => {
    setConfiguration(snapshot);
  }, [snapshot]);
  const save: Save = async (change, onFailure) => {
    if (saving.current) return false;
    saving.current = true;
    setPending(true);
    try {
      const result = await update({ environmentId, input: { target, change } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setConfiguration(result.value);
      refresh();
      return true;
    } catch (cause) {
      onFailure?.(cause);
      toastManager.add({
        type: "error",
        title: "Couldn't save Models settings",
        description: cause instanceof Error ? cause.message : String(cause),
      });
      return false;
    } finally {
      saving.current = false;
      setPending(false);
    }
  };
  const selectScope = (next: Scope, project?: string) => {
    if (pending) return;
    setScope(next);
    if (project && project !== state.projectId)
      state.changeSearch({ project, sessionFile: undefined });
  };
  const picker: PickerContext = {
    configuration,
    environmentId,
    target,
    provider: connection,
    scope,
  };
  const provider = section.startsWith("provider:")
    ? configuration.providers.find((provider) => provider.id === section.slice(9))
    : null;
  const models = useMemo(
    () =>
      section === "all" || provider
        ? modelsForView(configuration, provider?.id ?? null, query)
        : [],
    [configuration, provider, query, section],
  );
  const assign = (role: Role, selector: string) =>
    save({
      operation: "role",
      role: role.id,
      scope,
      selector,
      ...(role[scope].effort ? { effort: role[scope].effort } : {}),
      expected: role[scope],
    });
  const setThreadModel = target.sessionFile
    ? async (model: NeoPiNativeModel) => {
        const result = await request({
          environmentId,
          input: {
            ref: {
              providerInstanceId: target.providerInstanceId,
              sessionFile: target.sessionFile!,
            },
            command: { type: "set_model", provider: model.provider, modelId: model.id },
          },
        });
        if (result._tag === "Failure")
          toastManager.add({
            type: "error",
            title: "Couldn't change this thread's model",
            description: String(squashAtomCommandFailure(result)),
          });
      }
    : undefined;
  return (
    <>
      <ModelsScope
        state={state}
        scope={scope}
        pending={pending}
        selectScope={(next, project) => {
          void selectScope(next, project);
        }}
      />
      {section === "roles" ? (
        <RolesView key={scope} picker={picker} scope={scope} pending={pending} save={save} />
      ) : section === "effort" ? (
        <RulesView key={scope} picker={picker} scope={scope} pending={pending} save={save} />
      ) : section.startsWith("provider:") && !provider ? (
        <SettingsSection title="Models">
          <SettingsRow
            title="Provider not available"
            description="Choose another provider or All models."
          />
        </SettingsSection>
      ) : (
        <>
          {provider ? (
            <ProviderAccounts
              key={provider.id}
              environmentId={environmentId}
              target={target}
              connectedOwner={state.connectedOwner}
              provider={provider}
              refresh={refresh}
              save={save}
              pending={pending}
            />
          ) : null}
          <SettingsSection
            title="Models"
            headerAction={
              <Input
                aria-label="Filter models"
                placeholder="Filter models"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            }
          >
            <Table
              className="table-fixed"
              aria-label={provider ? `${provider.id} models` : "All models"}
            >
              <colgroup>
                <col />
                <col style={{ width: "6rem" }} />
                <col style={{ width: "8rem" }} />
                <col style={{ width: "9rem" }} />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Context</TableHead>
                  <TableHead className="text-right">
                    <Tooltip>
                      <TooltipTrigger render={<span />}>Price</TooltipTrigger>
                      <TooltipPopup>Per million input / output tokens</TooltipPopup>
                    </Tooltip>
                  </TableHead>
                  <TableHead>Effort</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map((model) => (
                  <ModelRow
                    key={`${model.provider}/${model.id}`}
                    model={model}
                    models={configuration.models}
                    roles={configuration.roles}
                    scope={scope}
                    pending={pending}
                    assign={assign}
                    {...(setThreadModel ? { setThreadModel: setThreadModel } : {})}
                  />
                ))}
                {models.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4}>No models match “{query}”.</TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </SettingsSection>
        </>
      )}
    </>
  );
}

function ModelRow({
  model,
  models,
  roles,
  scope,
  pending,
  assign,
  setThreadModel: setThreadModel,
}: {
  model: NeoPiNativeModel;
  models: ReadonlyArray<NeoPiNativeModel>;
  roles: ReadonlyArray<Role>;
  scope: Scope;
  pending: boolean;
  assign: (role: Role, selector: string) => Promise<boolean>;
  setThreadModel?: (model: NeoPiNativeModel) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const selector = `${model.provider}/${model.id}`;
  const number = (value: number | null) => value?.toLocaleString() ?? "Not reported";
  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          nativeButton={false}
          render={
            <TableRow
              tabIndex={0}
              className="cursor-pointer"
              onContextMenu={(event) => {
                event.preventDefault();
                setOpen(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  setOpen(true);
                }
              }}
            />
          }
        >
          <TableCell>
            <div className="min-w-64 max-w-xl">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-medium">{modelDisplayName(model)}</span>
                {model.supportsFastMode ? (
                  <Tooltip>
                    <TooltipTrigger render={<span />}>
                      <ZapIcon className="size-3" />
                    </TooltipTrigger>
                    <TooltipPopup>Fast mode available</TooltipPopup>
                  </Tooltip>
                ) : null}
                {model.kind !== "chat" ? (
                  <Badge size="sm" variant="outline">
                    {model.kind}
                  </Badge>
                ) : null}
              </div>
              <div className="truncate font-mono text-xs text-muted-foreground">{model.id}</div>
            </div>
          </TableCell>
          <TableCell className="text-right">
            <Tooltip>
              <TooltipTrigger render={<span className="tabular-nums" />}>
                {modelContextLabel(model.contextWindow)}
              </TooltipTrigger>
              <TooltipPopup>
                {number(model.effectiveContextWindow)} usable · {number(model.contextWindow)} window
                · {number(model.maxTokens)} max output
              </TooltipPopup>
            </Tooltip>
          </TableCell>
          <TableCell className="text-right">
            <span className="tabular-nums">
              {model.cost.input === 0 && model.cost.output === 0 ? (
                <Tooltip>
                  <TooltipTrigger render={<span />}>—</TooltipTrigger>
                  <TooltipPopup>No per-token price reported</TooltipPopup>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger render={<span />}>{modelPriceLabel(model.cost)}</TooltipTrigger>
                  <TooltipPopup>
                    {`$${model.cost.input} input / $${model.cost.output} output`}
                  </TooltipPopup>
                </Tooltip>
              )}
            </span>
          </TableCell>
          <TableCell className="whitespace-nowrap">
            {modelEffortLabel(model.permittedEfforts)}
          </TableCell>
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuSub>
            <MenuSubTrigger>Assign to role</MenuSubTrigger>
            <MenuSubPopup>
              {roles.map((role) => {
                const resolution = role.scopedResolutions[scope];
                const using =
                  resolution?.provider === model.provider && resolution.modelId === model.id;
                const currentModel =
                  resolution &&
                  models.find(
                    (candidate) =>
                      candidate.provider === resolution.provider &&
                      candidate.id === resolution.modelId,
                  );
                const current = currentModel ? modelDisplayName(currentModel) : resolution?.modelId;
                return (
                  <MenuItem
                    key={role.id}
                    disabled={pending}
                    onClick={() => {
                      void assign(role, selector);
                    }}
                  >
                    {using ? <CheckIcon className="size-3" /> : null}
                    <span>{role.id}</span>
                    <span className="ml-auto max-w-48 truncate text-xs text-muted-foreground">
                      {current ??
                        (modelRoleForScope(role, scope).selector ? "Not available" : "Automatic")}
                    </span>
                  </MenuItem>
                );
              })}
            </MenuSubPopup>
          </MenuSub>
          {setThreadModel ? (
            <MenuItem
              onClick={() => {
                void setThreadModel(model);
              }}
            >
              Use in this thread
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem onClick={() => setDetails(true)}>Details…</MenuItem>
        </MenuPopup>
      </Menu>
      <Dialog open={details} onOpenChange={setDetails}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{modelDisplayName(model)}</DialogTitle>
            <DialogDescription>{model.description ?? model.name ?? model.id}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <SettingsRow title="ID" description={selector} />
            <SettingsRow
              title="Context"
              description={`${number(model.effectiveContextWindow)} usable · ${number(model.contextWindow)} window · ${number(model.maxTokens)} max output`}
            />
            <SettingsRow
              title="Price per million tokens"
              description={`$${model.cost.input} input / $${model.cost.output} output · $${model.cost.cacheRead} cache read / $${model.cost.cacheWrite} cache write`}
            />
            <SettingsRow
              title="Efforts"
              description={model.permittedEfforts.join(", ") || "No controllable effort"}
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetails(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function EffortToggles({
  selected,
  disabled,
  onChange,
}: {
  selected: ReadonlyArray<string>;
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  return (
    <ToggleGroup
      multiple
      size="sm"
      value={[...selected]}
      disabled={disabled}
      onValueChange={(value) => {
        if (value.length > 0) onChange(value);
        else toastManager.add({ type: "error", title: "Choose at least one effort" });
      }}
      aria-label="Allowed efforts"
    >
      {MODEL_EFFORTS.map((effort) => (
        <ToggleGroupItem key={effort} value={effort} aria-label={`Allow ${effort} effort`}>
          {effort}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function RolesView({
  picker,
  scope,
  pending,
  save,
}: {
  picker: PickerContext;
  scope: Scope;
  pending: boolean;
  save: Save;
}) {
  const [creating, setCreating] = useState(false);
  const isMedia = (role: Role) => role.section === "kind";
  const roles = picker.configuration.roles;
  return (
    <>
      <SettingsSection
        title="Roles"
        headerAction={
          <Button size="xs" variant="outline" onClick={() => setCreating(true)}>
            New role
          </Button>
        }
      >
        {roles
          .filter((role) => !isMedia(role))
          .map((role) => (
            <RoleRow
              key={`${scope}:${role.id}`}
              role={role}
              picker={picker}
              scope={scope}
              pending={pending}
              save={save}
            />
          ))}
      </SettingsSection>
      <SettingsSection title="Media">
        {roles.filter(isMedia).map((role) => (
          <RoleRow
            key={`${scope}:${role.id}`}
            role={role}
            picker={picker}
            scope={scope}
            pending={pending}
            save={save}
          />
        ))}
      </SettingsSection>
      <NewRoleDialog
        open={creating}
        setOpen={setCreating}
        picker={picker}
        scope={scope}
        pending={pending}
        save={save}
      />
    </>
  );
}

function RoleRow({
  role,
  picker,
  scope,
  pending,
  save,
}: {
  role: Role;
  picker: PickerContext;
  scope: Scope;
  pending: boolean;
  save: Save;
}) {
  const [effortOpen, setEffortOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const scoped = role[scope];
  const { selector, effort, resolution } = modelRoleForScope(role, scope);
  const resolved = resolution
    ? picker.configuration.models.find(
        (model) => resolution.provider === model.provider && resolution.modelId === model.id,
      )
    : undefined;
  const traitsModel = resolved ? `${resolved.provider}/${resolved.id}` : selector;
  const traits: ReadonlyArray<ServerProviderModel> = useMemo(
    () => [
      {
        slug: traitsModel,
        name: resolved ? modelDisplayName(resolved) : selector,
        isCustom: false,
        capabilities: createModelCapabilities({
          reasoning: resolved?.reasoning,
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Effort",
              type: "select",
              options: [
                { id: "automatic", label: "Automatic" },
                ...(resolved?.supportedThinkingLevels ?? MODEL_EFFORTS).map((level) => ({
                  id: level,
                  label: level,
                })),
              ],
              currentValue: effort?.mode === "fixed" ? effort.level : "automatic",
            },
          ],
        }),
      },
    ],
    [resolved, traitsModel, selector, effort],
  );
  const setRole = (
    nextSelector: string | null,
    nextEffort: NeoPiEffortSelection | null = scoped.effort,
  ) =>
    save({
      operation: "role",
      role: role.id,
      scope,
      ...(nextSelector ? { selector: nextSelector } : {}),
      ...(nextEffort ? { effort: nextEffort } : {}),
      expected: scoped,
    });
  const unavailable = selector !== "" && !resolution;
  return (
    <SettingsRow
      title={<span className="font-medium">{role.id}</span>}
      description={role.description}
      status={
        unavailable ? (
          <span className="text-xs text-warning">
            {selector} isn't available. Sign in to its provider or choose another model.
          </span>
        ) : undefined
      }
      resetAction={
        (scoped.selector !== null || scoped.effort !== null) &&
        (role.source === "builtin" ||
          (scope === "project" &&
            (role.global.selector !== null || role.global.effort !== null))) ? (
          <SettingResetButton
            label={role.id}
            tooltip="Reset to inherited value"
            disabled={pending}
            onClick={() => {
              void save({ operation: "role", role: role.id, scope, expected: scoped });
            }}
          />
        ) : null
      }
      control={
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          <NeoPiModelsSelector
            {...picker}
            label={`Model for ${role.id}`}
            value={selector}
            selectionLabel={
              !selector ? "Automatic" : resolved ? modelDisplayName(resolved) : "Not available"
            }
            onChange={(selector) => {
              void setRole(selector);
            }}
            disabled={pending}
          />
          <RoleFallbacks role={role} picker={picker} scope={scope} pending={pending} save={save} />
          <fieldset disabled={pending}>
            <TraitsPicker
              provider={picker.provider.driver}
              instanceId={picker.target.providerInstanceId}
              models={traits}
              model={traitsModel}
              modelOptions={[
                {
                  id: "reasoningEffort",
                  value: effort?.mode === "fixed" ? effort.level : "automatic",
                },
              ]}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              onModelOptionsChange={(options) => {
                const level = options?.find((option) => option.id === "reasoningEffort")?.value;
                if (typeof level === "string")
                  void setRole(
                    scoped.selector,
                    level === "automatic"
                      ? { mode: "auto", allowed: [...MODEL_EFFORTS] }
                      : { mode: "fixed", level },
                  );
              }}
            />
          </fieldset>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  ref={setMenuAnchor}
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Actions for ${role.id}`}
                  disabled={pending}
                />
              }
            >
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuPopup>
              <MenuItem onClick={() => setEffortOpen(true)}>Effort options…</MenuItem>
              {role.source === "configured" ? (
                <MenuItem
                  variant="destructive"
                  onClick={() => {
                    void save({ operation: "deleteRole", role: role.id, scope, expected: scoped });
                  }}
                >
                  Delete role
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
          <Popover open={effortOpen} onOpenChange={setEffortOpen}>
            <PopoverPopup anchor={menuAnchor} align="end">
              <Select
                disabled={pending}
                value={effort?.mode === "fixed" ? "fixed" : "auto"}
                onValueChange={(mode) => {
                  if (mode === "auto")
                    void setRole(scoped.selector, { mode: "auto", allowed: [...MODEL_EFFORTS] });
                  if (mode === "fixed")
                    void setRole(scoped.selector, {
                      mode: "fixed",
                      level: resolved?.supportedThinkingLevels[0] ?? "off",
                    });
                }}
              >
                <SelectTrigger size="sm" aria-label="Effort options">
                  <SelectValue>{effort?.mode === "fixed" ? "Fixed" : "Automatic"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="auto">Automatic</SelectItem>
                  <SelectItem value="fixed">Fixed</SelectItem>
                </SelectPopup>
              </Select>
              {effort?.mode === "fixed" ? (
                <Select
                  disabled={pending}
                  value={effort.level}
                  onValueChange={(level) => {
                    if (level) void setRole(scoped.selector, { mode: "fixed", level });
                  }}
                >
                  <SelectTrigger size="sm" aria-label="Fixed effort">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {(resolved?.supportedThinkingLevels ?? MODEL_EFFORTS).map((level) => (
                      <SelectItem key={level} value={level}>
                        {level}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : (
                <EffortToggles
                  selected={
                    effort?.mode === "auto" ? (effort.allowed ?? MODEL_EFFORTS) : MODEL_EFFORTS
                  }
                  disabled={pending}
                  onChange={(allowed) => {
                    void setRole(scoped.selector, { mode: "auto", allowed });
                  }}
                />
              )}
            </PopoverPopup>
          </Popover>
        </div>
      }
    />
  );
}

function RoleFallbacks({
  role,
  picker,
  scope,
  pending,
  save,
}: {
  role: Role;
  picker: PickerContext;
  scope: Scope;
  pending: boolean;
  save: Save;
}) {
  const [adding, setAdding] = useState(false);
  const fallbacks = scope === "global" ? role.fallbacksGlobal : role.fallbacks;
  const saveChain = (chain: ReadonlyArray<string>) =>
    save({
      operation: "fallbacks",
      role: role.id,
      scope,
      chain,
      efforts: Object.fromEntries(
        Object.entries(fallbacks.efforts).filter(([selector]) => chain.includes(selector)),
      ),
      expected: role.fallbacksGlobal,
    });
  return (
    <Popover>
      <PopoverTrigger render={<InlineButton tone="picker" disabled={pending} />}>
        {fallbacks.chain.length > 0 ? (
          <Badge size="sm" variant="outline">
            +{fallbacks.chain.length} fallbacks
          </Badge>
        ) : (
          "Add fallback"
        )}
      </PopoverTrigger>
      <PopoverPopup align="end">
        {scope === "project" ? (
          <p className="text-sm text-muted-foreground">
            Fallbacks are stored globally. Choose Global in the editing scope to change them.
          </p>
        ) : null}
        <ol>
          {fallbacks.chain.map((selector, index) => (
            <li key={`${index}:${selector}`} className="flex items-center gap-1.5">
              <NeoPiModelsSelector
                {...picker}
                label={`Fallback ${index + 1} for ${role.id}`}
                value={selector}
                disabled={pending || scope !== "global"}
                onChange={(next) => {
                  void saveChain(fallbacks.chain.map((value, at) => (at === index ? next : value)));
                }}
              />
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove fallback ${index + 1}`}
                disabled={pending || scope !== "global"}
                onClick={() => {
                  void saveChain(fallbacks.chain.filter((_, at) => at !== index));
                }}
              >
                <XIcon />
              </Button>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Fallback ${index + 1} actions`}
                      disabled={pending || scope !== "global"}
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </MenuTrigger>
                <MenuPopup>
                  <MenuItem
                    disabled={index === 0}
                    onClick={() => {
                      void saveChain(moveModelItem(fallbacks.chain, index, -1));
                    }}
                  >
                    Move up
                  </MenuItem>
                  <MenuItem
                    disabled={index === fallbacks.chain.length - 1}
                    onClick={() => {
                      void saveChain(moveModelItem(fallbacks.chain, index, 1));
                    }}
                  >
                    Move down
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </li>
          ))}
        </ol>
        {adding ? (
          <NeoPiModelsSelector
            {...picker}
            label={`New fallback for ${role.id}`}
            value=""
            open={adding}
            onOpenChange={setAdding}
            disabled={pending || scope !== "global"}
            onChange={(selector) => {
              setAdding(false);
              void saveChain([...fallbacks.chain, selector]);
            }}
          />
        ) : null}
        <InlineButton disabled={pending || scope !== "global"} onClick={() => setAdding(true)}>
          Add fallback
        </InlineButton>
      </PopoverPopup>
    </Popover>
  );
}

function NewRoleDialog({
  open,
  setOpen,
  picker,
  scope,
  pending,
  save,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  picker: PickerContext;
  scope: Scope;
  pending: boolean;
  save: Save;
}) {
  const [name, setName] = useState("");
  const [selector, setSelector] = useState("");
  const [description, setDescription] = useState("");
  const [created, setCreated] = useState(false);
  const close = () => {
    if (pending) return;
    setOpen(false);
    setName("");
    setSelector("");
    setDescription("");
    setCreated(false);
  };
  const create = async () => {
    const role = name.trim();
    if (!created) {
      if (
        !(await save({
          operation: "role",
          scope,
          role,
          selector,
          expected: { selector: null, effort: null },
        }))
      )
        return;
      setCreated(true);
    }
    if (
      scope === "global" &&
      description &&
      !(await save({ operation: "description", role, scope, description, expected: null }))
    )
      return;
    close();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New role</DialogTitle>
          {created ? (
            <DialogDescription>
              The role was created. Its description hasn't been saved yet.
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogPanel>
          <SettingsRow
            title="Name"
            control={
              <Input
                aria-label="Name"
                autoFocus
                disabled={pending || created}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            }
          />
          <SettingsRow
            title="Description"
            description={
              scope === "project"
                ? "Descriptions are stored globally. Choose Global in the editing scope to add a description."
                : undefined
            }
            control={
              <Textarea
                aria-label="Description"
                disabled={pending || scope !== "global"}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            }
          />
          <SettingsRow
            title="Model"
            control={
              <NeoPiModelsSelector
                {...picker}
                value={selector}
                label="New role model"
                disabled={pending || created}
                onChange={setSelector}
              />
            }
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={close}>
            {created ? "Close" : "Cancel"}
          </Button>
          <Button
            disabled={
              pending ||
              !name.trim() ||
              !selector ||
              (!created && picker.configuration.roles.some((role) => role.id === name.trim()))
            }
            onClick={() => {
              void create();
            }}
          >
            {created ? "Save description" : "Create"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RulesView({
  picker,
  scope,
  pending,
  save,
}: {
  picker: PickerContext;
  scope: Scope;
  pending: boolean;
  save: Save;
}) {
  const expected = picker.configuration.effortRuleScopes[scope];
  const rules =
    expected ?? (scope === "project" ? (picker.configuration.effortRuleScopes.global ?? []) : []);
  type PatternDraft = {
    index: number | null;
    selector: string;
    allowed: ReadonlyArray<string>;
    base: ReadonlyArray<NeoPiEffortRule>;
    expected: typeof expected;
  };
  const [exactOpen, setExactOpen] = useState(false);
  const [pattern, setPattern] = useState<PatternDraft | null>(null);
  const [invalid, setInvalid] = useState(false);
  const persist = (next: ReadonlyArray<NeoPiEffortRule>) =>
    save({ operation: "rules", scope, rules: next, expected });
  const editPattern = (index: number | null) => {
    const rule = index === null ? null : rules[index];
    setPattern({
      index,
      selector: rule?.selector ?? "",
      allowed: rule?.allowed ?? MODEL_EFFORTS,
      base: rules,
      expected,
    });
    setInvalid(false);
  };
  const savePattern = async (draft: PatternDraft) => {
    if (pending) return;
    const selector = draft.selector.trim();
    if (
      !isModelRulePattern(selector) ||
      !isModelRuleSelectorValid(selector) ||
      draft.base.some(
        (rule, index) =>
          index !== draft.index &&
          rule.selector.toLocaleLowerCase() === selector.toLocaleLowerCase(),
      )
    ) {
      setInvalid(true);
      return;
    }
    const next =
      draft.index === null
        ? [...draft.base, { selector, allowed: draft.allowed }]
        : draft.base.map((rule, index) =>
            index === draft.index ? { selector, allowed: draft.allowed } : rule,
          );
    // Keep the edit's original compare-and-swap snapshot through live configuration changes.
    let invalidValue = false;
    const saved = await save(
      { operation: "rules", scope, rules: next, expected: draft.expected },
      (cause) => {
        invalidValue =
          cause !== null &&
          typeof cause === "object" &&
          "code" in cause &&
          cause.code === "invalid_value";
      },
    );
    if (!saved && invalidValue) {
      setInvalid(true);
      return;
    }
    setPattern(null);
    setInvalid(false);
  };
  const patternInput = (draft: PatternDraft, label: string) => (
    <Input
      autoFocus
      disabled={pending}
      aria-label={label}
      placeholder="anthropic/* or re:^gpt-6"
      value={draft.selector}
      onChange={(event) => {
        setPattern({ ...draft, selector: event.target.value });
        setInvalid(false);
      }}
      onBlur={() => {
        void savePattern(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
  const createExact = (selector: string) => {
    if (
      isModelRulePattern(selector) ||
      !picker.configuration.models.some((model) => `${model.provider}/${model.id}` === selector)
    )
      return;
    setExactOpen(false);
    if (!rules.some((rule) => rule.selector === selector))
      void persist([...rules, { selector, allowed: [...MODEL_EFFORTS] }]);
  };
  return (
    <SettingsSection
      title="Effort rules"
      headerAction={
        <Menu>
          <MenuTrigger render={<Button size="xs" variant="outline" disabled={pending} />}>
            Add rule
          </MenuTrigger>
          <MenuPopup>
            <MenuItem disabled={pattern !== null} onClick={() => setExactOpen(true)}>
              Exact model…
            </MenuItem>
            <MenuItem disabled={pattern !== null} onClick={() => editPattern(null)}>
              Pattern…
            </MenuItem>
          </MenuPopup>
        </Menu>
      }
    >
      <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
        The first rule that matches a model limits which efforts it can use automatically. Exact
        models win over patterns.{" "}
        <PolicyTooltip>
          Exact models first, then regular expressions, then globs, each in list order. Efforts you
          pick by hand ignore these rules.
        </PolicyTooltip>
      </p>
      {exactOpen ? (
        <SettingsRow
          title="Exact model"
          control={
            <NeoPiModelsSelector
              {...picker}
              exactOnly
              label="Exact model for effort rule"
              value=""
              onChange={createExact}
              open={exactOpen}
              onOpenChange={setExactOpen}
              disabled={pending}
            />
          }
        />
      ) : null}
      {rules.length === 0 && !pattern ? (
        <SettingsRow title="No rules" description="Models can use every effort they support." />
      ) : null}
      {rules.map((rule, index) => {
        const model = picker.configuration.models.find(
          (model) => `${model.provider}/${model.id}` === rule.selector,
        );
        const draft = pattern?.index === index ? pattern : null;
        return (
          <SettingsRow
            key={`${scope}:${index}:${rule.selector}`}
            title={
              draft ? (
                patternInput(draft, "Rule pattern")
              ) : isModelRulePattern(rule.selector) ? (
                <span className="flex items-center gap-1.5">
                  <span className="font-mono">{rule.selector}</span>
                  <Badge size="sm" variant="outline">
                    pattern
                  </Badge>
                </span>
              ) : model ? (
                modelDisplayName(model)
              ) : (
                rule.selector
              )
            }
            status={draft && invalid ? <ErrorText>That pattern isn't valid.</ErrorText> : undefined}
            control={
              <div className="flex items-center gap-1.5">
                <EffortToggles
                  selected={draft?.allowed ?? rule.allowed}
                  disabled={pending || (pattern !== null && draft === null)}
                  onChange={(allowed) => {
                    if (draft) {
                      const next = { ...draft, allowed };
                      setPattern(next);
                      void savePattern(next);
                    } else
                      void persist(
                        rules.map((rule, at) => (at === index ? { ...rule, allowed } : rule)),
                      );
                  }}
                />
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Rule ${index + 1} actions`}
                        disabled={pending}
                      />
                    }
                  >
                    <MoreHorizontalIcon />
                  </MenuTrigger>
                  <MenuPopup>
                    <MenuItem
                      disabled={index === 0 || pattern !== null}
                      onClick={() => {
                        void persist(moveModelItem(rules, index, -1));
                      }}
                    >
                      Move up
                    </MenuItem>
                    <MenuItem
                      disabled={index === rules.length - 1 || pattern !== null}
                      onClick={() => {
                        void persist(moveModelItem(rules, index, 1));
                      }}
                    >
                      Move down
                    </MenuItem>
                    {isModelRulePattern(rule.selector) ? (
                      <MenuItem disabled={pattern !== null} onClick={() => editPattern(index)}>
                        Edit pattern
                      </MenuItem>
                    ) : null}
                    <MenuItem
                      variant="destructive"
                      onClick={() => {
                        setPattern(null);
                        setInvalid(false);
                        void persist(rules.filter((_, at) => at !== index));
                      }}
                    >
                      Remove
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </div>
            }
          />
        );
      })}
      {pattern?.index === null ? (
        <SettingsRow
          title={patternInput(pattern, "New rule pattern")}
          status={invalid ? <ErrorText>That pattern isn't valid.</ErrorText> : undefined}
          control={
            <div className="flex items-center gap-1.5">
              <EffortToggles
                selected={pattern.allowed}
                disabled={pending}
                onChange={(allowed) => {
                  const next = { ...pattern, allowed };
                  setPattern(next);
                  if (next.selector.trim()) void savePattern(next);
                }}
              />
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="New rule actions"
                      disabled={pending}
                    />
                  }
                >
                  <MoreHorizontalIcon />
                </MenuTrigger>
                <MenuPopup>
                  <MenuItem
                    variant="destructive"
                    onClick={() => {
                      setPattern(null);
                      setInvalid(false);
                    }}
                  >
                    Remove
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </div>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

function ProviderAccounts({
  environmentId,
  target,
  connectedOwner,
  provider,
  pending,
  refresh,
  save,
}: {
  environmentId: EnvironmentId;
  target: NeoPiModelsTarget;
  connectedOwner: boolean;
  provider: Provider;
  pending: boolean;
  refresh: () => void;
  save: Save;
}) {
  const accountsCommand = useAtomCommand(neopiModels.accounts, { reportFailure: false });
  const startAuth = useAtomCommand(neopiModels.startAuth, { reportFailure: false });
  const cancelAuth = useAtomCommand(neopiModels.cancelAuth, { reportFailure: false });
  const [accounts, setAccounts] = useState<NeoPiModelsAccounts["accounts"]>([]);
  const [accountsReady, setAccountsReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [key, setKey] = useState("");
  const [flowId, setFlowId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const loadAccounts = useCallback(async () => {
    const result = await accountsCommand({
      environmentId,
      input: { target, providerId: provider.id },
    });
    if (!mounted.current) return null;
    setLoading(false);
    if (result._tag === "Failure") {
      setError(String(squashAtomCommandFailure(result)));
      return null;
    }
    setAccounts(result.value.accounts);
    setAccountsReady(true);
    setError(null);
    return result.value.accounts;
  }, [accountsCommand, environmentId, target, provider.id]);
  useEffect(() => {
    mounted.current = true;
    void loadAccounts();
    return () => {
      mounted.current = false;
    };
  }, [loadAccounts]);
  const login = async (providerId: string) => {
    setStarting(true);
    setError(null);
    const result = await startAuth({ environmentId, input: { target, providerId } });
    if (!mounted.current) {
      if (result._tag === "Success") void cancelAuth({ environmentId, input: result.value });
      return;
    }
    setStarting(false);
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else setFlowId(result.value.flowId);
  };
  const methods = provider.loginProviders.filter((method) => method.available);
  const signIn = methods[0] ? (
    <Group>
      <Button
        size="sm"
        disabled={pending || starting}
        onClick={() => {
          void login(methods[0]!.id);
        }}
      >
        {starting ? <Spinner /> : null}Sign in
      </Button>
      {methods.length > 1 ? (
        <Menu>
          <MenuTrigger
            render={
              <Button size="sm" disabled={pending || starting} aria-label="Other sign-in methods" />
            }
          >
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup>
            {methods.slice(1).map((method) => (
              <MenuItem
                key={method.id}
                onClick={() => {
                  void login(method.id);
                }}
              >
                {method.deviceCode || method.loginKind === "device-code"
                  ? "Use a device code"
                  : method.name}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
    </Group>
  ) : null;
  const keyControl = (
    <div className="flex items-center gap-1.5">
      <InputGroup>
        <InputGroupInput
          type="password"
          aria-label={`${provider.id} API key`}
          placeholder="Paste key"
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
      </InputGroup>
      <Button
        size="sm"
        disabled={pending || !key.trim()}
        onClick={() => {
          void save({ operation: "key", providerId: provider.id, apiKey: key }).then((saved) => {
            if (saved) {
              setKey("");
              void loadAccounts();
            }
          });
        }}
      >
        Save
      </Button>
    </div>
  );
  return (
    <SettingsSection
      title="Account"
      icon={
        <PolicyTooltip>{`Stored in NeoPi. Environment variables: ${provider.envVars.join(", ") || "none"}.`}</PolicyTooltip>
      }
      headerAction={
        accounts.length > 0 && methods.length > 0 ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending || starting || flowId !== null}
                />
              }
            >
              Add account
            </MenuTrigger>
            <MenuPopup>
              {methods.map((method) => (
                <MenuItem
                  key={method.id}
                  onClick={() => {
                    void login(method.id);
                  }}
                >
                  {method.deviceCode || method.loginKind === "device-code"
                    ? "Use a device code"
                    : method.name}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : undefined
      }
    >
      {loading ? (
        [0, 1, 2, 3].map((row) => <Skeleton key={row} className="h-12" />)
      ) : accountsReady ? (
        <>
          {accounts.map((account) => (
            <SettingsRow
              key={account.credentialId}
              title={account.label || "API key"}
              status={
                <span className="flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-success" />
                  Signed in
                  {account.active ? (
                    <Badge size="sm" variant="secondary">
                      In use
                    </Badge>
                  ) : null}
                </span>
              }
              control={
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Account actions for ${account.label || "API key"}`}
                        disabled={pending || flowId !== null}
                      />
                    }
                  >
                    <MoreHorizontalIcon />
                  </MenuTrigger>
                  <MenuPopup>
                    {!account.active && account.type === "oauth" ? (
                      <MenuItem
                        disabled={!connectedOwner}
                        onClick={() => {
                          void save({
                            operation: "activateAccount",
                            providerId: provider.id,
                            credentialId: account.credentialId,
                          }).then((saved) => {
                            if (saved) void loadAccounts();
                          });
                        }}
                      >
                        Use this account
                        {!connectedOwner ? (
                          <span className="text-xs text-muted-foreground">
                            Open from a connected native session
                          </span>
                        ) : null}
                      </MenuItem>
                    ) : null}
                    <MenuItem
                      variant="destructive"
                      onClick={() => {
                        void save({
                          operation: "logout",
                          providerId: provider.id,
                          credentialId: account.credentialId,
                        }).then((saved) => {
                          if (saved) void loadAccounts();
                        });
                      }}
                    >
                      Sign out
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              }
            />
          ))}
          {accounts.length === 0 && !flowId ? (
            <SettingsRow
              title={provider.authenticated ? "API key" : "Not signed in"}
              description={
                provider.authenticated ? undefined : `Sign in to use ${provider.id} models.`
              }
              status={
                provider.authenticated ? (
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-success" />
                    Signed in
                  </span>
                ) : undefined
              }
              control={signIn}
            />
          ) : null}
          {flowId ? (
            <NativeLogin
              environmentId={environmentId}
              flowId={flowId}
              title={
                accounts.length === 0
                  ? provider.authenticated
                    ? "API key"
                    : "Not signed in"
                  : "Sign in"
              }
              description={
                accounts.length === 0 && !provider.authenticated
                  ? `Sign in to use ${provider.id} models.`
                  : undefined
              }
              finish={async (status, message) => {
                setFlowId(null);
                if (status === "complete") {
                  const next = await loadAccounts();
                  if (mounted.current) {
                    const label =
                      next?.find(
                        (account) =>
                          !accounts.some(
                            (previous) => previous.credentialId === account.credentialId,
                          ),
                      )?.label ??
                      next?.find((account) => account.active)?.label ??
                      next?.[0]?.label;
                    if (label)
                      toastManager.add({ type: "success", title: `Signed in as ${label}` });
                    refresh();
                  }
                } else if (status === "cancelled")
                  toastManager.add({ type: "info", title: "Sign-in cancelled" });
                else setError(message ?? "Sign-in failed. Try again.");
              }}
            />
          ) : null}
          {!provider.authenticated && accounts.length === 0 && provider.acceptsKeys ? (
            <SettingsRow
              title="API key"
              description={`Paste a key from your ${provider.id} account.`}
              control={keyControl}
            />
          ) : null}
        </>
      ) : null}
      {error ? (
        <SettingsRow
          title={<ErrorText>{error}</ErrorText>}
          control={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setError(null);
                if (!accountsReady) setLoading(true);
                void loadAccounts();
              }}
            >
              Retry
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

function NativeLogin({
  environmentId,
  flowId,
  title,
  description,
  finish,
}: {
  environmentId: EnvironmentId;
  flowId: string;
  title: string;
  description?: string | undefined;
  finish: (status: "complete" | "cancelled" | "failed", message: string | null) => void;
}) {
  const state = useAtomValue(neopiModels.authChanges({ environmentId, input: { flowId } }));
  const respond = useAtomCommand(neopiModels.respondAuth, { reportFailure: false });
  const cancel = useAtomCommand(neopiModels.cancelAuth, { reportFailure: false });
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const finished = useRef(false);
  const result = AsyncResult.isSuccess(state) ? state.value : null;
  useEffect(() => {
    setValue("");
  }, [result?.prompt?.id]);
  useEffect(() => {
    if (finished.current) return;
    if (AsyncResult.isFailure(state)) {
      finished.current = true;
      finish("failed", formatEnvironmentQueryError(state.cause));
    } else if (result && result.status !== "running") {
      finished.current = true;
      finish(result.status, result.message);
    }
  }, [state, result, finish]);
  const url = result?.url && /^https?:\/\//i.test(result.url) ? result.url : null;
  return (
    <SettingsRow
      title={title}
      description={description}
      status={error ? <ErrorText>{error}</ErrorText> : (result?.message ?? undefined)}
      control={
        <div className="flex items-center gap-1.5">
          <Spinner size="sm" />
          <span className="text-xs">Waiting for browser…</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={cancelling}
            onClick={() => {
              setCancelling(true);
              void cancel({ environmentId, input: { flowId } }).then((response) => {
                if (response._tag === "Failure") {
                  const cause = squashAtomCommandFailure(response);
                  setError(cause instanceof Error ? cause.message : String(cause));
                  setCancelling(false);
                }
              });
            }}
          >
            Cancel
          </Button>
        </div>
      }
    >
      {url ? (
        <InlineButton render={<a href={url} target="_blank" rel="noreferrer noopener" />}>
          Open sign-in page
        </InlineButton>
      ) : null}
      {result?.userCode ? <Kbd>{result.userCode}</Kbd> : null}
      {result?.instructions ? (
        <p className="whitespace-pre-wrap text-xs text-muted-foreground">{result.instructions}</p>
      ) : null}
      {result?.prompt ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const prompt = result.prompt!;
            void respond({ environmentId, input: { flowId, requestId: prompt.id, value } }).then(
              (response) => {
                if (response._tag === "Failure") {
                  const cause = squashAtomCommandFailure(response);
                  setError(cause instanceof Error ? cause.message : String(cause));
                } else setValue("");
              },
            );
          }}
        >
          <label className="text-sm">
            {result.prompt.title}
            <Input
              aria-label={result.prompt.title}
              autoComplete="off"
              type={result.prompt.secret ? "password" : "text"}
              value={value}
              placeholder={result.prompt.placeholder ?? undefined}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <Button type="submit" size="sm">
            Continue
          </Button>
        </form>
      ) : null}
    </SettingsRow>
  );
}
