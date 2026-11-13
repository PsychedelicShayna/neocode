import type {
  ModelSelection,
  OrchestrationV2ThreadShell,
  ServerProvider,
} from "@t3tools/contracts";

/** Native catalogs may contain private deployments; only reviewed public labels leave the host. */
const VENDOR_CATALOG_DRIVERS: ReadonlySet<string> = new Set([
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "antigravity",
  "neopi",
]);

export interface ProviderDimensions {
  readonly provider: string;
  readonly model?: string;
}

/**
 * Anonymous provider and model for a model selection. Instance ids are
 * user-defined, so only the driver kind is reported. The model is reported
 * only when its non-custom catalog entry matches a reviewed public label.
 */
export function providerDimensions(
  providers: ReadonlyArray<ServerProvider>,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): ProviderDimensions {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (provider === undefined) return { provider: "unknown" };
  const model = provider.models.find((candidate) => candidate.slug === selection.model);
  const label =
    VENDOR_CATALOG_DRIVERS.has(provider.driver) && model !== undefined && !model.isCustom
      ? catalogModelLabel(model.slug)
      : undefined;
  return label === undefined
    ? { provider: provider.driver }
    : { provider: provider.driver, model: label };
}

const DATED_SNAPSHOT = /-\d{8}$/u;

// Privacy allowlist extracted from upstream v0.1.8, not a picker, price list, or execution catalog.
// New native models remain unreported until their public names have been reviewed.
const PUBLIC_MODEL_NAMES: ReadonlyArray<readonly [string, ...string[]]> = [
  ["gpt-6.1-sol"],
  ["gpt-6-astra"],
  ["gpt-6-luna"],
  ["gpt-6-sol"],
  ["gpt-5.6-sol"],
  ["gpt-5.6-terra"],
  ["gpt-5.6-luna"],
  ["gpt-5.5"],
  ["gpt-5.4-mini"],
  ["gpt-5.3-codex-spark"],
  ["claude-opus-5-5", "opus", "opus-5.5", "claude-opus-5.5"],
  ["claude-sonnet-5-5", "sonnet", "sonnet-5.5", "claude-sonnet-5.5"],
  ["claude-fable-5-2", "fable", "fable-5.2", "claude-fable-5.2"],
  ["claude-fable-5-1", "fable-5.1", "claude-fable-5.1"],
  ["claude-fable-5"],
  ["claude-opus-5", "opus-5", "claude-opus-5.0", "claude-opus-5-0"],
  ["claude-opus-4-8", "opus-4.8", "claude-opus-4.8"],
  ["claude-opus-4-7", "opus-4.7", "claude-opus-4.7"],
  ["claude-opus-4-6", "opus-4.6", "claude-opus-4.6", "claude-opus-4-6-20251117"],
  ["claude-opus-4-5"],
  ["claude-sonnet-5", "sonnet-5", "claude-sonnet-5.0", "claude-sonnet-5-0"],
  ["claude-sonnet-4-6", "sonnet-4.6", "claude-sonnet-4.6", "claude-sonnet-4-6-20251117"],
  ["claude-haiku-5-5", "haiku", "haiku-5.5", "claude-haiku-5.5"],
  ["claude-haiku-4-5", "haiku-4.5", "claude-haiku-4.5", "claude-haiku-4-5-20251001"],
  ["gemini-3.8-flash-high"],
  ["gemini-3.8-flash-medium"],
  ["gemini-3.8-flash-low"],
  ["gemini-3.7-flash-high"],
  ["gemini-3.7-flash-medium"],
  ["gemini-3.7-flash-low"],
  ["gemini-3.6-flash-high"],
  ["gemini-3.6-flash-medium"],
  ["gemini-3.6-flash-low"],
  ["gemini-pro-agent"],
  ["gemini-3.1-pro-low"],
];
const PUBLIC_MODEL_LABELS: ReadonlyMap<string, string> = new Map(
  PUBLIC_MODEL_NAMES.flatMap((names) => names.map((name) => [name, names[0]] as const)),
);

/**
 * The reviewed public label for a native or routed model ID, including dated snapshots.
 * Never trust discovery alone: even a non-custom native entry can name a private deployment.
 */
export function catalogModelLabel(model: string): string | undefined {
  const leaf = model.slice(model.lastIndexOf("/") + 1);
  const candidates = [model, leaf, leaf.replace(DATED_SNAPSHOT, "")];
  for (const candidate of candidates) {
    const label = PUBLIC_MODEL_LABELS.get(candidate);
    if (label !== undefined) return label;
  }
  return undefined;
}

/** The thread fields agent analytics reads. Ids are used for lookups, never reported. */
export type AgentThread = Pick<
  OrchestrationV2ThreadShell,
  "modelSelection" | "runtimeMode" | "interactionMode" | "createdBy" | "creationSource" | "lineage"
>;

type Fields = Readonly<Record<string, unknown>>;

const asFields = (value: unknown): Fields =>
  typeof value === "object" && value !== null ? (value as Fields) : {};

const stringField = (fields: Fields, key: string) =>
  typeof fields[key] === "string" ? (fields[key] as string) : undefined;

/** A string from the tool input only when it is one of the schema's literals. */
const oneOf = (value: string | undefined, allowed: ReadonlyArray<string>) =>
  value !== undefined && allowed.includes(value) ? value : undefined;

/**
 * Whether two resolved providers differ. Unresolved selections compare as
 * unknown rather than as a cross-provider handoff.
 */
export const crossProvider = (caller: string, target: string) =>
  caller === "unknown" || target === "unknown" ? undefined : caller !== target;

const defined = (entries: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));

/**
 * How deep a thread sits in a delegation tree: 0 for a top-level thread, 1 for
 * its subagent, and so on. Forks are top-level threads of their own. Depth is
 * counted by walking parents, capped so a corrupt lineage cannot loop.
 */
export const MAX_REPORTED_DEPTH = 5;

/**
 * Who started the work that made this call. Scheduled runs keep the task
 * creator's provenance, so the run's message marks them instead.
 */
function callerOrigin(input: {
  readonly thread: Pick<AgentThread, "createdBy">;
  readonly scheduledRun: boolean;
}) {
  if (input.scheduledRun) return "scheduler";
  if (input.thread.createdBy === "agent") return "agent";
  return input.thread.createdBy === "system" ? "system" : "user";
}

/**
 * Settings the agent chose for a handoff, read only from closed enums and
 * booleans in the tool's arguments and result. Prompts, titles, and ids are
 * never read.
 */
export function handoffSettings(tool: string, args: unknown, result: unknown): Fields {
  const input = asFields(args);
  const output = asFields(result);
  switch (tool) {
    case "delegate_task":
      return defined({
        targetChosen: input.target !== undefined,
        // Rejected calls are recorded too, so input strings must match a literal.
        mode: oneOf(stringField(input, "mode"), ["async", "wait"]) ?? "async",
        ...(output.waitTimedOut === true ? { waitTimedOut: true } : {}),
      });
    case "create_threads": {
      const threads = Array.isArray(input.threads) ? input.threads : [];
      return {
        batchSize: threads.length,
        targetChosen: threads.some((thread) => asFields(thread).target !== undefined),
      };
    }
    case "t3_thread_launch":
      return defined({
        targetChosen: input.modelSelection !== undefined,
        workspace:
          input.scratch === true
            ? "scratch"
            : (oneOf(stringField(asFields(input.workspaceStrategy), "type"), [
                "root",
                "worktree",
                "existing_worktree",
              ]) ?? "root"),
      });
    case "t3_thread_send":
      return defined({ delivery: stringField(output, "delivery") });
    case "t3_thread_send_attachments":
      return { delivery: "auto" };
    case "schedule_task":
      return { bindToCurrentThread: input.bindToCurrentThread !== false };
    default:
      return {};
  }
}

/** Outcome of a tool call, with the stable failure code when the call failed. */
export function toolOutcome(
  result:
    | { readonly isError?: boolean | undefined; readonly structuredContent?: unknown }
    | undefined,
) {
  if (result === undefined) return { outcome: "error", errorCode: "exception" };
  const content = asFields(result.structuredContent);
  // T3 tool failures are declared errors whose structured content carries a
  // closed `code`; the MCP layer does not always set isError for them.
  const code = stringField(content, "code") ?? stringField(asFields(content.error), "_tag");
  if (result.isError === true || (content._tag !== undefined && code !== undefined)) {
    return { outcome: "error", errorCode: code ?? "unknown" };
  }
  return { outcome: "ok" };
}

/**
 * Event properties for an agent tool call: the calling agent, and when the call
 * handed work to other threads, the agents running them. Each target counts
 * once, so a create_threads batch on two providers reports both.
 */
export function agentToolProperties(input: {
  readonly tool: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly caller: AgentThread | undefined;
  readonly callerProviderInstanceId?: ModelSelection["instanceId"];
  readonly callerDepth?: number;
  readonly callerScheduledRun?: boolean;
  readonly targets: ReadonlyArray<AgentThread>;
  readonly outcome: Fields;
  readonly settings?: Fields;
  readonly durationMs?: number;
}): ReadonlyArray<Readonly<Record<string, unknown>>> {
  const caller =
    input.caller !== undefined
      ? providerDimensions(input.providers, input.caller.modelSelection)
      : input.callerProviderInstanceId !== undefined
        ? {
            provider: providerDimensions(input.providers, {
              instanceId: input.callerProviderInstanceId,
              model: "",
            }).provider,
          }
        : { provider: "unknown" };
  const base = defined({
    tool: input.tool,
    callerProvider: caller.provider,
    callerModel: caller.model,
    callerOrigin:
      input.caller === undefined
        ? undefined
        : callerOrigin({
            thread: input.caller,
            scheduledRun: input.callerScheduledRun === true,
          }),
    callerDepth:
      input.callerDepth === undefined ? undefined : Math.min(input.callerDepth, MAX_REPORTED_DEPTH),
    durationMs: input.durationMs,
    ...input.outcome,
    ...input.settings,
  });
  if (input.targets.length === 0) return [base];
  return input.targets.map((thread) => {
    const target = providerDimensions(input.providers, thread.modelSelection);
    return defined({
      ...base,
      targetProvider: target.provider,
      targetModel: target.model,
      targetRuntimeMode: thread.runtimeMode,
      targetInteractionMode: thread.interactionMode,
      crossProvider: crossProvider(caller.provider, target.provider),
    });
  });
}
