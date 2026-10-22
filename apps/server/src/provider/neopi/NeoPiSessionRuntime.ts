// @effect-diagnostics nodeBuiltinImport:off -- compare session identities with Node path resolution.
import * as NodePath from "node:path";
import type { ModelSelection, RuntimeMode, ThreadId, TurnId } from "@t3tools/contracts";
import {
  make as makeClient,
  type NeoPiRpcClient,
  type NeoPiRpcTransport,
  type PromptHandle,
  type SpawnFn,
  type HostToolCallFrame,
} from "effect-neopi-rpc/client";
import type { PlanProposalResponseFrame } from "effect-neopi-rpc/schema";
import { NeoPiRpcError } from "effect-neopi-rpc/errors";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { buildNeoPiLaunchPlan, isSharedNeoPiCursor } from "./NeoPiLaunchArgs.ts";
import { NEOPI_CAPABILITIES, neopiCompatibility } from "./NeoPiCompatibility.ts";
import { neoPiRoleFromModelSlug } from "./NeoPiModelCatalog.ts";
import { NeoPiRuntimeError } from "./NeoPiRuntimeError.ts";
import { makeNeoPiNativeEventHub } from "./NeoPiNativeEventHub.ts";
import type {
  NeoPiResumeCursor,
  NeoPiRuntimeFrame,
  NeoPiRuntimeState,
  NeoPiSessionRuntimeShape,
  NeoPiTurnInput,
} from "./NeoPiRuntimeTypes.ts";

interface SessionState {
  sessionId?: string;
  sessionFile?: string;
  messageCount?: number;
  contextUsage?: { tokens?: number };
  [key: string]: unknown;
}
interface HostBridge {
  readonly definitions: ReadonlyArray<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    loadMode?: string;
  }>;
  readonly handle: (
    call: HostToolCallFrame,
    signal: AbortSignal,
  ) => Effect.Effect<
    {
      content: ReadonlyArray<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      >;
      details?: unknown;
      isError?: boolean;
    },
    never
  >;
}
export interface NeoPiRuntimeInput {
  readonly threadId: ThreadId;
  readonly binary: string;
  readonly cwd: string;
  readonly t3Home: string;
  readonly env?: Record<string, string>;
  readonly projectId: string;
  readonly profile?: string;
  readonly launchArgs?: string;
  readonly runtimeMode: RuntimeMode;
  readonly cursor?: NeoPiResumeCursor;
  /** Latest successful provider probe; absent/partial capability sets retain isolated files. */
  readonly sharedSessionCapabilities?: ReadonlySet<string>;
  readonly spawn: SpawnFn;
  readonly hostBridge?: HostBridge;
  readonly requestTimeoutMs?: number;
  readonly closeGraceMs?: number;
}

const rpcError = (cause: unknown): NeoPiRuntimeError =>
  new NeoPiRuntimeError({
    code:
      cause instanceof NeoPiRpcError && cause.code === "session_in_use" ? "session_in_use" : "rpc",
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const identityError = (message: string) =>
  new NeoPiRuntimeError({ code: "identity_mismatch", message });
const unknownCommand = (error: NeoPiRuntimeError) => /unknown command/i.test(error.message);
const activeUiMethods = new Set(["select", "confirm", "input", "editor"]);
const decodeOwnerCatalog = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      sessions: Schema.Array(
        Schema.Struct({
          path: Schema.String,
          inUse: Schema.NullOr(Schema.Struct({ pid: Schema.Number })),
          control: Schema.NullOr(Schema.Struct({ instanceId: Schema.String })),
        }),
      ),
    }),
  ),
);

type ActiveTurn = {
  readonly id: TurnId;
  readonly baselineLeaf: string | null;
  readonly boundaryDone: Deferred.Deferred<void>;
  boundaryStarted: boolean;
  readonly continuation?: boolean;
  promptId?: string;
  readonly promptReady?: Deferred.Deferred<PromptHandle>;
  agentInvoked: boolean;
  interrupted: boolean;
  error?: { reason: string; message?: string };
};

export const makeNeoPiSessionRuntime = Effect.fn("NeoPiSessionRuntime.make")(function* (
  input: NeoPiRuntimeInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const state = yield* SubscriptionRef.make<NeoPiRuntimeState>("stopped");
  const cursor = yield* SubscriptionRef.make<NeoPiResumeCursor>(
    input.cursor ?? { v: 1, sessionFile: "", sessionId: "", sessionDir: "", turnBoundaries: [] },
  );
  const frames = yield* Queue.unbounded<NeoPiRuntimeFrame, Cause.Done<void>>();
  const nativeEvents = makeNeoPiNativeEventHub();
  const configurationChanges = yield* PubSub.sliding<void>(1);
  const invalidateConfiguration = PubSub.publish(configurationChanges, undefined).pipe(
    Effect.asVoid,
  );
  const capabilities = new Set<string>();
  const uiPending = new Set<string>();
  const hostPending = new Map<string, Scope.Closeable>();
  let client: NeoPiRpcClient | undefined;
  let earlyUi: Pick<NeoPiRpcTransport, "respondUi"> | undefined;
  let lifetime: Scope.Closeable | undefined;
  let generation = 0;
  let active: ActiveTurn | undefined;
  let compacting = false;
  let pendingProposal:
    | {
        readonly id: string;
        readonly done: Deferred.Deferred<void, NeoPiRuntimeError>;
        resolving: boolean;
        withdrawing?: boolean;
        closed?: boolean;
      }
    | undefined;
  let mode = input.runtimeMode;
  let pendingMode = false;
  let attached = false;
  const requireOwner = (operation: string) =>
    Effect.suspend(() =>
      attached
        ? Effect.fail(
            new NeoPiRpcError({
              code: "attached_session",
              command: operation,
              message: `Cannot ${operation} on an attached NeoPi session owned by another process. Use the terminal owner instead.`,
            }),
          )
        : Effect.void,
    );

  const emit = (frame: NeoPiRuntimeFrame) =>
    Queue.offer(frames, frame).pipe(Effect.orDie, Effect.asVoid);
  const setState = (value: NeoPiRuntimeState) =>
    SubscriptionRef.set(state, value).pipe(
      Effect.andThen(invalidateConfiguration),
      Effect.andThen(() => value === "stopped" || value === "failed" || value === "stopping"
        ? nativeEvents.publish({ type: "neocode_connection_closed", state: value })
        : Effect.void),
    );
  const current = () =>
    client
      ? Effect.succeed(client)
      : Effect.fail(
          new NeoPiRuntimeError({ code: "closed", message: "NeoPi session is not connected" }),
        );
  // Only read operations and interrupting our own turn may cross an attached
  // control connection. New mutating commands are refused by default.
  const attachedReadCommands = new Set([
    "get_state",
    "snapshot_session_journal",
    "get_entries",
    "get_entries_page",
    "get_messages_page",
    "get_usage",
    "get_roles",
    "get_commands",
  ]);
  const request: NeoPiRpcClient["request"] = (cmd) =>
    Effect.gen(function* () {
      if (!attachedReadCommands.has(cmd.type) && !(cmd.type === "abort" && active))
        yield* requireOwner(cmd.type);
      if (!client)
        return yield* new NeoPiRpcError({
          code: "closed",
          message: "NeoPi session is not connected",
          command: cmd.type,
        });
      return yield* client.request(cmd);
    });
  const getState = () =>
    request({ type: "get_state" }).pipe(
      Effect.map((data) => record(data) as SessionState),
      Effect.mapError(rpcError),
    );
  const publishState = () =>
    Effect.flatMap(getState(), (value) => emit({ type: "t3.state", state: value }));
  const cancelPending = Effect.gen(function* () {
    for (const id of uiPending) {
      if (!attached)
        yield* client?.respondUi({ id, cancelled: true }).pipe(Effect.ignore) ?? Effect.void;
      yield* emit({
        type: "extension_ui_request",
        id,
        method: "cancel",
        targetId: id,
        ...(active ? { turnId: active.id } : {}),
      });
    }
    uiPending.clear();
    for (const [id, requestScope] of hostPending) {
      yield* Scope.close(requestScope, Exit.void);
      yield* emit({
        type: "host_tool_cancel",
        id,
        targetId: id,
        ...(active ? { turnId: active.id } : {}),
      });
    }
    hostPending.clear();
  });
  const captureBoundary = (turn: ActiveTurn) =>
    Effect.gen(function* () {
      if (capabilities.has(NEOPI_CAPABILITIES.promptEntryIds)) {
        if (!turn.promptReady) return;
        const outcome = yield* Deferred.await((yield* Deferred.await(turn.promptReady)).outcome);
        if (outcome.kind === "rejected") return;
        if (outcome.kind === "agent") turn.agentInvoked = true;
        let boundary: NeoPiResumeCursor["turnBoundaries"][number] | undefined;
        if (outcome.userEntryId) {
          const result = record(
            yield* request({ type: "get_entries" }).pipe(Effect.mapError(rpcError)),
          );
          const entries = Array.isArray(result.entries) ? result.entries.map(record) : [];
          const byId = new Map(
            entries
              .filter((entry) => typeof entry.id === "string")
              .map((entry) => [entry.id, entry]),
          );
          let id = typeof result.leafId === "string" ? result.leafId : null;
          const seen = new Set<string>();
          while (id && !seen.has(id)) {
            if (id === outcome.userEntryId) {
              boundary = { turnId: turn.id, userEntryId: id };
              break;
            }
            seen.add(id);
            const entry = byId.get(id);
            id = typeof entry?.parentId === "string" ? entry.parentId : null;
          }
        }
        if (!boundary && outcome.kind === "local") boundary = { turnId: turn.id, kind: "local" };
        if (boundary) {
          const previous = yield* SubscriptionRef.get(cursor);
          yield* SubscriptionRef.set(cursor, {
            ...previous,
            turnBoundaries: [...previous.turnBoundaries, boundary],
          });
        }
        return;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = record(
          yield* request({ type: "get_entries" }).pipe(Effect.mapError(rpcError)),
        );
        const entries = Array.isArray(result.entries) ? result.entries.map(record) : [];
        const byId = new Map(
          entries.filter((entry) => typeof entry.id === "string").map((entry) => [entry.id, entry]),
        );
        const descendants: Record<string, unknown>[] = [];
        let id = typeof result.leafId === "string" ? result.leafId : null;
        const seen = new Set<string>();
        while (id !== turn.baselineLeaf && id !== null && !seen.has(id)) {
          seen.add(id);
          const entry = byId.get(id);
          if (!entry) break;
          descendants.push(entry);
          id = typeof entry.parentId === "string" ? entry.parentId : null;
        }
        // Prompt text changes under templates and mentions; follow the active
        // ancestry from the pre-admission leaf to the first new user entry.
        const user = (id === turn.baselineLeaf ? descendants.reverse() : []).find(
          (entry) => entry.type === "message" && record(entry.message).role === "user",
        );
        if (user && typeof user.id === "string") {
          const previous = yield* SubscriptionRef.get(cursor);
          yield* SubscriptionRef.set(cursor, {
            ...previous,
            turnBoundaries: [...previous.turnBoundaries, { turnId: turn.id, userEntryId: user.id }],
          });
          return;
        }
        if (attempt < 2) yield* Effect.sleep("50 millis");
      }
      yield* emit({
        type: "notice",
        level: "warning",
        message: "NeoPi did not expose this turn's user entry; rollback is unavailable for it",
        turnId: turn.id,
      });
    });
  const rememberBoundary = (turn: ActiveTurn) =>
    captureBoundary(turn).pipe(
      Effect.catch((error) =>
        emit({
          type: "notice",
          level: "warning",
          message: `NeoPi boundary capture failed: ${error.message}`,
          turnId: turn.id,
        }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          const previous = yield* SubscriptionRef.get(cursor);
          if (!previous.turnBoundaries.some((boundary) => boundary.turnId === turn.id))
            yield* SubscriptionRef.set(cursor, {
              ...previous,
              turnBoundaries: [...previous.turnBoundaries, { turnId: turn.id, kind: "unknown" }],
            });
          yield* Deferred.succeed(turn.boundaryDone, undefined).pipe(Effect.ignore);
        }),
      ),
    );
  const settle = (
    turn: ActiveTurn,
    outcome: "completed" | "failed" | "interrupted",
    errorMessage?: string,
  ) =>
    Effect.gen(function* () {
      if (active !== turn) return;
      active = undefined;
      if (
        (turn.agentInvoked || capabilities.has(NEOPI_CAPABILITIES.promptEntryIds)) &&
        !turn.continuation &&
        client &&
        (yield* SubscriptionRef.get(state)) !== "failed"
      ) {
        if (turn.boundaryStarted) yield* Deferred.await(turn.boundaryDone);
        else yield* rememberBoundary(turn);
      }
      if (
        !(turn.continuation && outcome !== "completed") &&
        !(yield* SubscriptionRef.get(cursor)).turnBoundaries.some(
          (boundary) => boundary.turnId === turn.id,
        )
      ) {
        const previous = yield* SubscriptionRef.get(cursor);
        yield* SubscriptionRef.set(cursor, {
          ...previous,
          turnBoundaries: [
            ...previous.turnBoundaries,
            {
              turnId: turn.id,
              kind: !turn.agentInvoked && outcome === "completed" ? "local" : "unknown",
            },
          ],
        });
      }
      if ((yield* SubscriptionRef.get(state)) === "running") yield* setState("ready");
      yield* emit({
        type: "t3.turn.outcome",
        state: outcome,
        ...(errorMessage ? { errorMessage } : {}),
        turnId: turn.id,
      });
      if ((yield* SubscriptionRef.get(state)) === "ready")
        yield* publishState().pipe(Effect.ignore);
    });
  const observePrompt = (turn: ActiveTurn, handle: PromptHandle) =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.await(handle.outcome);
      if (active !== turn || outcome.kind !== "agent") return;
      turn.agentInvoked = true;
      if (!capabilities.has(NEOPI_CAPABILITIES.promptEntryIds) && !turn.boundaryStarted) {
        turn.boundaryStarted = true;
        yield* rememberBoundary(turn).pipe(Effect.forkIn(lifetime!));
      }
    });
  const rejectProposal = (proposal: NonNullable<typeof pendingProposal>, message: string) =>
    Effect.gen(function* () {
      if (pendingProposal === proposal) {
        pendingProposal = undefined;
        if (!proposal.closed) yield* emit({ type: "t3.plan.proposal.closed", id: proposal.id });
      }
      const turn = active;
      if (turn?.continuation) {
        const previous = yield* SubscriptionRef.get(cursor);
        yield* SubscriptionRef.set(cursor, {
          ...previous,
          turnBoundaries: previous.turnBoundaries.filter((boundary) => boundary.turnId !== turn.id),
        });
        yield* settle(turn, "failed", message);
      }
      yield* Deferred.fail(
        proposal.done,
        new NeoPiRuntimeError({ code: "not_ready", message }),
      ).pipe(Effect.ignore);
    });
  const handleEvent = (frame: NeoPiRuntimeFrame) =>
    Effect.gen(function* () {
      if (frame.type === "model_changed" || frame.type === "thinking_level_changed")
        yield* invalidateConfiguration;
      // Native observers retain process-local message IDs independently of SQL
      // turns. Only message_persisted can associate one with a durable entry.
      yield* nativeEvents.publish(frame);
      if (frame.type === "journal_state" || frame.type === "journal_entry" || frame.type === "message_persisted") return;
      // External terminal work must not create or settle NeoCode SQL turns.
      if (attached && !active) return;
      if (!active && (frame.type.startsWith("message_") || frame.type === "agent_start" || frame.type === "agent_end" || frame.type === "turn_start" || frame.type === "turn_end")) return;
      const turn = active;
      yield* emit({ ...frame, ...(turn ? { turnId: turn.id } : {}) });
      const rejected = pendingProposal;
      if (
        frame.type === "t3.plan.proposal.rejected" &&
        rejected !== undefined &&
        rejected.id === frame.id
      ) {
        yield* rejectProposal(
          rejected,
          typeof frame.error === "string" ? frame.error : "NeoPi rejected the plan proposal",
        );
        return;
      }
      if (
        (frame.type === "model_changed" || frame.type === "config_warnings_changed") &&
        !record(frame).model
      ) {
        if (lifetime) yield* publishState().pipe(Effect.ignore, Effect.forkIn(lifetime));
      }
      if (
        frame.type === "plan_proposal_request" &&
        typeof frame.id === "string" &&
        frame.id &&
        capabilities.has(NEOPI_CAPABILITIES.setMode) &&
        turn
      ) {
        pendingProposal = {
          id: frame.id,
          done: yield* Deferred.make<void, NeoPiRuntimeError>(),
          resolving: false,
        };
        yield* settle(turn, "completed");
        return;
      }
      if (pendingProposal) {
        const proposal = pendingProposal;
        const terminal = frame.type === "agent_end" && frame.isTerminal !== false;
        const cancelled = capabilities.has(NEOPI_CAPABILITIES.planProposalCancel)
          ? frame.type === "plan_proposal_cancel" && frame.id === proposal.id
          : (terminal && !proposal.resolving) ||
            (frame.type === "mode_changed" && frame.mode !== "plan" && !proposal.resolving);
        if (cancelled && !proposal.closed) {
          proposal.closed = true;
          yield* emit({ type: "t3.plan.proposal.closed", id: proposal.id });
        }
        if (cancelled && proposal.resolving && !proposal.withdrawing && turn?.continuation) {
          yield* rejectProposal(proposal, "NeoPi cancelled the proposed plan");
          return;
        }
        if (
          (terminal &&
            (proposal.resolving || !capabilities.has(NEOPI_CAPABILITIES.planProposalCancel))) ||
          (cancelled && !proposal.withdrawing)
        ) {
          pendingProposal = undefined;
          if (!proposal.closed) yield* emit({ type: "t3.plan.proposal.closed", id: proposal.id });
          yield* Deferred.succeed(proposal.done, undefined).pipe(Effect.ignore);
        }
      }
      if (!turn) return;
      if (
        (frame.type === "t3.prompt.local" ||
          (frame.type === "prompt_result" && frame.agentInvoked === false)) &&
        (!turn.promptId || frame.id === turn.promptId)
      ) {
        yield* settle(turn, "completed");
        return;
      }
      if (frame.type === "t3.prompt.failed" && (!turn.promptId || frame.id === turn.promptId)) {
        yield* settle(
          turn,
          "failed",
          typeof frame.error === "string" ? frame.error : "prompt failed",
        );
        return;
      }
      if (frame.type === "agent_start") {
        turn.agentInvoked = true;
        delete turn.error;
      }
      if (frame.type === "message_start" && record(frame.message).role === "assistant")
        delete turn.error;
      if (frame.type === "message_update") {
        const event = record(frame.assistantMessageEvent);
        if (event.type === "error" && (event.reason === "aborted" || event.reason === "error")) {
          turn.error = {
            reason: event.reason,
            ...(typeof record(event.error).errorMessage === "string"
              ? { message: String(record(event.error).errorMessage) }
              : {}),
          };
        }
      }
      if (frame.type !== "agent_end" || frame.isTerminal === false) return;
      const last = Array.isArray(frame.messages)
        ? frame.messages
            .map(record)
            .filter((message) => message.role === "assistant")
            .at(-1)
        : undefined;
      const reason = last?.stopReason ?? turn.error?.reason;
      const message =
        turn.error?.message ??
        (typeof last?.errorMessage === "string" ? last.errorMessage : undefined);
      yield* settle(
        turn,
        reason === "aborted" || (turn.interrupted && reason !== "error")
          ? "interrupted"
          : reason === "error"
            ? "failed"
            : "completed",
        message,
      );
    });
  const pumpHost = (peer: Pick<NeoPiRpcTransport, "hostToolCalls" | "hostToolResult">) =>
    Stream.runForEach(peer.hostToolCalls, (call) =>
      Effect.gen(function* () {
        if (attached) return;
        if (call.type === "host_tool_cancel") {
          const requestScope = hostPending.get(call.targetId);
          if (requestScope) yield* Scope.close(requestScope, Exit.void);
          hostPending.delete(call.targetId);
        } else if (!input.hostBridge) {
          yield* peer
            .hostToolResult(
              call.id,
              {
                content: [{ type: "text", text: `Unsupported host tool: ${call.toolName}` }],
                isError: true,
              },
              true,
            )
            .pipe(Effect.ignore);
        } else {
          const requestScope = yield* Scope.make();
          const signal = yield* Effect.abortSignal.pipe(
            Effect.provideService(Scope.Scope, requestScope),
          );
          hostPending.set(call.id, requestScope);
          yield* input.hostBridge.handle(call, signal).pipe(
            Effect.catchCause((cause) =>
              Effect.succeed({
                content: [{ type: "text" as const, text: String(cause) }],
                isError: true,
              }),
            ),
            Effect.flatMap((result) =>
              signal.aborted || hostPending.get(call.id) !== requestScope
                ? Effect.void
                : peer.hostToolResult(call.id, result, result.isError),
            ),
            Effect.ensuring(
              Scope.close(requestScope, Exit.void).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    hostPending.delete(call.id);
                  }),
                ),
              ),
            ),
            Effect.ignore,
            Effect.forkIn(lifetime!),
          );
        }
        yield* emit({ ...call, ...(active ? { turnId: active.id } : {}) });
      }),
    );
  const closePeer = Effect.gen(function* () {
    generation++;
    yield* invalidateConfiguration;
    if (pendingProposal) {
      const proposal = pendingProposal;
      pendingProposal = undefined;
      yield* Deferred.fail(
        proposal.done,
        new NeoPiRuntimeError({ code: "closed", message: "NeoPi closed with a pending plan" }),
      ).pipe(Effect.ignore);
    }
    yield* cancelPending;
    const closing = client;
    if (closing) yield* closing.close(input.closeGraceMs ?? 150).pipe(Effect.ignore);
    const exit = closing ? yield* Deferred.await(closing.exit) : undefined;
    if (lifetime) yield* Scope.close(lifetime, Exit.void).pipe(Effect.ignore);
    client = undefined;
    earlyUi = undefined;
    lifetime = undefined;
    return exit;
  });
  const start: NeoPiSessionRuntimeShape["start"] = Effect.gen(function* () {
    const previous = yield* SubscriptionRef.get(state);
    if (previous !== "stopped" && previous !== "failed")
      return yield* new NeoPiRuntimeError({
        code: "not_ready",
        message: "NeoPi runtime is already started",
      });
    yield* setState("starting");
    const epoch = ++generation;
    const saved = yield* SubscriptionRef.get(cursor);
    const resume = saved.sessionId ? saved : undefined;
    const sharedSession = resume
      ? isSharedNeoPiCursor(resume, input.t3Home)
      : input.sharedSessionCapabilities?.has(NEOPI_CAPABILITIES.sessionLease) === true &&
        input.sharedSessionCapabilities.has(NEOPI_CAPABILITIES.newSession);
    if (
      resume &&
      sharedSession &&
      !input.sharedSessionCapabilities?.has(NEOPI_CAPABILITIES.sessionLease)
    ) {
      yield* setState("failed");
      return yield* new NeoPiRuntimeError({
        code: "startup",
        message: "NeoPi cannot reopen a shared session without verified lease support.",
      });
    }
    const launch = yield* buildNeoPiLaunchPlan({
      ...input,
      runtimeMode: mode,
      sharedSession,
      ...(resume ? { cursor: resume } : {}),
    }).pipe(Effect.tapError(() => setState("failed")));
    const scope = yield* Scope.make();
    lifetime = scope;
    const begin = Effect.gen(function* () {
      if (launch.sessionDir) yield* fs.makeDirectory(launch.sessionDir, { recursive: true });
      attached = false;
      const connect = (args: ReadonlyArray<string>) =>
        makeClient({
          spawn: input.spawn,
          command: launch.command,
          args,
          cwd: launch.cwd,
          env: launch.env,
          eventQueueCapacity: 1,
          ...(input.requestTimeoutMs === undefined
            ? {}
            : { requestTimeoutMs: input.requestTimeoutMs }),
          onTransportReady: (transport) =>
            Effect.gen(function* () {
              earlyUi = transport;
              yield* transport.transportReady.pipe(
                Effect.flatMap((ready) => {
                  attached =
                    ready.capabilities?.includes(NEOPI_CAPABILITIES.controlAttached) === true;
                  return emit({ ...ready, type: "ready" });
                }),
                Effect.ignore,
                Effect.forkScoped,
                Effect.provideService(Scope.Scope, scope),
              );
              yield* Stream.runForEach(transport.events, handleEvent).pipe(
                Effect.forkScoped,
                Effect.provideService(Scope.Scope, scope),
              );
              yield* Stream.runForEach(transport.uiRequests, (frame) =>
                Effect.gen(function* () {
                  if (attached && !active) return;
                  if (activeUiMethods.has(frame.method)) {
                    if (
                      (yield* SubscriptionRef.get(state)) === "failed" ||
                      (yield* SubscriptionRef.get(state)) === "stopping"
                    ) {
                      yield* emit({
                        type: "extension_ui_request",
                        id: frame.id,
                        method: "cancel",
                        targetId: frame.id,
                        ...(active ? { turnId: active.id } : {}),
                      });
                    } else uiPending.add(frame.id);
                  }
                  if (frame.method === "cancel" && typeof frame.targetId === "string")
                    uiPending.delete(frame.targetId);
                  yield* emit({ ...frame, ...(active ? { turnId: active.id } : {}) });
                }),
              ).pipe(Effect.forkScoped, Effect.provideService(Scope.Scope, scope));
              yield* pumpHost(transport).pipe(
                Effect.forkScoped,
                Effect.provideService(Scope.Scope, scope),
              );
            }),
        }).pipe(Effect.provideService(Scope.Scope, scope));
      const peer = yield* connect(launch.args).pipe(
        Effect.catchIf(
          (error) =>
            error.code === "session_in_use" &&
            sharedSession &&
            resume !== undefined &&
            input.sharedSessionCapabilities?.has(NEOPI_CAPABILITIES.controlPipe) === true,
          (error) =>
            Effect.gen(function* () {
              let owner:
                | { inUse: { pid: number } | null; control: { instanceId: string } | null }
                | undefined;
              if (input.sharedSessionCapabilities?.has(NEOPI_CAPABILITIES.sessionCatalog)) {
                owner = yield* Effect.scoped(
                  Effect.gen(function* () {
                    const process = yield* input.spawn(
                      ChildProcess.make(
                        launch.command,
                        [
                          "sessions",
                          "list",
                          "--json",
                          "--session-dir",
                          NodePath.dirname(resume!.sessionFile),
                        ],
                        {
                          cwd: launch.cwd,
                          env: launch.env,
                          stdin: "ignore",
                          stdout: "pipe",
                          stderr: "ignore",
                        },
                      ),
                    );
                    const text = yield* Stream.mkString(Stream.decodeText(process.stdout));
                    const code = yield* process.exitCode;
                    if (code !== 0) return undefined;
                    const catalog = yield* Effect.try(() => decodeOwnerCatalog(text));
                    return catalog.sessions.find(
                      (row) => NodePath.resolve(row.path) === NodePath.resolve(resume!.sessionFile),
                    );
                  }),
                ).pipe(Effect.timeout("10 seconds"), Effect.mapError(rpcError));
              }
              if (!owner?.control)
                return yield* new NeoPiRuntimeError({
                  code: "session_in_use",
                  message: `${error.message}. The session is open elsewhere without a control socket${owner?.inUse ? ` (owner PID ${owner.inUse.pid})` : ""}.`,
                });
              attached = true;
              return yield* connect([
                "ctl",
                "pipe",
                owner.control.instanceId,
                "--label",
                "neocode",
              ]);
            }),
        ),
      );
      client = peer;
      attached = peer.capabilities.has(NEOPI_CAPABILITIES.controlAttached);
      if (neopiCompatibility(peer.ready, peer.capabilities.has("v2")).status !== "supported") {
        return yield* new NeoPiRuntimeError({
          code: "startup",
          message: "NeoPi RPC peer requires protocol v2. Update the CLI to continue.",
        });
      }
      if (
        !attached &&
        sharedSession &&
        (!peer.capabilities.has(NEOPI_CAPABILITIES.sessionLease) ||
          (!resume && !peer.capabilities.has(NEOPI_CAPABILITIES.newSession)))
      )
        return yield* new NeoPiRuntimeError({
          code: "startup",
          message: "NeoPi no longer advertises safe shared sessions; refusing this launch.",
        });
      earlyUi = undefined;
      capabilities.clear();
      for (const item of peer.capabilities) capabilities.add(item);
      yield* Deferred.await(peer.exit).pipe(
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            if (epoch !== generation) return;
            const requested = (yield* SubscriptionRef.get(state)) === "stopping";
            yield* setState(requested ? "stopped" : "failed");
            if (pendingProposal) {
              const proposal = pendingProposal;
              pendingProposal = undefined;
              yield* Deferred.fail(
                proposal.done,
                new NeoPiRuntimeError({
                  code: "closed",
                  message: "NeoPi exited before resolving its proposed plan",
                }),
              ).pipe(Effect.ignore);
            }
            if (active) yield* settle(active, "failed", "NeoPi process exited during the turn");
            yield* cancelPending;
            yield* emit({ type: "t3.session.exited", recoverable: !requested, ...exit });
          }),
        ),
        Effect.forkScoped,
        Effect.provideService(Scope.Scope, scope),
      );
      const initial = yield* getState();
      const file =
        typeof initial.sessionFile === "string" ? NodePath.resolve(initial.sessionFile) : "";
      const expected = launch.sessionDir ? NodePath.resolve(launch.sessionDir) + NodePath.sep : "";
      if (
        !initial.sessionId ||
        !file ||
        (resume
          ? initial.sessionId !== resume.sessionId || file !== NodePath.resolve(resume.sessionFile)
          : initial.messageCount !== 0 || (expected !== "" && !file.startsWith(expected)))
      ) {
        return yield* identityError(
          resume
            ? "NeoPi resumed a different session"
            : "NeoPi fresh launch selected a non-empty or foreign session",
        );
      }
      yield* SubscriptionRef.set(cursor, {
        ...saved,
        v: 1 as const,
        sessionId: initial.sessionId,
        sessionFile: file,
        sessionDir: launch.sessionDir || NodePath.dirname(file),
        sharedSession,
      });
      // Attached startup is read-only: no approval handler, host tools,
      // subagent subscription, or interrupt-mode mutations on the owner.
      if (!attached && capabilities.has(NEOPI_CAPABILITIES.toolApprovalRequest)) {
        const configured = record(
          yield* peer
            .request({ type: "set_approval_handler", handler: "host" })
            .pipe(Effect.mapError(rpcError)),
        );
        if (configured.handler !== "host")
          return yield* new NeoPiRuntimeError({
            code: "startup",
            message: "NeoPi did not activate its host approval handler",
          });
      }
      if (!attached && input.hostBridge)
        yield* peer
          .request({ type: "set_host_tools", tools: input.hostBridge.definitions })
          .pipe(Effect.mapError(rpcError));
      for (const command of attached
        ? []
        : ([
            { type: "set_subagent_subscription", level: "events" },
            { type: "set_interrupt_mode", mode: "immediate" },
          ] as const)) {
        yield* peer.request(command).pipe(
          Effect.mapError(rpcError),
          Effect.catchIf(unknownCommand, () => Effect.void),
        );
      }
      yield* setState("ready");
    });
    yield* begin.pipe(
      Effect.mapError((error) => (error instanceof NeoPiRuntimeError ? error : rpcError(error))),
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* setState("failed");
          yield* closePeer;
          return yield* error;
        }),
      ),
    );
  });
  const applyModelSelection = (selection: ModelSelection) =>
    Effect.gen(function* () {
      yield* requireOwner("change model or thinking settings").pipe(Effect.mapError(rpcError));
      const role = capabilities.has(NEOPI_CAPABILITIES.getRoles)
        ? neoPiRoleFromModelSlug(selection.model)
        : undefined;
      if (role) yield* request({ type: "set_role", role }).pipe(Effect.mapError(rpcError));
      else {
        const slash = selection.model.indexOf("/");
        if (slash > 0)
          yield* request({
            type: "set_model",
            provider: selection.model.slice(0, slash),
            modelId: selection.model.slice(slash + 1),
          }).pipe(Effect.mapError(rpcError));
      }
      for (const option of selection.options ?? []) {
        if (option.id === "reasoningEffort" && typeof option.value === "string")
          yield* request({ type: "set_thinking_level", level: option.value }).pipe(
            Effect.mapError(rpcError),
          );
        if (option.id === "fastMode" && typeof option.value === "boolean") {
          const data = record(
            yield* request({ type: "set_fast_mode", enabled: option.value }).pipe(
              Effect.mapError(rpcError),
            ),
          );
          yield* emit({ type: "t3.fast_mode", enabled: data.enabled, active: data.active });
          if (data.enabled && !data.active)
            yield* emit({
              type: "notice",
              level: "warning",
              message: "NeoPi fast mode is enabled but not active for the current model",
            });
        }
      }
    });
  const restart = (_reason: "runtime-mode-change") =>
    Effect.gen(function* () {
      yield* requireOwner("restart").pipe(Effect.mapError(rpcError));
      if ((yield* SubscriptionRef.get(state)) !== "ready" || compacting)
        return yield* new NeoPiRuntimeError({
          code: "not_ready",
          message: "NeoPi can restart only between turns",
        });
      yield* closePeer;
      yield* setState("stopped");
      yield* start;
      pendingMode = false;
    });
  const prepareForTurn = Effect.gen(function* () {
    if (pendingMode && (yield* SubscriptionRef.get(state)) === "ready")
      yield* restart("runtime-mode-change");
  });
  const startTurn = (turn: NeoPiTurnInput) =>
    Effect.gen(function* () {
      yield* prepareForTurn;
      if ((yield* SubscriptionRef.get(state)) !== "ready" || compacting)
        return yield* new NeoPiRuntimeError({
          code: "not_ready",
          message: "NeoPi is not ready for a turn",
        });
      if (!attached && turn.modelSelection) yield* applyModelSelection(turn.modelSelection);
      const peer = yield* current();
      const baseline = record(
        yield* request({ type: "get_entries" }).pipe(Effect.mapError(rpcError)),
      );
      const entry: ActiveTurn = {
        id: turn.turnId,
        baselineLeaf: typeof baseline.leafId === "string" ? baseline.leafId : null,
        boundaryDone: yield* Deferred.make<void>(),
        promptReady: yield* Deferred.make<PromptHandle>(),
        boundaryStarted: false,
        agentInvoked: false,
        interrupted: false,
      };
      active = entry;
      // The import/handoff watermark predates this GUI turn. Invalidate it;
      // handoff records a new exact leaf only after the writer has stopped.
      yield* SubscriptionRef.update(cursor, (previous) => {
        const next = { ...previous };
        delete next.historyLeafId;
        return next;
      });
      yield* setState("running");
      const handle = yield* peer
        .prompt({
          type: "prompt",
          message: turn.text,
          ...(turn.images.length ? { images: turn.images } : {}),
        })
        .pipe(
          Effect.mapError(rpcError),
          Effect.tapError(() =>
            Effect.gen(function* () {
              active = undefined;
              yield* setState("ready");
            }),
          ),
        );
      entry.promptId = handle.id;
      yield* Deferred.succeed(entry.promptReady!, handle);
      yield* observePrompt(entry, handle).pipe(Effect.forkIn(lifetime!));
      return { turnId: turn.turnId };
    });
  const steer = (turn: NeoPiTurnInput) =>
    Effect.gen(function* () {
      if ((yield* SubscriptionRef.get(state)) !== "running" || !active || compacting)
        return yield* new NeoPiRuntimeError({
          code: "not_running",
          message: "NeoPi has no running turn to steer",
        });
      yield* request({
        type: "steer",
        message: turn.text,
        ...(turn.images.length ? { images: turn.images } : {}),
      }).pipe(Effect.mapError(rpcError));
    });
  const resolvePlanProposal: NeoPiSessionRuntimeShape["resolvePlanProposal"] = (
    response,
    continuation,
  ) =>
    Effect.gen(function* () {
      const proposal = pendingProposal;
      yield* requireOwner("respond to a plan proposal").pipe(Effect.mapError(rpcError));
      if (!proposal || proposal.resolving)
        return yield* new NeoPiRuntimeError({
          code: "not_ready",
          message: "NeoPi has no pending plan proposal for this action",
        });
      if (response.decision === "withdraw") {
        proposal.resolving = true;
        proposal.withdrawing = true;
        yield* request({ type: "set_mode", mode: "default" }).pipe(
          Effect.mapError(rpcError),
          Effect.tapError(() =>
            Effect.sync(() => {
              proposal.resolving = false;
              proposal.withdrawing = false;
            }),
          ),
        );
        yield* Deferred.await(proposal.done);
        return;
      }
      const beforeRefinement = continuation
        ? record(yield* request({ type: "get_entries" }).pipe(Effect.mapError(rpcError))).leafId
        : undefined;
      if (pendingProposal !== proposal || proposal.resolving)
        return yield* new NeoPiRuntimeError({
          code: "not_ready",
          message: "NeoPi cancelled this plan before its response could be sent",
        });
      if (continuation) {
        if (typeof beforeRefinement !== "string")
          return yield* new NeoPiRuntimeError({
            code: "identity_mismatch",
            message: "NeoPi cannot locate the plan refinement's native history boundary",
          });
        proposal.resolving = true;
        const entry: ActiveTurn = {
          id: continuation.turnId,
          baselineLeaf: null,
          boundaryDone: yield* Deferred.make<void>(),
          boundaryStarted: false,
          continuation: true,
          agentInvoked: true,
          interrupted: false,
        };
        const previous = yield* SubscriptionRef.get(cursor);
        const next = {
          ...previous,
          turnBoundaries: [
            ...previous.turnBoundaries,
            {
              turnId: continuation.turnId,
              kind: "continuation" as const,
              afterEntryId: beforeRefinement,
            },
          ],
        };
        delete next.historyLeafId;
        yield* SubscriptionRef.set(cursor, next);
        active = entry;
        yield* setState("running");
        if (pendingProposal !== proposal) {
          yield* rejectProposal(proposal, "NeoPi cancelled this plan before admission");
          return yield* new NeoPiRuntimeError({
            code: "not_ready",
            message: "NeoPi cancelled this plan before admission",
          });
        }
      } else proposal.resolving = true;
      const peer = yield* current();
      if (pendingProposal !== proposal)
        return yield* new NeoPiRuntimeError({
          code: "not_ready",
          message: "NeoPi cancelled this plan before its response could be sent",
        });
      const frame: PlanProposalResponseFrame = {
        type: "plan_proposal_response",
        id: proposal.id,
        decision: response.decision,
        ...(response.feedback ? { feedback: response.feedback } : {}),
      };
      yield* peer.writeFrame(frame).pipe(
        Effect.mapError(rpcError),
        Effect.tapError(() =>
          Effect.gen(function* () {
            proposal.resolving = false;
            if (continuation && active?.id === continuation.turnId) {
              active = undefined;
              const previous = yield* SubscriptionRef.get(cursor);
              yield* SubscriptionRef.set(cursor, {
                ...previous,
                turnBoundaries: previous.turnBoundaries.filter(
                  (boundary) => boundary.turnId !== continuation.turnId,
                ),
              });
              yield* setState("ready");
            }
          }),
        ),
      );
      if (!continuation) yield* Deferred.await(proposal.done);
    });
  const interrupt = Effect.gen(function* () {
    if (attached && !active)
      return yield* new NeoPiRuntimeError({
        code: "not_running",
        message: "NeoCode has no active turn to interrupt on the attached session",
      });
    if (!attached && pendingProposal && !pendingProposal.resolving) {
      pendingProposal.resolving = true;
      yield* (yield* current())
        .writeFrame({
          type: "plan_proposal_response",
          id: pendingProposal.id,
          decision: "refine",
        })
        .pipe(Effect.mapError(rpcError));
      yield* request({ type: "abort" }).pipe(Effect.mapError(rpcError));
      return;
    }
    if ((yield* SubscriptionRef.get(state)) !== "running" || !active)
      return yield* new NeoPiRuntimeError({
        code: "not_running",
        message: "NeoPi has no running turn to interrupt",
      });
    const turn = active;
    turn.interrupted = true;
    yield* request({ type: "abort" }).pipe(
      Effect.mapError(rpcError),
      Effect.tapError(() =>
        Effect.sync(() => {
          if (active === turn) turn.interrupted = false;
        }),
      ),
    );
  });
  const compact = (customInstructions?: string) =>
    Effect.gen(function* () {
      yield* requireOwner("compact").pipe(Effect.mapError(rpcError));
      if ((yield* SubscriptionRef.get(state)) !== "ready" || compacting)
        return yield* new NeoPiRuntimeError({
          code: "not_ready",
          message: "NeoPi can compact only between turns",
        });
      compacting = true;
      const result = yield* request({
        type: "compact",
        ...(customInstructions ? { customInstructions } : {}),
      }).pipe(
        Effect.mapError(rpcError),
        Effect.ensuring(
          Effect.sync(() => {
            compacting = false;
          }),
        ),
      );
      const before = record(result).tokensBefore;
      const after = yield* getState();
      yield* emit({
        type: "t3.compaction",
        ...(typeof before === "number" ? { beforeTokens: before } : {}),
        ...(typeof after.contextUsage?.tokens === "number"
          ? { afterTokens: after.contextUsage.tokens }
          : {}),
      });
      yield* emit({ type: "t3.state", state: after });
    });
  const stop = Effect.gen(function* () {
    const previous = yield* SubscriptionRef.get(state);
    if (previous === "stopped") return;
    if (!attached && pendingProposal && !pendingProposal.resolving) {
      yield* (
        client
          ?.writeFrame({
            type: "plan_proposal_response",
            id: pendingProposal.id,
            decision: "refine",
          })
          .pipe(Effect.ignore) ?? Effect.void
      );
    }
    yield* setState("stopping");
    const exit = yield* closePeer;
    if (active) yield* settle(active, "failed", "NeoPi session was stopped");
    yield* setState("stopped");
    if (exit && previous !== "failed")
      yield* emit({ type: "t3.session.exited", recoverable: false, ...exit });
    yield* Queue.end(frames);
  });
  const onSessionIdentityMayHaveChanged = Effect.gen(function* () {
    const fresh = yield* getState();
    if (!fresh.sessionId || !fresh.sessionFile)
      return yield* identityError("NeoPi did not report its current session identity");
    const previous = yield* SubscriptionRef.get(cursor);
    yield* SubscriptionRef.set(cursor, {
      ...previous,
      sessionId: fresh.sessionId,
      sessionFile: NodePath.resolve(fresh.sessionFile),
    });
    yield* invalidateConfiguration;
    yield* emit({ type: "t3.state", state: fresh });
  });
  const setRuntimeMode = (next: RuntimeMode) =>
    Effect.gen(function* () {
      yield* requireOwner("change runtime mode").pipe(Effect.mapError(rpcError));
      if (mode === next) return;
      mode = next;
      const status = yield* SubscriptionRef.get(state);
      if (status === "ready") yield* restart("runtime-mode-change");
      else if (status === "running") {
        pendingMode = true;
        return yield* new NeoPiRuntimeError({
          code: "runtime_mode_deferred",
          message: "NeoPi runtime mode takes effect after the current turn",
        });
      }
    });
  return {
    threadId: input.threadId,
    state,
    cursor,
    get processGeneration() {
      return generation;
    },
    subscribeConfigurationChanges: PubSub.subscribe(configurationChanges),
    observeNative: nativeEvents.subscribe,
    nativeRequest: (command) =>
      Effect.gen(function* () {
        if (!["get_state", "get_entries_page", "snapshot_session_journal", "navigate_tree", "resume_tree", "abort"].includes(command.type))
          return yield* new NeoPiRpcError({ code: "unsupported", command: command.type, message: "Not a native conversation command." });
        return yield* (yield* current()).request(command);
      }),
    invalidateConfiguration,
    prepareForTurn,
    capabilities,
    start,
    startTurn,
    steer,
    resolvePlanProposal,
    interrupt,
    compact,
    request,
    writeFrame: (frame) =>
      requireOwner("send an owner response").pipe(
        Effect.andThen(() =>
          client
            ? client.writeFrame(frame)
            : Effect.fail(
                new NeoPiRpcError({
                  code: "closed",
                  message: "NeoPi session is not connected",
                }),
              ),
        ),
      ),
    frames: Stream.fromQueue(frames),
    restart,
    stop,
    setRuntimeMode,
    onSessionIdentityMayHaveChanged,
    applyModelSelection,
    respondUi: (response) =>
      Effect.gen(function* () {
        yield* requireOwner("respond to owner UI");
        const channel = client ?? earlyUi;
        if (!channel)
          return yield* new NeoPiRpcError({
            code: "closed",
            message: "NeoPi session is not connected",
          });
        yield* channel.respondUi(response);
        uiPending.delete(response.id);
      }),
  } satisfies NeoPiSessionRuntimeShape;
});
