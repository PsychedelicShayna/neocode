import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { modelSelection } from "../provider/neopi/NeoPiAdapterTestHarness.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { makeNativeOrchestratorHarness } from "./testkit/NativeOrchestratorTestHarness.ts";

it.live.each(["message", "thread settings"] as const)(
  "applies the next native model selected through %s before sending its prompt",
  (via) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeOrchestratorHarness(`native-model-${via.replaceAll(" ", "-")}`);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threadId = ThreadId.make("native-model-switch");
          yield* h.create(threadId);
          yield* h.send(threadId, "FIRST", "first answer");
          const next = { ...modelSelection, model: "fixture/next" };
          if (via === "thread settings") {
            yield* orchestrator.dispatch({
              type: "thread.model-selection.set",
              commandId: CommandId.make("change-model"),
              threadId,
              modelSelection: next,
            });
          }
          const result = yield* h.send(
            threadId,
            "SECOND",
            "second answer",
            via === "message" ? next : undefined,
          );
          assert.deepEqual(
            result.projection.runs.map((run) => [run.status, run.modelSelection.model]),
            [
              ["completed", modelSelection.model],
              ["completed", next.model],
            ],
          );
          assert.deepEqual(h.native.promptModels, [modelSelection.model, next.model]);
          assert.deepEqual(
            result.projection.messages
              .filter((message) => message.role === "assistant")
              .map((message) => message.text),
            ["first answer", "second answer"],
          );
        }).pipe(Effect.provide(h.services()));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("applies changed native approval modes to each subsequent turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeNativeOrchestratorHarness("native-runtime-modes");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("native-runtime-modes");
        yield* h.create(threadId);
        yield* h.send(threadId, "FIRST", "first answer");
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("auto-edit"),
          threadId,
          runtimeMode: "auto-accept-edits",
        });
        yield* h.send(threadId, "SECOND", "second answer");
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("full-access"),
          threadId,
          runtimeMode: "full-access",
        });
        const result = yield* h.send(threadId, "THIRD", "third answer");
        assert.deepEqual(
          result.projection.runs.map((run) => run.status),
          ["completed", "completed", "completed"],
        );
        assert.equal(result.projection.thread.runtimeMode, "full-access");
        assert.deepEqual(
          h.native.launches
            .filter((args) => !args.includes("--no-session"))
            .map((args) => args[args.indexOf("--approval-mode") + 1]),
          ["yolo", "write", "yolo"],
        );
      }).pipe(Effect.provide(h.services()));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("returns from native plan mode to ordinary execution across completed turns", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeNativeOrchestratorHarness("native-plan-transition");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("native-plan-transition");
        yield* h.create(threadId);
        yield* orchestrator.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("plan-mode"),
          threadId,
          interactionMode: "plan",
        });
        const plan = yield* h.start(threadId, "PLAN");
        assert.equal(h.native.native(plan.cursor.sessionFile).mode, "plan");
        yield* plan.complete("planned answer");
        yield* orchestrator.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("default-mode"),
          threadId,
          interactionMode: "default",
        });
        const execute = yield* h.start(threadId, "EXECUTE");
        assert.equal(h.native.native(execute.cursor.sessionFile).mode, "default");
        const result = yield* execute.complete("executed answer");
        assert.deepEqual(
          result.projection.runs.map((run) => run.status),
          ["completed", "completed"],
        );
        assert.equal(result.projection.thread.interactionMode, "default");
      }).pipe(Effect.provide(h.services()));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("never sends a cancelled queued prompt and still executes the following prompt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeNativeOrchestratorHarness("native-cancel-queued");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("native-cancel-queued");
        yield* h.create(threadId);
        const first = yield* h.start(threadId, "FIRST");
        for (const text of ["CANCELLED_INPUT", "KEEP_INPUT"]) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(text),
            threadId,
            messageId: MessageId.make(text),
            text,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
        }
        const queued = yield* orchestrator.getThreadProjection(threadId);
        const cancelled = queued.runs.find(
          (run) => run.userMessageId === MessageId.make("CANCELLED_INPUT"),
        );
        const retained = queued.runs.find(
          (run) => run.userMessageId === MessageId.make("KEEP_INPUT"),
        );
        if (!cancelled || !retained) throw new Error("Missing queued runs");
        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("cancel-queued"),
          threadId,
          runId: cancelled.id,
        });
        yield* worker.drain();
        assert.equal(h.native.prompts.length, 1);
        const accepted = yield* h.watch(
          threadId,
          (event) => event.type === "provider-turn.updated" && event.payload.inputAccepted === true,
        );
        yield* first.complete("first answer");
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        yield* Fiber.join(accepted);
        const finished = yield* h.watch(
          threadId,
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === retained.id &&
            event.payload.status === "completed",
        );
        const checkpointReady = yield* h.watch(
          threadId,
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === retained.id &&
            event.payload.status === "waiting",
        );
        yield* h.native.complete("retained answer", first.cursor.sessionFile);
        yield* Fiber.join(checkpointReady);
        yield* worker.drain();
        yield* Fiber.join(finished);
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        const result = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          result.runs.map((run) => run.status),
          ["completed", "cancelled", "completed"],
        );
        assert.equal(h.native.prompts.length, 2);
        assert.isFalse(h.native.prompts.some((prompt) => prompt.includes("CANCELLED_INPUT")));
        assert.include(h.native.prompts[1]!, "KEEP_INPUT");
      }).pipe(Effect.provide(h.services()));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["completed", "failed", "aborted"] as const)(
  "settles a native child's %s report during the parent turn without a duplicate continuation",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeOrchestratorHarness(`native-child-${outcome}`);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make(`native-child-${outcome}`);
          yield* h.create(threadId);
          const parent = yield* h.start(threadId, "Delegate a child while working");
          const opened = yield* h.watch(
            threadId,
            (event) =>
              event.type === "subagent.updated" &&
              event.payload.nativeTaskRef?.nativeId === "native-child",
          );
          yield* h.native.emit(
            {
              type: "subagent_lifecycle",
              payload: {
                id: "native-child",
                status: "started",
                task: "Child work",
              },
            },
            parent.cursor.sessionFile,
          );
          yield* Fiber.join(opened);
          const toolStarted = yield* h.watch(
            threadId,
            (event) =>
              event.type === "turn-item.updated" && event.payload.type === "command_execution",
          );
          yield* h.native.emit(
            {
              type: "subagent_event",
              payload: {
                id: "native-child",
                event: {
                  type: "tool_execution_start",
                  toolCallId: "child-shell",
                  toolName: "bash",
                  args: { command: "work" },
                },
              },
            },
            parent.cursor.sessionFile,
          );
          yield* Fiber.join(toolStarted);
          if (outcome === "completed") {
            yield* h.native.emit(
              {
                type: "subagent_event",
                payload: {
                  id: "native-child",
                  event: {
                    type: "tool_execution_end",
                    toolCallId: "child-shell",
                    toolName: "bash",
                    result: { content: [{ type: "text", text: "work completed" }] },
                  },
                },
              },
              parent.cursor.sessionFile,
            );
          }
          yield* h.native.emit(
            {
              type: "subagent_event",
              payload: {
                id: "native-child",
                event: {
                  type: "message_end",
                  message: { role: "assistant", content: [{ type: "text", text: "CHILD_RESULT" }] },
                },
              },
            },
            parent.cursor.sessionFile,
          );
          const expected = outcome === "aborted" ? "cancelled" : outcome;
          const settled = yield* h.watch(
            threadId,
            (event) => event.type === "subagent.updated" && event.payload.status === expected,
          );
          yield* h.native.emit(
            {
              type: "subagent_lifecycle",
              payload: {
                id: "native-child",
                status: outcome,
              },
            },
            parent.cursor.sessionFile,
          );
          yield* Fiber.join(settled);
          const result = yield* parent.complete("PARENT_RESULT");
          const child = result.projection.subagents.find(
            (task) => task.nativeTaskRef?.nativeId === "native-child",
          );
          assert.equal(child?.status, expected);
          assert.equal(child?.result, "CHILD_RESULT");
          assert.deepEqual(
            result.projection.runs.map((run) => run.status),
            ["completed"],
          );
          assert.deepEqual(
            result.projection.messages
              .filter((message) => message.role === "assistant")
              .map((message) => message.text),
            ["PARENT_RESULT"],
          );
          assert.isFalse(result.projection.turnItems.some((item) => item.status === "running"));
          assert.deepEqual(
            (yield* orchestrator.getThreadShell(threadId))?.pendingBackgroundTasks ?? [],
            [],
          );
          yield* orchestrator.recoverDelegatedTasks;
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          assert.equal(h.native.prompts.length, 1);
          const next = yield* h.send(threadId, "NEXT", "next answer");
          assert.deepEqual(
            next.projection.runs.map((run) => run.status),
            ["completed", "completed"],
          );
        }).pipe(Effect.provide(h.services()));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(
  (["approval", "user-input"] as const).flatMap((kind) =>
    [false, true].map((fail) => ({ kind, fail })),
  ),
)(
  "answers the first native $kind dialog and recovers after startup failure=$fail",
  ({ kind, fail }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeOrchestratorHarness(`native-startup-${kind}-${fail}`);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make(`native-startup-${kind}-${fail}`);
          yield* h.create(threadId);
          const opened = yield* h.watch(
            threadId,
            (event) =>
              event.type === "runtime-request.updated" && event.payload.status === "pending",
          );
          const settled = yield* h.watch(
            threadId,
            (event) =>
              event.type === "run.updated" &&
              event.payload.status === (fail ? "failed" : "completed"),
          );
          h.native.askOnStartup({ kind, fail });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("startup-turn"),
            threadId,
            messageId: MessageId.make("startup-message"),
            text: "Start after the dialog",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const draining = yield* worker.drain().pipe(Effect.forkChild);
          yield* Fiber.join(opened);
          const pending = yield* orchestrator.getThreadProjection(threadId);
          const request = pending.runtimeRequests.find((request) => request.status === "pending");
          assert.ok(request);
          assert.equal(request.kind, kind === "approval" ? "command" : "user_input");
          assert.ok(pending.attempts.some((attempt) => attempt.rootNodeId === request.nodeId));
          assert.deepEqual(h.native.prompts, []);
          yield* orchestrator.dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make("startup-answer"),
            threadId,
            requestId: request.id,
            ...(kind === "approval"
              ? { decision: "accept" as const }
              : {
                  answers: { "startup-permission": "true" },
                }),
          });
          yield* worker.drain();
          yield* Fiber.join(draining);
          if (!fail) {
            const active = yield* orchestrator.getThreadProjection(threadId);
            const cursor = active.providerThreads.find(
              (thread) => thread.id === active.thread.activeProviderThreadId,
            )?.nativeMetadata?.neopiResumeCursor;
            assert.ok(cursor);
            const checkpointReady = yield* h.watch(
              threadId,
              (event) => event.type === "run.updated" && event.payload.status === "waiting",
            );
            yield* h.native.complete("Started successfully", cursor.sessionFile);
            yield* Fiber.join(checkpointReady);
            yield* worker.drain();
          }
          yield* Fiber.join(settled);
          yield* worker.drain();
          const result = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            result.runs.map((run) => run.status),
            [fail ? "failed" : "completed"],
          );
          assert.isFalse(result.runtimeRequests.some((request) => request.status === "pending"));
          if (fail) assert.deepEqual(h.native.prompts, []);
          const next = yield* h.send(threadId, "Retry after the first start", "Recovered");
          assert.deepEqual(
            next.projection.runs.map((run) => run.status),
            [fail ? "failed" : "completed", "completed"],
          );
        }).pipe(Effect.provide(h.services()));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
