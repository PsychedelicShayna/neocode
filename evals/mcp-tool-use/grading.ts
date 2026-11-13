import {
  ComposerContextRecord,
  DeviceOperationError,
  DeviceSummary,
  OrchestratorMcpTaskRole,
  PullRequestState,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import { AttachmentToolkit } from "../../apps/server/src/mcp/toolkits/attachment/tools.ts";
import { DeviceToolkit } from "../../apps/server/src/mcp/toolkits/device/tools.ts";
import { EnvironmentToolkit } from "../../apps/server/src/mcp/toolkits/environment/tools.ts";
import { HtmlToolkit } from "../../apps/server/src/mcp/toolkits/html/tools.ts";
import { OrchestratorToolkit } from "../../apps/server/src/mcp/toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "../../apps/server/src/mcp/toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "../../apps/server/src/mcp/toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "../../apps/server/src/mcp/toolkits/project/tools.ts";
import { PullRequestsToolkit } from "../../apps/server/src/mcp/toolkits/pullRequests/tools.ts";
import { ThreadToolkit } from "../../apps/server/src/mcp/toolkits/thread/tools.ts";
import { WorktreeToolkit } from "../../apps/server/src/mcp/toolkits/worktree/tools.ts";
import { DeviceExpect, gradeDevice } from "./device-grading.ts";
import {
  argvForm,
  gradeSecret,
  scriptsBefore,
  UNKNOWN_SCRIPT,
  scriptSources,
  SecretExpect,
} from "./secret-grading.ts";

const T3_PREFIX = "mcp__t3-code__";

type Call = {
  readonly step: number;
  readonly tool: string;
  readonly input: unknown;
  /** The tool_use id, when the call was a tool use of its own. */
  readonly id?: string;
  /** Once answered: whether the agent saw an error, and the result text it saw. */
  failed?: boolean;
  output?: string;
};
export type SampleRun = {
  readonly calls: ReadonlyArray<Call>;
  text: string;
  stopReason: string;
  /** The agent's final answer: its last response's text, if it ended its turn. */
  readonly finalText?: string;
  /** PRs linked to the thread when the sample ends, by the agent or by T3. */
  readonly linked?: ReadonlyArray<string>;
  /** The `agent-device` commands T3's device_open returned, prior turns included. */
  readonly launchers?: ReadonlyArray<string>;
};

const Rest = [Schema.Record(Schema.String, Schema.Unknown)] as const;

const PriorToolCall = Schema.Struct({
  tool: Schema.String,
  input: Schema.Unknown,
  /** For a device tool, `"default"` runs the call on the world's devices for T3's result. */
  result: Schema.Unknown,
  /** Repository-relative file whose current contents supply this tool result. */
  resultFile: Schema.optional(Schema.String),
});

/**
 * One expected call. `args` match partially: `~text` is a case-insensitive substring,
 * `"<=N"` / `">=N"` bound a number, `null` matches a missing key, and keys may be dotted paths.
 */
const McpToolUseCall = Schema.Struct({
  tool: Schema.String,
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
type McpToolUseCall = typeof McpToolUseCall.Type;

/** Grading rules. Tool names are bare: `delegate_task`, `Bash`, `Agent`. */
const McpToolUseExpect = Schema.Struct({
  /** Each entry needs one matching call. */
  calls: Schema.optional(Schema.Array(McpToolUseCall)),
  /** Each entry matches a different call, and no call matches two entries; tool names are exact. */
  distinctCalls: Schema.optional(Schema.Array(McpToolUseCall)),
  /** No call may match any entry. */
  callsMustNot: Schema.optional(Schema.Array(McpToolUseCall)),
  notCalls: Schema.optional(Schema.Array(Schema.String)),
  /** First calls of these tools happen in this order. */
  order: Schema.optional(Schema.Array(Schema.String)),
  minCalls: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  maxCalls: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  /**
   * One `args`-style value per new top-level thread the agent asks for, by `t3_thread_launch` or a
   * `create_threads` entry. Each matches a different thread's request; no other thread is asked for.
   */
  newThreads: Schema.optional(Schema.Array(Schema.Unknown)),
  /** The last step with tool calls includes this tool, then the turn ends. */
  endsTurnAfter: Schema.optional(Schema.String),
  /**
   * Regexes that no shell command may match. In a case with `secret` checks, a command also carries
   * the source of the scripts it runs that the agent wrote earlier in the sample.
   */
  shellMustNot: Schema.optional(Schema.Array(Schema.String)),
  /** Regexes that some shell command must match, each. */
  shellMust: Schema.optional(Schema.Array(Schema.String)),
  /** Case-sensitive regexes on the agent's visible text. */
  textMust: Schema.optional(Schema.Array(Schema.String)),
  textMustNot: Schema.optional(Schema.Array(Schema.String)),
  /** Case-sensitive regexes on the final answer: the last response's text, once the turn ended. */
  finalTextMust: Schema.optional(Schema.Array(Schema.String)),
  /** Each entry matches a PR URL linked at the end, as `args` values match. */
  linked: Schema.optional(Schema.Array(Schema.String)),
  /** The PR numbers linked at the end, exactly. */
  linkedNumbers: Schema.optional(Schema.Array(Schema.Number)),
  /** Device manager checks: child briefs, simulator UI over the shell, failures, recordings. */
  device: Schema.optional(DeviceExpect),
  /**
   * Secret checks: chat asks in text and question tools, where fixture values went, and how the
   * files request_secret returned were read. See `SecretExpect` in secret-grading.ts.
   */
  secret: Schema.optional(SecretExpect),
});

/**
 * The agent's machine, as the shell simulator and the gitStatus reminder see it. Only these keys
 * are typed; others (files, diff, prs, pages) are free-form facts for the simulator.
 */
const McpToolUseWorld = Schema.StructWithRest(
  Schema.Struct({
    /** GitHub `owner/name`. Defaults to `acme/app`. */
    repo: Schema.optional(Schema.String),
    branch: Schema.optional(Schema.String),
    /** `git status --short` lines. */
    status: Schema.optional(Schema.String),
    /** Newest first. On a branch other than main, these are the commits main lacks. */
    commits: Schema.optional(
      Schema.Array(
        Schema.StructWithRest(Schema.Struct({ sha: Schema.String, subject: Schema.String }), Rest),
      ),
    ),
    /** Simulators and emulators. With them, T3's device tools answer from this world. */
    devices: Schema.optional(Schema.Array(DeviceSummary)),
    /** Labels of the SSH device hosts in `devices`, by id. The local host always exists. */
    deviceHosts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    /**
     * agent-device sessions that prior turns started, by device id, with the app `open` put in
     * each. Otherwise a device's session starts at its launcher's first `open` in the sample.
     */
    agentDeviceSessions: Schema.optional(
      Schema.Record(Schema.String, Schema.Struct({ app: Schema.optional(Schema.String) })),
    ),
    /**
     * Hosts whose hub fails to list devices, by id, with the error, such as F1's
     * `{"_tag": "DeviceOperationError", "operation": "list", "reason": "request_failed", "cause": null}`.
     * T3 marks each one failed on every call and lists none of its devices.
     */
    deviceDiscoveryFailures: Schema.optional(Schema.Record(Schema.String, DeviceOperationError)),
    /** false: agent device access is off. T3 denies every device call and drops its device text. */
    deviceAgentAccess: Schema.optional(Schema.Boolean),
    /** Every capture reaches T3 with adb screencap's warning ahead of the PNG: T3 reports 0×0. */
    deviceInvalidCapture: Schema.optional(Schema.Boolean),
    /** Devices another thread's agent-device session holds, by device id: that thread's id. */
    deviceOwners: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    /** PRs already linked to the thread, with the state T3 last saw. */
    linkedPullRequests: Schema.optional(
      Schema.Array(
        Schema.Struct({ number: Schema.Number, state: PullRequestState, title: Schema.String }),
      ),
    ),
  }),
  Rest,
);

/** One fake thread, one JSON object per line in a case file. */
export const McpToolUseCase = Schema.Struct({
  id: Schema.String,
  area: Schema.String,
  kind: Schema.Literals(["bad", "guard", "control"]),
  pattern: Schema.String,
  experience: Schema.String,
  rule: Schema.optional(Schema.String),
  privacy: Schema.optional(Schema.Literals(["commit-safe", "private"])),
  setup: Schema.Struct({
    role: Schema.Literals(["top", "delegated-child", "native-subagent"]),
    /** Runs only on this harness, for cases whose right answer depends on it. */
    harness: Schema.optional(Schema.Literals(["claude", "codex"])),
    /** The Linked environments beta is on, so T3 lists its link tools. */
    linkedEnvironments: Schema.optional(Schema.Boolean),
    /** delegate_task `role` for a delegated child. T3 builds the child's first message from it. */
    delegateRole: Schema.optional(OrchestratorMcpTaskRole),
    context: Schema.optional(Schema.String),
    priorTurns: Schema.optional(
      Schema.Array(
        Schema.Struct({
          role: Schema.Literals(["user", "assistant"]),
          text: Schema.optional(Schema.String),
          toolCalls: Schema.optional(Schema.Array(PriorToolCall)),
        }),
      ),
    ),
    world: Schema.optional(McpToolUseWorld),
    /**
     * Canned tool results by bare name, T3 or native. `"default"` uses the runner's result. For a
     * device tool, a T3 `DeviceError` (`{"_tag": ..., "cause": null}`) fails it inside T3.
     */
    mocks: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    /** Regexes on one part of a shell command. A match wins over the shell simulator. */
    shellMocks: Schema.optional(
      Schema.Array(Schema.Struct({ match: Schema.String, output: Schema.String })),
    ),
    /** The thread is a side chat's first turn: T3 puts the parent's digest ahead of `prompt`. */
    sideChat: Schema.optional(
      Schema.Struct({ parentThreadId: Schema.String, digest: Schema.Array(Schema.String) }),
    ),
  }),
  /** Empty to resume a top-level thread without side-chat context after its last tool result. */
  prompt: Schema.String,
  /** Records for the context chips `prompt` links, projected as T3 sends them. */
  promptContext: Schema.optional(Schema.Struct({ records: Schema.Array(ComposerContextRecord) })),
  expect: McpToolUseExpect,
  /** Model calls this case may need. Overrides `--max-steps`. */
  maxSteps: Schema.optional(Schema.Number),
  source: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  notes: Schema.optional(Schema.String),
});
export type McpToolUseCase = typeof McpToolUseCase.Type;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const valueText = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");
const isT3Name = (name: string) => name.startsWith(T3_PREFIX) || name.startsWith("mcp__t3_code__");
/** Grading name: T3 tools lose their MCP prefix, native tools keep the part after the last `_`. */
const CODEX_NAMES: Readonly<Record<string, string>> = {
  exec_command: "Bash",
  shell_command: "Bash",
  shell: "Bash",
  spawn_agent: "Agent",
  apply_patch: "Edit",
  request_user_input: "AskUserQuestion",
  request_user_input_async: "AskUserQuestion",
  write_stdin: "write_stdin",
  web__run: "WebFetch",
};
export const normalizeToolName = (name: string) => {
  const bare = name.slice(name.lastIndexOf(".") + 1);
  return isT3Name(bare)
    ? bare.slice(T3_PREFIX.length)
    : (CODEX_NAMES[bare] ?? bare.slice(bare.lastIndexOf("_") + 1));
};
export const normalizeToolInput = (name: string, input: unknown) => {
  const decode = t3InputDecoders.get(normalizeToolName(name));
  if (decode !== undefined) return Option.getOrElse(decode(input), () => input);
  return normalizeToolName(name) === "Bash" && isRecord(input)
    ? { ...input, command: input.command ?? input.cmd }
    : typeof input === "string" && normalizeToolName(name) === "Edit"
      ? { patch: input }
      : input;
};

const t3SourceTools: ReadonlyArray<Tool.Any> = [
  OrchestratorToolkit,
  ThreadToolkit,
  AttachmentToolkit,
  ProjectToolkit,
  EnvironmentToolkit,
  PreviewControlsToolkit,
  WorktreeToolkit,
  PullRequestsToolkit,
  PreviewToolkit,
  DeviceToolkit,
  HtmlToolkit,
].flatMap((toolkit): ReadonlyArray<Tool.Any> => Object.values(toolkit.tools));
// McpHttpServer decodes arguments with each tool's JSON codec, which drops undeclared keys.
const t3InputDecoders = new Map(
  t3SourceTools.map((tool) => [
    tool.name,
    Schema.decodeUnknownOption(
      Schema.toCodecJson(tool.parametersSchema as Schema.Codec<unknown, unknown>),
    ),
  ]),
);
const BOUND = /^([<>]=)(-?\d+(?:\.\d+)?)$/;
/**
 * Partial match: `~text` is a case-insensitive substring, `<=N` / `>=N` bound a number, and `null`
 * matches a missing or null value.
 */
const matches = (expected: unknown, actual: unknown): boolean => {
  if (expected === null) return actual === undefined || actual === null;
  const bound = typeof expected === "string" ? BOUND.exec(expected) : null;
  if (bound !== null) {
    const limit = Number(bound[2]);
    return typeof actual === "number" && (bound[1] === "<=" ? actual <= limit : actual >= limit);
  }
  if (typeof expected === "string" && expected.startsWith("~")) {
    return valueText(actual).toLowerCase().includes(expected.slice(1).toLowerCase());
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) && expected.every((item) => actual.some((at) => matches(item, at)))
    );
  }
  if (!isRecord(expected)) return expected === actual;
  const at = (path: string) =>
    path
      .split(".")
      .reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), actual);
  return Object.entries(expected).every(([path, value]) => matches(value, at(path)));
};

/** Each new top-level thread request in a run; a failed call created nothing. */
const newThreadRequests = (calls: ReadonlyArray<Call>) =>
  calls.flatMap((call): ReadonlyArray<{ request: unknown; brief: unknown }> => {
    if (call.failed === true || !isRecord(call.input)) return [];
    if (call.tool === "t3_thread_launch")
      return [{ request: call.input, brief: call.input.message }];
    if (call.tool !== "create_threads" || !Array.isArray(call.input.threads)) return [];
    return call.input.threads.map((request: unknown) => ({
      request,
      brief: isRecord(request) ? request.prompt : undefined,
    }));
  });

/** Whether every expected value can take a different request it matches. */
const matchesDistinct = (
  expected: ReadonlyArray<unknown>,
  requests: ReturnType<typeof newThreadRequests>,
  taken: ReadonlySet<number> = new Set(),
): boolean => {
  const [first, ...rest] = expected;
  if (expected.length === 0) return true;
  return requests.some(
    ({ request, brief }, i) =>
      !taken.has(i) &&
      matches(first, typeof first === "string" ? brief : request) &&
      matchesDistinct(rest, requests, new Set([...taken, i])),
  );
};

/** delegate_task takes `target.options` as an object or `[{id, value}]`. Grade both as an object. */
const withOptionsObject = (input: unknown) => {
  if (!isRecord(input) || !isRecord(input.target) || !Array.isArray(input.target.options)) {
    return input;
  }
  const options = Object.fromEntries(
    input.target.options.flatMap((option) =>
      isRecord(option) ? [[valueText(option.id), option.value]] : [],
    ),
  );
  return { ...input, target: { ...input.target, options } };
};

/** What the user wrote in the case's thread: its context, prior user turns and the prompt. */
export const pastedText = ({ prompt, setup }: Pick<McpToolUseCase, "prompt" | "setup">) =>
  [
    setup.context ?? "",
    ...(setup.priorTurns ?? []).flatMap((turn) => (turn.role === "user" ? [turn.text ?? ""] : [])),
    prompt,
  ].join("\n");

const isPageTool = (tool: string) => tool === "html_preview" || tool === "html_render";

/** `page` is the HTML a page tool shows: its inline `html`, or the file the agent wrote at `path`. */
const withPage = (tool: string, input: unknown, files: ReadonlyMap<string, string>) => {
  if (!isPageTool(tool) || !isRecord(input)) return input;
  const path = valueText(input.path);
  // A patch may name the file relative to the agent's working directory. When written files that
  // could be this one differ, the page is unknown, so page checks fail rather than grade a stale copy.
  const written = [...files].filter(
    ([file]) =>
      file === path ||
      (!file.startsWith("/") && path.endsWith(`/${file.replace(/^(?:\.\/)+/, "")}`)),
  );
  const pages = new Set(written.map(([, page]) => page));
  const page =
    typeof input.html === "string"
      ? input.html
      : pages.size === 1 && !pages.has(UNKNOWN_SCRIPT)
        ? written[0]![1]
        : undefined;
  // The grader derives `page`; a call cannot supply its own.
  return { ...input, page };
};

/** `pasted` is the thread's user text (`pastedText`), for request_secret's `value`. */
export const gradeSample = (expect: McpToolUseCase["expect"], run: SampleRun, pasted = "") => {
  const checks: Array<{ readonly check: string; readonly pass: boolean }> = [];
  const add = (check: string, pass: boolean) => checks.push({ check, pass });
  const written = scriptsBefore(run.calls, true);
  // A refused page call showed nothing, so it neither previews nor renders, and no file stands in
  // for its page. Inline HTML it sent still counts against callsMustNot.
  const attempted = run.calls.map((call, index) => ({
    ...call,
    input: withPage(
      call.tool,
      withOptionsObject(call.input),
      call.failed ? new Map() : written[index]!,
    ),
  }));
  const calls = attempted.filter((call) => !(call.failed && isPageTool(call.tool)));
  const count = (tool: string) => calls.filter((call) => call.tool === tool).length;
  // `tool` may list alternatives, as in "link_pull_request|watch_pull_request".
  const found = ({ tool, args = {} }: McpToolUseCall, among = calls) =>
    among.some((call) => tool.split("|").includes(call.tool) && matches(args, call.input));
  const label = ({ tool, args }: McpToolUseCall) => (args ? `${tool} ${valueText(args)}` : tool);
  for (const call of expect.calls ?? []) add(`calls ${label(call)}`, found(call));
  if (expect.distinctCalls !== undefined) {
    const expected = expect.distinctCalls.map(({ tool, args }) => ({ tool, input: args ?? {} }));
    add(
      "distinctCalls",
      calls.every((call) => expected.filter((entry) => matches(entry, call)).length <= 1) &&
        matchesDistinct(
          expected,
          calls.map((request) => ({ request, brief: "" })),
        ),
    );
  }
  for (const call of expect.callsMustNot ?? [])
    add(`callsMustNot ${label(call)}`, !found(call, attempted));
  // A page check must not pass because the grader never saw the file a path call shows.
  const pageTools = [...(expect.calls ?? []), ...(expect.callsMustNot ?? [])].flatMap((call) =>
    call.args?.page === undefined ? [] : call.tool.split("|"),
  );
  for (const call of calls)
    if (
      pageTools.includes(call.tool) &&
      isRecord(call.input) &&
      call.input.path !== undefined &&
      call.input.page === undefined
    )
      add(`page known ${call.tool} ${valueText(call.input.path)}`, false);
  for (const tool of expect.notCalls ?? [])
    add(`notCalls ${tool}`, !attempted.some((call) => call.tool === tool));
  if (expect.order !== undefined) {
    const firsts = expect.order.map((tool) => calls.findIndex((call) => call.tool === tool));
    const inOrder = firsts.every((at, i) => at > (firsts[i - 1] ?? -1));
    add(`order ${expect.order.join(" > ")}`, inOrder);
  }
  for (const [t, n] of Object.entries(expect.minCalls ?? {}))
    add(`minCalls ${t} >= ${n}`, count(t) >= n);
  for (const [t, n] of Object.entries(expect.maxCalls ?? {}))
    add(`maxCalls ${t} <= ${n}`, count(t) <= n);
  if (expect.newThreads !== undefined) {
    const requests = newThreadRequests(calls);
    add(
      `newThreads ${valueText(expect.newThreads)}`,
      requests.length === expect.newThreads.length && matchesDistinct(expect.newThreads, requests),
    );
  }
  if (expect.endsTurnAfter !== undefined) {
    const lastStep = Math.max(-1, ...calls.map((call) => call.step));
    const last = calls.filter((call) => call.step === lastStep).map((call) => call.tool);
    const ended = run.stopReason === "end_turn" && last.includes(expect.endsTurnAfter);
    add(`endsTurnAfter ${expect.endsTurnAfter}`, ended);
  }
  // Bash and Monitor both take a shell `command`. Secret cases also check, one by one, the scripts
  // the agent wrote and a command ran: `node run.mjs signup.mjs` after a Write of signup.mjs.
  const sources = expect.secret === undefined ? [] : scriptSources(calls);
  const shell = calls.flatMap((call, i) =>
    isRecord(call.input) && typeof call.input.command === "string"
      ? [call.input.command, ...(sources[i] ?? [])]
      : [],
  );
  const test = (pattern: string, value: string) => new RegExp(pattern).test(value);
  for (const p of expect.shellMustNot ?? [])
    add(`shellMustNot /${p}/`, !shell.some((c) => test(p, c)));
  // A positive check also reads argv lists as command lines: spawnSync('pnpm', ['exec', …]).
  for (const p of expect.shellMust ?? [])
    add(
      `shellMust /${p}/`,
      shell.some((c) => test(p, c) || test(p, argvForm(c))),
    );
  for (const p of expect.textMust ?? []) add(`textMust /${p}/`, test(p, run.text));
  for (const p of expect.textMustNot ?? []) add(`textMustNot /${p}/`, !test(p, run.text));
  for (const p of expect.finalTextMust ?? [])
    add(`finalTextMust /${p}/`, run.stopReason === "end_turn" && test(p, run.finalText ?? ""));
  const isLinked = (url: string) => (run.linked ?? []).some((at) => matches(url, at));
  for (const url of expect.linked ?? []) add(`linked ${url}`, isLinked(url));
  if (expect.linkedNumbers !== undefined) {
    const numbers = (run.linked ?? []).map((url) => Number(/(\d+)\/?$/.exec(url)?.[1]));
    const exact = valueText(numbers.toSorted((a, b) => a - b));
    add("linkedNumbers", exact === valueText(expect.linkedNumbers.toSorted((a, b) => a - b)));
  }
  checks.push(...gradeDevice(expect.device, run));
  checks.push(...gradeSecret(expect.secret, run, pasted));
  return checks;
};

// Checks that can only go from pass to fail as a sample goes on.
const SETTLED =
  /^(?:(?:notCalls|callsMustNot|shellMustNot|maxCalls|textMustNot) |secret\.(?:chatAsk|askTools|values|fileUse|noCardDemand|afterDecline) )/;
/** True once the sample has failed for good, so the rest of it cannot change the result. */
export const failedEarly = (expect: McpToolUseCase["expect"], run: SampleRun, pasted = "") =>
  gradeSample(
    expect,
    // A page call T3 has not answered yet may still be refused, so it is graded once it settles.
    {
      ...run,
      calls: run.calls.filter((call) => !isPageTool(call.tool) || call.failed !== undefined),
    },
    pasted,
  ).some((check) => !check.pass && SETTLED.test(check.check));
