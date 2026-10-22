// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ApprovalRequestId,
  MessageId,
  ProviderDriverKind,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeNeoPiSessionRuntime, type NeoPiRuntimeInput } from "./NeoPiSessionRuntime.ts";
import type { NeoPiResumeCursor } from "./NeoPiRuntimeTypes.ts";
import { readNeoPiSessionConfiguration } from "./NeoPiSessionConfiguration.ts";
import { makeNeoPiAdapter } from "../Layers/NeoPiAdapter.ts";
import { makeNeoPiDiscoveryHub } from "./NeoPiDiscovery.ts";
import { makeOrchestrationIntegrationHarness } from "../../../integration/OrchestrationEngineHarness.integration.ts";

const root = "/tmp/neopi-runtime-tests";
const sessionDir = `${root}/neopi/sessions/default/test`;
const sessionFile = `${sessionDir}/session.jsonl`;
type Command = { id?: string; type: string; [key: string]: unknown };
const decodeCommand = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeCommand = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
type Emitter = (frame: unknown) => Effect.Effect<void>;
const defaultReady = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  capabilities: ["rpc-ui"],
};
const testPeer = Effect.fn("testPeer")(function* (
  handler: (cmd: Command, emit: Emitter) => Effect.Effect<void>,
  ready: unknown = defaultReady,
  startup?: { stdout?: unknown; stderr?: unknown },
  closeOnStdin: boolean = false,
) {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const exited = yield* Deferred.make<string | null>();
  const commands: Command[] = [];
  const signals: string[] = [];
  const emit: Emitter = (frame) =>
    Queue.offer(stdout, new TextEncoder().encode(`${JSON.stringify(frame)}\n`)).pipe(Effect.asVoid);
  const finish = (signal: string | null) =>
    Effect.gen(function* () {
      yield* Queue.end(stdout).pipe(Effect.ignore);
      yield* Deferred.succeed(exited, signal).pipe(Effect.ignore);
    });
  if (!startup) yield* emit(ready);
  yield* Effect.gen(function* () {
    let pending = "";
    while (true) {
      pending += new TextDecoder().decode(yield* Queue.take(stdin));
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const command = decodeCommand(line) as Command;
        commands.push(command);
        yield* ready === defaultReady && command.type === "negotiate_protocol"
          ? answer(command, emit, { protocolVersion: 2 })
          : handler(command, emit);
      }
    }
  }).pipe(Effect.ignore, Effect.forkScoped);
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    exitCode: Deferred.await(exited).pipe(
      Effect.flatMap((signal) =>
        signal
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "exitCode",
                cause: new Error(`Process interrupted due to receipt of signal: '${signal}'`),
              }),
            )
          : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      ),
    ),
    isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
    kill: (options) =>
      Effect.gen(function* () {
        signals.push(options?.killSignal ?? "SIGTERM");
        if (options?.forceKillAfter) {
          yield* Effect.sleep(options.forceKillAfter);
          signals.push("SIGKILL");
          yield* finish("SIGKILL");
        } else yield* finish(options?.killSignal ?? "SIGTERM");
      }),
    stdin: Sink.forEach((chunk: Uint8Array) => Queue.offer(stdin, chunk)).pipe(
      Sink.ensuring(closeOnStdin ? finish(null) : Effect.void),
    ),
    stdout: startup
      ? startup.stdout === undefined
        ? Stream.empty
        : Stream.make(new TextEncoder().encode(`${encodeCommand(startup.stdout)}\n`))
      : Stream.fromQueue(stdout),
    stderr:
      startup?.stderr === undefined
        ? Stream.empty
        : Stream.make(new TextEncoder().encode(`${encodeCommand(startup.stderr)}\n`)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
  return { handle, commands, emit, finish, signals };
});
const answer = (cmd: Command, emit: Emitter, data: unknown = {}) =>
  emit({ type: "response", id: cmd.id, command: cmd.type, success: true, data });
const basicHandler = (cmd: Command, emit: Emitter) =>
  cmd.type === "get_state"
    ? answer(cmd, emit, { sessionId: "s1", sessionFile, messageCount: 0 })
    : cmd.type === "get_entries"
      ? answer(cmd, emit, { entries: [], leafId: null })
      : answer(cmd, emit);
const make = (
  spawn: NeoPiRuntimeInput["spawn"],
  cursor?: { sessionId: string; sessionFile: string; sessionDir: string; v: 1; turnBoundaries: [] },
  hostBridge?: NeoPiRuntimeInput["hostBridge"],
  sharedSessionCapabilities?: ReadonlySet<string>,
) =>
  makeNeoPiSessionRuntime({
    threadId: "thread-test" as ThreadId,
    binary: "npi",
    cwd: "/tmp",
    t3Home: root,
    projectId: "test",
    runtimeMode: "approval-required",
    spawn,
    ...(cursor ? { cursor } : {}),
    ...(hostBridge ? { hostBridge } : {}),
    ...(sharedSessionCapabilities ? { sharedSessionCapabilities } : {}),
    closeGraceMs: 20,
  });
const turn = (id: string) => ({ turnId: id as TurnId, text: "hello", images: [] });
const capture = (runtime: Effect.Success<ReturnType<typeof make>>) =>
  Effect.gen(function* () {
    const frames: Array<Record<string, unknown>> = [];
    yield* Stream.runForEach(runtime.frames, (frame) =>
      Effect.sync(() => {
        frames.push(frame as Record<string, unknown>);
      }),
    ).pipe(Effect.forkScoped);
    return frames;
  });
const awaitOutcomes = (frames: Array<Record<string, unknown>>, count: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      const outcomes = frames.filter((frame) => frame.type === "t3.turn.outcome");
      if (outcomes.length >= count) return outcomes;
      yield* Effect.sleep("5 millis");
    }
    throw new Error(
      `Expected ${count} outcomes, observed ${frames.filter((frame) => frame.type === "t3.turn.outcome").length}`,
    );
  });

const attachedCursor = {
  v: 1 as const,
  sessionId: "s1",
  sessionFile: "/tmp/omp-sessions/session.jsonl",
  sessionDir: "/tmp/omp-sessions",
  sharedSession: true,
  turnBoundaries: [] as [],
};
const attachCapabilities = new Set(["session_lease", "session_catalog", "control_pipe"]);
const attachFixture = Effect.fn("attachFixture")(function* (
  endpoint: boolean = true,
  advertised: ReadonlySet<string> = attachCapabilities,
  configuration?: {
    state: () => Record<string, unknown>;
    roles: () => unknown;
  },
) {
  const busy = yield* testPeer(basicHandler, defaultReady, {
    stderr: {
      type: "startup_error",
      code: "session_in_use",
      pid: 42,
      sessionFile: attachedCursor.sessionFile,
    },
  });
  const catalog = yield* testPeer(basicHandler, defaultReady, {
    stdout: {
      version: 1,
      sessions: [
        {
          path: attachedCursor.sessionFile,
          inUse: { pid: 42 },
          control: endpoint ? { instanceId: "owner-instance" } : null,
        },
      ],
    },
  });
  const pipe = yield* testPeer(
    (cmd, emit) =>
      cmd.type === "negotiate_protocol"
        ? answer(cmd, emit, { protocolVersion: 2 })
        : cmd.type === "get_state"
          ? answer(cmd, emit, {
              sessionId: "s1",
              sessionFile: attachedCursor.sessionFile,
              messageCount: 3,
              ...configuration?.state(),
            })
          : cmd.type === "get_roles" && configuration
            ? answer(cmd, emit, configuration.roles())
            : basicHandler(cmd, emit),
    {
      ...defaultReady,
      capabilities: [
        "rpc-ui",
        "control_v1",
        "tool_approval_request",
        "set_mode",
        "set_chat_mode",
        ...(configuration ? ["get_roles"] : []),
      ],
    },
    undefined,
    true,
  );
  const launches: string[][] = [];
  const spawn: NeoPiRuntimeInput["spawn"] = (command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("Expected standard command");
    launches.push([...command.args]);
    if (command.args[0] === "sessions") return catalog.finish(null).pipe(Effect.as(catalog.handle));
    return Effect.succeed(command.args[0] === "ctl" ? pipe.handle : busy.handle);
  };
  const runtime = yield* make(
    spawn,
    attachedCursor,
    {
      definitions: [{ name: "host-tool", description: "test", parameters: {} }],
      handle: () => Effect.succeed({ content: [] }),
    },
    advertised,
  );
  return { runtime, launches, pipe, spawn };
});

const configurationRole = {
  id: "fast",
  alias: "fast",
  name: "Fast",
  source: "configured",
  configured: "provider/model:low",
  patterns: ["provider/model:low", "fallback/*"],
  resolved: { provider: "provider", modelId: "model", thinkingLevel: "low" },
  hidden: false,
};

it.live("refreshes attached configuration using reads while preserving the terminal owner", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let activeRole = "fast";
      const { runtime, pipe, launches } = yield* attachFixture(true, attachCapabilities, {
        state: () => ({
          activeRole,
          model: { provider: "provider", id: activeRole, name: activeRole, apiKey: "never expose" },
          thinkingLevel: activeRole === "fast" ? "low" : "high",
          systemPrompt: "never expose",
        }),
        roles: () => ({ roles: [configurationRole], activeRole }),
      });
      yield* runtime.start;
      const originalCursor = yield* SubscriptionRef.get(runtime.cursor);
      const launchCount = launches.length;
      const commandCount = pipe.commands.length;
      const first = yield* readNeoPiSessionConfiguration(runtime, attachedCursor);
      NodeAssert.equal(first.status, "available");
      NodeAssert.equal(first.attachment, "terminal");
      NodeAssert.equal(first.activeRole, "fast");
      NodeAssert.deepEqual(first.model, { provider: "provider", id: "fast", name: "fast" });
      NodeAssert.deepEqual(first.roles, {
        status: "available",
        items: [
          {
            id: "fast",
            alias: "fast",
            name: "Fast",
            configured: "provider/model:low",
            patterns: ["provider/model:low", "fallback/*"],
            resolved: { provider: "provider", modelId: "model", thinkingLevel: "low" },
            hidden: false,
          },
        ],
      });
      activeRole = "careful";
      const refreshed = yield* readNeoPiSessionConfiguration(runtime, attachedCursor);
      NodeAssert.equal(refreshed.status, "available");
      NodeAssert.equal(refreshed.activeRole, "careful");
      NodeAssert.equal(refreshed.thinkingLevel, "high");
      NodeAssert.equal(refreshed.model?.id, "careful");
      NodeAssert.deepEqual(
        pipe.commands.slice(commandCount).map((cmd) => cmd.type),
        ["get_state", "get_roles", "get_state", "get_state", "get_roles", "get_state"],
      );
      NodeAssert.equal(launches.length, launchCount);
      NodeAssert.deepEqual(pipe.signals, []);
      NodeAssert.deepEqual(yield* SubscriptionRef.get(runtime.cursor), originalCursor);
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reports unsupported roles and a disconnected attached runtime without starting it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, pipe, launches } = yield* attachFixture();
      const disconnected = yield* readNeoPiSessionConfiguration(runtime, attachedCursor);
      NodeAssert.equal(disconnected.status, "unavailable");
      NodeAssert.equal(launches.length, 0);
      yield* runtime.start;
      const commandCount = pipe.commands.length;
      const result = yield* readNeoPiSessionConfiguration(runtime, attachedCursor);
      NodeAssert.equal(result.status, "available");
      NodeAssert.equal(result.roles.status, "unsupported");
      NodeAssert.deepEqual(
        pipe.commands.slice(commandCount).map((cmd) => cmd.type),
        ["get_state", "get_state"],
      );
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects a native identity replacement while reading attached roles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let sessionId = "s1";
      const { runtime, pipe } = yield* attachFixture(true, attachCapabilities, {
        state: () => ({ sessionId }),
        roles: () => {
          sessionId = "replacement";
          return { roles: [configurationRole] };
        },
      });
      yield* runtime.start;
      const result = yield* readNeoPiSessionConfiguration(runtime, attachedCursor);
      NodeAssert.equal(result.status, "unavailable");
      NodeAssert.equal((yield* SubscriptionRef.get(runtime.cursor)).sessionId, "s1");
      NodeAssert.equal(
        pipe.commands.some((cmd) => cmd.type.startsWith("set_")),
        false,
      );
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reads owned configuration and rejects malformed advertised roles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let malformed = false;
      const peer = yield* testPeer(
        (cmd, emit) =>
          cmd.type === "negotiate_protocol"
            ? answer(cmd, emit, { protocolVersion: 2 })
            : cmd.type === "get_roles"
              ? answer(cmd, emit, malformed ? { roles: [{}] } : { roles: [configurationRole] })
              : basicHandler(cmd, emit),
        { ...defaultReady, capabilities: ["get_roles"] },
      );
      let launches = 0;
      const runtime = yield* make(() => {
        launches++;
        return Effect.succeed(peer.handle);
      });
      yield* runtime.start;
      const expected = yield* SubscriptionRef.get(runtime.cursor);
      const commandCount = peer.commands.length;
      const result = yield* readNeoPiSessionConfiguration(runtime, expected);
      NodeAssert.equal(result.status, "available");
      NodeAssert.equal(result.attachment, "owned");
      NodeAssert.equal(result.roles.status, "available");
      NodeAssert.equal(launches, 1);
      NodeAssert.deepEqual(
        peer.commands.slice(commandCount).map((cmd) => cmd.type),
        ["get_state", "get_roles", "get_state"],
      );
      malformed = true;
      const error = yield* Effect.flip(readNeoPiSessionConfiguration(runtime, expected));
      NodeAssert.match(error.message, /malformed role configuration/);
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "attaches a leased shared session through its advertised control endpoint without owner mutations",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runtime, launches, pipe } = yield* attachFixture();
        yield* capture(runtime);
        yield* runtime.start;
        NodeAssert.deepEqual(launches[1], [
          "sessions",
          "list",
          "--json",
          "--session-dir",
          attachedCursor.sessionDir,
        ]);
        NodeAssert.deepEqual(launches[2], ["ctl", "pipe", "owner-instance", "--label", "neocode"]);
        NodeAssert.equal(runtime.capabilities.has("control_v1"), true);
        NodeAssert.deepEqual(
          pipe.commands.map((cmd) => cmd.type),
          ["negotiate_protocol", "get_state"],
        );
        const modeError = yield* Effect.flip(runtime.setRuntimeMode("full-access"));
        NodeAssert.match(modeError.message, /attached.*owned by another process/);
        const noTurn = yield* Effect.flip(runtime.interrupt);
        NodeAssert.equal(noTurn.code, "not_running");
        yield* runtime.stop;
        NodeAssert.equal(
          pipe.commands.some((cmd) => cmd.type === "abort"),
          false,
        );
        NodeAssert.deepEqual(
          pipe.signals,
          [],
          "Detaching closes stdin, not the owner or even the pipe process",
        );
        NodeAssert.equal(
          pipe.commands.some((cmd) => cmd.type.startsWith("set_")),
          false,
        );
        NodeAssert.equal(
          (yield* SubscriptionRef.get(runtime.cursor)).sessionFile,
          attachedCursor.sessionFile,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("refuses every owner mutation through an attached runtime boundary", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, pipe } = yield* attachFixture();
      yield* runtime.start;
      for (const type of [
        "set_chat_mode",
        "set_mode",
        "set_model",
        "set_thinking_level",
        "set_fast_mode",
        "set_role",
        "set_approval_handler",
        "set_host_tools",
        "set_interrupt_mode",
        "set_subagent_subscription",
        "compact",
        "branch",
        "steer",
        "abort",
      ]) {
        const error = yield* Effect.flip(runtime.request({ type }).pipe(Effect.asVoid));
        NodeAssert.match(error.message, /attached.*owned by another process/);
      }
      const compactError = yield* Effect.flip(runtime.compact());
      NodeAssert.match(compactError.message, /attached.*owned by another process/);
      const modelError = yield* Effect.flip(
        runtime.applyModelSelection({
          instanceId: ProviderInstanceId.make("neopi"),
          model: "provider/model",
        }),
      );
      NodeAssert.match(modelError.message, /attached.*owned by another process/);
      const frameError = yield* Effect.flip(
        runtime.writeFrame({
          type: "plan_proposal_response",
          id: "owner-plan",
          decision: "approve",
        }),
      );
      NodeAssert.match(frameError.message, /attached.*owned by another process/);
      const uiError = yield* Effect.flip(runtime.respondUi({ id: "owner-ui", cancelled: true }));
      NodeAssert.match(uiError.message, /attached.*owned by another process/);
      NodeAssert.deepEqual(
        pipe.commands.map((cmd) => cmd.type),
        ["negotiate_protocol", "get_state"],
      );
      yield* runtime.startTurn(turn("attached-prompt"));
      const steerError = yield* Effect.flip(runtime.steer(turn("attached-steer")));
      NodeAssert.match(steerError.message, /attached.*owned by another process/);
      yield* runtime.interrupt;
      NodeAssert.equal(pipe.commands.filter((cmd) => cmd.type === "prompt").length, 1);
      NodeAssert.equal(pipe.commands.filter((cmd) => cmd.type === "abort").length, 1);
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("names the lease holder when no control endpoint exists and never spawns a pipe", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, launches } = yield* attachFixture(false);
      const error = yield* Effect.flip(runtime.start);
      NodeAssert.equal(error.code, "session_in_use");
      NodeAssert.match(error.message, /PID 42/);
      NodeAssert.match(error.message, /open elsewhere without a control socket/);
      NodeAssert.equal(launches.length, 2);
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("retains the original lease error when the CLI does not advertise control pipes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, launches } = yield* attachFixture(
        true,
        new Set(["session_lease", "session_catalog"]),
      );
      const error = yield* Effect.flip(runtime.start);
      NodeAssert.equal(error.code, "session_in_use");
      NodeAssert.match(error.message, /already in use.*PID 42/);
      NodeAssert.equal(launches.length, 1);
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("does not invoke session catalog commands unless the capability was advertised", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, launches } = yield* attachFixture(
        true,
        new Set(["session_lease", "control_pipe"]),
      );
      const error = yield* Effect.flip(runtime.start);
      NodeAssert.match(error.message, /without a control socket/);
      NodeAssert.match(error.message, /PID 42/);
      NodeAssert.equal(launches.length, 1);
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "publishes external native identities without SQL turns and relaunches after owner exit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* attachFixture();
        const freePeer = yield* testPeer(
          (cmd, emit) =>
            cmd.type === "negotiate_protocol"
              ? answer(cmd, emit, { protocolVersion: 2 })
              : cmd.type === "get_state"
                ? answer(cmd, emit, {
                    sessionId: "s1",
                    sessionFile: attachedCursor.sessionFile,
                    messageCount: 3,
                  })
                : basicHandler(cmd, emit),
          { ...defaultReady, capabilities: ["rpc-ui", "session_lease"] },
        );
        let normalLaunches = 0;
        const runtime = yield* make(
          (command) => {
            if (ChildProcess.isStandardCommand(command) && command.args[0] === "--mode") {
              normalLaunches++;
              if (normalLaunches > 1) return Effect.succeed(freePeer.handle);
            }
            return fixture.spawn(command);
          },
          attachedCursor,
          undefined,
          attachCapabilities,
        );
        const exited = yield* Deferred.make<void>();
        const frames: Array<Record<string, unknown>> = [];
        yield* Stream.runForEach(runtime.frames, (frame) =>
          Effect.gen(function* () {
            frames.push(frame as Record<string, unknown>);
            if (frame.type === "t3.session.exited") yield* Deferred.succeed(exited, undefined);
          }),
        ).pipe(Effect.forkScoped);
        const native = yield* runtime.observeNative!;
        const persisted = yield* Deferred.make<void>();
        const nativeFrames: Array<Record<string, unknown>> = [];
        yield* Stream.runForEach(native, (frame) => Effect.gen(function* () {
          nativeFrames.push(frame);
          if (frame.type === "message_persisted") yield* Deferred.succeed(persisted, undefined);
        })).pipe(Effect.forkScoped);
        yield* runtime.start;
        yield* fixture.pipe.emit({ type: "agent_start" });
        yield* fixture.pipe.emit({ type: "message_start", messageId: "msg-external", message: { role: "assistant", content: [] } });
        yield* fixture.pipe.emit({ type: "message_update", messageId: "msg-external", assistantMessageEvent: { type: "text_delta", delta: "terminal" } });
        yield* fixture.pipe.emit({ type: "message_end", messageId: "msg-external", message: { role: "assistant", content: [{ type: "text", text: "terminal" }] } });
        yield* fixture.pipe.emit({ type: "message_persisted", sessionId: "s1", sessionFile: attachedCursor.sessionFile, leafId: "entry-external", messageId: "msg-external", entryId: "entry-external" });
        yield* Deferred.await(persisted);
        NodeAssert.deepEqual(nativeFrames.filter((frame) => typeof frame.messageId === "string").map((frame) => frame.messageId), ["msg-external", "msg-external", "msg-external", "msg-external"]);
        NodeAssert.equal(nativeFrames.some((frame) => "turnId" in frame), false);
        yield* fixture.pipe.emit({ type: "agent_end", messages: [] });
        yield* fixture.pipe.finish(null);
        yield* Deferred.await(exited);
        NodeAssert.equal(
          frames.some(
            (frame) =>
              frame.type === "agent_start" ||
              frame.type === "agent_end" ||
              frame.type === "t3.turn.outcome",
          ),
          false,
        );
        NodeAssert.deepEqual((yield* SubscriptionRef.get(runtime.cursor)).turnBoundaries, []);
        yield* runtime.start;
        NodeAssert.equal(normalLaunches, 2);
        NodeAssert.equal(runtime.capabilities.has("control_v1"), false);
        yield* runtime.stop;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "rejects attached rollback, chat mode changes and compaction before mutating the owner",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { spawn, pipe } = yield* attachFixture();
        const threadId = ThreadId.make("attached-thread");
        const instanceId = ProviderInstanceId.make("attached-neopi");
        const adapter = yield* makeNeoPiAdapter({
          settings: {
            enabled: true,
            binaryPath: "npi",
            profile: "",
            launchArgs: "",
            customModels: [],
          },
          instanceId,
          binary: "npi",
          cwd: "/tmp",
          t3Home: root,
          attachmentsDir: root,
          environment: {},
          spawn,
          discovery: yield* makeNeoPiDiscoveryHub(),
          sharedSessionCapabilities: attachCapabilities,
        });
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("neopi"),
          providerInstanceId: instanceId,
          cwd: "/tmp",
          runtimeMode: "approval-required",
          resumeCursor: attachedCursor,
        });
        const error = yield* Effect.flip(adapter.rollbackThread(threadId, 1));
        NodeAssert.match(error.message, /attached.*owned by another process/);
        const chatError = yield* Effect.flip(
          adapter.sendTurn({
            threadId,
            input: "/chat raw",
            interactionMode: "default",
          }),
        );
        NodeAssert.match(chatError.message, /attached.*owned by another process/);
        const compactError = yield* Effect.flip(adapter.compaction.start(threadId));
        NodeAssert.match(compactError.message, /attached.*owned by another process/);
        NodeAssert.equal(
          pipe.commands.some(
            (cmd) =>
              cmd.type === "abort" ||
              cmd.type === "branch" ||
              cmd.type === "compact" ||
              cmd.type.startsWith("set_"),
          ),
          false,
        );
        yield* adapter.stopAll();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
it.live("uses shared files only with both lease and fresh-session capabilities", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const advertised of [
        [],
        ["session_lease"],
        ["new_session"],
        ["session_lease", "new_session"],
      ]) {
        const shared = advertised.length === 2;
        const file = shared ? "/tmp/omp-sessions/session.jsonl" : sessionFile;
        const peer = yield* testPeer(
          (cmd, emit) =>
            cmd.type === "negotiate_protocol"
              ? answer(cmd, emit, { protocolVersion: 2 })
              : cmd.type === "get_state"
                ? answer(cmd, emit, { sessionId: "s1", sessionFile: file, messageCount: 0 })
                : basicHandler(cmd, emit),
          { ...defaultReady, capabilities: ["rpc-ui", ...advertised] },
        );
        const launches: ReadonlyArray<string>[] = [];
        const runtime = yield* make(
          (command) =>
            Effect.sync(() => {
              if (!ChildProcess.isStandardCommand(command))
                throw new Error("Expected a standard NeoPi command");
              launches.push(command.args);
              return peer.handle;
            }),
          undefined,
          undefined,
          new Set(advertised),
        );
        yield* runtime.start;
        NodeAssert.equal(launches[0]?.includes("--new-session"), shared);
        NodeAssert.equal(launches[0]?.includes("--session-dir"), !shared);
        NodeAssert.equal(
          (yield* SubscriptionRef.get(runtime.cursor)).sessionDir,
          shared ? "/tmp/omp-sessions" : sessionDir,
        );
        yield* runtime.stop;
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("refuses to reopen a shared session when the replacement peer lacks a lease", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sharedCursor = {
        v: 1 as const,
        sessionId: "s1",
        sessionFile: "/tmp/omp-sessions/session.jsonl",
        sessionDir: "/tmp/omp-sessions",
        sharedSession: true,
        turnBoundaries: [] as [],
      };
      for (const [advertised, expected] of [
        [[], false],
        [["session_lease"], true],
      ] as const) {
        const peer = yield* testPeer(
          (cmd, emit) =>
            cmd.type === "negotiate_protocol"
              ? answer(cmd, emit, { protocolVersion: 2 })
              : cmd.type === "get_state"
                ? answer(cmd, emit, {
                    sessionId: "s1",
                    sessionFile: sharedCursor.sessionFile,
                    messageCount: 0,
                  })
                : basicHandler(cmd, emit),
          { ...defaultReady, capabilities: ["rpc-ui", ...advertised] },
        );
        const runtime = yield* make(
          () => Effect.succeed(peer.handle),
          sharedCursor,
          undefined,
          new Set(advertised),
        );
        if (expected) yield* runtime.start;
        else NodeAssert.equal((yield* Effect.flip(runtime.start)).code, "startup");
        yield* runtime.stop;
      }
      const unsupported = yield* make(
        () => Effect.die("A peer without lease support must never open the shared file"),
        sharedCursor,
        undefined,
        new Set(),
      );
      NodeAssert.equal((yield* Effect.flip(unsupported.start)).code, "startup");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("routes role aliases through set_role only when get_roles is advertised", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const advertiseRole of [false, true]) {
        const peer = yield* testPeer(
          (cmd, emit) =>
            cmd.type === "negotiate_protocol"
              ? answer(cmd, emit, { protocolVersion: 2 })
              : basicHandler(cmd, emit),
          {
            ...defaultReady,
            capabilities: advertiseRole ? ["rpc-ui", "get_roles"] : ["rpc-ui"],
          },
        );
        const runtime = yield* make(() => Effect.succeed(peer.handle));
        yield* runtime.start;
        yield* runtime.applyModelSelection({
          instanceId: ProviderInstanceId.make("neopi"),
          model: "@smol",
        });
        NodeAssert.deepEqual(
          peer.commands
            .filter((command) => command.type === "set_role")
            .map(({ id: _, ...command }) => command),
          advertiseRole ? [{ type: "set_role", role: "smol" }] : [],
        );
        yield* runtime.stop;
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("holds a plan proposal until refine feedback continues a new T3 turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let promptStarted = false;
      const peer = yield* testPeer(
        (cmd, emit) =>
          Effect.gen(function* () {
            if (cmd.type === "negotiate_protocol")
              return yield* answer(cmd, emit, { protocolVersion: 2 });
            if (cmd.type === "get_entries")
              return yield* answer(
                cmd,
                emit,
                promptStarted
                  ? {
                      entries: [
                        {
                          id: "native-user",
                          type: "message",
                          parentId: null,
                          message: { role: "user", content: [{ type: "text", text: "plan this" }] },
                        },
                        {
                          id: "proposal-tool",
                          type: "message",
                          parentId: "native-user",
                          message: {
                            role: "assistant",
                            content: [{ type: "text", text: "# Plan" }],
                          },
                        },
                      ],
                      leafId: "proposal-tool",
                    }
                  : { entries: [], leafId: null },
              );
            if (cmd.type === "prompt") {
              promptStarted = true;
              yield* answer(cmd, emit, { agentInvoked: true });
              yield* emit({ type: "agent_start" });
              yield* emit({
                type: "plan_proposal_request",
                id: "proposal-1",
                title: "Plan",
                planFilePath: "xd://plan/test",
                planMarkdown: "# Plan",
              });
              return;
            }
            if (cmd.type === "plan_proposal_response") {
              yield* emit({
                type: "agent_end",
                isTerminal: true,
                messages: [{ role: "assistant", stopReason: "stop" }],
              });
              return;
            }
            yield* basicHandler(cmd, emit);
          }),
        { ...defaultReady, capabilities: ["rpc-ui", "set_mode"] },
      );
      const runtime = yield* make(() => Effect.succeed(peer.handle));
      const frames = yield* capture(runtime);
      yield* runtime.start;
      yield* runtime.startTurn({ ...turn("source"), text: "plan this" });
      yield* awaitOutcomes(frames, 1);
      NodeAssert.equal(
        peer.commands.some((cmd) => cmd.type === "plan_proposal_response"),
        false,
      );
      NodeAssert.deepEqual((yield* SubscriptionRef.get(runtime.cursor)).turnBoundaries, [
        { turnId: "source", userEntryId: "native-user" },
      ]);
      yield* runtime.resolvePlanProposal(
        { decision: "refine", feedback: "Please simplify step two" },
        { ...turn("refine"), text: "Please simplify step two" },
      );
      yield* awaitOutcomes(frames, 2);
      NodeAssert.deepEqual(
        peer.commands
          .filter((cmd) => cmd.type === "plan_proposal_response")
          .map(({ type, id, decision, feedback }) => ({ type, id, decision, feedback })),
        [
          {
            type: "plan_proposal_response",
            id: "proposal-1",
            decision: "refine",
            feedback: "Please simplify step two",
          },
        ],
      );
      NodeAssert.deepEqual((yield* SubscriptionRef.get(runtime.cursor)).turnBoundaries, [
        { turnId: "source", userEntryId: "native-user" },
        { turnId: "refine", kind: "continuation", afterEntryId: "proposal-tool" },
      ]);
      NodeAssert.equal(
        frames.some((frame) => frame.type === "t3.turn.outcome" && frame.turnId === "refine"),
        true,
      );
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("continues approved plan work in the implementation turn without a second prompt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let prompted = false;
      const peer = yield* testPeer(
        (cmd, emit) =>
          Effect.gen(function* () {
            if (cmd.type === "negotiate_protocol")
              return yield* answer(cmd, emit, { protocolVersion: 2 });
            if (cmd.type === "get_entries")
              return yield* answer(
                cmd,
                emit,
                prompted
                  ? {
                      leafId: "plan-leaf",
                      entries: [
                        {
                          id: "plan-leaf",
                          parentId: null,
                          type: "message",
                          message: { role: "user", content: [{ type: "text", text: "plan" }] },
                        },
                      ],
                    }
                  : { leafId: null, entries: [] },
              );
            if (cmd.type === "prompt") {
              prompted = true;
              yield* answer(cmd, emit, { agentInvoked: true });
              yield* emit({ type: "agent_start" });
              yield* emit({ type: "plan_proposal_request", id: "plan-1", planMarkdown: "# Plan" });
              return;
            }
            if (cmd.type === "plan_proposal_response") {
              yield* emit({ type: "mode_changed", mode: "default" });
              yield* emit({
                type: "tool_execution_start",
                toolCallId: "implement-tool",
                toolName: "bash",
              });
              yield* emit({
                type: "message_end",
                message: { role: "assistant", content: [], usage: { input: 12, output: 7 } },
              });
              yield* emit({ type: "agent_end", isTerminal: true });
              return;
            }
            yield* basicHandler(cmd, emit);
          }),
        { ...defaultReady, capabilities: ["rpc-ui", "set_mode"] },
      );
      const runtime = yield* make(() => Effect.succeed(peer.handle));
      const frames = yield* capture(runtime);
      yield* runtime.start;
      yield* runtime.startTurn(turn("plan"));
      yield* awaitOutcomes(frames, 1);
      yield* runtime.resolvePlanProposal({ decision: "approve" }, turn("implementation"));
      yield* awaitOutcomes(frames, 2);
      NodeAssert.equal(peer.commands.filter((cmd) => cmd.type === "prompt").length, 1);
      NodeAssert.ok(
        frames.some(
          (frame) => frame.type === "tool_execution_start" && frame.turnId === "implementation",
        ),
      );
      NodeAssert.deepEqual((yield* SubscriptionRef.get(runtime.cursor)).turnBoundaries, [
        { turnId: "plan", userEntryId: "plan-leaf" },
        { turnId: "implementation", kind: "continuation", afterEntryId: "plan-leaf" },
      ]);
      NodeAssert.ok(
        frames.some((frame) => frame.type === "message_end" && frame.turnId === "implementation"),
      );
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("does not admit an implementation after its proposal cancels during boundary lookup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let admit = false;
      const peer = yield* testPeer(
        (cmd, emit) =>
          Effect.gen(function* () {
            if (cmd.type === "negotiate_protocol")
              return yield* answer(cmd, emit, { protocolVersion: 2 });
            if (cmd.type === "get_entries") {
              if (admit) {
                yield* Deferred.succeed(entered, undefined).pipe(Effect.ignore);
                yield* Deferred.await(release);
              }
              return yield* answer(cmd, emit, { entries: [], leafId: "plan-leaf" });
            }
            if (cmd.type === "prompt") {
              yield* answer(cmd, emit, { agentInvoked: true });
              yield* emit({ type: "agent_start" });
              yield* emit({ type: "plan_proposal_request", id: "plan", planMarkdown: "# Plan" });
              return;
            }
            yield* basicHandler(cmd, emit);
          }),
        { ...defaultReady, capabilities: ["rpc-ui", "set_mode", "plan_proposal_cancel"] },
      );
      const runtime = yield* make(() => Effect.succeed(peer.handle));
      const frames = yield* capture(runtime);
      yield* runtime.start;
      yield* runtime.startTurn(turn("plan"));
      yield* awaitOutcomes(frames, 1);
      admit = true;
      const admission = yield* runtime
        .resolvePlanProposal({ decision: "approve" }, turn("implementation"))
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* peer.emit({ type: "plan_proposal_cancel", id: "plan", reason: "abort" });
      yield* peer.emit({ type: "agent_end", isTerminal: true });
      for (
        let attempt = 0;
        attempt < 100 && !frames.some((frame) => frame.type === "t3.plan.proposal.closed");
        attempt++
      )
        yield* Effect.sleep("5 millis");
      NodeAssert.ok(frames.some((frame) => frame.type === "t3.plan.proposal.closed"));
      yield* Deferred.succeed(release, undefined);
      NodeAssert.equal((yield* Effect.flip(Fiber.join(admission))).code, "not_ready");
      NodeAssert.equal(
        peer.commands.filter((cmd) => cmd.type === "plan_proposal_response").length,
        0,
      );
      NodeAssert.equal(
        (yield* SubscriptionRef.get(runtime.cursor)).turnBoundaries.some(
          (boundary) => boundary.turnId === "implementation",
        ),
        false,
      );
      NodeAssert.equal(yield* SubscriptionRef.get(runtime.state), "ready");
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("fails a provisional implementation when the peer rejects its late proposal response", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let prompted = false;
      const peer = yield* testPeer(
        (cmd, emit) =>
          Effect.gen(function* () {
            if (cmd.type === "negotiate_protocol")
              return yield* answer(cmd, emit, { protocolVersion: 2 });
            if (cmd.type === "get_entries")
              return yield* answer(cmd, emit, { entries: [], leafId: "plan-leaf" });
            if (cmd.type === "prompt") {
              prompted = true;
              yield* answer(cmd, emit, { agentInvoked: true });
              yield* emit({ type: "agent_start" });
              yield* emit({ type: "plan_proposal_request", id: "plan", planMarkdown: "# Plan" });
              return;
            }
            if (cmd.type === "plan_proposal_response" && prompted)
              return yield* emit({
                type: "response",
                command: "plan_proposal_response",
                id: cmd.id,
                success: false,
                error: "proposal was cancelled",
                code: "proposal_cancelled",
              });
            yield* basicHandler(cmd, emit);
          }),
        { ...defaultReady, capabilities: ["rpc-ui", "set_mode", "plan_proposal_cancel"] },
      );
      const runtime = yield* make(() => Effect.succeed(peer.handle));
      const frames = yield* capture(runtime);
      yield* runtime.start;
      yield* runtime.startTurn(turn("plan"));
      yield* awaitOutcomes(frames, 1);
      yield* runtime.resolvePlanProposal({ decision: "approve" }, turn("implementation"));
      const outcomes = yield* awaitOutcomes(frames, 2);
      NodeAssert.deepEqual(
        outcomes.map((frame) => ({ turnId: frame.turnId, state: frame.state })),
        [
          { turnId: "plan", state: "completed" },
          { turnId: "implementation", state: "failed" },
        ],
      );
      NodeAssert.equal(
        (yield* SubscriptionRef.get(runtime.cursor)).turnBoundaries.some(
          (boundary) => boundary.turnId === "implementation",
        ),
        false,
      );
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("withdrawal waits for the old native run to end before a new prompt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* testPeer(
        (cmd, emit) =>
          Effect.gen(function* () {
            if (cmd.type === "negotiate_protocol")
              return yield* answer(cmd, emit, { protocolVersion: 2 });
            if (cmd.type === "prompt") {
              yield* answer(cmd, emit, { agentInvoked: true });
              yield* emit({ type: "agent_start" });
              yield* emit({ type: "plan_proposal_request", id: "plan", planMarkdown: "# Plan" });
              return;
            }
            if (cmd.type === "set_mode") {
              yield* emit({ type: "plan_proposal_cancel", id: "plan", reason: "mode_change" });
              yield* emit({ type: "mode_changed", mode: "default" });
              return yield* answer(cmd, emit, { mode: "default" });
            }
            yield* basicHandler(cmd, emit);
          }),
        { ...defaultReady, capabilities: ["rpc-ui", "set_mode", "plan_proposal_cancel"] },
      );
      const runtime = yield* make(() => Effect.succeed(peer.handle));
      const frames = yield* capture(runtime);
      yield* runtime.start;
      yield* runtime.startTurn(turn("plan"));
      yield* awaitOutcomes(frames, 1);
      const completed = yield* Deferred.make<void>();
      const withdrawal = yield* runtime
        .resolvePlanProposal({ decision: "withdraw" })
        .pipe(Effect.andThen(Deferred.succeed(completed, undefined)), Effect.forkScoped);
      for (
        let attempt = 0;
        attempt < 100 && !frames.some((frame) => frame.type === "t3.plan.proposal.closed");
        attempt++
      )
        yield* Effect.sleep("5 millis");
      NodeAssert.ok(frames.some((frame) => frame.type === "t3.plan.proposal.closed"));
      NodeAssert.equal(yield* Deferred.isDone(completed), false);
      NodeAssert.equal(
        peer.commands.filter((cmd) => cmd.type === "plan_proposal_response").length,
        0,
      );
      yield* peer.emit({ type: "agent_end", isTerminal: true });
      yield* Fiber.join(withdrawal);
      NodeAssert.equal(yield* Deferred.isDone(completed), true);
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("expires a native proposal when its unanswered request times out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* testPeer(
        (cmd, emit) =>
          Effect.gen(function* () {
            if (cmd.type === "negotiate_protocol")
              return yield* answer(cmd, emit, { protocolVersion: 2 });
            if (cmd.type === "prompt") {
              yield* answer(cmd, emit, { agentInvoked: true });
              yield* emit({ type: "agent_start" });
              yield* emit({ type: "plan_proposal_request", id: "expired", planMarkdown: "# Plan" });
              return;
            }
            yield* basicHandler(cmd, emit);
          }),
        { ...defaultReady, capabilities: ["rpc-ui", "set_mode"] },
      );
      const runtime = yield* make(() => Effect.succeed(peer.handle));
      const frames = yield* capture(runtime);
      yield* runtime.start;
      yield* runtime.startTurn(turn("plan"));
      yield* awaitOutcomes(frames, 1);
      yield* peer.emit({ type: "agent_end", isTerminal: true });
      for (
        let attempt = 0;
        attempt < 100 && !frames.some((frame) => frame.type === "t3.plan.proposal.closed");
        attempt++
      )
        yield* Effect.sleep("5 millis");
      NodeAssert.ok(frames.some((frame) => frame.type === "t3.plan.proposal.closed"));
      const failure = yield* Effect.flip(
        runtime.resolvePlanProposal({ decision: "approve" }, turn("implement")),
      );
      NodeAssert.equal(failure.code, "not_ready");
      NodeAssert.equal(
        peer.commands.filter((cmd) => cmd.type === "plan_proposal_response").length,
        0,
      );
      yield* runtime.startTurn(turn("mode-cancelled"));
      yield* awaitOutcomes(frames, 2);
      yield* peer.emit({ type: "mode_changed", mode: "default" });
      for (
        let attempt = 0;
        attempt < 100 &&
        frames.filter((frame) => frame.type === "t3.plan.proposal.closed").length < 2;
        attempt++
      )
        yield* Effect.sleep("5 millis");
      NodeAssert.equal(
        frames.filter((frame) => frame.type === "t3.plan.proposal.closed").length,
        2,
      );
      NodeAssert.equal(
        (yield* Effect.flip(
          runtime.resolvePlanProposal({ decision: "approve" }, turn("cancelled-implement")),
        )).code,
        "not_ready",
      );
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("uses plan cancellation frames only on peers that advertise them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const advertised of [false, true]) {
        const peer = yield* testPeer(
          (cmd, emit) =>
            Effect.gen(function* () {
              if (cmd.type === "negotiate_protocol")
                return yield* answer(cmd, emit, { protocolVersion: 2 });
              if (cmd.type === "prompt") {
                yield* answer(cmd, emit, { agentInvoked: true });
                yield* emit({ type: "agent_start" });
                yield* emit({
                  type: "plan_proposal_request",
                  id: "proposal",
                  planMarkdown: "# Plan",
                });
                return;
              }
              yield* basicHandler(cmd, emit);
            }),
          {
            ...defaultReady,
            capabilities: ["rpc-ui", "set_mode", ...(advertised ? ["plan_proposal_cancel"] : [])],
          },
        );
        const runtime = yield* make(() => Effect.succeed(peer.handle));
        const frames = yield* capture(runtime);
        yield* runtime.start;
        yield* runtime.startTurn(turn("plan"));
        yield* awaitOutcomes(frames, 1);
        yield* peer.emit({ type: "plan_proposal_cancel", id: "wrong", reason: "abort" });
        yield* peer.emit({ type: "agent_end", isTerminal: true });
        yield* peer.emit({ type: "mode_changed", mode: "default" });
        yield* peer.emit({ type: "plan_proposal_cancel", id: "proposal", reason: "abort" });
        for (
          let attempt = 0;
          attempt < 100 &&
          frames.filter((frame) => frame.type === "plan_proposal_cancel").length < 2;
          attempt++
        )
          yield* Effect.sleep("5 millis");
        NodeAssert.equal(
          frames.filter((frame) => frame.type === "t3.plan.proposal.closed").length,
          1,
        );
        const closedAt = frames.findIndex((frame) => frame.type === "t3.plan.proposal.closed");
        const cancelledAt = frames.findIndex(
          (frame) => frame.type === "plan_proposal_cancel" && frame.id === "proposal",
        );
        NodeAssert.equal(closedAt > cancelledAt, advertised);
        NodeAssert.equal(
          (yield* Effect.flip(runtime.resolvePlanProposal({ decision: "approve" }))).code,
          "not_ready",
        );
        yield* runtime.stop;
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("takes advertised prompt entry ids rather than inferred ancestry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const advertised of [false, true]) {
        let prompted = false;
        const peer = yield* testPeer(
          (cmd, emit) =>
            Effect.gen(function* () {
              if (cmd.type === "negotiate_protocol")
                return yield* answer(cmd, emit, { protocolVersion: 2 });
              if (cmd.type === "get_entries")
                return yield* answer(
                  cmd,
                  emit,
                  prompted
                    ? {
                        leafId: "native-user",
                        entries: [
                          {
                            id: "extension-user",
                            parentId: null,
                            type: "message",
                            message: { role: "user" },
                          },
                          {
                            id: "native-user",
                            parentId: "extension-user",
                            type: "message",
                            message: { role: "user" },
                          },
                        ],
                      }
                    : { leafId: null, entries: [] },
                );
              if (cmd.type === "prompt") {
                prompted = true;
                yield* answer(cmd, emit, { agentInvoked: true, userEntryId: "native-user" });
                yield* emit({ type: "agent_start" });
                yield* emit({ type: "agent_end", isTerminal: true });
                return;
              }
              yield* basicHandler(cmd, emit);
            }),
          {
            ...defaultReady,
            capabilities: ["rpc-ui", ...(advertised ? ["prompt_entry_ids"] : [])],
          },
        );
        const runtime = yield* make(() => Effect.succeed(peer.handle));
        const frames = yield* capture(runtime);
        yield* runtime.start;
        yield* SubscriptionRef.update(runtime.cursor, (cursor) => ({
          ...cursor,
          historyLeafId: "imported-leaf",
        }));
        yield* runtime.startTurn(turn("prompt"));
        yield* awaitOutcomes(frames, 1);
        NodeAssert.deepEqual((yield* SubscriptionRef.get(runtime.cursor)).turnBoundaries, [
          { turnId: "prompt", userEntryId: advertised ? "native-user" : "extension-user" },
        ]);
        NodeAssert.equal((yield* SubscriptionRef.get(runtime.cursor)).historyLeafId, undefined);
        yield* runtime.stop;
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("distinguishes persisted local entries from reserved and absent prompt ids", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const scenario of [
        { id: "committed", persisted: true, boundary: { userEntryId: "committed" } },
        { id: "reserved", persisted: false, boundary: { kind: "local" } },
        { id: undefined, persisted: false, boundary: { kind: "local" } },
      ] as const) {
        const peer = yield* testPeer(
          (cmd, emit) =>
            cmd.type === "negotiate_protocol"
              ? answer(cmd, emit, { protocolVersion: 2 })
              : cmd.type === "prompt"
                ? answer(cmd, emit, {
                    agentInvoked: false,
                    ...(scenario.id ? { userEntryId: scenario.id } : {}),
                  })
                : cmd.type === "get_entries"
                  ? answer(cmd, emit, {
                      entries: scenario.persisted
                        ? [
                            {
                              id: scenario.id,
                              parentId: null,
                              type: "message",
                              message: { role: "user" },
                            },
                          ]
                        : [],
                      leafId: scenario.persisted ? scenario.id : null,
                    })
                  : basicHandler(cmd, emit),
          { ...defaultReady, capabilities: ["rpc-ui", "prompt_entry_ids"] },
        );
        const runtime = yield* make(() => Effect.succeed(peer.handle));
        const frames = yield* capture(runtime);
        yield* runtime.start;
        yield* runtime.startTurn(turn("local"));
        yield* awaitOutcomes(frames, 1);
        NodeAssert.deepEqual((yield* SubscriptionRef.get(runtime.cursor)).turnBoundaries, [
          { turnId: "local", ...scenario.boundary },
        ]);
        yield* runtime.stop;
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("opts into host tool approvals before prompting only when the peer advertises them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const supported of [false, true]) {
        let handlerSelected = false;
        const peer = yield* testPeer(
          (cmd, emit) =>
            Effect.gen(function* () {
              if (cmd.type === "negotiate_protocol")
                return yield* answer(cmd, emit, { protocolVersion: 2 });
              if (cmd.type === "set_approval_handler") {
                handlerSelected = cmd.handler === "host";
                return yield* answer(cmd, emit, { handler: "host" });
              }
              if (cmd.type === "prompt") {
                yield* answer(cmd, emit, { agentInvoked: true });
                if (handlerSelected)
                  yield* emit({
                    type: "tool_approval_request",
                    id: "approval-1",
                    toolName: "bash",
                    toolCallId: "tool-1",
                    args: { command: "echo yes" },
                  });
                return;
              }
              yield* basicHandler(cmd, emit);
            }),
          {
            ...defaultReady,
            capabilities: supported ? ["rpc-ui", "tool_approval_request"] : ["rpc-ui"],
          },
        );
        const runtime = yield* make(() => Effect.succeed(peer.handle));
        const frames = yield* capture(runtime);
        yield* runtime.start;
        yield* runtime.startTurn(turn("approval"));
        if (supported)
          for (
            let i = 0;
            i < 100 && !frames.some((frame) => frame.type === "tool_approval_request");
            i++
          )
            yield* Effect.sleep("5 millis");
        NodeAssert.equal(handlerSelected, supported);
        NodeAssert.equal(
          frames.some((frame) => frame.type === "tool_approval_request"),
          supported,
        );
        NodeAssert.equal(
          peer.commands.filter((cmd) => cmd.type === "set_approval_handler").length,
          supported ? 1 : 0,
        );
        yield* runtime.stop;
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reapplies structured approval after restart and rejects a declined handler", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peerFor = (handler: "host" | "ui") =>
        testPeer(
          (cmd, emit) =>
            cmd.type === "negotiate_protocol"
              ? answer(cmd, emit, { protocolVersion: 2 })
              : cmd.type === "set_approval_handler"
                ? answer(cmd, emit, { handler })
                : basicHandler(cmd, emit),
          { ...defaultReady, capabilities: ["rpc-ui", "tool_approval_request"] },
        );
      const first = yield* peerFor("host");
      const second = yield* peerFor("host");
      const declined = yield* peerFor("ui");
      const peers = [first, second];
      let launches = 0;
      const runtime = yield* make(() => Effect.succeed(peers[launches++]!.handle));
      yield* runtime.start;
      yield* runtime.restart("runtime-mode-change");
      NodeAssert.equal(launches, 2);
      for (const peer of peers)
        NodeAssert.equal(
          peer.commands.filter((command) => command.type === "set_approval_handler").length,
          1,
        );
      yield* runtime.stop;
      const unsupported = yield* make(() => Effect.succeed(declined.handle));
      const failure = yield* Effect.flip(unsupported.start);
      NodeAssert.equal(failure.code, "startup");
      NodeAssert.match(failure.message, /did not activate its host approval handler/);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("interrupting a pending plan proposal refuses it without approval", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* testPeer(
        (cmd, emit) =>
          Effect.gen(function* () {
            if (cmd.type === "negotiate_protocol")
              return yield* answer(cmd, emit, { protocolVersion: 2 });
            if (cmd.type === "prompt") {
              yield* answer(cmd, emit, { agentInvoked: true });
              yield* emit({ type: "agent_start" });
              yield* emit({
                type: "plan_proposal_request",
                id: "pending-plan",
                planMarkdown: "# Plan",
              });
              return;
            }
            if (cmd.type === "abort") {
              yield* answer(cmd, emit);
              yield* emit({ type: "agent_end", isTerminal: true });
              return;
            }
            yield* basicHandler(cmd, emit);
          }),
        { ...defaultReady, capabilities: ["rpc-ui", "set_mode"] },
      );
      const runtime = yield* make(() => Effect.succeed(peer.handle));
      const frames = yield* capture(runtime);
      yield* runtime.start;
      yield* runtime.startTurn({ ...turn("source"), text: "plan this" });
      yield* awaitOutcomes(frames, 1);
      yield* runtime.interrupt;
      NodeAssert.deepEqual(
        peer.commands
          .filter((cmd) => cmd.type === "plan_proposal_response")
          .map(({ type, id, decision }) => ({ type, id, decision })),
        [{ type: "plan_proposal_response", id: "pending-plan", decision: "refine" }],
      );
      NodeAssert.equal(
        peer.commands.some((cmd) => cmd.type === "abort"),
        true,
      );
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects a v1-only peer during live session admission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* testPeer(basicHandler, { type: "ready", protocolVersion: 1 });
      const runtime = yield* make(() => Effect.succeed(peer.handle));
      const error = yield* Effect.flip(runtime.start);
      NodeAssert.equal(error.code, "startup");
      NodeAssert.match(error.message, /protocol v2/);
      NodeAssert.equal(
        peer.commands.some((cmd) => cmd.type === "get_state"),
        false,
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects auto-resumed fresh sessions and mismatched resume ids, closing both peers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const cursor of [
        undefined,
        { v: 1 as const, sessionFile, sessionId: "expected", sessionDir, turnBoundaries: [] as [] },
      ]) {
        const peer = yield* testPeer((cmd, emit) =>
          cmd.type === "get_state"
            ? answer(cmd, emit, { sessionId: "unexpected", sessionFile, messageCount: 3 })
            : basicHandler(cmd, emit),
        );
        const runtime = yield* make(() => Effect.succeed(peer.handle), cursor);
        const failure = yield* runtime.start.pipe(Effect.flip);
        NodeAssert.equal(failure.code, "identity_mismatch");
        NodeAssert.equal(yield* SubscriptionRef.get(runtime.state), "failed");
        NodeAssert.ok(peer.signals.includes("SIGKILL"));
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
it.live(
  "settles late rejection, local response, local prompt_result and terminal agent_end exactly once",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const peer = yield* testPeer((cmd, emit) =>
          Effect.gen(function* () {
            if (cmd.type !== "prompt") return yield* basicHandler(cmd, emit);
            if (cmd.message === "reject") {
              yield* answer(cmd, emit);
              yield* emit({
                type: "response",
                id: cmd.id,
                command: "prompt",
                success: false,
                error: "denied",
              });
            } else if (cmd.message === "data-local")
              yield* answer(cmd, emit, { agentInvoked: false });
            else if (cmd.message === "event-local") {
              yield* answer(cmd, emit);
              yield* emit({ type: "command_output", text: "local output" });
              yield* emit({ type: "prompt_result", id: cmd.id, agentInvoked: false });
            } else {
              yield* answer(cmd, emit, { agentInvoked: true });
              yield* emit({ type: "agent_start" });
              yield* emit({ type: "agent_end", isTerminal: false, hasFinalResponse: true });
              yield* emit({ type: "agent_end", isTerminal: true });
            }
          }),
        );
        const runtime = yield* make(() => Effect.succeed(peer.handle));
        const frames = yield* capture(runtime);
        yield* runtime.start;
        for (const [i, text] of ["reject", "data-local", "event-local", "agent"].entries()) {
          yield* runtime.startTurn({ ...turn(`turn-${i}`), text });
          const outcomes = yield* awaitOutcomes(frames, i + 1);
          NodeAssert.equal(outcomes[i]?.state, i === 0 ? "failed" : "completed");
          NodeAssert.equal(yield* SubscriptionRef.get(runtime.state), "ready");
        }
        NodeAssert.equal(frames.filter((frame) => frame.type === "t3.turn.outcome").length, 4);
        NodeAssert.deepEqual(
          (yield* SubscriptionRef.get(runtime.cursor)).turnBoundaries.map((boundary) =>
            "kind" in boundary ? boundary.kind : boundary.userEntryId,
          ),
          ["unknown", "local", "local", "unknown"],
        );
        NodeAssert.ok(
          frames.findIndex((frame) => frame.type === "command_output") <
            frames.findIndex(
              (frame) => frame.turnId === "turn-2" && frame.type === "t3.turn.outcome",
            ),
        );
        yield* runtime.stop;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
it.live(
  "steers only running turns, interrupts at terminal end and captures one user boundary per prompt",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let ordinal = 0;
        const entries: Array<{
          id: string;
          parentId: string | null;
          type: string;
          message: { role: string; content: Array<{ type: string; text: string }> };
        }> = [];
        const append = (id: string, text: string) => {
          entries.push({
            id,
            parentId: entries.at(-1)?.id ?? null,
            type: "message",
            message: { role: "user", content: [{ type: "text", text }] },
          });
        };
        const peer = yield* testPeer((cmd, emit) =>
          Effect.gen(function* () {
            if (cmd.type === "get_entries") {
              return yield* answer(cmd, emit, {
                entries,
                leafId: entries.at(-1)?.id ?? null,
              });
            }
            if (cmd.type === "prompt") {
              ordinal++;
              append(`user-${ordinal}`, `expanded: ${String(cmd.message)}`);
              append(`hidden-${ordinal}`, "extension instruction");
              yield* answer(cmd, emit, { agentInvoked: true });
              yield* emit({ type: "agent_start" });
              return;
            }
            if (cmd.type === "steer") append("steer-1", String(cmd.message));
            return yield* basicHandler(cmd, emit);
          }),
        );
        const runtime = yield* make(() => Effect.succeed(peer.handle));
        const frames = yield* capture(runtime);
        yield* runtime.start;
        NodeAssert.equal(
          (yield* runtime.steer(turn("unused")).pipe(Effect.flip)).code,
          "not_running",
        );
        yield* runtime.startTurn(turn("t1"));
        yield* runtime.steer(turn("steer-not-a-turn"));
        NodeAssert.equal(
          (yield* runtime.restart("runtime-mode-change").pipe(Effect.flip)).code,
          "not_ready",
        );
        yield* peer.emit({ type: "agent_end", isTerminal: true });
        yield* awaitOutcomes(frames, 1);
        yield* runtime.startTurn(turn("t2"));
        yield* runtime.interrupt;
        yield* peer.emit({ type: "agent_end", isTerminal: true });
        const outcomes = yield* awaitOutcomes(frames, 2);
        NodeAssert.deepEqual(
          outcomes.map((event) => [event.turnId, event.state]),
          [
            ["t1", "completed"],
            ["t2", "interrupted"],
          ],
        );
        const cursor = yield* SubscriptionRef.get(runtime.cursor);
        NodeAssert.deepEqual(
          cursor.turnBoundaries.map((boundary) =>
            "userEntryId" in boundary ? boundary.userEntryId : boundary.kind,
          ),
          ["user-1", "user-2"],
        );
        NodeAssert.ok(peer.commands.some((cmd) => cmd.type === "get_entries"));
        NodeAssert.equal(peer.commands.filter((cmd) => cmd.type === "steer").length, 1);
        NodeAssert.equal(peer.commands.filter((cmd) => cmd.type === "abort").length, 1);
        yield* runtime.stop;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
it.live("restarts with the verified cursor and updated approval mode", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peers = [yield* testPeer(basicHandler), yield* testPeer(basicHandler)];
      const args: string[][] = [];
      let index = 0;
      const runtime = yield* make((cmd) =>
        Effect.sync(() => {
          NodeAssert.equal(cmd._tag, "StandardCommand");
          if (cmd._tag !== "StandardCommand") throw new Error("unexpected piped command");
          args.push([...cmd.args]);
          return peers[index++]!.handle;
        }),
      );
      yield* runtime.start;
      yield* runtime.setRuntimeMode("auto");
      NodeAssert.equal(args.length, 2);
      NodeAssert.equal(args[1]?.[args[1]!.indexOf("--session") + 1], sessionFile);
      NodeAssert.equal(args[1]?.[args[1]!.indexOf("--approval-mode") + 1], "yolo");
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
it.live(
  "fails one running turn on unexpected process exit and cancels pending UI and host requests",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const peer = yield* testPeer((cmd, emit) =>
          cmd.type === "prompt"
            ? answer(cmd, emit, { agentInvoked: true })
            : basicHandler(cmd, emit),
        );
        const runtime = yield* make(() => Effect.succeed(peer.handle));
        const frames = yield* capture(runtime);
        yield* runtime.start;
        yield* runtime.startTurn(turn("exit-turn"));
        yield* peer.emit({
          type: "extension_ui_request",
          id: "ui1",
          method: "select",
          title: "Approve",
        });
        yield* peer.finish("SIGKILL");
        const outcomes = yield* awaitOutcomes(frames, 1);
        NodeAssert.equal(outcomes[0]?.state, "failed");
        NodeAssert.equal(yield* SubscriptionRef.get(runtime.state), "failed");
        NodeAssert.ok(
          frames.some((frame) => frame.type === "t3.session.exited" && frame.recoverable === true),
        );
        NodeAssert.ok(
          frames.some((frame) => frame.method === "cancel" && frame.targetId === "ui1"),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
it.live("removes a dead adapter session after mock peer exit and resumes on the next send", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-test");
      const instanceId = ProviderInstanceId.make("neopi-exit-test");
      const adapterHandler = (cmd: Command, emit: Emitter) =>
        cmd.type === "get_state"
          ? answer(cmd, emit, {
              sessionId: "s1",
              sessionFile: `${root}/neopi/sessions/default/thread-test/session.jsonl`,
              messageCount: 0,
            })
          : cmd.type === "prompt"
            ? answer(cmd, emit, { agentInvoked: true })
            : basicHandler(cmd, emit);
      const peers = [yield* testPeer(adapterHandler), yield* testPeer(adapterHandler)];
      let launches = 0;
      const adapter = yield* makeNeoPiAdapter({
        settings: {
          enabled: true,
          binaryPath: "npi",
          profile: "",
          launchArgs: "",
          customModels: [],
        },
        instanceId,
        binary: "npi",
        cwd: "/tmp",
        t3Home: root,
        attachmentsDir: root,
        environment: {},
        spawn: () => Effect.succeed(peers[launches++]!.handle),
        discovery: yield* makeNeoPiDiscoveryHub(),
      });
      const events: Array<{ type: string; payload: unknown }> = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ).pipe(Effect.forkScoped);
      const sessionInput = {
        threadId,
        provider: ProviderDriverKind.make("neopi"),
        providerInstanceId: instanceId,
        cwd: "/tmp",
        runtimeMode: "approval-required" as const,
      };
      const first = yield* adapter.startSession(sessionInput);
      yield* adapter.sendTurn({ threadId, input: "before exit" });
      yield* peers[0]!.finish("SIGKILL");
      for (
        let attempt = 0;
        attempt < 200 &&
        !(
          events.some((event) => event.type === "session.exited") &&
          !(yield* adapter.hasSession(threadId))
        );
        attempt++
      )
        yield* Effect.sleep("5 millis");
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
      NodeAssert.ok(
        events.some(
          (event) =>
            event.type === "session.exited" &&
            (event.payload as { recoverable?: boolean; exitKind?: string }).recoverable === true &&
            (event.payload as { exitKind?: string }).exitKind === "error",
        ),
      );
      const resumed = yield* adapter.startSession({
        ...sessionInput,
        resumeCursor: first.resumeCursor,
      });
      NodeAssert.equal(resumed.status, "ready");
      yield* adapter.sendTurn({ threadId, input: "after exit" });
      NodeAssert.equal(launches, 2);
      yield* adapter.stopAll();
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("cancels pending UI and host work and kills a peer ignoring EOF and SIGTERM", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* testPeer(basicHandler);
      const signals: AbortSignal[] = [];
      const runtime = yield* make(() => Effect.succeed(peer.handle), undefined, {
        definitions: [{ name: "preview", description: "preview", parameters: {} }],
        handle: (_call, signal) =>
          Effect.sync(() => {
            signals.push(signal);
          }).pipe(Effect.andThen(Effect.never)),
      });
      const frames = yield* capture(runtime);
      yield* runtime.start;
      yield* peer.emit({
        type: "extension_ui_request",
        id: "select-pending",
        method: "select",
        title: "Approve?",
      });
      yield* peer.emit({
        type: "host_tool_call",
        id: "host-pending",
        toolCallId: "tc1",
        toolName: "preview",
        arguments: {},
      });
      for (
        let i = 0;
        i < 100 && (signals.length === 0 || !frames.some((frame) => frame.id === "select-pending"));
        i++
      )
        yield* Effect.sleep("5 millis");
      NodeAssert.equal(signals.length, 1);
      yield* runtime.stop;
      NodeAssert.equal(yield* SubscriptionRef.get(runtime.state), "stopped");
      NodeAssert.ok(peer.signals.includes("SIGKILL"));
      NodeAssert.equal(signals[0]?.aborted, true);
      NodeAssert.ok(
        frames.some((frame) => frame.method === "cancel" && frame.targetId === "select-pending"),
      );
      NodeAssert.ok(
        frames.some(
          (frame) => frame.type === "host_tool_cancel" && frame.targetId === "host-pending",
        ),
      );
      NodeAssert.ok(
        peer.commands.some(
          (cmd) =>
            cmd.type === "extension_ui_response" &&
            cmd.id === "select-pending" &&
            cmd.cancelled === true,
        ),
      );
      for (let i = 0; i < 100 && !frames.some((frame) => frame.type === "t3.session.exited"); i++)
        yield* Effect.sleep("5 millis");
      NodeAssert.ok(
        frames.some(
          (frame) =>
            frame.type === "t3.session.exited" &&
            frame.recoverable === false &&
            frame.signal === "SIGKILL",
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
it.live(
  "defers a running mode change until the following turn and classifies streamed errors",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let ordinal = 0;
        const handler = (cmd: Command, emit: Emitter) =>
          Effect.gen(function* () {
            if (cmd.type === "get_entries")
              return yield* answer(cmd, emit, {
                entries: [
                  {
                    id: `user-${ordinal}`,
                    type: "message",
                    message: { role: "user", content: [{ type: "text", text: "hello" }] },
                  },
                ],
                leafId: `leaf-${ordinal}`,
              });
            if (cmd.type === "prompt") {
              ordinal++;
              yield* answer(cmd, emit, { agentInvoked: true });
              yield* emit({ type: "agent_start" });
              return;
            }
            yield* basicHandler(cmd, emit);
          });
        const peers = [yield* testPeer(handler), yield* testPeer(handler)];
        const args: string[][] = [];
        let index = 0;
        const runtime = yield* make((cmd) =>
          Effect.sync(() => {
            NodeAssert.equal(cmd._tag, "StandardCommand");
            if (cmd._tag !== "StandardCommand") throw new Error("unexpected piped command");
            args.push([...cmd.args]);
            return peers[index++]!.handle;
          }),
        );
        const frames = yield* capture(runtime);
        yield* runtime.start;
        yield* runtime.startTurn(turn("first"));
        const deferred = yield* runtime.setRuntimeMode("full-access").pipe(Effect.flip);
        NodeAssert.equal(deferred.code, "runtime_mode_deferred");
        NodeAssert.ok(deferred.message.includes("takes effect after the current turn"));
        yield* peers[0]!.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "error",
            reason: "error",
            error: { errorMessage: "upstream failed" },
          },
        });
        yield* peers[0]!.emit({ type: "agent_end", isTerminal: true });
        NodeAssert.equal((yield* awaitOutcomes(frames, 1))[0]?.state, "failed");
        yield* runtime.startTurn(turn("second"));
        NodeAssert.equal(args.length, 2);
        NodeAssert.equal(args[1]?.[args[1]!.indexOf("--approval-mode") + 1], "yolo");
        yield* peers[1]!.emit({
          type: "message_update",
          assistantMessageEvent: { type: "error", reason: "aborted", error: {} },
        });
        yield* peers[1]!.emit({ type: "agent_end", isTerminal: true });
        NodeAssert.equal((yield* awaitOutcomes(frames, 2))[1]?.state, "interrupted");
        yield* runtime.stop;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("treats recovered nonterminal errors as a successful original turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* testPeer((cmd, emit) =>
        cmd.type === "prompt"
          ? answer(cmd, emit, { agentInvoked: true }).pipe(
              Effect.andThen(emit({ type: "agent_start" })),
            )
          : basicHandler(cmd, emit),
      );
      const runtime = yield* make(() => Effect.succeed(peer.handle));
      const frames = yield* capture(runtime);
      yield* runtime.start;
      yield* runtime.startTurn(turn("retry-success"));
      yield* peer.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "error",
          reason: "error",
          error: { errorMessage: "temporary provider failure" },
        },
      });
      yield* peer.emit({ type: "agent_end", isTerminal: false });
      yield* peer.emit({ type: "agent_start" });
      yield* peer.emit({ type: "message_start", message: { role: "assistant" } });
      yield* peer.emit({
        type: "agent_end",
        isTerminal: true,
        messages: [{ role: "assistant", stopReason: "stop" }],
      });
      const outcomes = yield* awaitOutcomes(frames, 1);
      NodeAssert.equal(outcomes[0]?.state, "completed");
      NodeAssert.equal(outcomes[0]?.errorMessage, undefined);
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("answers first-session startup UI through ProviderService before v2 negotiation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let negotiateId: string | undefined;
      const peer = yield* testPeer(
        (cmd, emit) => {
          if (cmd.type === "negotiate_protocol") {
            negotiateId = cmd.id;
            return emit({
              type: "extension_ui_request",
              id: "startup-input",
              method: "confirm",
              title: "Enable extension?",
              message: "Continue?",
            });
          }
          if (cmd.type === "extension_ui_response" && negotiateId)
            return answer({ type: "negotiate_protocol", id: negotiateId }, emit, {
              protocolVersion: 2,
            });
          if (cmd.type === "get_state")
            return answer(cmd, emit, {
              sessionId: "s1",
              sessionFile: `${root}/neopi/sessions/default/thread-test/session.jsonl`,
              messageCount: 0,
            });
          return answer(cmd, emit);
        },
        {
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [2],
          capabilities: ["rpc-ui"],
        },
      );
      const threadId = ThreadId.make("thread-test");
      const adapter = yield* makeNeoPiAdapter({
        settings: {
          enabled: true,
          binaryPath: "npi",
          profile: "",
          launchArgs: "",
          customModels: [],
        },
        instanceId: ProviderInstanceId.make("neopi"),
        binary: "npi",
        cwd: "/tmp",
        t3Home: root,
        attachmentsDir: root,
        environment: {},
        spawn: () => Effect.succeed(peer.handle),
        discovery: yield* makeNeoPiDiscoveryHub(),
      });
      const provider = ProviderDriverKind.make("neopi");
      const instanceId = ProviderInstanceId.make("neopi");
      const projectId = ProjectId.make("neopi-startup-test-project");
      const harness = yield* makeOrchestrationIntegrationHarness({ provider, adapter });
      yield* Effect.addFinalizer(() => harness.dispose);
      const createdAt = "2026-09-27T00:00:00.000Z";
      yield* harness.engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("neopi-startup-project-create"),
        projectId,
        title: "NeoPi startup",
        workspaceRoot: harness.workspaceDir,
        defaultModelSelection: { instanceId, model: "neopi-current" },
        createdAt,
      });
      yield* harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("neopi-startup-thread-create"),
        threadId,
        projectId,
        title: "Startup UI",
        modelSelection: { instanceId, model: "neopi-current" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: harness.workspaceDir,
        createdAt,
      });
      yield* Stream.runForEach(harness.providerService.streamEvents, (event) =>
        event.type === "user-input.requested"
          ? harness.providerService.respondToUserInput({
              threadId,
              requestId: ApprovalRequestId.make(event.requestId!),
              answers: { "startup-input": "true" },
            })
          : Effect.void,
      ).pipe(Effect.forkScoped);
      const session = yield* harness.providerService
        .startSession(threadId, {
          threadId,
          provider,
          providerInstanceId: instanceId,
          cwd: harness.workspaceDir,
          runtimeMode: "approval-required",
        })
        .pipe(Effect.timeout("5 seconds"));
      NodeAssert.ok(session.status === "ready" || session.status === "connecting");
      for (
        let attempt = 0;
        attempt < 200 &&
        !(yield* adapter.listSessions()).some(
          (current) => current.threadId === threadId && current.status === "ready",
        );
        attempt++
      )
        yield* Effect.sleep("5 millis");
      NodeAssert.equal(
        (yield* adapter.listSessions()).find((current) => current.threadId === threadId)?.status,
        "ready",
      );
      NodeAssert.ok(
        peer.commands.some((cmd) => cmd.type === "extension_ui_response" && cmd.confirmed === true),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "answers first-turn startup dialogs and reports later startup failures through the command reactor",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const kind of ["user-input", "approval", "session-in-use"] as const) {
          const id = `startup-${kind}`;
          const threadId = ThreadId.make(`startup-reactor-${kind}`);
          const sessionFile = `${root}/neopi/sessions/default/${threadId}/session.jsonl`;
          let startupAnswered = false;
          let stateRequest: Command | undefined;
          const peer = yield* testPeer((cmd, emit) => {
            if (cmd.type === "get_state" && !startupAnswered) {
              stateRequest = cmd;
              return emit(
                kind !== "approval"
                  ? {
                      type: "extension_ui_request",
                      id,
                      method: "confirm",
                      title: "Startup check",
                      message: "Continue startup?",
                    }
                  : {
                      type: "extension_ui_request",
                      id,
                      method: "select",
                      title: "Allow tool: bash\nCommand: echo ready",
                      options: ["Approve", "Deny"],
                    },
              );
            }
            if (cmd.type === "extension_ui_response" && stateRequest) {
              startupAnswered = true;
              return kind === "session-in-use"
                ? emit({
                    type: "response",
                    id: stateRequest.id,
                    command: "get_state",
                    success: false,
                    code: "session_in_use",
                    error: "session_in_use: session already owned by PID 42",
                  })
                : answer(stateRequest, emit, {
                    sessionId: "s1",
                    sessionFile,
                    messageCount: 0,
                  });
            }
            if (cmd.type === "get_state")
              return answer(cmd, emit, { sessionId: "s1", sessionFile, messageCount: 0 });
            if (cmd.type === "prompt")
              return answer(cmd, emit, { agentInvoked: true }).pipe(
                Effect.andThen(emit({ type: "agent_start" })),
                Effect.andThen(emit({ type: "agent_end", isTerminal: true })),
              );
            return answer(cmd, emit);
          });
          const provider = ProviderDriverKind.make("neopi");
          const instanceId = ProviderInstanceId.make("neopi");
          const projectId = ProjectId.make(`startup-reactor-project-${kind}`);
          let launches = 0;
          const adapter = yield* makeNeoPiAdapter({
            settings: {
              enabled: true,
              binaryPath: "npi",
              profile: "",
              launchArgs: "",
              customModels: [],
            },
            instanceId,
            binary: "npi",
            cwd: "/tmp",
            t3Home: root,
            attachmentsDir: root,
            environment: {},
            spawn: () =>
              Effect.sync(() => {
                launches++;
                return peer.handle;
              }),
            discovery: yield* makeNeoPiDiscoveryHub(),
          });
          const harness = yield* makeOrchestrationIntegrationHarness({ provider, adapter });
          yield* Effect.addFinalizer(() => harness.dispose);
          const createdAt = "2026-09-27T00:00:00.000Z";
          yield* harness.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make(`startup-reactor-project-create-${kind}`),
            projectId,
            title: "NeoPi startup",
            workspaceRoot: harness.workspaceDir,
            defaultModelSelection: { instanceId, model: "neopi-current" },
            createdAt,
          });
          yield* harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`startup-reactor-thread-create-${kind}`),
            threadId,
            projectId,
            title: "Startup UI",
            modelSelection: { instanceId, model: "neopi-current" },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: harness.workspaceDir,
            createdAt,
          });
          const opened = yield* Deferred.make<string>();
          yield* Stream.runForEach(harness.providerService.streamEvents, (event) =>
            event.requestId === id &&
            event.type === (kind === "approval" ? "request.opened" : "user-input.requested")
              ? Deferred.succeed(opened, event.requestId).pipe(Effect.asVoid)
              : Effect.void,
          ).pipe(Effect.forkScoped);
          yield* harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`startup-reactor-turn-${kind}`),
            threadId,
            message: {
              messageId: MessageId.make(`startup-reactor-message-${kind}`),
              role: "user",
              text: "Run after startup",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt,
          });
          NodeAssert.equal(yield* Deferred.await(opened).pipe(Effect.timeout("5 seconds")), id);
          yield* harness.engine.dispatch(
            kind !== "approval"
              ? {
                  type: "thread.user-input.respond",
                  commandId: CommandId.make(`startup-reactor-response-${kind}`),
                  threadId,
                  requestId: ApprovalRequestId.make(id),
                  answers: { [id]: "true" },
                  createdAt,
                }
              : {
                  type: "thread.approval.respond",
                  commandId: CommandId.make(`startup-reactor-response-${kind}`),
                  threadId,
                  requestId: ApprovalRequestId.make(id),
                  decision: "accept",
                  createdAt,
                },
          );
          for (
            let attempt = 0;
            attempt < 200 &&
            !peer.commands.some((cmd) => cmd.type === "extension_ui_response" && cmd.id === id);
            attempt++
          )
            yield* Effect.sleep("5 millis");
          NodeAssert.ok(
            peer.commands.some(
              (cmd) =>
                cmd.type === "extension_ui_response" &&
                cmd.id === id &&
                (kind === "approval" ? cmd.value === "Approve" : cmd.confirmed === true),
            ),
            `The ${kind} answer did not reach the startup peer`,
          );
          if (kind === "session-in-use") {
            const failed = yield* harness.waitForThread(
              threadId,
              (thread) =>
                thread.activities.some(
                  (activity) => activity.kind === "provider.turn.start.failed",
                ),
              5_000,
            );
            const failure = failed.activities.find(
              (activity) => activity.kind === "provider.turn.start.failed",
            );
            NodeAssert.match(
              String((failure?.payload as { detail?: string } | undefined)?.detail),
              /session_in_use/,
            );
            NodeAssert.equal(launches, 1, "Startup failure must not trigger session recovery");
            NodeAssert.equal(
              peer.commands.some((cmd) => cmd.type === "prompt"),
              false,
            );
            continue;
          }
          for (
            let attempt = 0;
            attempt < 200 && !peer.commands.some((cmd) => cmd.type === "prompt");
            attempt++
          )
            yield* Effect.sleep("5 millis");
          NodeAssert.ok(peer.commands.some((cmd) => cmd.type === "prompt"));
          const completed = yield* harness.waitForThread(
            threadId,
            (thread) =>
              thread.session?.status === "ready" &&
              thread.activities.some(
                (activity) =>
                  activity.kind ===
                  (kind === "user-input" ? "user-input.resolved" : "approval.resolved"),
              ),
          );
          NodeAssert.equal(
            completed.activities.some(
              (activity) =>
                activity.kind === "provider.user-input.respond.failed" ||
                activity.kind === "provider.approval.respond.failed",
            ),
            false,
          );
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("installs host tools without credential frames and suppresses cancelled results", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* testPeer(basicHandler);
      const signals: AbortSignal[] = [];
      const runtime = yield* make(() => Effect.succeed(peer.handle), undefined, {
        definitions: [
          {
            name: "list_thread_pull_requests",
            description: "List PRs",
            parameters: { type: "object" },
            loadMode: "discoverable",
          },
        ],
        handle: (_call, signal) =>
          Effect.sync(() => {
            signals.push(signal);
          }).pipe(Effect.andThen(Effect.never)),
      });
      yield* runtime.start;
      NodeAssert.deepEqual(
        peer.commands.find((command) => command.type === "set_host_tools")?.tools,
        [
          {
            name: "list_thread_pull_requests",
            description: "List PRs",
            parameters: { type: "object" },
            loadMode: "discoverable",
          },
        ],
      );
      NodeAssert.equal(encodeCommand(peer.commands).includes("Bearer "), false);
      yield* peer.emit({
        type: "host_tool_call",
        id: "host-cancelled",
        toolCallId: "tool-cancelled",
        toolName: "list_thread_pull_requests",
        arguments: {},
      });
      for (let count = 0; count < 100 && signals.length === 0; count++)
        yield* Effect.sleep("5 millis");
      NodeAssert.equal(signals.length, 1);
      yield* peer.emit({
        type: "host_tool_cancel",
        id: "cancel-frame",
        targetId: "host-cancelled",
      });
      for (let count = 0; count < 100 && signals[0]?.aborted !== true; count++)
        yield* Effect.sleep("5 millis");
      NodeAssert.equal(signals[0]?.aborted, true);
      NodeAssert.equal(
        peer.commands.some((cmd) => cmd.type === "host_tool_result" && cmd.id === "host-cancelled"),
        false,
      );
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("answers unexpected host calls with an explicit error when no bridge is installed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* testPeer(basicHandler);
      const runtime = yield* make(() => Effect.succeed(peer.handle));
      yield* runtime.start;
      yield* peer.emit({
        type: "host_tool_call",
        id: "unsupported-call",
        toolCallId: "tool-1",
        toolName: "unknown_host_tool",
        arguments: {},
      });
      for (
        let count = 0;
        count < 100 && !peer.commands.some((cmd) => cmd.type === "host_tool_result");
        count++
      )
        yield* Effect.sleep("5 millis");
      const result = peer.commands.find((cmd) => cmd.type === "host_tool_result");
      NodeAssert.equal(result?.id, "unsupported-call");
      NodeAssert.equal(result?.isError, true);
      NodeAssert.match(encodeCommand(result), /Unsupported host tool/);
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "routes capability-gated chat changes to RPC and exposes mode through adapter activities",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let mode: "off" | "chat" | "erp" | "raw" = "off";
        const peer = yield* testPeer(
          (cmd, emit) => {
            if (cmd.type === "get_entries") return answer(cmd, emit, { entries: [], leafId: null });
            if (cmd.type === "get_messages_page") return answer(cmd, emit, { messages: [] });
            if (cmd.type === "negotiate_protocol") return answer(cmd, emit, { protocolVersion: 2 });
            if (cmd.type === "get_state")
              return answer(cmd, emit, {
                sessionId: "s1",
                sessionFile: `${root}/neopi/sessions/default/thread-test/session.jsonl`,
                messageCount: 0,
                chatMode: mode,
              });
            if (cmd.type === "set_chat_mode") {
              if (
                cmd.mode === "off" ||
                cmd.mode === "chat" ||
                cmd.mode === "erp" ||
                cmd.mode === "raw"
              )
                mode = cmd.mode;
              return answer(cmd, emit, { mode }).pipe(
                Effect.andThen(emit({ type: "chat_mode_changed", mode })),
              );
            }
            return answer(cmd, emit);
          },
          {
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [2],
            capabilities: ["rpc-ui", "set_chat_mode"],
          },
        );
        const threadId = ThreadId.make("thread-test");
        const adapter = yield* makeNeoPiAdapter({
          settings: {
            enabled: true,
            binaryPath: "npi",
            profile: "",
            launchArgs: "",
            customModels: [],
          },
          instanceId: ProviderInstanceId.make("neopi-chat-test"),
          binary: "npi",
          cwd: "/tmp",
          t3Home: root,
          attachmentsDir: root,
          environment: {},
          spawn: () => Effect.succeed(peer.handle),
          discovery: yield* makeNeoPiDiscoveryHub(),
        });
        const warnings: unknown[] = [];
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            if (event.type === "runtime.warning") warnings.push(event.payload.detail);
          }),
        ).pipe(Effect.forkScoped);
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("neopi"),
          providerInstanceId: ProviderInstanceId.make("neopi-chat-test"),
          cwd: "/tmp",
          runtimeMode: "approval-required",
        });
        yield* adapter.sendTurn({ threadId, input: "/chat erp" });
        NodeAssert.equal(mode, "erp");
        yield* adapter.sendTurn({ threadId, input: "/chat" });
        NodeAssert.equal(mode, "off");
        yield* adapter.sendTurn({ threadId, input: "/chat" });
        NodeAssert.equal(mode, "erp");
        NodeAssert.deepEqual(
          peer.commands.filter((cmd) => cmd.type === "set_chat_mode").map((cmd) => cmd.mode),
          ["erp", "off", "erp"],
        );
        NodeAssert.equal(
          peer.commands.some((cmd) => cmd.type === "prompt"),
          false,
        );
        const cursorBefore = (yield* adapter.listSessions())[0]?.resumeCursor as NeoPiResumeCursor;
        NodeAssert.deepEqual(
          cursorBefore.turnBoundaries.map((boundary) =>
            "kind" in boundary ? boundary.kind : boundary.userEntryId,
          ),
          ["local", "local", "local"],
        );
        yield* adapter.rollbackThread(threadId, 1);
        const cursorAfter = (yield* adapter.listSessions())[0]?.resumeCursor as NeoPiResumeCursor;
        NodeAssert.equal(cursorAfter.turnBoundaries.length, 2);
        NodeAssert.equal(
          peer.commands.some((cmd) => cmd.type === "branch"),
          false,
        );
        for (let count = 0; count < 100 && warnings.length < 2; count++)
          yield* Effect.sleep("5 millis");
        NodeAssert.ok(
          warnings.some((detail) => JSON.stringify(detail).includes('\"mode\":\"erp\"')),
        );
        yield* adapter.stopAll();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reports disconnection during configuration reads instead of stale success", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let disconnect = Effect.void;
      const peer = yield* testPeer(
        (cmd, emit) =>
          cmd.type === "negotiate_protocol"
            ? answer(cmd, emit, { protocolVersion: 2 })
            : cmd.type === "get_roles"
              ? disconnect
              : basicHandler(cmd, emit),
        { ...defaultReady, capabilities: ["get_roles"] },
      );
      disconnect = peer.finish(null);
      let launches = 0;
      const runtime = yield* make(() => {
        launches++;
        return Effect.succeed(peer.handle);
      });
      yield* runtime.start;
      const expected = yield* SubscriptionRef.get(runtime.cursor);
      const commandCount = peer.commands.length;
      const result = yield* readNeoPiSessionConfiguration(runtime, expected);
      NodeAssert.equal(result.status, "unavailable");
      NodeAssert.equal(launches, 1);
      NodeAssert.deepEqual(
        peer.commands.slice(commandCount).map((cmd) => cmd.type),
        ["get_state", "get_roles"],
      );
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("follows idle terminal model and effort changes without importing its turns", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let model = "first";
      let thinkingLevel = "low";
      const fixture = yield* attachFixture(true, attachCapabilities, {
        state: () => ({ model: { provider: "test", id: model }, thinkingLevel }),
        roles: () => ({ roles: [configurationRole] }),
      });
      const { runtime, pipe, launches } = fixture;
      const instanceId = ProviderInstanceId.make("observed-neopi");
      const adapter = yield* makeNeoPiAdapter({
        settings: {
          enabled: true,
          binaryPath: "npi",
          profile: "",
          launchArgs: "",
          customModels: [],
        },
        instanceId,
        binary: "npi",
        cwd: "/tmp",
        t3Home: root,
        attachmentsDir: root,
        environment: {},
        spawn: fixture.spawn,
        discovery: yield* makeNeoPiDiscoveryHub(),
        makeRuntime: () => Effect.succeed(runtime),
      });
      yield* adapter.startSession({
        threadId: runtime.threadId,
        provider: ProviderDriverKind.make("neopi"),
        providerInstanceId: instanceId,
        cwd: "/tmp",
        runtimeMode: "approval-required",
        resumeCursor: attachedCursor,
      });
      const cursorBefore = yield* SubscriptionRef.get(runtime.cursor);
      const frames = yield* capture(runtime);
      const commandCount = pipe.commands.length;
      const launchCount = launches.length;
      const observation = yield* adapter.observeConfiguration(runtime.threadId, attachedCursor);
      const output = yield* Queue.unbounded<Effect.Success<typeof observation.read>>();
      const watching = yield* Stream.concat(
        Stream.fromEffect(observation.read),
        observation.changes.pipe(Stream.mapEffect(() => observation.read)),
      ).pipe(
        Stream.takeUntil((result) => result.status === "unavailable"),
        Stream.runForEach((result) => Queue.offer(output, result)),
        Effect.forkScoped,
      );
      const initial = yield* Queue.take(output);
      NodeAssert.equal(initial.status, "available");
      NodeAssert.equal(initial.model?.id, "first");
      yield* pipe.emit({ type: "agent_start" });
      yield* pipe.emit({ type: "message_end", message: { role: "assistant", content: [] } });
      yield* pipe.emit({ type: "agent_end", isTerminal: true });
      model = "second";
      yield* pipe.emit({ type: "model_changed", model: { provider: "test", id: model } });
      const changed = yield* Queue.take(output);
      NodeAssert.equal(changed.status, "available");
      NodeAssert.equal(changed.model?.id, "second");
      thinkingLevel = "high";
      yield* pipe.emit({ type: "thinking_level_changed", level: thinkingLevel });
      const effort = yield* Queue.take(output);
      NodeAssert.equal(effort.status, "available");
      NodeAssert.equal(effort.thinkingLevel, "high");
      NodeAssert.equal(yield* SubscriptionRef.get(runtime.state), "ready");
      NodeAssert.deepEqual(yield* SubscriptionRef.get(runtime.cursor), cursorBefore);
      NodeAssert.equal(launches.length, launchCount);
      NodeAssert.equal(
        frames.some((frame) =>
          [
            "agent_start",
            "message_end",
            "agent_end",
            "model_changed",
            "thinking_level_changed",
          ].includes(String(frame.type)),
        ),
        false,
      );
      NodeAssert.deepEqual(
        pipe.commands.slice(commandCount).map((cmd) => cmd.type),
        Array.from({ length: 3 }, () => ["get_state", "get_roles", "get_state"]).flat(),
      );
      yield* pipe.finish(null);
      NodeAssert.equal((yield* Queue.take(output)).status, "unavailable");
      yield* Fiber.join(watching);
      NodeAssert.equal(launches.length, launchCount);
      NodeAssert.deepEqual(pipe.signals, []);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("does not read configuration for unobserved idle terminal notifications", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, pipe } = yield* attachFixture();
      yield* runtime.start;
      const commandCount = pipe.commands.length;
      // A bare invalidation subscriber gives the test an event receipt without
      // creating a configuration consumer or relying on a timer.
      const receipt = yield* runtime.subscribeConfigurationChanges;
      yield* pipe.emit({ type: "model_changed", model: { provider: "test", id: "second" } });
      yield* PubSub.take(receipt);
      yield* pipe.emit({ type: "thinking_level_changed", level: "high" });
      yield* PubSub.take(receipt);
      NodeAssert.equal(pipe.commands.length, commandCount);
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
