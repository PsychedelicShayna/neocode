import type { NeoPiManagedSessionLifecycle, NeoPiNativeSessionSummary } from "@t3tools/contracts";

/**
 * What a native session asks of the user right now: `waiting` is blocked on
 * an answer, `done` finished something the user has not looked at, `working`
 * is busy and needs nothing, `idle` is simply history. Only `waiting` and
 * `working` choose a section; `done` marks a row within recent history.
 */
export type NativeSessionStatus = "waiting" | "done" | "working" | "idle";

const MANAGED_STOP_LABEL = {
  requested: "Stop requested",
  "awaiting-input": "Stop needs input",
  unconfirmed: "Stop unconfirmed",
  forcing: "Force Stop requested",
  exited: "Exited",
} as const;

export function managedSessionSidebarLabel(
  liveness: NeoPiManagedSessionLifecycle["liveness"],
  stop: NeoPiManagedSessionLifecycle["stop"],
  attention: NativeSessionStatus,
) {
  if (stop !== "idle") return MANAGED_STOP_LABEL[stop];
  if (liveness === "exited") return "Exited";
  if (liveness === "unknown") return "Liveness unknown";
  if (attention === "waiting") return "Needs input";
  return attention === "working" ? "Working" : "Alive";
}

export type NativeSessionSection = "attention" | "working" | "recent" | "settled";

export interface NativeSessionEntry<S extends NativeSessionSummaryLike = NativeSessionSummaryLike> {
  readonly session: S;
  readonly status: NativeSessionStatus;
}

export type NativeSessionSummaryLike = Pick<
  NeoPiNativeSessionSummary,
  "ref" | "modifiedAt" | "live" | "settledAt"
>;

export interface NativeSessionVisitState {
  /** When this client first listed the environment: older activity counts as seen. */
  readonly baseline: string;
  /** Last time each session file was open in this client, ISO 8601. */
  readonly visited: Readonly<Record<string, string>>;
}

function toMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * `done` needs activity newer than the last visit. A session never visited is
 * judged against the baseline, so installing this client does not light up
 * every historical session. The open session is never `done`: the user is
 * looking at it.
 */
export function resolveNativeSessionStatus(
  session: NativeSessionSummaryLike,
  visits: NativeSessionVisitState,
  isOpen: boolean,
): NativeSessionStatus {
  const live = session.live?.state;
  if (live === "waiting") return "waiting";
  if (live === "busy") return "working";
  if (isOpen) return "idle";
  const seen = visits.visited[session.ref.sessionFile] ?? visits.baseline;
  return toMs(session.modifiedAt) > toMs(seen) ? "done" : "idle";
}

export function nativeSessionSection(
  session: NativeSessionSummaryLike,
  status: NativeSessionStatus,
): NativeSessionSection {
  // The server wakes a settled session the moment its owner gets busy or
  // blocked, so a settled stamp here always means history.
  if (session.settledAt !== undefined) return "settled";
  switch (status) {
    case "waiting":
      return "attention";
    case "working":
      return "working";
    case "done":
    case "idle":
      return "recent";
  }
}

export interface NativeSessionSections<S extends NativeSessionSummaryLike> {
  readonly attention: ReadonlyArray<NativeSessionEntry<S>>;
  readonly working: ReadonlyArray<NativeSessionEntry<S>>;
  readonly recent: ReadonlyArray<NativeSessionEntry<S>>;
  readonly settled: ReadonlyArray<NativeSessionEntry<S>>;
}

const byRecency = (a: NativeSessionSummaryLike, b: NativeSessionSummaryLike) =>
  toMs(b.modifiedAt) - toMs(a.modifiedAt);

/**
 * Splits sessions into the sidebar's sections: blocked sessions, then working
 * ones, then recent history (finished-unseen included), each newest first.
 * The settled shelf orders by when each session was settled.
 */
export function partitionNativeSessions<S extends NativeSessionSummaryLike>(
  sessions: ReadonlyArray<S>,
  visits: NativeSessionVisitState,
  openSessionFile: string | null,
): NativeSessionSections<S> {
  const attention: Array<NativeSessionEntry<S>> = [];
  const working: Array<NativeSessionEntry<S>> = [];
  const recent: Array<NativeSessionEntry<S>> = [];
  const settled: Array<NativeSessionEntry<S>> = [];
  for (const session of sessions) {
    const status = resolveNativeSessionStatus(
      session,
      visits,
      session.ref.sessionFile === openSessionFile,
    );
    const section = nativeSessionSection(session, status);
    const target =
      section === "attention"
        ? attention
        : section === "working"
          ? working
          : section === "recent"
            ? recent
            : settled;
    target.push({ session, status });
  }
  attention.sort((a, b) => byRecency(a.session, b.session));
  working.sort((a, b) => byRecency(a.session, b.session));
  recent.sort((a, b) => byRecency(a.session, b.session));
  settled.sort(
    (a, b) =>
      toMs(b.session.settledAt ?? "") - toMs(a.session.settledAt ?? "") ||
      byRecency(a.session, b.session),
  );
  return { attention, working, recent, settled };
}

/** The folder a session works in, as the row's project label. */
export function nativeSessionProjectLabel(cwd: string): string {
  const name = cwd
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1);
  return name ? name : "No project";
}
