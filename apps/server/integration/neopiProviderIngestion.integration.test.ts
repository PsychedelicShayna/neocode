import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../src/persistence/Sqlite.ts";
import * as EffectWorker from "../src/orchestration-v2/EffectWorker.ts";
import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as Orchestrator from "../src/orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../src/orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../src/orchestration-v2/ProviderSessionManager.ts";
import { layerWithRegistry } from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  makeNativeAdapterHarness,
  modelSelection,
} from "../src/provider/neopi/NeoPiAdapterTestHarness.ts";

const firstThread = ThreadId.make("neopi-ingestion-first");
const otherThread = ThreadId.make("neopi-ingestion-other");
const createThread = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  cwd: string,
) =>
  orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId: ProjectId.make("native-ingestion"),
    title: String(threadId),
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: cwd,
    createdBy: "user",
    creationSource: "web",
  });
const dispatch = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  text: string,
) =>
  orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`send:${threadId}:${text}`),
    threadId,
    messageId: MessageId.make(`message:${threadId}:${text}`),
    text,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
const savedNative = (projection: OrchestrationV2ThreadProjection) => {
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === projection.thread.activeProviderThreadId,
  );
  const cursor = providerThread?.nativeMetadata?.neopiResumeCursor;
  if (!providerThread || !cursor) throw new Error("Missing persisted native identity");
  return { providerThread, cursor };
};
const watch = Effect.fn("nativeIngestion.watch")(function* (
  sink: EventSink.EventSinkV2["Service"],
  threadId: ThreadId,
  predicate: (event: OrchestrationV2DomainEvent) => boolean,
) {
  const afterSequence = yield* sink.latestSequence({ threadId });
  return yield* sink.stream({ threadId, afterSequence }).pipe(
    Stream.filter((event) => predicate(event.event)),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkScoped,
  );
});

it.live(
  "persists actual native turns, tools, identities and cursor across V2 sessions and SQLite restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeAdapterHarness();
        const cwd = yield* checkpointWorkspace("native-ingestion");
        const fs = yield* FileSystem.FileSystem;
        const databaseLayer = SqlitePersistence.layerFromPath(`${h.home}/ingestion.sqlite`).pipe(
          Layer.provide(NodeServices.layer),
        );
        const registry = ProviderAdapterRegistry.layerSingle(h.adapter);
        const services = () =>
          layerWithRegistry({ name: "native-ingestion" }, registry, {
            databaseLayer,
            runEffectWorker: false,
          });
        const expectedMessages = ["first", "second", "after restart", "cwd mode restart"];
        const original = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const sink = yield* EventSink.EventSinkV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          yield* createThread(orchestrator, firstThread, cwd);
          yield* createThread(orchestrator, otherThread, cwd);
          const send = Effect.fn("nativeIngestion.send")(function* (
            threadId: ThreadId,
            text: string,
            tool = false,
          ) {
            const completed = yield* watch(
              sink,
              threadId,
              (event) =>
                event.type === "run.updated" &&
                event.payload.status === "completed" &&
                event.payload.userMessageId === MessageId.make(`message:${threadId}:${text}`),
            );
            const checkpointReady = yield* watch(
              sink,
              threadId,
              (event) =>
                event.type === "run.updated" &&
                event.payload.status === "waiting" &&
                event.payload.userMessageId === MessageId.make(`message:${threadId}:${text}`),
            );
            const accepted = yield* watch(
              sink,
              threadId,
              (event) =>
                event.type === "provider-turn.updated" && event.payload.inputAccepted === true,
            );
            yield* dispatch(orchestrator, threadId, text);
            yield* worker.drain();
            yield* Fiber.join(accepted);
            const pending = yield* orchestrator.getThreadProjection(threadId);
            const { cursor } = savedNative(pending);
            const run = pending.runs.find(
              (run) => run.userMessageId === MessageId.make(`message:${threadId}:${text}`),
            );
            assert.isDefined(run);
            const attempt = pending.attempts.find((attempt) => attempt.id === run?.activeAttemptId);
            assert.isTrue(
              pending.providerTurns.some(
                (turn) => turn.runAttemptId === attempt?.id && turn.inputAccepted === true,
              ),
            );
            if (tool) {
              yield* h.emit(
                {
                  type: "tool_execution_start",
                  toolCallId: "tool-1",
                  toolName: "bash",
                  args: { command: "pwd" },
                },
                cursor.sessionFile,
              );
              yield* h.emit(
                {
                  type: "tool_execution_end",
                  toolCallId: "tool-1",
                  toolName: "bash",
                  result: { content: [{ type: "text", text: "workspace" }] },
                },
                cursor.sessionFile,
              );
            }
            yield* h.complete(`answer: ${text}`, cursor.sessionFile);
            yield* Fiber.join(checkpointReady);
            yield* worker.drain();
            yield* Fiber.join(completed);
            return yield* orchestrator.getThreadProjection(threadId);
          });
          const first = yield* send(firstThread, "first", true);
          const firstIdentity = savedNative(first).cursor;
          const other = yield* send(otherThread, "parallel");
          const otherIdentity = savedNative(other).cursor;
          assert.notEqual(firstIdentity.sessionFile, otherIdentity.sessionFile);
          assert.notEqual(firstIdentity.sessionId, otherIdentity.sessionId);
          const second = yield* send(firstThread, "second");
          assert.equal(savedNative(second).cursor.turnBoundaries.length, 2);
          const liveSession = second.providerSessions.find((session) => session.status === "ready");
          assert.isDefined(liveSession);
          yield* manager.close(liveSession!.id);
          const restarted = yield* send(firstThread, "after restart");
          assert.equal(savedNative(restarted).cursor.sessionFile, firstIdentity.sessionFile);
          assert.equal(savedNative(restarted).cursor.sessionId, firstIdentity.sessionId);
          assert.equal(savedNative(restarted).cursor.turnBoundaries.length, 3);
          const newCwd = `${cwd}/moved`;
          yield* fs.makeDirectory(newCwd);
          yield* orchestrator.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("move-cwd"),
            threadId: firstThread,
            worktreePath: newCwd,
          });
          yield* orchestrator.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("change-mode"),
            threadId: firstThread,
            runtimeMode: "auto",
          });
          const moved = yield* send(firstThread, "cwd mode restart");
          assert.equal(savedNative(moved).cursor.sessionFile, firstIdentity.sessionFile);
          assert.equal(savedNative(moved).cursor.turnBoundaries.length, 4);
          assert.equal(h.runtimeInputs.at(-1)?.cwd, newCwd);
          assert.equal(h.runtimeInputs.at(-1)?.runtimeMode, "auto");
          assert.deepEqual(
            moved.messages
              .filter((message) => message.role === "assistant")
              .map((message) => message.text),
            expectedMessages.map((text) => `answer: ${text}`),
          );
          const tool = moved.turnItems.find((item) => item.type === "command_execution");
          assert.equal(tool?.status, "completed");
          if (tool?.type !== "command_execution")
            throw new Error("Missing native command execution");
          assert.equal(tool.input, "pwd");
          const ids = [...moved.messages, ...other.messages]
            .filter((message) => message.role === "assistant")
            .map((message) => message.id);
          assert.equal(new Set(ids).size, 5);
          return { firstIdentity, otherIdentity, newCwd };
        }).pipe(Effect.provide(services()));

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const sink = yield* EventSink.EventSinkV2;
          const restored = yield* orchestrator.getThreadProjection(firstThread);
          const other = yield* orchestrator.getThreadProjection(otherThread);
          assert.equal(
            savedNative(restored).cursor.sessionFile,
            original.firstIdentity.sessionFile,
          );
          assert.equal(savedNative(other).cursor.sessionFile, original.otherIdentity.sessionFile);
          assert.equal(savedNative(restored).cursor.turnBoundaries.length, 4);
          assert.equal(restored.thread.worktreePath, original.newCwd);
          assert.equal(restored.thread.runtimeMode, "auto");
          assert.equal(restored.providerTurns.filter((turn) => turn.inputAccepted).length, 4);
          const completed = yield* watch(
            sink,
            firstThread,
            (event) => event.type === "run.updated" && event.payload.status === "completed",
          );
          const checkpointReady = yield* watch(
            sink,
            firstThread,
            (event) => event.type === "run.updated" && event.payload.status === "waiting",
          );
          yield* dispatch(orchestrator, firstThread, "after database restart");
          yield* worker.drain();
          const running = yield* orchestrator.getThreadProjection(firstThread);
          assert.equal(savedNative(running).cursor.sessionId, original.firstIdentity.sessionId);
          yield* h.complete("answer: after database restart", original.firstIdentity.sessionFile);
          yield* Fiber.join(checkpointReady);
          yield* worker.drain();
          yield* Fiber.join(completed);
          const final = yield* orchestrator.getThreadProjection(firstThread);
          assert.equal(savedNative(final).cursor.turnBoundaries.length, 5);
          assert.deepEqual(
            final.messages
              .filter((message) => message.role === "assistant")
              .map((message) => message.text),
            [...expectedMessages, "after database restart"].map((text) => `answer: ${text}`),
          );
        }).pipe(Effect.provide(services()));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "records only correlated native acceptance before a fast terminal and retains rejected input across SQLite restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeAdapterHarness();
        const cwd = yield* checkpointWorkspace("native-acceptance");
        const databaseLayer = SqlitePersistence.layerFromPath(`${h.home}/acceptance.sqlite`).pipe(
          Layer.provide(NodeServices.layer),
        );
        const services = () =>
          layerWithRegistry(
            { name: "native-acceptance" },
            ProviderAdapterRegistry.layerSingle(h.adapter),
            { databaseLayer, runEffectWorker: false },
          );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const sink = yield* EventSink.EventSinkV2;
          yield* createThread(orchestrator, firstThread, cwd);
          const seen = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          h.gatePrompt(
            Deferred.await(release),
            Deferred.succeed(seen, undefined).pipe(Effect.asVoid),
          );
          const completed = yield* watch(
            sink,
            firstThread,
            (event) => event.type === "run.updated" && event.payload.status === "completed",
          );
          const checkpointReady = yield* watch(
            sink,
            firstThread,
            (event) => event.type === "run.updated" && event.payload.status === "waiting",
          );
          const running = yield* watch(
            sink,
            firstThread,
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
          yield* dispatch(orchestrator, firstThread, "delayed acknowledgment");
          const starting = yield* worker.drain().pipe(Effect.forkScoped);
          yield* Deferred.await(seen);
          yield* Fiber.join(running);
          const pending = yield* orchestrator.getThreadProjection(firstThread);
          assert.equal(pending.runs[0]?.status, "running");
          assert.isFalse(pending.providerTurns.some((turn) => turn.inputAccepted === true));
          yield* h.complete("finished before acknowledgment");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(starting);
          yield* Fiber.join(checkpointReady);
          yield* worker.drain();
          yield* Fiber.join(completed);
          const accepted = yield* orchestrator.getThreadProjection(firstThread);
          assert.equal(accepted.runs[0]?.status, "completed");
          assert.isTrue(accepted.providerTurns.some((turn) => turn.inputAccepted === true));
          h.failNextPrompt("native rejected input");
          const failed = yield* watch(
            sink,
            firstThread,
            (event) =>
              event.type === "run.updated" &&
              event.payload.status === "failed" &&
              event.payload.userMessageId ===
                MessageId.make(`message:${firstThread}:rejected input`),
          );
          yield* dispatch(orchestrator, firstThread, "rejected input");
          yield* worker.drain();
          yield* Fiber.join(failed);
        }).pipe(Effect.provide(services()));
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const restored = yield* orchestrator.getThreadProjection(firstThread);
          const accepted = restored.runs.find(
            (run) =>
              run.userMessageId === MessageId.make(`message:${firstThread}:delayed acknowledgment`),
          );
          const rejected = restored.runs.find(
            (run) => run.userMessageId === MessageId.make(`message:${firstThread}:rejected input`),
          );
          assert.equal(accepted?.status, "completed");
          assert.equal(rejected?.status, "failed");
          const acceptance = (runId: typeof accepted) =>
            restored.providerTurns.some(
              (turn) =>
                turn.inputAccepted === true &&
                restored.attempts.some(
                  (attempt) =>
                    attempt.id === turn.runAttemptId &&
                    attempt.rootNodeId === turn.nodeId &&
                    attempt.runId === runId?.id,
                ),
            );
          assert.isTrue(acceptance(accepted));
          assert.isFalse(acceptance(rejected));
          assert.deepEqual(
            restored.messages
              .filter((message) => message.role === "user")
              .map((message) => message.text),
            ["delayed acknowledgment", "rejected input"],
          );
        }).pipe(Effect.provide(services()));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
