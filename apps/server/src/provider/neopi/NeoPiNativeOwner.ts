// @effect-diagnostics nodeBuiltinImport:off -- native identities use canonical filesystem paths.
import * as NodePath from "node:path";
import type { NeoPiNavigateTreeInput, ThreadId } from "@t3tools/contracts";
import { make as makeClient, type SessionEventFrame } from "effect-neopi-rpc/client";
import { MAX_RPC_REASSEMBLED_BYTES } from "effect-neopi-rpc/frame";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import * as Streams from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { neoPiSessionCatalogSource } from "./NeoPiSessionCatalogSource.ts";
import { makeNeoPiNativeEventHub } from "./NeoPiNativeEventHub.ts";

export interface NeoPiNativeOwner {
  readonly ownership: "gui" | "terminal";
  readonly capabilities: ReadonlySet<string>;
  readonly events: Stream.Stream<SessionEventFrame, unknown>;
  readonly request: (command: { readonly type: string; readonly [key: string]: unknown }) => Effect.Effect<unknown, unknown>;
}
const Cursor = Schema.Struct({ sessionId: Schema.String, sessionFile: Schema.String });
const Catalog = Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1), sessions: Schema.Array(Schema.Struct({
  id: Schema.String, path: Schema.String,
  inUse: Schema.NullOr(Schema.Struct({ pid: Schema.Number })),
  control: Schema.NullOr(Schema.Struct({ instanceId: Schema.String })),
})) }));

/** Resolve the existing writer only. History observation never starts or resumes a session. */
export const makeNeoPiNativeOwnerResolver = Effect.fn("NeoPiNativeOwner.make")(function* () {
  const directory = yield* ProviderSessionDirectory;
  const instances = yield* ProviderInstanceRegistry;
  const snapshots = yield* ProjectionSnapshotQuery;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return Effect.fn("NeoPiNativeOwner.resolve")(function* (threadId: ThreadId) {
    const binding = yield* directory.getBinding(threadId);
    if (Option.isNone(binding) || binding.value.provider !== "neopi") return undefined;
    const saved = yield* Schema.decodeUnknownEffect(Cursor)(binding.value.resumeCursor);
    if (!NodePath.isAbsolute(saved.sessionFile)) return undefined;
    const expected = { sessionId: saved.sessionId, sessionFile: yield* fs.realPath(saved.sessionFile) };
    const instance = binding.value.providerInstanceId ? yield* instances.getInstance(binding.value.providerInstanceId) : undefined;
    if (!instance?.enabled || instance.driverKind !== "neopi") return undefined;
    const source = neoPiSessionCatalogSource(instance);
    if (!source) return undefined;
    const unchanged = Effect.gen(function* () {
      const current = yield* directory.getBinding(threadId);
      if (Option.isNone(current) || current.value.provider !== "neopi" ||
        current.value.providerInstanceId !== binding.value.providerInstanceId ||
        current.value.adapterKey !== binding.value.adapterKey ||
        (yield* instances.getInstance(instance.instanceId)) !== instance) return false;
      const cursor = Schema.decodeUnknownOption(Cursor)(current.value.resumeCursor);
      return Option.isSome(cursor) && cursor.value.sessionId === expected.sessionId &&
        (yield* fs.realPath(cursor.value.sessionFile)) === expected.sessionFile;
    });
    let owner = source.observeNative ? yield* source.observeNative(threadId) : undefined;
    if (!owner) {
      if (source.probe.status !== "compatible" || !source.capabilities.has("session_catalog") || !source.capabilities.has("control_pipe")) return undefined;
      const thread = yield* snapshots.getThreadShellById(threadId);
      if (Option.isNone(thread)) return undefined;
      const project = yield* snapshots.getProjectShellById(thread.value.projectId);
      if (Option.isNone(project)) return undefined;
      const cwd = thread.value.worktreePath ?? project.value.workspaceRoot;
      const child = yield* spawner.spawn(ChildProcess.make(source.binary, ["sessions", "list", "--json", "--session-dir", NodePath.dirname(expected.sessionFile)], { cwd, env: source.env, stdin: "ignore" }));
      const [out, err, code] = yield* Effect.all([
        collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_RPC_REASSEMBLED_BYTES }),
        collectUint8StreamText({ stream: child.stderr, maxBytes: 65536 }), child.exitCode,
      ], { concurrency: "unbounded" });
      if (Number(code) !== 0 || out.truncated || err.truncated) return yield* Effect.fail(new Error("Native owner discovery failed."));
      const catalog = yield* Schema.decodeUnknownEffect(Catalog)(out.text);
      let instanceId: string | undefined;
      for (const row of catalog.sessions) {
        if (row.id === expected.sessionId && (yield* fs.realPath(row.path)) === expected.sessionFile) {
          instanceId = row.control?.instanceId;
          break;
        }
      }
      if (!instanceId) return undefined;
      const hub = makeNeoPiNativeEventHub();
      const events = yield* hub.subscribe;
      const peer = yield* makeClient({ spawn: spawner.spawn, command: source.binary,
        args: ["ctl", "pipe", instanceId, "--label", "neocode-conversation"], cwd, env: source.env,
        eventQueueCapacity: 1,
        onTransportReady: (transport) => Effect.gen(function* () {
          yield* Streams.runDrain(transport.uiRequests).pipe(Effect.forkScoped);
          yield* Streams.runDrain(transport.hostToolCalls).pipe(Effect.forkScoped);
          yield* Streams.runForEach(transport.events, hub.publish).pipe(
            Effect.ensuring(hub.publish({ type: "neocode_connection_closed" })), Effect.forkScoped,
          );
        }),
      });
      if (!peer.capabilities.has("control_v1")) return undefined;
      owner = { ownership: "terminal", capabilities: peer.capabilities, events, request: peer.request };
    }
    const connected = owner;
    return {
      expected,
      owner: { ...connected, request: (command: { readonly type: string; readonly [key: string]: unknown }) =>
        Effect.gen(function* () {
          if (!(yield* unchanged)) return yield* Effect.fail(new Error("The bound native identity changed. Reconnect."));
          return yield* connected.request(command);
        }),
      },
    };
  });
});

/** This path is called only by an explicit start-and-navigate request. */
export const makeNeoPiNativeSessionStarter = Effect.fn("NeoPiNativeOwner.starter")(function* () {
  const directory = yield* ProviderSessionDirectory;
  const providers = yield* ProviderService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const fs = yield* FileSystem.FileSystem;
  return Effect.fn("NeoPiNativeOwner.startStopped")(function* (input: NeoPiNavigateTreeInput) {
    const binding = yield* directory.getBinding(input.threadId);
    if (Option.isNone(binding) || binding.value.provider !== "neopi" || binding.value.status !== "stopped" || !binding.value.providerInstanceId) return;
    const cursor = yield* Schema.decodeUnknownEffect(Cursor)(binding.value.resumeCursor);
    const sessionFile = yield* fs.realPath(cursor.sessionFile);
    if (cursor.sessionId !== input.expectedSessionId || sessionFile !== input.expectedSessionFile)
      return yield* Effect.fail(new Error("The stopped session does not match the requested native identity."));
    const thread = yield* snapshots.getThreadShellById(input.threadId);
    if (Option.isNone(thread)) return;
    const project = yield* snapshots.getProjectShellById(thread.value.projectId);
    if (Option.isNone(project)) return;
    yield* providers.startSession(input.threadId, {
      threadId: input.threadId,
      provider: "neopi",
      providerInstanceId: binding.value.providerInstanceId,
      runtimeMode: binding.value.runtimeMode,
      resumeCursor: binding.value.resumeCursor,
      cwd: thread.value.worktreePath ?? project.value.workspaceRoot,
    });
  });
});
