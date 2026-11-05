import type { NeoPiNativeSessionLive } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * What the sidebar calls Working, Waiting and idle comes from the running
 * NeoPi process itself: the control registry that `npi ctl list --json`
 * prints, one live snapshot per process. `npi sessions list --live` folds the
 * same snapshots into a coarser `state` that is wrong for this purpose (it
 * counts a queued follow-up as busy and any open pane, such as the context
 * viewer, as a pending dialog), so NeoCode reads the snapshot fields itself.
 *
 * A process that does not answer, or that left the registry, has no live state
 * at all. Unknown is never Working and never Waiting.
 */

/** Dialogs that block on the user's answer. Panes the user opened (`app`, `panel`, `selector`, ...) do not. */
const BLOCKING_DIALOG_FAMILIES: ReadonlySet<string> = new Set([
  "ask",
  "approval",
  "plan_review",
  "extension",
  "confirm",
]);

const ControlSnapshot = Schema.Struct({
  build: Schema.optional(Schema.Struct({ version: Schema.optional(Schema.String) })),
  busy: Schema.optional(
    Schema.Struct({
      streaming: Schema.optional(Schema.Boolean),
      compacting: Schema.optional(Schema.Boolean),
    }),
  ),
  session: Schema.optional(
    Schema.Struct({
      isStreaming: Schema.optional(Schema.Boolean),
      isCompacting: Schema.optional(Schema.Boolean),
    }),
  ),
  dialogs: Schema.optional(Schema.Array(Schema.Struct({ family: Schema.optional(Schema.String) }))),
});
export type NeoPiControlSnapshot = typeof ControlSnapshot.Type;

const ControlRegistry = Schema.fromJsonString(
  Schema.Struct({
    sessions: Schema.Array(
      Schema.Struct({
        meta: Schema.Struct({ instanceId: Schema.String }),
        // `null` for a registered process whose endpoint did not answer (`state: "unresponsive"`).
        snapshot: Schema.NullOr(ControlSnapshot),
      }),
    ),
  }),
);

/** Live control snapshots by instance id; a process that did not answer maps to `null`. */
export type NeoPiControlRegistry = ReadonlyMap<string, NeoPiControlSnapshot | null>;

/** Decodes `npi ctl list --json`; `undefined` when the output is not a registry listing. */
export const decodeNeoPiControlRegistry = (stdout: string): NeoPiControlRegistry | undefined => {
  const decoded = Schema.decodeUnknownOption(ControlRegistry)(stdout);
  if (decoded._tag === "None") return undefined;
  return new Map(decoded.value.sessions.map((row) => [row.meta.instanceId, row.snapshot]));
};

/**
 * Working = the process is streaming a turn or compacting. A queued
 * steer/follow-up, pending background work or an idle prompt is not Working.
 * Waiting = a question, approval, plan review or extension prompt is open;
 * it outranks Working because the turn is parked on the user.
 * `undefined` = the snapshot says nothing about streaming (never guessed).
 */
export const neoPiLiveFromControlSnapshot = (
  snapshot: NeoPiControlSnapshot,
  branch: string | null,
): NeoPiNativeSessionLive | undefined => {
  const streaming = snapshot.busy?.streaming ?? snapshot.session?.isStreaming;
  const compacting = snapshot.busy?.compacting ?? snapshot.session?.isCompacting ?? false;
  if (streaming === undefined) return undefined;
  const pendingDialogs = (snapshot.dialogs ?? []).filter(
    (dialog) => dialog.family !== undefined && BLOCKING_DIALOG_FAMILIES.has(dialog.family),
  ).length;
  const working = streaming || compacting;
  return {
    state: pendingDialogs > 0 ? "waiting" : working ? "busy" : "idle",
    isStreaming: streaming,
    pendingDialogs,
    branch,
  };
};

/**
 * The live state to show for one catalog row. `reported` is what
 * `sessions list --live` said for the row's owner, kept for its branch and as
 * the answer only when the control registry could not be read at all, in which
 * case just its streaming flag is believed: its `waiting` and `busy` states
 * cannot be told apart from an open pane or a queued prompt.
 */
export const resolveNativeLive = (input: {
  readonly instanceId: string | null;
  readonly reported: NeoPiNativeSessionLive | null | undefined;
  readonly registry: NeoPiControlRegistry | undefined;
}): NeoPiNativeSessionLive | undefined => {
  const { instanceId, reported, registry } = input;
  if (instanceId === null) return undefined;
  if (registry === undefined) {
    if (!reported) return undefined;
    return {
      state: reported.isStreaming ? "busy" : "idle",
      isStreaming: reported.isStreaming,
      pendingDialogs: 0,
      branch: reported.branch,
    };
  }
  const snapshot = registry.get(instanceId);
  if (!snapshot) return undefined;
  return neoPiLiveFromControlSnapshot(snapshot, reported?.branch ?? null);
};

/** Release a process reports, for the older-owner notice; `null` when it is not in the registry. */
export const neoPiOwnerVersion = (
  registry: NeoPiControlRegistry | undefined,
  instanceId: string,
): string | null => registry?.get(instanceId)?.build?.version ?? null;

export const olderOwnerMessage = (version: string | null) =>
  `This session runs an older NeoPi${version ? ` (v${version})` : ""}; restart it to use it here.`;
