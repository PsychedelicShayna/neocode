import * as NodeCrypto from "node:crypto";
import {
  NeoPiModelsError,
  NeoPiModelsConfiguration,
  NeoPiModelsAccounts,
  type NeoPiModelsTarget,
  type NeoPiModelsUpdate,
  type NeoPiModelsAuthState,
  type NeoPiModelsAuthRespond,
  type NeoPiNativeSessionRef,
  type NeoPiNativeSessionsError,
} from "@t3tools/contracts";
import { NeoPiModelSelectorResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { neoPiSessionCatalogSource } from "./NeoPiSessionCatalogSource.ts";
import type { NeoPiModelsConnection } from "./NeoPiModelsConnection.ts";
import { makeNeoPiModelsHub } from "./NeoPiModelsHub.ts";

const modelError = (cause: unknown) =>
  Schema.is(NeoPiModelsError)(cause)
    ? cause
    : new NeoPiModelsError({
        message: cause instanceof Error ? cause.message : String(cause),
        ...(cause !== null &&
        typeof cause === "object" &&
        "code" in cause &&
        typeof cause.code === "string"
          ? { code: cause.code }
          : {}),
      });
const Cursor = Schema.Struct({ sessionId: Schema.String, sessionFile: Schema.String });
interface AuthFlow {
  readonly connection: NeoPiModelsConnection;
  readonly state: SubscriptionRef.SubscriptionRef<NeoPiModelsAuthState>;
  readonly scope: Scope.Closeable;
  readonly cancel: Effect.Effect<void, NeoPiModelsError>;
  watchers: number;
}

export const readNativeModelsConfiguration = Effect.fnUntraced(function* (
  native: NeoPiModelsConnection,
) {
  if (!native.capabilities.has("models_configuration"))
    return yield* new NeoPiModelsError({
      message:
        "This NeoPi connection does not advertise models_configuration. Update the configured native executable. No configuration was changed.",
    });
  yield* native.validate;
  const result = yield* native
    .request({ type: "get_models_configuration" })
    .pipe(Effect.mapError(modelError));
  return yield* Schema.decodeUnknownEffect(NeoPiModelsConfiguration)(result, {
    reportInput: false,
  }).pipe(
    Effect.mapError(
      (error) =>
        new NeoPiModelsError({
          message:
            `NeoPi returned an incompatible Models configuration: ${SchemaIssue.makeFormatterDefault()(error.issue)}. ` +
            "Check the configured NeoPi executable and NeoCode versions, then refresh after updating the incompatible side. No configuration was changed.",
        }),
    ),
  );
});

/** One validated native mutation followed by its authoritative configuration receipt. */
export const updateNativeModelsConfiguration = Effect.fnUntraced(function* (
  native: NeoPiModelsConnection,
  input: NeoPiModelsUpdate,
) {
  if (!native.capabilities.has("models_configuration"))
    return yield* new NeoPiModelsError({
      message:
        "This NeoPi connection cannot update Models configuration. Update the configured executable. Nothing was changed.",
    });
  yield* native.validate;
  const { operation, ...change } = input.change;
  switch (operation) {
    case "role":
      yield* native.request({ ...change, type: "set_model_role_configuration" });
      break;
    case "fallbacks":
      yield* native.request({ ...change, type: "set_model_role_fallbacks" });
      break;
    case "description":
      yield* native.request({ ...change, type: "set_model_role_description" });
      break;
    case "deleteRole":
      yield* native.request({ ...change, type: "delete_model_role" });
      break;
    case "activateAccount":
      if (!input.target.sessionFile)
        return yield* new NeoPiModelsError({
          message: "Open Models from a connected thread to use an account in that session.",
        });
      yield* native.request({ ...change, type: "activate_account" });
      break;
    case "storage":
      yield* native.request({ ...change, type: "set_model_role_storage" });
      break;
    case "rules":
      yield* native.request({ ...change, type: "set_effort_rules" });
      break;
    case "key":
      yield* native.request({ ...change, type: "set_provider_api_key" });
      break;
    case "logout":
      yield* native.request({ ...change, type: "logout" });
      break;
  }
  return yield* readNativeModelsConfiguration(native);
}, Effect.mapError(modelError));

export const queryNativeModelSelector = Effect.fnUntraced(function* (
  native: NeoPiModelsConnection,
  query: string,
) {
  if (!native.capabilities.has("model_selector"))
    return yield* new NeoPiModelsError({
      message:
        "This NeoPi connection does not advertise model_selector. Update the configured native executable to search models.",
    });
  yield* native.validate;
  const response = yield* native
    .request({ type: "query_model_selector", query })
    .pipe(Effect.mapError(modelError));
  const result = yield* Schema.decodeUnknownEffect(NeoPiModelSelectorResult)(response).pipe(
    Effect.mapError(
      () =>
        new NeoPiModelsError({
          message:
            "NeoPi returned an incompatible model selector response. Update NeoPi and NeoCode together.",
        }),
    ),
  );
  yield* native.validate;
  return result;
});

/**
 * Native login state and resources share one lifetime, independent of any one observer.
 *
 * That lifetime is the auth's own scope, never the caller's: the server builds its handlers in a
 * scope that closes as soon as they exist, and a login forked into a closed scope dies instantly.
 * A flow ends with its last observer or its native result; `close` ends every flow at once.
 */
export const makeNativeModelsAuth = Effect.fn("makeNativeModelsAuth")(function* (
  connection: (
    target: NeoPiModelsTarget,
  ) => Effect.Effect<NeoPiModelsConnection, NeoPiModelsError, Scope.Scope>,
) {
  const lifetime = yield* Scope.make();
  const flows = new Map<string, AuthFlow>();
  const requireFlow = (flowId: string) =>
    flows.has(flowId)
      ? Effect.succeed(flows.get(flowId)!)
      : Effect.fail(
          new NeoPiModelsError({
            message: "This native login is no longer active. Start login again.",
          }),
        );
  const settleAuth = (
    state: AuthFlow["state"],
    status: NeoPiModelsAuthState["status"],
    message: string,
  ) =>
    SubscriptionRef.update(state, (current) =>
      current.status === "running" ? { ...current, status, prompt: null, message } : current,
    );
  const cancelAuth = (input: { flowId: string }) =>
    Effect.flatMap(requireFlow(input.flowId), (flow) => flow.cancel);
  const startAuth = (input: {
    target: NeoPiModelsTarget;
    providerId: string;
    serverUrl?: string | undefined;
  }) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const native = yield* restore(
          connection(input.target).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.tapError(() => Scope.close(scope, Exit.void)),
            Effect.onInterrupt(() => Scope.close(scope, Exit.void)),
          ),
        );
        if (!native.capabilities.has("cancellable_login")) {
          yield* Scope.close(scope, Exit.void);
          return yield* new NeoPiModelsError({
            message:
              "This native connection cannot safely run cancellable login. Update NeoPi before logging in here.",
          });
        }
        const flowId = NodeCrypto.randomUUID();
        const state = yield* SubscriptionRef.make<NeoPiModelsAuthState>({
          flowId,
          status: "running",
          message: null,
          url: null,
          instructions: null,
          userCode: null,
          prompt: null,
        });
        // Memoize cancellation so simultaneous button presses and watch teardown
        // cannot send a second cancel after NeoPi has retired the native login.
        const cancel = yield* Effect.cached(
          Effect.gen(function* () {
            if ((yield* SubscriptionRef.get(state)).status !== "running") return;
            const result = yield* native
              .request({ type: "cancel_login", loginId: flowId })
              .pipe(Effect.result);
            if (result._tag === "Failure") {
              // Completion can overtake the cancel response. Never replace a
              // native terminal result with a stale cancellation error.
              if ((yield* SubscriptionRef.get(state)).status !== "running") return;
              const error = modelError(result.failure);
              yield* settleAuth(state, "failed", error.message);
              yield* Scope.close(scope, Exit.void);
              return yield* error;
            }
            // The cancel acknowledgement is not the login result. NeoPi can
            // still finish saving an account before it observes the abort.
          }),
        );
        const flow: AuthFlow = { connection: native, state, scope, cancel, watchers: 0 };
        const ui = yield* Stream.toPull(native.ui).pipe(Effect.provideService(Scope.Scope, scope));
        // A server address supplied up front answers the provider's own address
        // prompt once, so the person never types it twice.
        let pendingServerUrl = input.serverUrl?.trim() || null;
        // toPull is lazy; start consuming before login can emit its first prompt.
        yield* Stream.fromPull(Effect.succeed(ui)).pipe(
          Stream.runForEach((frame) => {
            if (frame.loginId !== flowId) return Effect.void;
            if (
              pendingServerUrl !== null &&
              frame.method === "input" &&
              typeof frame.title === "string" &&
              /\b(url|address)\b/i.test(frame.title) &&
              typeof frame.id === "string"
            ) {
              const value = pendingServerUrl;
              pendingServerUrl = null;
              const promptId = frame.id;
              // On failure the person gets the prompt back, with the reason, rather than a silent spinner.
              return native.respondUi({ id: promptId, value }).pipe(
                Effect.catch((cause) =>
                  SubscriptionRef.update(state, (current) =>
                    current.status !== "running"
                      ? current
                      : {
                          ...current,
                          message: `Could not submit the server address automatically: ${modelError(cause).message}`,
                          prompt: {
                            kind: "input" as const,
                            id: promptId,
                            title: frame.title as string,
                            placeholder:
                              typeof frame.placeholder === "string" ? frame.placeholder : null,
                            secret: false,
                          },
                        },
                  ),
                ),
              );
            }
            return SubscriptionRef.update(state, (current) => {
              if (current.status !== "running") return current;
              if (frame.method === "open_url" && typeof frame.url === "string")
                return {
                  ...current,
                  url: frame.url,
                  instructions: typeof frame.instructions === "string" ? frame.instructions : null,
                  userCode: typeof frame.userCode === "string" ? frame.userCode : null,
                };
              if (frame.method === "notify" && typeof frame.message === "string")
                return { ...current, message: frame.message };
              if (frame.method === "input" && typeof frame.title === "string")
                return {
                  ...current,
                  prompt: {
                    kind: "input" as const,
                    id: frame.id,
                    title: frame.title,
                    placeholder: typeof frame.placeholder === "string" ? frame.placeholder : null,
                    secret: frame.secret === true,
                  },
                };
              if (
                frame.method === "confirm" &&
                typeof frame.title === "string" &&
                typeof frame.message === "string"
              )
                return {
                  ...current,
                  prompt: {
                    kind: "confirm" as const,
                    id: frame.id,
                    title: frame.title,
                    message: frame.message,
                  },
                };
              if (frame.method === "cancel" && frame.targetId === current.prompt?.id)
                return { ...current, prompt: null };
              return current;
            });
          }),
          Effect.forkIn(scope, { startImmediately: true, uninterruptible: false }),
        );
        const login = yield* native
          .request({
            type: "login",
            providerId: input.providerId,
            id: flowId,
            // Host capabilities only; consent still requires a correlated boolean confirmation.
            allowSecretInput: true,
            allowTrustConfirmation: true,
          })
          .pipe(
            Effect.matchEffect({
              onSuccess: () => settleAuth(state, "complete", "Account saved"),
              onFailure: (cause) =>
                settleAuth(
                  state,
                  cause.code === "login_cancelled" ? "cancelled" : "failed",
                  cause.message,
                ),
            }),
            Effect.onInterrupt(() =>
              settleAuth(
                state,
                "failed",
                "The native login connection closed before login completed.",
              ),
            ),
            Effect.forkIn(scope, { startImmediately: true, uninterruptible: false }),
          );
        // The request belongs to the flow scope; a separate fiber closes it so
        // watch teardown also interrupts a borrowed connection's pending request.
        yield* Fiber.await(login).pipe(
          Effect.andThen(Scope.close(scope, Exit.void)),
          Effect.forkIn(lifetime, { uninterruptible: false }),
        );
        flows.set(flowId, flow);
        return { flowId };
      }),
    ).pipe(Effect.mapError(modelError));
  const watchAuth = (input: { flowId: string }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const flow = yield* requireFlow(input.flowId);
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            flow.watchers += 1;
          }),
          () =>
            Effect.gen(function* () {
              flow.watchers -= 1;
              if (flow.watchers !== 0) return;
              if ((yield* SubscriptionRef.get(flow.state)).status === "running")
                yield* flow.cancel.pipe(Effect.ignore);
              yield* Scope.close(flow.scope, Exit.void);
              flows.delete(input.flowId);
            }),
        );
        return SubscriptionRef.changes(flow.state).pipe(
          Stream.takeUntil((state) => state.status !== "running"),
        );
      }),
    ).pipe(Stream.mapError(modelError));
  const respondAuth = (input: typeof NeoPiModelsAuthRespond.Type) =>
    Effect.gen(function* () {
      const flow = yield* requireFlow(input.flowId);
      yield* flow.connection.validate;
      const current = yield* SubscriptionRef.get(flow.state);
      if (current.status !== "running" || current.prompt?.id !== input.requestId)
        return yield* new NeoPiModelsError({
          message: "The native login prompt changed. Use its current prompt.",
        });
      const response =
        current.prompt.kind === "input" && "value" in input && typeof input.value === "string"
          ? { id: input.requestId, value: input.value }
          : current.prompt.kind === "confirm" &&
              "confirmed" in input &&
              typeof input.confirmed === "boolean"
            ? { id: input.requestId, confirmed: input.confirmed }
            : null;
      if (response === null)
        return yield* new NeoPiModelsError({
          message: "Answer this native login prompt using its requested input or confirmation.",
        });
      yield* flow.connection.respondUi(response).pipe(Effect.mapError(modelError));
      yield* SubscriptionRef.update(flow.state, (state) =>
        state.prompt?.id === input.requestId ? { ...state, prompt: null } : state,
      );
    });
  const close = Effect.suspend(() =>
    Effect.forEach(
      [...flows],
      ([flowId, flow]) =>
        cancelAuth({ flowId }).pipe(
          Effect.ignore,
          Effect.andThen(Scope.close(flow.scope, Exit.void)),
        ),
      { discard: true },
    ),
  ).pipe(Effect.andThen(Scope.close(lifetime, Exit.void)));
  return { startAuth, watchAuth, respondAuth, cancelAuth, close };
});

/** Routes explicit graphical model operations to their native owner; it stores no model policy or credentials. */
export const makeNeoPiModels = Effect.fn("makeNeoPiModels")(function* (
  nativeSessionConnection?: (
    ref: NeoPiNativeSessionRef,
  ) => Effect.Effect<NeoPiModelsConnection, NeoPiNativeSessionsError | NeoPiModelsError>,
) {
  const instances = yield* ProviderInstanceRegistry;
  const snapshots = yield* ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory;
  const serverConfig = yield* ServerConfig;
  const connection = Effect.fnUntraced(function* (target: NeoPiModelsTarget) {
    if (target.sessionFile !== undefined) {
      if (!nativeSessionConnection)
        return yield* new NeoPiModelsError({
          message: "Native session configuration is unavailable.",
        });
      return yield* nativeSessionConnection({
        providerInstanceId: target.providerInstanceId,
        sessionFile: target.sessionFile,
      }).pipe(Effect.mapError(modelError));
    }
    const instance = yield* instances.getInstance(target.providerInstanceId);
    const source = instance && neoPiSessionCatalogSource(instance);
    if (!instance?.enabled || instance.driverKind !== "neopi" || !source?.modelsConnection)
      return yield* new NeoPiModelsError({
        message: "This native NeoPi instance is unavailable. Check NeoCore settings.",
      });
    let projectId = target.projectId;
    let cwd = serverConfig.cwd;
    let expected: { sessionId: string; sessionFile: string } | undefined;
    let hasThreadWorktree = false;
    if (target.threadId) {
      const binding = yield* directory.getBinding(target.threadId);
      const thread = yield* snapshots.getThreadShellById(target.threadId);
      if (
        Option.isNone(binding) ||
        Option.isNone(thread) ||
        binding.value.status !== "running" ||
        binding.value.providerInstanceId !== target.providerInstanceId
      )
        return yield* new NeoPiModelsError({
          message:
            "The selected thread has no matching connected native session. Reopen Models from a connected thread or choose project configuration.",
        });
      if (target.projectId && target.projectId !== thread.value.projectId)
        return yield* new NeoPiModelsError({
          message: "The selected thread's project changed. Reopen Models from that thread.",
        });
      expected = yield* Schema.decodeUnknownEffect(Cursor)(binding.value.resumeCursor).pipe(
        Effect.mapError(modelError),
      );
      projectId = thread.value.projectId;
      if (thread.value.worktreePath) {
        cwd = thread.value.worktreePath;
        hasThreadWorktree = true;
      }
    }
    if (projectId && !hasThreadWorktree) {
      const project = yield* snapshots.getProjectShellById(projectId);
      if (Option.isNone(project))
        return yield* new NeoPiModelsError({ message: "The selected project no longer exists." });
      cwd = project.value.workspaceRoot;
    }
    const native = yield* source.modelsConnection(cwd, target.threadId, expected);
    return native;
  }, Effect.mapError(modelError));
  const auth = yield* makeNativeModelsAuth(connection);
  const hub = yield* makeNeoPiModelsHub(connection, readNativeModelsConfiguration);
  const read = (target: NeoPiModelsTarget) =>
    Effect.scoped(Effect.flatMap(connection(target), readNativeModelsConfiguration)).pipe(
      Effect.tap((configuration) => hub.publish(target, configuration)),
      Effect.mapError(modelError),
    );
  const querySelector = (input: { target: NeoPiModelsTarget; query: string }) =>
    Effect.scoped(
      Effect.flatMap(connection(input.target), (native) =>
        queryNativeModelSelector(native, input.query),
      ),
    ).pipe(Effect.mapError(modelError));
  const watch = (target: NeoPiModelsTarget) => hub.watch(target).pipe(Stream.mapError(modelError));
  const update = (input: NeoPiModelsUpdate) =>
    Effect.scoped(
      Effect.flatMap(connection(input.target), (native) =>
        updateNativeModelsConfiguration(native, input),
      ),
    ).pipe(
      Effect.tap((configuration) => hub.publish(input.target, configuration)),
      Effect.mapError(modelError),
    );
  const accounts = (input: { target: NeoPiModelsTarget; providerId: string }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const native = yield* connection(input.target);
        yield* native.validate;
        return yield* Schema.decodeUnknownEffect(NeoPiModelsAccounts)(
          yield* native.request({ type: "get_logout_accounts", providerId: input.providerId }),
        );
      }),
    ).pipe(Effect.mapError(modelError));
  return {
    connection,
    read,
    querySelector,
    watch,
    update,
    accounts,
    ...auth,
  };
});
