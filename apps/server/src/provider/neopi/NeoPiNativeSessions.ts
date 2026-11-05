// @effect-diagnostics nodeBuiltinImport:off -- native session identity is a canonical filesystem path.
import * as NodePath from "node:path";
import {
  NeoPiJournalPage,
  NeoPiModelsError,
  NeoPiNativeSessionCommand,
  NeoPiNativeSessionLive,
  NeoPiNativeSessionRecord,
  NeoPiNativeSessionsError,
  type NeoPiNativeSessionRef,
  type NeoPiNativeSessionSummary,
  type NeoPiNativeSessionsListInput,
  type NeoPiNativeSessionsListResult,
  type NeoPiNativeSessionsOpenInput,
  type NeoPiNativeSessionsOpenResult,
  type NeoPiNativeSessionsRequestInput,
  type NeoPiNativeSessionsSetSettledInput,
  type NeoPiNativeSessionsSetSettledResult,
  type NeoPiNativeSessionsStreamEvent,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  make as makeClient,
  type NeoPiRpcClient,
  type SessionEventFrame,
  type UiRequestFrame,
} from "effect-neopi-rpc/client";
import { NeoPiRpcError } from "effect-neopi-rpc/errors";
import { MAX_RPC_REASSEMBLED_BYTES } from "effect-neopi-rpc/frame";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  makeNeoPiNativeSettledStore,
  type NeoPiNativeSettledStore,
  resolveNativeSettlement,
} from "./NeoPiNativeSettlement.ts";
import type { McpCapability } from "../../mcp/McpInvocationContext.ts";
import { makeNeoPiNativeHostToolPump } from "./NeoPiHostToolBridge.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import {
  neoPiAvailableCommands,
  neoPiSlashCommandName,
  neoPiTerminalTextRoute,
} from "./NeoPiCommandCatalog.ts";
import { NEOPI_CAPABILITIES } from "./NeoPiCompatibility.ts";
import { parseNeoPiLaunchArguments } from "./NeoPiLaunchArgs.ts";
import { prepareNeoPiNativePrompt } from "./NeoPiNativeAttachments.ts";
import { makeNeoPiNativeEventHub } from "./NeoPiNativeEventHub.ts";
import type { NeoPiModelsConnection } from "./NeoPiModelsConnection.ts";
import {
  neoPiSessionCatalogSource,
  type NeoPiSessionCatalogSource,
} from "./NeoPiSessionCatalogSource.ts";

const CatalogRow = Schema.Struct({
  path: Schema.String,
  id: Schema.String,
  cwd: Schema.String,
  title: Schema.NullOr(Schema.String),
  firstMessage: Schema.String,
  modified: Schema.String,
  inUse: Schema.NullOr(Schema.Struct({ pid: Schema.Number })),
  control: Schema.NullOr(Schema.Struct({ instanceId: Schema.String })),
  /** Present only for `sessions list --live`; null when no owner answered in time. */
  live: Schema.optional(Schema.NullOr(NeoPiNativeSessionLive)),
});
type CatalogRow = typeof CatalogRow.Type;
const Catalog = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), sessions: Schema.Array(CatalogRow) }),
);
const StateIdentity = Schema.Struct({ sessionId: Schema.String, sessionFile: Schema.String });
const JournalIdentity = Schema.Struct({
  sessionId: Schema.String,
  sessionFile: Schema.String,
  leafId: Schema.NullOr(Schema.String),
});
const UiResponse = Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
  NeoPiNativeSessionRecord,
]);
const ControlIdentity = Schema.Struct({
  session: StateIdentity,
  cwd: Schema.String,
  revisions: Schema.Struct({ generation: Schema.Number }),
});
const closedType = "neocode_native_connection_closed";
const answeredType = "neocode_native_dialog_answered";
/** The terminal owner exited; the server is waiting for a replacement. */
const reconnectingType = "neocode_native_reconnecting";
/** A replacement owner is attached in place; watchers re-read their snapshot. */
const attachedType = "neocode_native_owner_attached";
/**
 * How long a vanished terminal owner (`/restart`, a quit) gets to come back before
 * NeoCode may start an owner of its own. Starting one earlier would take the
 * session's lease out from under a terminal that is still restarting.
 */
const OWNER_REATTACH_GRACE = "10 seconds";
const OWNER_REATTACH_POLL = "500 millis";
const nativeError = (cause: unknown): NeoPiNativeSessionsError => {
  if (Schema.is(NeoPiNativeSessionsError)(cause)) return cause;
  const error = new NeoPiNativeSessionsError({
    message: cause instanceof Error ? cause.message : String(cause),
    ...(cause instanceof NeoPiRpcError && cause.code ? { code: cause.code } : {}),
  });
  // Keep the original failure server-side without extending the public error schema.
  Object.defineProperty(error, "cause", { value: cause, configurable: true });
  return error;
};
const fail = (message: string, code = "session_unavailable") =>
  new NeoPiNativeSessionsError({ message, code });

export interface NeoPiNativeProfile {
  readonly providerInstanceId: ProviderInstanceId;
  readonly source: NeoPiSessionCatalogSource;
  /** The configured instance must still be the same object, not a replacement profile. */
  readonly validate: Effect.Effect<void, NeoPiNativeSessionsError>;
}
export interface NeoPiNativeConnection {
  readonly client: Pick<
    NeoPiRpcClient,
    "capabilities" | "request" | "respondUi" | "writeFrame" | "exit"
  >;
  readonly attachment: "owned" | "terminal";
  readonly cwd: string;
  /** A startup dialog can block stdio commands; the native control reader remains available. */
  readonly readState?: Effect.Effect<unknown, NeoPiNativeSessionsError>;
  readonly hostTools?: {
    readonly bind: (ref: NeoPiNativeSessionRef) => Effect.Effect<void, NeoPiNativeSessionsError>;
    readonly revoke: Effect.Effect<void>;
  };
}
export interface NeoPiNativeSessionsDependencies {
  readonly profileIds: Effect.Effect<ReadonlyArray<ProviderInstanceId>>;
  readonly profileChanges?: Stream.Stream<void>;
  readonly profile: (
    id: ProviderInstanceId,
  ) => Effect.Effect<NeoPiNativeProfile, NeoPiNativeSessionsError>;
  readonly canonicalize: (file: string) => Effect.Effect<string, NeoPiNativeSessionsError>;
  readonly preparePrompt: (
    input: NeoPiNativeSessionsRequestInput,
  ) => Effect.Effect<NeoPiNativeSessionCommand, NeoPiNativeSessionsError>;
  readonly catalog: (
    profile: NeoPiNativeProfile,
    cwd?: string,
    file?: string,
  ) => Effect.Effect<ReadonlyArray<CatalogRow>, NeoPiNativeSessionsError>;
  readonly connect: (
    profile: NeoPiNativeProfile,
    input: NeoPiNativeSessionsOpenInput,
    publish: (frame: SessionEventFrame) => Effect.Effect<void>,
    /** `attach` joins a live owner only and never starts one. */
    mode?: "auto" | "attach",
  ) => Effect.Effect<NeoPiNativeConnection, NeoPiNativeSessionsError, Scope.Scope>;
  /** Persisted settle decisions and the auto-settle window; omitted, nothing is ever settled. */
  readonly settlement?: {
    readonly store: NeoPiNativeSettledStore;
    readonly autoSettleAfterDays: Effect.Effect<number | null>;
  };
}
interface NativeSession {
  readonly profile: NeoPiNativeProfile;
  /** Replaced in place when a terminal owner is swapped for its successor. */
  native: NeoPiNativeConnection;
  nativeScope: Scope.Closeable;
  readonly scope: Scope.Closeable;
  readonly hub: ReturnType<typeof makeNeoPiNativeEventHub>;
  readonly pendingUi: Map<string, SessionEventFrame>;
  readonly modelChanges: PubSub.PubSub<void>;
  readonly modelUi: PubSub.PubSub<UiRequestFrame>;
  readonly openedAt: string;
  ref: NeoPiNativeSessionRef;
  sessionId: string;
  cwd: string;
  cwdFile: string;
  state: Record<string, unknown>;
  closed: boolean;
  /** A turn is in flight, from `agent_start`/`agent_end` frames and `get_state`. */
  busy: boolean;
  /** Set while the terminal owner is gone and its successor is awaited; requests wait on it. */
  recovery: Deferred.Deferred<void, NeoPiNativeSessionsError> | null;
  /** A prompt is waiting: when the grace period ends, start an owner instead of closing. */
  takeoverRequested: boolean;
}

/** One owner/control connection per canonical native file, never per browser subscription. */
export const makeNeoPiNativeSessionsWith = Effect.fn("NeoPiNativeSessions.makeWith")(function* (
  dependencies: NeoPiNativeSessionsDependencies,
) {
  const lifetime = yield* Effect.scope;
  const sessions = new Map<string, NativeSession>();
  // Gates are per native path: unrelated sessions can start independently.
  const gates = new Map<string, Semaphore.Semaphore>();
  const gate = Effect.fnUntraced(function* (file: string) {
    const existing = gates.get(file);
    if (existing) return existing;
    const created = yield* Semaphore.make(1);
    const winner = gates.get(file) ?? created;
    gates.set(file, winner);
    return winner;
  });
  const finish = (session: NativeSession, reason: string, code?: string) =>
    Effect.gen(function* () {
      if (session.closed) return;
      session.closed = true;
      if (sessions.get(session.ref.sessionFile) === session)
        sessions.delete(session.ref.sessionFile);
      if (session.recovery) yield* Deferred.fail(session.recovery, fail(reason, code ?? "closed"));
      yield* session.native.hostTools?.revoke ?? Effect.void;
      yield* session.hub.publish({ type: closedType, reason, ...(code ? { code } : {}) });
      yield* PubSub.publish(session.modelChanges, undefined);
    });
  const adoptIdentity = Effect.fnUntraced(function* (
    session: NativeSession,
    sessionId: string,
    file: string,
  ) {
    const sessionFile = yield* dependencies.canonicalize(file);
    if (sessionId === session.sessionId && sessionFile === session.ref.sessionFile) return;
    yield* session.native.hostTools?.revoke ?? Effect.void;
    const other = sessions.get(sessionFile);
    if (other && other !== session)
      return yield* fail(
        "The native owner moved to an already connected session. Reopen it explicitly.",
        "identity_conflict",
      );
    if (sessions.get(session.ref.sessionFile) === session) sessions.delete(session.ref.sessionFile);
    session.ref = { providerInstanceId: session.profile.providerInstanceId, sessionFile };
    session.state = { ...session.state, sessionId, sessionFile };
    session.sessionId = sessionId;
    sessions.set(sessionFile, session);
    yield* session.native.hostTools?.bind(session.ref) ?? Effect.void;
    yield* PubSub.publish(session.modelChanges, undefined);
  });
  const describe = (session: NativeSession): NeoPiNativeSessionsOpenResult => ({
    ref: session.ref,
    sessionId: session.sessionId,
    cwd: session.cwd,
    attachment: session.native.attachment,
    capabilities: Array.from(session.native.client.capabilities),
    state: session.state,
  });
  const refreshCwd = Effect.fnUntraced(function* (session: NativeSession) {
    if (session.cwdFile === session.ref.sessionFile) return;
    const rows = yield* dependencies.catalog(session.profile, undefined, session.ref.sessionFile);
    for (const row of rows) {
      if ((yield* dependencies.canonicalize(row.path)) === session.ref.sessionFile) {
        session.cwd = row.cwd;
        break;
      }
    }
    // Native new_session keeps its cwd even while its new file is still lazy.
    session.cwdFile = session.ref.sessionFile;
  });
  const refresh = Effect.fnUntraced(function* (session: NativeSession) {
    yield* session.profile.validate;
    if (session.closed) return yield* fail("This native connection is closed.", "closed");
    const state = yield* Schema.decodeUnknownEffect(NeoPiNativeSessionRecord)(
      yield* (
        session.native.readState ??
          session.native.client.request({ type: "get_state", includeDump: false })
      ),
    );
    const identity = yield* Schema.decodeUnknownEffect(StateIdentity)(state);
    yield* adoptIdentity(session, identity.sessionId, identity.sessionFile);
    session.state =
      state.sessionFile === session.ref.sessionFile
        ? state
        : { ...state, sessionFile: session.ref.sessionFile };
    session.busy = state.isStreaming === true;
    yield* refreshCwd(session);
    return describe(session);
  });
  const requireSession = Effect.fnUntraced(function* (ref: NeoPiNativeSessionRef) {
    const file = yield* dependencies.canonicalize(ref.sessionFile);
    const session = sessions.get(file);
    if (!session || session.closed)
      return yield* fail("Open this native session before using its connection.", "closed");
    if (session.profile.providerInstanceId !== ref.providerInstanceId)
      return yield* fail(
        "This native file is already connected through a different configured instance. Use that instance or close it explicitly.",
        "profile_conflict",
      );
    yield* session.profile.validate;
    return session;
  });
  const verifyRef = (session: NativeSession, ref: NeoPiNativeSessionRef) =>
    Effect.gen(function* () {
      if (
        session.closed ||
        session.ref.sessionFile !== (yield* dependencies.canonicalize(ref.sessionFile))
      )
        return yield* fail(
          "The native owner changed session. Select its new native file before sending commands.",
          "session_changed",
        );
    });
  const create = Effect.fnUntraced(function* (
    profile: NeoPiNativeProfile,
    input: NeoPiNativeSessionsOpenInput,
  ) {
    const scope = yield* Scope.fork(lifetime);
    const pendingUi = new Map<string, SessionEventFrame>();
    const hub = makeNeoPiNativeEventHub();
    const modelChanges = yield* Effect.acquireRelease(
      PubSub.unbounded<void>(),
      PubSub.shutdown,
    ).pipe(Effect.provideService(Scope.Scope, scope));
    const modelUi = yield* Effect.acquireRelease(
      PubSub.unbounded<UiRequestFrame>(),
      PubSub.shutdown,
    ).pipe(Effect.provideService(Scope.Scope, scope));
    let session: NativeSession | undefined;
    const publish = (frame: SessionEventFrame): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (frame.type === "extension_ui_request" && typeof frame.id === "string") {
          if (frame.method === "cancel" && typeof frame.targetId === "string")
            pendingUi.delete(frame.targetId);
          else if (
            frame.method === "select" ||
            frame.method === "confirm" ||
            frame.method === "input" ||
            frame.method === "editor" ||
            frame.method === "ask"
          )
            pendingUi.set(frame.id, frame);
        }
        if (
          (frame.type === "tool_approval_request" || frame.type === "plan_proposal_request") &&
          typeof frame.id === "string"
        )
          pendingUi.set(frame.id, frame);
        if (frame.type === "tool_approval_cancel" && typeof frame.targetId === "string")
          pendingUi.delete(frame.targetId);
        if (frame.type === "plan_proposal_cancel" && typeof frame.id === "string")
          pendingUi.delete(frame.id);
        const current = session;
        if (!current || current.closed) return;
        if (frame.type === "agent_start") current.busy = true;
        else if (frame.type === "agent_end") current.busy = false;
        if (
          frame.type === "journal_state" &&
          typeof frame.sessionId === "string" &&
          typeof frame.sessionFile === "string"
        ) {
          const adopted = yield* adoptIdentity(current, frame.sessionId, frame.sessionFile).pipe(
            Effect.result,
          );
          if (adopted._tag === "Failure") {
            yield* finish(current, nativeError(adopted.failure).message);
            yield* Scope.close(scope, Exit.void).pipe(Effect.forkIn(lifetime));
            return;
          }
        }
        if (frame.type === "models_configuration_changed" || frame.type === "model_changed")
          yield* PubSub.publish(modelChanges, undefined);
        if (
          frame.type === "extension_ui_request" &&
          typeof frame.id === "string" &&
          typeof frame.method === "string"
        )
          yield* PubSub.publish(modelUi, frame as UiRequestFrame);
        let outgoing = frame;
        if (typeof frame.sessionFile === "string" && typeof frame.sessionId === "string") {
          const canonical = yield* dependencies.canonicalize(frame.sessionFile).pipe(Effect.result);
          if (canonical._tag === "Failure") {
            yield* finish(current, nativeError(canonical.failure).message);
            yield* Scope.close(scope, Exit.void).pipe(Effect.forkIn(lifetime));
            return;
          }
          if (canonical.success !== frame.sessionFile)
            outgoing = { ...frame, sessionFile: canonical.success };
        }
        yield* hub.publish(outgoing);
      });
    /** One native connection in its own scope, so a successor can retire the dead one. */
    const establish = Effect.fnUntraced(function* (
      connectInput: NeoPiNativeSessionsOpenInput,
      mode: "auto" | "attach",
    ) {
      const nativeScope = yield* Scope.fork(scope);
      return yield* Effect.gen(function* () {
        const native = yield* dependencies
          .connect(profile, connectInput, publish, mode)
          .pipe(Effect.provideService(Scope.Scope, nativeScope));
        if (
          !native.client.capabilities.has("session_journal") ||
          !native.client.capabilities.has("session_journal_events")
        )
          return yield* fail(
            "The configured NeoPi must support session_journal and session_journal_events.",
            "unsupported",
          );
        const state = yield* Schema.decodeUnknownEffect(NeoPiNativeSessionRecord)(
          yield* (
            native.readState ?? native.client.request({ type: "get_state", includeDump: false })
          ),
        );
        const identity = yield* Schema.decodeUnknownEffect(StateIdentity)(state);
        const file = yield* dependencies.canonicalize(identity.sessionFile);
        if (
          connectInput.sessionFile &&
          file !== (yield* dependencies.canonicalize(connectInput.sessionFile))
        )
          return yield* fail(
            "NeoPi opened a different native file than requested.",
            "session_changed",
          );
        yield* profile.validate;
        return { native, nativeScope, state, identity, file };
      }).pipe(Effect.onError(() => Scope.close(nativeScope, Exit.void)));
    });
    const abandon = (current: NativeSession, reason: string, code?: string) =>
      finish(current, reason, code).pipe(Effect.andThen(Scope.close(scope, Exit.void)));
    /** Swap a successor owner into a live session, keeping its hub and watchers. */
    const adopt = Effect.fnUntraced(function* (current: NativeSession, mode: "auto" | "attach") {
      const next = yield* establish(
        {
          providerInstanceId: profile.providerInstanceId,
          sessionFile: current.ref.sessionFile,
          ...(input.cwd ? { cwd: input.cwd } : {}),
        },
        mode,
      );
      return yield* Effect.gen(function* () {
        if (current.closed) return yield* fail("This native connection is closed.", "closed");
        if (next.file !== current.ref.sessionFile)
          return yield* fail(
            "The native owner opened a different session file.",
            "session_changed",
          );
        yield* next.native.hostTools?.bind(current.ref) ?? Effect.void;
        current.native = next.native;
        current.nativeScope = next.nativeScope;
        current.sessionId = next.identity.sessionId;
        current.state =
          next.state.sessionFile === next.file
            ? next.state
            : { ...next.state, sessionFile: next.file };
        current.busy = next.state.isStreaming === true;
        return next.native;
      }).pipe(Effect.onError(() => Scope.close(next.nativeScope, Exit.void)));
    });
    /**
     * The terminal that owned this session is gone. A restart brings a successor
     * within seconds, so wait for one and attach to it. When none appears the session
     * closes as `owner_exited`, unless a prompt is waiting: that starts an owner of
     * NeoCode's own, which is safe only because no live owner holds the lease.
     */
    const recover = Effect.fnUntraced(function* (current: NativeSession, reason: string) {
      const recovery = yield* Deferred.make<void, NeoPiNativeSessionsError>();
      current.recovery = recovery;
      current.takeoverRequested = false;
      current.busy = false;
      pendingUi.clear();
      yield* current.native.hostTools?.revoke ?? Effect.void;
      yield* Scope.close(current.nativeScope, Exit.void);
      yield* hub.publish({ type: reconnectingType, reason });
      const attached = yield* Effect.gen(function* () {
        while (!current.closed) {
          const next = yield* adopt(current, "attach").pipe(Effect.result);
          if (next._tag === "Success") return next.success;
          if (nativeError(next.failure).code === "profile_changed") return yield* next.failure;
          yield* Effect.sleep(OWNER_REATTACH_POLL);
        }
        return undefined;
      }).pipe(Effect.timeoutOption(OWNER_REATTACH_GRACE), Effect.result);
      if (current.closed) return;
      if (attached._tag === "Failure")
        return yield* abandon(current, nativeError(attached.failure).message);
      let successor = attached.success._tag === "Some" ? attached.success.value : undefined;
      if (!successor) {
        if (!current.takeoverRequested)
          return yield* abandon(current, "No NeoPi is running this session now.", "owner_exited");
        const taken = yield* adopt(current, "auto").pipe(Effect.result);
        if (taken._tag === "Failure")
          return yield* abandon(current, nativeError(taken.failure).message);
        successor = taken.success;
      }
      current.recovery = null;
      yield* Deferred.succeed(recovery, undefined);
      yield* watchExit(current, successor);
      yield* hub.publish({ type: attachedType });
      yield* PubSub.publish(modelChanges, undefined);
    });
    const watchExit = (
      current: NativeSession,
      native: NeoPiNativeConnection,
    ): Effect.Effect<void> =>
      Deferred.await(native.client.exit).pipe(
        Effect.flatMap((exit) => {
          if (current.closed || current.native !== native) return Effect.void;
          const reason =
            exit.stderrTail ||
            `The native connection exited (${exit.code ?? exit.signal ?? "closed"}).`;
          return native.attachment === "terminal"
            ? recover(current, reason)
            : abandon(current, reason);
        }),
        Effect.forkIn(lifetime),
        Effect.asVoid,
      );
    return yield* Effect.gen(function* () {
      const { native, nativeScope, state, identity, file } = yield* establish(input, "auto");
      if (sessions.has(file))
        return yield* fail(
          "The native file already has a canonical connection.",
          "identity_conflict",
        );
      session = {
        profile,
        native,
        nativeScope,
        scope,
        hub,
        pendingUi,
        modelChanges,
        modelUi,
        state: state.sessionFile === file ? state : { ...state, sessionFile: file },
        openedAt: DateTime.formatIso(yield* DateTime.now),
        ref: { providerInstanceId: profile.providerInstanceId, sessionFile: file },
        sessionId: identity.sessionId,
        cwd: native.cwd,
        cwdFile: file,
        closed: false,
        busy: state.isStreaming === true,
        recovery: null,
        takeoverRequested: false,
      };
      const current = session;
      sessions.set(file, current);
      yield* Effect.addFinalizer(() => finish(current, "The native connection was closed.")).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      yield* native.hostTools?.bind(current.ref) ?? Effect.void;
      yield* watchExit(current, native);
      return current;
    }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
  });
  const open = (
    input: NeoPiNativeSessionsOpenInput,
  ): Effect.Effect<NeoPiNativeSessionsOpenResult, NeoPiNativeSessionsError> =>
    Effect.gen(function* () {
      const profile = yield* dependencies.profile(input.providerInstanceId);
      if (!input.sessionFile) return describe(yield* create(profile, input));
      const file = yield* dependencies.canonicalize(input.sessionFile);
      // A reopen while the owner is being replaced waits for the outcome, outside the
      // gate so an explicit close is never queued behind it. A closed outcome falls
      // through to a fresh open below.
      const recovering = sessions.get(file)?.recovery;
      if (recovering) yield* Deferred.await(recovering).pipe(Effect.ignore);
      return yield* (yield* gate(file)).withPermits(1)(
        Effect.gen(function* () {
          const existing = sessions.get(file);
          if (existing) {
            const current = yield* requireSession({
              providerInstanceId: input.providerInstanceId,
              sessionFile: file,
            });
            yield* refreshCwd(current);
            const result = current.pendingUi.size > 0 ? describe(current) : yield* refresh(current);
            yield* verifyRef(current, {
              providerInstanceId: input.providerInstanceId,
              sessionFile: file,
            });
            return result;
          }
          return describe(yield* create(profile, { ...input, sessionFile: file }));
        }),
      );
    }).pipe(Effect.mapError(nativeError));
  /**
   * What a session's owner is doing. NeoCode's own connection is authoritative
   * for sessions it owns; for a terminal-owned session the control snapshot
   * NeoPi reported wins and NeoCode's feed fills in when none answered.
   */
  const liveState = (
    connected: NativeSession | undefined,
    reported: CatalogRow["live"],
  ): NeoPiNativeSessionSummary["live"] => {
    if (!connected || connected.closed) return reported ?? undefined;
    if (connected.native.attachment === "terminal" && reported) return reported;
    const pendingDialogs = connected.pendingUi.size;
    return {
      state: pendingDialogs > 0 ? "waiting" : connected.busy ? "busy" : "idle",
      isStreaming: connected.busy,
      pendingDialogs,
      branch: reported?.branch ?? null,
    };
  };
  const list = (
    input: NeoPiNativeSessionsListInput,
  ): Effect.Effect<NeoPiNativeSessionsListResult, NeoPiNativeSessionsError> =>
    Effect.gen(function* () {
      const ids = input.providerInstanceId
        ? [input.providerInstanceId]
        : yield* dependencies.profileIds;
      const rows: NeoPiNativeSessionSummary[] = [];
      const diagnostics: Array<{ providerInstanceId: ProviderInstanceId; message: string }> = [];
      for (const id of ids) {
        const result = yield* Effect.gen(function* () {
          const profile = yield* dependencies.profile(id);
          return yield* dependencies.catalog(profile, input.cwd);
        }).pipe(Effect.result);
        if (result._tag === "Failure") {
          diagnostics.push({
            providerInstanceId: id,
            message: nativeError(result.failure).message,
          });
          continue;
        }
        for (const row of result.success) {
          const canonical = yield* dependencies.canonicalize(row.path).pipe(Effect.result);
          if (canonical._tag === "Failure") {
            diagnostics.push({
              providerInstanceId: id,
              message: nativeError(canonical.failure).message,
            });
            continue;
          }
          const file = canonical.success;
          const connected = sessions.get(file);
          if (connected && connected.profile.providerInstanceId === id) {
            connected.cwd = row.cwd;
            connected.cwdFile = file;
          }
          const live = liveState(
            connected && connected.profile.providerInstanceId === id ? connected : undefined,
            row.live,
          );
          rows.push({
            ref: { providerInstanceId: id, sessionFile: file },
            sessionId: row.id,
            cwd: row.cwd,
            title: row.title,
            firstMessage: row.firstMessage,
            modifiedAt: row.modified,
            owner:
              connected && !connected.closed && connected.profile.providerInstanceId === id
                ? { kind: "neocode", attachment: connected.native.attachment }
                : row.inUse
                  ? { kind: "process", pid: row.inUse.pid, attachable: row.control !== null }
                  : { kind: "none" },
            ...(live ? { live } : {}),
          });
        }
      }
      // Fresh native files are deliberately lazy; the CLI cannot list their unwritten headers.
      for (const session of sessions.values()) {
        if (
          session.closed ||
          (input.providerInstanceId &&
            session.profile.providerInstanceId !== input.providerInstanceId)
        )
          continue;
        const existing = rows.findIndex(
          (row) =>
            row.ref.providerInstanceId === session.profile.providerInstanceId &&
            row.ref.sessionFile === session.ref.sessionFile,
        );
        const cwd = existing >= 0 ? rows[existing]!.cwd : session.cwd;
        if (
          input.cwd &&
          (yield* dependencies.canonicalize(cwd)) !== (yield* dependencies.canonicalize(input.cwd))
        )
          continue;
        const live = existing >= 0 ? rows[existing]!.live : liveState(session, undefined);
        const summary: NeoPiNativeSessionSummary = {
          ref: session.ref,
          sessionId: session.sessionId,
          cwd,
          title:
            existing >= 0
              ? rows[existing]!.title
              : typeof session.state.sessionName === "string"
                ? session.state.sessionName
                : null,
          firstMessage: existing >= 0 ? rows[existing]!.firstMessage : "",
          modifiedAt: existing >= 0 ? rows[existing]!.modifiedAt : session.openedAt,
          owner: { kind: "neocode", attachment: session.native.attachment },
          ...(live ? { live } : {}),
        };
        if (existing >= 0) rows[existing] = summary;
        else rows.push(summary);
      }
      rows.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
      const settlement = dependencies.settlement;
      if (settlement) {
        const records = yield* settlement.store.read;
        const autoSettleAfterDays = yield* settlement.autoSettleAfterDays;
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const forgotten: Array<readonly [string, null]> = [];
        rows.forEach((row, index) => {
          const record = records.get(row.ref.sessionFile);
          const resolved = resolveNativeSettlement({
            record,
            modifiedAt: row.modifiedAt,
            live: row.live,
            autoSettleAfterDays,
            now,
          });
          if (record && !resolved.retain) forgotten.push([row.ref.sessionFile, null]);
          if (resolved.settledAt !== null) rows[index] = { ...row, settledAt: resolved.settledAt };
        });
        // Waking is bookkeeping: a failed write only means it is retried on the next list.
        if (forgotten.length > 0) yield* settlement.store.update(forgotten).pipe(Effect.ignore);
      }
      return { sessions: rows, diagnostics };
    }).pipe(Effect.mapError(nativeError));
  const setSettled = (
    input: NeoPiNativeSessionsSetSettledInput,
  ): Effect.Effect<NeoPiNativeSessionsSetSettledResult, NeoPiNativeSessionsError> =>
    Effect.gen(function* () {
      const settlement = dependencies.settlement;
      if (!settlement) return yield* fail("Settling sessions is unavailable.", "unsupported");
      const profile = yield* dependencies.profile(input.ref.providerInstanceId);
      const file = yield* dependencies.canonicalize(input.ref.sessionFile);
      // The decision holds until the file sees newer activity than this.
      let modifiedAt = sessions.get(file)?.openedAt;
      for (const row of yield* dependencies.catalog(profile, undefined, file)) {
        if ((yield* dependencies.canonicalize(row.path)) === file) modifiedAt = row.modified;
      }
      if (modifiedAt === undefined)
        return yield* fail("This native session is not available in the configured profile.");
      const decidedAt = DateTime.formatIso(yield* DateTime.now);
      yield* settlement.store.update([
        [
          file,
          { state: input.settled ? "settled" : "unsettled", settledAt: decidedAt, modifiedAt },
        ],
      ]);
      return { settled: input.settled };
    }).pipe(Effect.mapError(nativeError));
  /** Resolve file access from native authority without starting a session. */
  const resolveWorkspace = (ref: NeoPiNativeSessionRef) =>
    Effect.gen(function* () {
      const profile = yield* dependencies.profile(ref.providerInstanceId);
      const sessionFile = yield* dependencies.canonicalize(ref.sessionFile);
      const connected = sessions.get(sessionFile);
      if (
        connected &&
        !connected.closed &&
        connected.profile.providerInstanceId === ref.providerInstanceId
      ) {
        yield* connected.profile.validate;
        yield* refreshCwd(connected);
        yield* verifyRef(connected, { ...ref, sessionFile });
        return { ref: connected.ref, cwd: connected.cwd };
      }
      const rows = yield* dependencies.catalog(profile, undefined, sessionFile);
      for (const row of rows) {
        if ((yield* dependencies.canonicalize(row.path)) !== sessionFile) continue;
        yield* profile.validate;
        return {
          ref: { providerInstanceId: ref.providerInstanceId, sessionFile },
          cwd: yield* dependencies.canonicalize(row.cwd),
        };
      }
      return yield* fail(
        "This native session is not available in the configured profile.",
        "session_unavailable",
      );
    }).pipe(Effect.mapError(nativeError));
  const requestNative = (
    input: NeoPiNativeSessionsRequestInput,
    preserveId = false,
  ): Effect.Effect<unknown, NeoPiNativeSessionsError> =>
    Effect.gen(function* () {
      const session = yield* requireSession(input.ref);
      // A terminal owner is being replaced. A prompt asks for a takeover if none appears;
      // every request waits for the outcome rather than failing on a dead connection.
      if (session.recovery) {
        if (input.command.type === "prompt" || input.command.type === "slash")
          session.takeoverRequested = true;
        yield* Deferred.await(session.recovery);
      }
      const client = session.native.client;
      const command = input.command;
      if (
        command.type === "set_host_tools" ||
        command.type === "serve" ||
        command.type === "unserve" ||
        command.type === "host_tool_result" ||
        command.type === "host_tool_update"
      )
        return yield* fail(
          "Native host tools are server-owned; clients cannot replace registrations or supply results.",
          "host_tools_server_owned",
        );
      yield* verifyRef(session, input.ref);
      const preparedCommand = yield* dependencies.preparePrompt(input);
      // UI and approval answers are one-way side channels, never correlated RPC requests.
      if (command.type === "extension_ui_response") {
        const response = yield* Schema.decodeUnknownEffect(UiResponse)(command);
        yield* client.respondUi(response);
        session.pendingUi.delete(response.id);
        yield* session.hub.publish({ type: answeredType, id: response.id });
        return { accepted: true };
      }
      if (
        command.type === "tool_approval_response" ||
        command.type === "plan_proposal_response" ||
        command.type === "host_uri_result"
      ) {
        yield* client.writeFrame(command);
        if (
          (command.type === "tool_approval_response" ||
            command.type === "plan_proposal_response") &&
          typeof command.id === "string"
        ) {
          session.pendingUi.delete(command.id);
          yield* session.hub.publish({ type: answeredType, id: command.id });
        }
        return { accepted: true };
      }
      // Window-local ids must not collide; native Models login uses a server-generated UUID.
      const { id, requestId: _requestId, ...payload } = preparedCommand;
      let nativeCommand: Record<string, unknown> & { readonly type: string } =
        preserveId && typeof id === "string" ? { ...payload, id } : payload;
      // A terminal's prompt path runs only headless commands. Text its TUI would dispatch
      // is typed into the pane's editor instead, exactly as the user would type it there.
      if (
        session.native.attachment === "terminal" &&
        nativeCommand.type === "prompt" &&
        typeof nativeCommand.message === "string" &&
        nativeCommand.images === undefined &&
        !input.attachments?.length &&
        neoPiSlashCommandName(nativeCommand.message)
      ) {
        const listed = yield* client.request({ type: "get_available_commands" });
        const route = neoPiTerminalTextRoute(
          nativeCommand.message,
          neoPiAvailableCommands(
            Schema.is(NeoPiNativeSessionRecord)(listed) ? listed.commands : [],
          ),
          client.capabilities.has(NEOPI_CAPABILITIES.commandCatalog),
        );
        if (route === "tui") {
          const { message, streamingBehavior: _streaming, type: _type, ...rest } = nativeCommand;
          nativeCommand = { ...rest, type: "slash", text: message };
        }
      }
      let guardedCommand = nativeCommand;
      if (session.native.attachment === "terminal") {
        const current = yield* Schema.decodeUnknownEffect(ControlIdentity)(
          yield* client.request({ type: "get_status" }),
        );
        yield* adoptIdentity(session, current.session.sessionId, current.session.sessionFile);
        session.cwd = current.cwd;
        session.cwdFile = session.ref.sessionFile;
        yield* verifyRef(session, input.ref);
        const expected = nativeCommand.if;
        // Native control checks this atomically with dispatch. The terminal may
        // switch files after get_status; a stale graphical prompt must not follow it.
        if (expected === undefined)
          guardedCommand = { ...nativeCommand, if: { generation: current.revisions.generation } };
        else if (Schema.is(NeoPiNativeSessionRecord)(expected) && expected.generation === undefined)
          guardedCommand = {
            ...nativeCommand,
            if: { ...expected, generation: current.revisions.generation },
          };
      }
      const result = yield* client.request(guardedCommand);
      if (
        Schema.is(NeoPiNativeSessionRecord)(result) &&
        typeof result.sessionFile === "string" &&
        typeof result.sessionId === "string"
      ) {
        const canonical = yield* dependencies.canonicalize(result.sessionFile);
        return canonical === result.sessionFile ? result : { ...result, sessionFile: canonical };
      }
      // Commands such as abort succeed without data; undefined cannot cross the
      // JSON wire and would turn that success into a client-side failure.
      return result ?? null;
    }).pipe(Effect.mapError(nativeError));
  const request = (input: NeoPiNativeSessionsRequestInput) => requestNative(input);
  const watch = (input: {
    ref: NeoPiNativeSessionRef;
  }): Stream.Stream<NeoPiNativeSessionsStreamEvent, NeoPiNativeSessionsError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const session = yield* requireSession(input.ref);
        const events = yield* session.hub.subscribe;
        const uiEvents = yield* session.hub.subscribe;
        const pendingUi = Array.from(session.pendingUi.values());
        const isUi = (frame: SessionEventFrame) =>
          frame.type === answeredType ||
          frame.type === "extension_ui_request" ||
          frame.type === "tool_approval_request" ||
          frame.type === "tool_approval_cancel" ||
          frame.type === "plan_proposal_request" ||
          frame.type === "plan_proposal_cancel" ||
          frame.type === "host_tool_call" ||
          frame.type === "host_tool_cancel" ||
          frame.type === "host_uri_request";
        const asEvent = (frame: SessionEventFrame): NeoPiNativeSessionsStreamEvent => {
          if (frame.type === closedType)
            return {
              type: "closed",
              reason:
                typeof frame.reason === "string" ? frame.reason : "The native connection closed.",
              ...(typeof frame.code === "string" ? { code: frame.code } : {}),
            };
          if (frame.type === reconnectingType)
            return {
              type: "reconnecting",
              reason: typeof frame.reason === "string" ? frame.reason : "The native owner exited.",
            };
          // Only the native answer identity is shared, never credentials or feedback.
          if (frame.type === answeredType && typeof frame.id === "string")
            return { type: "answered", id: frame.id };
          return { type: "event", frame };
        };
        const snapshotAndEvents = Stream.unwrap(
          Effect.gen(function* () {
            let seen = new Set<string>();
            let beforeBoundary = true;
            const loadSnapshot = Effect.gen(function* () {
              const snapshot = yield* refresh(session);
              yield* verifyRef(session, input.ref);
              const boundary = yield* Schema.decodeUnknownEffect(JournalIdentity)(
                yield* session.native.client.request({ type: "snapshot_session_journal" }),
              );
              if (
                boundary.sessionId !== snapshot.sessionId ||
                (yield* dependencies.canonicalize(boundary.sessionFile)) !==
                  snapshot.ref.sessionFile
              )
                return yield* fail(
                  "The native session changed while preparing history. Reopen the new file.",
                  "session_changed",
                );
              const nativeJournal = yield* Schema.decodeUnknownEffect(NeoPiJournalPage)(
                yield* session.native.client.request({
                  type: "get_entries_page",
                  scope: "branch",
                  direction: "backward",
                  limit: 128,
                }),
              );
              if (
                nativeJournal.sessionId !== snapshot.sessionId ||
                (yield* dependencies.canonicalize(nativeJournal.sessionFile)) !==
                  snapshot.ref.sessionFile
              )
                return yield* fail(
                  "The native journal changed session while preparing history.",
                  "session_changed",
                );
              const journal =
                nativeJournal.sessionFile === snapshot.ref.sessionFile
                  ? nativeJournal
                  : { ...nativeJournal, sessionFile: snapshot.ref.sessionFile };
              seen = new Set(journal.entries.map((entry) => entry.id));
              beforeBoundary = true;
              return { type: "snapshot", session: snapshot, journal } as const;
            });
            const first = yield* loadSnapshot;
            const live = events.pipe(
              Stream.filter((frame) => {
                if (isUi(frame)) return false;
                if (frame.type === "journal_state" && frame.reason === "snapshot")
                  beforeBoundary = false;
                if (
                  beforeBoundary &&
                  (frame.type === "message_start" ||
                    frame.type === "message_update" ||
                    frame.type === "message_end")
                )
                  return false;
                if (
                  frame.type !== "journal_entry" ||
                  typeof frame.entry !== "object" ||
                  frame.entry === null ||
                  !("id" in frame.entry) ||
                  typeof frame.entry.id !== "string"
                )
                  return true;
                if (seen.has(frame.entry.id)) return false;
                seen.add(frame.entry.id);
                if (seen.size > 512) seen.delete(seen.values().next().value!);
                return true;
              }),
              // A successor owner means a different process: read history afresh.
              Stream.mapEffect((frame) =>
                frame.type === attachedType ? loadSnapshot : Effect.succeed(asEvent(frame)),
              ),
              Stream.takeUntil((event) => event.type === "closed"),
            );
            return Stream.concat(Stream.succeed<NeoPiNativeSessionsStreamEvent>(first), live);
          }),
        );
        // Dialog answers must be deliverable even if native startup/navigation blocks a snapshot.
        // This branch emits only raw side channels; transcript frames wait for canonical history.
        const ui = Stream.fromIterable(pendingUi).pipe(
          Stream.concat(uiEvents),
          Stream.filter((frame) => isUi(frame) || frame.type === closedType),
          Stream.map(asEvent),
          Stream.takeUntil((event) => event.type === "closed"),
        );
        return Stream.merge(snapshotAndEvents, ui, { haltStrategy: "either" });
      }),
    ).pipe(Stream.mapError(nativeError), Stream.scoped);
  const close = (input: {
    ref: NeoPiNativeSessionRef;
  }): Effect.Effect<{ closed: boolean }, NeoPiNativeSessionsError> =>
    Effect.gen(function* () {
      const file = yield* dependencies.canonicalize(input.ref.sessionFile);
      return yield* (yield* gate(file)).withPermits(1)(
        Effect.gen(function* () {
          const session = sessions.get(file);
          if (!session) return { closed: false };
          if (session.profile.providerInstanceId !== input.ref.providerInstanceId)
            return yield* fail(
              "This native connection belongs to another configured instance.",
              "profile_conflict",
            );
          yield* finish(session, "The native connection was explicitly closed.", "detached");
          if (session.native.attachment === "owned")
            yield* session.native.client
              .request({ type: "abort" })
              .pipe(Effect.timeoutOption("2 seconds"), Effect.ignore);
          // EOF disposes an owned RPC runtime; ctl pipe EOF detaches only its control socket.
          yield* Scope.close(session.scope, Exit.void);
          return { closed: true };
        }),
      );
    }).pipe(Effect.uninterruptible, Effect.mapError(nativeError));
  const modelsConnection = (
    ref: NeoPiNativeSessionRef,
  ): Effect.Effect<NeoPiModelsConnection, NeoPiNativeSessionsError> =>
    Effect.gen(function* () {
      const session = yield* requireSession(ref).pipe(
        Effect.catch((cause) =>
          nativeError(cause).code === "closed"
            ? fail("Native session is not connected. Open it before using Models.", "closed")
            : Effect.fail(cause),
        ),
      );
      const validate = Effect.gen(function* () {
        yield* session.profile.validate;
        yield* verifyRef(session, ref);
      });
      return {
        capabilities: session.native.client.capabilities,
        request: (command) =>
          Effect.gen(function* () {
            yield* validate;
            const nativeCommand =
              yield* Schema.decodeUnknownEffect(NeoPiNativeSessionCommand)(command);
            return yield* requestNative({ ref, command: nativeCommand }, true);
          }).pipe(
            Effect.mapError((cause) => {
              const error = nativeError(cause);
              return new NeoPiRpcError({
                message: error.message,
                ...(error.code ? { code: error.code } : {}),
              });
            }),
          ),
        respondUi: (response) =>
          request({ ref, command: { ...response, type: "extension_ui_response" } }).pipe(
            Effect.asVoid,
            Effect.mapError((cause) => new NeoPiRpcError({ message: cause.message })),
          ),
        ui: Stream.fromPubSub(session.modelUi),
        changes: Stream.fromPubSub(session.modelChanges),
        validate: validate.pipe(
          Effect.mapError((cause) => new NeoPiModelsError({ message: nativeError(cause).message })),
        ),
      } satisfies NeoPiModelsConnection;
    }).pipe(Effect.mapError(nativeError));
  if (dependencies.profileChanges)
    yield* Stream.runForEach(dependencies.profileChanges, () =>
      Effect.forEach(Array.from(sessions.values()), (session) =>
        session.profile.validate.pipe(
          Effect.catch((cause) =>
            finish(session, nativeError(cause).message).pipe(
              Effect.andThen(Scope.close(session.scope, Exit.void)),
            ),
          ),
        ),
      ),
    ).pipe(Effect.forkIn(lifetime));
  return { list, open, request, watch, close, modelsConnection, resolveWorkspace, setSettled };
});

/** Uses the configured runtime/profile and its existing CLI + RPC/control transports. No SQL bindings. */
export const makeNeoPiNativeSessions = Effect.fn("NeoPiNativeSessions.make")(function* () {
  const instances = yield* ProviderInstanceRegistry;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const canonicalize = Effect.fnUntraced(function* (file: string) {
    if (!NodePath.isAbsolute(file))
      return yield* fail("A native session file must be an absolute path.", "invalid_path");
    return yield* fs.realPath(file).pipe(
      Effect.catch((cause) => {
        // A native-created file may not have durable entries yet; only its leaf may be absent.
        if (cause.reason._tag !== "NotFound") return Effect.fail(cause);
        return fs
          .realPath(NodePath.dirname(file))
          .pipe(Effect.map((parent) => NodePath.join(parent, NodePath.basename(file))));
      }),
    );
  }, Effect.mapError(nativeError));
  const profile = Effect.fnUntraced(function* (id: ProviderInstanceId) {
    const instance = yield* instances.getInstance(id);
    const source = instance && neoPiSessionCatalogSource(instance);
    if (!instance?.enabled || instance.driverKind !== "neopi" || !source)
      return yield* fail("This configured NeoPi instance is unavailable. Check NeoCore settings.");
    return {
      providerInstanceId: id,
      source,
      validate: Effect.gen(function* () {
        if ((yield* instances.getInstance(id)) !== instance)
          return yield* fail(
            "The configured NeoPi instance changed. Close and reopen this native connection.",
            "profile_changed",
          );
      }),
    } satisfies NeoPiNativeProfile;
  });
  // Binaries that rejected `--live` once; older NeoPi keeps listing without it.
  const liveUnsupported = new Set<string>();
  const runCatalog = (profile: NeoPiNativeProfile, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(profile.source.binary, args, {
          cwd: config.cwd,
          env: profile.source.env,
          stdin: "ignore",
        }),
      );
      const [out, err, code] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: MAX_RPC_REASSEMBLED_BYTES }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: 65536 }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return {
        ok: Number(code) === 0 && !out.truncated && !err.truncated,
        out: out.text,
        err: err.text,
      };
    }).pipe(Effect.scoped, Effect.timeout("30 seconds"));
  const catalog = Effect.fnUntraced(function* (
    profile: NeoPiNativeProfile,
    cwd?: string,
    file?: string,
  ) {
    yield* profile.validate;
    const listArgs = (live: boolean) => [
      "sessions",
      "list",
      "--json",
      ...(file ? ["--session-dir", NodePath.dirname(file)] : ["--all"]),
      ...(live ? ["--live"] : []),
    ];
    // Only the full listing feeds the sidebar; single-file lookups need no owner probes.
    const live = !file && !liveUnsupported.has(profile.source.binary);
    let output = yield* runCatalog(profile, listArgs(live));
    if (!output.ok && live && /--live/.test(`${output.err}\n${output.out}`)) {
      liveUnsupported.add(profile.source.binary);
      output = yield* runCatalog(profile, listArgs(false));
    }
    if (!output.ok) return yield* fail(output.err || "Native session discovery failed.");
    const result = yield* Schema.decodeUnknownEffect(Catalog)(output.out);
    yield* profile.validate;
    if (!cwd) return result.sessions;
    const expected = yield* fs.realPath(cwd);
    return yield* Effect.filter(result.sessions, (row) =>
      fs.realPath(row.cwd).pipe(
        Effect.map((actual) => actual === expected),
        Effect.orElseSucceed(() => false),
      ),
    );
  }, Effect.mapError(nativeError));
  const catalogRow = Effect.fnUntraced(function* (profile: NeoPiNativeProfile, file: string) {
    const rows = yield* catalog(profile, undefined, file);
    for (const row of rows) {
      if ((yield* canonicalize(row.path)) === file) return row;
    }
    return undefined;
  });
  const connect: NeoPiNativeSessionsDependencies["connect"] = (
    profile,
    input,
    publish,
    mode = "auto",
  ) =>
    Effect.gen(function* () {
      const source = profile.source;
      const row = input.sessionFile ? yield* catalogRow(profile, input.sessionFile) : undefined;
      const cwd = row?.cwd ?? input.cwd ?? config.cwd;
      const canonicalCwd = yield* fs.realPath(cwd);
      const extra = yield* parseNeoPiLaunchArguments(source.launchArgs);
      const startupUi = yield* Deferred.make<void>();
      // Typed native side channels share this envelope; keep the original frame object.
      const publishFrame: (frame: { readonly type: string }) => Effect.Effect<void> = publish;
      let ownedPid: number | undefined;
      const spawn = Effect.fnUntraced(function* (args: string[], capturePid = false) {
        const transportScope = yield* Effect.scope;
        let hostPump: Effect.Success<ReturnType<typeof makeNeoPiNativeHostToolPump>> | undefined;
        let activeClient: NeoPiRpcClient | undefined;
        const client = yield* makeClient({
          spawn: (command) =>
            spawner.spawn(command).pipe(
              Effect.tap((handle) =>
                Effect.sync(() => {
                  if (capturePid) ownedPid = Number(handle.pid);
                }),
              ),
            ),
          command: source.binary,
          args,
          cwd: canonicalCwd,
          env: source.env,
          // Never bound the parser's queue: replies must pass even during a snapshot or slow UI.
          onTransportReady: (transport) =>
            Effect.gen(function* () {
              yield* Stream.runForEach(transport.events, publish).pipe(
                Effect.forkIn(transportScope),
              );
              yield* Stream.runForEach(transport.uiRequests, (frame) =>
                Effect.gen(function* () {
                  if (
                    frame.method === "select" ||
                    frame.method === "confirm" ||
                    frame.method === "input" ||
                    frame.method === "editor"
                  )
                    yield* Deferred.succeed(startupUi, undefined);
                  yield* publish(frame);
                }),
              ).pipe(Effect.forkIn(transportScope));
              hostPump = yield* makeNeoPiNativeHostToolPump(
                {
                  hostToolCalls: transport.hostToolCalls.pipe(Stream.tap(publishFrame)),
                  hostToolResult: transport.hostToolResult,
                },
                (ref) =>
                  Effect.gen(function* () {
                    yield* profile.validate;
                    if (!activeClient)
                      return yield* fail(
                        "Native host tools are not ready.",
                        "host_tools_unavailable",
                      );
                    const identity = yield* Schema.decodeUnknownEffect(StateIdentity)(
                      yield* activeClient.request({ type: "get_state", includeDump: false }),
                    );
                    if ((yield* canonicalize(identity.sessionFile)) !== ref.sessionFile)
                      return yield* fail("The native owner changed session.", "session_changed");
                  }).pipe(Effect.mapError(nativeError)),
              ).pipe(Effect.provideService(Scope.Scope, transportScope));
              yield* Stream.runForEach(transport.hostUriRequests, publishFrame).pipe(
                Effect.forkIn(transportScope),
              );
            }),
        });
        activeClient = client;
        // An already-running terminal may predate the installed binary. Old control
        // owners replace session-global tools, so only the owner's capability is safe.
        if (!capturePid && !client.capabilities.has("connection_owned_host_tools"))
          return { client, hostTools: undefined };
        if (!hostPump)
          return yield* fail(
            "Native host-tool transport is unavailable.",
            "host_tools_unavailable",
          );
        const pump = hostPump;
        const hostTools: NonNullable<NeoPiNativeConnection["hostTools"]> = {
          revoke: pump.revoke,
          bind: (ref) =>
            Effect.gen(function* () {
              yield* profile.validate;
              const settings = yield* serverSettings.getSettings;
              const overrides = Object.values(settings.projectSettingsOverrides);
              // Without a SQL thread there is no authoritative project binding. An
              // unresolved project override must not become an environment-level bypass.
              const capabilities = new Set<McpCapability>();
              if (
                settings.enableAgentBrowserAccess &&
                !overrides.some((entry) => entry.enableAgentBrowserAccess !== undefined)
              )
                capabilities.add("preview");
              if (
                settings.enableAgentDeviceAccess &&
                !overrides.some((entry) => entry.enableAgentDeviceAccess !== undefined)
              )
                capabilities.add("device");
              const tools = yield* pump.bind(ref, capabilities);
              const registered = yield* client
                .request({ type: "set_host_tools", tools })
                .pipe(Effect.result);
              if (registered._tag === "Success") return;
              // NeoPi keeps host-tool names session-global: a second NeoCode
              // attaching to the same session cannot take them over. Stay
              // attached without them and say so, rather than failing the attach.
              if (!/conflicts with an existing tool/i.test(String(registered.failure.message)))
                return yield* registered.failure;
              yield* pump.revoke;
              yield* publish({
                type: "extension_ui_request",
                id: "neocode-host-tools",
                method: "setStatus",
                statusKey: "hostTools",
                statusText:
                  "Browser preview and device tools stay with the NeoCode window that attached first; this window follows the session without them.",
              } as SessionEventFrame);
            }).pipe(Effect.mapError(nativeError)),
        };
        return { client, hostTools };
      });
      const attach = (owner: CatalogRow | undefined) =>
        Effect.gen(function* () {
          if (!owner?.control)
            return yield* fail(
              "The native session is in use without an attachable control endpoint.",
              "session_in_use",
            );
          const { client, hostTools } = yield* spawn([
            "ctl",
            "pipe",
            owner.control.instanceId,
            "--label",
            "neocode-native",
          ]);
          if (!client.capabilities.has("control_v1"))
            return yield* fail(
              "The native endpoint did not establish a control attachment.",
              "unsupported",
            );
          return {
            client,
            attachment: "terminal" as const,
            cwd: canonicalCwd,
            ...(hostTools ? { hostTools } : {}),
          };
        });
      if (row?.inUse) return yield* attach(row);
      if (mode === "attach") return yield* fail("No NeoPi owns this session yet.", "no_owner");
      const args = [
        "--mode",
        "rpc-ui",
        "--cwd",
        canonicalCwd,
        "--no-title",
        ...extra,
        ...(input.sessionFile ? ["--session", input.sessionFile] : ["--new-session"]),
      ];
      // A losing ownership attempt has its own scope; release it before attaching the real writer.
      const attemptScope = yield* Scope.fork(yield* Effect.scope);
      const attempt = yield* spawn(args, true).pipe(
        Effect.provideService(Scope.Scope, attemptScope),
        Effect.result,
      );
      if (attempt._tag === "Success") {
        const { client, hostTools } = attempt.success;
        let booting = true;
        const readState = Effect.suspend(() => {
          const ordinary = client.request({ type: "get_state", includeDump: false }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                booting = false;
              }),
            ),
          );
          if (!booting) return ordinary;
          // A native extension can await UI before stdio startup releases get_state.
          // Read the same session through its existing control dispatcher, which is
          // independent of that startup gate. Never synthesize an identity or header.
          const duringDialog = Deferred.await(startupUi).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                if (ownedPid === undefined)
                  return yield* fail(
                    "The native process has no control identity.",
                    "startup_unavailable",
                  );
                return yield* Effect.gen(function* () {
                  const reader = yield* makeClient({
                    spawn: spawner.spawn,
                    command: source.binary,
                    args: ["ctl", "pipe", `pid:${ownedPid}`, "--label", "neocode-native-startup"],
                    cwd: canonicalCwd,
                    env: source.env,
                  });
                  const status = yield* Schema.decodeUnknownEffect(
                    Schema.Struct({ ready: Schema.Boolean }),
                  )(yield* reader.request({ type: "get_status" }));
                  const state = yield* reader.request({ type: "get_state", includeDump: false });
                  if (status.ready) booting = false;
                  return state;
                }).pipe(Effect.scoped);
              }),
            ),
          );
          return Effect.raceFirst(ordinary, duringDialog);
        }).pipe(Effect.mapError(nativeError));
        return {
          client,
          attachment: "owned" as const,
          cwd: canonicalCwd,
          readState,
          ...(hostTools ? { hostTools } : {}),
        };
      }
      yield* Scope.close(attemptScope, Exit.void);
      if (
        !(attempt.failure instanceof NeoPiRpcError) ||
        attempt.failure.code !== "session_in_use" ||
        !input.sessionFile
      )
        return yield* Effect.fail(attempt.failure);
      return yield* attach(yield* catalogRow(profile, input.sessionFile));
    }).pipe(Effect.mapError(nativeError));
  const profileChanges = yield* instances.subscribeChanges;
  return yield* makeNeoPiNativeSessionsWith({
    profileChanges: Stream.fromSubscription(profileChanges),
    profileIds: Effect.gen(function* () {
      const all = yield* instances.listInstances;
      const unavailable = yield* instances.listUnavailable;
      return Array.from(
        new Set([
          ...all
            .filter((instance) => instance.enabled && instance.driverKind === "neopi")
            .map((instance) => instance.instanceId),
          ...unavailable
            .filter((instance) => instance.driver === "neopi")
            .map((instance) => instance.instanceId),
        ]),
      );
    }),
    profile,
    canonicalize,
    preparePrompt: (input) =>
      prepareNeoPiNativePrompt(input, config.attachmentsDir).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
    catalog,
    connect,
    settlement: {
      store: yield* makeNeoPiNativeSettledStore(
        NodePath.join(config.stateDir, "neopi-native-settled.json"),
      ),
      autoSettleAfterDays: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.sidebarAutoSettleAfterDays),
        Effect.orElseSucceed(() => null),
      ),
    },
  });
});

export class NeoPiNativeSessions extends Context.Service<
  NeoPiNativeSessions,
  Effect.Success<ReturnType<typeof makeNeoPiNativeSessions>>
>()("t3/provider/neopi/NeoPiNativeSessions") {
  static readonly layer = Layer.effect(NeoPiNativeSessions, makeNeoPiNativeSessions());
}
