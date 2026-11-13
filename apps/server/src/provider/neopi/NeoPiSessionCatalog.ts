// @effect-diagnostics nodeBuiltinImport:off -- NeoPi CLI identities are absolute filesystem paths.
import * as NodePath from "node:path";
import {
  CommandId,
  IsoDateTime,
  NeoPiSessionError,
  NonNegativeInt,
  type NeoPiSessionHandoffInput,
  type NeoPiSessionHandoffResult,
  type NeoPiSessionConfigurationInput,
  type NeoPiSessionConfigurationResult,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import { makeNeoPiThreadBindingReader, makeNeoPiThreadStateWriter } from "./NeoPiThreadBinding.ts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { ProviderInstanceRegistry } from "../ProviderInstanceRegistry.ts";
import { NEOPI_CAPABILITIES } from "./NeoPiCompatibility.ts";
import type { NeoPiSessionCatalogSource } from "./NeoPiSessionCatalogSource.ts";

const Session = Schema.Struct({
  path: Schema.String,
  id: Schema.String,
  cwd: Schema.String,
  title: Schema.NullOr(Schema.String),
  created: IsoDateTime,
  modified: IsoDateTime,
  messageCount: NonNegativeInt,
  firstMessage: Schema.String,
  inUse: Schema.NullOr(Schema.Struct({ pid: NonNegativeInt })),
  control: Schema.NullOr(Schema.Struct({ instanceId: Schema.String })),
});
const ListOutput = Schema.Struct({ version: Schema.Literal(1), sessions: Schema.Array(Session) });
const NativeMessage = Schema.Struct({
  entryId: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  timestamp: IsoDateTime,
});
const ReadOutput = Schema.Struct({
  version: Schema.Literal(1),
  session: Schema.Struct({
    path: Schema.String,
    id: Schema.String,
    cwd: Schema.String,
    title: Schema.NullOr(Schema.String),
  }),
  messages: Schema.Array(NativeMessage),
  branchMessages: Schema.Array(NativeMessage),
  branchEntryIds: Schema.Array(Schema.String),
  leafId: Schema.NullOr(Schema.String),
});
const decodeListOutput = Schema.decodeEffect(Schema.fromJsonString(ListOutput));
const decodeReadOutput = Schema.decodeEffect(Schema.fromJsonString(ReadOutput));
const isNeoPiSessionError = Schema.is(NeoPiSessionError);
const capabilityUnavailable = (
  source: NeoPiSessionCatalogSource | undefined,
  capability: string,
): string => {
  if (!source) return "NeoPi session discovery is not registered for this provider.";
  const evidence = `NeoPi binary '${source.binary}' (version ${source.probe.version ?? "unknown"})`;
  if (source.probe.status === "unprobed")
    return `${evidence} has not completed a compatible RPC handshake; ${capability} support is not yet known.${source.probe.failure ? ` Last probe failed: ${source.probe.failure}` : " Retry after the provider check completes."}`;
  if (source.probe.status === "unsupported")
    return `${evidence} returned an unsupported RPC handshake. Update NeoPi at this configured executable before using ${capability}.${source.probe.failure ? ` Last refresh failed: ${source.probe.failure}` : ""}`;
  return `${evidence} did not advertise ${capability} in its last compatible handshake. Update NeoPi at this configured executable.${source.probe.failure ? ` Last refresh failed: ${source.probe.failure}` : ""}`;
};
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const operationError = (operation: NeoPiSessionError["operation"]) => (cause: unknown) =>
  isNeoPiSessionError(cause) && cause.operation === operation
    ? cause
    : new NeoPiSessionError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
      });

export interface NeoPiSessionCommandInput {
  readonly source: NeoPiSessionCatalogSource;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}
export type NeoPiSessionCommandRunner = (
  input: NeoPiSessionCommandInput,
) => Effect.Effect<string, NeoPiSessionError>;

/** The runner is injectable so tests never launch a real NeoPi process. */
export const makeNeoPiSessionCatalog = Effect.fn("makeNeoPiSessionCatalog")(function* (
  runCommand?: NeoPiSessionCommandRunner,
) {
  const instances = yield* ProviderInstanceRegistry;
  const engine = yield* Orchestrator.OrchestratorV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const events = yield* EventSink.EventSinkV2;
  const readBinding = yield* makeNeoPiThreadBindingReader();
  const writeState = yield* makeNeoPiThreadStateWriter();
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const historyMutation = yield* Semaphore.make(1);
  const pathIdentity = Effect.fnUntraced(function* (path: string) {
    if (path === "") return "";
    const resolved = yield* fs.realPath(path).pipe(Effect.orElseSucceed(() => path));
    return normalizeProjectPathForComparison(resolved);
  });
  const sameCwd = Effect.fnUntraced(function* (left: string, right: string) {
    return (
      NodePath.isAbsolute(left) &&
      NodePath.isAbsolute(right) &&
      (yield* pathIdentity(left)) === (yield* pathIdentity(right))
    );
  });
  const run: NeoPiSessionCommandRunner =
    runCommand ??
    ((input) =>
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(input.source.binary, input.args, {
            cwd: input.cwd,
            env: input.source.env,
            stdin: "ignore",
          }),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            collectUint8StreamText({ stream: child.stdout, maxBytes: 16 * 1024 * 1024 }),
            collectUint8StreamText({ stream: child.stderr, maxBytes: 64 * 1024 }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (stdout.truncated || stderr.truncated)
          return yield* new NeoPiSessionError({
            operation: "handoff",
            message: "NeoPi session output exceeded the safety limit.",
          });
        if (Number(code) !== 0)
          return yield* new NeoPiSessionError({
            operation: "handoff",
            message: stderr.text || `NeoPi exited ${code}.`,
          });
        return stdout.text;
      }).pipe(
        Effect.timeout("30 seconds"),
        Effect.scoped,
        Effect.mapError(operationError("handoff")),
      ));

  const readTranscript = Effect.fn("NeoPiSessionCatalog.readTranscript")(function* (
    source: NeoPiSessionCatalogSource,
    cwd: string,
    sessionFile: string,
    sessionId: string,
  ) {
    const transcript = yield* decodeReadOutput(
      yield* run({
        source,
        cwd,
        args: ["sessions", "read", "--json", sessionFile, "--max-messages", "0"],
      }),
    ).pipe(
      Effect.mapError(
        () =>
          new NeoPiSessionError({
            operation: "handoff",
            message:
              "NeoPi did not return stable native history identities. Update NeoPi for session_history_identity before handing off this session.",
          }),
      ),
    );
    if (
      transcript.session.id !== sessionId ||
      (yield* pathIdentity(transcript.session.path)) !== (yield* pathIdentity(sessionFile)) ||
      !(yield* sameCwd(transcript.session.cwd, cwd)) ||
      transcript.leafId !== (transcript.branchEntryIds.at(-1) ?? null) ||
      new Set(transcript.branchEntryIds).size !== transcript.branchEntryIds.length
    )
      return yield* new NeoPiSessionError({
        operation: "handoff",
        message:
          "The session identity or selected branch changed during handoff. Refresh session discovery.",
      });
    const ancestry = new Set(transcript.branchEntryIds);
    for (const messages of [transcript.messages, transcript.branchMessages]) {
      const messageIds = new Set<string>();
      for (const message of messages) {
        if (!ancestry.has(message.entryId) || messageIds.has(message.entryId))
          return yield* new NeoPiSessionError({
            operation: "handoff",
            message: "NeoPi returned invalid native message identities for the selected branch.",
          });
        messageIds.add(message.entryId);
      }
    }
    return transcript;
  });

  const handoff = Effect.fn("NeoPiSessionCatalog.handoff")(
    function* (
      input: NeoPiSessionHandoffInput,
    ): Effect.fn.Return<NeoPiSessionHandoffResult, unknown> {
      const binding = yield* readBinding(input.threadId);
      if (!binding?.session)
        return yield* new NeoPiSessionError({
          operation: "handoff",
          message: "This thread has no resumable NeoPi session.",
        });
      const {
        source,
        cwd,
        session: boundSession,
        expected: { sessionFile, sessionId },
      } = binding;
      for (const capability of [
        NEOPI_CAPABILITIES.sessionCatalog,
        NEOPI_CAPABILITIES.sessionHistoryIdentity,
      ]) {
        if (source.probe.status === "unsupported" || !source.capabilities.has(capability))
          return yield* new NeoPiSessionError({
            operation: "handoff",
            message: capabilityUnavailable(source, capability),
          });
      }
      const wasRunning = binding.connected;
      if (binding.attached) {
        const commandId = CommandId.make(yield* randomUuidV4);
        yield* engine.dispatch({
          type: "provider-session.detach",
          commandId,
          threadId: input.threadId,
          providerSessionId: boundSession.id,
          reason: "Native terminal handoff",
        });
        const effects = yield* outbox.listByCommandId(commandId);
        const detach = effects.find(
          (effect) =>
            effect.request.type === "provider-session.detach" &&
            effect.request.providerSessionId === boundSession.id,
        );
        if (!detach)
          return yield* new NeoPiSessionError({
            operation: "handoff",
            message: "NeoPi session stop was not scheduled. Try handing off again.",
          });
        yield* outbox.awaitSettled(detach.id).pipe(Effect.timeout("30 seconds"));
        const settled = yield* outbox.get(detach.id);
        if (Option.isNone(settled) || settled.value.status !== "succeeded")
          return yield* new NeoPiSessionError({
            operation: "handoff",
            message: "NeoPi session stop did not complete. Try handing off again.",
          });
      }
      // A stopped control connection only detached: its terminal owner still
      // holds the native lease. Never offer a command that cannot acquire it.
      const listed = yield* decodeListOutput(
        yield* run({
          source,
          cwd,
          args: [
            "sessions",
            "list",
            "--json",
            "--session-dir",
            NodePath.dirname(NodePath.resolve(sessionFile)),
          ],
        }),
      );
      let owner: (typeof listed.sessions)[number]["inUse"] = null;
      for (const row of listed.sessions) {
        if ((yield* pathIdentity(row.path)) === sessionFile) {
          owner = row.inUse;
          break;
        }
      }
      if (owner)
        return yield* new NeoPiSessionError({
          operation: "handoff",
          message: `This session is still open in the terminal process (PID ${owner.pid}). NeoCode merely detached; close the session in that terminal before resuming it elsewhere.`,
        });
      const transcript = yield* readTranscript(source, cwd, sessionFile, sessionId);
      const current = yield* readBinding(input.threadId);
      if (
        !current?.session ||
        current.attached ||
        current.providerThread.id !== binding.providerThread.id ||
        current.instance !== binding.instance ||
        current.expected.sessionId !== sessionId ||
        current.expected.sessionFile !== sessionFile
      )
        return yield* new NeoPiSessionError({
          operation: "handoff",
          message: "The native binding changed during handoff. Stop it before handing off again.",
        });
      const saved = current.cursor;
      if (!wasRunning && saved.historyLeafId !== transcript.leafId)
        return yield* new NeoPiSessionError({
          operation: "handoff",
          message:
            "This stopped thread has unverified native history. Restore it in NeoCode before handing it off; older cursors without a native watermark require NeoPi.",
        });
      const committed = yield* writeState({
        expected: current.providerThread,
        expectedSession: current.session,
        expectedAttached: false,
        next: {
          ...current.providerThread,
          nativeConversationHeadRef:
            transcript.leafId === null
              ? null
              : {
                  driver: current.providerThread.driver,
                  nativeId: transcript.leafId,
                  strength: "strong",
                },
          nativeMetadata: {
            ...current.providerThread.nativeMetadata,
            neopiResumeCursor: { ...saved, historyLeafId: transcript.leafId },
          },
        },
      });
      if (!committed)
        return yield* new NeoPiSessionError({
          operation: "handoff",
          message: "The native binding changed before handoff could be recorded.",
        });
      const profile = source.env.OMP_PROFILE;
      const command = `cd ${shellQuote(cwd)} && ${profile ? `OMP_PROFILE=${shellQuote(profile)} ` : ""}${shellQuote(source.binary)} --session ${shellQuote(sessionFile)}`;
      return { sessionFile, sessionId, cwd, command };
    },
    historyMutation.withPermits(1),
    Effect.mapError(operationError("handoff")),
  );

  const configuration = Effect.fn("NeoPiSessionCatalog.configuration")(
    function* (
      input: NeoPiSessionConfigurationInput,
    ): Effect.fn.Return<NeoPiSessionConfigurationResult, unknown> {
      const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });
      const binding = yield* readBinding(input.threadId);
      if (!binding) return unavailable("This thread has no bound NeoPi session.");
      if (!binding.connected) return unavailable("This thread's NeoPi session is not connected.");
      const { source, expected, instance } = binding;
      if (!source.configuration)
        return unavailable("The bound NeoPi provider has no connected configuration reader.");
      const result = yield* source.configuration(input.threadId, expected);
      if (
        result.status === "available" &&
        (result.providerInstanceId !== instance.instanceId ||
          result.sessionId !== expected.sessionId)
      )
        return unavailable("The NeoPi reader returned a different bound session.");
      const changed = !(yield* binding.unchanged);
      if (changed) return unavailable("The bound NeoPi connection changed during the snapshot.");
      return result;
    },
    Effect.mapError(operationError("configuration")),
  );

  const watchConfiguration = (input: NeoPiSessionConfigurationInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });
        // Acquire every notification source before reading the binding or native
        // snapshot. A notification during a read leaves one pending refresh.
        const registryChanges = yield* instances.subscribeChanges;
        const afterSequence = yield* events.latestSequence({ threadId: input.threadId });
        const domainEvents = events.stream({ threadId: input.threadId, afterSequence });
        const pending = yield* Queue.sliding<void>(1);
        let refresh = true;
        const invalidate = (read: boolean) =>
          Effect.suspend(() => {
            refresh ||= read;
            return Queue.offer(pending, undefined);
          });
        yield* Effect.forever(
          PubSub.take(registryChanges).pipe(Effect.andThen(invalidate(false))),
        ).pipe(Effect.forkScoped);
        yield* domainEvents.pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "provider-session.attached" ||
              event.type === "provider-session.updated" ||
              event.type === "provider-session.detached" ||
              event.type === "provider-thread.updated" ||
              event.type === "thread.deleted",
          ),
          Stream.runForEach(() => invalidate(false)),
          Effect.forkScoped,
        );
        const binding = yield* readBinding(input.threadId);
        if (!binding) return Stream.succeed(unavailable("This thread has no bound NeoPi session."));
        if (!binding.connected)
          return Stream.succeed(unavailable("This thread's NeoPi session is not connected."));
        const { instance, source, expected } = binding;
        if (!source.observeConfiguration)
          return Stream.succeed(
            unavailable("The bound NeoPi configuration observer is unavailable."),
          );
        const observation = yield* source.observeConfiguration(input.threadId, expected);
        const changed = binding.unchanged.pipe(Effect.map((unchanged) => !unchanged));
        yield* observation.changes.pipe(
          Stream.runForEach(() => invalidate(true)),
          Effect.forkScoped,
        );
        yield* Queue.offer(pending, undefined);
        return Stream.fromQueue(pending).pipe(
          Stream.mapEffect(() =>
            Effect.gen(function* () {
              const read = refresh;
              refresh = false;
              if (yield* changed)
                return Option.some(
                  unavailable("The observed NeoPi binding changed. Start following again."),
                );
              if (!read) return Option.none();
              const result = yield* observation.read;
              if (yield* changed)
                return Option.some(
                  unavailable("The observed NeoPi binding changed during the snapshot."),
                );
              if (
                result.status === "available" &&
                (result.providerInstanceId !== instance.instanceId ||
                  result.sessionId !== expected.sessionId)
              )
                return Option.some(
                  unavailable("The NeoPi reader returned a different bound session."),
                );
              return Option.some(result);
            }),
          ),
          Stream.filter(Option.isSome),
          Stream.map((result) => result.value),
          Stream.takeUntil((result) => result.status === "unavailable"),
        );
      }),
    ).pipe(Stream.mapError(operationError("configuration")));

  return { handoff, configuration, watchConfiguration };
});
