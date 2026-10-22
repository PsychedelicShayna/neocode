# Permission modes

Open **NeoPi session configuration** in the thread header to see the current native
policy and choose permissions for the **Next owned turn**. Selecting a preference
does not change the running native policy. NeoCode asks the native runtime to
apply it before sending your next turn.

Set the default for new threads in **Settings → General → New threads → Permissions**.
Projects can override the environment default. New threads use this setting rather than the
mode of the thread you were viewing. The initial default is **Full access**; existing threads
and modes you choose in a draft keep their permissions.

| Mode                  | Behavior                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                      |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval.          |
| **Full access**       | Allows commands and edits without approval prompts.                                   |

Approve or reject requests in the conversation to let the agent continue. Permission modes do
not prevent the agent from asking questions about the task.

## Native ownership

NeoPi enforces permissions. While NeoCode is attached to a terminal-owned session,
the preference is disabled. Change the policy in that session's terminal instead.
Opening the configuration panel never starts or restarts the session.

Per-tool policies and native safety checks can still require approval or refuse
an action, including in Full access. Saved Auto preferences use NeoPi's Full
access policy rather than a separate automatic-review mode.
