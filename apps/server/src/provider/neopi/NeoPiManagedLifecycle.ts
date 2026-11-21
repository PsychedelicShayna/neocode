import type { NeoPiManagedSessionLifecycle } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export type ManagedOwnerLiveness = NeoPiManagedSessionLifecycle["liveness"];

const STOP_WAIT_MS = 12_000;

/** Neither control acknowledgement nor bridge loss can establish a process exit. */
export function managedStopStatus(
  liveness: ManagedOwnerLiveness,
  requestedAt: number | undefined,
  needsInput: boolean,
  now: number,
  forcing = false,
): NeoPiManagedSessionLifecycle["stop"] {
  if (liveness === "exited") return "exited";
  if (forcing) return "forcing";
  if (requestedAt === undefined) return "idle";
  if (needsInput) return "awaiting-input";
  return now - requestedAt >= STOP_WAIT_MS ? "unconfirmed" : "requested";
}

/** The durable exclusive claim comes before dispatch, including after restart. */
export const submitManagedStopOnce = <E, A, E2, R>(
  claim: Effect.Effect<boolean, E>,
  dispatch: Effect.Effect<A, E2, R>,
) => Effect.flatMap(claim, (acquired) => (acquired ? Effect.asVoid(dispatch) : Effect.void));
