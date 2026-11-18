import type { NeoPiNativeObservationLifecycle, NeoPiThreadNativeRef } from "@t3tools/contracts";

/** What a thread's transcript, tree and status line show about its native observation. */
export interface ThreadNativeConnection {
  readonly status: "connected" | "unavailable" | "disconnected" | "identity_changed";
  /** `gui`: NeoCode's own runtime owns the session; `stopped`: nothing does, history is read-only. */
  readonly ownership: "gui" | "terminal" | "stopped" | "unknown";
  readonly canNavigate: boolean;
  readonly reason: string | null;
}

/** The observation controller's view of one session, as far as a thread needs it. */
export interface ThreadObservationInput {
  readonly phase: "attaching" | NeoPiNativeObservationLifecycle | "transport-lost" | "unauthorized";
  readonly reason: string | null;
  readonly connected: boolean;
  readonly session: {
    readonly sessionId: string;
    readonly capabilities: ReadonlyArray<string>;
  } | null;
}

export const CONTROL_PLANE_OFF_REASON =
  "NeoCode cannot observe this session: its NeoPi runtime is running, but that runtime's control plane is turned off (--no-control-socket or control.enabled=false) or not supported by its NeoPi version. The session itself is still running.";

/**
 * Maps a thread's native ref and its attach-only observation onto the thread statuses.
 * `null` while the ref or the first attachment is still being established.
 */
export function threadNativeConnection(
  ref: NeoPiThreadNativeRef | null,
  observation: ThreadObservationInput | null,
): ThreadNativeConnection | null {
  if (ref === null) return null;
  if (ref.status === "unavailable")
    return { status: "unavailable", ownership: "unknown", canNavigate: false, reason: ref.reason };
  const owner = ref.ownedRuntime ? "gui" : "terminal";
  const unavailable = (reason: string | null): ThreadNativeConnection => ({
    status: "unavailable",
    ownership: ref.ownedRuntime ? "gui" : "unknown",
    canNavigate: false,
    reason,
  });
  if (observation === null) return null;
  const { phase, session } = observation;
  if (session !== null && session.sessionId !== ref.sessionId)
    return {
      status: "identity_changed",
      ownership: owner,
      canNavigate: false,
      reason: "The native session no longer matches this thread's binding. Refresh the binding.",
    };
  switch (phase) {
    case "attaching":
      return session === null
        ? null
        : { status: "disconnected", ownership: owner, canNavigate: false, reason: null };
    case "building":
    case "observing":
      return observation.connected
        ? {
            status: "connected",
            ownership: owner,
            canNavigate: session?.capabilities.includes("session_tree_navigation") === true,
            reason: null,
          }
        : {
            status: "disconnected",
            ownership: owner,
            canNavigate: false,
            reason: observation.reason,
          };
    case "reconnecting":
    case "transport-lost":
    case "authority-unresolved":
      return {
        status: "disconnected",
        ownership: owner,
        canNavigate: false,
        reason: observation.reason,
      };
    // A runtime NeoCode itself runs is never "stopped": finding no attachable owner for it means
    // its control plane is off or unsupported.
    case "owner-stopped":
      return ref.ownedRuntime
        ? unavailable(CONTROL_PLANE_OFF_REASON)
        : {
            status: "unavailable",
            ownership: "stopped",
            canNavigate: false,
            reason: observation.reason,
          };
    case "incompatible":
      return unavailable(ref.ownedRuntime ? CONTROL_PLANE_OFF_REASON : observation.reason);
    case "identity-changed":
      return {
        status: "identity_changed",
        ownership: owner,
        canNavigate: false,
        reason: observation.reason,
      };
    case "detached":
    case "unauthorized":
      return unavailable(observation.reason);
  }
}
