import {
  ProviderThreadId,
  ProviderTurnId,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  NeoPiModelsError,
  type NeoPiSettings,
  NeoPiResumeCursor,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type NodeId,
  type RunId,
  type ThreadId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  make as makeModelsClient,
  type SpawnFn,
  type UiRequestFrame,
} from "effect-neopi-rpc/client";
import { NeoPiRpcError } from "effect-neopi-rpc/errors";
import type {
  NeoPiChatMode,
  NeoPiInteractionMode,
  PromptImage,
  SetChatModeCommand,
  SetModeCommand,
} from "effect-neopi-rpc/schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Context from "effect/Context";
import { McpServer } from "effect/ai";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as RcMap from "effect/RcMap";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { emptyCoreState, mapCoreFrame } from "./mappers/core.ts";
import type { CoreMapCtx } from "./mappers/MapCtx.ts";
import { emptyToolState, mapToolFrame, withHostToolNames } from "./mappers/tools.ts";
import { emptySubagentState, mapSubagentFrame } from "./mappers/subagents.ts";
import { emptyUiState, flushUiSettlements, mapUiRequest, type PendingUi } from "./mappers/ui.ts";
import { mapPlanProposal, neoPiInteractionModeFromFrame } from "./mappers/mode.ts";
import { neoPiAvailableCommands, toNeoPiCommandCatalog } from "./NeoPiCommandCatalog.ts";
import { NEOPI_CAPABILITIES } from "./NeoPiCompatibility.ts";
import type { NeoPiDiscoveryHub } from "./NeoPiDiscovery.ts";
import { makeNeoPiHostToolBridge } from "./NeoPiHostToolBridge.ts";
import { makeNeoPiSessionRuntime, type NeoPiRuntimeInput } from "./NeoPiSessionRuntime.ts";
import { readNeoPiJournalPeer, sameNeoPiJournalIdentity } from "./NeoPiJournalReader.ts";
import { readNeoPiSessionConfiguration } from "./NeoPiSessionConfiguration.ts";
import {
  groupNeoPiHistory,
  NeoPiRollbackIntegrityError,
  rollbackNeoPiConversation,
} from "./NeoPiRollback.ts";
import type { NeoPiRuntimeFrame, NeoPiSessionRuntimeShape } from "./NeoPiRuntimeTypes.ts";
import type { NeoPiAdapterShape } from "./NeoPiAdapter.ts";
import { makeNeoPiModelsConnection } from "./NeoPiModelsConnection.ts";
import { parseNeoPiLaunchArguments } from "./NeoPiLaunchArgs.ts";
import { NeoPiRuntimeError } from "./NeoPiRuntimeError.ts";

const PROVIDER = ProviderDriverKind.make("neopi");
const decodeResumeCursorSync = Schema.decodeUnknownSync(NeoPiResumeCursor);
const decodeResumeCursor = Schema.decodeEffect(NeoPiResumeCursor);
const isRollbackIntegrityError = Schema.is(NeoPiRollbackIntegrityError);
const isNeoPiRuntimeError = Schema.is(NeoPiRuntimeError);
const isNeoPiModelsError = Schema.is(NeoPiModelsError);
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function parseResumeCursor(value: unknown): NeoPiResumeCursor | undefined {
  if (value === undefined || value === null) return undefined;
  return decodeResumeCursorSync(value);
}

function nativeCapabilities(
  capabilities: ReadonlySet<string>,
): OrchestrationV2ProviderCapabilities {
  const ownsSession = !capabilities.has(NEOPI_CAPABILITIES.controlAttached);
  const approvals = capabilities.has(NEOPI_CAPABILITIES.toolApprovalRequest);
  const mode = capabilities.has(NEOPI_CAPABILITIES.setMode);
  return {
    sessions: {
      supportsMultipleProviderThreadsPerSession: false,
      supportsModelSwitchInSession: true,
      supportsProviderSwitchingViaHandoff: false,
      supportsRuntimeModeSwitchInSession: ownsSession,
      pendingRequestsSurviveRestart: false,
    },
    threads: {
      canCreateEmptyThread: false,
      canReadThreadSnapshot: true,
      canRollbackThread: ownsSession,
      canForkThread: false,
      canForkFromTurn: false,
      canForkFromSubagentThread: false,
      exposesNativeThreadId: true,
    },
    turns: {
      exposesNativeTurnId: false,
      emitsTurnStarted: true,
      emitsTurnCompleted: true,
      supportsInterrupt: true,
      supportsActiveSteering: true,
      activeSteeringInterruptsTools: true,
      activeSteeringAcceptsAttachments: true,
      supportsSteeringByInterruptRestart: false,
      supportsQueuedMessages: ownsSession,
      terminalStatusQuality: "strong",
    },
    streaming: {
      streamsAssistantText: true,
      streamsReasoning: true,
      streamsToolOutput: true,
      streamsPlanText: mode,
      emitsMessageCompleted: true,
    },
    tools: {
      exposesToolItemIds: true,
      emitsToolStarted: true,
      emitsToolCompleted: true,
      emitsToolOutput: true,
      supportsMcpTools: true,
      supportsDynamicToolCallbacks: true,
    },
    approvals: {
      supportsCommandApproval: approvals,
      supportsFileReadApproval: approvals,
      supportsFileChangeApproval: approvals,
      supportsApplyPatchApproval: approvals,
      approvalsHaveNativeRequestIds: true,
      approvalCallbacksAreLiveOnly: true,
      approvalsCanOriginateFromSubagents: approvals,
    },
    planning: {
      emitsPlanUpdated: mode,
      emitsTodoList: false,
      emitsProposedPlan: mode,
      supportsStructuredQuestions: true,
      planDeltasHaveItemIds: mode,
    },
    subagents: {
      supportsSubagents: true,
      exposesSubagentThreadIds: false,
      emitsSubagentLifecycle: true,
      canWaitForSubagents: false,
      canCloseSubagents: false,
      canForkSubagentThread: false,
    },
    context: {
      acceptsSystemContext: false,
      acceptsDeveloperContext: false,
      acceptsSyntheticUserContext: true,
      canGenerateSummaries: true,
      canConsumeHandoffSummaries: true,
      supportsDeltaHandoff: true,
      supportsFullThreadHandoff: true,
      maxRecommendedHandoffChars: null,
    },
    checkpointing: {
      appCanCheckpointFilesystem: true,
      supportsNestedCheckpointScopes: false,
      providerCanRollbackConversation: ownsSession,
      providerRollbackReturnsSnapshot: ownsSession,
      providerCanReadConversationSnapshot: true,
    },
    identity: {
      nativeThreadIds: "strong",
      nativeTurnIds: "none",
      nativeItemIds: "strong",
      nativeRequestIds: "strong",
    },
    runtimePolicy: { enforcement: "native" },
  };
}

interface TurnBinding {
  readonly turnId: TurnId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly runOrdinal: number;
  readonly ordinals: Map<string, number>;
  readonly settled: Deferred.Deferred<void>;
  providerTurn: OrchestrationV2ProviderTurn;
  core: ReturnType<typeof emptyCoreState>;
  tools: ReturnType<typeof emptyToolState>;
  subagents: ReturnType<typeof emptySubagentState>;
}

interface Session {
  readonly threadId: ThreadId;
  session: OrchestrationV2ProviderSession;
  providerThread: OrchestrationV2ProviderThread;
  runtime: NeoPiSessionRuntimeShape;
  runtimeMode: RuntimeMode;
  readonly scope: Scope.Closeable;
  readonly sessionKey: string;
  readonly mcpProviderSessionId?: string;
  readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
  readonly operation: Semaphore.Semaphore;
  readonly bindings: Map<TurnId, TurnBinding>;
  readonly turns: Map<TurnId, OrchestrationV2ProviderTurn>;
  readonly pending: Map<string, PendingUi>;
  readonly startupDone: Deferred.Deferred<void, NeoPiRuntimeError>;
  readonly ui: ReturnType<typeof emptyUiState>;
  lastBinding?: TurnBinding;
  activeTurnId?: TurnId;
  closed: boolean;
  lastChatMode?: Exclude<NeoPiChatMode, "off">;
  interactionMode?: NeoPiInteractionMode;
  hostPlanHandlerGeneration?: number;
  pendingPlan?: { readonly id: string; readonly planMarkdown: string };
}

export interface NeoPiAdapterOptions {
  readonly settings: NeoPiSettings;
  readonly instanceId: ProviderInstanceId;
  readonly binary: string;
  readonly cwd: string;
  readonly t3Home: string;
  readonly attachmentsDir: string;
  readonly environment: Record<string, string>;
  readonly spawn: SpawnFn;
  readonly discovery: NeoPiDiscoveryHub;
  readonly sharedSessionCapabilities?: Set<string>;
  readonly makeRuntime?: (
    input: NeoPiRuntimeInput,
  ) => Effect.Effect<NeoPiSessionRuntimeShape, never, FileSystem.FileSystem>;
  readonly makeHostBridge?: typeof makeNeoPiHostToolBridge;
}

export const makeNeoPiAdapter = Effect.fn("NeoPiAdapter.make")(function* (
  options: NeoPiAdapterOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const mcpRegistry = yield* McpSessionRegistry.McpSessionRegistry;
  const mcpContext = Context.pick(
    McpSessionRegistry.McpSessionRegistry,
    McpServer.McpServer,
  )(yield* Effect.context<McpSessionRegistry.McpSessionRegistry | McpServer.McpServer>());
  const scope = yield* Effect.scope;
  const controllers = new Map<ThreadId, ProviderAdapter.ProviderAdapterV2SessionRuntime>();
  const sessions = new Map<ThreadId, Session>();
  const modelsUi = yield* Effect.acquireRelease(
    PubSub.unbounded<{ threadId: ThreadId; frame: UiRequestFrame }>(),
    PubSub.shutdown,
  );
  const configurationClients = yield* RcMap.make({
    lookup: Effect.fn("NeoPiAdapter.lookupConfiguration")(
      function* (cwd: string) {
        const extra = yield* parseNeoPiLaunchArguments(options.settings.launchArgs);
        const client = yield* makeModelsClient({
          spawn: options.spawn,
          command: options.binary,
          cwd,
          env: {
            ...options.environment,
            ...(options.settings.profile ? { OMP_PROFILE: options.settings.profile } : {}),
          },
          args: [
            "--mode",
            "rpc-ui",
            "--cwd",
            cwd,
            "--no-session",
            "--no-tools",
            "--no-skills",
            "--no-rules",
            "--no-title",
            ...extra,
          ],
        });
        return yield* makeNeoPiModelsConnection(client);
      },
      Effect.mapError((cause) => new NeoPiModelsError({ message: cause.message })),
    ),
    idleTimeToLive: "30 seconds",
    capacity: 4,
  });
  const incarnationId = yield* random.uuidV4();
  let eventSequence = 0;
  const stamp = (now: string): Pick<CoreMapCtx, "now" | "newEventId"> => ({
    now: () => now,
    newEventId: () => `neopi-${options.instanceId}-${incarnationId}-${++eventSequence}`,
  });
  const context = (session: Session, now: string, binding: TurnBinding): CoreMapCtx => ({
    provider: PROVIDER,
    providerInstanceId: options.instanceId,
    providerSessionId: session.session.id,
    providerThreadId: session.providerThread.id,
    providerTurnId: binding.providerTurn.id,
    providerSession: session.session,
    providerThread: session.providerThread,
    providerTurn: binding.providerTurn,
    runId: binding.runId,
    nodeId: binding.nodeId,
    runOrdinal: binding.runOrdinal,
    sessionKey: session.sessionKey,
    threadId: session.threadId,
    turnId: binding.turnId,
    itemOrdinal: (id) => {
      const existing = binding.ordinals.get(id);
      if (existing !== undefined) return existing;
      const ordinal = binding.ordinals.size + 1;
      binding.ordinals.set(id, ordinal);
      return ordinal;
    },
    ...stamp(now),
  });
  // Streaming publication must not allocate a tracing span per frame.
  const publish = Effect.fnUntraced(function* (
    session: Session,
    items: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  ) {
    for (const item of items) {
      if (session.closed) return;
      switch (item.type) {
        case "provider_session.updated":
          session.session = item.providerSession;
          break;
        case "provider_thread.updated":
          session.providerThread = item.providerThread;
          break;
        case "provider_turn.updated": {
          const binding = session.bindings.get(TurnId.make(item.providerTurn.id));
          if (binding) binding.providerTurn = item.providerTurn;
          session.turns.set(TurnId.make(item.providerTurn.id), item.providerTurn);
          break;
        }
      }
      yield* Queue.offer(session.events, item);
    }
  });
  const requireSession = (threadId: ThreadId) => {
    const session = sessions.get(threadId);
    return session && !session.closed
      ? Effect.succeed(session)
      : Effect.fail(new ProviderAdapter.ProviderAdapterSessionStoppedError({ driver: PROVIDER }));
  };
  const rpcError = (_threadId: ThreadId, method: string, cause: { message: string }) =>
    new NeoPiRuntimeError({ code: "rpc", message: `${method}: ${cause.message}`, cause });
  const cursorCache = new WeakMap<Session, NeoPiResumeCursor>();
  // Streaming publication must not allocate a tracing span per frame.
  const publishCursor = Effect.fnUntraced(function* (session: Session) {
    const cursor = yield* SubscriptionRef.get(session.runtime.cursor);
    if (!cursor.sessionFile || !cursor.sessionId) return;
    if (
      cursorCache.get(session) === cursor &&
      session.providerThread.nativeMetadata?.neopiLastTurn?.providerTurn ===
        session.lastBinding?.providerTurn
    )
      return;
    const saved = yield* decodeResumeCursor(cursor).pipe(
      Effect.mapError(
        (cause) =>
          new NeoPiRuntimeError({
            code: "rpc",
            message: "NeoPi returned an invalid native resume cursor",
            cause,
          }),
      ),
    );
    cursorCache.set(session, cursor);
    yield* publish(session, [
      {
        type: "provider_thread.updated",
        driver: PROVIDER,
        providerThread: {
          ...session.providerThread,
          nativeThreadRef: { driver: PROVIDER, nativeId: saved.sessionId, strength: "strong" },
          nativeConversationHeadRef: saved.historyLeafId
            ? { driver: PROVIDER, nativeId: saved.historyLeafId, strength: "strong" }
            : null,
          nativeMetadata: {
            ...session.providerThread.nativeMetadata,
            neopiResumeCursor: saved,
            ...(session.lastBinding
              ? {
                  neopiLastTurn: {
                    runId: session.lastBinding.runId,
                    runOrdinal: session.lastBinding.runOrdinal,
                    providerTurn: session.lastBinding.providerTurn,
                  },
                }
              : {}),
          },
          updatedAt: yield* DateTime.now,
        },
      },
    ]);
  });
  const releaseCompletedBinding = (session: Session, binding: TurnBinding) => {
    if (
      binding === session.lastBinding ||
      session.activeTurnId === binding.turnId ||
      binding.providerTurn.status === "pending" ||
      binding.providerTurn.status === "running"
    )
      return;
    for (const id in binding.subagents.runs) if (!binding.subagents.runs[id]!.terminal) return;
    session.bindings.delete(binding.turnId);
  };
  // Streaming publication must not allocate a tracing span per frame.
  const processFrame = Effect.fnUntraced(function* (session: Session, frame: NeoPiRuntimeFrame) {
    if (session.closed || sessions.get(session.threadId) !== session) return;
    if (frame.type === "extension_ui_request" && typeof frame.loginId === "string") {
      yield* PubSub.publish(modelsUi, {
        threadId: session.threadId,
        frame: frame as UiRequestFrame,
      });
      return;
    }
    const data = record(frame);
    const turnId = frame.turnId ?? session.activeTurnId;
    const binding = turnId ? session.bindings.get(turnId) : session.lastBinding;
    yield* publishCursor(session);
    const now = DateTime.formatIso(yield* DateTime.now);
    if (data.type === "available_commands_update") {
      const catalog = toNeoPiCommandCatalog(
        neoPiAvailableCommands(data.commands),
        new Set([...session.ui.capabilities, ...session.runtime.capabilities]),
      );
      yield* options.discovery.publish({
        cwd: session.session.cwd ?? options.cwd,
        source: "live",
        at: now,
        commands: catalog.slashCommands,
        skills: catalog.skills,
      });
    }
    const chatMode =
      data.type === "t3.state"
        ? record(data.state).chatMode
        : data.type === "chat_mode_changed"
          ? data.mode
          : undefined;
    if (chatMode === "chat" || chatMode === "erp" || chatMode === "raw")
      session.lastChatMode = chatMode;
    const interactionMode = neoPiInteractionModeFromFrame(frame);
    if (interactionMode) {
      session.interactionMode = interactionMode;
      if (interactionMode === "default") delete session.hostPlanHandlerGeneration;
    }
    if (
      ((data.type === "extension_ui_request" && data.method === "cancel") ||
        data.type === "tool_approval_cancel") &&
      typeof data.targetId === "string"
    ) {
      for (const [id, pending] of session.pending) {
        if (pending.nativeId === data.targetId) session.pending.delete(id);
      }
    }
    if (!binding) {
      if (data.type === "t3.session.exited" && session.session.status !== "starting")
        yield* stopInternal(session).pipe(Effect.forkIn(scope));
      return;
    }
    const ctx = context(session, now, binding);
    const core = mapCoreFrame(ctx, frame, binding.core);
    binding.core = core.state;
    const tools = mapToolFrame(ctx, frame, binding.tools);
    binding.tools = tools.state;
    const ui = mapUiRequest(ctx, frame, session.ui);
    if (ui.pending) session.pending.set(ui.pending.requestId, ui.pending);
    const subagents = mapSubagentFrame(ctx, frame, binding.subagents, [
      ...binding.tools.hostToolNames,
    ]);
    binding.subagents = subagents.state;
    const proposal = mapPlanProposal(ctx, frame, session.runtime.capabilities);
    if (proposal.proposal) session.pendingPlan = proposal.proposal;
    if (data.type === "t3.plan.proposal.closed" && session.pendingPlan?.id === data.id)
      delete session.pendingPlan;
    const current =
      session.activeTurnId === binding.turnId ||
      (session.activeTurnId === undefined && session.lastBinding === binding);
    const lastCoreEvent = core.events.at(-1);
    const terminal = lastCoreEvent?.type === "turn.terminal" ? lastCoreEvent : undefined;
    yield* publish(session, [
      ...core.events.filter(
        (event) =>
          event !== terminal &&
          (current ||
            (event.type !== "provider_session.updated" &&
              event.type !== "provider_thread.updated")),
      ),
      ...tools.events,
      ...subagents.events,
      ...ui.events,
      ...proposal.events,
    ]);
    yield* publishCursor(session);
    if (terminal) yield* publish(session, [terminal]);
    if (data.type === "subagent_lifecycle") releaseCompletedBinding(session, binding);
    if (data.type === "t3.turn.outcome") {
      if (session.activeTurnId === binding.turnId) delete session.activeTurnId;
      yield* Deferred.succeed(binding.settled, undefined);
    } else if (data.type === "t3.session.exited" && session.session.status !== "starting") {
      yield* stopInternal(session).pipe(Effect.forkIn(scope));
    }
  });
  const stopInternal = Effect.fn("NeoPiAdapter.stopInternal")(function* (session: Session) {
    if (session.closed) return;
    session.closed = true;
    if (sessions.get(session.threadId) === session) sessions.delete(session.threadId);
    for (const binding of session.bindings.values())
      yield* Deferred.succeed(binding.settled, undefined);
    yield* session.runtime.stop;
    yield* Scope.close(session.scope, Exit.void);
  });
  const startRuntime = Effect.fn("NeoPiAdapter.startRuntime")(function* (
    input: Pick<
      ProviderAdapter.ProviderAdapterV2TurnInput,
      "threadId" | "providerThread" | "runtimePolicy"
    >,
    providerSession: OrchestrationV2ProviderSession,
    eventQueue: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>,
    ownerScope: Scope.Scope,
    operation: Semaphore.Semaphore,
    binding?: TurnBinding,
  ) {
    const existing = sessions.get(input.threadId);
    if (existing && !existing.closed)
      return yield* new NeoPiRuntimeError({
        code: "rpc",
        message:
          "A native runtime already owns this app thread; close its binding before reopening.",
      });
    const resume = yield* Effect.try({
      try: () => parseResumeCursor(input.providerThread.nativeMetadata?.neopiResumeCursor),
      catch: (cause) =>
        new NeoPiRuntimeError({
          code: "rpc",
          message: "Invalid NeoPi resume cursor: refusing to start a fresh session",
          cause,
        }),
    });
    const issued = yield* mcpSessions.read(input.threadId);
    const mcpSession = issued?.providerInstanceId === options.instanceId ? issued : undefined;
    const invocation = mcpSession
      ? yield* mcpRegistry.resolve(mcpSession.authorizationHeader.replace(/^Bearer\s+/, ""))
      : undefined;
    const caller = invocation?.kind === "native" ? invocation : invocation?.thread;
    const hostBridge =
      invocation &&
      caller &&
      mcpSession &&
      caller.threadId === input.threadId &&
      caller.providerInstanceId === options.instanceId &&
      caller.providerSessionId === mcpSession.providerSessionId
        ? yield* (options.makeHostBridge ?? makeNeoPiHostToolBridge)({
            threadId: input.threadId,
            capabilities: invocation.capabilities,
            credential: mcpSession.authorizationHeader,
            context: invocation,
          }).pipe(Effect.provideContext(Context.add(mcpContext, Scope.Scope, ownerScope)))
        : undefined;
    const sessionScope = yield* Scope.make();
    const environment = McpProviderSession.withAgentDeviceEnvironment(
      options.environment,
      hostBridge ? mcpSession : undefined,
    );
    const runtime = yield* (options.makeRuntime ?? makeNeoPiSessionRuntime)({
      threadId: input.threadId,
      binary: options.binary,
      cwd: input.runtimePolicy.cwd ?? options.cwd,
      t3Home: options.t3Home,
      env: Object.fromEntries(
        Object.entries(environment).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      projectId: input.threadId,
      profile: options.settings.profile,
      launchArgs: options.settings.launchArgs,
      runtimeMode: input.runtimePolicy.runtimeMode,
      ...(resume ? { cursor: resume } : {}),
      spawn: options.spawn,
      ...(hostBridge ? { hostBridge } : {}),
      ...(options.sharedSessionCapabilities
        ? { sharedSessionCapabilities: options.sharedSessionCapabilities }
        : {}),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Scope.Scope, sessionScope),
    );
    const entry: Session = {
      threadId: input.threadId,
      session: providerSession,
      providerThread: input.providerThread,
      runtime,
      runtimeMode: input.runtimePolicy.runtimeMode,
      scope: sessionScope,
      sessionKey: providerSession.id,
      events: eventQueue,
      operation,
      bindings: new Map(binding ? [[binding.turnId, binding]] : []),
      turns: new Map(binding ? [[binding.turnId, binding.providerTurn]] : []),
      ...(binding ? { lastBinding: binding } : {}),
      startupDone: yield* Deferred.make<void, NeoPiRuntimeError>(),
      pending: new Map(),
      ui: emptyUiState(),
      closed: false,
      ...(hostBridge && mcpSession ? { mcpProviderSessionId: mcpSession.providerSessionId } : {}),
    };
    if (binding)
      binding.tools = withHostToolNames(
        binding.tools,
        hostBridge?.definitions.map((tool) => tool.name) ?? [],
      );
    sessions.set(input.threadId, entry);
    yield* Effect.addFinalizer(() => stopInternal(entry)).pipe(
      Effect.provideService(Scope.Scope, ownerScope),
    );
    yield* Stream.runForEach(runtime.frames, (frame) => processFrame(entry, frame)).pipe(
      Effect.forkIn(sessionScope),
    );
    if (entry.closed)
      return yield* new NeoPiRuntimeError({
        code: "closed",
        message: "The native session was closed during startup.",
      });
    yield* runtime.start.pipe(
      Effect.tapError((error) => Deferred.fail(entry.startupDone, error)),
      Effect.onError(() => stopInternal(entry)),
    );
    if (entry.closed) {
      yield* runtime.stop;
      return yield* new NeoPiRuntimeError({
        code: "closed",
        message: "The native session was closed during startup.",
      });
    }
    for (const capability of runtime.capabilities) entry.ui.capabilities.add(capability);
    yield* publish(entry, [
      {
        type: "provider_session.updated",
        driver: PROVIDER,
        providerSession: {
          ...entry.session,
          capabilities: nativeCapabilities(runtime.capabilities),
          status: "ready",
          updatedAt: yield* DateTime.now,
        },
      },
    ]);
    yield* publishCursor(entry);
    yield* Deferred.succeed(entry.startupDone, undefined);
    if (
      runtime.capabilities.has(NEOPI_CAPABILITIES.setChatMode) ||
      runtime.capabilities.has(NEOPI_CAPABILITIES.setMode)
    ) {
      const state = yield* runtime.request({ type: "get_state" });
      yield* processFrame(entry, { type: "t3.state", state });
    }
    return entry;
  });
  const makePrompt = Effect.fn("NeoPiAdapter.makePrompt")(function* (
    message: ProviderAdapter.ProviderAdapterV2TurnMessage,
    turnId: TurnId,
  ) {
    const images: PromptImage[] = [];
    const text = [message.text];
    for (const attachment of message.attachments) {
      const path = resolveAttachmentPath({ attachmentsDir: options.attachmentsDir, attachment });
      if (!path)
        return yield* new NeoPiRuntimeError({
          code: "rpc",
          message: `Invalid attachment id '${attachment.id}'.`,
        });
      if (attachment.type === "image") {
        const bytes = yield* fs
          .readFile(path)
          .pipe(
            Effect.mapError(
              (cause) => new NeoPiRuntimeError({ code: "rpc", message: cause.message, cause }),
            ),
          );
        images.push({
          type: "image",
          data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
          mimeType: attachment.mimeType,
        });
      } else if (!message.text.includes(path)) {
        text.push(`Attached file "${attachment.name}": "${path}"`);
      }
    }
    if (!text.some(Boolean) && images.length === 0)
      return yield* new NeoPiRuntimeError({
        code: "rpc",
        message: "Turn requires text or attachments.",
      });
    return { text: text.filter(Boolean).join("\n\n"), images, turnId };
  });
  const sendTurn = Effect.fn("NeoPiAdapter.sendTurn")(function* (
    session: Session,
    input: ProviderAdapter.ProviderAdapterV2TurnInput,
    binding: TurnBinding,
    compact = false,
  ) {
    yield* Deferred.await(session.startupDone);
    const base = yield* makePrompt(input.message, binding.turnId);
    const prompt = {
      ...base,
      text: input.appContext?.length
        ? [...input.appContext.map(({ key, text }) => `[${key}]\n${text}`), base.text].join("\n\n")
        : base.text,
      modelSelection: input.modelSelection,
    };
    const turnId = binding.turnId;
    const interactionMode = input.runtimePolicy.interactionMode;
    if (session.runtimeMode !== input.runtimePolicy.runtimeMode) {
      yield* session.runtime.setRuntimeMode(input.runtimePolicy.runtimeMode);
      session.runtimeMode = input.runtimePolicy.runtimeMode;
    }
    if (compact) {
      yield* processFrame(session, { type: "agent_start", turnId });
      yield* session.runtime.compact(input.message.text || undefined);
      yield* processFrame(session, { type: "t3.turn.outcome", state: "completed", turnId });
      return;
    }
    if (
      session.runtime.capabilities.has(NEOPI_CAPABILITIES.setChatMode) &&
      /^\/chat(?:\s|$)/.test(input.message.text)
    ) {
      const match = /^\/chat(?:\s+(chat|erp|raw|off))?(?:\s+--include\s+(\S+))?\s*$/.exec(
        input.message.text,
      );
      if (!match || input.message.attachments.length)
        return yield* new NeoPiRuntimeError({
          code: "rpc",
          message: "Use /chat [chat|erp|raw|off] [--include categories] without attachments.",
        });
      const current = record(yield* session.runtime.request({ type: "get_state" }));
      const mode: NeoPiChatMode =
        match[1] === "chat" || match[1] === "erp" || match[1] === "raw" || match[1] === "off"
          ? match[1]
          : current.chatMode === "off"
            ? (session.lastChatMode ?? "chat")
            : "off";
      if (mode !== "off" && interactionMode === "plan")
        return yield* new NeoPiRuntimeError({
          code: "rpc",
          message: "Exit Plan mode before enabling NeoPi chat mode.",
        });
      if (
        interactionMode === "default" &&
        session.runtime.capabilities.has(NEOPI_CAPABILITIES.setMode)
      ) {
        if (session.pendingPlan) {
          yield* session.runtime.resolvePlanProposal({ decision: "withdraw" });
          delete session.pendingPlan;
        } else if (session.interactionMode === "plan") {
          yield* session.runtime.request({ type: "set_mode", mode: "default" });
        }
        session.interactionMode = "default";
        delete session.hostPlanHandlerGeneration;
      }
      const command: SetChatModeCommand = {
        type: "set_chat_mode",
        mode,
        ...(match[2] ? { include: match[2] } : {}),
      };
      yield* session.runtime.request(command);
      const updated = yield* session.runtime.request({ type: "get_state" });
      const cursor = yield* SubscriptionRef.get(session.runtime.cursor);
      yield* SubscriptionRef.set(session.runtime.cursor, {
        ...cursor,
        turnBoundaries: [...cursor.turnBoundaries, { turnId, kind: "local" }],
      });
      yield* processFrame(session, { type: "agent_start", turnId });
      yield* processFrame(session, { type: "t3.state", state: updated, turnId });
      yield* processFrame(session, { type: "t3.turn.outcome", state: "completed", turnId });
      return;
    }
    if (session.pendingPlan && session.runtime.capabilities.has(NEOPI_CAPABILITIES.setMode)) {
      const proposal = session.pendingPlan;
      const implement =
        interactionMode === "default" &&
        prompt.images.length === 0 &&
        input.message.text === `PLEASE IMPLEMENT THIS PLAN:\n${proposal.planMarkdown}`;
      if (implement || interactionMode === "plan") {
        yield* session.runtime.resolvePlanProposal(
          implement ? { decision: "approve" } : { decision: "refine", feedback: prompt.text },
          prompt,
        );
        if (session.pendingPlan === proposal) delete session.pendingPlan;
        yield* publishCursor(session);
        return;
      }
      yield* session.runtime.resolvePlanProposal({ decision: "withdraw" });
      if (session.pendingPlan === proposal) delete session.pendingPlan;
      session.interactionMode = "default";
      delete session.hostPlanHandlerGeneration;
    }
    if (session.runtime.prepareForTurn) yield* session.runtime.prepareForTurn;
    if (
      !session.runtime.capabilities.has(NEOPI_CAPABILITIES.controlAttached) &&
      session.runtime.capabilities.has(NEOPI_CAPABILITIES.setMode) &&
      (session.interactionMode !== interactionMode ||
        (interactionMode === "plan" &&
          session.hostPlanHandlerGeneration !== (session.runtime.processGeneration ?? 0)))
    ) {
      const command: SetModeCommand = { type: "set_mode", mode: interactionMode };
      yield* session.runtime.request(command);
      session.interactionMode = interactionMode;
      if (interactionMode === "plan")
        session.hostPlanHandlerGeneration = session.runtime.processGeneration ?? 0;
      else delete session.hostPlanHandlerGeneration;
    }
    yield* session.runtime.startTurn(prompt);
    if (input.message.text.startsWith("/")) yield* session.runtime.onSessionIdentityMayHaveChanged;
    yield* publishCursor(session);
  });
  const respond = Effect.fn("NeoPiAdapter.respond")(function* (
    session: Session,
    input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput,
  ) {
    const pending = session.pending.get(input.requestId);
    const value = pending?.kind === "approval" ? input.decision : input.answers;
    if (!pending || value === undefined)
      return yield* new NeoPiRuntimeError({
        code: "rpc",
        message: `Unknown or incomplete pending request: ${input.requestId}`,
      });
    const response = pending.reply(value);
    if (response._tag === "ExtensionUi") yield* session.runtime.respondUi(response.frame);
    else yield* session.runtime.writeFrame(response.frame);
    if (session.closed || session.pending.get(input.requestId) !== pending) return;
    session.pending.delete(input.requestId);
    pending.settle(value);
    if (session.lastBinding)
      yield* publish(
        session,
        flushUiSettlements(
          context(session, DateTime.formatIso(yield* DateTime.now), session.lastBinding),
          session.ui,
        ),
      );
  });
  const readThread = Effect.fn("NeoPiAdapter.readThread")(function* (
    session: Session,
  ): Effect.fn.Return<
    ProviderAdapter.ProviderAdapterV2ThreadSnapshot,
    NeoPiRuntimeError | NeoPiRpcError
  > {
    if ((yield* SubscriptionRef.get(session.runtime.state)) !== "ready")
      return yield* new NeoPiRuntimeError({
        code: "rpc",
        message: "session_busy: retry when the NeoPi turn has settled",
      });
    const before = yield* SubscriptionRef.get(session.runtime.cursor);
    const generation = session.runtime.processGeneration;
    const messages: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = record(
        yield* session.runtime.request({
          type: "get_messages_page",
          ...(cursor ? { cursor } : {}),
        }),
      );
      if (Array.isArray(page.messages)) messages.push(...page.messages);
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor);
    const entries = record(yield* session.runtime.request({ type: "get_entries" }));
    const after = yield* SubscriptionRef.get(session.runtime.cursor);
    if (
      session.closed ||
      sessions.get(session.threadId) !== session ||
      session.runtime.processGeneration !== generation ||
      before.sessionId !== after.sessionId ||
      before.sessionFile !== after.sessionFile
    )
      return yield* new NeoPiRuntimeError({
        code: "rpc",
        message: "The native session changed while its history was being read.",
      });
    const turns = yield* Effect.try({
      try: () =>
        groupNeoPiHistory(
          messages,
          entries.entries,
          entries.leafId,
          after,
          session.runtime.capabilities.has(NEOPI_CAPABILITIES.promptEntryIds),
        ),
      catch: (cause) =>
        new NeoPiRuntimeError({
          code: "rpc",
          message: "NeoPi returned inconsistent native history",
          cause,
        }),
    });
    yield* publishCursor(session);
    return {
      providerThread: session.providerThread,
      providerTurns: turns.flatMap((turn) => {
        const snapshot = session.turns.get(turn.id);
        return snapshot ? [snapshot] : [];
      }),
      messages: [],
      runtimeRequests: [...session.ui.open.values()].map(({ request }) => request),
      providerPayload: { turns, messages, entries: entries.entries, leafId: entries.leafId },
    };
  });
  const rollback = Effect.fn("NeoPiAdapter.rollback")(function* (
    session: Session,
    input: ProviderAdapter.ProviderAdapterV2RollbackThreadInput,
  ) {
    if (session.runtime.capabilities.has(NEOPI_CAPABILITIES.controlAttached))
      return yield* new NeoPiRuntimeError({
        code: "rpc",
        message: "Cannot roll back a native session owned by another process.",
      });
    const active = session.activeTurnId ? session.bindings.get(session.activeTurnId) : undefined;
    if (active) {
      yield* session.runtime.interrupt;
      yield* Deferred.await(active.settled);
    }
    if (session.closed || (yield* SubscriptionRef.get(session.runtime.state)) !== "ready")
      return yield* new NeoPiRuntimeError({
        code: "rpc",
        message: "NeoPi is not ready to branch.",
      });
    if (session.pendingPlan) {
      const proposal = session.pendingPlan;
      yield* session.runtime.resolvePlanProposal({ decision: "withdraw" });
      if (session.pendingPlan === proposal) delete session.pendingPlan;
      session.interactionMode = "default";
      delete session.hostPlanHandlerGeneration;
    }
    const cursor = yield* SubscriptionRef.get(session.runtime.cursor);
    let retained = 0;
    if (input.target.type === "provider_turn") {
      const targetId = input.target.providerTurn.id;
      const index = cursor.turnBoundaries.findIndex(
        (turn) => turn.turnId === TurnId.make(targetId),
      );
      if (index < 0)
        return yield* new NeoPiRuntimeError({
          code: "rpc",
          message: "The requested rollback turn has no native boundary in this session.",
        });
      retained = index + 1;
    }
    const numTurns = cursor.turnBoundaries.length - retained;
    if (numTurns === 0) return yield* readThread(session);
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const next = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await rollbackNeoPiConversation({
            cursor,
            numTurns,
            useMessageEntryIds: session.runtime.capabilities.has(NEOPI_CAPABILITIES.promptEntryIds),
            request: (command) => runPromise(session.runtime.request(command)),
            onBranched: async (branched) => {
              await runPromise(SubscriptionRef.set(session.runtime.cursor, branched));
              await runPromise(publishCursor(session));
              await runPromise(session.runtime.invalidateConfiguration ?? Effect.void);
            },
          });
        } catch (cause) {
          if (isRollbackIntegrityError(cause)) {
            await runPromise(SubscriptionRef.set(session.runtime.cursor, cursor));
            await runPromise(publishCursor(session));
            await runPromise(session.runtime.restart("runtime-mode-change"));
          }
          throw cause;
        }
      },
      catch: (cause) =>
        new NeoPiRuntimeError({
          code: "rpc",
          message: "Native rollback failed",
          cause,
        }),
    }).pipe(Effect.uninterruptible);
    yield* SubscriptionRef.set(session.runtime.cursor, next);
    yield* publishCursor(session);
    yield* session.runtime.invalidateConfiguration ?? Effect.void;
    if (next.sessionId !== cursor.sessionId) {
      session.interactionMode = "default";
      delete session.hostPlanHandlerGeneration;
    }
    return yield* readThread(session);
  });
  const getCapabilities = () =>
    Effect.scoped(
      RcMap.get(configurationClients, options.cwd).pipe(
        Effect.map((client) => nativeCapabilities(client.capabilities)),
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterCapabilitiesError({
              driver: PROVIDER,
              cause,
            }),
        ),
      ),
    );
  const openSession: NeoPiAdapterShape["openSession"] = Effect.fn("NeoPiAdapter.openSession")(
    function* (input) {
      const ownerScope = yield* Effect.scope;
      const initial: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: PROVIDER,
        providerInstanceId: options.instanceId,
        status: "starting",
        cwd: input.runtimePolicy.cwd ?? options.cwd,
        model: input.modelSelection.model || null,
        capabilities: yield* getCapabilities(),
        extensionStatuses: [],
        createdAt: input.resumeFromSession?.createdAt ?? (yield* DateTime.now),
        updatedAt: yield* DateTime.now,
        lastError: null,
      };
      const events = yield* Effect.acquireRelease(
        Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>(),
        Queue.shutdown,
      );
      const operation = yield* Semaphore.make(1);
      let planned: OrchestrationV2ProviderThread | undefined;
      let entry: Session | undefined;
      let closed = false;
      const currentThread = () => (entry && !entry.closed ? entry.providerThread : planned);
      const checkThread = Effect.fn("NeoPiAdapter.checkThread")(function* (
        thread: OrchestrationV2ProviderThread,
      ) {
        if (
          closed ||
          controllers.get(input.threadId) !== controller ||
          currentThread()?.id !== thread.id ||
          thread.driver !== PROVIDER ||
          thread.providerInstanceId !== options.instanceId ||
          thread.appThreadId !== input.threadId
        )
          return yield* new NeoPiRuntimeError({
            code: "rpc",
            message: "The native provider thread binding changed.",
          });
      });
      const ensure: ProviderAdapter.ProviderAdapterV2SessionRuntime["ensureThread"] = Effect.fn(
        "NeoPiAdapter.ensureThread",
      )(
        function* (request) {
          if (
            closed ||
            request.threadId !== input.threadId ||
            request.modelSelection.instanceId !== options.instanceId
          )
            return yield* new NeoPiRuntimeError({
              code: "rpc",
              message: "The requested thread belongs to a different native binding.",
            });
          if (request.forceNewNativeThread && entry) {
            yield* stopInternal(entry);
            entry = undefined;
            planned = undefined;
          }
          const existing = request.forceNewNativeThread
            ? undefined
            : (currentThread() ?? request.existingProviderThread);
          if (existing) {
            if (
              existing.driver !== PROVIDER ||
              existing.providerInstanceId !== options.instanceId ||
              existing.appThreadId !== input.threadId
            )
              return yield* new NeoPiRuntimeError({
                code: "rpc",
                message: "Cannot resume a different provider's thread.",
              });
            const cursor = yield* Effect.try({
              try: () => parseResumeCursor(existing.nativeMetadata?.neopiResumeCursor),
              catch: (cause) =>
                new NeoPiRuntimeError({
                  code: "rpc",
                  message: "The saved native cursor is invalid.",
                  cause,
                }),
            });
            if (
              existing.nativeThreadRef &&
              (!cursor || existing.nativeThreadRef.nativeId !== cursor.sessionId)
            )
              return yield* new NeoPiRuntimeError({
                code: "rpc",
                message: "The saved native identity has no matching resume cursor.",
              });
            planned = { ...existing, providerSessionId: input.providerSessionId };
          } else {
            if (input.initialNativeThreadId && !request.forceNewNativeThread)
              return yield* new NeoPiRuntimeError({
                code: "rpc",
                message: "A native thread id cannot replace its durable session cursor.",
              });
            const now = yield* DateTime.now;
            planned = {
              id: ProviderThreadId.make(yield* random.uuidV4()),
              driver: PROVIDER,
              providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: input.threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "not_loaded",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              contextUsage: null,
              nativeMetadata: null,
              goal: null,
              createdAt: now,
              updatedAt: now,
            };
          }
          return planned;
        },
        (effect, request) =>
          effect.pipe(
            operation.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: PROVIDER,
                  threadId: request.threadId,
                  cause,
                }),
            ),
          ),
      );
      const resumeForAccess = Effect.fn("NeoPiAdapter.resumeForAccess")(function* () {
        if (entry && !entry.closed) return entry;
        const thread = currentThread();
        const last = thread?.nativeMetadata?.neopiLastTurn;
        if (!thread)
          return yield* new NeoPiRuntimeError({
            code: "rpc",
            message: "The saved native thread is no longer available.",
          });
        yield* checkThread(thread);
        const binding: TurnBinding | undefined =
          last?.providerTurn.providerThreadId === thread.id
            ? {
                turnId: TurnId.make(last.providerTurn.id),
                runId: last.runId,
                nodeId: last.providerTurn.nodeId,
                runOrdinal: last.runOrdinal,
                providerTurn: last.providerTurn,
                ordinals: new Map(),
                settled: yield* Deferred.make<void>(),
                core: emptyCoreState(),
                tools: emptyToolState(),
                subagents: emptySubagentState(),
              }
            : undefined;
        if (binding) yield* Deferred.succeed(binding.settled, undefined);
        entry = yield* startRuntime(
          {
            threadId: input.threadId,
            providerThread: thread,
            runtimePolicy: input.runtimePolicy,
          },
          initial,
          events,
          ownerScope,
          operation,
          binding,
        );
        planned = entry.providerThread;
        return entry;
      });
      const readSnapshot = Effect.fn("NeoPiAdapter.readSnapshot")(function* () {
        const thread = currentThread();
        if (thread && !thread.nativeThreadRef && !thread.nativeMetadata?.neopiResumeCursor)
          return {
            providerThread: thread,
            providerTurns: [],
            messages: [],
            runtimeRequests: [],
          } satisfies ProviderAdapter.ProviderAdapterV2ThreadSnapshot;
        return yield* readThread(yield* resumeForAccess());
      });
      const start = Effect.fn("NeoPiAdapter.startTurn")(
        function* (request: ProviderAdapter.ProviderAdapterV2TurnInput, compact = false) {
          yield* checkThread(request.providerThread);
          if (request.modelSelection.instanceId !== options.instanceId)
            return yield* new NeoPiRuntimeError({
              code: "rpc",
              message: "The selected model belongs to a different native instance.",
            });
          if (entry && !entry.closed && entry.activeTurnId)
            return yield* new NeoPiRuntimeError({
              code: "rpc",
              message: "The previous native turn is still active.",
            });
          const providerTurnId = ProviderTurnId.make(`neopi:${request.attemptId}`);
          const binding: TurnBinding = {
            turnId: TurnId.make(providerTurnId),
            runId: request.runId,
            nodeId: request.rootNodeId,
            runOrdinal: request.runOrdinal,
            ordinals: new Map(),
            settled: yield* Deferred.make<void>(),
            providerTurn: {
              id: providerTurnId,
              providerThreadId: request.providerThread.id,
              nodeId: request.rootNodeId,
              runAttemptId: request.attemptId,
              nativeTurnRef: null,
              ordinal: request.providerTurnOrdinal,
              status: "pending",
              startedAt: null,
              completedAt: null,
              model: request.modelSelection.model,
            },
            core: emptyCoreState(),
            tools: emptyToolState(),
            subagents: emptySubagentState(),
          };
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver: PROVIDER,
            threadId: input.threadId,
            providerTurn: binding.providerTurn,
          });
          if (!entry || entry.closed) {
            entry = yield* startRuntime(
              { ...request, providerThread: currentThread() ?? request.providerThread },
              initial,
              events,
              ownerScope,
              operation,
              binding,
            );
          } else {
            binding.tools = withHostToolNames(binding.tools, [
              ...(entry.lastBinding?.tools.hostToolNames ?? []),
            ]);
            entry.bindings.set(binding.turnId, binding);
            entry.turns.set(binding.turnId, binding.providerTurn);
            entry.lastBinding = binding;
            for (const previous of entry.bindings.values())
              releaseCompletedBinding(entry, previous);
          }
          const active = entry;
          active.activeTurnId = binding.turnId;
          yield* sendTurn(active, request, binding, compact).pipe(
            Effect.tapError(() =>
              Effect.gen(function* () {
                if (
                  (yield* SubscriptionRef.get(active.runtime.state)) !== "running" &&
                  active.activeTurnId === binding.turnId
                ) {
                  delete active.activeTurnId;
                  yield* Deferred.succeed(binding.settled, undefined);
                }
              }),
            ),
          );
          planned = active.providerThread;
        },
        (effect, request, _compact = false) =>
          effect.pipe(
            operation.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: PROVIDER,
                  threadId: request.threadId,
                  providerThreadId: request.providerThread.id,
                  runId: request.runId,
                  cause,
                }),
            ),
          ),
      );
      const controller: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return entry?.session ?? initial;
        },
        canResumeAfterRestart: true,
        events: Stream.fromQueue(events),
        ensureThread: ensure,
        resumeThread: Effect.fn("NeoPiAdapter.resumeThread")(
          function* (request) {
            yield* ensure({
              threadId: request.threadId ?? input.threadId,
              existingProviderThread: request.providerThread,
              modelSelection: request.modelSelection ?? input.modelSelection,
              runtimePolicy: request.runtimePolicy ?? input.runtimePolicy,
            });
            return yield* Effect.gen(function* () {
              yield* checkThread(request.providerThread);
              return (yield* resumeForAccess()).providerThread;
            }).pipe(operation.withPermits(1));
          },
          (effect, request) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterEnsureThreadError({
                    driver: PROVIDER,
                    threadId: request.threadId ?? input.threadId,
                    cause,
                  }),
              ),
            ),
        ),
        startTurn: (request) => start(request),
        compactThread: (request) => start(request, true),
        steerTurn: Effect.fn("NeoPiAdapter.steerTurn")(
          function* (request) {
            yield* checkThread(request.providerThread);
            const active = yield* requireSession(input.threadId);
            const binding = active.activeTurnId
              ? active.bindings.get(active.activeTurnId)
              : undefined;
            if (
              !binding ||
              binding.providerTurn.id !== request.providerTurnId ||
              binding.runId !== request.runId
            )
              return yield* new NeoPiRuntimeError({
                code: "rpc",
                message: "The selected turn is no longer active.",
              });
            const prompt = yield* makePrompt(request.message, binding.turnId);
            yield* active.runtime.steer(prompt);
            yield* publishCursor(active);
          },
          (effect, request) =>
            effect.pipe(
              operation.withPermits(1),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver: PROVIDER,
                    providerThreadId: request.providerThread.id,
                    providerTurnId: request.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        interruptTurn: Effect.fn("NeoPiAdapter.interruptTurn")(
          function* (request) {
            yield* checkThread(request.providerThread);
            const active = yield* requireSession(input.threadId);
            const binding = active.activeTurnId
              ? active.bindings.get(active.activeTurnId)
              : undefined;
            if (!binding || binding.providerTurn.id !== request.providerTurnId)
              return yield* new NeoPiRuntimeError({
                code: "rpc",
                message: "The selected turn is no longer active.",
              });
            yield* active.runtime.interrupt;
          },
          (effect, request) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterInterruptError({
                    driver: PROVIDER,
                    providerThreadId: request.providerThread.id,
                    providerTurnId: request.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        respondToRuntimeRequest: Effect.fn("NeoPiAdapter.respondToRuntimeRequest")(
          function* (request) {
            const active = yield* requireSession(input.threadId);
            if (active.session.id !== input.providerSessionId)
              return yield* new NeoPiRuntimeError({
                code: "rpc",
                message: "The request owner was replaced.",
              });
            yield* respond(active, request);
          },
          (effect, request) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver: PROVIDER,
                    requestId: request.requestId,
                    cause,
                  }),
              ),
            ),
        ),
        readThreadSnapshot: Effect.fn("NeoPiAdapter.readThreadSnapshot")(
          function* (request) {
            yield* checkThread(request.providerThread);
            return yield* readSnapshot();
          },
          (effect, request) =>
            effect.pipe(
              operation.withPermits(1),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                    driver: PROVIDER,
                    providerThreadId: request.providerThread.id,
                    cause,
                  }),
              ),
            ),
        ),
        rollbackThread: Effect.fn("NeoPiAdapter.rollbackThread")(
          function* (request) {
            yield* checkThread(request.providerThread);
            const current = currentThread();
            if (
              request.target.type === "thread_start" &&
              current &&
              !current.nativeThreadRef &&
              !current.nativeMetadata?.neopiResumeCursor
            )
              return yield* readSnapshot();
            return yield* rollback(yield* resumeForAccess(), request);
          },
          (effect, request) =>
            effect.pipe(
              operation.withPermits(1),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRollbackThreadError({
                    driver: PROVIDER,
                    providerThreadId: request.providerThread.id,
                    checkpointId: request.target.checkpointId,
                    cause,
                  }),
              ),
            ),
        ),
        forkThread: (request) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver: PROVIDER,
              providerThreadId: request.sourceProviderThread.id,
              cause: "NeoPi RPC does not expose an independent native conversation fork.",
            }),
          ),
        unloadThread: Effect.fn("NeoPiAdapter.unloadThread")(
          function* (request) {
            yield* checkThread(request.providerThread);
            if (entry) {
              planned = entry.providerThread;
              yield* stopInternal(entry);
              entry = undefined;
            }
          },
          operation.withPermits(1),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterCloseSessionError({
                driver: PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
      };
      const previous = controllers.get(input.threadId);
      if (previous)
        return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
          driver: PROVIDER,
          providerSessionId: input.providerSessionId,
          cause: "A provider controller already owns this app thread.",
        });
      controllers.set(input.threadId, controller);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          if (controllers.get(input.threadId) === controller) controllers.delete(input.threadId);
          if (entry) yield* stopInternal(entry);
        }),
      );
      return controller;
    },
  );
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...sessions.values()], stopInternal, {
      concurrency: "unbounded",
      discard: true,
    }),
  );
  return {
    driver: PROVIDER,
    instanceId: options.instanceId,
    getCapabilities,
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession,
    observeNative: Effect.fn("NeoPiAdapter.observeNative")(function* (threadId) {
      const session = sessions.get(threadId);
      if (!session?.runtime.observeNative || !session.runtime.nativeRequest) return undefined;
      const runtime = session.runtime;
      const status = yield* SubscriptionRef.get(runtime.state);
      if (status === "stopped" || status === "failed") return undefined;
      const generation = runtime.processGeneration;
      const events = (yield* session.runtime.observeNative).pipe(
        Stream.mapError((cause) =>
          isNeoPiRuntimeError(cause)
            ? cause
            : new NeoPiRuntimeError({
                code: "rpc",
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
        ),
      );
      return {
        ownership: runtime.capabilities.has(NEOPI_CAPABILITIES.controlAttached)
          ? ("terminal" as const)
          : ("gui" as const),
        capabilities: runtime.capabilities,
        events,
        request: Effect.fn("NeoPiAdapter.nativeRequest")(
          function* (command: { readonly type: string; readonly [key: string]: unknown }) {
            if (sessions.get(threadId) !== session || runtime.processGeneration !== generation)
              return yield* new NeoPiRpcError({
                code: "closed",
                command: command.type,
                message: "The native runtime was replaced. Reconnect before issuing commands.",
              });
            const result = yield* session.runtime.nativeRequest!(command);
            if (sessions.get(threadId) !== session || runtime.processGeneration !== generation)
              return yield* new NeoPiRpcError({
                code: "closed",
                command: command.type,
                message: "The native runtime changed during the request.",
              });
            if (command.type === "navigate_tree") yield* publishCursor(session);
            return result;
          },
          (effect, command) =>
            command.type === "navigate_tree"
              ? effect.pipe(session.operation.withPermits(1))
              : effect,
        ),
      };
    }),
    readJournal: Effect.fn("NeoPiAdapter.readJournal")(function* (threadId, expected, paging) {
      const session = sessions.get(threadId);
      if (!session) return undefined;
      const runtime = session.runtime;
      const status = yield* SubscriptionRef.get(runtime.state);
      if (status === "stopped" || status === "failed") return undefined;
      if (status !== "ready" && status !== "running")
        return {
          status: "unavailable" as const,
          reason: "The NeoPi connection is transitioning. Retry after it settles.",
        };
      const generation = runtime.processGeneration;
      const cursorIdentity = Effect.gen(function* () {
        const cursor = yield* SubscriptionRef.get(runtime.cursor);
        const file = yield* fs.realPath(cursor.sessionFile).pipe(Effect.option);
        return file._tag === "Some"
          ? { sessionId: cursor.sessionId, sessionFile: file.value }
          : undefined;
      });
      const beforeIdentity = yield* cursorIdentity;
      if (!beforeIdentity || !sameNeoPiJournalIdentity(beforeIdentity, expected))
        return {
          status: "error" as const,
          code: "stale_cursor",
          message: "The bound native session changed. Restart this view.",
        };
      const result = yield* readNeoPiJournalPeer(runtime, expected, paging, (file) =>
        fs.realPath(file),
      );
      const afterStatus = yield* SubscriptionRef.get(runtime.state);
      const afterIdentity = yield* cursorIdentity;
      if (
        sessions.get(threadId) !== session ||
        runtime.processGeneration !== generation ||
        (afterStatus !== "ready" && afterStatus !== "running") ||
        !afterIdentity ||
        !sameNeoPiJournalIdentity(afterIdentity, expected)
      )
        return {
          status: "error" as const,
          code: "stale_cursor",
          message: "The native connection changed during this read. Restart this view.",
        };
      return result;
    }),
    getModelsConnection: Effect.fn("NeoPiAdapter.getModelsConnection")(
      function* (cwd, threadId, expected) {
        if (!threadId)
          return yield* RcMap.get(configurationClients, cwd).pipe(
            Effect.mapError((cause) =>
              isNeoPiModelsError(cause) ? cause : new NeoPiModelsError({ message: cause.message }),
            ),
          );
        const session = sessions.get(threadId);
        if (!session || !expected || !session.runtime.subscribeConfigurationChanges)
          return yield* new NeoPiModelsError({
            message: "The bound native session is not connected.",
          });
        const generation = session.runtime.processGeneration;
        const validate = Effect.gen(function* () {
          if (
            sessions.get(threadId) !== session ||
            session.runtime.processGeneration !== generation
          )
            return yield* new NeoPiModelsError({
              message: "The bound native runtime changed. Reopen Models.",
            });
          const snapshot = yield* readNeoPiSessionConfiguration(session.runtime, expected).pipe(
            Effect.mapError((cause) => new NeoPiModelsError({ message: cause.message })),
          );
          if (snapshot.status !== "available")
            return yield* new NeoPiModelsError({ message: snapshot.reason });
        });
        yield* validate;
        const changes = yield* session.runtime.subscribeConfigurationChanges;
        return {
          capabilities: session.runtime.capabilities,
          request: session.runtime.request,
          respondUi: session.runtime.respondUi,
          ui: Stream.fromPubSub(modelsUi).pipe(
            Stream.filter((entry) => entry.threadId === threadId),
            Stream.map((entry) => entry.frame),
          ),
          changes: Stream.fromEffectRepeat(PubSub.take(changes)),
          validate,
        };
      },
    ),
    observeConfiguration: Effect.fn("NeoPiAdapter.observeConfiguration")(
      function* (threadId, expected) {
        const session = sessions.get(threadId);
        const unavailable = (reason: string) => ({
          read: Effect.succeed({ status: "unavailable" as const, reason }),
          changes: Stream.empty,
        });
        if (!session?.runtime.subscribeConfigurationChanges)
          return unavailable("This thread has no connected NeoPi configuration observer.");
        const generation = session.runtime.processGeneration;
        const changes = yield* session.runtime.subscribeConfigurationChanges;
        const read = Effect.gen(function* () {
          if (
            sessions.get(threadId) !== session ||
            session.runtime.processGeneration !== generation
          )
            return {
              status: "unavailable" as const,
              reason: "The observed NeoPi runtime was replaced. Start following again.",
            };
          const result = yield* readNeoPiSessionConfiguration(session.runtime, expected).pipe(
            Effect.mapError((cause) => rpcError(threadId, "configuration", cause)),
          );
          if (
            sessions.get(threadId) !== session ||
            session.runtime.processGeneration !== generation
          )
            return {
              status: "unavailable" as const,
              reason: "The observed NeoPi runtime changed during the snapshot.",
            };
          return result.status === "available"
            ? { ...result, providerInstanceId: options.instanceId }
            : result;
        });
        return { read, changes: Stream.fromEffectRepeat(PubSub.take(changes)) };
      },
    ),
    getConfiguration: Effect.fn("NeoPiAdapter.getConfiguration")(function* (threadId, expected) {
      const session = sessions.get(threadId);
      if (!session)
        return {
          status: "unavailable" as const,
          reason: "This thread has no connected NeoPi runtime.",
        };
      const result = yield* readNeoPiSessionConfiguration(session.runtime, expected).pipe(
        Effect.mapError((cause) => rpcError(threadId, "configuration", cause)),
      );
      if (sessions.get(threadId) !== session)
        return {
          status: "unavailable" as const,
          reason: "The NeoPi runtime was replaced during the snapshot.",
        };
      return result.status === "available"
        ? { ...result, providerInstanceId: options.instanceId }
        : result;
    }),
    getLiveUsage: Effect.fn("NeoPiAdapter.getLiveUsage")(function* (activeProvider) {
      for (const session of sessions.values()) {
        if (!session.runtime.capabilities.has(NEOPI_CAPABILITIES.getUsage)) continue;
        if ((yield* SubscriptionRef.get(session.runtime.state)) !== "ready") continue;
        return yield* session.runtime
          .request({ type: "get_usage", provider: activeProvider, redact: true })
          .pipe(Effect.mapError((cause) => rpcError(session.threadId, "get_usage", cause)));
      }
      return undefined;
    }),
  } satisfies NeoPiAdapterShape;
});
