# Provider constraints

NeoPi is the only execution runtime. Keep its protocols, process ownership,
permissions, and capabilities at the
[adapter boundary](../../apps/server/src/provider/Services/ProviderAdapter.ts),
not in reactors or client-specific workarounds.

An instance identifies one executable/profile/environment configuration. Route by
instance so mutable session and catalog state cannot leak between configurations.
Inference-provider IDs such as `openai-codex`, `anthropic`, and `cursor` belong to
NeoPi's model catalog. They must not be interpreted as execution-driver choices.

## Legacy identities remain readable, not executable

The [driver registry](../../apps/server/src/provider/builtInDrivers.ts) ships only
NeoPi. Open wire identifiers and old settings decoders remain because removing
them would discard stored configuration or make history unreadable.

A saved session's runtime identity wins over a draft model choice. Legacy records
are read-only; switching a picker must never reinterpret their history as NeoPi
history. Only fresh defaults fall back to an enabled native configuration. The
[shared classification](../../packages/shared/src/serverSettings.ts) is used by
clients, command admission, and restart recovery.

NeoPi owns inference credentials, account selection, models, and roles. Do not
replace a missing native capability with another CLI's credentials or a GUI-owned
account store.

## Native session ownership

NeoPi/OMP (oh-my-pi compatible) uses JSONL `rpc-ui` with a required negotiated
protocol-v2 transport. The `ready` handshake determines optional features;
unknown or older peers must not be treated as fully compatible. Native `agent_end`
can be nonterminal (`isTerminal: false`), so a T3 turn ends only after a terminal
outcome. Until upstream #102 supplies structured `tool_approval_request`, tool
approvals arrive as `select` extension dialogs with Approve/Deny replies. Approval
mode is selected at process launch; changing modes requires restart and resume,
not a fictitious mid-session RPC setter. A rollback `branch` creates a new native
session file and its new cursor must be saved before T3 reports completion.

NeoPi fresh session files use the CLI's normal directory only when the compatible
peer advertises both `session_lease` (#106) and `new_session` (#107); T3 launches
those sessions with `--new-session`. Otherwise live files stay under the T3 home,
isolated from the NeoPi/OMP picker. Previously isolated threads resume from their
saved files even after sharing becomes available. A profile sets `OMP_PROFILE`
independently for each provider instance. Provider probes do not create shared
user sessions, and OAuth login metadata does not establish API-key or local-model
access.

With `set_mode` (#103), a proposed plan settles the visible T3 turn while the
native proposal request waits for a decision. Implementing in the same thread
approves it; refinement feedback or interruption rejects it. **Implement in new
thread** starts another session and cannot decide the proposal in the original
one: that original request remains pending until its next send, interruption,
or session stop, which resolves it as a refinement. Rollback cannot remove just
the refinement continuation without also removing its original native turn.

## Attachments and stored history

Attachments live outside the project workspace. [ProviderService](../../apps/server/src/provider/Layers/ProviderService.ts)
puts their environment-local paths in turn input and lets adapters choose native input formats.
A path in the prompt does not grant filesystem access. Keep provider sandbox and approval rules
in force; copying uploads into the project to bypass them changes that boundary.

File attachments introduced a replay compatibility limit. Image-only clients cannot decode
file-bearing messages, and an image-only server can fail the entire environment's startup when
replaying one such event. Rollouts and downgrades must account for persisted history as well as
current client support.

Assistant-reference handling is documented under
[citations](./assistant-citations.md).
