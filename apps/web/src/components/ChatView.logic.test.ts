import {
  boundAttachmentIds,
  mergeDirectPreviewAnnotation,
  planComposerTurn,
  snapshotComposerSend,
  deriveAvailableRevertTurnCounts,
  recallCheckoutIsRepo,
  rememberCheckoutIsRepo,
  resolveComposerProviderSelection,
  resolveWorktreeSetupProgress,
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resetHeldThreadTimeline,
  resolveThreadSwitchTimeline,
  timelineHasEphemeralPreviewUrls,
  createLocalDispatchSnapshot,
  hasServerAcknowledgedLocalDispatch,
  deriveCommittedServerUserMessageIds,
  deriveComposerSendState,
  deriveLockedProvider,
  resolveThreadMetadataUpdateForNextTurn,
  shouldReleaseTimelineAnchorForToolActivity,
  waitForRevertedMessage,
} from "./ChatView.logic";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  RunId,
  TurnItemId,
  type ServerProvider,
  type OrchestrationV2ProjectedTurnItem,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { ensureInlineContextReferences } from "../lib/composerContextReferences";
import { terminalContextReference } from "../lib/composerContextRecords";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";
import type { Thread } from "../types";
import { makeThreadFixture, makeThreadProjectionFixture } from "../test-fixtures";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    runtime: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

const completedTurn = {
  runId: RunId.make("turn-1"),
  status: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  status: "completed" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  activeRunId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};

describe("deriveComposerSendState", () => {
  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo [Terminal 1](t3-context://v1/terminal/ctx-expired) waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  it("acknowledges a settled newer background turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: completedTurn, runtime: readySession }),
      { submissionIntent: "background" },
    );
    const newerTurn = {
      ...completedTurn,
      runId: RunId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestRun: newerTurn,
        runtime: { ...readySession, updatedAt: newerTurn.completedAt },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("holds a first send while the thread shell still reports a preparing run", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const preparingRun = {
      ...completedTurn,
      status: "preparing" as const,
      startedAt: null,
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "disconnected",
        latestRun: preparingRun,
        runtime: { ...readySession, status: "preparing", activeRunId: preparingRun.runId },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it.each([
    ["queued", "message-queued", true],
    ["queued", "message-before-send", false],
    ["preparing", "message-queued", false],
    ["starting", "message-queued", false],
  ] as const)("acknowledges %s with latest message %s: %s", (status, messageId, acknowledged) => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: completedTurn, runtime: readySession }),
      { latestUserMessageId: MessageId.make("message-before-send") },
    );
    // The shell hides the silent compaction run, so its runtime reports the queued message's run.
    const queuedRun = {
      ...completedTurn,
      runId: RunId.make("turn-queued"),
      status: "queued" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: null,
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: queuedRun,
        latestUserMessageId: MessageId.make(messageId),
        runtime: { ...readySession, status },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(acknowledged);
  });

  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: completedTurn, runtime: readySession }),
    );
    const runningTurn = {
      ...completedTurn,
      runId: RunId.make("turn-2"),
      status: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: runningTurn,
        runtime: {
          ...readySession,
          status: "running",
          activeRunId: RunId.make("turn-other"),
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: runningTurn,
        runtime: {
          ...readySession,
          status: "running",
          activeRunId: runningTurn.runId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges a steering message projected onto the current running run", () => {
    const runningRun = {
      ...completedTurn,
      status: "running" as const,
      completedAt: null,
    };
    const runningRuntime = {
      ...readySession,
      status: "running" as const,
      activeRunId: runningRun.runId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestRun: runningRun, runtime: runningRuntime }),
      { latestUserMessageId: MessageId.make("message-before-steer") },
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestRun: runningRun,
        latestUserMessageId: MessageId.make("message-steer"),
        runtime: runningRuntime,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });
});

describe("deriveCommittedServerUserMessageIds", () => {
  it("tracks only committed user turn items, not assistant rows or projection-only messages", () => {
    const turnStartId = MessageId.make("message-turn-start");
    const steerId = MessageId.make("message-steer");
    const assistantId = MessageId.make("message-assistant");
    const committedAt = DateTime.makeUnsafe("2026-06-26T17:50:15.180Z");
    const runId = RunId.make("run:thread:thread-1:ordinal:1");
    const visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [
      {
        position: 0,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:message-turn-start"),
        item: {
          id: TurnItemId.make("turn-item:message-turn-start"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: committedAt,
          completedAt: committedAt,
          updatedAt: committedAt,
          createdBy: "user",
          creationSource: "web",
          type: "user_message",
          messageId: turnStartId,
          inputIntent: "turn_start",
          text: "start",
          attachments: [],
        },
      },
      {
        position: 1,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:message-assistant"),
        item: {
          id: TurnItemId.make("turn-item:message-assistant"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "completed",
          title: null,
          startedAt: committedAt,
          completedAt: committedAt,
          updatedAt: committedAt,
          type: "assistant_message",
          messageId: assistantId,
          text: "working",
          streaming: false,
        },
      },
      {
        position: 2,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:message-steer"),
        item: {
          id: TurnItemId.make("turn-item:message-steer"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 3,
          status: "completed",
          title: null,
          startedAt: committedAt,
          completedAt: committedAt,
          updatedAt: committedAt,
          createdBy: "user",
          creationSource: "web",
          type: "user_message",
          messageId: steerId,
          inputIntent: "steer",
          text: "continue",
          attachments: [],
        },
      },
    ];

    expect(deriveCommittedServerUserMessageIds(visibleTurnItems)).toEqual(
      new Set([turnStartId, steerId]),
    );
  });
});

describe("resolveThreadSwitchTimeline", () => {
  afterEach(() => {
    resetHeldThreadTimeline();
  });

  const held = { threadKey: "env-1:thread-a", entries: ["a1", "a2"] };

  it("paints a remembered destination instead of the last-viewed thread", () => {
    rememberReadyThreadTimeline(held);
    rememberReadyThreadTimeline({ threadKey: "env-1:thread-b", entries: ["b1", "b2"] });
    expect(peekRememberedThreadTimeline<string[]>("env-1:thread-a")).toEqual(["a1", "a2"]);
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-1:thread-a",
        nextEntries: [],
      }),
    ).toEqual(["a1", "a2"]);
  });

  it("does not paint the last-viewed thread for a destination with nothing remembered", () => {
    rememberReadyThreadTimeline(held);
    expect(
      resolveThreadSwitchTimeline({
        loading: true,
        activeThreadKey: "env-2:thread-b",
        nextEntries: [],
      }),
    ).toEqual([]);
  });

  it("does not remember a timeline that still has handoff blob previews", () => {
    expect(
      timelineHasEphemeralPreviewUrls([
        {
          kind: "message",
          message: {
            id: MessageId.make("preview-message"),
            role: "user",
            text: "Preview",
            runId: null,
            streaming: false,
            createdAt: "2026-09-10T12:00:00.000Z",
            updatedAt: "2026-09-10T12:00:00.000Z",
            attachments: [
              {
                type: "image",
                id: "preview",
                name: "preview.png",
                mimeType: "image/png",
                sizeBytes: 1,
                previewUrl: "blob:handoff",
              },
            ],
          },
        },
      ]),
    ).toBe(true);
    expect(
      timelineHasEphemeralPreviewUrls([
        {
          kind: "message",
          message: {
            id: MessageId.make("preview-message"),
            role: "user",
            text: "Preview",
            runId: null,
            streaming: false,
            createdAt: "2026-09-10T12:00:00.000Z",
            updatedAt: "2026-09-10T12:00:00.000Z",
            attachments: [
              {
                type: "image",
                id: "preview",
                name: "preview.png",
                mimeType: "image/png",
                sizeBytes: 1,
                previewUrl: "https://cdn.example/a.png",
              },
            ],
          },
        },
      ]),
    ).toBe(false);
  });
});

describe("shouldReleaseTimelineAnchorForToolActivity", () => {
  const activeTurnId = RunId.make("active-turn");
  const anchorMessageId = MessageId.make("anchored-message");
  const activeToolEntry = {
    id: "tool-entry",
    kind: "work" as const,
    createdAt: now,
    entry: {
      id: "active-tool",
      createdAt: now,
      runId: activeTurnId,
      label: "Run command",
      tone: "tool" as const,
      command: "git status",
    },
  };

  it("releases the send anchor for tool activity in the active turn", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: true,
        runningTurnId: activeTurnId,
        timelineEntries: [activeToolEntry],
      }),
    ).toBe(true);
  });

  it("keeps the anchor while the user reads history", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: false,
        runningTurnId: activeTurnId,
        timelineEntries: [activeToolEntry],
      }),
    ).toBe(false);
  });

  it("ignores tool activity from earlier turns", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: true,
        runningTurnId: activeTurnId,
        timelineEntries: [
          {
            ...activeToolEntry,
            entry: {
              ...activeToolEntry.entry,
              runId: RunId.make("previous-turn"),
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("ignores thinking and error rows without tool activity", () => {
    expect(
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId,
        liveFollowEnabled: true,
        runningTurnId: activeTurnId,
        timelineEntries: [
          {
            ...activeToolEntry,
            entry: {
              id: "thinking-entry",
              createdAt: now,
              runId: activeTurnId,
              label: "Thinking",
              tone: "thinking",
            },
          },
          {
            ...activeToolEntry,
            id: "error-entry",
            entry: {
              id: "error-entry",
              createdAt: now,
              runId: activeTurnId,
              label: "Provider error",
              tone: "error",
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("does nothing without an anchor or running turn", () => {
    const input = {
      anchorMessageId,
      liveFollowEnabled: true,
      runningTurnId: activeTurnId,
      timelineEntries: [activeToolEntry],
    };

    expect(shouldReleaseTimelineAnchorForToolActivity({ ...input, anchorMessageId: null })).toBe(
      false,
    );
    expect(shouldReleaseTimelineAnchorForToolActivity({ ...input, runningTurnId: null })).toBe(
      false,
    );
  });
});

it("keeps a legacy runtime's identity authoritative over a new draft choice", () => {
  const thread = makeThread({
    latestRun: completedTurn,
    runtime: { ...readySession, providerName: "claudeAgent" },
  });
  expect(
    deriveLockedProvider({
      thread,
      selectedProvider: "neopi",
      threadProvider: "saved-legacy",
      providers: [],
    }),
  ).toBe("claudeAgent");
});

describe("resolveThreadMetadataUpdateForNextTurn", () => {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };

  it("updates a stale local thread branch to the active checkout", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        currentBranch: "feature/thread",
        nextBranch: "feature/checkout",
      }),
    ).toEqual({ branch: "feature/checkout", worktreePath: null });
  });

  it("does not write metadata when the model and branch are unchanged", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        nextModelSelection: modelSelection,
        currentBranch: "feature/current",
        nextBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("resolveComposerProviderSelection", () => {
  const models: ServerProvider["models"] = [
    { slug: "openai-codex/current", name: "Current", isCustom: false, capabilities: null },
  ];
  const entry = (driver: string, id = driver, overrides: Partial<ServerProvider> = {}) =>
    deriveProviderInstanceEntries([
      {
        driver: ProviderDriverKind.make(driver),
        instanceId: ProviderInstanceId.make(id),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "unknown" },
        version: null,
        checkedAt: now,
        models,
        slashCommands: [],
        skills: [],
        ...overrides,
      },
    ])[0]!;

  function importedThread(instanceId: ProviderInstanceId) {
    return makeThread({
      modelSelection: { instanceId, model: "default" },
      itemCount: 1,
    });
  }

  it.each([
    ["claudeAgent", "claude_work"],
    ["codex", "codex_work"],
    ["ollama", "local_models"],
  ])(
    "retains imported %s identity without admitting its custom instance to execution",
    (driver, instanceId) => {
      const importedEntry = entry(driver, instanceId);
      const native = entry("neopi");
      const entries = [native, importedEntry];
      const thread = importedThread(importedEntry.instanceId);
      const lockedProvider = deriveLockedProvider({
        thread,
        selectedProvider: native.instanceId,
        threadProvider: thread.modelSelection.instanceId,
        providers: entries.map((entry) => entry.snapshot),
      });
      expect(thread.runtime).toBeNull();
      expect(lockedProvider).toBe(driver);
      const selection = resolveComposerProviderSelection({
        entries,
        candidateInstanceIds: [importedEntry.instanceId],
        lockedProvider,
        lockedInstanceId: importedEntry.instanceId,
      });
      expect(selection.selectedProviderEntry).toBeUndefined();
      expect(selection.unavailableProviderInstanceId).toBe(importedEntry.instanceId);
    },
  );

  it("uses a ready NeoPi instance even when an old runtime arrives first", () => {
    const native = entry("neopi");
    expect(
      resolveComposerProviderSelection({
        entries: [entry("codex"), native],
        candidateInstanceIds: [ProviderInstanceId.make("codex")],
        lockedProvider: null,
        lockedInstanceId: null,
      }).selectedProviderEntry,
    ).toBe(native);
  });

  it.each(["codex", "removed"])(
    "releases an unstarted %s instance choice without releasing an established writer",
    (instanceId) => {
      const native = entry("neopi");
      const savedInstanceId = ProviderInstanceId.make(instanceId);
      const selection = {
        entries: [entry("codex"), native],
        candidateInstanceIds: [savedInstanceId],
        lockedInstanceId: savedInstanceId,
      };
      expect(
        resolveComposerProviderSelection({ ...selection, lockedProvider: null })
          .selectedProviderEntry,
      ).toBe(native);
      expect(
        resolveComposerProviderSelection({
          ...selection,
          lockedProvider: ProviderDriverKind.make(instanceId === "codex" ? "codex" : "neopi"),
        }).selectedProviderEntry,
      ).toBeUndefined();
    },
  );

  it("does not reinterpret legacy history as a NeoPi session", () => {
    const legacy = entry("claudeAgent", "saved-work");
    const selection = resolveComposerProviderSelection({
      entries: [legacy, entry("neopi")],
      candidateInstanceIds: [legacy.instanceId],
      lockedProvider: legacy.driverKind,
      lockedInstanceId: legacy.instanceId,
    });
    expect(selection.selectedProviderEntry).toBeUndefined();
    expect(selection.unavailableProviderInstanceId).toBe(legacy.instanceId);
  });

  it("does not offer an enabled old runtime when no NeoPi instance is ready", () => {
    const selection = resolveComposerProviderSelection({
      entries: [entry("codex"), entry("neopi", "neopi", { enabled: false })],
      candidateInstanceIds: [],
      lockedProvider: null,
      lockedInstanceId: null,
    });
    expect(selection.selectedProviderEntry).toBeUndefined();
  });

  it("uses another ready NeoPi configuration when an obsolete draft choice cannot run", () => {
    const personal = entry("neopi", "personal");
    const selection = resolveComposerProviderSelection({
      entries: [entry("neopi", "neopi", { status: "error" }), personal],
      candidateInstanceIds: [ProviderInstanceId.make("removed")],
      lockedProvider: null,
      lockedInstanceId: null,
    });
    expect(selection.selectedProviderEntry).toBe(personal);
  });

  it("does not move a native session to a different instance without continuation identity", () => {
    const selection = resolveComposerProviderSelection({
      entries: [entry("neopi", "other")],
      candidateInstanceIds: [ProviderInstanceId.make("removed")],
      lockedProvider: ProviderDriverKind.make("neopi"),
      lockedInstanceId: ProviderInstanceId.make("removed"),
    });
    expect(selection.selectedProviderEntry).toBeUndefined();
  });

  it("keeps an established native continuation group authoritative", () => {
    const original = entry("neopi", "original", {
      enabled: false,
      continuation: { groupKey: "native-profile" },
    });
    const compatible = entry("neopi", "compatible", {
      continuation: { groupKey: "native-profile" },
    });
    const unrelated = entry("neopi", "other", { continuation: { groupKey: "other-profile" } });
    expect(
      resolveComposerProviderSelection({
        entries: [original, unrelated, compatible],
        candidateInstanceIds: [unrelated.instanceId],
        lockedProvider: ProviderDriverKind.make("neopi"),
        lockedInstanceId: original.instanceId,
      }).selectedProviderEntry,
    ).toBe(compatible);
  });
});

describe("checkout Git memory", () => {
  it("does not confuse an environment id containing the separator with a path", () => {
    rememberCheckoutIsRepo(EnvironmentId.make("env"), "a:b", false);
    expect(recallCheckoutIsRepo(EnvironmentId.make("env:a"), "b")).toBeUndefined();
  });
});

describe("worktree setup visibility", () => {
  const stage = (
    id: "fetch" | "checkout" | "submodules" | "setup-script" | "agent",
    status: "done" | "running" | "failed" | "pending",
  ) => ({
    id,
    status,
    startedAt: now,
    endedAt: status === "running" || status === "pending" ? null : now,
    percent: null,
    detail: null,
    tail: [],
  });
  const base = {
    threadId,
    phase: "running" as const,
    startedAt: now,
    endedAt: null,
    branch: "feature",
    baseRef: "main",
    worktreePath: null,
    setupScript: null,
    stages: [stage("checkout", "running"), stage("agent", "pending")],
    error: null,
    sequence: 1,
  };
  const settledDone = {
    ...base,
    phase: "done" as const,
    endedAt: now,
    stages: [stage("checkout", "done"), stage("setup-script", "done"), stage("agent", "done")],
  };

  it("uses streamed setup progress immediately without reverting to an older held snapshot", () => {
    const newest = { ...settledDone, sequence: 9 };
    const resolve = (latest: WorktreeSetupSnapshot | null, held: WorktreeSetupSnapshot | null) =>
      resolveWorktreeSetupProgress({
        threadId,
        localPreparing: false,
        runStatus: "running",
        latest,
        held,
      });
    expect(resolve(newest, base)).toEqual({ snapshot: newest, isPreparingWorktree: false });
    expect(resolve(base, newest)).toEqual({ snapshot: newest, isPreparingWorktree: false });
    const other = { ...base, threadId: ThreadId.make("another-thread") };
    expect(resolve(other, other)).toEqual({ snapshot: null, isPreparingWorktree: false });
  });
});

describe("waitForRevertedMessage", () => {
  const threadRef = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("t") };
  const messageId = MessageId.make("message-2");
  const requestId = CommandId.make("rollback-1");

  function projectionAtom() {
    const base = makeThreadProjectionFixture();
    const providerThreadId = ProviderThreadId.make("provider-thread");
    const projection = {
      ...base,
      thread: { ...base.thread, activeProviderThreadId: providerThreadId },
      providerThreads: [
        {
          id: providerThreadId,
          driver: "codex",
          providerInstanceId: base.thread.providerInstanceId,
          providerSessionId: ProviderSessionId.make("provider-session"),
          appThreadId: base.thread.id,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 4,
          handoffIds: [],
          forkedFrom: null,
          createdAt: base.updatedAt,
          updatedAt: base.updatedAt,
        },
      ],
      runs: [1, 2, 3, 4].map((ordinal) => ({
        id: RunId.make(`run-${ordinal}`),
        threadId: base.thread.id,
        ordinal,
        providerInstanceId: base.thread.providerInstanceId,
        modelSelection: base.thread.modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`message-${ordinal}`),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: base.updatedAt,
        startedAt: base.updatedAt,
        completedAt: base.updatedAt,
        checkpointId: null,
        contextHandoffId: null,
      })),
      messages: [
        {
          id: messageId,
          threadId: base.thread.id,
          runId: RunId.make("run-2"),
          nodeId: null,
          role: "user",
          text: "second",
          attachments: [],
          streaming: false,
          createdAt: base.updatedAt,
          updatedAt: base.updatedAt,
        },
      ],
    } as unknown as ReturnType<typeof makeThreadProjectionFixture>;
    const state = Atom.make({ data: Option.some(projection) });
    vi.spyOn(environmentThreadDetails, "stateAtom").mockReturnValue(state as never);
    return { state, projection };
  }

  afterEach(() => vi.restoreAllMocks());

  it("rejects with the projected reason when the rollback fails for good", async () => {
    const { state, projection } = projectionAtom();
    const waiting = waitForRevertedMessage(threadRef, 1, requestId, async () => {});
    await Promise.resolve();
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: {
          ...projection.thread,
          rollbackFailure: { requestId, message: "The provider could not roll back." },
        },
      }),
    });

    await expect(waiting).rejects.toThrow("The provider could not roll back.");
  });

  it.each([
    ["same", "streamed"],
    ["replacement", "streamed"],
    ["replacement", "refetched"],
  ] as const)(
    "waits for the retained rollback suffix when the edited message and run are paged out (%s provider, %s)",
    async (providerIdentity, projectionSource) => {
      vi.useFakeTimers();
      const { state, projection } = projectionAtom();
      const latestRunId = RunId.make("latest-run-9");
      const latestRun = {
        ...projection.runs[3]!,
        id: latestRunId,
        ordinal: 9,
        userMessageId: MessageId.make("latest-message-9"),
        status: "cancelled" as const,
      };
      const bounded = {
        ...projection,
        messages: [],
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 9,
        })),
        runs: [
          {
            ...latestRun,
            id: RunId.make("old-rewound-run-3"),
            userMessageId: MessageId.make("old-rewound-message-3"),
            ordinal: 3,
            status: "rolled_back" as const,
          },
          latestRun,
        ],
      };
      const oldProviderThread = bounded.providerThreads[0]!;
      const completedProviderThread = {
        ...oldProviderThread,
        ...(providerIdentity === "replacement"
          ? { id: ProviderThreadId.make("replacement-provider-thread"), firstRunOrdinal: null }
          : {}),
        lastRunOrdinal: null,
      };
      appAtomRegistry.set(state, { data: Option.some(bounded) });
      let outcome = "pending";
      const waiting = waitForRevertedMessage(threadRef, 0, requestId, async () => {}).then(
        () => {
          outcome = "reverted";
        },
        (error: Error) => {
          outcome = error.message;
        },
      );

      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBe("pending");

        appAtomRegistry.set(state, {
          data: Option.some({
            ...bounded,
            thread: {
              ...bounded.thread,
              activeProviderThreadId:
                projectionSource === "refetched"
                  ? completedProviderThread.id
                  : oldProviderThread.id,
            },
            providerThreads:
              providerIdentity === "replacement"
                ? [oldProviderThread, completedProviderThread]
                : [completedProviderThread],
            runs: bounded.runs.map((run) =>
              run.id === latestRunId ? { ...run, status: "rolled_back" as const } : run,
            ),
          }),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBe("reverted");
        await waiting;
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("waits for the requested target when another client finishes a shallower rewind", async () => {
    vi.useFakeTimers();
    const { state, projection } = projectionAtom();
    let outcome = "pending";
    const waiting = waitForRevertedMessage(threadRef, 1, requestId, async () => {}).then(
      () => {
        outcome = "reverted";
      },
      (error: Error) => {
        outcome = error.message;
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("pending");

      // Our command is accepted while the earlier target-3 effect is still running.
      const shallowerRewind = {
        ...projection,
        thread: { ...projection.thread, rollbackRequestId: requestId, rollbackFailure: null },
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 3,
        })),
        runs: projection.runs.map((run) =>
          run.ordinal > 3 ? { ...run, status: "rolled_back" as const } : run,
        ),
      };
      appAtomRegistry.set(state, { data: Option.some(shallowerRewind) });
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("pending");

      appAtomRegistry.set(state, {
        data: Option.some({
          ...shallowerRewind,
          providerThreads: shallowerRewind.providerThreads.map((thread) => ({
            ...thread,
            lastRunOrdinal: 1,
          })),
          runs: shallowerRewind.runs.map((run) =>
            run.ordinal > 1 ? { ...run, status: "rolled_back" as const } : run,
          ),
        }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("reverted");
      await waiting;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("rejects a stale edit already rewound by another client during attachment preparation", async () => {
    vi.useFakeTimers();
    const { state, projection } = projectionAtom();
    appAtomRegistry.set(state, {
      data: Option.some({
        ...projection,
        thread: { ...projection.thread, rollbackRequestId: CommandId.make("other-client-rewind") },
        messages: [],
        providerThreads: projection.providerThreads.map((thread) => ({
          ...thread,
          lastRunOrdinal: 1,
        })),
        runs: projection.runs.map((run) =>
          run.ordinal > 1 ? { ...run, status: "rolled_back" as const } : run,
        ),
      }),
    });
    const revert = vi.fn(async () => {});
    let outcome = "pending";
    const waiting = waitForRevertedMessage(threadRef, 1, requestId, revert).then(
      () => {
        outcome = "reverted";
      },
      () => {
        outcome = "rejected";
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("rejected");
      expect(revert).not.toHaveBeenCalled();
      await waiting;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("mergeDirectPreviewAnnotation", () => {
  const annotation = (id: string) =>
    ({
      id,
      pageUrl: "http://localhost:5173/",
      pageTitle: null,
      comment: "tighten this",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: {
        dataUrl: "data:image/png;base64,AAAA",
        width: 10,
        height: 10,
        cropRect: { x: 0, y: 0, width: 10, height: 10 },
      },
      createdAt: "2026-10-16T00:00:00.000Z",
    }) as const;
  const image = (id: string) =>
    ({ id, type: "image", name: `${id}.png`, mimeType: "image/png", sizeBytes: 1 }) as never;

  it("drops the screenshot claim when the attachment cap is full", () => {
    const result = mergeDirectPreviewAnnotation({
      images: [],
      fileCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
      previewAnnotations: [],
      direct: { annotation: annotation("a"), image: image("crop") },
    });
    expect(result.images).toEqual([]);
    expect(result.previewAnnotations[0]?.screenshot).toBeNull();
  });
});

describe("snapshotComposerSend", () => {
  const expired = {
    id: "ctx-expired",
    threadId,
    terminalId: "default",
    terminalLabel: "Terminal 1",
    lineStart: 4,
    lineEnd: 4,
    text: "",
    createdAt: now,
  };
  const live = { ...expired, id: "ctx-live", text: "pnpm test", lineStart: 9, lineEnd: 9 };

  it("drops expired terminal contexts from the contexts and from the prompt", () => {
    const snapshot = snapshotComposerSend({
      prompt: ensureInlineContextReferences("run", [
        terminalContextReference(expired),
        terminalContextReference(live),
      ]),
      images: [],
      files: [],
      terminalContexts: [expired, live],
      sendableTerminalContexts: [live],
      previewAnnotations: [],
      reviewComments: [],
      threadContexts: [],
      environmentContexts: [],
    });

    expect(snapshot.terminalContexts).toEqual([live]);
    expect(snapshot.messageText).toBe(
      ensureInlineContextReferences("run", [terminalContextReference(live)]).trim(),
    );
  });
});

describe("planComposerTurn", () => {
  const base = {
    messageText: "hello",
    sendQueuesBehindSetup: false,
    isServerThread: false,
    activeMessageCount: 0,
    sendEnvMode: "worktree" as const,
    worktreePath: null,
    activeThreadBranch: "main",
    resumeCompactionTokens: null,
    keepFullHistory: false,
    phase: "ready" as const,
    dispatchMode: "auto" as const,
    freshContext: false,
  };

  it("prepares a worktree from the selected branch on a new thread", () => {
    expect(planComposerTurn(base)).toMatchObject({
      missingWorktreeBaseBranch: false,
      baseBranchForWorktree: "main",
      shouldQueueBehindActiveRun: false,
    });
  });

  it("refuses a new worktree without a base branch", () => {
    expect(planComposerTurn({ ...base, activeThreadBranch: null })).toMatchObject({
      missingWorktreeBaseBranch: true,
      baseBranchForWorktree: null,
    });
  });

  it("queues behind a compaction of a stale session, except for /compact itself", () => {
    const stale = { ...base, resumeCompactionTokens: 120_000 };
    for (const messageText of ["hello", "/compactfoo"]) {
      expect(planComposerTurn({ ...stale, messageText })).toMatchObject({
        compactBeforeSend: true,
        turnDispatchMode: "queue",
        shouldQueueBehindActiveRun: true,
      });
    }
    for (const messageText of ["/COMPACT", "/compact keep the API notes", "/compact\n  tests"]) {
      expect(planComposerTurn({ ...stale, messageText })).toMatchObject({
        compactBeforeSend: false,
        turnDispatchMode: "auto",
        shouldQueueBehindActiveRun: false,
      });
    }
  });

  it("queues behind a running turn only when asked to", () => {
    const running = {
      ...base,
      isServerThread: true,
      activeMessageCount: 3,
      phase: "running" as const,
    };
    expect(planComposerTurn({ ...running, dispatchMode: "queue" }).shouldQueueBehindActiveRun).toBe(
      true,
    );
    expect(planComposerTurn({ ...running, dispatchMode: "steer" })).toMatchObject({
      shouldQueueBehindActiveRun: false,
      baseBranchForWorktree: null,
    });
    // A fresh session cannot join the running turn, and a stale one is not compacted first.
    expect(
      planComposerTurn({
        ...running,
        dispatchMode: "steer",
        freshContext: true,
        resumeCompactionTokens: 120_000,
      }),
    ).toMatchObject({
      compactBeforeSend: false,
      turnDispatchMode: "queue",
      shouldQueueBehindActiveRun: true,
    });
  });
});

describe("boundAttachmentIds", () => {
  it("prefers the uploaded id and falls back to the local one", () => {
    expect(
      boundAttachmentIds([{ id: "upload-1" }, {}], [{ id: "local-1" }, { id: "local-2" }]),
    ).toEqual(["upload-1", "local-2"]);
  });
});

describe("deriveAvailableRevertTurnCounts", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread");
  const otherProviderThreadId = ProviderThreadId.make("other-provider-thread");

  function projection(input: { readonly providerSessionId: ProviderSessionId | null }) {
    const base = makeThreadProjectionFixture();
    const run = (ordinal: number) => ({
      id: RunId.make(`run-${ordinal}`),
      ordinal,
      activeAttemptId: `attempt-${ordinal}`,
    });
    const turn = (ordinal: number, attempt: number, threadId: ProviderThreadId) => ({
      id: `turn-${attempt}-${ordinal}`,
      runAttemptId: `attempt-${attempt}`,
      ordinal,
      providerThreadId: threadId,
    });
    return {
      ...base,
      thread: { ...base.thread, activeProviderThreadId: providerThreadId },
      providerThreads: [
        {
          id: providerThreadId,
          providerInstanceId: base.thread.modelSelection.instanceId,
          providerSessionId: input.providerSessionId,
        },
      ],
      runs: [run(1), run(2), run(3)],
      attempts: [1, 2, 3].map((ordinal) => ({ id: `attempt-${ordinal}`, providerTurnId: null })),
      // Run 2's latest turn moved to another provider thread, so its checkpoint cannot restore
      // this conversation.
      providerTurns: [
        turn(1, 1, providerThreadId),
        turn(1, 2, providerThreadId),
        turn(2, 2, otherProviderThreadId),
        turn(1, 3, providerThreadId),
      ],
    } as unknown as ReturnType<typeof makeThreadProjectionFixture>;
  }

  it("offers the thread start and runs whose latest turn is on the active provider thread", () => {
    const available = deriveAvailableRevertTurnCounts(
      projection({ providerSessionId: ProviderSessionId.make("session") }),
    );
    expect([...available].toSorted()).toEqual([0, 1, 3]);
  });

  it("offers nothing without a provider session to rewind", () => {
    expect(deriveAvailableRevertTurnCounts(projection({ providerSessionId: null })).size).toBe(0);
    expect(deriveAvailableRevertTurnCounts(null).size).toBe(0);
  });
});
