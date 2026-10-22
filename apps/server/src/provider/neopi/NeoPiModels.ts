import * as NodeCrypto from "node:crypto";
import {
  NeoPiModelsError, NeoPiModelsConfiguration, NeoPiModelsAccounts,
  type NeoPiModelsTarget, type NeoPiModelsUpdate, type NeoPiModelsAuthState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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

const modelError = (cause: unknown) => cause instanceof NeoPiModelsError ? cause : new NeoPiModelsError({ message: cause instanceof Error ? cause.message : String(cause) });
const Cursor = Schema.Struct({ sessionId: Schema.String, sessionFile: Schema.String });
interface AuthFlow {
  readonly connection: NeoPiModelsConnection;
  readonly state: SubscriptionRef.SubscriptionRef<NeoPiModelsAuthState>;
  readonly scope: Scope.Closeable;
}

export const readNativeModelsConfiguration = Effect.fnUntraced(function* (native: NeoPiModelsConnection) {
  if (!native.capabilities.has("models_configuration"))
    return yield* new NeoPiModelsError({ message: "This NeoPi connection does not advertise models_configuration. Update the configured native executable. No configuration was changed." });
  yield* native.validate;
  const result = yield* native.request({ type: "get_models_configuration" }).pipe(Effect.mapError(modelError));
  return yield* Schema.decodeUnknownEffect(NeoPiModelsConfiguration)(result).pipe(Effect.mapError(() => new NeoPiModelsError({ message: "NeoPi returned an incompatible Models configuration. Update NeoPi and NeoCode together." })));
});

/** Routes explicit graphical model operations to their native owner; it stores no model policy or credentials. */
export const makeNeoPiModels = Effect.fn("makeNeoPiModels")(function* () {
  const instances = yield* ProviderInstanceRegistry;
  const snapshots = yield* ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory;
  const serverConfig = yield* ServerConfig;
  const lifetime = yield* Effect.scope;
  const flows = new Map<string, AuthFlow>();
  const connection = Effect.fnUntraced(function* (target: NeoPiModelsTarget) {
    const instance = yield* instances.getInstance(target.providerInstanceId);
    const source = instance && neoPiSessionCatalogSource(instance);
    if (!instance?.enabled || instance.driverKind !== "neopi" || !source?.modelsConnection)
      return yield* new NeoPiModelsError({ message: "This native NeoPi instance is unavailable. Check NeoCore settings." });
    let projectId = target.projectId;
    let cwd = serverConfig.cwd;
    let expected: { sessionId: string; sessionFile: string } | undefined;
    let hasThreadWorktree = false;
    if (target.threadId) {
      const binding = yield* directory.getBinding(target.threadId);
      const thread = yield* snapshots.getThreadShellById(target.threadId);
      if (Option.isNone(binding) || Option.isNone(thread) || binding.value.status !== "running" || binding.value.providerInstanceId !== target.providerInstanceId)
        return yield* new NeoPiModelsError({ message: "The selected thread has no matching connected native session. Reopen Models from a connected thread or choose project configuration." });
      if (target.projectId && target.projectId !== thread.value.projectId)
        return yield* new NeoPiModelsError({ message: "The selected thread's project changed. Reopen Models from that thread." });
      expected = yield* Schema.decodeUnknownEffect(Cursor)(binding.value.resumeCursor).pipe(Effect.mapError(modelError));
      projectId = thread.value.projectId;
      if (thread.value.worktreePath) { cwd = thread.value.worktreePath; hasThreadWorktree = true; }
    }
    if (projectId && !hasThreadWorktree) {
      const project = yield* snapshots.getProjectShellById(projectId);
      if (Option.isNone(project)) return yield* new NeoPiModelsError({ message: "The selected project no longer exists." });
      cwd = project.value.workspaceRoot;
    }
    const native = yield* source.modelsConnection(cwd, target.threadId, expected);
    return native;
  });
  const read = (target: NeoPiModelsTarget) => Effect.scoped(Effect.flatMap(connection(target), readNativeModelsConfiguration)).pipe(Effect.mapError(modelError));
  const watch = (target: NeoPiModelsTarget) => Stream.unwrap(Effect.gen(function* () {
    const native = yield* connection(target);
    const changes = yield* Stream.toPull(native.changes);
    return Stream.fromEffect(readNativeModelsConfiguration(native)).pipe(Stream.concat(Stream.fromPull(Effect.succeed(changes)).pipe(Stream.mapEffect(() => readNativeModelsConfiguration(native)))));
  })).pipe(Stream.mapError(modelError));
  const update = (input: NeoPiModelsUpdate) => Effect.scoped(Effect.gen(function* () {
    const native = yield* connection(input.target);
    if (!native.capabilities.has("models_configuration"))
      return yield* new NeoPiModelsError({ message: "This NeoPi connection cannot update native Models configuration. Update the configured executable. Nothing was changed." });
    yield* native.validate;
    const change = input.change;
    switch (change.operation) {
      case "role": yield* native.request({ ...change, type: "set_model_role_configuration" }); break;
      case "storage": yield* native.request({ type: "set_model_role_storage", value: change.value, expected: change.expected }); break;
      case "rules": yield* native.request({ ...change, type: "set_effort_rules" }); break;
      case "key": yield* native.request({ type: "set_provider_api_key", providerId: change.providerId, apiKey: change.apiKey }); break;
      case "logout": yield* native.request({ type: "logout", providerId: change.providerId, credentialId: change.credentialId }); break;
    }
    return yield* readNativeModelsConfiguration(native);
  })).pipe(Effect.mapError(modelError));
  const accounts = (input: { target: NeoPiModelsTarget; providerId: string }) => Effect.scoped(Effect.gen(function* () {
    const native = yield* connection(input.target);
    yield* native.validate;
    return yield* Schema.decodeUnknownEffect(NeoPiModelsAccounts)(yield* native.request({ type: "get_logout_accounts", providerId: input.providerId }));
  })).pipe(Effect.mapError(modelError));
  const requireFlow = (flowId: string) => flows.has(flowId) ? Effect.succeed(flows.get(flowId)!) : Effect.fail(new NeoPiModelsError({ message: "This native login is no longer active. Start login again." }));
  const cancelAuth = (input: { flowId: string }) => Effect.gen(function* () {
    const flow = yield* requireFlow(input.flowId);
    const current = yield* SubscriptionRef.get(flow.state);
    if (current.status !== "running") return;
    yield* flow.connection.request({ type: "cancel_login", loginId: input.flowId }).pipe(Effect.mapError(modelError));
    yield* SubscriptionRef.set(flow.state, { ...current, status: "cancelled", prompt: null, message: "Login cancelled" });
  });
  const startAuth = (input: { target: NeoPiModelsTarget; providerId: string }) => Effect.gen(function* () {
    const scope = yield* Scope.make();
    const acquired = yield* connection(input.target).pipe(Effect.provideService(Scope.Scope, scope), Effect.result);
    if (acquired._tag === "Failure") { yield* Scope.close(scope, Exit.void); return yield* Effect.fail(modelError(acquired.failure)); }
    const native = acquired.success;
    if (!native.capabilities.has("cancellable_login")) { yield* Scope.close(scope, Exit.void); return yield* new NeoPiModelsError({ message: "This native connection cannot safely run cancellable login. Update NeoPi before logging in here." }); }
    const flowId = NodeCrypto.randomUUID();
    const state = yield* SubscriptionRef.make<NeoPiModelsAuthState>({ flowId, status: "running", message: null, url: null, instructions: null, prompt: null });
    const flow = { connection: native, state, scope };
    flows.set(flowId, flow);
    const ui = yield* Stream.toPull(native.ui).pipe(Effect.provideService(Scope.Scope, scope));
    yield* Stream.fromPull(Effect.succeed(ui)).pipe(Stream.runForEach(frame => {
      if (frame.loginId !== flowId) return Effect.void;
      return SubscriptionRef.update(state, current => {
        if (current.status !== "running") return current;
        if (frame.method === "open_url" && typeof frame.url === "string") return { ...current, url: frame.url, instructions: typeof frame.instructions === "string" ? frame.instructions : null };
        if (frame.method === "notify" && typeof frame.message === "string") return { ...current, message: frame.message };
        if (frame.method === "input" && typeof frame.title === "string") return { ...current, prompt: { id: frame.id, title: frame.title, placeholder: typeof frame.placeholder === "string" ? frame.placeholder : null, secret: frame.secret === true } };
        if (frame.method === "cancel" && frame.targetId === current.prompt?.id) return { ...current, prompt: null };
        return current;
      });
    }), Effect.forkIn(scope));
    yield* native.request({ type: "login", providerId: input.providerId, id: flowId }).pipe(
      Effect.matchEffect({
        onSuccess: () => SubscriptionRef.update(state, current => ({ ...current, status: "complete", prompt: null, message: "Native account saved" })),
        onFailure: cause => SubscriptionRef.update(state, current => ({ ...current, status: current.status === "cancelled" ? "cancelled" : "failed", prompt: null, message: cause.message })),
      }), Effect.ensuring(Scope.close(scope, Exit.void)), Effect.forkIn(lifetime),
    );
    return { flowId };
  }).pipe(Effect.mapError(modelError));
  const watchAuth = (input: { flowId: string }) => Stream.unwrap(Effect.gen(function* () {
    const flow = yield* requireFlow(input.flowId);
    yield* Effect.addFinalizer(() => cancelAuth(input).pipe(Effect.ignore, Effect.andThen(Scope.close(flow.scope, Exit.void)), Effect.andThen(Effect.sync(() => flows.delete(input.flowId)))));
    return SubscriptionRef.changes(flow.state).pipe(Stream.takeUntil(state => state.status !== "running"));
  })).pipe(Stream.mapError(modelError));
  const respondAuth = (input: { flowId: string; requestId: string; value: string }) => Effect.gen(function* () {
    const flow = yield* requireFlow(input.flowId);
    const current = yield* SubscriptionRef.get(flow.state);
    if (current.status !== "running" || current.prompt?.id !== input.requestId) return yield* new NeoPiModelsError({ message: "The native login prompt changed. Use its current prompt." });
    yield* flow.connection.validate;
    yield* flow.connection.respondUi({ id: input.requestId, value: input.value }).pipe(Effect.mapError(modelError));
    yield* SubscriptionRef.update(flow.state, state => ({ ...state, prompt: null }));
  });
  yield* Effect.addFinalizer(() => Effect.forEach([...flows], ([flowId, flow]) => cancelAuth({ flowId }).pipe(Effect.ignore, Effect.andThen(Scope.close(flow.scope, Exit.void))), { discard: true }));
  return { connection, read, watch, update, accounts, startAuth, watchAuth, respondAuth, cancelAuth };
});
