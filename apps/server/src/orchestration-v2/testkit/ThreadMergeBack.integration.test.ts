import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Orchestrator from "../Orchestrator.ts";
import { makeNativeOrchestratorHarness, nativeCursor } from "./NativeOrchestratorTestHarness.ts";

it.live(
  "delivers sibling merge-back deltas to the original native session without crossing siblings",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeOrchestratorHarness("native-merge-back-siblings");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sourceId = ThreadId.make("merge-back-source");
          const firstId = ThreadId.make("merge-back-first");
          const secondId = ThreadId.make("merge-back-second");
          const fork = (targetThreadId: ThreadId) =>
            orchestrator.dispatch({
              type: "thread.fork",
              commandId: CommandId.make(`fork:${targetThreadId}`),
              sourceThreadId: sourceId,
              targetThreadId,
              sourcePoint: { type: "latest_stable" },
              title: String(targetThreadId),
              createdBy: "user",
              creationSource: "web",
            });
          yield* h.create(sourceId);
          const source = yield* h.send(sourceId, "ROOT-SEED", "root recorded");
          const original = nativeCursor(source.projection);
          yield* fork(firstId);
          const first = yield* h.send(firstId, "FIRST-ONLY", "first sibling result");
          yield* fork(secondId);
          const second = yield* h.send(secondId, "SECOND-ONLY", "second sibling result");
          const firstCursor = nativeCursor(first.projection);
          const secondCursor = nativeCursor(second.projection);
          assert.equal(
            new Set([original.sessionFile, firstCursor.sessionFile, secondCursor.sessionFile]).size,
            3,
          );
          assert.equal(
            new Set([original.sessionId, firstCursor.sessionId, secondCursor.sessionId]).size,
            3,
          );
          assert.include(first.prompt, "ROOT-SEED");
          assert.include(second.prompt, "ROOT-SEED");
          assert.notInclude(first.prompt, "SECOND-ONLY");
          assert.notInclude(second.prompt, "FIRST-ONLY");

          const mergedRunIds = [];
          for (const [childId, child, consume, response, own, other] of [
            [
              firstId,
              first,
              "Integrate first sibling",
              "first integrated",
              "FIRST-ONLY",
              "SECOND-ONLY",
            ],
            [
              secondId,
              second,
              "Integrate second sibling",
              "second integrated",
              "SECOND-ONLY",
              "FIRST-ONLY",
            ],
          ] as const) {
            const run = child.projection.runs.find((run) => run.userMessageId === child.messageId);
            if (!run) throw new Error("Missing sibling run");
            mergedRunIds.push(run.id);
            yield* orchestrator.dispatch({
              type: "thread.merge_back",
              commandId: CommandId.make(`merge:${childId}`),
              sourceThreadId: childId,
              targetThreadId: sourceId,
              sourcePoint: { type: "run", runId: run.id },
              createdBy: "user",
              creationSource: "web",
            });
            const result = yield* h.send(sourceId, consume, response);
            assert.include(result.prompt, own);
            assert.notInclude(result.prompt, other);
            assert.equal(nativeCursor(result.projection).sessionFile, original.sessionFile);
            assert.equal(nativeCursor(result.projection).sessionId, original.sessionId);
          }
          const final = yield* orchestrator.getThreadProjection(sourceId);
          const transfers = final.contextTransfers.filter(
            (transfer) => transfer.type === "merge_back",
          );
          assert.deepEqual(
            transfers.map((transfer) => transfer.status),
            ["consumed", "consumed"],
          );
          assert.deepEqual(
            transfers.map((transfer) => transfer.sourcePoint.runId),
            mergedRunIds,
          );
          assert.deepEqual(
            final.messages
              .filter((message) => message.role === "user")
              .map((message) => message.text),
            ["ROOT-SEED", "Integrate first sibling", "Integrate second sibling"],
          );
          assert.notInclude(
            first.projection.messages.map((message) => message.text).join("\n"),
            "SECOND-ONLY",
          );
          assert.notInclude(
            second.projection.messages.map((message) => message.text).join("\n"),
            "FIRST-ONLY",
          );
        }).pipe(Effect.provide(h.services()));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
