import type { SessionEventFrame } from "effect-neopi-rpc/client";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  makeLiveStreamBudget,
  type RetainedLiveItem,
  type LiveStreamBufferError,
} from "../../orchestration-v2/LiveStreamBudget.ts";
import { NeoPiRuntimeError } from "./NeoPiRuntimeError.ts";

/** Each window has one bounded queue. A slow window cannot stop the native owner. */
export const makeNeoPiNativeEventHub = () => {
  const observers = new Set<(frame: SessionEventFrame) => Effect.Effect<void>>();
  const subscribe = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const budget = yield* makeLiveStreamBudget({
      maxItems: 256,
      maxSerializedBytes: 8 * 1024 * 1024,
    });
    const queue = yield* Queue.unbounded<
      RetainedLiveItem<SessionEventFrame>,
      LiveStreamBufferError | Cause.Done<void>
    >();
    const accept = (frame: SessionEventFrame) =>
      budget.retain(frame).pipe(
        Effect.flatMap((item) => Queue.offer(queue, item)),
        Effect.catch((cause) => Queue.fail(queue, cause)),
        Effect.asVoid,
      );
    observers.add(accept);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        observers.delete(accept);
      }),
    );
    return budget.deliver(Stream.fromQueue(queue)).pipe(
      Stream.provideService(Scope.Scope, scope),
      Stream.mapError(
        (cause) =>
          new NeoPiRuntimeError({
            message:
              "The native observer buffer is full. Reconnect to refresh history; the current transcript is preserved.",
            code: "rpc",
            cause,
          }),
      ),
    );
  });
  return {
    subscribe,
    publish: (frame: SessionEventFrame) =>
      Effect.forEach(observers, (accept) => accept(frame), { discard: true }),
  };
};
