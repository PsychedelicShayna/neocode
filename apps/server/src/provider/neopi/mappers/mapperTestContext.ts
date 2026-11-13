import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnId,
  TurnItemId,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { CoreMapCtx } from "./MapCtx.ts";

const capabilities: OrchestrationV2ProviderCapabilities = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: false,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: false,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: false,
    emitsTurnCompleted: false,
    supportsInterrupt: false,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: false,
    terminalStatusQuality: "none",
  },
  streaming: {
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: false,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "none",
    nativeTurnIds: "none",
    nativeItemIds: "none",
    nativeRequestIds: "none",
  },
  runtimePolicy: { enforcement: "client-boundary" },
};

export function mapperTestContext(child = false): CoreMapCtx {
  let nextId = 0;
  const ordinals = new Map<string, number>();
  const now = "2026-09-27T00:00:00.000Z";
  const timestamp = DateTime.makeUnsafe(now);
  const driver = ProviderDriverKind.make("neopi");
  const instanceId = ProviderInstanceId.make("neopi-test");
  const threadId = ThreadId.make("thread-test");
  const providerSessionId = ProviderSessionId.make("session-test");
  const providerThreadId = ProviderThreadId.make(child ? "child-thread" : "provider-thread");
  const providerTurnId = ProviderTurnId.make(child ? "child-turn" : "provider-turn");
  const nodeId = NodeId.make(child ? "child-node" : "root-node");
  return {
    provider: driver,
    providerInstanceId: instanceId,
    threadId,
    turnId: TurnId.make("turn-test"),
    sessionKey: "native-session",
    providerSessionId,
    providerThreadId,
    providerTurnId,
    runId: RunId.make("run-test"),
    runOrdinal: 1,
    nodeId,
    itemOrdinal(id) {
      const prior = ordinals.get(id);
      if (prior !== undefined) return prior;
      const ordinal = ordinals.size + 1;
      ordinals.set(id, ordinal);
      return ordinal;
    },
    providerSession: {
      id: providerSessionId,
      driver,
      providerInstanceId: instanceId,
      status: "ready",
      cwd: "/workspace",
      model: "openai/initial",
      capabilities,
      extensionStatuses: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      lastError: null,
    },
    providerThread: {
      id: providerThreadId,
      driver,
      providerInstanceId: instanceId,
      providerSessionId,
      appThreadId: threadId,
      ownerNodeId: nodeId,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      contextUsage: null,
      nativeMetadata: {
        modelSelection: {
          instanceId,
          model: "openai/initial",
          options: [{ id: "fastMode", value: true }],
        },
      },
      goal: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    providerTurn: {
      id: providerTurnId,
      providerThreadId,
      nodeId,
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "pending",
      startedAt: null,
      completedAt: null,
    },
    ...(child ? { agentId: "child-1", parentItemId: TurnItemId.make("parent-tool") } : {}),
    now: () => now,
    newEventId: () => `event-${++nextId}`,
  };
}
