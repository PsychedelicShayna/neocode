import {
  NeoPiNavigateTreeResult,
  type NeoPiNavigateTreeInput,
  type NeoPiResumeTreeInput,
  type NeoPiTreeOperationResult,
  type NeoPiTreeResumeResult,
  type NeoPiTreeCancelResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { neoPiJournalError } from "./NeoPiJournalReader.ts";
import {
  makeNeoPiNativeOwnerResolver,
  makeNeoPiNativeSessionStarter,
  makeNeoPiThreadNativeRef,
  type NeoPiNativeOwner,
} from "./NeoPiNativeOwner.ts";
import type { NeoPiConfigurationIdentity } from "./NeoPiSessionConfiguration.ts";
import type { NeoPiRuntimeError } from "./NeoPiRuntimeError.ts";

const unavailable = (reason: string) => ({ status: "unavailable" as const, reason });

type ResolveOwner = (threadId: ThreadId) => Effect.Effect<
  | {
      readonly expected: NeoPiConfigurationIdentity;
      readonly owner: NeoPiNativeOwner;
    }
  | undefined,
  NeoPiRuntimeError,
  Scope.Scope
>;

/** Tree operations on a thread's existing owner; observation goes through NeoPiNativeSessions. */
export const makeNeoPiNativeConversationWith = (
  resolve: ResolveOwner,
  startStopped: (input: NeoPiNavigateTreeInput) => Effect.Effect<void, NeoPiRuntimeError> = () =>
    Effect.void,
) =>
  Effect.gen(function* () {
    const pending = new Map<ThreadId, NeoPiNativeOwner>();
    const navigate = (input: NeoPiNavigateTreeInput): Effect.Effect<NeoPiTreeOperationResult> =>
      Effect.gen(function* () {
        if (pending.has(input.threadId))
          return {
            status: "error" as const,
            code: "session_busy",
            message: "A native tree navigation is already pending.",
          };
        let resolved = yield* resolve(input.threadId);
        if (!resolved && input.startIfStopped) {
          yield* startStopped(input);
          resolved = yield* resolve(input.threadId);
        }
        if (!resolved)
          return unavailable(
            "Start or resume this native session explicitly before navigating its tree.",
          );
        if (!resolved.owner.capabilities.has("session_tree_navigation"))
          return unavailable("The existing native owner does not support session_tree_navigation.");
        const { threadId, startIfStopped: _, ...options } = input;
        if (
          options.expectedSessionId !== resolved.expected.sessionId ||
          options.expectedSessionFile !== resolved.expected.sessionFile
        )
          return {
            status: "error" as const,
            code: "session_changed",
            message: "Navigation does not match the thread's canonical native binding.",
          };
        if (pending.has(threadId))
          return {
            status: "error" as const,
            code: "session_busy",
            message: "A native tree navigation is already pending.",
          };
        pending.set(threadId, resolved.owner);
        return yield* Effect.gen(function* () {
          const result = yield* Schema.decodeUnknownEffect(NeoPiNavigateTreeResult)(
            yield* resolved.owner.request({ type: "navigate_tree", ...options }),
          );
          return { status: "available" as const, result };
        }).pipe(
          Effect.onInterrupt(() => resolved.owner.request({ type: "abort" }).pipe(Effect.ignore)),
          Effect.ensuring(
            Effect.sync(() => {
              pending.delete(threadId);
            }),
          ),
        );
      }).pipe(
        Effect.scoped,
        Effect.catch((cause) => Effect.succeed(neoPiJournalError(cause))),
      );
    const resume = (input: NeoPiResumeTreeInput): Effect.Effect<NeoPiTreeResumeResult> =>
      Effect.gen(function* () {
        const resolved = yield* resolve(input.threadId);
        if (!resolved)
          return unavailable("The native owner is disconnected. No ask continuation was started.");
        if (!resolved.owner.capabilities.has("session_tree_navigation"))
          return unavailable("The native owner does not support session_tree_navigation.");
        const { threadId: _, ...options } = input;
        if (
          options.expectedSessionId !== resolved.expected.sessionId ||
          options.expectedSessionFile !== resolved.expected.sessionFile
        )
          return {
            status: "error" as const,
            code: "session_changed",
            message: "Resume does not match the thread's canonical native binding.",
          };
        const result = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ resumed: Schema.Literal(true) }),
        )(yield* resolved.owner.request({ type: "resume_tree", ...options }));
        return { status: "available" as const, result };
      }).pipe(
        Effect.scoped,
        Effect.catch((cause) => Effect.succeed(neoPiJournalError(cause))),
      );
    const cancel = (threadId: ThreadId): Effect.Effect<NeoPiTreeCancelResult> =>
      Effect.gen(function* () {
        const owner = pending.get(threadId);
        if (!owner)
          return unavailable(
            "There is no NeoCode navigation to cancel. No native turn was interrupted.",
          );
        return { status: "available" as const, result: yield* owner.request({ type: "abort" }) };
      }).pipe(Effect.catch((cause) => Effect.succeed(neoPiJournalError(cause))));
    return { navigate, resume, cancel };
  });

export const makeNeoPiNativeConversation = Effect.fn("NeoPiNativeConversation.make")(function* () {
  const resolve = yield* makeNeoPiNativeOwnerResolver();
  const startStopped = yield* makeNeoPiNativeSessionStarter();
  const nativeRef = yield* makeNeoPiThreadNativeRef();
  const conversation = yield* makeNeoPiNativeConversationWith(resolve, startStopped);
  return { ...conversation, nativeRef };
});
