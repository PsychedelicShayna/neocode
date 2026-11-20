import { NeoPiModelsError } from "@t3tools/contracts";
import type { UiRequestFrame } from "effect-neopi-rpc/client";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/**
 * A login flow sends a handful of frames (open_url, notify, input, confirm, cancel). A flow
 * whose reader falls this far behind fails with an error instead of growing or dropping.
 */
export const NEOPI_LOGIN_UI_LIMIT = 256;

/**
 * Login UI frames delivered per login flow. A frame is matched to its flow by `loginId`
 * before it is queued, so other UI traffic on the connection never reaches, delays or
 * displaces a flow's unanswered prompt. Frames for flows nobody follows are not kept.
 * `publish` is synchronous and safe to call from a frame sink.
 */
export interface NeoPiLoginUi {
  readonly publish: (frame: UiRequestFrame) => void;
  readonly subscribe: (
    loginId: string,
  ) => Effect.Effect<Stream.Stream<UiRequestFrame, NeoPiModelsError>, never, Scope.Scope>;
}

export const makeNeoPiLoginUi = (): NeoPiLoginUi => {
  const flows = new Map<string, Set<Queue.Queue<UiRequestFrame, NeoPiModelsError>>>();
  const overflow = new NeoPiModelsError({
    message: `The login sent more than ${NEOPI_LOGIN_UI_LIMIT} unread prompts; it was stopped. Start the login again.`,
  });
  return {
    publish: (frame: UiRequestFrame): void => {
      if (typeof frame.loginId !== "string") return;
      for (const queue of flows.get(frame.loginId) ?? []) {
        if (Queue.sizeUnsafe(queue) >= NEOPI_LOGIN_UI_LIMIT)
          Queue.failCauseUnsafe(queue, Cause.fail(overflow));
        else Queue.offerUnsafe(queue, frame);
      }
    },
    /** Follows one flow from now until the scope closes; subscribe before starting the login. */
    subscribe: (loginId: string) =>
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<UiRequestFrame, NeoPiModelsError>();
        const followers = flows.get(loginId) ?? new Set();
        followers.add(queue);
        flows.set(loginId, followers);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            followers.delete(queue);
            if (followers.size === 0) flows.delete(loginId);
          }),
        );
        return Stream.fromQueue(queue);
      }),
  };
};
