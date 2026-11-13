import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../ProviderInstanceRegistry.ts";
import { makeNativeAdapterHarness, instanceId, threadId } from "./NeoPiAdapterTestHarness.ts";
import { registerNeoPiSessionCatalogSource } from "./NeoPiSessionCatalogSource.ts";
import { makeNeoPiThreadBindingReader, makeNeoPiThreadStateWriter } from "./NeoPiThreadBinding.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(database),
);
const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  EventSink.layer.pipe(Layer.provideMerge(stores)),
);

it.live("keeps the native owner independent of selected models and rejects replaced bindings", () =>
  Effect.gen(function* () {
    const h = yield* makeNativeAdapterHarness();
    const { session, providerThread } = yield* h.open();
    const input = h.turn(providerThread, "establish durable identity");
    yield* session.startTurn(input);
    yield* h.finish();
    const update = h.observed.findLast((event) => event.type === "provider_thread.updated");
    if (update?.type !== "provider_thread.updated")
      throw new Error("Missing durable native identity");
    const boundThread = update.providerThread;
    const now = DateTime.makeUnsafe("2026-11-11T00:00:00.000Z");
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const thread = {
      ...input.appThread,
      // Changing a future run's model must not redirect an existing native reader.
      providerInstanceId: ProviderInstanceId.make("different-selection"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("different-selection"),
        model: "other",
      },
    };
    yield* projections.apply({
      id: EventId.make("binding-thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread,
    });
    yield* projections.apply({
      id: EventId.make("binding-session"),
      type: "provider-session.attached",
      threadId,
      driver: boundThread.driver,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: session.providerSession,
    });
    let revision = 0;
    const save = (value: typeof boundThread) =>
      projections.apply({
        id: EventId.make(`binding-native-${revision++}`),
        type: "provider-thread.updated",
        threadId,
        driver: boundThread.driver,
        providerInstanceId: instanceId,
        occurredAt: now,
        payload: value,
      });
    yield* save(boundThread);
    const unused = Effect.die("Binding reads must not invoke execution or text generation");
    const instance: ProviderInstance = registerNeoPiSessionCatalogSource(
      {
        instanceId,
        driverKind: ProviderDriverKind.make("neopi"),
        enabled: true,
        displayName: undefined,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make("neopi"),
          continuationKey: "binding",
        },
        orchestrationAdapter: h.adapter,
        snapshot: {
          getSnapshot: unused,
          refresh: unused,
          streamChanges: Stream.empty,
          applyUsageLimits: () => unused,
        },
        textGeneration: {
          generateCommitMessage: () => unused,
          generatePrContent: () => unused,
          generateBranchName: () => unused,
          generateThreadTitle: () => unused,
          generateReviewGuide: () => unused,
          generateTranscriptionPostProcessing: () => unused,
        },
      },
      {
        binary: "unused",
        env: {},
        profile: "fixture",
        capabilities: new Set(),
        probe: { status: "compatible", version: "fixture" },
      },
    );
    let currentInstance = instance;
    const dependencies = Layer.mergeAll(
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: (id) => Effect.succeed(id === instanceId ? currentInstance : undefined),
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.succeedSome({
            projectId: thread.projectId,
            title: "Fixture",
            workspaceRoot: h.home,
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            pinnedAt: null,
            archivedAt: null,
            createdAt: DateTime.formatIso(now),
            updatedAt: DateTime.formatIso(now),
            deletedAt: null,
          }),
      }),
    );
    const read = yield* makeNeoPiThreadBindingReader().pipe(Effect.provide(dependencies));
    const binding = yield* read(threadId);
    assert.isDefined(binding);
    if (!binding) throw new Error("Missing V2 native binding");
    assert.equal(binding.instance.instanceId, instanceId);
    assert.equal(binding.expected.sessionFile, h.native().file);
    assert.equal(binding.expected.sessionId, h.native().id);
    assert.deepEqual(binding.cursor, boundThread.nativeMetadata?.neopiResumeCursor);
    assert.equal(binding.connected, true);
    assert.equal(yield* binding.unchanged, true);
    const launches = h.launches.length;
    const commands = h.commands.length;
    const cursor = binding.cursor;

    yield* save({
      ...boundThread,
      nativeMetadata: {
        ...boundThread.nativeMetadata,
        neopiResumeCursor: { ...cursor, historyLeafId: "new-leaf" },
      },
    });
    assert.equal(yield* binding.unchanged, true);
    for (const replacement of [
      { ...boundThread, providerSessionId: ProviderSessionId.make("replacement") },
      {
        ...boundThread,
        nativeThreadRef: { ...boundThread.nativeThreadRef!, nativeId: "replacement" },
      },
      {
        ...boundThread,
        nativeMetadata: {
          ...boundThread.nativeMetadata,
          neopiResumeCursor: { ...cursor, sessionId: "replacement" },
        },
      },
    ]) {
      yield* save(replacement);
      assert.equal(yield* binding.unchanged, false);
    }
    yield* save(boundThread);
    assert.equal(yield* binding.unchanged, true);
    currentInstance = { ...instance };
    assert.equal(yield* binding.unchanged, false);
    currentInstance = instance;
    yield* projections.apply({
      id: EventId.make("binding-stopped"),
      type: "provider-session.updated",
      threadId,
      driver: boundThread.driver,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: { ...session.providerSession, status: "stopped" },
    });
    assert.equal(yield* binding.unchanged, false);
    const stopped = yield* read(threadId);
    assert.equal(stopped?.connected, false);
    yield* projections.apply({
      id: EventId.make("binding-detached"),
      type: "provider-session.detached",
      threadId,
      driver: boundThread.driver,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: { providerSessionId: session.providerSession.id, detachedAt: now },
    });
    const detached = yield* read(threadId);
    assert.isDefined(detached);
    assert.equal(detached?.attached, false);
    assert.equal(detached?.connected, false);
    assert.equal(detached?.session?.id, session.providerSession.id);
    assert.equal(detached?.session?.status, "stopped");
    assert.deepEqual(detached?.cursor, cursor);
    assert.equal(yield* stopped!.unchanged, false);
    assert.deepEqual((yield* projections.getThreadProviderContext(threadId)).providerSessions, []);
    yield* projections.apply({
      id: EventId.make("binding-reattached"),
      type: "provider-session.attached",
      threadId,
      driver: boundThread.driver,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: session.providerSession,
    });
    assert.equal(yield* detached!.unchanged, false);
    assert.equal((yield* read(threadId))?.connected, true);
    const guarded = yield* read(threadId);
    if (!guarded?.session) throw new Error("Missing reattached native session");
    const writeState = yield* makeNeoPiThreadStateWriter();
    const next = {
      ...guarded.providerThread,
      nativeConversationHeadRef: {
        driver: guarded.providerThread.driver,
        nativeId: "written-leaf",
        strength: "strong" as const,
      },
      nativeMetadata: {
        ...guarded.providerThread.nativeMetadata,
        neopiResumeCursor: { ...guarded.cursor, historyLeafId: "written-leaf" },
      },
    };
    const write = (expectedAttached: boolean) =>
      writeState({
        expected: guarded.providerThread,
        expectedSession: guarded.session!,
        expectedAttached,
        next,
      });
    yield* projections.apply({
      id: EventId.make("binding-model-race"),
      type: "provider-session.updated",
      threadId,
      driver: boundThread.driver,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: { ...guarded.session, model: "changed-without-new-timestamp" },
    });
    assert.equal(yield* write(true), false);
    yield* projections.apply({
      id: EventId.make("binding-session-reset"),
      type: "provider-session.updated",
      threadId,
      driver: boundThread.driver,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: guarded.session,
    });
    yield* projections.apply({
      id: EventId.make("binding-detach-race"),
      type: "provider-session.detached",
      threadId,
      driver: boundThread.driver,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: { providerSessionId: guarded.session.id, detachedAt: now },
    });
    assert.equal(yield* write(true), false);
    assert.deepEqual((yield* read(threadId))?.cursor, guarded.cursor);
    assert.equal(yield* write(false), true);
    assert.equal((yield* read(threadId))?.cursor.historyLeafId, "written-leaf");
    assert.equal(yield* write(false), false);
    assert.equal(h.launches.length, launches);
    assert.equal(h.commands.length, commands);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
