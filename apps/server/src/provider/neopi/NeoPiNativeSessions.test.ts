import { assert, describe, it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import {
  NeoPiNativeSessionsError,
  ProviderInstanceId,
  type NeoPiJournalEntry,
  type NeoPiNativeSessionRef,
} from "@t3tools/contracts";
import type { ProcessExit, SessionEventFrame } from "effect-neopi-rpc/client";
import { NeoPiRpcError } from "effect-neopi-rpc/errors";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import {
  makeNeoPiNativeSessionsWith,
  type NeoPiNativeConnection,
  type NeoPiNativeProfile,
  type NeoPiNativeSessionsDependencies,
} from "./NeoPiNativeSessions.ts";
import { prepareNeoPiNativePrompt } from "./NeoPiNativeAttachments.ts";
import { updateNativeModelsConfiguration } from "./NeoPiModels.ts";
import { readNeoPiLiveUsage } from "./NeoPiLiveUsage.ts";

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
      streaming: false,
      connections: 0,
      starts: 0,
      disposals: 0,
      detaches: 0,
      aborts: 0,
      acceptedPrompts: 0,
      modelRuleRequests: 0,
      usageRequests: [] as string[],
      ownerPid: null as number | null,
      profileValid: true,
      blockSnapshot: false,
      startupDialog: false,
      pageHook: Effect.void as Effect.Effect<void>,
      afterPageHook: Effect.void as Effect.Effect<void>,
      publish: (_frame: SessionEventFrame): Effect.Effect<void> => Effect.void,
    };
    const state = () => ({
      sessionId: native.sessionId,
      sessionFile: native.sessionFile,
      isStreaming: native.streaming,
      messageCount: native.entries.length,
    });
    const identity = () => ({
      sessionId: native.sessionId,
      sessionFile: native.sessionFile,
      leafId: native.entries.at(-1)?.id ?? null,
    });
    const source = {
      binary: "/fixture/npi",
      env: {} as Record<string, string>,
      profile: "fixture",
      capabilities: new Set(["session_catalog"]),
      probe: { status: "compatible" as const, version: "fixture" },
    };
    const profile = (id: ProviderInstanceId): NeoPiNativeProfile => ({
      providerInstanceId: id,
      source,
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
      catalog: () =>
        Effect.succeed(
          native.ownerPid === null
            ? []
            : [
                {
                  path: native.sessionFile,
                  id: native.sessionId,
                  cwd: native.cwd,
                  title: null,
                  modified: "2026-10-28T00:00:00Z",
                  messageCount: native.entries.length,
                  inUse: { pid: native.ownerPid },
                },
              ],
        ),
      connect: (_profile, input, publish) =>
        Effect.gen(function* () {
          if (native.connections !== 0)
            return yield* new NeoPiNativeSessionsError({
              code: "session_in_use",
              message: "A writer already owns the file",
            });
          native.starts++;
          native.connections++;
          native.running = true;
          native.sessionFile = input.sessionFile ?? "/native/lazy-created.jsonl";
          native.publish = publish;
          const exit = yield* Deferred.make<ProcessExit>();
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              native.connections--;
              if (attachment === "owned") {
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
              "get_usage",
            ]),
            exit,
            request: (command) =>
              Effect.gen(function* () {
                switch (command.type) {
                  case "get_state":
                    return state();
                  case "get_status":
                    return {
                      session: state(),
                      cwd: native.cwd,
                      revisions: { generation: native.generation },
                    };
                  case "snapshot_session_journal": {
                    yield* publish({ type: "journal_state", reason: "snapshot", ...identity() });
                    if (native.blockSnapshot) yield* Deferred.await(snapshotReleased);
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
                    native.streaming = true;
                    return { userEntryId: "native-admission" };
                  case "get_usage":
                    native.usageRequests.push(String(command.provider));
                    return { provider: command.provider, redact: command.redact };
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
          return { client, attachment, cwd: native.cwd, readState: Effect.sync(state) };
        }),
    };
    const service = yield* makeNeoPiNativeSessionsWith(dependencies);
    return { native, service, dependencies, profileChanges, disconnected, source };
  });

const snapshot = (
  service: Effect.Success<ReturnType<typeof makeNeoPiNativeSessionsWith>>,
  ref: NeoPiNativeSessionRef,
) =>
  Stream.runCollect(
    service.watch({ ref }).pipe(
      Stream.filter((event) => event.type === "snapshot"),
      Stream.take(1),
    ),
  );

describe("canonical native session lifecycle", () => {
  it.effect(
    "hands off only the connected canonical native file with a quoted terminal command",
    () =>
      Effect.gen(function* () {
        const { native, source, service } = yield* fixture();
        const ref = { ...originalRef, sessionFile: "/alias/session's file.jsonl" };
        native.cwd = "/work/owner's project";
        source.binary = "/bin/owner's npi";
        source.env.OMP_PROFILE = "owner's profile";
        yield* service.open(ref);
        const result = yield* service.handoff(ref);
        assert.deepEqual(result, {
          sessionFile: "/native/session's file.jsonl",
          sessionId: "native-id",
          cwd: "/work/owner's project",
          command:
            "cd '/work/owner'\\''s project' && OMP_PROFILE='owner'\\''s profile' '/bin/owner'\\''s npi' --session '/native/session'\\''s file.jsonl'",
        });
        assert.equal(native.starts, 1);
        assert.equal(native.disposals, 1);
        assert.equal(native.connections, 0);
        assert.equal(native.aborts, 1);
        assert.equal((yield* Effect.result(service.modelsConnection(ref)))._tag, "Failure");
      }).pipe(Effect.scoped),
  );

  it.effect("detaches handoff observers without aborting or killing a terminal owner", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture("terminal");
      native.ownerPid = 42;
      yield* service.open(originalRef);
      const result = yield* Effect.result(service.handoff(originalRef));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.code, "session_in_use");
        assert.match(result.failure.message, /PID 42/);
      }
      assert.equal(native.detaches, 1);
      assert.equal(native.running, true);
      assert.equal(native.aborts, 0);
      assert.equal(native.disposals, 0);
      assert.equal(native.starts, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not implicitly open or release another profile during handoff", () =>
    Effect.gen(function* () {
      const { native, service } = yield* fixture();
      const missing = yield* Effect.result(service.handoff(originalRef));
      assert.equal(missing._tag, "Failure");
      assert.equal(native.starts, 0);
      yield* service.open(originalRef);
      const conflict = yield* Effect.result(
        service.handoff({ ...originalRef, providerInstanceId: otherId }),
      );
      assert.equal(conflict._tag, "Failure");
      if (conflict._tag === "Failure") assert.equal(conflict.failure.code, "profile_conflict");
      assert.equal(native.disposals, 0);
      assert.equal(native.connections, 1);
      native.sessionFile = "/native/switched.jsonl";
      native.sessionId = "switched";
      const changed = yield* Effect.result(service.handoff(originalRef));
      assert.equal(changed._tag, "Failure");
      if (changed._tag === "Failure") assert.equal(changed.failure.code, "session_changed");
      assert.equal(native.disposals, 0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "reads usage from the direct native owner only for its configured source lifetime",
    () =>
      Effect.gen(function* () {
        const { native, service, source } = yield* fixture();
        assert.equal(yield* readNeoPiLiveUsage(source, "provider"), undefined);
        yield* service.open(originalRef);
        assert.deepEqual(yield* readNeoPiLiveUsage(source, "provider"), {
          provider: "provider",
          redact: true,
        });
        assert.equal(yield* readNeoPiLiveUsage({ ...source }, "other"), undefined);
        yield* service.close({ ref: originalRef });
        assert.equal(yield* readNeoPiLiveUsage(source, "provider"), undefined);
        assert.deepEqual(native.usageRequests, ["provider"]);
      }).pipe(Effect.scoped),
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
        const first = (yield* snapshot(service, originalRef))[0];
        if (first?.type !== "snapshot") return assert.fail("Expected native snapshot");
        assert.deepEqual(first.session.ref, originalRef);
        assert.equal(first.session.state.sessionFile, originalRef.sessionFile);
        assert.deepEqual(first.journal, {
          sessionId: "native-id",
          sessionFile: originalRef.sessionFile,
          leafId: null,
          entries: [],
          totalEntries: 0,
        });
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
        const result = yield* Stream.runCollect(
          service.watch({ ref: originalRef }).pipe(Stream.take(5)),
        );
        assert.deepEqual(
          result
            .filter((event) => event.type === "event" && event.frame.type === "journal_entry")
            .map((event) => (event.type === "event" ? event.frame : null)),
          [
            {
              type: "journal_entry",
              sessionId: "native-id",
              sessionFile: originalRef.sessionFile,
              leafId: last.id,
              entry: first,
            },
            {
              type: "journal_entry",
              sessionId: "native-id",
              sessionFile: originalRef.sessionFile,
              leafId: last.id,
              entry: last,
            },
          ],
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
        yield* snapshot(service, originalRef);
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
        const hydrated = second[0];
        assert.equal(hydrated?.type, "snapshot");
        if (hydrated?.type === "snapshot") {
          assert.deepEqual(hydrated.journal, {
            sessionId: "native-id",
            sessionFile: originalRef.sessionFile,
            leafId: "native-admission",
            entries: [entry("native-admission")],
            totalEntries: 1,
          });
          assert.equal(hydrated.session.state.isStreaming, true);
        }
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
        const frames = yield* Stream.runCollect(
          service.watch({ ref: originalRef }).pipe(Stream.take(4)),
        );
        assert.deepEqual(
          frames
            .filter((event) => event.type === "event")
            .map((event) => (event.type === "event" ? event.frame : null)),
          [
            {
              type: "journal_state",
              reason: "snapshot",
              sessionId: "native-id",
              sessionFile: originalRef.sessionFile,
              leafId: null,
            },
            persisted,
            update,
          ],
        );
        assert.equal(
          frames.some((event) => event.type === "event" && event.frame.type === "journal_entry"),
          false,
        );
        const first = frames[0];
        if (first?.type === "snapshot")
          assert.deepEqual(first.journal, {
            sessionId: "native-id",
            sessionFile: originalRef.sessionFile,
            leafId: committed.id,
            entries: [committed],
            totalEntries: 1,
          });
        else assert.fail("Expected a native journal snapshot");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "delivers pending native UI before a blocked snapshot so answers can release native startup",
    () =>
      Effect.gen(function* () {
        const { native, service } = yield* fixture();
        native.startupDialog = true;
        native.blockSnapshot = true;
        yield* service.open({ ...originalRef });
        const received = yield* Deferred.make<void>();
        const observer = yield* service.watch({ ref: originalRef }).pipe(
          Stream.tap((event) =>
            event.type === "event" && event.frame.id === "native-dialog"
              ? Deferred.succeed(received, undefined)
              : Effect.void,
          ),
          Stream.filter((event) => event.type === "snapshot"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(received);
        yield* service.request({
          ref: originalRef,
          command: { type: "extension_ui_response", id: "native-dialog", confirmed: true },
        });
        const result = yield* Fiber.join(observer);
        assert.equal(result[0]?.type, "snapshot");
        assert.equal(native.running, true);
        assert.equal(native.disposals, 0);
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
        const mounted = yield* Effect.all([Deferred.make<void>(), Deferred.make<void>()]);
        const watchers = yield* Effect.all(
          mounted.map((ready) =>
            service.watch({ ref: originalRef }).pipe(
              Stream.tap((event) =>
                event.type === "event" && event.frame.id === "plan"
                  ? Deferred.succeed(ready, undefined)
                  : Effect.void,
              ),
              Stream.runCollect,
              Effect.forkChild,
            ),
          ),
        );
        yield* Effect.all(mounted.map(Deferred.await));
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
        const reconnect = yield* Stream.runCollect(
          service.watch({ ref: originalRef }).pipe(Stream.take(2)),
        );
        assert.equal(
          reconnect.some(
            (event) =>
              event.type === "event" &&
              (event.frame.type === "tool_approval_request" ||
                event.frame.type === "plan_proposal_request"),
          ),
          false,
        );
        yield* service.close({ ref: originalRef });
        for (const watcher of watchers) {
          const events = yield* Fiber.join(watcher);
          // Acknowledgements carry identity only, not private answer contents.
          assert.deepEqual(
            events.filter((event) => event.type === "answered"),
            [
              { type: "answered", id: "approval" },
              { type: "answered", id: "plan" },
            ],
          );
        }
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
      const frames = yield* Stream.runCollect(
        service.watch({ ref: originalRef }).pipe(Stream.take(2)),
      );
      assert.deepEqual(
        frames.map((event) => event.type),
        ["snapshot", "event"],
      );
      const event = frames[1];
      assert.equal(event?.type === "event" && event.frame.type, "journal_state");
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
});
