import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { modelSelection } from "../../provider/neopi/NeoPiAdapterTestHarness.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import { makeNativeOrchestratorHarness, nativeCursor } from "./NativeOrchestratorTestHarness.ts";

it.live(
  "recovers an accepted native turn after process loss without losing history or adopting its child output",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeOrchestratorHarness("native-orphan-recovery");
        const threadId = ThreadId.make("native-orphan-parent");
        const snapshotPath = `${h.native.home}/crash-snapshot.sqlite`;
        const before = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* h.create(threadId);
          yield* h.send(threadId, "Completed before restart", "retained answer");
          const active = yield* h.start(threadId, "Accepted before process loss");
          const childStarted = yield* h.watch(
            threadId,
            (event) =>
              event.type === "subagent.updated" &&
              event.payload.nativeTaskRef?.nativeId === "orphan-child",
          );
          yield* h.native.emit(
            {
              type: "subagent_lifecycle",
              payload: { id: "orphan-child", status: "started", task: "background analysis" },
            },
            active.cursor.sessionFile,
          );
          yield* Fiber.join(childStarted);
          const childOutput = yield* h.watch(
            threadId,
            (event) =>
              event.type === "subagent.updated" && event.payload.progress === "orphan child output",
          );
          yield* h.native.emit(
            {
              type: "subagent_event",
              payload: {
                id: "orphan-child",
                event: {
                  type: "message_end",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "orphan child output" }],
                  },
                },
              },
            },
            active.cursor.sessionFile,
          );
          yield* Fiber.join(childOutput);
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.find((run) => run.userMessageId === active.messageId);
          if (!run) throw new Error("Missing accepted run");
          assert.equal(run.status, "running");
          assert.isTrue(projection.providerTurns.some((turn) => turn.inputAccepted));
          const sql = yield* SqlClient.SqlClient;
          yield* sql`VACUUM INTO ${snapshotPath}`;
          return { cursor: nativeCursor(projection), runId: run.id };
        }).pipe(Effect.provide(h.services({ databasePath: `${h.native.home}/source.sqlite` })));

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const recovered = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(recovered.runs.find((run) => run.id === before.runId)?.status, "cancelled");
          assert.equal(nativeCursor(recovered).sessionFile, before.cursor.sessionFile);
          assert.equal(nativeCursor(recovered).sessionId, before.cursor.sessionId);
          assert.deepEqual(
            recovered.messages
              .filter((message) => message.role === "user")
              .map((message) => message.text),
            ["Completed before restart", "Accepted before process loss"],
          );
          const resumed = yield* h.send(threadId, "Continue after restart", "resumed answer");
          assert.equal(nativeCursor(resumed.projection).sessionFile, before.cursor.sessionFile);
          assert.equal(nativeCursor(resumed.projection).sessionId, before.cursor.sessionId);
          assert.deepEqual(
            resumed.projection.messages
              .filter((message) => message.role === "assistant")
              .map((message) => message.text),
            ["retained answer", "resumed answer"],
          );
          assert.equal(
            resumed.projection.runs.filter((run) => run.status === "completed").length,
            2,
          );
          assert.isTrue(
            resumed.projection.subagents.some(
              (task) =>
                task.nativeTaskRef?.nativeId === "orphan-child" && task.status === "cancelled",
            ),
          );
        }).pipe(
          Effect.provide(
            h.services({
              databasePath: snapshotPath,
              recoverOnStartup: true,
              continueThreadsAfterServerUpdate: false,
            }),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each([true, false])(
  "resumes the same native delegated child after restart when its previous run completed: %s",
  (childCompleted) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeOrchestratorHarness(`native-child-recovery-${childCompleted}`);
        const parentId = ThreadId.make("native-recovery-parent");
        const snapshotPath = `${h.native.home}/child-snapshot.sqlite`;
        const before = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* h.create(parentId);
          const parent = yield* h.start(parentId, "Delegate the analysis");
          const parentRun = parent.projection.runs.find(
            (run) => run.userMessageId === parent.messageId,
          );
          const attempt = parent.projection.attempts.find(
            (attempt) => attempt.id === parentRun?.activeAttemptId,
          );
          if (!parentRun || !attempt) throw new Error("Missing parent attempt");
          yield* orchestrator.dispatch({
            type: "delegated_task.request",
            commandId: CommandId.make("delegate-native-child"),
            parentThreadId: parentId,
            parentRunId: parentRun.id,
            parentNodeId: attempt.rootNodeId,
            task: "Analyze the child workspace",
            title: "Analysis child",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            completionWake: "settled_only",
            createdBy: "agent",
            creationSource: "mcp",
          });
          yield* worker.drain();
          const parentProjection = yield* orchestrator.getThreadProjection(parentId);
          const task = parentProjection.subagents.find((task) => task.origin === "app_owned");
          const childId = task?.childThreadId;
          if (!childId) throw new Error("Missing delegated child thread");
          yield* orchestrator.streamStoredEventsFrom({ threadId: childId, afterSequence: 0 }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-turn.updated" &&
                stored.event.payload.inputAccepted === true,
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          const child = yield* orchestrator.getThreadProjection(childId);
          const cursor = nativeCursor(child);
          if (childCompleted) {
            const completed = yield* h.watch(
              childId,
              (event) => event.type === "run.updated" && event.payload.status === "completed",
            );
            const checkpointReady = yield* h.watch(
              childId,
              (event) => event.type === "run.updated" && event.payload.status === "waiting",
            );
            yield* h.native.complete("first child answer", cursor.sessionFile);
            yield* Fiber.join(checkpointReady);
            yield* worker.drain();
            yield* Fiber.join(completed);
          }
          if (childCompleted) {
            yield* parent.complete("parent answer");
          } else {
            const waiting = yield* h.watch(
              parentId,
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === parentRun.id &&
                event.payload.status === "waiting",
            );
            const persisted = yield* h.watch(
              parentId,
              (event) =>
                event.type === "provider-thread.updated" &&
                event.payload.nativeMetadata?.neopiLastTurn?.providerTurn.status === "completed",
            );
            yield* h.native.complete("parent answer", parent.cursor.sessionFile);
            yield* Fiber.join(waiting);
            yield* Fiber.join(persisted);
            yield* worker.drain();
          }
          const sql = yield* SqlClient.SqlClient;
          yield* sql`VACUUM INTO ${snapshotPath}`;
          return { childId, cursor, runId: child.runs[0]!.id };
        }).pipe(Effect.provide(h.services({ databasePath: `${h.native.home}/source.sqlite` })));

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const recovered = yield* orchestrator.getThreadProjection(before.childId);
          assert.equal(
            recovered.runs.find((run) => run.id === before.runId)?.status,
            childCompleted ? "completed" : "cancelled",
          );
          assert.equal(recovered.thread.lineage.parentThreadId, parentId);
          assert.equal(recovered.thread.lineage.relationshipToParent, "subagent");
          assert.deepEqual(recovered.thread.modelSelection, modelSelection);
          const resumed = yield* h.send(
            before.childId,
            "Resume the child analysis",
            "resumed child answer",
          );
          assert.equal(nativeCursor(resumed.projection).sessionFile, before.cursor.sessionFile);
          assert.equal(nativeCursor(resumed.projection).sessionId, before.cursor.sessionId);
          assert.equal(resumed.projection.thread.id, before.childId);
          assert.deepEqual(
            resumed.projection.messages
              .filter((message) => message.role === "assistant")
              .map((message) => message.text),
            childCompleted
              ? ["first child answer", "resumed child answer"]
              : ["resumed child answer"],
          );
          const parent = yield* orchestrator.getThreadProjection(parentId);
          assert.deepEqual(
            parent.messages
              .filter((message) => message.role === "assistant")
              .map((message) => message.text),
            ["parent answer"],
          );
        }).pipe(
          Effect.provide(
            h.services({
              databasePath: snapshotPath,
              recoverOnStartup: true,
              continueThreadsAfterServerUpdate: false,
            }),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
