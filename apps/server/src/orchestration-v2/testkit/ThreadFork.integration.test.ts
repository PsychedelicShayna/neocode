import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import { makeNativeOrchestratorHarness, nativeCursor } from "./NativeOrchestratorTestHarness.ts";

const visibleText = (projection: OrchestrationV2ThreadProjection) =>
  projection.visibleTurnItems
    .flatMap(({ item }) =>
      item.type === "user_message" || item.type === "assistant_message" ? [item.text] : [],
    )
    .join("\n");

it.live.each(["latest", "first"] as const)(
  "starts an idle native fork with history bounded at the %s source turn",
  (boundary) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeOrchestratorHarness(`native-fork-${boundary}`);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sourceId = ThreadId.make("fork-source");
          const targetId = ThreadId.make("fork-target");
          yield* h.create(sourceId);
          const alpha = yield* h.send(sourceId, "SOURCE-ALPHA", "alpha stored");
          const beta = yield* h.send(sourceId, "SOURCE-BETA", "beta stored");
          const firstRun = alpha.projection.runs.find(
            (run) => run.userMessageId === alpha.messageId,
          );
          if (!firstRun) throw new Error("Missing source run");
          const original = nativeCursor(beta.projection);
          const launches = h.native.launches.length;
          yield* orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("create-fork"),
            sourceThreadId: sourceId,
            targetThreadId: targetId,
            sourcePoint:
              boundary === "latest"
                ? { type: "latest_stable" }
                : { type: "run", runId: firstRun.id },
            title: "Fork",
            createdBy: "user",
            creationSource: "web",
          });
          const idle = yield* orchestrator.getThreadProjection(targetId);
          assert.deepEqual(idle.runs, []);
          assert.deepEqual(idle.providerThreads, []);
          assert.equal(h.native.launches.length, launches);
          assert.include(visibleText(idle), "SOURCE-ALPHA");
          assert.equal(visibleText(idle).includes("SOURCE-BETA"), boundary === "latest");
          assert.equal(idle.thread.lineage.relationshipToParent, "fork");
          const inherited = idle.visibleTurnItems.filter((row) => row.visibility === "inherited");
          const inheritedMessages = inherited.flatMap(({ item }) =>
            item.type === "user_message" || item.type === "assistant_message" ? [item] : [],
          );
          assert.deepEqual(
            inheritedMessages.map((item) => item.text),
            boundary === "latest"
              ? ["SOURCE-ALPHA", "alpha stored", "SOURCE-BETA", "beta stored"]
              : ["SOURCE-ALPHA", "alpha stored"],
          );
          assert.equal(inheritedMessages[0]?.type, "user_message");
          if (inheritedMessages[0]?.type === "user_message")
            assert.equal(inheritedMessages[0].inputIntent, "turn_start");
          assert.isTrue(
            idle.visibleTurnItems.some(
              (row) => row.visibility === "synthetic" && row.item.type === "fork",
            ),
          );

          const started = yield* h.send(targetId, "CONTINUE-FORK", "fork completed");
          const forked = nativeCursor(started.projection);
          assert.notEqual(forked.sessionFile, original.sessionFile);
          assert.notEqual(forked.sessionId, original.sessionId);
          assert.include(started.prompt, "SOURCE-ALPHA");
          assert.equal(started.prompt.includes("SOURCE-BETA"), boundary === "latest");
          const [transfer] = started.projection.contextTransfers;
          assert.equal(transfer?.status, "consumed");
          assert.equal(started.projection.runs[0]?.status, "completed");
          assert.equal(transfer?.resolution?.strategy, "portable_context");
          const sourceAfter = yield* orchestrator.getThreadProjection(sourceId);
          assert.deepEqual(nativeCursor(sourceAfter), original);
          assert.deepEqual(sourceAfter.messages, beta.projection.messages);
          const shell = yield* orchestrator.getThreadShell(targetId);
          assert.equal(shell?.visibleItemCount, started.projection.visibleTurnItems.length);
        }).pipe(Effect.provide(h.services()));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["source", "fork"] as const)(
  "keeps the other native session unchanged when rolling back the %s",
  (rollbackTarget) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeOrchestratorHarness(`native-fork-rollback-${rollbackTarget}`);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const sourceId = ThreadId.make("rollback-source");
          const targetId = ThreadId.make("rollback-fork");
          yield* h.create(sourceId);
          const alpha = yield* h.send(sourceId, "SOURCE-ALPHA", "alpha stored");
          const beta = yield* h.send(sourceId, "SOURCE-BETA", "beta stored");
          const firstSourceRun = alpha.projection.runs.find(
            (run) => run.userMessageId === alpha.messageId,
          );
          if (!firstSourceRun) throw new Error("Missing source run");
          yield* orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("create-rollback-fork"),
            sourceThreadId: sourceId,
            targetThreadId: targetId,
            sourcePoint: { type: "run", runId: firstSourceRun.id },
            title: "Fork",
            createdBy: "user",
            creationSource: "web",
          });
          const first = yield* h.send(targetId, "FORK-FIRST", "first fork reply");
          const second = yield* h.send(targetId, "FORK-SECOND", "second fork reply");
          const affectedId = rollbackTarget === "source" ? sourceId : targetId;
          const unaffectedId = rollbackTarget === "source" ? targetId : sourceId;
          const affected = rollbackTarget === "source" ? beta : second;
          const retained = rollbackTarget === "source" ? alpha : first;
          const unaffected = rollbackTarget === "source" ? second.projection : beta.projection;
          const unaffectedCursor = nativeCursor(unaffected);
          const unaffectedEntries = [...h.native.native(unaffectedCursor.sessionFile).entries];
          const retainedRun = retained.projection.runs.find(
            (run) => run.userMessageId === retained.messageId,
          );
          const removedRun = affected.projection.runs.find(
            (run) => run.userMessageId === affected.messageId,
          );
          const checkpoint = affected.projection.checkpoints.find(
            (checkpoint) => checkpoint.runId === retainedRun?.id && checkpoint.status === "ready",
          );
          if (!retainedRun || !removedRun || !checkpoint)
            throw new Error("Missing ready native rollback checkpoint");
          const rolledBack = yield* h.watch(
            affectedId,
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === removedRun.id &&
              event.payload.status === "rolled_back",
          );
          const nativeMoved = yield* h.watch(
            affectedId,
            (event) =>
              event.type === "provider-thread.updated" &&
              event.payload.nativeMetadata?.neopiResumeCursor?.turnBoundaries.length === 1 &&
              event.payload.nativeMetadata.neopiResumeCursor.sessionFile !==
                nativeCursor(affected.projection).sessionFile,
          );
          yield* orchestrator.dispatch({
            type: "checkpoint.rollback",
            commandId: CommandId.make("rollback-one-turn"),
            threadId: affectedId,
            scopeId: checkpoint.scopeId,
            checkpointId: checkpoint.id,
            restoreFiles: false,
          });
          yield* worker.drain();
          yield* Fiber.join(rolledBack);
          yield* Fiber.join(nativeMoved);
          const after = yield* orchestrator.getThreadProjection(affectedId);
          assert.equal(nativeCursor(after).turnBoundaries.length, 1);
          assert.notEqual(
            nativeCursor(after).sessionFile,
            nativeCursor(affected.projection).sessionFile,
          );
          assert.include(
            visibleText(after),
            rollbackTarget === "source" ? "SOURCE-ALPHA" : "FORK-FIRST",
          );
          assert.notInclude(
            visibleText(after),
            rollbackTarget === "source" ? "SOURCE-BETA" : "FORK-SECOND",
          );
          const other = yield* orchestrator.getThreadProjection(unaffectedId);
          assert.deepEqual(nativeCursor(other), unaffectedCursor);
          assert.deepEqual(other.messages, unaffected.messages);
          assert.deepEqual(
            h.native.native(unaffectedCursor.sessionFile).entries,
            unaffectedEntries,
          );
          const forkAfter = yield* orchestrator.getThreadProjection(targetId);
          assert.include(visibleText(forkAfter), "SOURCE-ALPHA");
          assert.notInclude(visibleText(forkAfter), "SOURCE-BETA");
          const resumed = yield* h.send(affectedId, "CONTINUE-AFTER-ROLLBACK", "resumed reply");
          assert.equal(
            nativeCursor(resumed.projection).sessionFile,
            nativeCursor(after).sessionFile,
          );
          const nativeHistory = h.native.native(
            nativeCursor(resumed.projection).sessionFile,
          ).entries;
          assert.notInclude(
            JSON.stringify(nativeHistory),
            rollbackTarget === "source" ? "SOURCE-BETA" : "FORK-SECOND",
          );
        }).pipe(Effect.provide(h.services()));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
