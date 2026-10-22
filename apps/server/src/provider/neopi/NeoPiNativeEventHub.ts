import type { SessionEventFrame } from "effect-neopi-rpc/client";
import type { OrchestrationGetSnapshotError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { makeLiveStreamBudget, type RetainedLiveItem } from "../../orchestration/LiveStreamBudget.ts";

/** Each window has one bounded queue. A slow window cannot stop the native owner. */
export const makeNeoPiNativeEventHub = () => {
  const observers = new Set<(frame: SessionEventFrame) => Effect.Effect<void>>();
  const subscribe = Effect.gen(function* () {
    const budget = yield* makeLiveStreamBudget({ maxItems: 256, maxSerializedBytes: 8 * 1024 * 1024 });
    const queue = yield* Queue.unbounded<RetainedLiveItem<SessionEventFrame>, OrchestrationGetSnapshotError | Cause.Done<void>>();
    const accept = (frame: SessionEventFrame) => budget.retain(frame).pipe(
      Effect.flatMap((item) => Queue.offer(queue, item)),
      Effect.catch((cause) => Queue.fail(queue, cause)),
      Effect.asVoid,
    );
    observers.add(accept);
    yield* Effect.addFinalizer(() => Effect.sync(() => { observers.delete(accept); }));
    return budget.deliver(Stream.fromQueue(queue)).pipe(
      Stream.mapError(() => new Error("The native observer buffer is full. Reconnect to rebuild canonical history; unsaved streaming output must be discarded.")),
    );
  });
  return {
    subscribe,
    publish: (frame: SessionEventFrame) => Effect.forEach(observers, (accept) => accept(frame), { discard: true }),
  };
};
