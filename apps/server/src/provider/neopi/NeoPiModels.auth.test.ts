import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type NeoPiModelsAuthState } from "@t3tools/contracts";
import { NeoPiRpcError } from "effect-neopi-rpc/errors";
import type { UiRequestFrame } from "effect-neopi-rpc/client";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { makeNativeModelsAuth } from "./NeoPiModels.ts";
import type { NeoPiModelsConnection } from "./NeoPiModelsConnection.ts";

const target = { providerInstanceId: ProviderInstanceId.make("native-auth") };
const cancelled = () => new NeoPiRpcError({ code: "login_cancelled", message: "Login cancelled" });
const fixture = Effect.fnUntraced(function* (
  cancelReply?: Effect.Effect<unknown, NeoPiRpcError>,
  uiReply: Effect.Effect<void, NeoPiRpcError> = Effect.void,
  initialPrompt?: {
    readonly id: string;
    readonly title: string;
    readonly method?: "input" | "confirm";
    readonly message?: string;
    readonly secret?: boolean;
  },
  validate: Effect.Effect<void> = Effect.void,
) {
  const result = yield* Deferred.make<unknown, NeoPiRpcError>();
  const loginId = yield* Deferred.make<string>();
  const requestEnded = yield* Deferred.make<void>();
  const cancelStarted = yield* Deferred.make<void>();
  const respondStarted = yield* Deferred.make<void>();
  const cancelCalls = yield* Ref.make(0);
  const releases = yield* Ref.make(0);
  const responses = yield* Ref.make<
    ReadonlyArray<Parameters<NeoPiModelsConnection["respondUi"]>[0]>
  >([]);
  const ui = yield* Effect.acquireRelease(PubSub.unbounded<UiRequestFrame>(), PubSub.shutdown);
  const native: NeoPiModelsConnection = {
    capabilities: new Set(["cancellable_login"]),
    validate,
    changes: Stream.empty,
    ui: Stream.fromPubSub(ui),
    respondUi: (response) =>
      Ref.update(responses, (current) => [...current, response]).pipe(
        Effect.andThen(Deferred.succeed(respondStarted, undefined)),
        Effect.andThen(uiReply),
      ),
    request: (command) =>
      Effect.gen(function* () {
        if (command.type === "login" && "id" in command && typeof command.id === "string") {
          yield* Deferred.succeed(loginId, command.id);
          if (initialPrompt)
            yield* PubSub.publish(ui, {
              type: "extension_ui_request",
              ...initialPrompt,
              method: initialPrompt.method ?? "input",
              loginId: command.id,
            });
          return yield* Deferred.await(result).pipe(
            Effect.ensuring(Deferred.succeed(requestEnded, undefined)),
          );
        }
        if (command.type === "cancel_login" && "loginId" in command) {
          if (command.loginId !== (yield* Deferred.await(loginId)))
            return yield* new NeoPiRpcError({
              message: "This connection has no such active login",
            });
          yield* Ref.update(cancelCalls, (count) => count + 1);
          yield* Deferred.succeed(cancelStarted, undefined);
          return yield* cancelReply ?? Deferred.fail(result, cancelled());
        }
        return yield* new NeoPiRpcError({ message: "Unexpected auth command" });
      }),
  };
  // Built in a scope that closes at once, as the server's handlers are.
  const auth = yield* Effect.scoped(
    makeNativeModelsAuth(() =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Ref.update(releases, (count) => count + 1));
        return native;
      }),
    ),
  );
  const flow = yield* auth.startAuth({ target, providerId: "fixture-provider" });
  return {
    auth,
    flow,
    result,
    loginId,
    requestEnded,
    cancelStarted,
    respondStarted,
    cancelCalls,
    releases,
    responses,
    ui,
  };
});

describe("native Models login lifecycle", () => {
  it.effect("cancels a pending confirmation with its original login ID, not the dialog ID", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { auth, flow, cancelCalls, responses } = yield* fixture(undefined, Effect.void, {
          id: "certificate-dialog",
          method: "confirm",
          title: "Verify server",
          message: "Certificate verification",
        });
        const ready = yield* Deferred.make<void>();
        const watch = yield* auth.watchAuth(flow).pipe(
          Stream.tap((state) =>
            state.prompt?.id === "certificate-dialog"
              ? Deferred.succeed(ready, undefined)
              : Effect.void,
          ),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        yield* auth.cancelAuth(flow);
        const states = yield* Fiber.join(watch);
        expect(states.at(-1)).toMatchObject({ status: "cancelled", prompt: null });
        expect(yield* Ref.get(cancelCalls)).toBe(1);
        expect(yield* Ref.get(responses)).toHaveLength(0);
      }),
    ),
  );

  it.effect("requires a boolean answer to native trust and preserves the native message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const message =
          "https://office.example\nServer SHA256: full server fingerprint\nCA SHA256: full CA fingerprint\nCompare with your administrator. Trust applies only to this credential.";
        const { auth, flow, result, responses } = yield* fixture(Effect.void, Effect.void, {
          id: "trust-dialog",
          method: "confirm",
          title: "Verify this server",
          message,
        });
        const ready = yield* Deferred.make<void>();
        const watch = yield* auth.watchAuth(flow).pipe(
          Stream.tap((state) =>
            state.prompt?.id === "trust-dialog" ? Deferred.succeed(ready, undefined) : Effect.void,
          ),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        expect(yield* Ref.get(responses)).toHaveLength(0);
        const textAnswer = yield* auth
          .respondAuth({ flowId: flow.flowId, requestId: "trust-dialog", value: "yes" })
          .pipe(Effect.result);
        expect(textAnswer._tag).toBe("Failure");
        expect(yield* Ref.get(responses)).toHaveLength(0);
        const current = yield* auth.watchAuth(flow).pipe(Stream.take(1), Stream.runCollect);
        expect(current.at(0)?.prompt).toEqual({
          kind: "confirm",
          id: "trust-dialog",
          title: "Verify this server",
          message,
        });
        yield* auth.respondAuth({
          flowId: flow.flowId,
          requestId: "trust-dialog",
          confirmed: false,
        });
        yield* Deferred.fail(result, cancelled());
        const states = yield* Fiber.join(watch);
        expect(states.at(-1)).toMatchObject({ status: "cancelled", prompt: null });
      }),
    ),
  );

  it.effect("keeps member-key input masked and rejects a confirmation in its place", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { auth, flow, result, responses } = yield* fixture(Effect.void, Effect.void, {
          id: "key-dialog",
          title: "Member key",
          secret: true,
        });
        const ready = yield* Deferred.make<void>();
        const watch = yield* auth.watchAuth(flow).pipe(
          Stream.tap((state) =>
            state.prompt?.id === "key-dialog" ? Deferred.succeed(ready, undefined) : Effect.void,
          ),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        const answer = yield* auth
          .respondAuth({ flowId: flow.flowId, requestId: "key-dialog", confirmed: true })
          .pipe(Effect.result);
        expect(answer._tag).toBe("Failure");
        expect(yield* Ref.get(responses)).toHaveLength(0);
        const current = yield* auth.watchAuth(flow).pipe(Stream.take(1), Stream.runCollect);
        expect(current.at(0)?.prompt).toMatchObject({ kind: "input", secret: true });
        yield* auth.respondAuth({
          flowId: flow.flowId,
          requestId: "key-dialog",
          value: "fixture-member-key",
        });
        yield* Deferred.succeed(result, {});
        const states = yield* Fiber.join(watch);
        expect(states.at(-1)).toMatchObject({ status: "complete", prompt: null });
      }),
    ),
  );

  it.effect("isolates foreign login prompts and rejects foreign or retired dialog IDs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { auth, flow, result, ui, responses } = yield* fixture(Effect.void, Effect.void, {
          id: "first-dialog",
          title: "First prompt",
        });
        const ready = yield* Deferred.make<void>();
        const foreignConsumed = yield* Deferred.make<NeoPiModelsAuthState>();
        const secondReady = yield* Deferred.make<void>();
        const watch = yield* auth.watchAuth(flow).pipe(
          Stream.tap((state) => {
            if (state.prompt?.id === "second-dialog")
              return Deferred.succeed(secondReady, undefined);
            if (state.message === "foreign event consumed")
              return Deferred.succeed(foreignConsumed, state);
            return state.prompt?.id === "first-dialog"
              ? Deferred.succeed(ready, undefined)
              : Effect.void;
          }),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        yield* PubSub.publish(ui, {
          type: "extension_ui_request",
          id: "foreign-dialog",
          method: "confirm",
          loginId: "foreign-login",
          title: "Foreign trust",
          message: "Do not show or answer this dialog",
        });
        yield* PubSub.publish(ui, {
          type: "extension_ui_request",
          id: "receipt",
          method: "notify",
          loginId: flow.flowId,
          message: "foreign event consumed",
        });
        expect((yield* Deferred.await(foreignConsumed)).prompt?.id).toBe("first-dialog");
        for (const input of [
          { flowId: flow.flowId, requestId: "foreign-dialog", confirmed: true },
          { flowId: "foreign-login", requestId: "first-dialog", value: "answer" },
        ]) {
          expect((yield* auth.respondAuth(input).pipe(Effect.result))._tag).toBe("Failure");
        }
        yield* PubSub.publish(ui, {
          type: "extension_ui_request",
          id: "second-dialog",
          method: "confirm",
          loginId: flow.flowId,
          title: "Current trust",
          message: "Current certificate",
        });
        yield* Deferred.await(secondReady);
        expect(
          (yield* auth
            .respondAuth({ flowId: flow.flowId, requestId: "first-dialog", value: "stale" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* Ref.get(responses)).toHaveLength(0);
        yield* auth.respondAuth({
          flowId: flow.flowId,
          requestId: "second-dialog",
          confirmed: true,
        });
        expect(
          (yield* auth
            .respondAuth({ flowId: flow.flowId, requestId: "second-dialog", confirmed: true })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* Ref.get(responses)).toHaveLength(1);
        yield* Deferred.succeed(result, {});
        yield* Fiber.join(watch);
      }),
    ),
  );

  it.effect("rechecks prompt identity after suspended connection validation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const validating = yield* Deferred.make<void>();
        const validated = yield* Deferred.make<void>();
        const { auth, flow, result, ui, responses } = yield* fixture(
          Effect.void,
          Effect.void,
          { id: "old-dialog", title: "Old prompt" },
          Deferred.succeed(validating, undefined).pipe(Effect.andThen(Deferred.await(validated))),
        );
        const ready = yield* Deferred.make<void>();
        const changed = yield* Deferred.make<void>();
        const watch = yield* auth.watchAuth(flow).pipe(
          Stream.tap((state) =>
            state.prompt?.id === "old-dialog"
              ? Deferred.succeed(ready, undefined)
              : state.prompt?.id === "new-dialog"
                ? Deferred.succeed(changed, undefined)
                : Effect.void,
          ),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        const answer = yield* auth
          .respondAuth({ flowId: flow.flowId, requestId: "old-dialog", value: "stale" })
          .pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(validating);
        yield* PubSub.publish(ui, {
          type: "extension_ui_request",
          id: "new-dialog",
          method: "confirm",
          loginId: flow.flowId,
          title: "Verify current certificate",
          message: "Current certificate",
        });
        yield* Deferred.await(changed);
        yield* Deferred.succeed(validated, undefined);
        expect((yield* Fiber.join(answer))._tag).toBe("Failure");
        expect(yield* Ref.get(responses)).toHaveLength(0);
        yield* Deferred.succeed(result, {});
        yield* Fiber.join(watch);
      }),
    ),
  );

  it.effect("preserves the public device verification code from the native challenge", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { auth, flow, loginId, ui } = yield* fixture();
        const observed = yield* Deferred.make<void>();
        const watch = yield* auth.watchAuth(flow).pipe(
          Stream.filter((state) => state.userCode !== null),
          Stream.take(1),
          Stream.tap((state) => {
            expect(state.userCode).toBe("ABCD-EFGH");
            expect(state.url).toBe("https://example.com/device");
            return Deferred.succeed(observed, undefined);
          }),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* PubSub.publish(ui, {
          type: "extension_ui_request",
          id: "device-challenge",
          method: "open_url",
          loginId: yield* Deferred.await(loginId),
          url: "https://example.com/device",
          userCode: "ABCD-EFGH",
        });
        yield* Deferred.await(observed);
        yield* Fiber.join(watch);
      }),
    ),
  );
  it.effect("reports native cancellation as cancelled rather than failed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { auth, flow, requestEnded } = yield* fixture();
        const watch = yield* auth.watchAuth(flow).pipe(Stream.runCollect, Effect.forkScoped);
        yield* auth.cancelAuth(flow);
        const states = yield* Fiber.join(watch);
        expect(states.at(-1)).toMatchObject({
          status: "cancelled",
          message: "Login cancelled",
          prompt: null,
        });
        yield* Deferred.await(requestEnded);
      }),
    ),
  );

  it.effect("keeps native success when saving an account wins against cancellation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { auth, flow, result } = yield* fixture(Effect.void);
        const watch = yield* auth.watchAuth(flow).pipe(Stream.runCollect, Effect.forkScoped);
        yield* auth.cancelAuth(flow);
        yield* Deferred.succeed(result, { providerId: "fixture-provider" });
        const states = yield* Fiber.join(watch);
        expect(states.at(-1)?.status).toBe("complete");
        expect(states.some((state) => state.status === "cancelled")).toBe(false);
      }),
    ),
  );

  it.effect("delivers the full native failure even when the watch starts after login fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { auth, flow, result, requestEnded } = yield* fixture();
        const message = "Provider login failed: callback rejected; native detail: invalid verifier";
        yield* Deferred.fail(result, new NeoPiRpcError({ message }));
        yield* Deferred.await(requestEnded);
        const states = yield* auth.watchAuth(flow).pipe(Stream.runCollect);
        expect(states.at(-1)).toMatchObject({ status: "failed", message, prompt: null });
      }),
    ),
  );

  it.effect(
    "settles the watch with the cancellation error instead of leaving a waiting login",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const message = "This connection has no such active login";
          const { auth, flow, requestEnded } = yield* fixture(
            Effect.fail(new NeoPiRpcError({ message })),
          );
          const watch = yield* auth.watchAuth(flow).pipe(Stream.runCollect, Effect.forkScoped);
          const cancel = yield* auth.cancelAuth(flow).pipe(Effect.result);
          expect(cancel._tag).toBe("Failure");
          if (cancel._tag === "Failure") expect(cancel.failure.message).toBe(message);
          const states = yield* Fiber.join(watch);
          expect(states.at(-1)).toMatchObject({ status: "failed", message, prompt: null });
          yield* Deferred.await(requestEnded);
        }),
      ),
  );

  it.effect("does not replace native completion with a late cancellation error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reply = yield* Deferred.make<unknown, NeoPiRpcError>();
        const { auth, flow, result, cancelStarted } = yield* fixture(Deferred.await(reply));
        const watch = yield* auth.watchAuth(flow).pipe(Stream.runCollect, Effect.forkScoped);
        const cancel = yield* auth.cancelAuth(flow).pipe(Effect.forkScoped);
        yield* Deferred.await(cancelStarted);
        yield* Deferred.succeed(result, {});
        const states = yield* Fiber.join(watch);
        expect(states.at(-1)?.status).toBe("complete");
        yield* Deferred.fail(
          reply,
          new NeoPiRpcError({ message: "This connection has no such active login" }),
        );
        yield* Fiber.join(cancel);
      }),
    ),
  );

  it.effect("shares one native cancellation between concurrent requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reply = yield* Deferred.make<unknown, NeoPiRpcError>();
        const { auth, flow, result, cancelStarted, cancelCalls } = yield* fixture(
          Deferred.await(reply),
        );
        const watch = yield* auth.watchAuth(flow).pipe(Stream.runCollect, Effect.forkScoped);
        const first = yield* auth.cancelAuth(flow).pipe(Effect.forkScoped);
        const second = yield* auth.cancelAuth(flow).pipe(Effect.forkScoped);
        yield* Deferred.await(cancelStarted);
        yield* Deferred.fail(result, cancelled());
        yield* Deferred.succeed(reply, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        const states = yield* Fiber.join(watch);
        expect(states.at(-1)?.status).toBe("cancelled");
        expect(yield* Ref.get(cancelCalls)).toBe(1);
      }),
    ),
  );

  it.effect(
    "interrupts the pending request and releases the borrowed connection on watch teardown",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { auth, flow, requestEnded, releases, cancelCalls } = yield* fixture(Effect.void);
          const ready = yield* Deferred.make<void>();
          const watch = yield* auth.watchAuth(flow).pipe(
            Stream.tap(() => Deferred.succeed(ready, undefined)),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* Deferred.await(ready);
          yield* Fiber.interrupt(watch);
          yield* Deferred.await(requestEnded);
          expect(yield* Ref.get(releases)).toBe(1);
          expect(yield* Ref.get(cancelCalls)).toBe(1);
        }),
      ),
  );

  it.live("keeps a login alive after the scope that built the auth has closed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { auth, flow, result, releases, cancelCalls, requestEnded } = yield* fixture(
          Effect.void,
        );
        yield* Effect.sleep("50 millis");
        expect(yield* Ref.get(cancelCalls)).toBe(0);
        expect(yield* Ref.get(releases)).toBe(0);
        expect(yield* Deferred.isDone(requestEnded)).toBe(false);
        const watch = yield* auth.watchAuth(flow).pipe(Stream.runCollect, Effect.forkScoped);
        yield* Deferred.succeed(result, {});
        expect((yield* Fiber.join(watch)).at(-1)?.status).toBe("complete");
      }),
    ),
  );

  it.effect("ends every live login when the auth is closed explicitly", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { auth, cancelCalls, releases } = yield* fixture();
        yield* auth.close;
        expect(yield* Ref.get(cancelCalls)).toBe(1);
        expect(yield* Ref.get(releases)).toBe(1);
      }),
    ),
  );

  it.effect("keeps login alive until the last observer leaves", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { auth, flow, result, releases, cancelCalls } = yield* fixture(Effect.void);
        const firstReady = yield* Deferred.make<void>();
        const secondReady = yield* Deferred.make<void>();
        const first = yield* auth.watchAuth(flow).pipe(
          Stream.tap(() => Deferred.succeed(firstReady, undefined)),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const second = yield* auth.watchAuth(flow).pipe(
          Stream.tap(() => Deferred.succeed(secondReady, undefined)),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(firstReady);
        yield* Deferred.await(secondReady);
        yield* Fiber.interrupt(first);
        expect(yield* Ref.get(cancelCalls)).toBe(0);
        expect(yield* Ref.get(releases)).toBe(0);
        yield* Deferred.succeed(result, {});
        const states = yield* Fiber.join(second);
        expect(states.at(-1)?.status).toBe("complete");
      }),
    ),
  );
  it.effect("does not clear a newer prompt when an older answer finishes sending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reply = yield* Deferred.make<void>();
        const { auth, flow, result, ui, respondStarted } = yield* fixture(
          Effect.void,
          Deferred.await(reply),
          { id: "first", title: "First answer" },
        );
        const firstPrompt = yield* Deferred.make<void>();
        const secondPrompt = yield* Deferred.make<void>();
        const watch = yield* auth.watchAuth(flow).pipe(
          Stream.tap((state) =>
            state.prompt?.id === "first"
              ? Deferred.succeed(firstPrompt, undefined)
              : state.prompt?.id === "second"
                ? Deferred.succeed(secondPrompt, undefined)
                : Effect.void,
          ),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(firstPrompt);
        const response = yield* auth
          .respondAuth({
            flowId: flow.flowId,
            requestId: "first",
            value: "fixture answer",
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(respondStarted);
        yield* PubSub.publish(ui, {
          type: "extension_ui_request",
          id: "second",
          method: "input",
          title: "Second answer",
          loginId: flow.flowId,
        });
        yield* Deferred.await(secondPrompt);
        yield* Deferred.succeed(reply, undefined);
        yield* Fiber.join(response);
        const current = yield* auth.watchAuth(flow).pipe(Stream.take(1), Stream.runCollect);
        expect(current.at(0)?.prompt).toMatchObject({ id: "second", title: "Second answer" });
        yield* Deferred.succeed(result, {});
        yield* Fiber.join(watch);
      }),
    ),
  );
});
