import type { ReadyFrame } from "effect-neopi-rpc/schema";
import type { ServerProviderCompatibilityAdvisory } from "@t3tools/contracts";

/** Native feature gates are shared by probing, adapter routing and launch planning. */
export const NEOPI_CAPABILITIES = {
  toolApprovalRequest: "tool_approval_request",
  setMode: "set_mode",
  getRoles: "get_roles",
  getUsage: "get_usage",
  sessionLease: "session_lease",
  newSession: "new_session",
  setChatMode: "set_chat_mode",
  promptEntryIds: "prompt_entry_ids",
  planProposalCancel: "plan_proposal_cancel",
  /** `npi sessions list|read --json` exist (NeoPi #355). */
  sessionCatalog: "session_catalog",
  /** Stable selected-branch IDs and shutdown provenance in `sessions read --json`. */
  sessionHistoryIdentity: "session_history_identity",
  /** Canonical journal pages through RPC/control and the stopped-session CLI. */
  sessionJournal: "session_journal",
  /** `npi ctl pipe <selector>` relays a live owner's control socket over stdio (NeoPi #355). */
  controlPipe: "control_pipe",
  /** Present in `ready` only when the peer is a control connection: this runtime is attached, not the owner. */
  controlAttached: "control_v1",
} as const;

/** v2 negotiation is the required transport floor; all named features are optional. */
export function neopiCompatibility(
  ready: ReadyFrame | null,
  negotiatedV2: boolean,
): ServerProviderCompatibilityAdvisory {
  const compatible =
    ready?.protocolVersion === 1 &&
    negotiatedV2 &&
    ready.supportedProtocolVersions?.includes(2) === true;
  return {
    status: compatible ? "supported" : "unsupported",
    message: compatible
      ? null
      : "NeoPi RPC peer is too old or returned an invalid ready handshake; protocol v2 is required. Update the CLI to continue.",
    recommendedVersion: null,
    recommendedRange: null,
  };
}

export function supportsNeoPiCapability(
  capabilities: ReadonlySet<string>,
  name: keyof typeof NEOPI_CAPABILITIES,
): boolean {
  return capabilities.has(NEOPI_CAPABILITIES[name]);
}
