import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  type ModelSelection,
  type ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  makeNativeAdapterHarness,
  modelSelection,
} from "../../provider/neopi/NeoPiAdapterTestHarness.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "./ProviderReplayHarness.ts";

export const nativeCursor = (projection: OrchestrationV2ThreadProjection) => {
  const cursor = projection.providerThreads.find(
    (thread) => thread.id === projection.thread.activeProviderThreadId,
  )?.nativeMetadata?.neopiResumeCursor;
  if (!cursor) throw new Error("Missing persisted native session identity");
  return cursor;
};

export const makeNativeOrchestratorHarness = Effect.fn("makeNativeOrchestratorHarness")(function* (
  name: string,
) {
  const native = yield* makeNativeAdapterHarness();
  const cwd = yield* checkpointWorkspace(name);
  const registry = ProviderAdapterRegistry.layerSingle(native.adapter);
  const services = (
    options: {
      databasePath?: string;
      recoverOnStartup?: boolean;
      continueThreadsAfterServerUpdate?: boolean;
    } = {},
  ) => {
    const databaseLayer =
      options.databasePath === undefined
        ? SqlitePersistence.layerMemory
        : SqlitePersistence.layerFromPath(options.databasePath).pipe(
            Layer.provide(NodeServices.layer),
          );
    return Layer.merge(
      layerWithRegistry({ name, runtimePolicyOverride: { cwd } }, registry, {
        databaseLayer,
        runEffectWorker: options.recoverOnStartup === true,
        ...(options.recoverOnStartup === undefined
          ? {}
          : { recoverOnStartup: options.recoverOnStartup }),
        ...(options.continueThreadsAfterServerUpdate === undefined
          ? {}
          : {
              continueThreadsAfterServerUpdate: options.continueThreadsAfterServerUpdate,
            }),
      }),
      databaseLayer,
    );
  };
  const watch = Effect.fn("nativeOrchestrator.watch")(function* (
    threadId: ThreadId,
    predicate: (event: OrchestrationV2DomainEvent) => boolean,
  ) {
    const sink = yield* EventSink.EventSinkV2;
    const afterSequence = yield* sink.latestSequence({ threadId });
    return yield* sink.stream({ threadId, afterSequence }).pipe(
      Stream.filter((stored) => predicate(stored.event)),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
  });
  const create = Effect.fn("nativeOrchestrator.create")(function* (threadId: ThreadId) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make(name),
      title: String(threadId),
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
  });
  const start = Effect.fn("nativeOrchestrator.start")(function* (
    threadId: ThreadId,
    text: string,
    selection?: ModelSelection,
  ) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const messageId = MessageId.make(`message:${threadId}:${text}`);
    const completed = yield* watch(
      threadId,
      (event) =>
        event.type === "run.updated" &&
        event.payload.status === "completed" &&
        event.payload.userMessageId === messageId,
    );
    const checkpointReady = yield* watch(
      threadId,
      (event) =>
        event.type === "run.updated" &&
        event.payload.status === "waiting" &&
        event.payload.userMessageId === messageId,
    );
    const accepted = yield* watch(
      threadId,
      (event) => event.type === "provider-turn.updated" && event.payload.inputAccepted === true,
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      ...(selection === undefined ? {} : { modelSelection: selection }),
      threadId,
      messageId,
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* Fiber.join(accepted);
    const running = yield* orchestrator.getThreadProjection(threadId);
    const cursor = nativeCursor(running);
    const entry = native.native(cursor.sessionFile).entries.at(-1);
    assert.equal(entry?.message.role, "user");
    const content = entry?.message.content;
    if (!Array.isArray(content)) throw new Error("Missing native prompt content");
    const prompt = content
      .flatMap((part: unknown) =>
        typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
          ? [part.text]
          : [],
      )
      .join("\n");
    const complete = Effect.fn("nativeOrchestrator.complete")(function* (response: string) {
      yield* native.complete(response, cursor.sessionFile);
      yield* Fiber.join(checkpointReady);
      yield* worker.drain();
      yield* Fiber.join(completed);
      return { prompt, projection: yield* orchestrator.getThreadProjection(threadId), messageId };
    });
    return { prompt, projection: running, cursor, messageId, complete };
  });
  const send = Effect.fn("nativeOrchestrator.send")(function* (
    threadId: ThreadId,
    text: string,
    response: string,
    selection?: ModelSelection,
  ) {
    return yield* (yield* start(threadId, text, selection)).complete(response);
  });
  return { native, cwd, services, create, start, send, watch };
});
