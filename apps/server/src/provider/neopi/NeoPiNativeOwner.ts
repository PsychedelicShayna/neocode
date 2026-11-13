// @effect-diagnostics nodeBuiltinImport:off -- native identities use canonical filesystem paths.
import * as NodePath from "node:path";
import { type NeoPiNavigateTreeInput, type ThreadId } from "@t3tools/contracts";
import { NeoPiNavigateTreeResult } from "@t3tools/contracts";
import { make as makeClient, type SessionEventFrame } from "effect-neopi-rpc/client";
import { MAX_RPC_REASSEMBLED_BYTES } from "effect-neopi-rpc/frame";
import type { NeoPiRpcError } from "effect-neopi-rpc/errors";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import * as Streams from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as RuntimePolicy from "../../orchestration-v2/RuntimePolicy.ts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import type { NeoPiSessionCatalogSource } from "./NeoPiSessionCatalogSource.ts";
import { makeNeoPiNativeEventHub } from "./NeoPiNativeEventHub.ts";
import { NeoPiRuntimeError } from "./NeoPiRuntimeError.ts";
import { makeNeoPiThreadBindingReader, makeNeoPiThreadStateWriter } from "./NeoPiThreadBinding.ts";

export interface NeoPiNativeOwner {
  readonly ownership: "gui" | "terminal";
  readonly capabilities: ReadonlySet<string>;
  readonly events: Stream.Stream<SessionEventFrame, NeoPiRuntimeError>;
  readonly request: (command: {
    readonly type: string;
    readonly [key: string]: unknown;
  }) => Effect.Effect<unknown, NeoPiRpcError | NeoPiRuntimeError>;
}
const Catalog = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    sessions: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        path: Schema.String,
        inUse: Schema.NullOr(Schema.Struct({ pid: Schema.Number })),
        control: Schema.NullOr(Schema.Struct({ instanceId: Schema.String })),
      }),
    ),
  }),
);
const decodeCatalog = Schema.decodeEffect(Catalog);
const decodeNavigation = Schema.decodeUnknownEffect(NeoPiNavigateTreeResult);
const isNativeOwnerError = Schema.is(NeoPiRuntimeError);

const nativeOwnerError = (cause: unknown) =>
  isNativeOwnerError(cause)
    ? cause
    : new NeoPiRuntimeError({
        code: "rpc",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

/** Discovery is short-lived; the eventual control connection keeps its caller's scope. */
export const readNeoPiNativeOwnerCatalog = Effect.fn("NeoPiNativeOwner.readCatalog")(
  function* (
    source: Pick<NeoPiSessionCatalogSource, "binary" | "env">,
    cwd: string,
    sessionFile: string,
  ) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        source.binary,
        ["sessions", "list", "--json", "--session-dir", NodePath.dirname(sessionFile)],
        { cwd, env: source.env, stdin: "ignore" },
      ),
    );
    const [out, err, code] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_RPC_REASSEMBLED_BYTES }),
        collectUint8StreamText({ stream: child.stderr, maxBytes: 65536 }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (Number(code) !== 0 || out.truncated || err.truncated)
      return yield* new NeoPiRuntimeError({
        code: "rpc",
        message: "Native owner discovery failed.",
      });
    return yield* decodeCatalog(out.text);
  },
  Effect.scoped,
  Effect.timeout("30 seconds"),
  Effect.mapError(nativeOwnerError),
);

/** Resolve the existing writer only. History observation never starts or resumes a session. */
export const makeNeoPiNativeOwnerResolver = Effect.fn("NeoPiNativeOwner.make")(function* () {
  const readBinding = yield* makeNeoPiThreadBindingReader();
  const writeState = yield* makeNeoPiThreadStateWriter();
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return Effect.fn("NeoPiNativeOwner.resolve")(function* (threadId: ThreadId) {
    const scope = yield* Effect.scope;
    const binding = yield* readBinding(threadId);
    if (!binding) return undefined;
    const { expected, source, unchanged, cwd } = binding;
    let owner: NeoPiNativeOwner | undefined = source.observeNative
      ? yield* source.observeNative(threadId)
      : undefined;
    if (!owner) {
      if (
        source.probe.status !== "compatible" ||
        !source.capabilities.has("session_catalog") ||
        !source.capabilities.has("control_pipe")
      )
        return undefined;
      const catalog = yield* readNeoPiNativeOwnerCatalog(source, cwd, expected.sessionFile).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      let instanceId: string | undefined;
      for (const row of catalog.sessions) {
        if (
          row.id === expected.sessionId &&
          (yield* fs.realPath(row.path)) === expected.sessionFile
        ) {
          instanceId = row.control?.instanceId;
          break;
        }
      }
      if (!instanceId) return undefined;
      const hub = makeNeoPiNativeEventHub();
      const events = yield* hub.subscribe;
      const peer = yield* makeClient({
        spawn: spawner.spawn,
        command: source.binary,
        args: ["ctl", "pipe", instanceId, "--label", "neocode-conversation"],
        cwd,
        env: source.env,
        eventQueueCapacity: 1,
        onTransportReady: Effect.fn("NeoPiNativeOwner.onTransportReady")(function* (transport) {
          yield* Streams.runDrain(transport.uiRequests).pipe(Effect.forkIn(scope));
          yield* Streams.runDrain(transport.hostToolCalls).pipe(Effect.forkIn(scope));
          yield* Streams.runForEach(transport.events, hub.publish).pipe(
            Effect.ensuring(hub.publish({ type: "neocode_connection_closed" })),
            Effect.forkIn(scope),
          );
        }),
      });
      if (!peer.capabilities.has("control_v1")) return undefined;
      owner = {
        ownership: "terminal",
        capabilities: peer.capabilities,
        events,
        request: peer.request,
      };
    }
    const connected = owner;
    return {
      expected,
      owner: {
        ...connected,
        request: Effect.fn("NeoPiNativeOwner.request")(function* (command: {
          readonly type: string;
          readonly [key: string]: unknown;
        }) {
          if (!(yield* unchanged))
            return yield* new NeoPiRuntimeError({
              code: "identity_mismatch",
              message: "The bound native identity changed. Reconnect.",
            });
          const result = yield* connected.request(command);
          if (command.type !== "navigate_tree") return result;
          const navigation = yield* decodeNavigation(result);
          if (
            !binding.session ||
            !(yield* unchanged) ||
            navigation.sessionId !== expected.sessionId ||
            (navigation.sessionFile !== undefined &&
              (yield* fs.realPath(navigation.sessionFile)) !== expected.sessionFile)
          )
            return yield* new NeoPiRuntimeError({
              code: "identity_mismatch",
              message: "The bound native identity changed during navigation.",
            });
          const { historyLeafId: _, ...cursor } = binding.cursor;
          const committed = yield* writeState({
            expected: binding.providerThread,
            expectedSession: binding.session,
            expectedAttached: binding.attached,
            next: {
              ...binding.providerThread,
              nativeConversationHeadRef:
                navigation.leafId === null
                  ? null
                  : {
                      driver: binding.providerThread.driver,
                      nativeId: navigation.leafId,
                      strength: "strong",
                    },
              nativeMetadata: {
                ...binding.providerThread.nativeMetadata,
                neopiResumeCursor: {
                  ...cursor,
                  ...(navigation.leafId === null ? {} : { historyLeafId: navigation.leafId }),
                },
              },
            },
          });
          if (!committed)
            return yield* new NeoPiRuntimeError({
              code: "identity_mismatch",
              message: "The native binding changed before navigation could be recorded.",
            });
          return result;
        }, Effect.mapError(nativeOwnerError)),
      },
    };
  }, Effect.mapError(nativeOwnerError));
});

/** This path is called only by an explicit start-and-navigate request. */
export const makeNeoPiNativeSessionStarter = Effect.fn("NeoPiNativeOwner.starter")(function* () {
  const readBinding = yield* makeNeoPiThreadBindingReader();
  const writeState = yield* makeNeoPiThreadStateWriter();
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const policy = yield* RuntimePolicy.RuntimePolicyV2;
  const events = yield* EventSink.EventSinkV2;
  return Effect.fn("NeoPiNativeOwner.startStopped")(
    function* (input: NeoPiNavigateTreeInput) {
      const binding = yield* readBinding(input.threadId);
      if (!binding?.session || (binding.attached && binding.session.status !== "stopped")) return;
      const { thread, providerThread, session, expected } = binding;
      if (
        expected.sessionId !== input.expectedSessionId ||
        expected.sessionFile !== input.expectedSessionFile
      )
        return yield* new NeoPiRuntimeError({
          code: "identity_mismatch",
          message: "The stopped session does not match the requested native identity.",
        });
      const modelSelection =
        providerThread.nativeMetadata?.modelSelection ??
        (thread.modelSelection.instanceId === providerThread.providerInstanceId
          ? thread.modelSelection
          : session.model
            ? { instanceId: providerThread.providerInstanceId, model: session.model }
            : undefined);
      if (!modelSelection || modelSelection.instanceId !== providerThread.providerInstanceId)
        return yield* new NeoPiRuntimeError({
          code: "identity_mismatch",
          message: "The stopped session has no matching native model selection.",
        });
      const runtimePolicy = yield* policy.resolve({ thread, modelSelection });
      if (!(yield* binding.unchanged))
        return yield* new NeoPiRuntimeError({
          code: "identity_mismatch",
          message: "The stopped native binding changed before startup.",
        });
      const ready = yield* Deferred.make<void, NeoPiRuntimeError>();
      const afterSequence = yield* events.latestSequence({ threadId: input.threadId });
      yield* events.stream({ threadId: input.threadId, afterSequence }).pipe(
        Streams.runForEach(({ event }) =>
          event.type === "provider-session.updated" &&
          event.payload.id === session.id &&
          event.payload.status === "ready"
            ? Deferred.succeed(ready, undefined)
            : Effect.void,
        ),
        Effect.catch((cause) => Deferred.fail(ready, nativeOwnerError(cause))),
        Effect.forkScoped,
      );
      const runtime = yield* sessions.open({
        threadId: input.threadId,
        providerSessionId: session.id,
        modelSelection,
        runtimePolicy,
        resumeFromSession: session,
        initialNativeThreadId: expected.sessionId,
      });
      const resumed = yield* runtime.resumeThread({
        threadId: input.threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
      });
      yield* Deferred.await(ready);
      const current = yield* readBinding(input.threadId);
      if (
        !current?.session ||
        current.providerThread.id !== providerThread.id ||
        current.expected.sessionId !== expected.sessionId ||
        current.expected.sessionFile !== expected.sessionFile ||
        current.instance !== binding.instance ||
        !current.connected ||
        !(yield* writeState({
          expected: providerThread,
          expectedSession: current.session,
          expectedAttached: current.attached,
          next: resumed,
        }))
      )
        return yield* new NeoPiRuntimeError({
          code: "identity_mismatch",
          message: "The native binding changed before startup could be recorded.",
        });
    },
    Effect.scoped,
    Effect.mapError(nativeOwnerError),
  );
});
