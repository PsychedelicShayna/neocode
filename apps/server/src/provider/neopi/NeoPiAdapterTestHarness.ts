import { assert } from "@effect/vitest";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type NeoPiSettings,
  type RuntimeMode,
} from "@t3tools/contracts";
import {
  ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import { makeNeoPiAdapter } from "./NeoPiAdapterLive.ts";
import { makeNeoPiDiscoveryHub } from "./NeoPiDiscovery.ts";
import { makeNeoPiSessionRuntime } from "./NeoPiSessionRuntime.ts";
import type { NeoPiSessionRuntimeShape } from "./NeoPiRuntimeTypes.ts";
import {
  answer,
  commandArguments,
  defaultReady,
  testPeer,
  type Command,
  type Emitter,
} from "./NeoPiTestPeer.ts";

const decodeProviderEvent = Schema.decodeEffect(ProviderAdapterV2Event);

interface NativeEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: "message";
  readonly message: { readonly role: "user" | "assistant"; readonly content: unknown };
}
interface NativeMemory {
  readonly id: string;
  readonly file: string;
  entries: NativeEntry[];
  leafId?: string | null;
  mode: "default" | "plan";
  chatMode: "off" | "chat" | "erp" | "raw";
  model: { provider: string; id: string };
  streaming: boolean;
}

const settings: NeoPiSettings = {
  enabled: true,
  binaryPath: "npi",
  profile: "",
  launchArgs: "",
  customModels: [],
};
export const threadId = ThreadId.make("native-adapter-regression");
export const instanceId = ProviderInstanceId.make("neopi-regression");
export const modelSelection: ModelSelection = { instanceId, model: "fixture/test" };

export const makeNativeAdapterHarness = Effect.fn("makeNativeAdapterHarness")(function* (
  capabilities: readonly string[] = [
    "prompt_entry_ids",
    "set_mode",
    "set_chat_mode",
    "get_usage",
    "plan_proposal_cancel",
  ],
  options: {
    makeRuntime?: NonNullable<Parameters<typeof makeNeoPiAdapter>[0]["makeRuntime"]>;
    runtimeMode?: RuntimeMode;
    mcpTools?: Layer.Layer<never>;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "neopi-v2-adapter-" });
  const memories = new Map<string, NativeMemory>();
  const emitters = new Map<string, Emitter>();
  const runtimeInputs: Parameters<typeof makeNeoPiSessionRuntime>[0][] = [];
  const runtimes: NeoPiSessionRuntimeShape[] = [];
  const launches: string[][] = [];
  const processIsRunning: Array<ChildProcessSpawner.ChildProcessHandle["isRunning"]> = [];
  const processExits: Array<(signal: string | null) => Effect.Effect<void>> = [];
  const commands: Command[] = [];
  const prompts: string[] = [];
  const promptModels: string[] = [];
  const responses: Command[] = [];
  const proposed: Array<{ decision: unknown; feedback: unknown }> = [];
  const observed: ProviderAdapterV2Event[] = [];
  const inbox = yield* Queue.unbounded<ProviderAdapterV2Event>();
  let memory: NativeMemory | undefined;
  let emitCurrent: Emitter | undefined;
  let nativeSequence = 0;
  let entrySequence = 0;
  let proposalId: string | undefined;
  let rejectPrompt: string | undefined;
  let afterBranchFailure: "state" | "history" | "transcript" | undefined;
  let branched = false;
  let promptGate: Effect.Effect<void> = Effect.void;
  let onPrompt: Effect.Effect<void> = Effect.void;
  let startupQuestion: { kind: "approval" | "user-input"; fail: boolean } | undefined;
  let startupFails = false;
  let startupState: Command | undefined;
  const native = (sessionFile?: string) => {
    const state = sessionFile ? memories.get(sessionFile) : memory;
    if (!state) throw new Error("Native runtime has not started");
    return state;
  };
  const emit = (frame: unknown, sessionFile?: string) => {
    const write = sessionFile ? emitters.get(sessionFile) : emitCurrent;
    if (!write) throw new Error("Native runtime has not started");
    return write(frame);
  };
  const append = (role: "user" | "assistant", content: unknown, state = native()) => {
    const row: NativeEntry = {
      id: `entry-${++entrySequence}`,
      parentId: state.leafId !== undefined ? state.leafId : (state.entries.at(-1)?.id ?? null),
      type: "message",
      message: { role, content },
    };
    state.entries.push(row);
    state.leafId = row.id;
    return row;
  };
  const handler = Effect.fn("NativeAdapterHarness.handleCommand")(function* (
    context: { current: NativeMemory },
    cmd: Command,
    write: Emitter,
  ) {
    commands.push(cmd);
    if (cmd.type === "negotiate_protocol") return yield* answer(cmd, write, { protocolVersion: 2 });
    const state = context.current;
    if (cmd.type === "get_state") {
      if (startupQuestion) {
        const question = startupQuestion;
        startupQuestion = undefined;
        startupFails = question.fail;
        startupState = cmd;
        yield* write(
          question.kind === "approval"
            ? {
                type: "extension_ui_request",
                id: "startup-permission",
                method: "select",
                title: "Allow tool: bash",
                options: ["Approve", "Deny"],
              }
            : {
                type: "extension_ui_request",
                id: "startup-permission",
                method: "confirm",
                title: "Continue startup?",
              },
        );
        return;
      }
      if (branched && afterBranchFailure === "state") {
        afterBranchFailure = undefined;
        return yield* write({
          type: "response",
          id: cmd.id,
          command: cmd.type,
          success: false,
          error: "state unavailable",
        });
      }
      return yield* answer(cmd, write, {
        sessionId: state.id,
        sessionFile: state.file,
        messageCount: state.entries.length,
        mode: state.mode,
        chatMode: state.chatMode,
        isStreaming: state.streaming,
        model: state.model,
      });
    }
    if (cmd.type === "get_entries") {
      if (branched && afterBranchFailure === "history") {
        afterBranchFailure = undefined;
        return yield* write({
          type: "response",
          id: cmd.id,
          command: cmd.type,
          success: false,
          error: "history unavailable",
        });
      }
      return yield* answer(cmd, write, {
        entries: state.entries,
        leafId: state.leafId !== undefined ? state.leafId : (state.entries.at(-1)?.id ?? null),
      });
    }
    if (cmd.type === "get_messages_page")
      return yield* answer(cmd, write, {
        messages: state.entries.map((row) =>
          capabilities.includes("prompt_entry_ids")
            ? { ...row.message, entryId: row.id }
            : row.message,
        ),
      });
    if (cmd.type === "navigate_tree") {
      const leafId = state.leafId !== undefined ? state.leafId : (state.entries.at(-1)?.id ?? null);
      if (
        cmd.expectedSessionId !== state.id ||
        cmd.expectedSessionFile !== state.file ||
        cmd.expectedLeafId !== leafId ||
        !state.entries.some((entry) => entry.id === cmd.targetId)
      )
        return yield* write({
          type: "response",
          id: cmd.id,
          command: cmd.type,
          success: false,
          error: "stale native navigation",
        });
      state.leafId = String(cmd.targetId);
      return yield* answer(cmd, write, {
        sessionId: state.id,
        sessionFile: state.file,
        leafId: state.leafId,
        outcome: "navigated",
        cancelled: false,
      });
    }
    if (cmd.type === "set_model") {
      state.model = { provider: String(cmd.provider), id: String(cmd.modelId) };
      return yield* answer(cmd, write);
    }
    if (cmd.type === "set_mode") {
      if (cmd.mode === "plan" && state.chatMode !== "off")
        return yield* write({
          type: "response",
          id: cmd.id,
          command: cmd.type,
          success: false,
          error: "Exit chat mode first",
        });
      if (cmd.mode === "default" || cmd.mode === "plan") state.mode = cmd.mode;
      yield* answer(cmd, write);
      yield* write({ type: "mode_changed", mode: state.mode });
      if (state.mode === "default" && proposalId) {
        yield* write({ type: "plan_proposal_cancel", id: proposalId, reason: "mode_change" });
        proposalId = undefined;
        yield* write({ type: "agent_end", isTerminal: true, messages: [] });
      }
      return;
    }
    if (cmd.type === "set_chat_mode") {
      if (state.mode === "plan" && cmd.mode !== "off")
        return yield* write({
          type: "response",
          id: cmd.id,
          command: cmd.type,
          success: false,
          error: "Exit plan mode first",
        });
      if (cmd.mode === "chat" || cmd.mode === "off" || cmd.mode === "erp" || cmd.mode === "raw")
        state.chatMode = cmd.mode;
      return yield* answer(cmd, write);
    }
    if (cmd.type === "get_usage")
      return yield* answer(cmd, write, { provider: cmd.provider, windows: [] });
    if (cmd.type === "extension_ui_response" || cmd.type === "tool_approval_response") {
      responses.push(cmd);
      if (startupState && cmd.id === "startup-permission") {
        const pending = startupState;
        startupState = undefined;
        if (startupFails) {
          startupFails = false;
          return yield* write({
            type: "response",
            id: pending.id,
            command: pending.type,
            success: false,
            code: "session_in_use",
            error: "session_in_use: session already owned by PID 42",
          });
        }
        yield* answer(pending, write, {
          sessionId: state.id,
          sessionFile: state.file,
          messageCount: state.entries.length,
          mode: state.mode,
          chatMode: state.chatMode,
          isStreaming: state.streaming,
        });
      }
      return;
    }
    if (cmd.type === "plan_proposal_response") {
      proposed.push({ decision: cmd.decision, feedback: cmd.feedback });
      if (cmd.decision === "approve") state.mode = "default";
      state.streaming = true;
      yield* write({ type: "agent_start" });
      return;
    }
    if (cmd.type === "prompt") {
      if (rejectPrompt) {
        const error = rejectPrompt;
        rejectPrompt = undefined;
        return yield* write({
          type: "response",
          id: cmd.id,
          command: cmd.type,
          success: false,
          error,
        });
      }
      prompts.push(String(cmd.message));
      promptModels.push(`${state.model.provider}/${state.model.id}`);
      const user = append("user", [{ type: "text", text: String(cmd.message) }], state);
      state.streaming = true;
      yield* write({ type: "agent_start" });
      yield* onPrompt;
      yield* promptGate;
      return yield* answer(cmd, write, { agentInvoked: true, userEntryId: user.id });
    }
    if (cmd.type === "abort") {
      state.streaming = false;
      yield* answer(cmd, write);
      yield* write({ type: "agent_end", isTerminal: true, messages: [] });
      return;
    }
    if (cmd.type === "branch") {
      const index = state.entries.findIndex((row) => row.id === cmd.entryId);
      if (index < 0)
        return yield* write({
          type: "response",
          id: cmd.id,
          command: cmd.type,
          success: false,
          error: "missing branch entry",
        });
      const next: NativeMemory = {
        ...state,
        id: `session-${++nativeSequence}`,
        file: path.join(path.dirname(state.file), `branch-${nativeSequence}.jsonl`),
        entries:
          afterBranchFailure === "transcript" ? [...state.entries] : state.entries.slice(0, index),
        leafId: state.entries.slice(0, index).at(-1)?.id ?? null,
        mode: "default",
        streaming: false,
      };
      yield* fs.writeFileString(next.file, "");
      memories.set(next.file, next);
      context.current = next;
      emitters.delete(state.file);
      emitters.set(next.file, write);
      memory = next;
      branched = true;
      return yield* answer(cmd, write, { cancelled: false });
    }
    return yield* answer(cmd, write);
  });
  const spawn = Effect.fn("NativeAdapterHarness.spawn")(function* (command: ChildProcess.Command) {
    assert.ok(ChildProcess.isStandardCommand(command));
    if (!ChildProcess.isStandardCommand(command))
      return yield* Effect.die("Expected standard command");
    const args = commandArguments(command);
    launches.push(args);
    if (args.includes("--no-session")) {
      const config = yield* testPeer(
        (cmd, write) =>
          answer(cmd, write, cmd.type === "negotiate_protocol" ? { protocolVersion: 2 } : {}),
        { ...defaultReady, capabilities: ["rpc-ui", ...capabilities] },
        undefined,
        true,
      );
      return config.handle;
    }
    const resumeIndex = args.indexOf("--session");
    const resume = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
    if (resume) {
      memory = memories.get(resume);
      if (!memory) return yield* Effect.die(`Unknown native file ${resume}`);
      branched = false;
    } else {
      const directoryIndex = args.indexOf("--session-dir");
      const directory = directoryIndex >= 0 ? args[directoryIndex + 1]! : home;
      const file = `${directory}/session-${++nativeSequence}.jsonl`;
      memory = {
        id: `session-${nativeSequence}`,
        file,
        entries: [],
        mode: "default",
        chatMode: "off",
        model: { provider: "fixture", id: "test" },
        streaming: false,
      };
      yield* fs.writeFileString(file, "");
      memories.set(file, memory);
    }
    memory.streaming = false;
    const context = { current: native() };
    const peer = yield* testPeer(
      (cmd, write) => handler(context, cmd, write).pipe(Effect.orDie),
      { ...defaultReady, capabilities: ["rpc-ui", ...capabilities] },
      undefined,
      true,
    );
    emitters.set(context.current.file, peer.emit);
    processIsRunning.push(peer.handle.isRunning);
    processExits.push(peer.finish);
    emitCurrent = peer.emit;
    return peer.handle;
  });
  const mcpContext = yield* Layer.buildWithScope(
    options.mcpTools
      ? Layer.merge(McpSessionRegistryTestkit.layerNative, options.mcpTools)
      : McpSessionRegistryTestkit.layerNative,
    yield* Effect.scope,
  );
  const adapter = yield* makeNeoPiAdapter({
    settings,
    instanceId,
    binary: "npi",
    cwd: home,
    t3Home: home,
    attachmentsDir: home,
    environment: {},
    discovery: yield* makeNeoPiDiscoveryHub(),
    spawn,
    makeRuntime: (input) =>
      (options.makeRuntime ?? makeNeoPiSessionRuntime)(input).pipe(
        Effect.tap((runtime) =>
          Effect.sync(() => {
            runtimes.push(runtime);
            runtimeInputs.push(input);
          }),
        ),
      ),
  }).pipe(Effect.provideContext(mcpContext));
  const policy = {
    cwd: home,
    runtimeMode: options.runtimeMode ?? "auto",
    interactionMode: "default" as const,
  };
  let sessionSequence = 0;
  const open = Effect.fn("NativeAdapterHarness.open")(function* (
    saved?: OrchestrationV2ProviderThread,
  ) {
    const session = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-${++sessionSequence}`),
      modelSelection,
      runtimePolicy: policy,
    });
    yield* Stream.runForEach(session.events, (event) =>
      Effect.gen(function* () {
        yield* decodeProviderEvent(event);
        observed.push(event);
        yield* Queue.offer(inbox, event);
      }),
    ).pipe(Effect.forkScoped);
    const providerThread = yield* session.ensureThread({
      threadId,
      modelSelection,
      runtimePolicy: policy,
      ...(saved ? { existingProviderThread: saved } : {}),
    });
    return { session, providerThread };
  });
  let runSequence = 0;
  const turn = (
    providerThread: OrchestrationV2ProviderThread,
    text: string,
    mode: "default" | "plan" = "default",
  ): ProviderAdapterV2TurnInput => {
    const ordinal = ++runSequence;
    const now = DateTime.makeUnsafe("2026-11-11T00:00:00.000Z");
    const appThread: OrchestrationV2AppThread = {
      id: threadId,
      projectId: ProjectId.make("native-project"),
      title: "Native regression",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: policy.runtimeMode,
      interactionMode: mode,
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    return {
      appThread,
      threadId,
      providerThread,
      runId: RunId.make(`run-${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`attempt-${ordinal}`),
      rootNodeId: NodeId.make(`root-${ordinal}`),
      modelSelection,
      runtimePolicy: { ...policy, interactionMode: mode },
      message: {
        messageId: MessageId.make(`message-${ordinal}`),
        text,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
    };
  };
  const next = Effect.fn("NativeAdapterHarness.next")(function* (
    predicate: (event: ProviderAdapterV2Event) => boolean,
  ) {
    while (true) {
      const event = yield* Queue.take(inbox);
      if (predicate(event)) return event;
    }
  });
  const awaitTerminal = Effect.fn("NativeAdapterHarness.awaitTerminal")(function* () {
    const terminal = yield* next((event) => event.type === "turn.terminal");
    if (terminal.type !== "turn.terminal") return yield* Effect.die("Expected a terminal event");
    const saved = observed
      .slice(0, observed.indexOf(terminal))
      .findLast(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.nativeMetadata?.neopiLastTurn?.providerTurn.id ===
            terminal.providerTurnId,
      );
    assert.equal(
      saved?.type === "provider_thread.updated"
        ? saved.providerThread.nativeMetadata?.neopiLastTurn?.providerTurn.status
        : undefined,
      terminal.status,
    );
    return terminal;
  });
  const complete = Effect.fn("NativeAdapterHarness.complete")(function* (
    text = "answer",
    sessionFile?: string,
  ) {
    const state = native(sessionFile);
    const message = append("assistant", [{ type: "text", text }], state).message;
    yield* emit(
      { type: "message_start", message: { role: "assistant", content: [] } },
      sessionFile,
    );
    yield* emit(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } },
      sessionFile,
    );
    yield* emit({ type: "message_end", message }, sessionFile);
    state.streaming = false;
    yield* emit({ type: "agent_end", isTerminal: true, messages: [message] }, sessionFile);
  });
  const finish = Effect.fn("NativeAdapterHarness.finish")(function* (text = "answer") {
    yield* complete(text);
    return yield* awaitTerminal();
  });
  const propose = Effect.fn("NativeAdapterHarness.propose")(function* (
    id: string,
    markdown: string,
  ) {
    proposalId = id;
    native().streaming = false;
    yield* emit({ type: "plan_proposal_request", id, title: "Plan", planMarkdown: markdown });
    return yield* awaitTerminal();
  });
  return {
    adapter,
    open,
    turn,
    next,
    awaitTerminal,
    complete,
    finish,
    propose,
    native,
    emit,
    observed,
    launches,
    commands,
    prompts,
    promptModels,
    responses,
    proposed,
    runtimes,
    runtimeInputs,
    processIsRunning,
    spawn,
    home,
    policy,
    exit: (signal: string | null) =>
      processExits.at(-1)?.(signal) ?? Effect.die("No native process"),
    mcpRegistry: Context.get(mcpContext, McpSessionRegistry.McpSessionRegistry),
    mcpSessions: Context.get(mcpContext, McpProviderSessions.McpProviderSessions),
    askOnStartup: ({
      kind = "approval",
      fail = false,
    }: { kind?: "approval" | "user-input"; fail?: boolean } = {}) => {
      startupQuestion = { kind, fail };
    },
    failNextPrompt: (message: string) => {
      rejectPrompt = message;
    },
    failAfterBranch: (failure: "state" | "history" | "transcript" | undefined) => {
      afterBranchFailure = failure;
    },
    gatePrompt: (gate: Effect.Effect<void>, seen: Effect.Effect<void>) => {
      promptGate = gate;
      onPrompt = seen;
    },
  };
});
