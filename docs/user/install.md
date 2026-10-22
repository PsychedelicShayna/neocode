# Install NeoCode

NeoCode is a desktop, web, and mobile frontend for NeoPi. Set up NeoPi on the
machine where your sessions will run first.

Download this fork from [NeoCode releases](https://github.com/PsychedelicShayna/neocode/releases).
For a source checkout, follow the [development guide](../operations/development.md).
The T3 Code installers and package-manager entries below install upstream T3 Code,
not NeoCode. Existing `t3` commands, data directories and deep links retain their names.

## Requirements

You need NeoPi and an available inference provider before starting a thread.
NeoCode can open before NeoPi is configured. Existing NeoPi settings are preserved.

## Desktop windows

Use **File > New Window** or `Ctrl+Alt+N`, `Cmd+Alt+N` on macOS, to open another
NeoCode window. Windows in the same profile share their environment connection,
backend and running sessions. Launching the app again still raises the most
recently used window.

Close a window to leave the others running. **Quit** exits the application and
stops its local backend. Closing the last window also exits on Linux and Windows;
on macOS, reopen it from the Dock or **File > New Window**.

A separate `T3CODE_HOME` creates a separate desktop profile, including its browser
storage and instance lock. It does not reuse the default profile's saved browser
connections. Use another window, not another profile pointed at the same state,
when you want to work with the same local sessions.

Open **Models** from the sidebar or press **Alt-M** to configure NeoPi's native
inference providers, model roles and effort rules. Choose the environment and
project whose settings you want to change. Opening Models from a connected
thread uses that native session instead. Changes go through NeoPi and retain
its global/project scope rules; an edit made elsewhere can require a refresh
before you save.

Provider login, API keys and saved-account removal are handled by NeoPi.
NeoCode does not keep another credential vault. Models requires a native
executable advertising the Models configuration contract; an older executable
shows an update error rather than pretending a save worked.

The composer model picker searches through NeoPi's native selector, using the
connected thread's enabled model scope or the selected project's configuration.
Native order and role aliases are preserved. The context column shows the
effective context budget; missing facts show Unknown. Searching requires a
native executable advertising `model_selector`. Query errors are shown in the
picker instead of falling back to a different search.

## Upstream command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

This puts `t3` in `~/.local/bin`. If your shell reports `command not found`
afterwards, that directory is not on your `PATH` yet; the installer prints the
line to add. Set `T3CODE_CHANNEL=nightly` to install the nightly train, or
`T3CODE_VERSION` to pin an exact version.

| Task                                             | Command                                                   |
| ------------------------------------------------ | --------------------------------------------------------- |
| Start the server and open the web app            | `t3`                                                      |
| Start the server without a browser               | `t3 serve`                                                |
| Keep it running in the background (macOS, Linux) | `t3 service install` ([details](./background-service.md)) |
| Move to the newest release                       | `t3 update`                                               |
| Remove it again                                  | `t3 uninstall`                                            |

Run `t3 --help` for the full reference.

To try T3 Code once without installing it, run `npx t3@latest` instead (needs
Node.js for `npx`).

### Intel Macs

There is no `t3` executable for Intel Macs (the desktop app is available). To
run a server there, build it from source with Node.js 24 and `vp`
([Install vp](https://github.com/pingdotgg/t3code#install-vp)):

```bash
git clone https://github.com/pingdotgg/t3code
cd t3code && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

`t3 update` and the background service do not apply to a server run this way;
update it with `git pull` and a rebuild.

## Upstream desktop app

Download a release from [GitHub Releases](https://github.com/pingdotgg/t3code/releases),
or use a package manager:

| Platform           | Install                            |
| ------------------ | ---------------------------------- |
| Windows            | `winget install T3Tools.T3Code`    |
| macOS              | `brew install --cask t3-code`      |
| Debian, Ubuntu     | `sudo apt install ./T3-Code-*.deb` |
| Arch Linux         | `yay -S t3code-bin`                |
| Arch Linux nightly | `yay -S t3code-nightly-bin`        |

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

The [NeoPi-enabled Linux AppImage](https://github.com/PsychedelicShayna/neocode/releases)
includes `npi` and runs it without a separate installation. To use its terminal
agent, run `./T3-Code-npi.AppImage --npi --help` (or replace `--help` with any
`npi` arguments). Authenticate through **Models**, or use the native `npi` login.

On Linux, packaged NeoCode claims the `t3code:` login callback handler. Starting
a source build normally leaves the installed handler unchanged. To use a built
source checkout for callbacks instead, stop that checkout's running app and
launch its Electron entrypoint with `--register-url-handler`:

```bash
apps/desktop/node_modules/.bin/electron apps/desktop/dist-electron/main.cjs --register-url-handler
```

Run this from the built checkout's root. The registered command includes the
complete app entrypoint and forwards callback URLs unchanged. Development builds
use the separate `t3code-dev:` scheme. To return callbacks to the packaged app,
close the source app and launch the packaged app again.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run sessions and projects
there. Install NeoPi inside that distro. NeoCode installs its server runtime
there automatically; the first launch after an app update can take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
t3 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `t3 app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

Install T3 Code from the
[App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or
[Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code).
The phone connects to a server on another machine. Follow
[remote access](./remote-access.md) to link it through T3 Connect or a pairing URL.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## NeoPi

Open **Settings → Providers** in the web or desktop app and select the environment
to configure its NeoPi executable. On Linux, the NeoPi-enabled AppImage includes
`npi`; elsewhere install `npi` or a compatible `omp` CLI. Configure inference
providers, authentication, and models in NeoPi.

NeoCode runs only NeoPi. OpenAI Codex, Anthropic, Cursor, and other inference
providers exposed by NeoPi remain available. They are model backends, not separate
NeoCode agent runtimes.

Saved conversations from other runtimes remain in the database and can still be
read, renamed, or archived. Their history is read-only and cannot be resumed as a
NeoPi session. New threads ignore obsolete runtime defaults and use an available
NeoPi instance without changing the old conversations.

Setup does not scan or import Claude Code or Codex projects. Add a project folder
explicitly from the workspace, or use **Resume NeoPi session** for native history.

NeoPi automatically checks `npi-nightly`, then `npi`, the desktop app's bundled
`npi` (when available), and `omp` for session-catalog support. A version string
alone is not enough. The first capable executable's path is saved in
**Settings → NeoCore**, with a visible automatic-selection note.
Set **Binary path** to override it; explicit paths are never replaced or given a
fallback. Clear the field or enter `npi` to select automatically again. Set
**Profile** to select an `OMP_PROFILE`.
For a bundled desktop executable, NeoCode records the selection but resolves its
installation location again on startup, so an AppImage's changing mount path is
not saved as an explicit override.

NeoCore edits the environment selected in Settings. Select a runtime profile from
the list to edit its launch arguments or environment variables; existing NeoPi
instances keep their own configuration. Mark secret variables as sensitive.
Saved secrets stay concealed, and editing another field preserves them.
If a profile is disabled, use **Enable NeoPi** to make it available again.
If an explicit executable is missing, correct **Binary path** or clear it to
return to automatic selection. Opening NeoCore or selecting a profile does not
start or restart sessions. Model catalogs are not configured on this page.

T3 reads OAuth login status but cannot log you in; API-key and local models can
work even when the card reports authentication as unknown. Model, thinking level,
and fast mode are selected in the composer when the CLI advertises them. With a
current `npi`, NeoPi threads use the CLI's normal session folders, so they also
appear in `npi --resume`; older CLIs keep them isolated under T3's home directory.

To continue a terminal session in NeoCode, use **Resume NeoPi session** (beside
**New thread** in the sidebar, or in the command palette). It lists the
project's NeoPi sessions, or every project's, across all enabled NeoPi instances
that support discovery. Shared session files appear once, preferring your default
instance for new imports. Bound sessions retain their saved provider instance.
GUI-created worktree sessions appear in their owning project under the saved
NeoCode thread title, even if the native file has no title or message preview.
If one instance cannot load its catalog, the picker identifies it and keeps
sessions from healthy instances available. Fix that instance and refresh to
include its sessions.
Symlink and canonical paths refer to the same project and session. Under
**All projects**, you can resume a session from another accessible directory.
NeoCode uses its existing project or known worktree association, or registers
that directory as a project after validating the session. Browsing the list
does not register projects.
The list shows which sessions are open in a terminal. The picker waits for
imported history before opening the thread. Reopening an already-bound, stopped
thread restores new terminal turns into that same thread without duplicating
earlier messages. An active NeoCode thread opens without replacing its history.

NeoCode follows the native session's selected branch in the main conversation,
including turns started in its terminal. GUI turns use the existing NeoPi send
path. Opening a conversation never takes ownership from the terminal or starts a
second writer. The conversation header distinguishes attached input, terminal
observation, stopped history and reconnecting state.

The status beside the composer follows the connected native model and effort,
output throughput, journal-wide cache hit rate, context utilization and recorded
session cost. Context information is always available here, independent of the
legacy indicator setting. Hover a metric for its observation time and scope.
Recorded cost includes all journal branches, completed tasks and restored advisor
spend, but excludes unfinished child runs. Missing counters stay unavailable,
and disconnected observations are not shown as current.

Open **NeoPi session configuration** in the header to inspect native ownership,
current permissions and role configuration. **Next owned turn** changes the
permission preference sent before your next turn, not the current native policy.
The native runtime must accept it. While attached, permission changes are
disabled because the terminal owns that policy. Opening this panel does not
start or restart a session. Use **Refresh** for role-definition changes.

The main conversation reads NeoPi's canonical journal, not an imported SQL
transcript. Compaction, context-reset and branch-summary boundaries stay visible,
and **Load older native entries** reaches history before them without a fixed
history limit. Live messages remain provisional until NeoPi confirms their
durable journal identities. A reconnect reads a fresh branch and never resends a
prompt. Unknown entry types and extension content remain available as canonical
JSON alongside native text, images, reasoning and tool records.

Choose **Session tree**, or **Native history** in the right panel, to inspect
alternate branches. Filter tools and system events, search loaded entries, and
load older pages until the point you want is available. Selecting a row only
inspects it. **Navigate here** runs NeoPi's same-file tree command. It preserves
alternate futures, restores a selected user request and its ordered images to
the composer, and can carry a native summary into the chosen branch.

Selecting an old native ask result can reopen its questions without moving the
branch. Save a new answer to create a sibling answer, wait for the conversation
to rebuild, then choose **Resume after rebuilt transcript**. Reopened answers and
pending continuation acknowledgements survive closing the panel. You can keep
the saved answer without resuming. Cancel before saving leaves the original
branch intact. Navigation and summary failures remain visible in the panel;
they are not reported as successful leaf changes.

Stopped history is read through NeoPi's read-only journal command. To navigate a
stopped session, choose **Start stopped native session and navigate**. This starts
its native owner without sending a prompt. Navigation requires
`session_tree_navigation`; live following requires `session_journal_events`, and
complete paging requires `session_journal`. Missing native support is reported
explicitly. NeoCode does not substitute a partial SQL transcript.

To go the other way, use **Continue in terminal** in a NeoPi thread's header:
NeoCode stops its NeoPi process and copies the command that reopens the same
native session in `npi`. If the terminal still owns the session, NeoCode only
detaches and explains which process keeps it open instead of offering a resume
command. The native conversation reports that detached state while it observes
the terminal. Refresh or reconnect to observe the current owner again.

Discovery and attachment need `session_catalog` and `control_pipe`; restoration
and handoff also require `session_history_identity`. Capability errors identify
the server's configured executable and its probed version. Update that executable
when a compatible handshake confirms a missing capability; an uncompleted or
failed initial check means support is not yet known, not that an update is needed.
Discovery stays usable during refresh and transient probe failures once support
has been confirmed. A successful compatible refresh replaces the previous
capabilities; an incompatible handshake blocks discovery.

Older bindings without a saved history boundary can be restored only when
their completed GUI turn and clean native shutdown
prove an exact boundary. Diverged branches or ambiguous older histories are
refused without replacing the thread; the error includes the native session path
for continuing safely in NeoPi. Pre-v2 native journals must first be continued
in NeoPi to persist durable entry identities.

Add another NeoPi instance for a separate profile or executable configuration.
Each instance can have its own environment variables. Mark secret values as
sensitive; NeoCode does not display their original values after saving.
NeoPi upgrades and inference-provider sign-in remain in NeoPi, not NeoCode.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating T3 Code](./updating.md): update the app and connected servers.
