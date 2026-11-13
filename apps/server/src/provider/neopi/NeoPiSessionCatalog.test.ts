import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  type NeoPiSessionConfigurationResult,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import { layerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as RuntimePolicy from "../../orchestration-v2/RuntimePolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as ProviderInstanceRegistry from "../ProviderInstanceRegistry.ts";
import {
  makeNativeAdapterHarness,
  instanceId,
  modelSelection,
  threadId,
} from "./NeoPiAdapterTestHarness.ts";
import { makeNeoPiSessionCatalog, type NeoPiSessionCommandInput } from "./NeoPiSessionCatalog.ts";
import {
  registerNeoPiSessionCatalogSource,
  type NeoPiSessionCatalogSource,
} from "./NeoPiSessionCatalogSource.ts";
import { makeNeoPiThreadBindingReader } from "./NeoPiThreadBinding.ts";
import { makeNeoPiNativeConversation } from "./NeoPiNativeConversation.ts";
import { NeoPiRuntimeError } from "./NeoPiRuntimeError.ts";

const at = "2026-11-11T00:00:00.000Z";
const now = DateTime.makeUnsafe(at);
const snapshot = (sessionId: string): NeoPiSessionConfigurationResult => ({
  status: "available",
  providerInstanceId: instanceId,
  sessionId,
  attachment: "owned",
  model: { provider: "fixture", id: sessionId, name: null },
  thinkingLevel: null,
  activeRole: null,
  observedAt: at,
  roles: { status: "unsupported", reason: "Not advertised" },
});

const fixture = Effect.fn("NativeCatalogTest.fixture")(function* (
  options: {
    readonly connected?: boolean;
    readonly configuration?: NeoPiSessionCatalogSource["configuration"];
    readonly observeConfiguration?: NeoPiSessionCatalogSource["observeConfiguration"];
    readonly leasePid?: number;
    readonly databasePath?: string;
    readonly runtimeScope?: Scope.Scope;
  } = {},
) {
  const native = yield* makeNativeAdapterHarness(["prompt_entry_ids", "session_tree_navigation"]);
  const initialScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(initialScope, Exit.void));
  const initial = yield* native.open().pipe(Effect.provideService(Scope.Scope, initialScope));
  const turn = native.turn(initial.providerThread, "Retain native history");
  yield* initial.session.startTurn(turn);
  yield* native.finish("Retained native answer");
  const updated = native.observed.findLast((event) => event.type === "provider_thread.updated");
  if (updated?.type !== "provider_thread.updated") throw new Error("Missing native binding");
  const saved = updated.providerThread;
  const savedSession = { ...initial.session.providerSession, status: "stopped" as const };
  yield* Scope.close(initialScope, Exit.void);
  const cursor = saved.nativeMetadata!.neopiResumeCursor!;
  const registryChanges = yield* PubSub.sliding<void>(1);
  const capabilities = new Set(["session_catalog", "session_history_identity"]);
  const source: NeoPiSessionCatalogSource = {
    binary: "/opt/NeoPi nightly/npi",
    env: { OMP_PROFILE: "personal profile" },
    profile: "personal profile",
    capabilities,
    observeNative: native.adapter.observeNative,
    probe: { status: "compatible", version: "fixture" },
    ...(options.configuration ? { configuration: options.configuration } : {}),
    ...(options.observeConfiguration ? { observeConfiguration: options.observeConfiguration } : {}),
  };
  const unused = Effect.die("Catalog must not probe providers or generate text");
  let instance: ProviderInstance = registerNeoPiSessionCatalogSource(
    {
      instanceId,
      driverKind: ProviderDriverKind.make("neopi"),
      enabled: true,
      displayName: undefined,
      continuationIdentity: {
        driverKind: ProviderDriverKind.make("neopi"),
        continuationKey: "catalog",
      },
      orchestrationAdapter: native.adapter,
      snapshot: {
        getSnapshot: Effect.succeed(
          ServerProvider.make({
            instanceId,
            driver: ProviderDriverKind.make("neopi"),
            enabled: true,
            installed: true,
            version: "fixture",
            status: "ready",
            auth: { status: "unknown" },
            checkedAt: at,
            models: [],
            slashCommands: [],
            skills: [],
          }),
        ),
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
    source,
  );
  const database = options.databasePath
    ? SqlitePersistence.layerFromPath(options.databasePath).pipe(Layer.provide(NodeServices.layer))
    : SqlitePersistence.layerMemory;
  const stores = Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer, EffectOutbox.layer).pipe(
    Layer.provideMerge(database),
  );
  const runtime = layerWithRegistry(
    { name: "native-catalog-v2" },
    ProviderAdapterRegistry.layerSingle(native.adapter),
    { databaseLayer: database },
  );
  const registry = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: (id) => Effect.sync(() => (id === instanceId ? instance : undefined)),
    subscribeChanges: PubSub.subscribe(registryChanges),
  });
  const policy = RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(Layer.mergeAll(stores, registry, ServerSettingsService.layerTest())),
  );
  const layer = Layer.mergeAll(stores, runtime, registry, policy, IdAllocator.layer);
  const context = yield* options.runtimeScope
    ? Layer.build(layer).pipe(Effect.provideService(Scope.Scope, options.runtimeScope))
    : Layer.build(layer);
  return yield* Effect.gen(function* () {
    const events = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make("native-catalog-project"),
      aggregateKind: "project",
      aggregateId: turn.appThread.projectId,
      occurredAt: at,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: turn.appThread.projectId,
        title: "Native catalog",
        workspaceRoot: native.home,
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: at,
        updatedAt: at,
      },
    });
    yield* events.write({
      events: [
        {
          id: EventId.make("native-catalog-thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            ...turn.appThread,
            providerInstanceId: ProviderInstanceId.make("future-selection"),
            modelSelection: {
              instanceId: ProviderInstanceId.make("future-selection"),
              model: "future-model",
            },
          },
        },
        {
          id: EventId.make("native-catalog-session"),
          type: "provider-session.attached",
          threadId,
          driver: saved.driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: savedSession,
        },
        {
          id: EventId.make("native-catalog-binding"),
          type: "provider-thread.updated",
          threadId,
          driver: saved.driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: saved,
        },
      ],
    });
    const readBinding = yield* makeNeoPiThreadBindingReader();
    let revision = 0;
    const save = (providerThread: OrchestrationV2ProviderThread) =>
      events.write({
        events: [
          {
            id: EventId.make(`native-catalog-update-${++revision}`),
            type: "provider-thread.updated",
            threadId,
            driver: providerThread.driver,
            providerInstanceId: providerThread.providerInstanceId,
            occurredAt: now,
            payload: providerThread,
          },
        ],
      });
    const connect = Effect.gen(function* () {
      const afterSequence = yield* events.latestSequence({ threadId });
      const owner = yield* sessions.open({
        threadId,
        providerSessionId: savedSession.id,
        modelSelection,
        runtimePolicy: native.policy,
        resumeFromSession: savedSession,
        initialNativeThreadId: cursor.sessionId,
      });
      yield* owner.resumeThread({
        threadId,
        providerThread: saved,
        modelSelection,
        runtimePolicy: native.policy,
      });
      yield* events.stream({ threadId, afterSequence }).pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "provider-session.updated" &&
            event.payload.id === savedSession.id &&
            event.payload.status === "ready",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
    });
    if (options.connected !== false) yield* connect;
    const calls: NeoPiSessionCommandInput[] = [];
    let leasePid = options.leasePid;
    let readHook = Effect.void;
    const catalog = yield* makeNeoPiSessionCatalog((input) =>
      Effect.gen(function* () {
        calls.push(input);
        const state = native.native();
        if (input.args[1] === "read") {
          yield* readHook;
          return JSON.stringify({
            version: 1,
            session: { path: state.file, id: state.id, cwd: native.home, title: null },
            messages: [],
            branchMessages: [],
            truncated: false,
            branchMessagesTruncated: false,
            branchEntryIds: state.entries.map((entry) => entry.id),
            leafId: state.leafId ?? state.entries.at(-1)?.id ?? null,
          });
        }
        const stopped = !(yield* native.processIsRunning.at(-1)!.pipe(Effect.orDie));
        return JSON.stringify({
          version: 1,
          sessions: [
            {
              path: state.file,
              id: state.id,
              cwd: native.home,
              title: null,
              created: at,
              modified: at,
              messageCount: state.entries.length,
              firstMessage: "Retain native history",
              inUse: leasePid !== undefined ? { pid: leasePid } : stopped ? null : { pid: 123 },
              control: null,
            },
          ],
        });
      }),
    );
    const conversation = yield* makeNeoPiNativeConversation();
    return {
      catalog,
      conversation,
      native,
      cursor,
      saved,
      savedSession,
      calls,
      projections,
      events,
      readBinding,
      save,
      connect,
      source,
      capabilities,
      beforeRead: (hook: Effect.Effect<void>) => {
        readHook = hook;
      },
      replaceInstance: () => {
        instance = { ...instance };
      },
      notifyRegistry: PubSub.publish(registryChanges, undefined),
    };
  }).pipe(Effect.provide(context));
});

const run = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.live("hands off through the actual V2 manager and outbox without importing native turns", () =>
  run(
    Effect.gen(function* () {
      const h = yield* fixture();
      const before = yield* h.projections.getThreadProjection(threadId);
      const result = yield* h.catalog.handoff({ threadId });
      assert.equal(result.sessionId, h.cursor.sessionId);
      assert.equal(result.sessionFile, h.cursor.sessionFile);
      assert.equal(
        result.command,
        `cd '${h.native.home}' && OMP_PROFILE='personal profile' '/opt/NeoPi nightly/npi' --session '${h.cursor.sessionFile}'`,
      );
      assert.equal(yield* SubscriptionRef.get(h.native.runtimes.at(-1)!.state), "stopped");
      assert.equal(yield* h.native.processIsRunning.at(-1)!.pipe(Effect.orDie), false);
      const binding = yield* h.readBinding(threadId);
      assert.equal(binding?.attached, false);
      assert.deepEqual(binding?.cursor, h.cursor);
      const after = yield* h.projections.getThreadProjection(threadId);
      assert.deepEqual(after.runs, before.runs);
      assert.deepEqual(after.providerTurns, before.providerTurns);
      assert.deepEqual(after.messages, before.messages);
      assert.deepEqual(h.native.prompts, ["Retain native history"]);
      const history = [...h.native.native().entries];
      yield* h.connect;
      const reopened = yield* h.readBinding(threadId);
      assert.equal(reopened?.connected, true);
      assert.deepEqual(reopened?.cursor, h.cursor);
      assert.deepEqual(h.native.native().entries, history);
      assert.deepEqual(h.native.prompts, ["Retain native history"]);
    }),
  ),
);

it.live("refuses a terminal handoff when the native lease survives successful detach", () =>
  run(
    Effect.gen(function* () {
      const h = yield* fixture({ leasePid: 456 });
      const error = yield* h.catalog.handoff({ threadId }).pipe(Effect.flip);
      assert.equal(error.operation, "handoff");
      assert.include(error.message, "PID 456");
      assert.equal(
        h.calls.some((call) => call.args[1] === "read"),
        false,
      );
      assert.equal((yield* h.readBinding(threadId))?.attached, false);
    }),
  ),
);

it.live("refuses unverified terminal history on a stopped binding", () =>
  run(
    Effect.gen(function* () {
      const h = yield* fixture({ connected: false });
      const native = h.native.native();
      native.entries.push({
        id: "external-entry",
        parentId: h.cursor.historyLeafId ?? null,
        type: "message",
        message: { role: "user", content: "Terminal continuation" },
      });
      native.leafId = "external-entry";
      const error = yield* h.catalog.handoff({ threadId }).pipe(Effect.flip);
      assert.include(error.message, "unverified native history");
      assert.deepEqual((yield* h.readBinding(threadId))?.cursor, h.cursor);
    }),
  ),
);

it.live.each(["session_catalog", "session_history_identity"])(
  "rejects missing %s before stopping the native owner",
  (capability) =>
    run(
      Effect.gen(function* () {
        const h = yield* fixture();
        h.capabilities.delete(capability);
        const error = yield* h.catalog.handoff({ threadId }).pipe(Effect.flip);
        assert.include(error.message, capability);
        assert.equal((yield* h.readBinding(threadId))?.connected, true);
        assert.deepEqual(h.calls, []);
      }),
    ),
);

it.live("rejects a changed binding while reading the handoff watermark", () =>
  run(
    Effect.gen(function* () {
      const h = yield* fixture();
      h.beforeRead(
        h
          .save({
            ...h.saved,
            nativeMetadata: {
              ...h.saved.nativeMetadata,
              neopiResumeCursor: { ...h.cursor, sessionId: "replacement" },
            },
          })
          .pipe(Effect.orDie, Effect.asVoid),
      );
      const error = yield* h.catalog.handoff({ threadId }).pipe(Effect.flip);
      assert.equal(error.operation, "handoff");
      assert.include(error.message, "binding changed");
    }),
  ),
);

it.live("routes configuration to the bound native instance, not the next selected model", () =>
  run(
    Effect.gen(function* () {
      const inspected: string[] = [];
      const h = yield* fixture({
        configuration: (_, identity) =>
          Effect.sync(() => {
            inspected.push(identity.sessionId);
            return snapshot(identity.sessionId);
          }),
      });
      assert.deepEqual(yield* h.catalog.configuration({ threadId }), snapshot(h.cursor.sessionId));
      assert.deepEqual(inspected, [h.cursor.sessionId]);
      assert.deepEqual(h.calls, []);
    }),
  ),
);

it.live("does not read stopped configuration or start a disconnected runtime", () =>
  run(
    Effect.gen(function* () {
      const h = yield* fixture({
        connected: false,
        configuration: () => Effect.die("Unexpected native read"),
      });
      const count = h.native.launches.length;
      assert.equal((yield* h.catalog.configuration({ threadId })).status, "unavailable");
      assert.equal(h.native.launches.length, count);
      const missingReader = yield* fixture();
      assert.equal(
        (yield* missingReader.catalog.configuration({ threadId })).status,
        "unavailable",
      );
      const connected = yield* fixture({
        configuration: (_, identity) => Effect.succeed(snapshot(identity.sessionId)),
      });
      assert.equal((yield* connected.catalog.configuration({ threadId })).status, "available");
      for (const replacement of [
        { ...connected.saved, driver: ProviderDriverKind.make("foreign-history") },
        { ...connected.saved, providerInstanceId: ProviderInstanceId.make("missing") },
        { ...connected.saved, nativeThreadRef: null },
      ]) {
        yield* connected.save(replacement);
        assert.equal((yield* connected.catalog.configuration({ threadId })).status, "unavailable");
      }
    }),
  ),
);

it.live("discards configuration after an in-flight native identity replacement", () =>
  run(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = yield* fixture({
        configuration: (_, identity) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return snapshot(identity.sessionId);
          }),
      });
      const reading = yield* h.catalog.configuration({ threadId }).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* h.save({
        ...h.saved,
        nativeThreadRef: { ...h.saved.nativeThreadRef!, nativeId: "replacement" },
      });
      yield* Deferred.succeed(release, undefined);
      assert.equal((yield* Fiber.join(reading)).status, "unavailable");
    }),
  ),
);

it.live.each(["session", "instance"] as const)(
  "rejects a configuration snapshot with the wrong %s",
  (mismatch) =>
    run(
      Effect.gen(function* () {
        const h = yield* fixture({
          configuration: (_, identity) =>
            Effect.succeed({
              ...snapshot(mismatch === "session" ? "replacement" : identity.sessionId),
              providerInstanceId:
                mismatch === "instance" ? ProviderInstanceId.make("replacement") : instanceId,
            }),
        });
        assert.equal((yield* h.catalog.configuration({ threadId })).status, "unavailable");
      }),
    ),
);

it.live("subscribes before the initial snapshot and coalesces native invalidations", () =>
  run(
    Effect.gen(function* () {
      const changes = yield* PubSub.sliding<void>(1);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let model = "before";
      let reads = 0;
      let observers = 0;
      const h = yield* fixture({
        observeConfiguration: (_, identity) =>
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                observers++;
              }),
              () =>
                Effect.sync(() => {
                  observers--;
                }),
            );
            const subscription = yield* PubSub.subscribe(changes);
            return {
              changes: Stream.fromEffectRepeat(PubSub.take(subscription)),
              read: Effect.gen(function* () {
                const id = model;
                if (++reads === 1) {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }
                return {
                  ...snapshot(identity.sessionId),
                  model: { provider: "fixture", id, name: null },
                };
              }),
            };
          }),
      });
      const watching = yield* h.catalog
        .watchConfiguration({ threadId })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
      yield* Deferred.await(entered);
      model = "after";
      yield* PubSub.publish(changes, undefined);
      yield* Deferred.succeed(release, undefined);
      const results = yield* Fiber.join(watching);
      assert.deepEqual(
        results.map((result) => result.status === "available" && result.model?.id),
        ["before", "after"],
      );
      assert.equal(reads, 2);
      assert.equal(observers, 0);
    }),
  ),
);

it.live.each(["binding", "instance", "stop"] as const)(
  "ends an idle configuration observer on %s without following a new owner",
  (replacement) =>
    run(
      Effect.gen(function* () {
        const output = yield* Queue.unbounded<NeoPiSessionConfigurationResult>();
        let reads = 0;
        const h = yield* fixture({
          observeConfiguration: (_, identity) =>
            Effect.succeed({
              changes: Stream.never,
              read: Effect.sync(() => {
                reads++;
                return snapshot(identity.sessionId);
              }),
            }),
        });
        const watching = yield* h.catalog.watchConfiguration({ threadId }).pipe(
          Stream.runForEach((result) => Queue.offer(output, result)),
          Effect.forkScoped,
        );
        assert.equal((yield* Queue.take(output)).status, "available");
        if (replacement === "binding") {
          yield* h.save({
            ...h.saved,
            nativeThreadRef: { ...h.saved.nativeThreadRef!, nativeId: "replacement" },
          });
        } else if (replacement === "instance") {
          h.replaceInstance();
          yield* h.notifyRegistry;
        } else {
          yield* h.catalog.handoff({ threadId });
        }
        assert.equal((yield* Queue.take(output)).status, "unavailable");
        yield* Fiber.join(watching);
        assert.equal(reads, 1);
      }),
    ),
);

it.live("discards an observed snapshot when its binding changes during the native read", () =>
  run(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = yield* fixture({
        observeConfiguration: (_, identity) =>
          Effect.succeed({
            changes: Stream.never,
            read: Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return snapshot(identity.sessionId);
            }),
          }),
      });
      const watching = yield* h.catalog
        .watchConfiguration({ threadId })
        .pipe(Stream.runCollect, Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* h.save({
        ...h.saved,
        nativeThreadRef: { ...h.saved.nativeThreadRef!, nativeId: "replacement" },
      });
      yield* Deferred.succeed(release, undefined);
      assert.deepEqual(
        (yield* Fiber.join(watching)).map((value) => value.status),
        ["unavailable"],
      );
    }),
  ),
);

it.live.each([false, true])("releases a pending native snapshot when failure is %s", (fail) =>
  run(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const h = yield* fixture({
        observeConfiguration: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
            return {
              changes: Stream.never,
              read: Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(
                  fail
                    ? new NeoPiRuntimeError({
                        code: "rpc",
                        message: "native configuration failed",
                      })
                    : Effect.never,
                ),
                Effect.ensuring(Deferred.succeed(cancelled, undefined)),
              ),
            };
          }),
      });
      const watching = yield* h.catalog
        .watchConfiguration({ threadId })
        .pipe(Stream.runDrain, Effect.exit, Effect.forkScoped);
      yield* Deferred.await(entered);
      if (fail) {
        const result = yield* Fiber.join(watching);
        assert.equal(Exit.isFailure(result), true);
      } else yield* Fiber.interrupt(watching);
      yield* Deferred.await(cancelled);
      yield* Deferred.await(released);
      assert.deepEqual(h.calls, []);
    }),
  ),
);

it.live(
  "starts and navigates the retained native session without a new turn, then preserves its cursor across SQLite reopen",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "neopi-native-reopen-" });
        const databasePath = `${directory}/state.sqlite`;
        const runtimeScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
        const h = yield* fixture({ connected: false, databasePath, runtimeScope });
        const history = [...h.native.native().entries];
        const targetId = history[0]!.id;
        const input = {
          threadId,
          expectedSessionId: h.cursor.sessionId,
          expectedSessionFile: h.cursor.sessionFile,
          expectedLeafId: h.cursor.historyLeafId ?? null,
          targetId,
        };
        const before = yield* h.projections.getThreadProjection(threadId);
        const launches = h.native.launches.length;
        assert.equal((yield* h.conversation.navigate(input)).status, "unavailable");
        assert.equal(h.native.launches.length, launches);

        const result = yield* h.conversation.navigate({ ...input, startIfStopped: true });
        assert.equal(result.status, "available", JSON.stringify(result));
        if (result.status !== "available") throw new Error(JSON.stringify(result));
        assert.equal(result.result.leafId, targetId);
        assert.equal(h.native.launches.length, launches + 1);
        assert.deepEqual(h.native.native().entries, history);
        assert.deepEqual(h.native.prompts, ["Retain native history"]);
        const binding = yield* h.readBinding(threadId);
        assert.equal(binding?.connected, true);
        assert.deepEqual(binding?.cursor, { ...h.cursor, historyLeafId: targetId });
        assert.equal(binding?.providerThread.nativeConversationHeadRef?.nativeId, targetId);
        const after = yield* h.projections.getThreadProjection(threadId);
        assert.deepEqual(after.runs, before.runs);
        assert.deepEqual(after.providerTurns, before.providerTurns);
        assert.deepEqual(after.messages, before.messages);

        yield* Scope.close(runtimeScope, Exit.void);
        const restored = yield* Effect.gen(function* () {
          return yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(threadId);
        }).pipe(
          Effect.provide(
            ProjectionStore.layer.pipe(
              Layer.provide(SqlitePersistence.layerFromPath(databasePath)),
            ),
          ),
        );
        const saved = restored.providerThreads.find((row) => row.id === h.saved.id);
        assert.deepEqual(saved?.nativeMetadata?.neopiResumeCursor, {
          ...h.cursor,
          historyLeafId: targetId,
        });
        assert.equal(saved?.nativeConversationHeadRef?.nativeId, targetId);
        assert.equal(saved?.nativeThreadRef?.nativeId, h.saved.nativeThreadRef?.nativeId);
        assert.deepEqual(restored.runs, before.runs);
        assert.deepEqual(restored.providerTurns, before.providerTurns);
        assert.deepEqual(restored.messages, before.messages);
      }),
    ),
);
