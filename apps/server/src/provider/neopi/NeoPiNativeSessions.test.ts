// @effect-diagnostics nodeBuiltinImport:off -- managed state filenames use the canonical session hash.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { vi } from "vite-plus/test";
import {
  NeoPiNativeSessionsError,
  ProviderDriverKind,
  ProviderInstanceId,
  type NeoPiJournalEntry,
  type NeoPiNativeSessionRef,
  type NeoPiNativeCursor,
  type NeoPiNativeEntity,
  type NeoPiNativeEssentialEnvelope,
  type NeoPiNativeInboxRecord,
  type NeoPiNativeObservedJournalEntry,
} from "@t3tools/contracts";
import type { ProcessExit, SessionEventFrame } from "effect-neopi-rpc/client";
import { NeoPiRpcError } from "effect-neopi-rpc/errors";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { deriveServerPaths, layerTest as configLayer } from "../../config.ts";
import { layerTest as settingsLayer } from "../../serverSettings.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import * as HostToolBridge from "./NeoPiHostToolBridge.ts";
import * as ManagedTmux from "./NeoPiManagedTmux.ts";
import { registerNeoPiSessionCatalogSource } from "./NeoPiSessionCatalogSource.ts";
import {
  makeNeoPiNativeSessions,
  makeNeoPiNativeSessionsWith,
  type NeoPiNativeConnection,
  type NeoPiNativeProfile,
  type NeoPiNativeSessionsDependencies,
} from "./NeoPiNativeSessions.ts";
import type { NeoPiNativeSettledRecord, NeoPiNativeSettledStore } from "./NeoPiNativeSettlement.ts";
import { prepareNeoPiNativePrompt } from "./NeoPiNativeAttachments.ts";
import { updateNativeModelsConfiguration } from "./NeoPiModels.ts";
import {
  emptyNativeSessionFeed,
  reduceNativeSessionFeed,
  type NativeSessionFeed,
} from "../../../../../packages/client-runtime/src/neopiNativeSessions.ts";

const instanceId = ProviderInstanceId.make("native-profile");
/** The connection every test lease belongs to, unless a test says otherwise. */
const testClient = "client-a";
const otherId = ProviderInstanceId.make("other-profile");
const originalRef = { providerInstanceId: instanceId, sessionFile: "/native/session.jsonl" };
const entry = (id: string, parentId: string | null = null): NeoPiJournalEntry => ({
  id,
  parentId,
  type: "message",
  timestamp: "2026-10-28T00:00:00Z",
  message: { role: "user", content: [{ type: "text", text: id }] },
});

/** Models native ownership and its journal independently of browser watchers. */
const fixture = (attachment: "owned" | "terminal" = "owned") =>
  Effect.gen(function* () {
    const snapshotReleased = yield* Deferred.make<void>();
    const profileChanges = yield* Queue.unbounded<void>();
    const disconnected = yield* Deferred.make<void>();
    const native = {
      sessionId: "native-id",
      sessionFile: originalRef.sessionFile,
      cwd: "/workspace-free",
      generation: 1,
      entries: [] as NeoPiJournalEntry[],
      running: attachment === "terminal",
      /** A terminal owner is alive and holds the session lease. */
      ownerAlive: attachment === "terminal",
      exit: undefined as Deferred.Deferred<ProcessExit> | undefined,
      streaming: false,
      connections: 0,
      starts: 0,
      disposals: 0,
      detaches: 0,
      aborts: 0,
      acceptedPrompts: 0,
      modelRuleRequests: 0,
      capabilities: [] as string[],
      commands: [] as Record<string, unknown>[],
      prompts: [] as string[],
      slashes: [] as Record<string, unknown>[],
      dictation: [] as Record<string, unknown>[],
      profileValid: true,
      blockSnapshot: false,
      startupDialog: false,
      jobs: [] as Record<string, unknown>[],
      agents: [] as Record<string, unknown>[],
      /** `get_subagent_history` rows, served when `capabilities` lists `subagent_history`. */
      history: [] as Record<string, unknown>[],
      /** `get_subagent_history` requests the owner received. */
      historyReads: 0,
      /** Subagent subscription levels requested of the owner, in order. */
      levels: [] as string[],
      /** `snapshot_session_journal` requests the owner received. */
      snapshots: 0,
      /** The owner refuses to raise the subagent level. */
      refuseLevels: false,
      /** `get_entries_page` requests the owner received. */
      pages: 0,
      /** Host-tool registrations (`set_host_tools`) sent to the owner. */
      binds: 0,
      /** Runs inside `connect` once the connection exists (and its finalizer is registered). */
      connectHook: Effect.void as Effect.Effect<void>,
      /** Makes every connect fail with this error. */
      connectError: undefined as NeoPiNativeSessionsError | undefined,
      /** Makes every attach (not start) fail with this error. */
      attachError: undefined as NeoPiNativeSessionsError | undefined,
      /** Makes every start (not attach) fail with this error. */
      autoError: undefined as NeoPiNativeSessionsError | undefined,
      /** Refuses this many requests to lower the subagent level to `off`. */
      rejectOff: 0,
      /** After connecting, the owner reports a different file than the one asked for. */
      mismatch: false,
      /** Runs before a `set_subagent_subscription` is recorded. */
      levelHook: Effect.void as Effect.Effect<void>,
      followUp: [] as string[],
      inventoryFailure: false,
      inventoryHook: Effect.void as Effect.Effect<void>,
      pageHook: Effect.void as Effect.Effect<void, NeoPiRpcError>,
      disposeHook: Effect.void as Effect.Effect<void>,
      afterPageHook: Effect.void as Effect.Effect<void>,
      /** Runs before a `get_state` reply is returned. */
      stateHook: Effect.void as Effect.Effect<void>,
      /** Runs after the snapshot marker is written and before the snapshot reply returns. */
      snapshotHook: Effect.void as Effect.Effect<void>,
      publish: (_frame: SessionEventFrame): Effect.Effect<void> => Effect.void,
    };
    const state = () => ({
      sessionId: native.sessionId,
      sessionFile: native.sessionFile,
      isStreaming: native.streaming,
      messageCount: native.entries.length,
      queuedMessages: { steering: [], followUp: native.followUp },
    });
    const identity = () => ({
      sessionId: native.sessionId,
      sessionFile: native.sessionFile,
      leafId: native.entries.at(-1)?.id ?? null,
    });
    const profile = (id: ProviderInstanceId): NeoPiNativeProfile => ({
      providerInstanceId: id,
      source: {
        binary: "/fixture/npi",
        env: {},
        profile: String(id),
        capabilities: new Set(["session_catalog"]),
        probe: { status: "compatible", version: "fixture" },
      },
      validate: Effect.suspend(() =>
        native.profileValid
          ? Effect.void
          : Effect.fail(
              new NeoPiNativeSessionsError({
                message: "Profile replaced",
                code: "profile_changed",
              }),
            ),
      ),
    });
    const dependencies: NeoPiNativeSessionsDependencies = {
      profileIds: Effect.succeed([instanceId, otherId]),
      profileChanges: Stream.fromQueue(profileChanges),
      profile: (id) => Effect.succeed(profile(id)),
      canonicalize: (file) => Effect.succeed(file.replace("/alias/", "/native/")),
      preparePrompt: (input) =>
        prepareNeoPiNativePrompt(input, "/unused").pipe(Effect.provide(NodeFileSystem.layer)),
      catalog: () => Effect.succeed([]),
      connect: (_profile, input, observer, mode) =>
        Effect.gen(function* () {
          if (native.connectError) return yield* native.connectError;
          if (mode === "attach" && native.attachError) return yield* native.attachError;
          if (mode === "auto" && native.autoError) return yield* native.autoError;
          if (native.connections !== 0)
            return yield* new NeoPiNativeSessionsError({
              code: "session_in_use",
              message: "A writer already owns the file",
            });
          if (mode === "attach" && !native.ownerAlive)
            return yield* new NeoPiNativeSessionsError({
              code: "no_owner",
              message: "No NeoPi owns this session yet.",
            });
          const connectionAttachment = native.ownerAlive ? "terminal" : "owned";
          native.starts++;
          native.connections++;
          native.running = true;
          native.sessionFile = native.mismatch
            ? "/native/other.jsonl"
            : (input.sessionFile ?? "/native/lazy-created.jsonl");
          // The real transport calls the observer synchronously from its parser.
          const publish = (frame: SessionEventFrame) => Effect.sync(() => observer.frame(frame));
          native.publish = publish;
          const exit = yield* Deferred.make<ProcessExit>();
          native.exit = exit;
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* native.disposeHook;
              native.connections--;
              if (connectionAttachment === "owned") {
                native.disposals++;
                native.running = false;
              } else native.detaches++;
              yield* Deferred.succeed(exit, { code: 0, signal: null, stderrTail: "" });
              yield* Deferred.succeed(disconnected, undefined);
            }),
          );
          yield* native.connectHook;
          const client: NeoPiNativeConnection["client"] = {
            capabilities: new Set([
              "session_journal",
              "session_journal_events",
              "models_configuration",
              ...native.capabilities,
            ]),
            exit,
            request: (command) =>
              Effect.gen(function* () {
                switch (command.type) {
                  case "get_state":
                    return state();
                  case "get_jobs":
                    if (native.inventoryFailure)
                      return yield* new NeoPiRpcError({ message: "Inventory unavailable" });
                    return { running: native.jobs, runningCount: native.jobs.length };
                  case "get_subagents":
                    yield* native.inventoryHook;
                    return { subagents: native.agents };
                  case "get_subagent_history":
                    native.historyReads++;
                    return { subagents: native.history };
                  case "set_subagent_subscription":
                    if (native.refuseLevels && Reflect.get(command, "level") !== "off")
                      return yield* new NeoPiRpcError({
                        message: "Subagent event bus is unavailable",
                      });
                    yield* native.levelHook;
                    if (Reflect.get(command, "level") === "off" && native.rejectOff > 0) {
                      native.rejectOff--;
                      return yield* new NeoPiRpcError({ message: "Not now" });
                    }
                    native.levels.push(String(Reflect.get(command, "level")));
                    return { level: native.levels.at(-1) };
                  case "get_status":
                    return {
                      session: state(),
                      cwd: native.cwd,
                      revisions: { generation: native.generation },
                    };
                  case "snapshot_session_journal": {
                    native.snapshots++;
                    yield* publish({ type: "journal_state", reason: "snapshot", ...identity() });
                    if (native.blockSnapshot) yield* Deferred.await(snapshotReleased);
                    yield* native.snapshotHook;
                    return identity();
                  }
                  case "get_entries_page": {
                    native.pages++;
                    yield* native.pageHook;
                    const page = {
                      ...identity(),
                      entries: [...native.entries],
                      totalEntries: native.entries.length,
                    };
                    yield* native.afterPageHook;
                    return page;
                  }
                  case "prompt":
                    native.acceptedPrompts++;
                    native.prompts.push("message" in command ? String(command.message) : "");
                    native.streaming = true;
                    return { userEntryId: "native-admission" };
                  case "get_available_commands":
                    return { commands: native.commands };
                  case "slash":
                    native.slashes.push({ ...command });
                    return { delivery: "started" };
                  case "dictation_start":
                    native.dictation.push({ ...command });
                    yield* publish({
                      type: "dictation_state",
                      captureId: "captureId" in command ? String(command.captureId) : "",
                      state: "recording",
                    });
                    return undefined;
                  case "dictation_stop":
                    native.dictation.push({ ...command });
                    yield* publish({
                      type: "dictation_end",
                      captureId: "capture-1",
                      text: "hello",
                    });
                    return { text: "hello" };
                  case "abort":
                    native.aborts++;
                    native.streaming = false;
                    return undefined;
                  case "set_effort_rules":
                    native.modelRuleRequests++;
                    return yield* new NeoPiRpcError({
                      code: "invalid_value",
                      message: "Invalid model selector glob",
                    });
                  default:
                    return yield* Effect.fail(
                      new NeoPiRpcError({ message: `Unknown native command: ${command.type}` }),
                    );
                }
              }),
            respondUi: (response) =>
              Effect.gen(function* () {
                yield* publish({
                  type: "extension_ui_request",
                  id: "cancel-dialog",
                  method: "cancel",
                  targetId: response.id,
                });
                yield* Deferred.succeed(snapshotReleased, undefined);
              }),
            writeFrame: () => Effect.void,
          };
          if (native.startupDialog)
            yield* publish({
              type: "extension_ui_request",
              id: "native-dialog",
              method: "confirm",
              title: "Native confirmation",
            });
          return {
            client,
            attachment: connectionAttachment,
            cwd: "/workspace-free",
            readState: Effect.suspend(() => native.stateHook).pipe(
              Effect.andThen(Effect.sync(state)),
            ),
            hostTools: {
              bind: () =>
                Effect.sync(() => {
                  native.binds++;
                }),
              revoke: Effect.void,
            },
          };
        }),
    };
    const service = yield* makeNeoPiNativeSessionsWith(dependencies);
    return { native, service, dependencies, profileChanges, disconnected };
  });

type Service = Effect.Success<ReturnType<typeof makeNeoPiNativeSessionsWith>>;
type Envelope = NeoPiNativeEssentialEnvelope;

/**
 * Follows one lease the way the client does: each envelope is applied and its
 * credit returned at once, and bulk state is read by cursor. Tests wait on
 * envelopes in order, never on time.
 */
const follow = Effect.fnUntraced(function* (
  service: Service,
  ref: NeoPiNativeSessionRef,
  client: string = testClient,
  purpose?: "session" | "thread",
) {
  // `ended` marks the watch stream finishing, so a test waiting on an envelope fails instead of hanging.
  const envelopes = yield* Queue.unbounded<Envelope | { readonly type: "ended" }>();
  const leased = yield* Deferred.make<string>();
  let applied = 0;
  /** Every envelope delivered so far, in order. */
  const seen: Envelope[] = [];
  const fiber = yield* service.watch({ ref, ...(purpose ? { purpose } : {}) }, client).pipe(
    Stream.runForEach((envelope) =>
      Effect.gen(function* () {
        if (envelope.type === "leased") yield* Deferred.succeed(leased, envelope.leaseId);
        applied++;
        seen.push(envelope);
        yield* Queue.offer(envelopes, envelope);
        yield* service.credit({ leaseId: yield* Deferred.await(leased), applied }, client);
      }),
    ),
    Effect.ensuring(Queue.offer(envelopes, { type: "ended" })),
    Effect.forkScoped,
  );
  const leaseId = yield* Deferred.await(leased);
  let readId = 0;
  const next = Effect.fnUntraced(function* <Type extends Envelope["type"]>(
    type: Type,
    accept: (envelope: Extract<Envelope, { type: Type }>) => boolean = () => true,
  ) {
    while (true) {
      const envelope = yield* Queue.take(envelopes);
      if (envelope.type === "ended")
        return yield* Effect.die(new Error(`The watch ended before a ${type} envelope.`));
      if (envelope.type === type && accept(envelope as Extract<Envelope, { type: Type }>))
        return envelope as Extract<Envelope, { type: Type }>;
    }
  });
  const read = (cursor: NeoPiNativeCursor | null) =>
    service.read({ leaseId, readId: readId++, cursor }, client);
  /** Reads until one pass completes; returns what it delivered and the cursor after it. */
  const pass = Effect.fnUntraced(function* (from: NeoPiNativeCursor | null = null) {
    const entities = new Map<string, NeoPiNativeEntity["value"]>();
    const removed = new Set<string>();
    const entries: NeoPiNativeObservedJournalEntry[] = [];
    const inbox: NeoPiNativeInboxRecord[] = [];
    let cursor = from;
    while (true) {
      const reply = yield* read(cursor);
      if (reply.type === "unchanged")
        return { entities, removed, entries, inbox, cursor, unchanged: true };
      if (reply.type === "building") continue;
      for (const entity of reply.entities) {
        entities.set(entity.key, entity.value);
        removed.delete(entity.key);
      }
      for (const tombstone of reply.tombstones) {
        entities.delete(tombstone.key);
        removed.add(tombstone.key);
      }
      entries.push(...(reply.journal?.entries ?? []));
      inbox.push(...reply.inbox);
      cursor = reply.continuation;
      if (cursor.pass === null)
        return { entities, removed, entries, inbox, cursor, unchanged: false };
    }
  });
  return { fiber, leaseId, next, read, pass, seen, client };
});

/** A new lease's description and first complete pass, as a freshly mounted view sees them. */
const snapshot = Effect.fnUntraced(function* (service: Service, ref: NeoPiNativeSessionRef) {
  const lease = yield* follow(service, ref);
  const { session } = yield* lease.next("session");
  return { ...(yield* lease.pass()), session, lease };
});

describe("canonical native session lifecycle", () => {
  it.effect(
    "I4(4): an owned runtime is never retired for being unobserved, idle or released; explicit close still ends it",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open(originalRef);
        const lease = yield* follow(service, originalRef);
        yield* lease.next("lifecycle", observing);
        yield* TestClock.adjust("1 hour");
        assert.equal(native.connections, 1);
        yield* Fiber.interrupt(lease.fiber);
        yield* TestClock.adjust("1 hour");
        assert.equal(native.connections, 1);
        assert.equal(native.disposals, 0);
        assert.equal(native.aborts, 0);
        // Reopening reuses the same owner rather than starting another.
        yield* service.open(originalRef);
        assert.equal(native.starts, 1);
        assert.deepEqual(yield* service.close({ ref: originalRef }), { closed: true });
        assert.equal(native.connections, 0);
        assert.equal(native.disposals, 1);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps an owner while its Models consumers are attached and after they leave", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      yield* service.open(originalRef);
      const models = yield* service.modelsConnection(originalRef);
      const ready = yield* Deferred.make<void>();
      const observer = yield* models.changes.pipe(Stream.runDrain, Effect.forkScoped);
      // A delivered UI frame is a receipt that the Models subscriber is attached.
      const ui = yield* (yield* models.loginUi("flow")).pipe(
        Stream.tap(() => Deferred.succeed(ready, undefined)),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* native.publish({
        type: "extension_ui_request",
        id: "notice",
        method: "notify",
        loginId: "flow",
      });
      yield* Deferred.await(ready);
      yield* TestClock.adjust("1 hour");
      assert.equal(native.connections, 1);
      yield* Fiber.interrupt(observer);
      yield* Fiber.interrupt(ui);
      yield* TestClock.adjust("1 hour");
      assert.equal(native.connections, 1);
      assert.equal(native.disposals, 0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "never idle-reaps terminal-owned sessions and only detaches them at server shutdown",
    () =>
      Effect.gen(function* () {
        const native = yield* Effect.gen(function* () {
          const { native, service } = yield* fixture("terminal");
          yield* service.open(originalRef);
          yield* TestClock.adjust("1 hour");
          assert.equal(native.connections, 1);
          return native;
        }).pipe(Effect.scoped);
        assert.equal(native.detaches, 1);
        assert.equal(native.disposals, 0);
        assert.equal(native.running, true);
        assert.equal(native.aborts, 0);
      }),
  );

  it.effect(
    "keeps native invalid-pattern diagnostics through the canonical connected Models path",
    () =>
      Effect.gen(function* () {
        for (const attachment of ["owned", "terminal"] as const) {
          const { native, service } = yield* fixture(attachment);
          yield* service.open(originalRef);
          const connection = yield* service.modelsConnection(originalRef);
          const result = yield* Effect.result(
            updateNativeModelsConfiguration(connection, {
              target: originalRef,
              change: {
                operation: "rules",
                scope: "project",
                rules: [{ selector: "provider/[", allowed: ["low"] }],
                expected: null,
              },
            }),
          );
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.equal(result.failure.code, "invalid_value");
            assert.equal(result.failure.message, "Invalid model selector glob");
          }
          assert.equal(native.modelRuleRequests, 1);
          assert.equal(native.connections, 1);
          assert.equal(native.aborts, 0);
        }
      }).pipe(Effect.scoped),
  );
  it.effect(
    "eagerly closes invalidated native profiles while detaching terminal owners without abort",
    () =>
      Effect.gen(function* () {
        for (const attachment of ["owned", "terminal"] as const) {
          const { native, service, profileChanges, disconnected } = yield* fixture(attachment);
          yield* service.open(originalRef);
          native.profileValid = false;
          yield* Queue.offer(profileChanges, undefined);
          yield* Deferred.await(disconnected);
          assert.equal(native.connections, 0);
          assert.equal(native.aborts, 0);
          assert.equal(native.disposals, attachment === "owned" ? 1 : 0);
          assert.equal(native.detaches, attachment === "terminal" ? 1 : 0);
          assert.deepEqual(yield* service.close({ ref: originalRef }), { closed: false });
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects client tool registration/result injection on owned and terminal connections",
    () =>
      Effect.gen(function* () {
        for (const attachment of ["owned", "terminal"] as const) {
          const { native, service } = yield* fixture(attachment);
          yield* service.open(originalRef);
          for (const type of [
            "set_host_tools",
            "serve",
            "unserve",
            "host_tool_result",
            "host_tool_update",
          ]) {
            const result = yield* service
              .request({
                ref: originalRef,
                command: { type, id: "spoofed", tools: [], result: { content: [] } },
              })
              .pipe(Effect.result);
            assert.equal(result._tag, "Failure");
            if (result._tag === "Failure")
              assert.equal(result.failure.code, "host_tools_server_owned");
          }
          assert.equal(native.acceptedPrompts, 0);
          yield* service.request({
            ref: originalRef,
            command: { type: "prompt", message: "real input" },
          });
          assert.equal(native.acceptedPrompts, 1);
        }
      }).pipe(Effect.scoped),
  );

  it.effect("single-flights concurrent opens of canonical aliases and outlives caller scopes", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      const opened = yield* Effect.all(
        Array.from({ length: 8 }, (_, index) =>
          service
            .open({
              providerInstanceId: instanceId,
              sessionFile: index % 2 === 0 ? "/alias/session.jsonl" : originalRef.sessionFile,
            })
            .pipe(Effect.scoped),
        ),
        { concurrency: "unbounded" },
      );
      assert.equal(native.starts, 1);
      assert.equal(native.connections, 1);
      assert.equal(native.running, true);
      for (const result of opened) {
        assert.deepEqual(result.ref, originalRef);
        assert.equal(result.sessionId, "native-id");
      }
      assert.deepEqual(yield* service.close({ ref: originalRef }), { closed: true });
      assert.equal(native.disposals, 1);
      assert.equal(native.connections, 0);
      assert.equal(native.running, false);
      assert.deepEqual(yield* service.close({ ref: originalRef }), { closed: false });
    }).pipe(Effect.scoped),
  );

  it.effect("opens the managed graphical view via the attach-only connection", () =>
    Effect.gen(function* () {
      const { native, dependencies } = yield* fixture("terminal");
      const executable = "/test-bin/tmux";
      const owner = {
        executable,
        session: "$0",
        window: "@0",
        pane: "%0",
        pid: 123,
        instanceId: "control-instance",
        imageId: "control-image",
        sessionId: native.sessionId,
      };
      const args = ["-N", "-S", "/private/owner.sock", "attach-session", "-E", "-t", "$0"];
      const modes: Array<string | undefined> = [];
      const service = yield* makeNeoPiNativeSessionsWith({
        ...dependencies,
        managedTmuxView: () => Effect.succeed({ owner, executable, args }),
        connect: (profile, input, observer, mode) => {
          modes.push(mode);
          return dependencies.connect(profile, input, observer, mode).pipe(
            Effect.map((connection) => ({
              ...connection,
              managedTmux: { ...owner, sessionFile: originalRef.sessionFile },
            })),
          );
        },
      });
      assert.deepEqual(yield* service.managedTmuxView(originalRef), {
        cwd: native.cwd,
        executable,
        args,
      });
      assert.deepEqual(modes, ["attach"]);
      yield* service.close({ ref: originalRef });
      assert.equal(native.detaches, 1);
      assert.equal(native.disposals, 0);
      assert.equal(native.running, true);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps native-created lazy identities discoverable without a project or persisted journal",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        const opened = yield* service.open({ providerInstanceId: instanceId });
        assert.deepEqual(opened.ref, {
          providerInstanceId: instanceId,
          sessionFile: "/native/lazy-created.jsonl",
        });
        assert.equal(opened.cwd, "/workspace-free");
        assert.equal(opened.sessionId, "native-id");
        const catalog = yield* service.list({});
        assert.deepEqual(
          catalog.sessions.map((session) => ({ ref: session.ref, owner: session.owner })),
          [{ ref: opened.ref, owner: { kind: "neocode", attachment: "owned" } }],
        );
        assert.equal(native.entries.length, 0);
        assert.equal(native.starts, 1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps alias-spelled native snapshots on the canonical ref across first persistence",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        native.sessionFile = "/alias/session.jsonl";
        const first = yield* snapshot(service, originalRef);
        assert.deepEqual(first.session.ref, originalRef);
        assert.equal(first.session.state.sessionFile, originalRef.sessionFile);
        assert.deepEqual(first.entries, []);
        native.sessionFile = originalRef.sessionFile;
        yield* native.publish({
          type: "journal_state",
          reason: "identity",
          sessionId: "native-id",
          sessionFile: originalRef.sessionFile,
          leafId: null,
        });
        const reopened = yield* service.open({ ...originalRef });
        assert.deepEqual(reopened.ref, originalRef);
        assert.equal(reopened.sessionId, first.session.sessionId);
        assert.equal(native.starts, 1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "delivers every first-flush entry when a native append batch shares the current leaf",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const first = entry("batch-first");
        const last = entry("batch-last", first.id);
        native.afterPageHook = Effect.gen(function* () {
          native.entries.push(first, last);
          const identity = {
            sessionId: "native-id",
            sessionFile: originalRef.sessionFile,
            leafId: last.id,
          };
          yield* native.publish({ type: "journal_state", reason: "leaf", ...identity });
          yield* native.publish({ type: "journal_entry", ...identity, entry: first });
          yield* native.publish({ type: "journal_entry", ...identity, entry: last });
        });
        const lease = yield* follow(service, originalRef);
        // The two-entry batch under one leaf announcement costs a build retry today
        // (reported to the projection's owner); the retry runs on the test clock.
        const reading = yield* lease.pass().pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        const { entries } = yield* Fiber.join(reading);
        assert.deepEqual(
          entries.map((entry) => entry.id),
          [first.id, last.id],
        );
        assert.equal(native.acceptedPrompts, 0);
      }).pipe(Effect.scoped),
  );

  it.effect("does not start sessions for listing and isolates native profile failures", () =>
    Effect.gen(function* () {
      const { native, dependencies } = yield* fixture();
      const service = yield* makeNeoPiNativeSessionsWith({
        ...dependencies,
        catalog: (profile) =>
          profile.providerInstanceId === otherId
            ? Effect.fail(
                new NeoPiNativeSessionsError({ message: "Native profile catalog failed" }),
              )
            : Effect.succeed([
                {
                  path: originalRef.sessionFile,
                  id: "disk-id",
                  cwd: "/workspace-free",
                  title: null,
                  firstMessage: "saved",
                  modified: "2026-10-28T00:00:00Z",
                  inUse: { pid: 42 },
                  control: { instanceId: "native-owner" },
                },
              ]),
      });
      const result = yield* service.list({});
      assert.deepEqual(
        result.sessions.map((session) => ({ ref: session.ref, owner: session.owner })),
        [{ ref: originalRef, owner: { kind: "process", pid: 42, attachable: true } }],
      );
      assert.deepEqual(result.diagnostics, [
        { providerInstanceId: otherId, message: "Native profile catalog failed" },
      ]);
      assert.equal(native.starts, 0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps a running owned turn across watcher teardown and reconnects from native history without replay",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const first = yield* snapshot(service, originalRef);
        yield* Fiber.interrupt(first.lease.fiber);
        assert.deepEqual(
          yield* service.request({
            ref: originalRef,
            command: { type: "prompt", message: "native input" },
          }),
          { userEntryId: "native-admission" },
        );
        native.entries.push(entry("native-admission"));
        yield* native.publish({
          type: "journal_entry",
          sessionId: native.sessionId,
          sessionFile: native.sessionFile,
          leafId: "native-admission",
          entry: native.entries[0],
        });
        const second = yield* snapshot(service, originalRef);
        assert.deepEqual(second.entries, [entry("native-admission")]);
        // A lease arriving after an unobserved stretch re-reads `get_state`; the change
        // reaches it in its first pass or in the next read, whichever comes first.
        const next = yield* second.lease.pass(second.cursor).pipe(Effect.forkChild);
        yield* TestClock.adjust("20 seconds");
        const latest = new Map([...second.entities, ...(yield* Fiber.join(next)).entities]);
        const state = latest.get("setting:state");
        const record = state?.class === "setting" ? state.value.value : undefined;
        assert.isTrue(
          typeof record === "object" &&
            record !== null &&
            "isStreaming" in record &&
            record.isStreaming === true,
        );
        assert.equal(native.acceptedPrompts, 1);
        assert.equal(native.aborts, 0);
        assert.equal(native.disposals, 0);
        assert.equal(native.connections, 1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "reconciles a concurrent durable commit while preserving native streaming and persistence identities",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const committed = entry("native-committed");
        const persisted = {
          type: "message_persisted",
          sessionId: "native-id",
          sessionFile: originalRef.sessionFile,
          leafId: committed.id,
          messageId: "native-message",
          entryId: committed.id,
        };
        const update = {
          type: "message_update",
          messageId: "native-next",
          message: { role: "assistant", content: [{ type: "text", text: "live" }] },
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "live" },
        };
        native.pageHook = Effect.gen(function* () {
          native.entries.push(committed);
          yield* native.publish({
            type: "journal_entry",
            sessionId: "native-id",
            sessionFile: originalRef.sessionFile,
            leafId: committed.id,
            entry: committed,
          });
          yield* native.publish(persisted);
          yield* native.publish(update);
        });
        const { entities, entries } = yield* snapshot(service, originalRef);
        // The commit arrived while the build's page was in flight: it is delivered once.
        assert.deepEqual(entries, [committed]);
        const live = entities.get("message:native-next");
        assert.equal(live?.class === "message" && live.phase, "open");
      }).pipe(Effect.scoped),
  );

  it.effect("S2: a build gated on an interaction completes once the client answers it", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      native.startupDialog = true;
      native.blockSnapshot = true;
      yield* service.open({ ...originalRef });
      const lease = yield* follow(service, originalRef);
      // NeoPi withholds the snapshot reply until the dialog is answered; the request
      // still reaches the client on the essential stream while the build waits.
      const opened = yield* lease.next("obligation-opened", (env) => env.id === "native-dialog");
      assert.equal(opened.request.type, "extension_ui_request");
      const reading = yield* lease.pass().pipe(Effect.forkChild);
      yield* service.request({
        ref: originalRef,
        command: { type: "extension_ui_response", id: opened.id, confirmed: true },
      });
      // The fixture's owner also cancels the answered dialog; either settle closes it.
      yield* lease.next("obligation-settled", (env) => env.id === opened.id);
      yield* lease.next("lifecycle", (env) => env.state === "observing");
      const { entries } = yield* Fiber.join(reading);
      assert.deepEqual(entries, []);
      assert.equal(native.running, true);
      assert.equal(native.disposals, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("passes dictation commands to the native owner and serves their outcome", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture();
      yield* service.open({ ...originalRef });
      const lease = yield* follow(service, originalRef);
      const built = yield* lease.pass();
      yield* service.request({
        ref: originalRef,
        command: { type: "dictation_start", captureId: "capture-1" },
      });
      assert.deepEqual(
        yield* service.request({ ref: originalRef, command: { type: "dictation_stop" } }),
        { text: "hello" },
      );
      const { entities } = yield* lease.pass(built.cursor);
      assert.deepEqual(entities.get("presentation:dictation"), {
        class: "presentation",
        value: { captureId: "capture-1", phase: "ended", text: "hello", error: null },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("sends terminal dictation commands without a session generation guard", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture("terminal");
      yield* service.open({ ...originalRef });
      yield* service.request({
        ref: originalRef,
        command: { type: "dictation_start", captureId: "capture-1" },
      });
      // The terminal moved on; a stop must still reach NeoPi or the microphone stays open.
      native.generation++;
      yield* service.request({ ref: originalRef, command: { type: "dictation_stop" } });
      assert.deepEqual(native.dictation, [
        { type: "dictation_start", captureId: "capture-1" },
        { type: "dictation_stop" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("answers data-less native commands with a JSON value", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      yield* service.open({ ...originalRef });
      // NeoPi answers abort without data. The RPC wire only carries JSON, so an
      // undefined result would fail a request whose native command succeeded.
      assert.strictEqual(
        yield* service.request({ ref: originalRef, command: { type: "abort" } }),
        null,
      );
      assert.strictEqual(native.aborts, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("detaches terminal control without aborting or disposing the external owner", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture("terminal");
      const opened = yield* service.open({ ...originalRef });
      assert.equal(opened.attachment, "terminal");
      yield* snapshot(service, originalRef);
      yield* service.close({ ref: originalRef });
      assert.equal(native.running, true);
      assert.equal(native.streaming, false);
      assert.equal(native.detaches, 1);
      assert.equal(native.disposals, 0);
      assert.equal(native.aborts, 0);
      assert.equal(native.connections, 0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "types TUI commands into a terminal's editor and keeps other text on the prompt path",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture("terminal");
        native.capabilities.push("command_catalog");
        native.commands = [
          { name: "personality", availability: "tui", input: { hint: "<name>" } },
          { name: "usage", aliases: ["u"], availability: "headless" },
        ];
        yield* service.open({ ...originalRef });
        const send = (message: string, streamingBehavior?: "steer") =>
          service.request({
            ref: originalRef,
            command: {
              type: "prompt",
              message,
              ...(streamingBehavior ? { streamingBehavior } : {}),
            },
          });
        yield* send("/personality Angel", "steer");
        yield* send("/u");
        yield* send("/tmp/notes.md is broken");
        yield* send("/unheard-of thing");
        assert.deepEqual(native.slashes, [
          { type: "slash", text: "/personality Angel", if: { generation: native.generation } },
        ]);
        assert.deepEqual(native.prompts, ["/u", "/tmp/notes.md is broken", "/unheard-of thing"]);
      }).pipe(Effect.scoped),
  );

  it.effect("sends unlisted commands to the pane when NeoPi lists only headless ones", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture("terminal");
      native.commands = [{ name: "usage" }];
      yield* service.open({ ...originalRef });
      for (const message of ["/personality Angel", "/usage"])
        yield* service.request({ ref: originalRef, command: { type: "prompt", message } });
      assert.deepEqual(
        native.slashes.map((command) => command.text),
        ["/personality Angel"],
      );
      assert.deepEqual(native.prompts, ["/usage"]);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves owned-session slash text for NeoPi to parse", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      native.capabilities.push("command_catalog");
      native.commands = [{ name: "personality", availability: "tui" }];
      yield* service.open({ ...originalRef });
      yield* service.request({
        ref: originalRef,
        command: { type: "prompt", message: "/personality Angel" },
      });
      assert.deepEqual(native.prompts, ["/personality Angel"]);
      assert.deepEqual(native.slashes, []);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects stale terminal refs even when the identity event has not reached the graphical observer",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture("terminal");
        yield* service.open({ ...originalRef });
        native.sessionId = "terminal-switched";
        native.sessionFile = "/native/terminal-switched.jsonl";
        native.cwd = "/terminal-new-workspace";
        native.generation++;
        const result = yield* service
          .request({
            ref: originalRef,
            command: { type: "prompt", message: "must not follow terminal" },
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.code, "session_changed");
        assert.equal(native.acceptedPrompts, 0);
        assert.equal(native.running, true);
        const reopened = yield* service.open({
          providerInstanceId: instanceId,
          sessionFile: native.sessionFile,
        });
        assert.equal(reopened.sessionId, "terminal-switched");
        assert.equal(reopened.cwd, "/terminal-new-workspace");
        assert.equal(native.starts, 1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "dismisses answered native dialogs in every mounted watcher without replaying them on reconnect",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        yield* native.publish({ type: "tool_approval_request", id: "approval", toolName: "bash" });
        yield* native.publish({
          type: "plan_proposal_request",
          id: "plan",
          planMarkdown: "Native plan",
        });
        const watchers = [yield* follow(service, originalRef), yield* follow(service, originalRef)];
        for (const watcher of watchers)
          yield* watcher.next("obligation-opened", (envelope) => envelope.id === "plan");
        yield* service.request({
          ref: originalRef,
          command: { type: "tool_approval_response", id: "approval", decision: "deny" },
        });
        yield* service.request({
          ref: originalRef,
          command: {
            type: "plan_proposal_response",
            id: "plan",
            decision: "refine",
            feedback: "Private review note",
          },
        });
        for (const watcher of watchers) {
          // Settles carry identity only, never private answer contents.
          assert.deepEqual(
            [
              yield* watcher.next("obligation-settled"),
              yield* watcher.next("obligation-settled"),
            ].map(({ id, outcome }) => ({ id, outcome })),
            [
              { id: "approval", outcome: "answered" },
              { id: "plan", outcome: "answered" },
            ],
          );
        }
        const reconnect = yield* follow(service, originalRef);
        yield* reconnect.pass();
        assert.equal(
          reconnect.seen.some((envelope) => envelope.type === "obligation-opened"),
          false,
        );
        yield* service.close({ ref: originalRef });
      }).pipe(Effect.scoped),
  );

  it.effect("does not resurrect cancelled native tool approvals or plans for a later watcher", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      yield* service.open({ ...originalRef });
      yield* native.publish({ type: "tool_approval_request", id: "native-approval" });
      yield* native.publish({ type: "plan_proposal_request", id: "native-plan" });
      yield* native.publish({
        type: "tool_approval_cancel",
        id: "native-cancellation-frame",
        targetId: "native-approval",
      });
      yield* native.publish({ type: "plan_proposal_cancel", id: "native-plan" });
      const lease = yield* follow(service, originalRef);
      yield* lease.pass();
      assert.equal(
        lease.seen.some((envelope) => envelope.type === "obligation-opened"),
        false,
      );
      assert.equal(native.connections, 1);
      assert.equal(native.disposals, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("does not open disconnected native sessions for Models", () =>
    Effect.gen(function* () {
      for (const attachment of ["owned", "terminal"] as const) {
        const { native, service } = yield* fixture(attachment);
        const result = yield* service.modelsConnection(originalRef).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure.code, "closed");
          assert.match(result.failure.message, /session is not connected/i);
        }
        assert.equal(native.starts, 0);
        assert.equal(native.connections, 0);
        assert.equal(native.running, attachment === "terminal");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("reuses a connected canonical owner without reopening it after explicit close", () =>
    Effect.gen(function* () {
      for (const attachment of ["owned", "terminal"] as const) {
        const { native, service } = yield* fixture(attachment);
        yield* service.open(originalRef);
        const [first, second] = yield* Effect.all(
          [
            service.modelsConnection(originalRef).pipe(Effect.scoped),
            service
              .modelsConnection({ ...originalRef, sessionFile: "/alias/session.jsonl" })
              .pipe(Effect.scoped),
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(native.starts, 1);
        assert.equal(native.connections, 1);
        yield* service.close({ ref: originalRef });
        assert.equal((yield* first!.validate.pipe(Effect.result))._tag, "Failure");
        assert.equal((yield* second!.validate.pipe(Effect.result))._tag, "Failure");
        const result = yield* service.modelsConnection(originalRef).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure.code, "closed");
          assert.match(result.failure.message, /session is not connected/i);
        }
        assert.equal(native.starts, 1);
        assert.equal(native.connections, 0);
        assert.equal(native.running, attachment === "terminal");
        assert.equal(native.disposals, attachment === "owned" ? 1 : 0);
      }
    }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects stale terminal Models refs without changing models or opening another owner",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture("terminal");
        yield* service.open(originalRef);
        native.sessionId = "terminal-switched";
        native.sessionFile = "/native/terminal-switched.jsonl";
        native.generation++;
        const connection = yield* service.modelsConnection(originalRef);
        const result = yield* updateNativeModelsConfiguration(connection, {
          target: originalRef,
          change: { operation: "rules", scope: "project", rules: [], expected: null },
        }).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.code, "session_changed");
        assert.equal(native.modelRuleRequests, 0);
        assert.equal(native.starts, 1);
        assert.equal(native.connections, 1);
        assert.equal(native.running, true);
        assert.equal(
          (yield* service.modelsConnection(originalRef).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(native.starts, 1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects cross-profile reuse and invalidated profiles without losing explicit cleanup",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const conflict = yield* service
          .open({ providerInstanceId: otherId, sessionFile: originalRef.sessionFile })
          .pipe(Effect.result);
        assert.equal(conflict._tag, "Failure");
        if (conflict._tag === "Failure") assert.equal(conflict.failure.code, "profile_conflict");
        native.profileValid = false;
        const stale = yield* service
          .request({ ref: originalRef, command: { type: "prompt", message: "wrong profile" } })
          .pipe(Effect.result);
        assert.equal(stale._tag, "Failure");
        if (stale._tag === "Failure") assert.equal(stale.failure.code, "profile_changed");
        assert.equal(native.acceptedPrompts, 0);
        assert.equal(native.starts, 1);
        assert.deepEqual(yield* service.close({ ref: originalRef }), { closed: true });
        assert.equal(native.disposals, 1);
      }).pipe(Effect.scoped),
  );

  it.effect("begins every owned runtime shutdown before awaiting any one runtime's exit", () =>
    Effect.gen(function* () {
      const first = yield* fixture();
      const second = yield* fixture();
      const firstRef = { ...originalRef, sessionFile: "/native/first.jsonl" };
      const secondRef = { ...originalRef, sessionFile: "/native/second.jsonl" };
      const serviceScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(serviceScope, Exit.void));
      const service = yield* makeNeoPiNativeSessionsWith({
        ...first.dependencies,
        connect: (profile, input, publish) =>
          (input.sessionFile === firstRef.sessionFile ? first : second).dependencies.connect(
            profile,
            input,
            publish,
          ),
      }).pipe(Effect.provideService(Scope.Scope, serviceScope));
      yield* service.open(firstRef);
      yield* service.open(secondRef);
      const started = yield* Queue.unbounded<string>();
      const release = yield* Deferred.make<void>();
      first.native.disposeHook = Queue.offer(started, "first").pipe(
        Effect.andThen(Deferred.await(release)),
      );
      second.native.disposeHook = Queue.offer(started, "second").pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const closing = yield* Scope.close(serviceScope, Exit.void).pipe(Effect.forkScoped);
      assert.deepEqual((yield* Queue.takeN(started, 2)).toSorted(), ["first", "second"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closing);
      assert.equal(first.native.disposals, 1);
      assert.equal(second.native.disposals, 1);
    }).pipe(Effect.scoped),
  );
});

const ownerExited = { code: 0, signal: null, stderrTail: "" } as const;
const observing = (envelope: Extract<Envelope, { type: "lifecycle" }>) =>
  envelope.state === "observing";

describe("terminal owner replacement", () => {
  it.effect(
    "reattaches in place when a restarted terminal returns, keeping the lease, then rebuilds",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture("terminal");
        yield* service.open(originalRef);
        const lease = yield* follow(service, originalRef);
        yield* lease.next("lifecycle", observing);

        native.ownerAlive = false;
        yield* Deferred.succeed(native.exit!, ownerExited);
        const reconnecting = yield* lease.next(
          "lifecycle",
          (envelope) => envelope.state === "reconnecting",
        );
        assert.match(reconnecting.reason ?? "", /exited \(0\)/);

        native.ownerAlive = true;
        yield* TestClock.adjust("1 second");
        const { session } = yield* lease.next("session");
        assert.equal(session.attachment, "terminal");
        yield* lease.next("lifecycle", observing);
        assert.equal(native.starts, 2);
        assert.equal(native.connections, 1);
        assert.equal(native.disposals, 0);

        yield* service.request({ ref: originalRef, command: { type: "prompt", message: "after" } });
        assert.equal(native.acceptedPrompts, 1);
      }).pipe(Effect.scoped),
  );

  it.effect("starts no owner during the grace period, then takes over for a waiting prompt", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture("terminal");
      yield* service.open(originalRef);
      const lease = yield* follow(service, originalRef);
      yield* lease.next("lifecycle", observing);

      native.ownerAlive = false;
      yield* Deferred.succeed(native.exit!, ownerExited);
      yield* lease.next("lifecycle", (envelope) => envelope.state === "reconnecting");
      const sent = yield* service
        .request({ ref: originalRef, command: { type: "prompt", message: "queued" } })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      yield* TestClock.adjust("5 seconds");
      assert.equal(native.starts, 1);
      assert.equal(native.acceptedPrompts, 0);

      yield* TestClock.adjust("6 seconds");
      yield* Fiber.join(sent);
      assert.equal(native.starts, 2);
      assert.equal(native.acceptedPrompts, 1);
      assert.deepEqual(native.prompts, ["queued"]);
      const { session } = yield* lease.next("session");
      assert.equal(session.attachment, "owned");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "ends the lease as owner-stopped when nothing replaces the terminal, and a revisit reopens",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture("terminal");
        yield* service.open(originalRef);
        const lease = yield* follow(service, originalRef);
        yield* lease.next("lifecycle", observing);

        native.ownerAlive = false;
        yield* Deferred.succeed(native.exit!, ownerExited);
        yield* lease.next("lifecycle", (envelope) => envelope.state === "reconnecting");
        yield* TestClock.adjust("9 seconds");
        assert.equal(native.starts, 1);

        yield* TestClock.adjust("2 seconds");
        yield* lease.next("lifecycle", (envelope) => envelope.state === "owner-stopped");
        yield* Fiber.join(lease.fiber);
        assert.equal(native.starts, 1);

        const reopened = yield* service.open(originalRef);
        assert.equal(reopened.attachment, "owned");
        assert.equal(native.starts, 2);
      }).pipe(Effect.scoped),
  );

  it.effect("detaches from a terminal on explicit close and leaves the terminal running", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture("terminal");
      yield* service.open(originalRef);
      const lease = yield* follow(service, originalRef);
      yield* lease.next("lifecycle", observing);

      assert.deepEqual(yield* service.close({ ref: originalRef }), { closed: true });
      yield* lease.next("lifecycle", (envelope) => envelope.state === "detached");
      yield* Fiber.join(lease.fiber);
      assert.equal(native.running, true);
      assert.equal(native.aborts, 0);
      assert.equal(native.detaches, 1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "fails requests held for a replacement owner when the session is closed meanwhile",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture("terminal");
        yield* service.open(originalRef);
        const lease = yield* follow(service, originalRef);
        yield* lease.next("lifecycle", observing);

        native.ownerAlive = false;
        yield* Deferred.succeed(native.exit!, ownerExited);
        yield* lease.next("lifecycle", (envelope) => envelope.state === "reconnecting");
        const held = yield* service
          .request({ ref: originalRef, command: { type: "get_state" } })
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        assert.deepEqual(yield* service.close({ ref: originalRef }), { closed: true });
        const result = yield* Fiber.join(held).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.code, "detached");
        assert.equal(native.starts, 1);
      }).pipe(Effect.scoped),
  );
});

const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const bodyOf = (value: NeoPiNativeEntity["value"] | undefined) =>
  value?.class === "message" ? value.message.content : undefined;
/** Appends `count` entries to the native branch, each announced as NeoPi does. */
const appender = (native: Effect.Success<ReturnType<typeof fixture>>["native"]) => {
  let made = 0;
  return Effect.fnUntraced(function* (count: number) {
    for (let index = 0; index < count; index++) {
      const appended = entry(`append-${made++}`, native.entries.at(-1)?.id ?? null);
      native.entries.push(appended);
      yield* native.publish({
        type: "journal_entry",
        sessionId: native.sessionId,
        sessionFile: native.sessionFile,
        leafId: appended.id,
        entry: appended,
      });
    }
    return native.entries.at(-1)!;
  });
};

describe("native observation (r12 §3.1)", () => {
  it.effect(
    "S1: a fast primary past every bound while state, snapshot and page are held ends no observation",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        yield* service.request({ ref: originalRef, command: { type: "prompt", message: "go" } });
        let body = "";
        // Each held reply waits behind 1,000 cumulative updates and 1,000 tool stream records:
        // 3,000 frames and more than 8 MiB in all, beyond the old 256-item / 8 MiB budget and
        // the inbox bound.
        const burst = Effect.gen(function* () {
          for (let index = 0; index < 1000; index++) {
            body += "abc";
            yield* native.publish({
              type: "message_update",
              messageId: "fast",
              message: assistant(body),
            });
            yield* native.publish({
              type: "tool_stream_update",
              toolCallId: "bash-1",
              toolName: "bash",
              update: { chunk: index },
            });
          }
        });
        native.snapshotHook = burst;
        native.stateHook = burst;
        native.pageHook = burst;
        const lease = yield* follow(service, originalRef);
        const built = yield* lease.pass();
        native.snapshotHook = Effect.void;
        native.stateHook = Effect.void;
        native.pageHook = Effect.void;
        const latestBody = assistant(body).content;
        assert.deepEqual(bodyOf(built.entities.get("message:fast")), latestBody);
        // The evicted inbox records are reported as such, never dropped silently.
        assert.isTrue(
          built.inbox.some((record) => record.type === "gap" && record.reason === "evicted"),
        );
        yield* native.publish({ type: "message_end", messageId: "fast", message: assistant(body) });
        const ended = (yield* lease.pass(built.cursor)).entities.get("message:fast");
        assert.equal(ended?.class === "message" && ended.phase, "ended");
        assert.deepEqual(bodyOf(ended), latestBody);
        // The stream carried only build and observing lifecycle: capacity ended nothing.
        assert.isTrue(
          lease.seen.every(
            (envelope) =>
              envelope.type !== "lifecycle" ||
              envelope.state === "building" ||
              envelope.state === "observing",
          ),
        );
        assert.equal(native.starts, 1);
        assert.equal(native.acceptedPrompts, 1);
        assert.equal(native.aborts, 0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "S4: builds that span more than the ring still publish, and successive reads advance",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const append = appender(native);
        // The producer never pauses: every build reply arrives behind more appends than
        // the projection's recent-entry ring holds.
        native.snapshotHook = append(600).pipe(Effect.asVoid);
        native.stateHook = append(600).pipe(Effect.asVoid);
        native.pageHook = append(600).pipe(Effect.asVoid);
        const lease = yield* follow(service, originalRef);
        let { cursor, entries } = yield* lease.pass();
        native.snapshotHook = Effect.void;
        native.stateHook = Effect.void;
        native.pageHook = Effect.void;
        assert.equal(entries.at(-1)?.id, native.entries.at(-1)?.id);
        for (let round = 0; round < 3; round++) {
          const head = yield* append(600);
          const read = yield* lease.pass(cursor);
          assert.equal(read.entries.at(-1)?.id, head.id);
          assert.equal(new Set(read.entries.map((item) => item.id)).size, read.entries.length);
          cursor = read.cursor;
          entries = read.entries;
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "S5: a stalled reader holds only its credit window while a second reader and every command proceed",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        // Lease A takes its envelopes but never reads and never returns credit.
        const stalled = yield* Queue.unbounded<Envelope>();
        yield* service.watch({ ref: originalRef }, testClient).pipe(
          Stream.runForEach((envelope) => Queue.offer(stalled, envelope)),
          Effect.forkScoped,
        );
        const current = yield* follow(service, originalRef);
        const built = yield* current.pass();
        let body = "";
        for (let index = 0; index < 500; index++) {
          body += "abc";
          yield* native.publish({ type: "agent_start" });
          yield* native.publish({
            type: "message_update",
            messageId: "live",
            message: assistant(body),
          });
          yield* native.publish({ type: "agent_end" });
        }
        yield* native.publish({ type: "host_tool_call", id: "host-1", toolName: "preview" });
        yield* current.next("obligation-opened", (envelope) => envelope.id === "host-1");
        yield* native.publish({ type: "extension_ui_request", id: "ask-1", method: "confirm" });
        yield* current.next("obligation-opened", (envelope) => envelope.id === "ask-1");
        yield* service.request({
          ref: originalRef,
          command: { type: "extension_ui_response", id: "ask-1", confirmed: true },
        });
        yield* current.next("obligation-settled", (envelope) => envelope.id === "ask-1");
        yield* service.request({ ref: originalRef, command: { type: "prompt", message: "next" } });
        yield* service.request({ ref: originalRef, command: { type: "abort" } });
        assert.equal(native.acceptedPrompts, 1);
        assert.equal(native.aborts, 1);
        const latest = yield* current.pass(built.cursor);
        assert.deepEqual(bodyOf(latest.entities.get("message:live")), assistant(body).content);
        // A never acknowledged more than one window, so it was sent exactly one window.
        const held = yield* Queue.clear(stalled);
        assert.equal(held.length, 8);
        const leaseId = held[0]?.type === "leased" ? held[0].leaseId : "";
        // What waited for A is current state, coalesced: 1,500 status-changing frames and
        // two obligations leave less than another window behind.
        let applied = held.length;
        let more = 0;
        for (let round = 0; round < 4; round++) {
          yield* service.credit({ leaseId, applied }, testClient);
          for (let spin = 0; spin < 20; spin++) yield* Effect.yieldNow;
          const sent = (yield* Queue.clear(stalled)).length;
          applied += sent;
          more += sent;
        }
        assert.isBelow(more, 8);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "S13: appends never restart a build or a reader, navigation rebases, a reader behind the ring rejoins",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const append = appender(native);
        yield* append(3);
        const lease = yield* follow(service, originalRef);
        const built = yield* lease.pass();
        const domain = built.cursor!.epoch;
        yield* lease.next("lifecycle", observing);
        const builds = () =>
          lease.seen.filter(
            (envelope) => envelope.type === "lifecycle" && envelope.state === "building",
          ).length;
        const buildsBefore = builds();
        // 600 appends overrun the 512-entry ring while this reader waits.
        const head = yield* append(600);
        const behind = yield* lease.pass(built.cursor);
        assert.deepEqual(behind.cursor!.epoch, domain);
        assert.equal(behind.entries.at(-1)?.id, head.id);
        assert.equal(new Set(behind.entries.map((item) => item.id)).size, behind.entries.length);
        assert.equal(builds(), buildsBefore);
        // A move back to an entry the branch already holds is navigation: the reader rebases.
        const target = native.entries.at(-10)!;
        // The native branch now ends at the target, as its next page will show.
        native.entries = native.entries.slice(0, native.entries.indexOf(target) + 1);
        yield* native.publish({
          type: "journal_state",
          reason: "leaf",
          sessionId: native.sessionId,
          sessionFile: native.sessionFile,
          leafId: target.id,
        });
        const rebased = yield* lease.pass(behind.cursor);
        assert.equal(rebased.cursor!.epoch.branchGeneration, domain.branchGeneration + 1);
        assert.equal(rebased.entries.at(-1)?.id, target.id);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "S14: one read per lease, stale reads refused, idle reads answer at their deadline, a cancelled lease cancels its read",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const lease = yield* follow(service, originalRef);
        // Read until nothing more changes (the first lease's own re-reads settle first).
        let cursor = (yield* lease.pass()).cursor;
        while (true) {
          const reading = yield* lease.pass(cursor).pipe(Effect.forkChild);
          yield* TestClock.adjust("20 seconds");
          const settled = yield* Fiber.join(reading);
          if (settled.unchanged) break;
          cursor = settled.cursor;
        }
        const { leaseId } = lease;
        const waiting = yield* service
          .read({ leaseId, readId: 100, cursor }, testClient)
          .pipe(Effect.forkChild);
        for (let spin = 0; spin < 10; spin++) yield* Effect.yieldNow;
        // The same or an older read id is a second read on this lease: refused.
        const repeated = yield* service
          .read({ leaseId, readId: 100, cursor }, testClient)
          .pipe(Effect.flip);
        assert.equal(repeated.code, "stale_read");
        // A newer read id is a retry: it replaces the one waiting, which ends as stale.
        const retry = yield* service
          .read({ leaseId, readId: 101, cursor }, testClient)
          .pipe(Effect.forkChild);
        const replaced = yield* Fiber.join(waiting).pipe(Effect.flip);
        assert.equal(replaced.code, "stale_read");
        yield* TestClock.adjust("20 seconds");
        assert.deepEqual(yield* Fiber.join(retry), { type: "unchanged" });
        // Essential and bulk state share one revision space: an obligation opened after the
        // read carries a revision the read could not have covered.
        yield* native.publish({ type: "tool_approval_request", id: "approval", toolName: "bash" });
        const opened = yield* lease.next(
          "obligation-opened",
          (envelope) => envelope.id === "approval",
        );
        assert.isAbove(opened.revision, cursor!.base);
        // Catch up past the obligation's revision, then leave a read waiting.
        const caughtUp = yield* service.read({ leaseId, readId: 102, cursor }, testClient);
        assert.equal(caughtUp.type, "pass");
        const pending = yield* service
          .read(
            {
              leaseId,
              readId: 103,
              cursor: caughtUp.type === "pass" ? caughtUp.continuation : cursor,
            },
            testClient,
          )
          .pipe(Effect.forkChild);
        for (let spin = 0; spin < 10; spin++) yield* Effect.yieldNow;
        yield* Fiber.interrupt(lease.fiber);
        const cancelled = yield* Fiber.join(pending).pipe(Effect.flip);
        assert.equal(cancelled.code, "lease_unknown");
        const late = yield* service.credit({ leaseId, applied: 1 }, testClient).pipe(Effect.flip);
        assert.equal(late.code, "lease_unknown");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "S15: an ended body survives delayed durability, connection loss and rebuild, then joins once; a persistence failure is a visible fault",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture("terminal");
        yield* service.open(originalRef);
        const lease = yield* follow(service, originalRef);
        const built = yield* lease.pass();
        yield* native.publish({
          type: "message_start",
          messageId: "m1",
          message: assistant("fin"),
        });
        yield* native.publish({
          type: "message_update",
          messageId: "m1",
          message: assistant("final"),
        });
        yield* native.publish({
          type: "message_end",
          messageId: "m1",
          message: assistant("final answer"),
        });
        const ended = yield* lease.pass(built.cursor);
        const body = bodyOf(ended.entities.get("message:m1"));
        assert.deepEqual(body, assistant("final answer").content);

        native.ownerAlive = false;
        yield* Deferred.succeed(native.exit!, ownerExited);
        yield* lease.next("lifecycle", (envelope) => envelope.state === "reconnecting");
        native.ownerAlive = true;
        yield* TestClock.adjust("1 second");
        yield* lease.next("lifecycle", observing);
        // The rebuild is a new domain: a full pass, which keeps the ended body as it was.
        const rebuilt = yield* lease.pass(ended.cursor);
        assert.notDeepEqual(rebuilt.cursor!.epoch, ended.cursor!.epoch);
        const kept = rebuilt.entities.get("message:m1");
        assert.equal(kept?.class === "message" && kept.phase, "ended");
        assert.deepEqual(bodyOf(kept), body);

        const committed = { ...entry("e1"), message: assistant("final answer") };
        native.entries.push(committed);
        yield* native.publish({
          type: "journal_entry",
          sessionId: native.sessionId,
          sessionFile: native.sessionFile,
          leafId: committed.id,
          entry: committed,
        });
        yield* native.publish({
          type: "message_persisted",
          sessionId: native.sessionId,
          sessionFile: native.sessionFile,
          messageId: "m1",
          entryId: committed.id,
        });
        const joined = yield* lease.pass(rebuilt.cursor);
        assert.deepEqual(
          joined.entries.map((item) => item.id),
          [committed.id],
        );
        assert.isTrue(joined.removed.has("message:m1"));

        yield* native.publish({ type: "message_end", messageId: "m2", message: assistant("kept") });
        yield* native.publish({
          type: "notice",
          level: "error",
          source: "session-persistence",
          message: "The session file could not be written.",
        });
        const failed = yield* lease.pass(joined.cursor);
        assert.equal(failed.entities.get("fault:session-persistence")?.class, "fault");
        assert.deepEqual(bodyOf(failed.entities.get("message:m2")), assistant("kept").content);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "S16: replies, leases and cursors from an earlier incarnation change nothing but their own",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture("terminal");
        yield* service.open(originalRef);
        const released = yield* Deferred.make<void>();
        let pages = 0;
        native.pageHook = Effect.suspend(() =>
          pages++ === 0 ? Deferred.await(released) : Effect.void,
        );
        const first = yield* follow(service, originalRef);
        const second = yield* follow(service, originalRef);
        // The first build's page is held across an owner succession.
        native.ownerAlive = false;
        yield* Deferred.succeed(native.exit!, ownerExited);
        yield* second.next("lifecycle", (envelope) => envelope.state === "reconnecting");
        native.ownerAlive = true;
        yield* TestClock.adjust("1 second");
        yield* second.next("lifecycle", observing);
        const current = yield* second.pass();
        // The earlier attempt's reply now arrives carrying an entry the new owner never had.
        native.entries = [entry("stale")];
        yield* Deferred.succeed(released, undefined);
        for (let spin = 0; spin < 20; spin++) yield* Effect.yieldNow;
        native.entries = [];
        const after = second.pass(current.cursor).pipe(Effect.forkChild);
        const reading = yield* after;
        yield* TestClock.adjust("20 seconds");
        assert.isFalse((yield* Fiber.join(reading)).entries.some((item) => item.id === "stale"));
        // Releasing the first lease after the succession leaves the second untouched.
        yield* Fiber.interrupt(first.fiber);
        const unknown = yield* service
          .setDemand(
            { leaseId: first.leaseId, generation: 1, demand: [{ kind: "summary" }] },
            testClient,
          )
          .pipe(Effect.flip);
        assert.equal(unknown.code, "lease_unknown");
        yield* native.publish({ type: "tool_approval_request", id: "after", toolName: "bash" });
        yield* second.next("obligation-opened", (envelope) => envelope.id === "after");
        // A cursor from another server incarnation is judged by its domain alone: a full pass.
        const foreign = yield* second.read({
          ...current.cursor!,
          epoch: { ...current.cursor!.epoch, serverIncarnation: "an-earlier-server" },
        });
        assert.equal(foreign.type === "pass" && foreign.kind, "full");
      }).pipe(Effect.scoped),
  );
});

const child = (id: string, status: string) => ({
  type: "subagent_lifecycle",
  payload: { id, runToken: `run-${id}`, status, agent: "task", agentSource: "bundled", index: 0 },
});

describe("native observation leases and demand (r12 C4)", () => {
  it.effect(
    "S7: two windows interleaving roster and child demand get the union; stale, repeated and conflicting generations never change it",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const a = yield* follow(service, originalRef);
        const b = yield* follow(service, originalRef);
        yield* a.pass();
        yield* b.pass();
        const demand = (lease: typeof a, generation: number, kinds: ReadonlyArray<string>) =>
          service.setDemand(
            {
              leaseId: lease.leaseId,
              generation,
              demand: kinds.map((kind) =>
                kind === "child"
                  ? { kind: "child" as const, childId: "c1", runToken: "run-c1" }
                  : { kind: kind as "roster" },
              ),
            },
            testClient,
          );
        const settle = () => TestClock.adjust("2 seconds");
        assert.deepEqual(yield* demand(a, 2, ["roster"]), { outcome: "applied" });
        yield* settle();
        assert.deepEqual(native.levels, ["progress"]);
        // A reordered older generation and a repeat change nothing.
        assert.deepEqual(yield* demand(a, 1, []), { outcome: "stale" });
        assert.deepEqual(yield* demand(a, 2, ["roster"]), { outcome: "unchanged" });
        const conflict = yield* demand(a, 2, ["roster", "child"]).pipe(Effect.flip);
        assert.equal(conflict.code, "demand_conflict");
        // The second window's child view raises the aggregate to every child step.
        yield* demand(b, 1, ["child"]);
        yield* settle();
        assert.deepEqual(native.levels, ["progress", "events"]);
        // The first window dropping its roster leaves the union at the second's level.
        yield* demand(a, 3, []);
        yield* settle();
        assert.deepEqual(native.levels, ["progress", "events"]);
        // The last demand going away lowers the level; nothing asks for children any more.
        yield* demand(b, 2, ["summary"]);
        yield* settle();
        assert.deepEqual(native.levels, ["progress", "events", "off"]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "with roster demand, a child that spawns, ticks and finishes after the first build reaches a reader with no client read",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const lease = yield* follow(service, originalRef);
        const built = yield* lease.pass();
        assert.isFalse([...built.entities.keys()].some((key) => key.startsWith("roster:")));
        yield* service.setDemand(
          {
            leaseId: lease.leaseId,
            generation: 1,
            demand: [{ kind: "roster" }],
          },
          testClient,
        );
        yield* TestClock.adjust("2 seconds");
        assert.deepEqual(native.levels, ["progress"]);
        yield* native.publish(child("c1", "started"));
        const spawned = yield* lease.pass(built.cursor);
        const key = [...spawned.entities.keys()].find((name) => name.startsWith("roster:"));
        assert.isDefined(key);
        yield* native.publish(child("c1", "completed"));
        const finished = yield* lease.pass(spawned.cursor);
        const value = finished.entities.get(key!);
        const lifecycle = value?.class === "roster" ? Reflect.get(value.value, "lifecycle") : null;
        assert.equal(Reflect.get(Object(lifecycle), "status"), "completed");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "S9: releasing a lease by cancel or loss returns the level, ends its reads and credit, and the inbox stops retaining",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const lease = yield* follow(service, originalRef);
        yield* lease.pass();
        yield* service.setDemand(
          {
            leaseId: lease.leaseId,
            generation: 1,
            demand: [{ kind: "roster" }],
          },
          testClient,
        );
        yield* TestClock.adjust("2 seconds");
        assert.deepEqual(native.levels, ["progress"]);
        yield* Fiber.interrupt(lease.fiber);
        yield* TestClock.adjust("2 seconds");
        assert.deepEqual(native.levels, ["progress", "off"]);
        const gone = yield* service
          .read({ leaseId: lease.leaseId, readId: 99, cursor: null }, testClient)
          .pipe(Effect.flip);
        assert.equal(gone.code, "lease_unknown");
        // While no lease is held, live-only records are not kept: a returning viewer is
        // told they were not observed, never given silence (decision 8 amendment).
        yield* native.publish({
          type: "tool_stream_update",
          toolCallId: "t1",
          toolName: "bash",
          update: { chunk: 1 },
        });
        yield* native.publish({ type: "notice", level: "info", message: "unseen" });
        const returning = yield* follow(service, originalRef);
        const { inbox } = yield* returning.pass();
        assert.deepEqual(
          inbox.map((record) => record.type === "gap" && record.reason),
          ["not-observed"],
        );
        // A record every live lease has passed is not served to a later reader (8 (b)).
        const inboxCursor = (yield* returning.pass()).cursor;
        yield* native.publish({ type: "notice", level: "info", message: "seen by the first" });
        const first = yield* returning.pass(inboxCursor);
        const noticeOf = (records: ReadonlyArray<NeoPiNativeInboxRecord>) =>
          records.filter((record) => record.type === "notice").map((record) => record.message);
        assert.deepEqual(noticeOf(first.inbox), ["seen by the first"]);
        // Its next read acknowledges that; the only live lease has now passed the record.
        const acknowledging = yield* returning.pass(first.cursor).pipe(Effect.forkChild);
        yield* TestClock.adjust("20 seconds");
        yield* Fiber.join(acknowledging);
        const later = yield* follow(service, originalRef);
        assert.deepEqual(noticeOf((yield* later.pass()).inbox), []);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "S9/S16: a successor adoption keeps the lease and applies the aggregate demand to the new connection",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture("terminal");
        yield* service.open(originalRef);
        const lease = yield* follow(service, originalRef);
        yield* lease.next("lifecycle", observing);
        yield* service.setDemand(
          {
            leaseId: lease.leaseId,
            generation: 1,
            demand: [{ kind: "roster" }],
          },
          testClient,
        );
        yield* TestClock.adjust("2 seconds");
        assert.deepEqual(native.levels, ["progress"]);
        native.ownerAlive = false;
        yield* Deferred.succeed(native.exit!, ownerExited);
        yield* lease.next("lifecycle", (envelope) => envelope.state === "reconnecting");
        native.ownerAlive = true;
        yield* TestClock.adjust("1 second");
        yield* lease.next("lifecycle", observing);
        yield* TestClock.adjust("2 seconds");
        // The new connection starts at `off`; the same lease's demand reaches it.
        assert.deepEqual(native.levels, ["progress", "progress"]);
        const same = yield* service.setDemand(
          {
            leaseId: lease.leaseId,
            generation: 1,
            demand: [{ kind: "roster" }],
          },
          testClient,
        );
        assert.deepEqual(same, { outcome: "unchanged" });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a client's snapshot_session_journal never races a build: the build is the only sender",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        native.snapshotHook = Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const lease = yield* follow(service, originalRef);
        yield* Deferred.await(reached);
        const refused = yield* service
          .request({ ref: originalRef, command: { type: "snapshot_session_journal" } })
          .pipe(Effect.result);
        assert.equal(
          refused._tag === "Failure" ? refused.failure.code : undefined,
          "observation_server_owned",
        );
        const level = yield* service
          .request({
            ref: originalRef,
            command: { type: "set_subagent_subscription", level: "events" },
          })
          .pipe(Effect.result);
        assert.equal(
          level._tag === "Failure" ? level.failure.code : undefined,
          "observation_server_owned",
        );
        native.snapshotHook = Effect.void;
        yield* Deferred.succeed(release, undefined);
        yield* lease.pass();
        assert.equal(native.snapshots, 1);
        assert.deepEqual(native.levels, []);
      }).pipe(Effect.scoped),
  );
});

describe("a refused subagent level (decision 11 follow-up)", () => {
  it.effect("is a fault a reader sees; a later success, or withdrawing the demand, clears it", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      yield* service.open({ ...originalRef });
      native.refuseLevels = true;
      const lease = yield* follow(service, originalRef);
      let { cursor } = yield* lease.pass();
      const ask = (generation: number, kinds: ReadonlyArray<"roster" | "summary">) =>
        service.setDemand(
          {
            leaseId: lease.leaseId,
            generation,
            demand: kinds.map((kind) => ({ kind })),
          },
          testClient,
        );
      const fault = () =>
        Effect.gen(function* () {
          // A read with nothing new waits for its deadline, which the test clock supplies.
          const reading = yield* lease.pass(cursor).pipe(Effect.forkChild);
          yield* TestClock.adjust("20 seconds");
          const read = yield* Fiber.join(reading);
          cursor = read.cursor;
          return read;
        });
      yield* ask(1, ["roster"]);
      yield* TestClock.adjust("2 seconds");
      const refused = (yield* fault()).entities.get("fault:subagent-subscription");
      assert.deepEqual(refused, {
        class: "fault",
        value: {
          source: "subagent-subscription",
          level: "error",
          requestedLevel: "progress",
          message: "Subagent event bus is unavailable",
        },
      });
      // No retry loop: the owner was asked once.
      yield* TestClock.adjust("1 minute");
      assert.deepEqual(native.levels, []);
      // The demand going away clears it.
      yield* ask(2, ["summary"]);
      yield* TestClock.adjust("2 seconds");
      assert.isTrue((yield* fault()).removed.has("fault:subagent-subscription"));
      // A later attempt that succeeds leaves no fault.
      native.refuseLevels = false;
      yield* ask(3, ["roster"]);
      yield* TestClock.adjust("2 seconds");
      assert.deepEqual(native.levels, ["progress"]);
      assert.isFalse((yield* fault()).entities.has("fault:subagent-subscription"));
    }).pipe(Effect.scoped),
  );
});

/** A watch that takes envelopes but returns credit only when told to. */
const manualWatch = Effect.fnUntraced(function* (
  service: Service,
  ref: NeoPiNativeSessionRef,
  client: string = testClient,
) {
  const received = yield* Queue.unbounded<Envelope>();
  const fiber = yield* service.watch({ ref }, client).pipe(
    Stream.runForEach((envelope) => Queue.offer(received, envelope)),
    Effect.forkScoped,
  );
  const settle = Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, {
    discard: true,
  });
  const take = Effect.gen(function* () {
    yield* settle;
    return yield* Queue.clear(received);
  });
  return { fiber, received, take, settle };
});
const leaseOf = (envelopes: ReadonlyArray<Envelope>) => {
  const first = envelopes[0];
  return first?.type === "leased" ? first.leaseId : "";
};
const openObligations = (
  native: { publish: (frame: SessionEventFrame) => Effect.Effect<void> },
  count: number,
) =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    (index) => native.publish({ type: "host_tool_call", id: `call-${index}`, toolName: "preview" }),
    { discard: true },
  );

describe("server wiring review round", () => {
  it.effect(
    "a cursor from another projection (closed and reopened file) rebases instead of continuing",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const first = yield* follow(service, originalRef);
        const held = yield* first.pass();
        yield* service.close({ ref: originalRef });
        native.connections = 0;
        yield* service.open({ ...originalRef });
        const second = yield* follow(service, originalRef);
        const reply = yield* second.read(held.cursor);
        assert.equal(reply.type, "pass");
        if (reply.type !== "pass") return;
        assert.equal(reply.kind, "full");
        assert.notEqual(
          reply.baseCursor.epoch.serverIncarnation,
          held.cursor!.epoch.serverIncarnation,
        );
      }).pipe(Effect.scoped),
  );

  it.effect("read, setDemand and credit refuse a lease that belongs to another connection", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture();
      yield* service.open({ ...originalRef });
      const lease = yield* follow(service, originalRef, "client-a");
      const built = yield* lease.pass();
      const stranger = "client-b";
      const read = yield* service
        .read({ leaseId: lease.leaseId, readId: 50, cursor: built.cursor }, stranger)
        .pipe(Effect.flip);
      const demand = yield* service
        .setDemand(
          { leaseId: lease.leaseId, generation: 1, demand: [{ kind: "roster" }] },
          stranger,
        )
        .pipe(Effect.flip);
      const credit = yield* service
        .credit({ leaseId: lease.leaseId, applied: 1 }, stranger)
        .pipe(Effect.flip);
      assert.deepEqual(
        [read.code, demand.code, credit.code],
        ["lease_unknown", "lease_unknown", "lease_unknown"],
      );
      // The owner's own calls still work, and the stranger changed nothing on the lease.
      assert.deepEqual(
        yield* service.setDemand(
          { leaseId: lease.leaseId, generation: 1, demand: [{ kind: "summary" }] },
          "client-a",
        ),
        { outcome: "applied" },
      );
    }).pipe(Effect.scoped),
  );

  it.effect("credit is cumulative: excess and repeated values grant nothing", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      yield* service.open({ ...originalRef });
      const watch = yield* manualWatch(service, originalRef);
      yield* openObligations(native, 20);
      const window = yield* watch.take;
      assert.equal(window.length, 8);
      const leaseId = leaseOf(window);
      // More than was sent, repeated: nothing arrives, however often it is said.
      for (let attempt = 0; attempt < 3; attempt++) {
        yield* service.credit({ leaseId, applied: 1000 }, testClient);
        assert.deepEqual(yield* watch.take, []);
      }
      // The true count releases exactly one window's worth; repeating it releases no more.
      yield* service.credit({ leaseId, applied: 8 }, testClient);
      assert.equal((yield* watch.take).length, 8);
      yield* service.credit({ leaseId, applied: 8 }, testClient);
      assert.deepEqual(yield* watch.take, []);
    }).pipe(Effect.scoped),
  );

  it.effect("ending a session reaches a lease that returns no credit, and releases it", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      yield* service.open({ ...originalRef });
      const watch = yield* manualWatch(service, originalRef);
      yield* openObligations(native, 20);
      const window = yield* watch.take;
      assert.equal(window.length, 8);
      yield* service.close({ ref: originalRef });
      const terminal = yield* watch.take;
      assert.deepEqual(
        terminal.map((envelope) => envelope.type === "lifecycle" && envelope.state),
        ["detached"],
      );
      yield* Fiber.join(watch.fiber);
      const gone = yield* service
        .read({ leaseId: leaseOf(window), readId: 0, cursor: null }, testClient)
        .pipe(Effect.flip);
      assert.equal(gone.code, "lease_unknown");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a lease that returns no credit while obligations pile up is ended to reattach, never grown without bound",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const healthy = yield* follow(service, originalRef);
        const stalled = yield* manualWatch(service, originalRef);
        const leaseId = leaseOf(yield* stalled.take);
        yield* openObligations(native, 600);
        const ended = yield* Fiber.await(stalled.fiber);
        assert.equal(ended._tag, "Failure");
        const failure = Exit.isFailure(ended) ? Cause.squash(ended.cause) : undefined;
        assert.equal(Reflect.get(Object(failure), "code"), "lease_unknown");
        const gone = yield* service
          .read({ leaseId, readId: 0, cursor: null }, testClient)
          .pipe(Effect.result);
        assert.equal(gone._tag === "Failure" ? gone.failure.code : undefined, "lease_unknown");
        // The viewer that keeps up loses nothing, and a fresh lease lists every open one.
        yield* stalled.settle;
        assert.equal(
          healthy.seen.filter((envelope) => envelope.type === "obligation-opened").length,
          600,
        );
        // The join lists all 600 at once; that is not growth, so the fresh lease is not ended.
        const again = yield* follow(service, originalRef);
        yield* again.next("obligation-opened", (envelope) => envelope.id === "call-599");
        yield* native.publish({ type: "host_tool_call", id: "after", toolName: "preview" });
        yield* again.next("obligation-opened", (envelope) => envelope.id === "after");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a new lease receives every open obligation before its first lifecycle, across several credit grants",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        // Built and observed already, so the joining lease's own lifecycle is its only one.
        const built = yield* follow(service, originalRef);
        yield* built.next("lifecycle", observing);
        yield* openObligations(native, 20);
        const lease = yield* follow(service, originalRef);
        yield* lease.next("lifecycle", observing);
        const first = lease.seen.findIndex((envelope) => envelope.type === "lifecycle");
        const replayed = lease.seen.flatMap((envelope, index) =>
          envelope.type === "obligation-opened" ? [index] : [],
        );
        assert.equal(replayed.length, 20);
        assert.isTrue(replayed.every((index) => index < first));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a lease whose stream is stuck does not hold a closed session beyond the grace period",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const watch = yield* manualWatch(service, originalRef);
        yield* openObligations(native, 20);
        const leaseId = leaseOf(yield* watch.take);
        yield* service.close({ ref: originalRef });
        yield* TestClock.adjust("10 seconds");
        const gone = yield* service
          .setDemand({ leaseId, generation: 1, demand: [] }, testClient)
          .pipe(Effect.flip);
        assert.equal(gone.code, "lease_unknown");
      }).pipe(Effect.scoped),
  );

  it.effect("a read woken by a change that lands between its scan and its wait still answers", () =>
    Effect.gen(function* () {
      const { native, dependencies } = yield* fixture();
      let slip = false;
      const service = yield* makeNeoPiNativeSessionsWith({
        ...dependencies,
        afterReadScan: Effect.suspend(() =>
          slip
            ? Effect.void
            : Effect.sync(() => {
                slip = true;
              }).pipe(
                Effect.andThen(
                  native.publish({ type: "notice", level: "info", message: "slipped in" }),
                ),
              ),
        ),
      });
      yield* service.open({ ...originalRef });
      const lease = yield* follow(service, originalRef);
      const built = yield* lease.pass();
      slip = false;
      // The test clock never advances: only the change can end this read.
      const reading = yield* lease.pass(built.cursor).pipe(Effect.forkChild);
      yield* Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true });
      assert.isTrue(reading.pollUnsafe() !== undefined);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a build waiting on a stale page is abandoned when the branch navigates, and a new one starts",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const held = yield* Deferred.make<void>();
        let first = true;
        native.pageHook = Effect.suspend(() => {
          if (!first) return Effect.void;
          first = false;
          return Deferred.await(held);
        });
        yield* follow(service, originalRef);
        const spin = Effect.forEach(Array.from({ length: 40 }), () => Effect.yieldNow, {
          discard: true,
        });
        yield* spin;
        assert.equal(native.snapshots, 1);
        const frame = (entry: NeoPiJournalEntry) =>
          native.publish({
            type: "journal_entry",
            sessionId: native.sessionId,
            sessionFile: native.sessionFile,
            leafId: entry.id,
            entry,
          });
        yield* frame(entry("a"));
        yield* frame(entry("elsewhere", "not-the-head"));
        yield* spin;
        // The held page is still outstanding, yet a fresh attempt has already started.
        assert.equal(native.snapshots, 2);
        yield* Deferred.succeed(held, undefined);
      }).pipe(Effect.scoped),
  );

  it.effect("a build stops retrying once the last lease has gone", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      yield* service.open({ ...originalRef });
      native.pageHook = Effect.sync(() => {}).pipe(
        Effect.andThen(Effect.fail(new NeoPiRpcError({ message: "page unavailable" }))),
      );
      const lease = yield* follow(service, originalRef);
      yield* TestClock.adjust("3 seconds");
      assert.isAbove(native.pages, 1);
      yield* Fiber.interrupt(lease.fiber);
      yield* TestClock.adjust("1 second");
      const after = native.pages;
      yield* TestClock.adjust("1 minute");
      assert.equal(native.pages, after);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a lease that never reads pins the inbox; a forged acknowledgement prunes nothing unseen",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const idle = yield* follow(service, originalRef);
        const reader = yield* follow(service, originalRef);
        const readerBuilt = yield* reader.pass();
        yield* native.publish({
          type: "notice",
          level: "info",
          message: "kept for the idle lease",
        });
        const got = yield* reader.pass(readerBuilt.cursor);
        assert.deepEqual(
          got.inbox.map((record) => record.type === "notice" && record.message),
          ["kept for the idle lease"],
        );
        // The reader acknowledges what it holds; the idle lease has acknowledged nothing.
        const ack = yield* reader.pass(got.cursor).pipe(Effect.forkChild);
        yield* TestClock.adjust("20 seconds");
        yield* Fiber.join(ack);
        // A forged position beyond anything sent cannot move pruning past what was delivered.
        const forging = yield* idle
          .read({ ...readerBuilt.cursor!, inboxSeq: 1_000_000 })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("20 seconds");
        yield* Fiber.join(forging);
        const late = yield* follow(service, originalRef);
        const fresh = yield* late.pass();
        assert.deepEqual(
          fresh.inbox.map((record) => record.type === "notice" && record.message),
          ["kept for the idle lease"],
        );
      }).pipe(Effect.scoped),
  );

  it.effect("a stale idle state reply cannot overwrite a turn that started meanwhile", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      yield* service.open({ ...originalRef });
      const lease = yield* follow(service, originalRef);
      yield* lease.pass();
      const held = yield* Deferred.make<void>();
      native.stateHook = Deferred.await(held);
      yield* native.publish({ type: "agent_end" });
      const refreshing = yield* Effect.forkChild(
        Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, { discard: true }),
      );
      yield* Fiber.join(refreshing);
      native.stateHook = Effect.void;
      yield* native.publish({ type: "agent_start" });
      yield* Deferred.succeed(held, undefined);
      yield* Effect.forEach(Array.from({ length: 60 }), () => Effect.yieldNow, { discard: true });
      const statuses = lease.seen.filter((envelope) => envelope.type === "status");
      const last = statuses.at(-1);
      assert.equal(last?.type === "status" && last.live.isStreaming, true);
    }).pipe(Effect.scoped),
  );

  it.effect("reports an open run waiting for async work until its terminal end", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      yield* service.open(originalRef);
      const lease = yield* follow(service, originalRef);
      yield* lease.pass();
      yield* native.publish({ type: "agent_start" });
      yield* lease.next("status", (status) => status.live.isStreaming);
      yield* native.publish({
        type: "agent_end",
        isTerminal: false,
        yielded: true,
        awaitingAsyncWork: true,
      });
      const paused = yield* lease.next("status", (status) => !status.live.isStreaming);
      assert.include(paused.live, { state: "busy", runPause: "async-work" });

      yield* native.publish({ type: "agent_end", isTerminal: true });
      const settled = yield* lease.next("status", (status) => status.live.state === "idle");
      assert.isUndefined(settled.live.runPause);
    }).pipe(Effect.scoped),
  );

  it.effect("a profile invalidation fails the watch with profile_changed, not owner-stopped", () =>
    Effect.gen(function* () {
      const { native, service, profileChanges } = yield* fixture("terminal");
      yield* service.open(originalRef);
      const lease = yield* follow(service, originalRef);
      yield* lease.next("lifecycle", observing);
      native.profileValid = false;
      yield* Queue.offer(profileChanges, undefined);
      const exit = yield* Fiber.await(lease.fiber);
      assert.isTrue(Exit.isFailure(exit));
      assert.isFalse(
        lease.seen.some(
          (envelope) => envelope.type === "lifecycle" && envelope.state === "owner-stopped",
        ),
      );
      if (Exit.isFailure(exit))
        assert.match(String(exit.cause), /profile_changed|Profile replaced/);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "bulk frames are not folded with no lease; the first lease rebuilds only if some were skipped",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const first = yield* follow(service, originalRef);
        yield* first.pass();
        yield* Fiber.interrupt(first.fiber);
        assert.equal(native.snapshots, 1);
        // Only identity and interactions arrived: nothing bulk went unread.
        const quiet = yield* follow(service, originalRef);
        yield* quiet.pass();
        assert.equal(native.snapshots, 1);
        yield* Fiber.interrupt(quiet.fiber);
        yield* native.publish({
          type: "message_update",
          messageId: "m",
          message: assistant("unseen"),
        });
        const returning = yield* follow(service, originalRef);
        const view = yield* returning.pass();
        assert.equal(native.snapshots, 2);
        assert.isFalse(view.entities.has("message:m"));
      }).pipe(Effect.scoped),
  );

  it.effect("a reader the journal ring overran makes the server fetch a fresh native page", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      yield* service.open({ ...originalRef });
      const append = appender(native);
      yield* append(3);
      const lease = yield* follow(service, originalRef);
      const built = yield* lease.pass();
      const pagesBefore = native.pages;
      yield* append(600);
      yield* lease.pass(built.cursor);
      yield* TestClock.adjust("2 seconds");
      assert.isAbove(native.pages, pagesBefore);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a stale demand reply from a replaced connection settles nothing for its successor",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture("terminal");
        yield* service.open(originalRef);
        const lease = yield* follow(service, originalRef);
        yield* lease.next("lifecycle", observing);
        const held = yield* Deferred.make<void>();
        native.levelHook = Deferred.await(held);
        yield* service.setDemand(
          { leaseId: lease.leaseId, generation: 1, demand: [{ kind: "roster" }] },
          testClient,
        );
        yield* Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });
        native.ownerAlive = false;
        yield* Deferred.succeed(native.exit!, ownerExited);
        yield* lease.next("lifecycle", (envelope) => envelope.state === "reconnecting");
        native.ownerAlive = true;
        native.levelHook = Effect.void;
        yield* TestClock.adjust("1 second");
        yield* lease.next("lifecycle", observing);
        yield* Deferred.succeed(held, undefined);
        yield* TestClock.adjust("2 seconds");
        // The old connection's reply arrived after the succession; the new connection was
        // still asked for the demand, so the owner now holds it.
        assert.deepEqual(native.levels, ["progress", "progress"]);
      }).pipe(Effect.scoped),
  );

  it.effect("a successor that fails validation never shows its frames to the leases", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture("terminal");
      yield* service.open(originalRef);
      const lease = yield* follow(service, originalRef);
      yield* lease.next("lifecycle", observing);
      native.ownerAlive = false;
      yield* Deferred.succeed(native.exit!, ownerExited);
      yield* lease.next("lifecycle", (envelope) => envelope.state === "reconnecting");
      // The candidate opens a dialog while connecting, then turns out to be another file.
      native.ownerAlive = true;
      native.startupDialog = true;
      native.mismatch = true;
      yield* TestClock.adjust("3 seconds");
      assert.isFalse(lease.seen.some((envelope) => envelope.type === "obligation-opened"));
      // A valid successor's frames reach the leases once it is accepted.
      native.mismatch = false;
      yield* TestClock.adjust("2 seconds");
      const opened = yield* lease.next(
        "obligation-opened",
        (envelope) => envelope.id === "native-dialog",
      );
      assert.equal(opened.id, "native-dialog");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a live owner that cannot be attached is incompatible or unresolved, never owner-stopped",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture("terminal");
        yield* service.open(originalRef);
        const lease = yield* follow(service, originalRef);
        yield* lease.next("lifecycle", observing);
        native.attachError = new NeoPiNativeSessionsError({
          code: "transient",
          message: "no answer",
        });
        native.ownerAlive = false;
        yield* Deferred.succeed(native.exit!, ownerExited);
        yield* lease.next("lifecycle", (envelope) => envelope.state === "reconnecting");
        yield* TestClock.adjust("12 seconds");
        yield* lease.next("lifecycle", (envelope) => envelope.state === "authority-unresolved");
        assert.isFalse(
          lease.seen.some(
            (envelope) => envelope.type === "lifecycle" && envelope.state === "owner-stopped",
          ),
        );
        // Attach is retried, and the same lease follows the owner when it answers.
        native.attachError = undefined;
        native.ownerAlive = true;
        yield* TestClock.adjust("6 seconds");
        yield* lease.next("lifecycle", observing);
      }).pipe(Effect.scoped),
  );

  it.effect("an owner outdated throughout the grace period ends the lease as incompatible", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture("terminal");
      yield* service.open(originalRef);
      const lease = yield* follow(service, originalRef);
      yield* lease.next("lifecycle", observing);
      native.attachError = new NeoPiNativeSessionsError({
        code: "owner_outdated",
        message: "update the terminal's NeoPi",
      });
      native.ownerAlive = false;
      yield* Deferred.succeed(native.exit!, ownerExited);
      yield* lease.next("lifecycle", (envelope) => envelope.state === "reconnecting");
      yield* TestClock.adjust("12 seconds");
      yield* lease.next("lifecycle", (envelope) => envelope.state === "incompatible");
      yield* Fiber.join(lease.fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("a discovery cancelled while its candidate connects closes that candidate", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture("terminal");
      const reached = yield* Deferred.make<void>();
      native.connectHook = Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never));
      const lease = yield* follow(service, originalRef);
      yield* Deferred.await(reached);
      assert.equal(native.connections, 1);
      yield* Fiber.interrupt(lease.fiber);
      yield* Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, { discard: true });
      assert.equal(native.connections, 0);
      assert.equal(native.detaches, 1);
      // Nothing was installed: a fresh lease discovers again.
      native.connectHook = Effect.void;
      const again = yield* follow(service, originalRef);
      yield* again.next("lifecycle", observing);
      assert.equal(native.connections, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("discovery keeps retrying attach while the authority is unresolved, then joins", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture("terminal");
      native.connectError = new NeoPiNativeSessionsError({ code: "transient", message: "busy" });
      const lease = yield* follow(service, originalRef);
      yield* lease.next("lifecycle", (envelope) => envelope.state === "authority-unresolved");
      assert.equal(native.starts, 0);
      native.connectError = undefined;
      yield* TestClock.adjust("3 seconds");
      yield* lease.next("lifecycle", observing);
      assert.equal(native.starts, 1);
    }).pipe(Effect.scoped),
  );
});

describe("leaf announcements (the live stall)", () => {
  const frames = (native: { sessionId: string; sessionFile: string }, leafId: string) => ({
    leaf: {
      type: "journal_state",
      reason: "leaf",
      sessionId: native.sessionId,
      sessionFile: native.sessionFile,
      leafId,
    },
    entry: (item: NeoPiJournalEntry) => ({
      type: "journal_entry",
      sessionId: native.sessionId,
      sessionFile: native.sessionFile,
      leafId,
      entry: item,
    }),
    persisted: (messageId: string, entryId: string) => ({
      type: "message_persisted",
      sessionId: native.sessionId,
      sessionFile: native.sessionFile,
      messageId,
      entryId,
    }),
  });

  it.effect(
    "a flush of several entries under one leaf announcement is not a navigation, even with a read in the middle",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const lease = yield* follow(service, originalRef);
        const built = yield* lease.pass();
        const domain = built.cursor!.epoch;
        const snapshots = native.snapshots;
        const e1 = entry("flush-1");
        const e2 = entry("flush-2", e1.id);
        const last = entry("flush-3", e2.id);
        const f = frames(native, last.id);
        // NeoPi's order: the leaf is the LAST entry, then each entry and its persisted event.
        yield* native.publish(f.leaf);
        yield* native.publish(f.entry(e1));
        yield* native.publish(f.persisted("m1", e1.id));
        const middle = yield* lease.pass(built.cursor).pipe(Effect.forkChild);
        yield* Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });
        yield* native.publish(f.entry(e2));
        yield* native.publish(f.persisted("m2", e2.id));
        yield* native.publish(f.entry(last));
        const read = yield* Fiber.join(middle);
        assert.deepEqual(read.cursor!.epoch.branchGeneration, domain.branchGeneration);
        assert.equal(native.snapshots, snapshots);
        const after = yield* lease.pass(read.cursor);
        assert.equal(after.cursor!.epoch.branchGeneration, domain.branchGeneration);
        assert.deepEqual(
          [...read.entries, ...after.entries].map((item) => item.id),
          [e1.id, e2.id, last.id],
        );
      }).pipe(Effect.scoped),
  );

  const settle = Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, {
    discard: true,
  });
  const idsOf = (entries: ReadonlyArray<{ readonly id: string }>) => entries.map((item) => item.id);

  it.effect("a leaf resolved in time leaves no timer behind to settle the next one", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      yield* service.open({ ...originalRef });
      const lease = yield* follow(service, originalRef);
      const built = yield* lease.pass();
      const pages = native.pages;
      const a1 = entry("a1");
      const a2 = entry("a2", a1.id);
      const fa = frames(native, a2.id);
      yield* native.publish(fa.leaf);
      yield* native.publish(fa.entry(a1));
      yield* native.publish(fa.entry(a2));
      // Leaf B is announced just before leaf A's deadline would have fired.
      yield* TestClock.adjust("1900 millis");
      const b1 = entry("b1", a2.id);
      const b2 = entry("b2", b1.id);
      const fb = frames(native, b2.id);
      yield* native.publish(fb.leaf);
      yield* TestClock.adjust("300 millis");
      yield* native.publish(fb.entry(b1));
      yield* native.publish(fb.entry(b2));
      yield* settle;
      const read = yield* lease.pass(built.cursor);
      assert.equal(read.cursor!.epoch.branchGeneration, built.cursor!.epoch.branchGeneration);
      assert.deepEqual(idsOf(read.entries), ["a1", "a2", "b1", "b2"]);
      assert.equal(native.pages, pages);
    }).pipe(Effect.scoped),
  );

  it.effect("entries that are only late are appended, not a navigation, and never twice", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      yield* service.open({ ...originalRef });
      const lease = yield* follow(service, originalRef);
      const built = yield* lease.pass();
      const e1 = entry("late-1");
      const e2 = entry("late-2", e1.id);
      const f = frames(native, e2.id);
      // The owner has committed both; its frames are slow.
      native.entries.push(e1, e2);
      yield* native.publish(f.leaf);
      yield* TestClock.adjust("3 seconds");
      yield* settle;
      // The answer fetched from the owner extended the held head: appended, no fence.
      const read = yield* lease.pass(built.cursor);
      assert.equal(read.cursor!.epoch.branchGeneration, built.cursor!.epoch.branchGeneration);
      assert.deepEqual(idsOf(read.entries), ["late-1", "late-2"]);
      // The late frames now arrive live: nothing is applied twice.
      yield* native.publish(f.entry(e1));
      yield* native.publish(f.entry(e2));
      const after = yield* lease.pass(read.cursor).pipe(Effect.forkChild);
      yield* TestClock.adjust("20 seconds");
      const rest = yield* Fiber.join(after);
      assert.deepEqual(idsOf(rest.entries), []);
      assert.equal(rest.cursor!.epoch.branchGeneration, built.cursor!.epoch.branchGeneration);
    }).pipe(Effect.scoped),
  );

  it.effect("a quiet move to a leaf outside the held tail is detected and history rebased", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      yield* service.open({ ...originalRef });
      const append = appender(native);
      yield* append(3);
      const lease = yield* follow(service, originalRef);
      const built = yield* lease.pass();
      // The owner moves to another branch whose entries the tail never held.
      const other = entry("other-root");
      const leaf = entry("other-leaf", other.id);
      native.entries = [other, leaf];
      yield* native.publish(frames(native, leaf.id).leaf);
      yield* TestClock.adjust("3 seconds");
      yield* settle;
      const read = yield* lease.pass(built.cursor);
      assert.equal(read.cursor!.epoch.branchGeneration, built.cursor!.epoch.branchGeneration + 1);
      assert.equal(read.entries.at(-1)?.id, "other-leaf");
    }).pipe(Effect.scoped),
  );

  it.effect("a failed fetch is retried with backoff and the view keeps its branch meanwhile", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      yield* service.open({ ...originalRef });
      const lease = yield* follow(service, originalRef);
      const built = yield* lease.pass();
      const e1 = entry("slow-1");
      native.entries.push(e1);
      native.pageHook = Effect.fail(new NeoPiRpcError({ message: "page unavailable" }));
      yield* native.publish(frames(native, e1.id).leaf);
      yield* TestClock.adjust("8 seconds");
      yield* settle;
      assert.isAbove(native.pages, 2);
      // Nothing false was said: still the same branch, nothing rebased.
      const quiet = yield* lease.pass(built.cursor).pipe(Effect.forkChild);
      yield* TestClock.adjust("20 seconds");
      const unchanged = yield* Fiber.join(quiet);
      assert.equal(unchanged.cursor!.epoch.branchGeneration, built.cursor!.epoch.branchGeneration);
      native.pageHook = Effect.void;
      yield* TestClock.adjust("6 seconds");
      yield* settle;
      const read = yield* lease.pass(unchanged.cursor);
      assert.deepEqual(idsOf(read.entries), ["slow-1"]);
      assert.equal(read.cursor!.epoch.branchGeneration, built.cursor!.epoch.branchGeneration);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "an entry folded live while the quiet-leaf fetch is in flight is kept once, with no navigation",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const head = yield* appender(native)(1);
        const lease = yield* follow(service, originalRef);
        const built = yield* lease.pass();
        const pages = native.pages;
        const x = entry("live-x", head.id);
        const a = entry("pending-a", x.id);
        const f = frames(native, a.id);
        // A flush announces its last entry A; nothing follows within the pause.
        yield* native.publish(f.leaf);
        // The owner's page still ends at the held head when it is read; X, extending
        // that head, folds live after the page exists and before it is applied.
        let first = true;
        native.afterPageHook = Effect.suspend(() => {
          if (!first) return Effect.void;
          first = false;
          return native.publish(f.entry(x));
        });
        yield* TestClock.adjust("2 seconds");
        yield* settle;
        assert.equal(native.pages, pages + 1);
        const read = yield* lease.pass(built.cursor);
        assert.equal(read.cursor!.epoch.branchGeneration, built.cursor!.epoch.branchGeneration);
        assert.deepEqual(idsOf(read.entries), ["live-x"]);
        // The rest of the flush arrives: A joins once, on the same branch.
        native.entries.push(x, a);
        yield* native.publish(f.entry(a));
        yield* settle;
        const rest = yield* lease.pass(read.cursor);
        assert.equal(rest.cursor!.epoch.branchGeneration, built.cursor!.epoch.branchGeneration);
        assert.deepEqual(idsOf(rest.entries), ["pending-a"]);
      }).pipe(Effect.scoped),
  );
});

describe("confirmation round", () => {
  const settle = Effect.forEach(Array.from({ length: 400 }), () => Effect.yieldNow, {
    discard: true,
  });

  it.effect(
    "hide and show: an assistant message that ended unseen is not served as its old prefix",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const first = yield* follow(service, originalRef);
        const built = yield* first.pass();
        yield* native.publish({ type: "message_start", messageId: "m", message: assistant("pre") });
        yield* native.publish({
          type: "message_update",
          messageId: "m",
          message: assistant("prefix"),
        });
        const seen = yield* first.pass(built.cursor);
        assert.deepEqual(bodyOf(seen.entities.get("message:m")), assistant("prefix").content);
        yield* Fiber.interrupt(first.fiber);
        yield* settle;
        // Nobody is watching: the message goes on, ends, and the turn is over.
        yield* native.publish({
          type: "message_update",
          messageId: "m",
          message: assistant("prefix and more"),
        });
        yield* native.publish({
          type: "message_end",
          messageId: "m",
          message: assistant("prefix and more, done"),
        });
        yield* native.publish({ type: "agent_end" });
        const second = yield* follow(service, originalRef);
        const view = yield* second.pass();
        // The old prefix is never served: the body is gone or current, never stale.
        const held = bodyOf(view.entities.get("message:m"));
        const last: unknown = Array.isArray(held) ? held.at(-1) : undefined;
        assert.isTrue(
          held === undefined || String(Reflect.get(Object(last), "text")).includes("done"),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("hide and show: a message still streaming is served with its current body", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      yield* service.open({ ...originalRef });
      const first = yield* follow(service, originalRef);
      const built = yield* first.pass();
      yield* native.publish({ type: "message_start", messageId: "m", message: assistant("pre") });
      yield* first.pass(built.cursor);
      yield* Fiber.interrupt(first.fiber);
      yield* settle;
      yield* native.publish({
        type: "message_update",
        messageId: "m",
        message: assistant("longer by now"),
      });
      // The owner's snapshot carries the message as it is now.
      native.snapshotHook = native.publish({
        type: "message_start",
        messageId: "m",
        snapshot: true,
        message: assistant("longer by now"),
      });
      const second = yield* follow(service, originalRef);
      const view = yield* second.pass();
      assert.deepEqual(bodyOf(view.entities.get("message:m")), assistant("longer by now").content);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a read scanned before its lease attached still answers when the session publishes first",
    () =>
      Effect.gen(function* () {
        const { native, dependencies } = yield* fixture("terminal");
        const gate = yield* Deferred.make<void>();
        native.connectHook = Deferred.await(gate);
        let first = true;
        const service = yield* makeNeoPiNativeSessionsWith({
          ...dependencies,
          afterReadScan: Effect.suspend(() => {
            if (!first) return Effect.void;
            first = false;
            // Attachment and publication happen after the scan and before the wait.
            return Deferred.succeed(gate, undefined).pipe(Effect.andThen(settle));
          }),
        });
        const lease = yield* follow(service, originalRef);
        const reading = yield* lease.read(null).pipe(Effect.forkChild);
        yield* settle;
        yield* settle;
        assert.isTrue(reading.pollUnsafe() !== undefined);
      }).pipe(Effect.scoped),
  );

  it.effect("a newer read is not displaced by an older one resuming after its scan", () =>
    Effect.gen(function* () {
      const { native, dependencies } = yield* fixture();
      const hold = yield* Deferred.make<void>();
      // Only the two reads under test are held or counted; the build's own read is not.
      let calls = -1;
      const service = yield* makeNeoPiNativeSessionsWith({
        ...dependencies,
        afterReadScan: Effect.suspend(() =>
          calls < 0 || calls++ > 0 ? Effect.void : Deferred.await(hold),
        ),
      });
      yield* service.open({ ...originalRef });
      const lease = yield* follow(service, originalRef);
      const built = yield* lease.pass();
      calls = 0;
      const older = yield* service
        .read({ leaseId: lease.leaseId, readId: 900, cursor: built.cursor }, testClient)
        .pipe(Effect.exit, Effect.forkChild);
      yield* settle;
      const newer = yield* service
        .read({ leaseId: lease.leaseId, readId: 901, cursor: built.cursor }, testClient)
        .pipe(Effect.forkChild);
      yield* settle;
      yield* Deferred.succeed(hold, undefined);
      yield* settle;
      // The older read ended as superseded and did not take the newer one's place.
      const olderExit = yield* Fiber.join(older);
      assert.isTrue(Exit.isFailure(olderExit));
      yield* native.publish({ type: "message_update", messageId: "x", message: assistant("go") });
      yield* settle;
      assert.isTrue(newer.pollUnsafe() !== undefined);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "an acknowledgement is capped at what was sent, so pruning never discards records a lease has not seen",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const a = yield* follow(service, originalRef);
        const b = yield* follow(service, originalRef);
        const builtA = yield* a.pass();
        const builtB = yield* b.pass();
        yield* native.publish({ type: "notice", level: "info", message: "only b sees this early" });
        const gotB = yield* b.pass(builtB.cursor);
        assert.equal(gotB.inbox.length, 1);
        const ackB = yield* b.pass(gotB.cursor).pipe(Effect.forkChild);
        yield* TestClock.adjust("20 seconds");
        yield* Fiber.join(ackB);
        // Lease a claims a position beyond anything it was sent, twice: the second read
        // would acknowledge the echo of the first reply's position.
        yield* native.publish({
          type: "message_update",
          messageId: "u",
          message: assistant("unrelated"),
        });
        const forged = { ...builtA.cursor!, inboxSeq: 1_000_000 };
        const first = yield* a.read(forged);
        assert.equal(first.type, "pass");
        const second = yield* a
          .read(first.type === "pass" ? first.continuation : forged)
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("20 seconds");
        yield* Fiber.join(second);
        // Its own honest position still has the record waiting.
        const honest = yield* a.read(builtA.cursor);
        assert.equal(honest.type === "pass" && honest.inbox.length, 1);
      }).pipe(Effect.scoped),
  );

  it.effect("a refused lowering of the subagent level is retried until the owner takes it", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      yield* service.open({ ...originalRef });
      const lease = yield* follow(service, originalRef);
      yield* lease.pass();
      yield* service.setDemand(
        { leaseId: lease.leaseId, generation: 1, demand: [{ kind: "roster" }] },
        testClient,
      );
      yield* TestClock.adjust("2 seconds");
      assert.deepEqual(native.levels, ["progress"]);
      native.rejectOff = 2;
      yield* Fiber.interrupt(lease.fiber);
      yield* TestClock.adjust("10 seconds");
      assert.deepEqual(native.levels, ["progress", "off"]);
      assert.equal(native.rejectOff, 0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a terminal that cannot be attached when takeover is due is incompatible, not owner-stopped",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture("terminal");
        yield* service.open(originalRef);
        const lease = yield* follow(service, originalRef);
        yield* lease.next("lifecycle", observing);
        native.ownerAlive = false;
        yield* Deferred.succeed(native.exit!, ownerExited);
        yield* lease.next("lifecycle", (envelope) => envelope.state === "reconnecting");
        yield* service
          .request({ ref: originalRef, command: { type: "prompt", message: "queued" } })
          .pipe(Effect.forkScoped);
        yield* settle;
        native.autoError = new NeoPiNativeSessionsError({
          code: "owner_outdated",
          message: "update the terminal's NeoPi",
        });
        yield* TestClock.adjust("12 seconds");
        yield* lease.next("lifecycle", (envelope) => envelope.state === "incompatible");
        assert.isFalse(
          lease.seen.some(
            (envelope) => envelope.type === "lifecycle" && envelope.state === "owner-stopped",
          ),
        );
      }).pipe(Effect.scoped),
  );
});

describe("children after an unwatched interval (rc3-1a)", () => {
  const settle = Effect.forEach(Array.from({ length: 400 }), () => Effect.yieldNow, {
    discard: true,
  });
  // The verifier's run: two children spawned, the view closed, the parent finished, the
  // view reopened. NeoPi sent only the spawns; with the level off it sent nothing more.
  const spawned = (id: string, runToken: string) => ({
    type: "subagent_lifecycle",
    payload: {
      id,
      runToken,
      runKind: "spawn",
      status: "started",
      agent: "task",
      agentSource: "bundled",
      index: 0,
      sessionFile: `/native/children/${id}.jsonl`,
    },
  });
  const rowOf = (
    view: { readonly entities: ReadonlyMap<string, NeoPiNativeEntity["value"]> },
    id: string,
  ) => {
    const value = view.entities.get(`roster:${id}`);
    return value?.class === "roster" ? value.value : undefined;
  };
  /** Shows the two children to a roster view, then closes it; returns when the level is off. */
  const watchThenClose = Effect.fnUntraced(function* (
    native: Effect.Success<ReturnType<typeof fixture>>["native"],
    service: Service,
  ) {
    yield* service.open({ ...originalRef });
    const first = yield* follow(service, originalRef);
    const built = yield* first.pass();
    yield* service.setDemand(
      { leaseId: first.leaseId, generation: 1, demand: [{ kind: "roster" }] },
      testClient,
    );
    yield* TestClock.adjust("2 seconds");
    yield* native.publish(spawned("Load0", "5f4a0d14-1cf6-4396-b217-ce24c2337edd"));
    yield* native.publish(spawned("Load1", "eee9a31c-45cc-4000-83a7-544dd920a038"));
    const seen = yield* first.pass(built.cursor);
    assert.isDefined(rowOf(seen, "Load0"));
    assert.isDefined(rowOf(seen, "Load1"));
    yield* Fiber.interrupt(first.fiber);
    yield* settle;
    assert.equal(native.levels.at(-1), "off");
    // The parent finished meanwhile: the live inventory is empty.
    native.agents = [];
  });

  it.effect(
    "an owner without subagent history: children that finished unseen stay, marked unobserved, never running",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* watchThenClose(native, service);
        const second = yield* follow(service, originalRef);
        const view = yield* second.pass();
        for (const id of ["Load0", "Load1"]) {
          const row = rowOf(view, id);
          assert.isDefined(row, `${id} vanished from the roster`);
          // No live part is left to replay as "started" over what the owner says now.
          assert.isUndefined(row?.lifecycle);
          const unobserved = Object(row?.unobserved);
          assert.equal(Reflect.get(Object(Reflect.get(unobserved, "lifecycle")), "id"), id);
          assert.isNumber(Reflect.get(unobserved, "since"));
        }
        assert.equal(native.historyReads, 0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a child marked unobserved after a reopen loses the mark when its run is seen to finish live",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* watchThenClose(native, service);
        const second = yield* follow(service, originalRef);
        const view = yield* second.pass();
        assert.isDefined(rowOf(view, "Load0")?.unobserved);
        yield* service.setDemand(
          { leaseId: second.leaseId, generation: 1, demand: [{ kind: "roster" }] },
          testClient,
        );
        yield* TestClock.adjust("2 seconds");
        const finished = spawned("Load0", "5f4a0d14-1cf6-4396-b217-ce24c2337edd");
        yield* native.publish({
          ...finished,
          payload: { ...finished.payload, status: "completed" },
        });
        const after = yield* second.pass(view.cursor);
        const row = rowOf(after, "Load0");
        assert.isUndefined(row?.unobserved);
        assert.equal(Reflect.get(Object(row?.lifecycle), "status"), "completed");
        // The other child is still only known to have finished unseen.
        const other = yield* second.pass();
        assert.isDefined(rowOf(other, "Load1")?.unobserved);
      }).pipe(Effect.scoped),
  );

  it.effect("a child the owner's history lists comes back finished, not unobserved", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      native.capabilities = ["subagent_history"];
      yield* watchThenClose(native, service);
      native.history = [
        { id: "Load0", kind: "sub", status: "parked", live: false, createdAt: 1, lastActivity: 2 },
        { id: "Load1", kind: "sub", status: "aborted", live: false, createdAt: 1, lastActivity: 2 },
      ];
      const second = yield* follow(service, originalRef);
      const view = yield* second.pass();
      assert.equal(Reflect.get(Object(rowOf(view, "Load0")?.history), "status"), "parked");
      assert.equal(Reflect.get(Object(rowOf(view, "Load1")?.history), "status"), "aborted");
      for (const id of ["Load0", "Load1"]) {
        assert.isUndefined(rowOf(view, id)?.lifecycle);
        assert.isUndefined(rowOf(view, id)?.unobserved);
      }
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a job held from before an unwatched interval is gone after the rebuild; one the owner still lists is kept",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        native.capabilities.push("background_jobs");
        const running = (id: string) => ({ id, status: "running" });
        native.jobs = [running("job-a"), running("job-b")];
        yield* service.open({ ...originalRef });
        const first = yield* follow(service, originalRef);
        const built = yield* first.pass();
        yield* service.setDemand(
          { leaseId: first.leaseId, generation: 1, demand: [{ kind: "roster" }] },
          testClient,
        );
        yield* TestClock.adjust("2 seconds");
        for (const id of ["job-a", "job-b"])
          yield* native.publish({
            type: "job_lifecycle",
            event: "registered",
            job: running(id),
            runningCount: 2,
          });
        const seen = yield* first.pass(built.cursor);
        assert.isTrue(seen.entities.has("job:job-a") && seen.entities.has("job:job-b"));
        yield* Fiber.interrupt(first.fiber);
        yield* settle;
        assert.equal(native.levels.at(-1), "off");
        // Job A finished and aged out unseen; the owner lists only B now.
        native.jobs = [running("job-b")];
        const second = yield* follow(service, originalRef);
        const view = yield* second.pass();
        assert.isFalse(view.entities.has("job:job-a"));
        assert.isTrue(view.entities.has("job:job-b"));
      }).pipe(Effect.scoped),
  );

  it.effect("a child still running is shown from the live inventory, not unobserved", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      yield* watchThenClose(native, service);
      native.agents = [{ id: "Load0", status: "running", agent: "task", index: 0 }];
      const second = yield* follow(service, originalRef);
      const view = yield* second.pass();
      assert.equal(Reflect.get(Object(rowOf(view, "Load0")?.inventory), "status"), "running");
      assert.isUndefined(rowOf(view, "Load0")?.unobserved);
      assert.isDefined(rowOf(view, "Load1")?.unobserved);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a history that does not list a child yet is read again, and the child is kept meanwhile",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        native.capabilities = ["subagent_history"];
        yield* watchThenClose(native, service);
        const second = yield* follow(service, originalRef);
        const view = yield* second.pass();
        assert.isDefined(rowOf(view, "Load0")?.unobserved);
        const reads = native.historyReads;
        // The child's result is persisted a moment later.
        native.history = [
          {
            id: "Load0",
            kind: "sub",
            status: "parked",
            live: false,
            createdAt: 1,
            lastActivity: 2,
          },
        ];
        yield* TestClock.adjust("300 millis");
        yield* settle;
        yield* TestClock.adjust("2 seconds");
        yield* settle;
        assert.isAbove(native.historyReads, reads);
        const after = yield* second.pass(view.cursor);
        assert.equal(Reflect.get(Object(rowOf(after, "Load0")?.history), "status"), "parked");
        assert.isUndefined(rowOf(after, "Load0")?.unobserved);
        // Load1 is in neither: it stays, and the re-reads stop after a bound.
        for (let step = 0; step < 20; step++) {
          yield* TestClock.adjust("10 seconds");
          yield* settle;
        }
        const settled = native.historyReads;
        yield* TestClock.adjust("2 minutes");
        yield* settle;
        assert.equal(native.historyReads, settled);
        assert.isAtMost(settled - reads, 8);
        const third = yield* follow(service, originalRef);
        const latest = yield* third.pass();
        assert.isDefined(rowOf(latest, "Load1")?.unobserved);
        assert.equal(Reflect.get(Object(rowOf(latest, "Load0")?.history), "status"), "parked");
      }).pipe(Effect.scoped),
  );
});

describe("attach-only discovery (r12 C5)", () => {
  it.effect(
    "with no session installed, a lease discovers a live terminal owner and attaches without starting one",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture("terminal");
        const lease = yield* follow(service, originalRef);
        const { session } = yield* lease.next("session");
        assert.equal(session.attachment, "terminal");
        yield* lease.next("lifecycle", observing);
        assert.equal(native.starts, 1);
        assert.equal(native.connections, 1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a thread view registers no host tools with the owner, across a refresh; a session view or open does",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture("terminal");
        const thread = yield* follow(service, originalRef, testClient, "thread");
        yield* thread.next("lifecycle", observing);
        yield* Fiber.interrupt(thread.fiber);
        const again = yield* follow(service, originalRef, testClient, "thread");
        yield* again.next("lifecycle", observing);
        assert.equal(native.binds, 0);
        assert.deepEqual(native.levels, []);
        // A session view joining the same attached session registers them once.
        const session = yield* follow(service, originalRef);
        yield* session.next("lifecycle", observing);
        assert.equal(native.binds, 1);
        yield* service.open(originalRef);
        assert.equal(native.binds, 1);
      }).pipe(Effect.scoped),
  );

  it.effect("an explicit open registers host tools before any view attaches", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture("terminal");
      yield* service.open(originalRef);
      assert.equal(native.binds, 1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "with no owner anywhere, discovery reports owner-stopped, ends the stream and starts nothing",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        const lease = yield* follow(service, originalRef);
        yield* lease.next("lifecycle", (envelope) => envelope.state === "owner-stopped");
        yield* Fiber.join(lease.fiber);
        assert.equal(native.starts, 0);
        assert.equal(native.connections, 0);
      }).pipe(Effect.scoped),
  );

  it.effect("concurrent leases share one discovery and one attached session", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture("terminal");
      const [a, b] = yield* Effect.all([
        follow(service, originalRef),
        follow(service, originalRef),
      ]);
      yield* a.next("lifecycle", observing);
      yield* b.next("lifecycle", observing);
      assert.equal(native.starts, 1);
    }).pipe(Effect.scoped),
  );
});

const catalogRow = (overrides: Partial<CatalogRowFixture> = {}): CatalogRowFixture => ({
  path: originalRef.sessionFile,
  id: "disk-id",
  cwd: "/workspace-free",
  title: null,
  firstMessage: "saved",
  modified: "2026-10-28T00:00:00Z",
  inUse: null,
  control: null,
  ...overrides,
});
type CatalogRowFixture = Effect.Success<
  ReturnType<NeoPiNativeSessionsDependencies["catalog"]>
>[number];

const memorySettledStore = () => {
  const records = new Map<string, NeoPiNativeSettledRecord>();
  const store: NeoPiNativeSettledStore = {
    read: Effect.sync(() => new Map(records)),
    update: (changes) =>
      Effect.sync(() => {
        for (const [file, record, expected] of changes) {
          if (record === null) {
            if (records.get(file) === expected) records.delete(file);
          } else records.set(file, record);
        }
      }),
  };
  return { records, store };
};

describe("native session liveness and settling", () => {
  it.effect("reports NeoPi's owner state, and NeoCode's own feed for sessions it owns", () =>
    Effect.gen(function* () {
      const { native, dependencies } = yield* fixture();
      const waiting = {
        state: "waiting",
        isStreaming: false,
        pendingDialogs: 1,
        branch: "main",
      } as const;
      const service = yield* makeNeoPiNativeSessionsWith({
        ...dependencies,
        catalog: (profile) =>
          Effect.succeed(
            profile.providerInstanceId === instanceId
              ? [
                  catalogRow({
                    inUse: { pid: 42 },
                    control: { instanceId: "terminal" },
                    live: waiting,
                  }),
                ]
              : [],
          ),
      });
      const liveOf = () => service.list({}).pipe(Effect.map((result) => result.sessions[0]?.live));
      assert.deepEqual(yield* liveOf(), waiting);

      yield* service.open({ ...originalRef });
      assert.deepEqual(yield* liveOf(), {
        state: "idle",
        isStreaming: false,
        pendingDialogs: 0,
        branch: "main",
      });
      yield* native.publish({ type: "agent_start" });
      assert.equal((yield* liveOf())?.state, "busy");
      yield* native.publish({
        type: "extension_ui_request",
        id: "approve",
        method: "confirm",
        title: "Run it?",
      });
      assert.deepEqual(
        { state: (yield* liveOf())?.state, dialogs: (yield* liveOf())?.pendingDialogs },
        { state: "waiting", dialogs: 1 },
      );
      yield* native.publish({
        type: "extension_ui_request",
        id: "cancel-approve",
        method: "cancel",
        targetId: "approve",
      });
      yield* native.publish({ type: "agent_end" });
      assert.equal((yield* liveOf())?.state, "idle");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a manual settle until the file sees activity, then wakes it", () =>
    Effect.gen(function* () {
      const { dependencies } = yield* fixture();
      const { records, store } = memorySettledStore();
      let row = catalogRow({ modified: "2999-01-01T00:00:00Z" });
      const service = yield* makeNeoPiNativeSessionsWith({
        ...dependencies,
        catalog: (profile) =>
          Effect.succeed(profile.providerInstanceId === instanceId ? [row] : []),
        settlement: { store, autoSettleAfterDays: Effect.succeed(null) },
      });
      const settledAt = () =>
        service.list({}).pipe(Effect.map((result) => result.sessions[0]?.settledAt));
      assert.equal(yield* settledAt(), undefined);

      assert.deepEqual(yield* service.setSettled({ ref: originalRef, settled: true }), {
        settled: true,
      });
      assert.equal(typeof (yield* settledAt()), "string");
      assert.equal(records.size, 1);

      row = { ...row, modified: "2999-01-02T00:00:00Z" };
      assert.equal(yield* settledAt(), undefined);
      assert.equal(records.size, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("does not discard a manual decision made while a stale list is paused", () =>
    Effect.gen(function* () {
      const { dependencies } = yield* fixture();
      for (const settled of [true, false]) {
        const { records, store } = memorySettledStore();
        records.set(originalRef.sessionFile, {
          state: "settled",
          settledAt: "2999-01-01T00:00:00Z",
          modifiedAt: "2999-01-01T00:00:00Z",
        });
        const snapshotRead = yield* Deferred.make<void>();
        const resumeList = yield* Deferred.make<void>();
        const row = catalogRow({ modified: "2999-01-02T00:00:00Z" });
        const service = yield* makeNeoPiNativeSessionsWith({
          ...dependencies,
          catalog: (profile) =>
            Effect.succeed(profile.providerInstanceId === instanceId ? [row] : []),
          settlement: {
            store,
            autoSettleAfterDays: Effect.gen(function* () {
              yield* Deferred.succeed(snapshotRead, undefined);
              yield* Deferred.await(resumeList);
              return null;
            }),
          },
        });
        const listing = yield* service.list({}).pipe(Effect.forkChild);
        yield* Deferred.await(snapshotRead);
        yield* service.setSettled({ ref: originalRef, settled });
        const decision = records.get(originalRef.sessionFile);
        yield* Deferred.succeed(resumeList, undefined);
        yield* Fiber.join(listing);

        assert.equal(records.get(originalRef.sessionFile), decision);
        assert.equal(decision?.state, settled ? "settled" : "unsettled");
        const result = yield* service.list({});
        assert.equal(result.sessions[0]?.settledAt, settled ? decision?.settledAt : undefined);
      }
    }).pipe(Effect.scoped),
  );

  // The auto-settle window compares against the wall clock, which `it.effect` replaces.
  it.live("auto-settles idle sessions and honors an explicit un-settle", () =>
    Effect.gen(function* () {
      const { dependencies } = yield* fixture();
      const { store } = memorySettledStore();
      const service = yield* makeNeoPiNativeSessionsWith({
        ...dependencies,
        catalog: (profile) =>
          Effect.succeed(
            profile.providerInstanceId === instanceId
              ? [catalogRow({ modified: "2020-01-01T00:00:00Z" })]
              : [],
          ),
        settlement: { store, autoSettleAfterDays: Effect.succeed(3) },
      });
      const settledAt = () =>
        service.list({}).pipe(Effect.map((result) => result.sessions[0]?.settledAt));
      assert.equal(yield* settledAt(), "2020-01-04T00:00:00.000Z");

      yield* service.setSettled({ ref: originalRef, settled: false });
      assert.equal(yield* settledAt(), undefined);
    }).pipe(Effect.scoped),
  );
});

describe("join replay through the client reducer (paired)", () => {
  it.effect(
    "a re-attached view keeps each still-open dialog object and drops only those settled while it was away",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        yield* service.open({ ...originalRef });
        const dialogs = 12; // More than the credit window of 8, so the replay spans several grants.
        const apply = (feed: NativeSessionFeed, envelopes: readonly Envelope[]) =>
          envelopes.reduce((current, envelope) => reduceNativeSessionFeed(current, envelope), feed);
        const first = yield* follow(service, originalRef);
        yield* first.next("lifecycle", observing);
        yield* Effect.forEach(
          Array.from({ length: dialogs }, (_, index) => index),
          (index) =>
            native.publish({
              type: "extension_ui_request",
              id: `ui-${index}`,
              method: "confirm",
              title: `Allow ${index}?`,
            }),
          { discard: true },
        );
        yield* first.next("obligation-opened", (envelope) => envelope.id === `ui-${dialogs - 1}`);
        let feed = apply(emptyNativeSessionFeed(), first.seen);
        assert.equal(feed.dialogs.length, dialogs);
        const held = feed.dialogs.find((dialog) => dialog.id === "ui-0");
        // The view goes away; three dialogs are cancelled by the owner while nobody watches.
        yield* Fiber.interrupt(first.fiber);
        yield* Effect.forEach(
          ["ui-1", "ui-5", "ui-11"],
          (targetId) =>
            native.publish({
              type: "extension_ui_request",
              id: `c-${targetId}`,
              method: "cancel",
              targetId,
            }),
          { discard: true },
        );
        const again = yield* follow(service, originalRef);
        yield* again.next("lifecycle", observing);
        const lifecycle = again.seen.findIndex((envelope) => envelope.type === "lifecycle");
        // Before the lease's first lifecycle every held dialog is still shown, the same objects.
        const beforeLifecycle = apply(feed, again.seen.slice(0, lifecycle));
        assert.equal(beforeLifecycle.dialogs.length, dialogs);
        feed = apply(beforeLifecycle, again.seen.slice(lifecycle));
        assert.deepEqual(
          feed.dialogs.map((dialog) => dialog.id),
          Array.from({ length: dialogs }, (_, index) => `ui-${index}`).filter(
            (id) => !["ui-1", "ui-5", "ui-11"].includes(id),
          ),
        );
        assert.strictEqual(
          feed.dialogs.find((dialog) => dialog.id === "ui-0"),
          held,
        );
        assert.isNull(feed.unconfirmedDialogs);
      }).pipe(Effect.scoped),
  );
});

const encodeOptOutFixture = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeOptOutRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, type: Schema.String })),
);

describe("opening native sessions with managed tmux disabled", () => {
  for (const scenario of [
    "malformed",
    "stale",
    "unsafe directory",
    "live owner",
    "invalid launch arguments with a live owner",
  ] as const) {
    const invalidArgs = scenario === "invalid launch arguments with a live owner";
    const name = invalidArgs
      ? `rejects ${scenario} before attaching`
      : `uses the ordinary open path with ${scenario} managed state`;
    it.live(name, () =>
      Effect.gen(function* () {
        vi.stubEnv("T3CODE_NEOPI_TMUX", undefined);
        vi.stubEnv("T3CODE_NEOPI_MANAGED_TMUX", undefined);
        const makeHost = vi.spyOn(ManagedTmux, "makeManagedTmuxHost");
        const hostTools = vi
          .spyOn(HostToolBridge, "makeNeoPiNativeHostToolPump")
          .mockReturnValue(Effect.succeed({ bind: () => Effect.succeed([]), revoke: Effect.void }));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            makeHost.mockRestore();
            hostTools.mockRestore();
            vi.unstubAllEnvs();
          }),
        );
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
        const sessionFile = NodePath.join(cwd, "session.jsonl");
        const { stateDir } = yield* deriveServerPaths(cwd, undefined);
        const directory = NodePath.join(stateDir, "nt");
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
        if (scenario === "unsafe directory") yield* fs.chmod(directory, 0o755);
        yield* fs.writeFileString(sessionFile, "");
        const live = scenario === "live owner" || invalidArgs;
        const owner = {
          executable: "/fixture/tmux",
          session: "$0",
          window: "@0",
          pane: "%0",
          pid: 321,
          instanceId: "existing-control",
          imageId: "existing-image",
          sessionId: "existing-session",
        };
        const key = NodeCrypto.createHash("sha256").update(sessionFile).digest("hex");
        const binding = {
          socket: NodePath.join(directory, "s"),
          session: "managed",
          sessionFile,
          providerInstanceId: instanceId,
          profile: null,
          owner,
        } satisfies ManagedTmux.ManagedTmuxBinding;
        const bindingPath = NodePath.join(directory, `${key}.json`);
        yield* fs.writeFileString(
          bindingPath,
          scenario === "malformed" ? "not JSON" : encodeOptOutFixture(binding),
        );
        yield* fs.chmod(bindingPath, 0o600);

        const instance = registerNeoPiSessionCatalogSource(
          {
            enabled: true,
            instanceId,
            driverKind: ProviderDriverKind.make("neopi"),
            get adapter(): never {
              throw new Error("Unexpected provider adapter access");
            },
            get snapshot(): never {
              throw new Error("Unexpected provider snapshot access");
            },
            get textGeneration(): never {
              throw new Error("Unexpected provider text generation access");
            },
            displayName: undefined,
            continuationIdentity: {
              driverKind: ProviderDriverKind.make("neopi"),
              continuationKey: instanceId,
            },
          },
          {
            binary: "/fixture/npi",
            env: {},
            profile: "default",
            ...(invalidArgs ? { launchArgs: "--fork" } : {}),
            capabilities: new Set(["exit_with_parent"]),
            probe: { status: "compatible", version: "fixture" },
          },
        );
        const changes = yield* PubSub.unbounded<void>();
        const spawned: ReadonlyArray<string>[] = [];
        const encode = (value: unknown) =>
          new TextEncoder().encode(`${encodeOptOutFixture(value)}\n`);
        const service = yield* makeNeoPiNativeSessions().pipe(
          Effect.provide(
            Layer.mergeAll(
              configLayer(cwd, cwd),
              settingsLayer(),
              Layer.mock(ProviderInstanceRegistry)({
                getInstance: () => Effect.succeed(instance),
                subscribeChanges: PubSub.subscribe(changes),
              }),
              Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
                spawn: (command) =>
                  Effect.gen(function* () {
                    if (!ChildProcess.isStandardCommand(command))
                      return yield* Effect.die("Unexpected piped child command");
                    spawned.push(command.args);
                    const catalog = command.args[0] === "sessions";
                    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
                    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
                    const finish = Queue.end(stdout).pipe(
                      Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))),
                      Effect.asVoid,
                    );
                    if (!catalog)
                      yield* Queue.offer(
                        stdout,
                        encode({
                          type: "ready",
                          protocolVersion: 1,
                          capabilities: ["control_v1", "session_journal", "session_journal_events"],
                        }),
                      );
                    return ChildProcessSpawner.makeHandle({
                      pid: ChildProcessSpawner.ProcessId(123),
                      exitCode: catalog
                        ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
                        : Deferred.await(exited),
                      isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
                      kill: () => finish,
                      stdin: Sink.forEach((chunk: Uint8Array) => {
                        const request = decodeOptOutRequest(new TextDecoder().decode(chunk));
                        return Queue.offer(
                          stdout,
                          encode({
                            type: "response",
                            id: request.id,
                            command: request.type,
                            success: true,
                            data:
                              request.type === "get_state"
                                ? { sessionId: owner.sessionId, sessionFile, messageCount: 0 }
                                : {},
                          }),
                        );
                      }).pipe(Sink.ensuring(finish)),
                      stdout: catalog
                        ? Stream.make(
                            encode({
                              version: 1,
                              sessions: [
                                {
                                  path: sessionFile,
                                  id: owner.sessionId,
                                  cwd,
                                  title: "Existing session",
                                  firstMessage: "Hello",
                                  modified: "2026-11-20T00:00:00Z",
                                  inUse: live ? { pid: owner.pid } : null,
                                  control: live
                                    ? { pid: owner.pid, instanceId: owner.instanceId }
                                    : null,
                                },
                              ],
                            }),
                          )
                        : Stream.fromQueue(stdout),
                      stderr: Stream.empty,
                      all: Stream.empty,
                      getInputFd: () => Sink.drain,
                      getOutputFd: () => Stream.empty,
                      unref: Effect.succeed(Effect.void),
                    });
                  }),
              }),
            ),
          ),
        );
        const ref = { providerInstanceId: instanceId, sessionFile };
        if (invalidArgs) {
          const result = yield* service.open(ref).pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.equal(result.failure.message, "NeoPi launch arguments may not override --fork");
          }
          assert.deepEqual(spawned, [["sessions", "list", "--json", "--session-dir", cwd]]);
          assert.equal(makeHost.mock.calls.length, 0);
          return;
        }
        const opened = yield* service.open(ref);
        assert.equal(opened.attachment, live ? "terminal" : "owned");
        assert.deepEqual(spawned, [
          ["sessions", "list", "--json", "--session-dir", cwd],
          live
            ? ["ctl", "pipe", owner.instanceId, "--label", "neocode-native"]
            : [
                "--mode",
                "rpc-ui",
                "--cwd",
                cwd,
                "--no-title",
                "--exit-with-parent",
                "--session",
                sessionFile,
              ],
        ]);
        assert.equal(makeHost.mock.calls.length, 0);
        yield* service.close({ ref });
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  }
});
