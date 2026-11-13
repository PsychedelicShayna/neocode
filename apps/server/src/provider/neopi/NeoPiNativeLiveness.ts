import type { NeoPiNativeSessionLive } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// Control snapshots distinguish blocking dialogs and streaming from open panes and queued input.
// The coarse sessions-list state does not; an unresponsive owner has no known live state.

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
const decodeControlRegistry = Schema.decodeOption(ControlRegistry);

/** Live control snapshots by instance id; a process that did not answer maps to `null`. */
export type NeoPiControlRegistry = ReadonlyMap<string, NeoPiControlSnapshot | null>;

/** Decodes `npi ctl list --json`; `undefined` when the output is not a registry listing. */
export const decodeNeoPiControlRegistry = (stdout: string): NeoPiControlRegistry | undefined => {
  const decoded = decodeControlRegistry(stdout);
  if (decoded._tag === "None") return undefined;
  return new Map(decoded.value.sessions.map((row) => [row.meta.instanceId, row.snapshot]));
};

const neoPiLiveFromControlSnapshot = (
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

// Without the control registry, trust only the reported streaming flag.
// Its coarse waiting/busy values include open panes and queued input.
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
