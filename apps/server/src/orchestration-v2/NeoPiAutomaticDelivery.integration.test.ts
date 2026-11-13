import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { modelSelection } from "../provider/neopi/NeoPiAdapterTestHarness.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { makeNativeOrchestratorHarness } from "./testkit/NativeOrchestratorTestHarness.ts";

const decodeScheduledTask = Schema.decodeEffect(ScheduledTaskUpsertInput);
const statusIds = ["status-1", "status-2", "status-3", "status-4"];
const deliveries = [
  "child completion",
  "scheduled message",
  "user steering",
  "promoted queued message",
] as const;

it.live.each(deliveries)(
  "delivers %s through the native runtime without aborting its tools",
  (delivery) =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `native-automatic-${delivery.replaceAll(" ", "-")}`;
        const h = yield* makeNativeOrchestratorHarness(name);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make("thread:automatic-delivery");
          const projectId = ProjectId.make(name);
          yield* h.create(threadId);
          const active = yield* h.start(threadId, "Build and check all four tasks.");
          const parent = active.projection.runs[0]!;
          if (parent.rootNodeId === null) throw new Error("Parent has no root node");
          const toolsReady = yield* h.watch(
            threadId,
            (event) =>
              event.type === "turn-item.updated" &&
              event.payload.nativeItemRef?.nativeId === "status-4",
          );
          for (const id of ["build", ...statusIds]) {
            yield* h.native.emit(
              {
                type: "tool_execution_start",
                toolCallId: id,
                toolName: id === "build" ? "bash" : "task_status",
                args: id === "build" ? { command: "make" } : { taskId: id },
              },
              active.cursor.sessionFile,
            );
          }
          yield* Fiber.join(toolsReady);
          const before = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(before.turnItems.filter((item) => item.status === "running").length, 5);
          const messageId = MessageId.make("automatic-notice");
          if (delivery === "child completion") {
            const taskId = NodeId.make("completed-child");
            const now = yield* DateTime.now;
            const sink = yield* EventSink.EventSinkV2;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("cohort"),
                  type: "run.updated",
                  threadId,
                  runId: parent.id,
                  occurredAt: now,
                  payload: {
                    ...parent,
                    delegatedCompletion: {
                      disposition: "open",
                      nextGeneration: 2,
                      delivery: { generation: 1, messageId, taskIds: [taskId] },
                    },
                  },
                },
                {
                  id: EventId.make("child"),
                  type: "subagent.updated",
                  threadId,
                  runId: parent.id,
                  nodeId: taskId,
                  occurredAt: now,
                  payload: {
                    id: taskId,
                    threadId,
                    runId: parent.id,
                    parentNodeId: parent.rootNodeId,
                    origin: "app_owned",
                    createdBy: "agent",
                    driver: ProviderDriverKind.make("neopi"),
                    providerInstanceId: modelSelection.instanceId,
                    providerThreadId: null,
                    childThreadId: null,
                    nativeTaskRef: null,
                    prompt: "Background work",
                    title: "Child",
                    model: null,
                    completionWake: "always",
                    completionDelivery: { state: "claimed", observedByRunId: null },
                    status: "completed",
                    result: "done",
                    startedAt: now,
                    completedAt: now,
                    updatedAt: now,
                  },
                },
              ],
            });
            const command = {
              type: "message.dispatch" as const,
              commandId: CommandId.make("completion"),
              threadId,
              messageId,
              text: "Child completed",
              attachments: [],
              dispatchMode: { type: "queue_after_active" as const },
              createdBy: "agent" as const,
              creationSource: "server" as const,
              delegatedCompletion: { parentRunId: parent.id, generation: 1, taskIds: [taskId] },
            };
            yield* orchestrator.dispatch(command);
            yield* orchestrator.dispatch(command);
            yield* orchestrator.recoverDelegatedTasks;
          } else if (delivery === "scheduled message") {
            yield* Effect.gen(function* () {
              const service = yield* ScheduledTaskService.ScheduledTaskService;
              const { task } = yield* service.upsert(
                yield* decodeScheduledTask({
                  title: "Status check",
                  prompt: "Check the four tasks.",
                  enabled: true,
                  schedule: { type: "interval", everyMs: 60_000 },
                  projectId,
                  threadId,
                  workspaceStrategy: { type: "root" },
                  modelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                }),
              );
              const ran = yield* service.runNow({ id: task.id });
              assert.equal(ran.task.lastRunStatus, "succeeded", ran.task.lastRunError ?? undefined);
            }).pipe(
              Effect.provide(
                ScheduledTaskService.layer.pipe(
                  Layer.provide(ThreadManagementService.layer),
                  Layer.provide(
                    ServerSettings.layerTest({
                      providerInstances: {
                        [modelSelection.instanceId]: {
                          driver: ProviderDriverKind.make("neopi"),
                          enabled: true,
                          config: {},
                        },
                      },
                    }),
                  ),
                  Layer.provide(
                    Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
                      ensureTranscript: () =>
                        Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
                    }),
                  ),
                  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
                  Layer.provide(ManagedPolicy.layerTest()),
                  Layer.provide(
                    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                      namedProjectsRoot: "/projects",
                      isScratchProject: () => Effect.succeed(false),
                    }),
                  ),
                  Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
                  Layer.provide(
                    CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
                  ),
                  Layer.provide(
                    Layer.mergeAll(
                      NodeCrypto.layer,
                      Scheduler.layer,
                      SqlitePersistence.layerMemory,
                    ),
                  ),
                ),
              ),
            );
          } else if (delivery === "user steering") {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("steer"),
              threadId,
              messageId,
              text: "Change direction now.",
              attachments: [],
              dispatchMode: { type: "steer_active", targetRunId: parent.id },
              createdBy: "user",
              creationSource: "web",
            });
          } else {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("queue"),
              threadId,
              messageId,
              text: "Change direction now.",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            });
            const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
            yield* orchestrator.dispatch({
              type: "queued-message.promote-to-steer",
              commandId: CommandId.make("promote"),
              threadId,
              queuedRunId: queuedRun.id,
              targetRunId: parent.id,
            });
            const promoted = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(promoted.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
            assert.equal(
              promoted.messages.find((message) => message.id === messageId)?.runId,
              parent.id,
            );
            const steer = promoted.turnItems.find(
              (item) => item.type === "user_message" && item.messageId === messageId,
            );
            assert.ok(steer?.type === "user_message");
            assert.equal(steer.inputIntent, "promoted_queued_to_steer");
          }
          yield* worker.drain();
          const explicitSteer =
            delivery === "user steering" || delivery === "promoted queued message";
          assert.equal(
            h.native.commands.filter((command) => command.type === "steer").length,
            explicitSteer ? 1 : 0,
          );
          assert.equal(h.native.prompts.length, 1);
          assert.isFalse(h.native.commands.some((command) => command.type === "abort"));
          const delivered = explicitSteer
            ? undefined
            : yield* h.watch(
                threadId,
                (event) =>
                  event.type === "provider-turn.updated" && event.payload.inputAccepted === true,
              );
          for (const id of ["build", ...statusIds]) {
            yield* h.native.emit(
              {
                type: "tool_execution_end",
                toolCallId: id,
                toolName: id === "build" ? "bash" : "task_status",
                result: {
                  content: [
                    { type: "text", text: id === "build" ? "build OK" : "Task completed normally" },
                  ],
                },
              },
              active.cursor.sessionFile,
            );
          }
          yield* active.complete("Initial work completed");
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          if (delivered) {
            yield* Fiber.join(delivered);
            const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.id !== parent.id,
            );
            if (!queued) throw new Error("Missing delivered run");
            const checkpointReady = yield* h.watch(
              threadId,
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === queued.id &&
                event.payload.status === "waiting",
            );
            const finished = yield* h.watch(
              threadId,
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === queued.id &&
                event.payload.status === "completed",
            );
            yield* h.native.complete("Notice acknowledged", active.cursor.sessionFile);
            yield* Fiber.join(checkpointReady);
            yield* worker.drain();
            yield* Fiber.join(finished);
          }
          const after = yield* orchestrator.getThreadProjection(threadId);
          const reads = after.turnItems.filter((item) =>
            statusIds.includes(item.nativeItemRef?.nativeId ?? ""),
          );
          assert.equal(reads.length, 4);
          for (const read of reads) {
            assert.equal(read.status, "completed");
            assert.equal(read.toolNonExecutionKind, undefined);
          }
          assert.equal(after.runs.find((run) => run.id === parent.id)?.status, "completed");
          if (!explicitSteer) {
            assert.equal(after.runs.length, 2);
            if (delivery === "child completion") {
              assert.equal(after.messages.filter((message) => message.id === messageId).length, 1);
              assert.equal(after.subagents[0]?.completionDelivery?.state, "delivered");
            } else {
              assert.equal(
                after.messages.filter((message) => message.scheduledTaskId !== undefined).length,
                1,
              );
            }
          }
          yield* orchestrator.recoverDelegatedTasks;
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          assert.equal(h.native.prompts.length, explicitSteer ? 1 : 2);
          assert.equal(
            h.native.commands.filter((command) => command.type === "steer").length,
            explicitSteer ? 1 : 0,
          );
          assert.isFalse(h.native.commands.some((command) => command.type === "abort"));
        }).pipe(Effect.provide(h.services()));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
