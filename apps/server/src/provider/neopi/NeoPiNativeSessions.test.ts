import { assert, describe, it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import {
  NeoPiNativeSessionsError,
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Scope from "effect/Scope";
import {
  makeNeoPiNativeSessionsWith,
  type NeoPiNativeConnection,
  type NeoPiNativeProfile,
  type NeoPiNativeSessionsDependencies,
} from "./NeoPiNativeSessions.ts";
import type { NeoPiNativeSettledRecord, NeoPiNativeSettledStore } from "./NeoPiNativeSettlement.ts";
import { prepareNeoPiNativePrompt } from "./NeoPiNativeAttachments.ts";
import { updateNativeModelsConfiguration } from "./NeoPiModels.ts";

const instanceId = ProviderInstanceId.make("native-profile");
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
      /** Subagent subscription levels requested of the owner, in order. */
      levels: [] as string[],
      /** `snapshot_session_journal` requests the owner received. */
      snapshots: 0,
      followUp: [] as string[],
      inventoryFailure: false,
      inventoryHook: Effect.void as Effect.Effect<void>,
      pageHook: Effect.void as Effect.Effect<void>,
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
          native.sessionFile = input.sessionFile ?? "/native/lazy-created.jsonl";
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
                  case "set_subagent_subscription":
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
const follow = Effect.fnUntraced(function* (service: Service, ref: NeoPiNativeSessionRef) {
  // `ended` marks the watch stream finishing, so a test waiting on an envelope fails instead of hanging.
  const envelopes = yield* Queue.unbounded<Envelope | { readonly type: "ended" }>();
  const leased = yield* Deferred.make<string>();
  let applied = 0;
  /** Every envelope delivered so far, in order. */
  const seen: Envelope[] = [];
  const fiber = yield* service.watch({ ref }).pipe(
    Stream.runForEach((envelope) =>
      Effect.gen(function* () {
        if (envelope.type === "leased") yield* Deferred.succeed(leased, envelope.leaseId);
        applied++;
        seen.push(envelope);
        yield* Queue.offer(envelopes, envelope);
        yield* service.credit({ leaseId: yield* Deferred.await(leased), applied });
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
    service.read({ leaseId, readId: readId++, cursor });
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
  return { fiber, leaseId, next, read, pass, seen };
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
      const ui = yield* models.ui.pipe(
        Stream.tap(() => Deferred.succeed(ready, undefined)),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* native.publish({ type: "extension_ui_request", id: "notice", method: "notify" });
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
        yield* service.watch({ ref: originalRef }).pipe(
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
          yield* service.credit({ leaseId, applied });
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
        // Unlike an append, the navigation restarts the build and fetches a fresh page (C3.5).
        assert.equal(rebased.cursor!.epoch.buildAttempt, domain.buildAttempt + 1);
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
          .read({ leaseId, readId: 100, cursor })
          .pipe(Effect.forkChild);
        for (let spin = 0; spin < 10; spin++) yield* Effect.yieldNow;
        // The same or an older read id is a second read on this lease: refused.
        const repeated = yield* service.read({ leaseId, readId: 100, cursor }).pipe(Effect.flip);
        assert.equal(repeated.code, "stale_read");
        // A newer read id is a retry: it replaces the one waiting, which ends as stale.
        const retry = yield* service.read({ leaseId, readId: 101, cursor }).pipe(Effect.forkChild);
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
        const caughtUp = yield* service.read({ leaseId, readId: 102, cursor });
        assert.equal(caughtUp.type, "pass");
        const pending = yield* service
          .read({
            leaseId,
            readId: 103,
            cursor: caughtUp.type === "pass" ? caughtUp.continuation : cursor,
          })
          .pipe(Effect.forkChild);
        for (let spin = 0; spin < 10; spin++) yield* Effect.yieldNow;
        yield* Fiber.interrupt(lease.fiber);
        const cancelled = yield* Fiber.join(pending).pipe(Effect.flip);
        assert.equal(cancelled.code, "lease_unknown");
        const late = yield* service.credit({ leaseId, applied: 1 }).pipe(Effect.flip);
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
          .setDemand({ leaseId: first.leaseId, generation: 1, demand: [{ kind: "summary" }] })
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
          service.setDemand({
            leaseId: lease.leaseId,
            generation,
            demand: kinds.map((kind) =>
              kind === "child"
                ? { kind: "child" as const, childId: "c1", runToken: "run-c1" }
                : { kind: kind as "roster" },
            ),
          });
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
        yield* service.setDemand({
          leaseId: lease.leaseId,
          generation: 1,
          demand: [{ kind: "roster" }],
        });
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
        yield* service.setDemand({
          leaseId: lease.leaseId,
          generation: 1,
          demand: [{ kind: "roster" }],
        });
        yield* TestClock.adjust("2 seconds");
        assert.deepEqual(native.levels, ["progress"]);
        yield* Fiber.interrupt(lease.fiber);
        yield* TestClock.adjust("2 seconds");
        assert.deepEqual(native.levels, ["progress", "off"]);
        const gone = yield* service
          .read({ leaseId: lease.leaseId, readId: 99, cursor: null })
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
        yield* service.setDemand({
          leaseId: lease.leaseId,
          generation: 1,
          demand: [{ kind: "roster" }],
        });
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
        const same = yield* service.setDemand({
          leaseId: lease.leaseId,
          generation: 1,
          demand: [{ kind: "roster" }],
        });
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
          .pipe(Effect.flip);
        assert.equal(refused.code, "observation_server_owned");
        const level = yield* service
          .request({
            ref: originalRef,
            command: { type: "set_subagent_subscription", level: "events" },
          })
          .pipe(Effect.flip);
        assert.equal(level.code, "observation_server_owned");
        native.snapshotHook = Effect.void;
        yield* Deferred.succeed(release, undefined);
        yield* lease.pass();
        assert.equal(native.snapshots, 1);
        assert.deepEqual(native.levels, []);
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
