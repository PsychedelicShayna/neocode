import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EventId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import { makeNativeOrchestratorHarness } from "./NativeOrchestratorTestHarness.ts";

it.live.each([false, true])(
  "reports cancelled native background work once without restarting a settled thread when continuation is %s",
  (continueThreadsAfterServerUpdate) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeOrchestratorHarness(
          `native-restart-note-${continueThreadsAfterServerUpdate}`,
        );
        const threadId = ThreadId.make("restart-note-parent");
        const snapshotPath = `${h.native.home}/background-snapshot.sqlite`;
        const taskTitle = "Background analysis before restart";
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          yield* h.create(threadId);
          const parent = yield* h.start(threadId, "Start background analysis");
          const childStarted = yield* h.watch(
            threadId,
            (event) =>
              event.type === "subagent.updated" &&
              event.payload.nativeTaskRef?.nativeId === "background-child",
          );
          yield* h.native.emit(
            {
              type: "subagent_lifecycle",
              payload: { id: "background-child", status: "started", task: taskTitle },
            },
            parent.cursor.sessionFile,
          );
          yield* Fiber.join(childStarted);
          const settled = (yield* parent.complete("The background task is still running"))
            .projection;
          assert.equal(settled.runs[0]?.status, "completed");
          assert.equal(settled.subagents[0]?.status, "running");
          const session = settled.providerSessions.find((session) => session.status === "ready");
          if (!session) throw new Error("Missing native provider session");
          const now = yield* DateTime.now;
          // Older shutdowns could leave a stopped session beside a running background task.
          yield* sink.write({
            events: [
              {
                id: EventId.make("legacy-stopped-session"),
                type: "provider-session.updated",
                threadId,
                providerInstanceId: session.providerInstanceId,
                occurredAt: now,
                payload: { ...session, status: "stopped", updatedAt: now, lastError: null },
              },
            ],
          });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`VACUUM INTO ${snapshotPath}`;
          assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs.length, 1);
        }).pipe(Effect.provide(h.services({ databasePath: `${h.native.home}/source.sqlite` })));

        const launches = h.native.launches.length;
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const recovered = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            recovered.runs.map((run) => run.status),
            ["completed"],
          );
          assert.equal(recovered.subagents[0]?.status, "cancelled");
          assert.equal(recovered.runs[0]?.restartCancelledBackgroundWork?.[0]?.kind, "subagent");
          assert.equal(h.native.launches.length, launches);
          const first = yield* h.send(
            threadId,
            "Is the background task done?",
            "Please restart it",
          );
          assert.include(first.prompt, taskTitle);
          assert.include(first.prompt, "Is the background task done?");
          const second = yield* h.send(threadId, "Anything else?", "No further work");
          assert.notInclude(second.prompt, taskTitle);
          assert.deepEqual(
            second.projection.runs.map((run) => run.status),
            ["completed", "completed", "completed"],
          );
          assert.isFalse(
            second.projection.runs.some((run) => run.restartContinuationOfRunId !== undefined),
          );
          assert.deepEqual(
            second.projection.messages
              .filter((message) => message.role === "user")
              .map((message) => message.text),
            ["Start background analysis", "Is the background task done?", "Anything else?"],
          );
        }).pipe(
          Effect.provide(
            h.services({
              databasePath: snapshotPath,
              recoverOnStartup: true,
              continueThreadsAfterServerUpdate,
            }),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
