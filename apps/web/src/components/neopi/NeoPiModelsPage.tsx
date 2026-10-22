import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react";
import type { EnvironmentId, NeoPiEffortRule, NeoPiEffortSelection, NeoPiModelsConfiguration, NeoPiModelsTarget, NeoPiModelsUpdate } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatEnvironmentQueryError } from "../../state/query";
import { useEscapeToGoBack, useNavigateBack } from "../../hooks/useNavigateBack";
import { ArrowLeftIcon } from "lucide-react";
import { SidebarUpdatePill } from "../sidebar/SidebarUpdatePill";
import { SidebarContent, SidebarFooter, SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarInset } from "../ui/sidebar";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { isElectron } from "../../env";
import { neopiModels, useModelsPageTarget } from "./modelsPageState";

type Configuration = NeoPiModelsConfiguration;
type Role = Configuration["roles"][number];
type Scope = "global" | "project";
function Choice({ label, value, options, onChange }: { label: string; value: string; options: ReadonlyArray<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return <label className="flex min-w-0 flex-col gap-1 text-sm"><span className="text-muted-foreground">{label}</span><Select value={value} onValueChange={value => { if (value !== null) onChange(value); }}><SelectTrigger aria-label={label}><SelectValue /></SelectTrigger><SelectPopup>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectPopup></Select></label>;
}
function ErrorText({ children }: { children: ReactNode }) { return <p role="alert" className="text-sm text-destructive">{children}</p>; }
function ModelsSnapshot({ environmentId, target, children }: { environmentId: EnvironmentId; target: NeoPiModelsTarget; children: (configuration: Configuration, refresh: () => void) => ReactNode }) {
  const atom = neopiModels.changes({ environmentId, input: target });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  if (AsyncResult.isFailure(result)) return <div className="p-4"><ErrorText>{formatEnvironmentQueryError(result.cause)}</ErrorText><Button variant="outline" size="sm" onClick={refresh}>Retry native connection</Button></div>;
  if (!AsyncResult.isSuccess(result) || result.value === null) return <p role="status" className="p-4 text-sm text-muted-foreground">Reading the native Models configuration. If this environment is disconnected, reconnect it to continue.</p>;
  return children(result.value, refresh);
}
export function NeoPiModelsSidebar() {
  const { target, environmentId, search, changeSearch } = useModelsPageTarget();
  const back = useNavigateBack();
  const section = search.section ?? "all";
  const item = (id: string, label: ReactNode, dimmed = false) => <SidebarMenuItem key={id}><SidebarMenuButton isActive={section === id} onClick={() => changeSearch({ section: id })}><span className={dimmed ? "truncate text-muted-foreground" : "truncate"}>{label}</span></SidebarMenuButton></SidebarMenuItem>;
  return (
    <>
      <SidebarContent>
        <SidebarGroup><SidebarMenu>{item("effort", "Effort rules")}</SidebarMenu></SidebarGroup>
        <SidebarGroup><SidebarMenu>{item("all", "All models")}{item("roles", "Roles")}</SidebarMenu></SidebarGroup>
        {target && environmentId ? <ModelsSnapshot environmentId={environmentId} target={target}>{configuration => <SidebarGroup><SidebarMenu>{[...configuration.providers].sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name)).map(provider => item(`provider:${provider.id}`, <span className="flex items-center gap-2"><span aria-hidden="true" data-native-icon={provider.mark.icon} className="w-6 shrink-0 text-center font-medium">{provider.mark.text}</span><span className="truncate">{provider.name}</span></span>, !provider.available))}</SidebarMenu></SidebarGroup>}</ModelsSnapshot> : null}
      </SidebarContent>
      <SidebarFooter><SidebarMenu className="flex-row items-center"><SidebarMenuItem className="min-w-0 flex-1"><SidebarMenuButton onClick={back}><ArrowLeftIcon /><span>Back</span></SidebarMenuButton></SidebarMenuItem><SidebarUpdatePill /></SidebarMenu></SidebarFooter>
    </>
  );
}
export function NeoPiModelsPage() {
  const state = useModelsPageTarget();
  const back = useNavigateBack();
  useEscapeToGoBack(back);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}><h1 className="text-sm font-semibold">Models</h1></WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <Choice label="Environment" value={state.environmentId ?? ""} options={state.environments.map(environment => ({ value: environment.environmentId, label: environment.label }))} onChange={environment => state.changeSearch({ environment, instance: undefined, project: undefined, thread: undefined })} />
              <Choice label="NeoPi connection" value={state.provider?.instanceId ?? ""} options={state.providers.map(provider => ({ value: provider.instanceId, label: provider.displayName ?? provider.instanceId }))} onChange={instance => state.changeSearch({ instance, thread: undefined })} />
              <Choice label="Project settings" value={state.projectId ?? ""} options={[{ value: "", label: "Server working directory" }, ...state.projects.map(project => ({ value: project.id, label: project.title }))]} onChange={project => state.changeSearch({ project: project || undefined, thread: undefined })} />
            </div>
            <p className="text-sm text-muted-foreground">{state.search.thread ? "Using this thread's connected native session. Choosing another project or connection leaves session-bound configuration." : "Configuration belongs to NeoPi. Changes use its saved scopes and update connected native clients."}</p>
            {state.target && state.environmentId ? (
              <ModelsSnapshot environmentId={state.environmentId} target={state.target}>
                {(configuration, refresh) => <ModelsContent key={JSON.stringify([state.environmentId, state.target])} environmentId={state.environmentId!} target={state.target!} section={state.search.section ?? "all"} configuration={configuration} refresh={refresh} />}
              </ModelsSnapshot>
            ) : <ErrorText>No enabled NeoPi connection is available in this environment. Configure its executable and profile in NeoCore.</ErrorText>}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
function ModelsContent({ environmentId, target, section, configuration, refresh }: { environmentId: EnvironmentId; target: NeoPiModelsTarget; section: string; configuration: Configuration; refresh: () => void }) {
  const update = useAtomCommand(neopiModels.update, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assignment, setAssignment] = useState<{ role: Role | null; selector: string } | null>(null);
  const [query, setQuery] = useState("");
  const [rulesRevision, setRulesRevision] = useState(0);
  const save = async (change: NeoPiModelsUpdate["change"]) => {
    setPending(true); setError(null);
    try {
      const result = await update({ environmentId, input: { target, change } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      refresh(); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "NeoPi rejected this configuration change."); return false; }
    finally { setPending(false); }
  };
  const provider = section.startsWith("provider:") ? configuration.providers.find(provider => provider.id === section.slice(9)) : null;
  const models = configuration.models.filter(model => (!provider || model.provider === provider.id) && `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{section === "roles" ? "Roles" : section === "effort" ? "Effort rules" : provider?.name ?? "All models"}</h2>
        <Button variant="outline" size="sm" onClick={refresh}>Refresh native state</Button>
      </div>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {provider ? <ProviderAccounts key={provider.id} environmentId={environmentId} target={target} provider={provider} refresh={refresh} save={save} pending={pending} /> : null}
      {assignment ? <RoleEditor key={`${assignment.role?.id ?? "new"}:${assignment.selector}`} configuration={configuration} initial={assignment} pending={pending} save={async change => { if (await save(change)) setAssignment(null); }} close={() => setAssignment(null)} /> : null}
      {section === "effort" ? (
        <RulesEditor key={rulesRevision} configuration={configuration} pending={pending} save={async change => { if (await save(change)) setRulesRevision(value => value + 1); }} />
      ) : section === "roles" ? (
        <>
          <Choice label="Native role storage" value={configuration.roleStorage} options={[{ value: "global", label: "Global" }, { value: "project", label: "Project with global fallback" }]} onChange={value => { if (!pending) void save({ operation: "storage", value: value as Scope, expected: configuration.roleStorage }); }} />
          <div><Button variant="outline" size="sm" onClick={() => setAssignment({ role: null, selector: "" })}>Create role</Button></div>
          <div className="divide-y divide-border">
            {configuration.roles.map(role => (
              <div key={role.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="font-medium">{role.name} <span className="text-sm font-normal text-muted-foreground">{role.alias}</span></p>
                  {role.description ? <p className="mt-1 text-sm text-muted-foreground">{role.description}</p> : null}
                  <p className="break-all text-sm">{role.configured ?? "Native automatic selection"}</p>
                  <p className="text-xs text-muted-foreground">{role.provenance}{role.resolved ? ` • ${role.resolved.provider}/${role.resolved.modelId}${role.resolved.thinkingLevel ? ` • ${role.resolved.thinkingLevel}` : ""}` : " • Unresolved"}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setAssignment({ role, selector: role.configured ?? "" })}>Configure</Button>
              </div>
            ))}
          </div>
        </>
      ) : section.startsWith("provider:") && !provider ? (
        <ErrorText>This provider is no longer in the native catalog. Choose another provider or All models.</ErrorText>
      ) : (
        <>
          <Input aria-label="Filter native models" placeholder="Filter models" value={query} onChange={event => setQuery(event.target.value)} />
          <div className="overflow-x-auto">
            <div role="table" aria-label="Native models" aria-rowcount={models.length + 1} className="min-w-[48rem] text-sm">
              <div role="row" className="grid grid-cols-[2fr_1fr_1fr_1fr_auto] gap-4 pb-2 text-xs text-muted-foreground">
                <span role="columnheader">Native model</span><span role="columnheader">Effective / native context / output</span><span role="columnheader">Input / output per million</span><span role="columnheader">Efforts</span><span role="columnheader">Role</span>
              </div>
              <LegendList data={models} keyExtractor={model => `${model.provider}/${model.id}`} estimatedItemSize={88} drawDistance={200} recycleItems={false} maintainVisibleContentPosition={false} style={{ height: Math.min(models.length * 88, 600) }} renderItem={({ item: model, index }) => (
                <div role="row" aria-rowindex={index + 2} className="grid grid-cols-[2fr_1fr_1fr_1fr_auto] items-center gap-4 border-t border-border py-3">
                  <div role="cell" className="min-w-0"><p className="font-medium">{model.name}</p><p className="break-all text-xs text-muted-foreground">{model.provider}/{model.id}</p><p className="text-xs text-muted-foreground">{model.kind}{!model.available ? " • Not connected" : ""}{model.supportsFastMode ? " • Native fast mode" : ""}</p></div>
                  <div role="cell" className="tabular-nums">{model.effectiveContextWindow.toLocaleString()} / {model.contextWindow.toLocaleString()} / {model.maxTokens.toLocaleString()}</div>
                  <div role="cell" className="tabular-nums">${model.cost.input} / ${model.cost.output}</div>
                  <div role="cell" className="text-xs">{model.permittedEfforts.join(", ") || "No controllable effort"}</div>
                  <div role="cell"><Button variant="outline" size="sm" onClick={() => setAssignment({ role: null, selector: `${model.provider}/${model.id}` })}>Assign role</Button></div>
                </div>
              )} />
            </div>
            {models.length === 0 ? <p className="py-5 text-sm text-muted-foreground">No native models match this view.</p> : null}
          </div>
        </>
      )}
    </div>
  );
}
function EffortChoices({ choices, selected, onChange }: { choices: ReadonlyArray<string>; selected: ReadonlyArray<string>; onChange: (next: string[]) => void }) {
  return <div className="flex flex-wrap gap-x-4 gap-y-2">{choices.map(choice => <label key={choice} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(choice)} onChange={event => onChange(event.target.checked ? [...selected, choice] : selected.filter(value => value !== choice))} />{choice}</label>)}</div>;
}
function RoleEditor({ configuration, initial, pending, save, close }: { configuration: Configuration; initial: { role: Role | null; selector: string }; pending: boolean; save: (change: NeoPiModelsUpdate["change"]) => Promise<void>; close: () => void }) {
  const [roleId, setRoleId] = useState(initial.role?.id ?? "");
  const [scope, setScope] = useState<Scope>("global");
  const role = configuration.roles.find(role => role.id === roleId);
  const [expected, setExpected] = useState(initial.role?.global ?? { selector: null, effort: null });
  const [selector, setSelector] = useState(initial.role?.global.selector ?? initial.selector);
  const [mode, setMode] = useState(initial.role?.global.effort?.mode ?? "selector");
  const [level, setLevel] = useState(initial.role?.global.effort?.mode === "fixed" ? initial.role.global.effort.level : configuration.effortChoices[0] ?? "off");
  const [allowed, setAllowed] = useState<ReadonlyArray<string>>(initial.role?.global.effort?.mode === "auto" ? initial.role.global.effort.allowed ?? configuration.effortChoices : configuration.effortChoices);
  const load = (id: string, nextScope: Scope) => {
    const value = configuration.roles.find(role => role.id === id)?.[nextScope] ?? { selector: null, effort: null };
    setRoleId(id); setScope(nextScope); setExpected(value); setSelector(initial.role ? value.selector ?? "" : initial.selector || value.selector || "");
    setMode(value.effort?.mode ?? "selector");
    if (value.effort?.mode === "fixed") setLevel(value.effort.level);
    setAllowed(value.effort?.mode === "auto" ? value.effort.allowed ?? configuration.effortChoices : configuration.effortChoices);
  };
  const effort: NeoPiEffortSelection | undefined = mode === "fixed" ? { mode: "fixed", level } : mode === "auto" ? { mode: "auto", allowed, selector } : mode === "inherit" ? { mode: "inherit" } : undefined;
  return <section className="flex flex-col gap-4 border-y border-border py-5"><h3 className="font-medium">Assign a native role</h3><div className="grid gap-3 sm:grid-cols-2"><label className="flex flex-col gap-1 text-sm">Role name<Input aria-label="Role name" value={roleId} list="native-role-names" onChange={event => load(event.target.value, scope)} /><datalist id="native-role-names">{configuration.roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</datalist></label><Choice label="Save scope" value={scope} options={[{ value: "global", label: "Global" }, ...(configuration.roleStorage === "project" ? [{ value: "project", label: "Project" }] : [])]} onChange={value => load(roleId, value as Scope)} /></div>{role?.description ? <p className="text-sm text-muted-foreground">{role.description}</p> : null}<label className="flex flex-col gap-1 text-sm">Model or native selector<Input aria-label="Model or native selector" value={selector} onChange={event => setSelector(event.target.value)} placeholder="provider/model, glob, @role or re:expression" /></label><p className="text-xs text-muted-foreground">Native NeoPi validates and resolves this single selector. Clearing this scope restores its inherited selection.</p><Choice label="Effort policy" value={mode} options={[{ value: "selector", label: "From selector or native default" }, { value: "inherit", label: "Inherit" }, { value: "fixed", label: "Fixed effort" }, { value: "auto", label: "Auto within allowed efforts" }]} onChange={setMode} />{mode === "fixed" ? <Choice label="Fixed effort" value={level} options={configuration.effortChoices.map(value => ({ value, label: value }))} onChange={setLevel} /> : mode === "auto" ? <EffortChoices choices={configuration.effortChoices} selected={allowed} onChange={setAllowed} /> : null}<div className="flex flex-wrap gap-2"><Button disabled={pending || !roleId.trim() || !selector.trim() || mode === "auto" && allowed.length === 0} onClick={() => void save({ operation: "role", role: roleId, scope, selector, ...(effort ? { effort } : {}), expected })}>Save role</Button><Button variant="outline" disabled={pending || !roleId.trim()} onClick={() => void save({ operation: "role", role: roleId, scope, expected })}>Clear this scope</Button><Button variant="ghost" onClick={close}>Cancel</Button></div></section>;
}
function RulesEditor({ configuration, pending, save }: { configuration: Configuration; pending: boolean; save: (change: NeoPiModelsUpdate["change"]) => Promise<void> }) {
  const [scope, setScope] = useState<Scope>("global");
  const [expected, setExpected] = useState(configuration.effortRuleScopes.global);
  const [rules, setRules] = useState<ReadonlyArray<NeoPiEffortRule>>(configuration.effortRuleScopes.global ?? []);
  const replace = (index: number, rule: NeoPiEffortRule) => setRules(current => current.map((value, at) => at === index ? rule : value));
  return <div className="flex flex-col gap-4"><p className="text-sm text-muted-foreground">Native policy: {configuration.effortMode}. Effective rules come from {configuration.effortRulesProvenance}. Exact matches take precedence over regular expressions, then globs. Native order decides ties.</p><Choice label="Rule save scope" value={scope} options={[{ value: "global", label: "Global" }, { value: "project", label: "Project" }]} onChange={value => { const next = value as Scope; setScope(next); setExpected(configuration.effortRuleScopes[next]); setRules(configuration.effortRuleScopes[next] ?? []); }} />{rules.map((rule, index) => <div key={index} className="flex flex-col gap-3 border-b border-border py-4"><Input aria-label={`Rule ${index + 1} selector`} value={rule.selector} placeholder="provider/model, glob or re:expression" onChange={event => replace(index, { ...rule, selector: event.target.value })} /><EffortChoices choices={configuration.effortChoices} selected={rule.allowed} onChange={allowed => replace(index, { ...rule, allowed })} /><div className="flex gap-2"><Button variant="outline" size="sm" disabled={index === 0} onClick={() => setRules(current => { const next = [...current]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; return next; })}>Move up</Button><Button variant="outline" size="sm" disabled={index === rules.length - 1} onClick={() => setRules(current => { const next = [...current]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!]; return next; })}>Move down</Button><Button variant="ghost" size="sm" onClick={() => setRules(current => current.filter((_, at) => at !== index))}>Remove</Button></div></div>)}<div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setRules(current => [...current, { selector: "", allowed: [...configuration.effortChoices] }])}>Add rule</Button><Button disabled={pending || rules.some(rule => !rule.selector.trim() || rule.allowed.length === 0)} onClick={() => void save({ operation: "rules", scope, rules, expected })}>Save rules</Button><Button variant="outline" disabled={pending} onClick={() => void save({ operation: "rules", scope, expected })}>Clear this scope</Button></div></div>;
}
function ProviderAccounts({ environmentId, target, provider, pending, refresh, save }: { environmentId: EnvironmentId; target: NeoPiModelsTarget; provider: Configuration["providers"][number]; pending: boolean; refresh: () => void; save: (change: NeoPiModelsUpdate["change"]) => Promise<boolean> }) {
  const accountsCommand = useAtomCommand(neopiModels.accounts, { reportFailure: false });
  const startAuth = useAtomCommand(neopiModels.startAuth, { reportFailure: false });
  const cancelAuth = useAtomCommand(neopiModels.cancelAuth, { reportFailure: false });
  const [accounts, setAccounts] = useState<ReadonlyArray<{ credentialId: number; label: string; detail: string; active: boolean }>>([]);
  const [key, setKey] = useState("");
  const [flowId, setFlowId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const loadAccounts = async () => {
    const result = await accountsCommand({ environmentId, input: { target, providerId: provider.id } });
    if (!mounted.current) return;
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else setAccounts(result.value.accounts);
  };
  const login = async (providerId: string) => {
    setError(null);
    const result = await startAuth({ environmentId, input: { target, providerId } });
    if (result._tag === "Failure") { if (mounted.current) setError(String(squashAtomCommandFailure(result))); return; }
    if (!mounted.current) { void cancelAuth({ environmentId, input: result.value }); return; }
    setFlowId(result.value.flowId);
  };
  return <section className="flex flex-col gap-3 border-b border-border pb-5"><p className="text-sm">{provider.disabled ? "Disabled in native NeoPi settings" : provider.authSource ?? (provider.available ? "Native models available without stored credentials" : "Not connected")}</p>{provider.envVars.length ? <p className="text-xs text-muted-foreground">Native environment keys: {provider.envVars.join(", ")}</p> : null}{error ? <ErrorText>{error}</ErrorText> : null}<div className="flex flex-wrap gap-2">{provider.loginProviders.map(loginProvider => <Button key={loginProvider.id} variant="outline" size="sm" disabled={!loginProvider.available || flowId !== null} onClick={() => void login(loginProvider.id)}>Log in to {loginProvider.name}</Button>)}<Button variant="outline" size="sm" onClick={() => void loadAccounts()}>Show native accounts</Button></div>{flowId ? <NativeLogin key={flowId} environmentId={environmentId} flowId={flowId} refresh={refresh} close={() => { setFlowId(null); void loadAccounts(); }} /> : null}<div className="flex flex-col gap-2 sm:flex-row"><div className="min-w-0 flex-1"><Input aria-label={`Native ${provider.name} API key`} type="password" autoComplete="off" value={key} placeholder="API key stored by NeoPi" onChange={event => setKey(event.target.value)} /></div><Button variant="outline" disabled={pending || !key.trim()} onClick={() => { const apiKey = key; setKey(""); void save({ operation: "key", providerId: provider.id, apiKey }); }}>Save native key</Button></div>{accounts.map(account => <div key={account.credentialId} className="flex items-center justify-between gap-3 text-sm"><div><p>{account.label}{account.active ? " • Active in native session" : ""}</p><p className="text-xs text-muted-foreground">{account.detail}</p></div><Button variant="outline" size="sm" disabled={pending} onClick={() => void save({ operation: "logout", providerId: provider.id, credentialId: account.credentialId }).then(saved => { if (saved) void loadAccounts(); })}>Remove this account</Button></div>)}</section>;
}
function NativeLogin({ environmentId, flowId, refresh, close }: { environmentId: EnvironmentId; flowId: string; refresh: () => void; close: () => void }) {
  const state = useAtomValue(neopiModels.authChanges({ environmentId, input: { flowId } }));
  const respond = useAtomCommand(neopiModels.respondAuth, { reportFailure: false });
  const cancel = useAtomCommand(neopiModels.cancelAuth, { reportFailure: false });
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const result = AsyncResult.isSuccess(state) ? state.value : null;
  useEffect(() => { setValue(""); }, [result?.prompt?.id]);
  useEffect(() => { if (result?.status === "complete") refresh(); }, [result?.status, refresh]);
  if (AsyncResult.isFailure(state)) return <div><ErrorText>{formatEnvironmentQueryError(state.cause)}</ErrorText><Button variant="outline" onClick={close}>Close login</Button></div>;
  const url = result?.url && /^https?:\/\//i.test(result.url) ? result.url : null;
  return <div className="flex flex-col gap-3 border-y border-border py-4"><p className="text-sm">{result?.message ?? "Waiting for native login"}</p>{url ? <a className="break-all text-sm underline" href={url} target="_blank" rel="noreferrer noopener">Open native authorization page</a> : null}{result?.instructions ? <p className="whitespace-pre-wrap text-sm text-muted-foreground">{result.instructions}</p> : null}{error ? <ErrorText>{error}</ErrorText> : null}{result?.prompt ? <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); const prompt = result.prompt!; const answer = value; setValue(""); void respond({ environmentId, input: { flowId, requestId: prompt.id, value: answer } }).then(response => { if (response._tag === "Failure") setError(String(squashAtomCommandFailure(response))); }); }}><label className="text-sm">{result.prompt.title}<Input autoComplete="off" type={result.prompt.secret ? "password" : "text"} value={value} placeholder={result.prompt.placeholder ?? undefined} onChange={event => setValue(event.target.value)} /></label><div><Button type="submit">Send to native login</Button></div></form> : null}<div><Button variant="outline" onClick={() => { if (!result || result.status === "running") void cancel({ environmentId, input: { flowId } }).then(response => { if (response._tag === "Failure") setError(String(squashAtomCommandFailure(response))); }); else close(); }}>{!result || result.status === "running" ? "Cancel login" : "Close login"}</Button></div></div>;
}
