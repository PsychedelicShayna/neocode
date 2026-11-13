# Provider constraints

NeoPi is the only execution runtime. Orchestration records intent and state;
protocols, process ownership, permissions and capabilities belong at the
[driver and adapter boundary](../../packages/provider-core/src/server/driver.ts),
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

Publish the final native cursor and recovery metadata before `turn.terminal`.
V2 consumers may close their event subscription at that boundary; a later cursor
update is not a durable recovery receipt.

Client views read the shared [native feed](../../packages/client-runtime/src/state/neopiNativeSessions.ts)
directly, including command-triggered state refreshes. Keep older journal pages in
the [shared conversation owner](../../packages/client-runtime/src/state/neopiConversation.ts),
not a React copy: live updates must retain loaded history, while replies for an
obsolete canonical file, branch revision or leaf-bound cursor must not enter the
current view.

Portable forks and merge-back deliver bounded context as synthetic user input,
not by copying or editing native session files. Keep those handoff capabilities
distinct from native session-tree forking: a portable fork starts its own native
identity, while merge-back retains the receiving session's identity.

NeoPi fresh session files use the CLI's normal directory only when the compatible
peer advertises both `session_lease` (#106) and `new_session` (#107); T3 launches
those sessions with `--new-session`. Otherwise live files stay under the T3 home,
isolated from the NeoPi/OMP picker. Previously isolated threads resume from their
saved files even after sharing becomes available. A profile sets `OMP_PROFILE`
independently for each provider instance. Provider probes do not create shared
user sessions, and OAuth login metadata does not establish API-key or local-model
access.

Opening a native session can start MCP servers or run hooks. Observation and
background probes must not start or resume sessions to discover their metadata.

With `set_mode` (#103), a proposed plan settles the visible T3 turn while the
native proposal request waits for a decision. Implementing in the same thread
approves it; refinement feedback or interruption rejects it. **Implement in new
thread** starts another session and cannot decide the proposal in the original
one: that original request remains pending until its next send, interruption,
or session stop, which resolves it as a refinement. Rollback cannot remove just
the refinement continuation without also removing its original native turn.

Owned native-session scopes finalize in parallel: quitting must cost one RPC
shutdown window, not one window per open session. The shared
[`shutdown.ts`](../../packages/effect-neopi-rpc/src/shutdown.ts) budget covers
stdin EOF, SIGTERM escalation and exit receipts. The desktop backend's force-kill
grace exceeds it, and the outer application-quit deadline also includes backend
output draining. Shortening either outer deadline can orphan detached owners.

When NeoPi advertises `exit_with_parent`, owned RPC launches opt into
`--exit-with-parent` so parent death and stdin EOF abort and dispose their work.
Older peers retain their normal EOF-drain behavior. Control-pipe attachments
never receive that option: closing them only detaches from the terminal's owner.

## Runtime request and capability boundaries

Runtime requests preserve their provider option IDs and response capabilities.
A display label is not necessarily a valid reply, and leaving the visible
history window does not resolve a pending request. Durable responses commit
their resolution and receipt together; live native dialogs remain routed to
the owning runtime.

Host-call cancellation must abort its signal and interrupt its running Effect,
including handlers that do not inspect the signal. Suppress cancelled results
without requiring the native session to close.

Capabilities must describe operations the runtime can actually perform. In
particular, workspace checkpoint support does not establish conversation
rollback support. The [checkpoint boundary](./overview.md#turn-completion-and-checkpoints)
must reject an unavailable rollback before changing files.

Review-guide generation remains unavailable until NeoPi exposes a restricted
read-only loadout ([NeoPi #698](https://github.com/PsychedelicShayna/neopi/issues/698)).
`--tools` alone does not exclude discovered custom tools. Disposable structured
generation must reject investigation rather than claim this is a sandbox.

## Attachments and stored history

Attachments live outside the project workspace. The
[attachment boundary](../../apps/server/src/orchestration-v2/AttachmentClaims.ts) validates and claims
uploads for a thread; adapters choose native input formats for those environment-local files.
A path in the prompt does not grant filesystem access. Keep provider sandbox and approval rules
in force; copying uploads into the project to bypass them changes that boundary.

File attachments introduced a replay compatibility limit. Image-only clients cannot decode
file-bearing messages, and an image-only server can fail the entire environment's startup when
replaying one such event. Rollouts and downgrades must account for persisted history as well as
current client support.

## Provider diagnostics

The [event logger](../../apps/server/src/provider/EventNdjsonLogger.ts) filters
transient events and duplicate raw frames before copying and redacting payloads.
Large or deeply nested payloads become bounded structural summaries that retain
routing identifiers, methods, status and error fields. These limits apply to
diagnostics, not to provider event handling.

Assistant-reference handling is documented under [citations](./assistant-citations.md).
