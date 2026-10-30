# Install NeoCode

NeoCode is NeoPi's graphical frontend. Install NeoCode on your computer and
NeoPi on the machine where your sessions will run.

Download from [NeoCode releases](https://github.com/PsychedelicShayna/neocode/releases).
Choose a stable release or, for nightly builds, a release marked **Pre-release**.
The fork currently publishes Linux x64 and unsigned Windows x64 builds, not
macOS or app-store releases. For a source checkout or another platform, follow
the [development guide](../operations/development.md).

Upstream T3 Code installers and package-manager entries install upstream T3 Code,
not NeoCode. Existing `t3` commands, data directories and deep links retain their names.

## Requirements

You need NeoPi and an available inference provider before starting a thread.
NeoCode can open before NeoPi is configured. Existing NeoPi settings are preserved.

## Download and run the desktop app

### Linux x64

Download the `NeoCode-…-x86_64.AppImage` asset from your chosen release. In a
terminal, change to its download folder and replace `<version>` below with the
full version in the downloaded filename:

```bash
chmod +x ./NeoCode-<version>-x86_64.AppImage
./NeoCode-<version>-x86_64.AppImage
```

The executable-bit step is required before launching a freshly downloaded
AppImage. Keep the file in a location you control; moving or deleting it changes
the path you use to start the app.

On Debian or Ubuntu, download the release's `NeoCode-…-amd64.deb` instead:

```bash
sudo apt install ./NeoCode-<version>-amd64.deb
```

The package retains the `t3code` package and desktop identities for compatibility;
it is not a side-by-side installation of upstream T3 Code. `.deb` updates need a
working password prompt. If an update cannot install, download the new `.deb`
from the fork and install it with the same command.

### Windows x64

Download and run the release's `NeoCode-…-x64.exe` NSIS installer. Fork Windows
builds are unsigned, so Windows may show an unknown-publisher or SmartScreen
warning. Check that the file came from `PsychedelicShayna/neocode` and review the
warning before choosing whether to proceed; do not disable system protections.

The release includes `SHA256SUMS` for checking downloaded assets. Download it from
the same release as your installer. NeoPi is a separate runtime; configure it
using the [NeoPi steps below](#neopi) before starting work.

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
thread uses that native session instead. If that session has disconnected,
reopen it before using Models; the page does not reconnect it or silently switch
to another settings target. Changes go through NeoPi and retain its
global/project scope rules; an edit made elsewhere can require a refresh before
you save.

To assign a model found in **All models** to a role, open the model's row menu
and choose **Assign to role**. The assignment uses the environment, project and
global/project scope currently selected in Models.

Provider login, API keys and saved-account removal are handled by NeoPi.
NeoCode does not keep another credential vault. **Use this account** activates
an OAuth account for the connected session; it is unavailable without that
connection and does not apply to API keys. Models requires a native executable
advertising the Models configuration contract; an older executable shows an
update error rather than pretending a save worked.

The composer model picker searches through NeoPi's native selector, using the
connected thread's enabled model scope or the selected project's configuration.
Native order and role aliases are preserved. The context column shows the
effective context budget; missing facts show Unknown. Searching requires a
native executable advertising `model_selector`. Query errors are shown in the
picker instead of falling back to a different search.

## Command line

For the fork's standalone server, download the matching `t3-…-linux-x64.tar.gz`
or `t3-…-win32-x64.zip` from the same
[NeoCode release](https://github.com/PsychedelicShayna/neocode/releases).
Extract the whole archive and keep `client/`, `node_modules/` and
`resource-monitor/` alongside `t3` (`t3.exe` on Windows). These are NeoCode
archives even though the executable keeps its compatibility name.

Run `./t3` on Linux or `.\t3.exe` in Windows PowerShell from the extracted
directory to start the server and open the web app. Use `./t3 serve` or
`.\t3.exe serve` to start without opening a browser. Add that directory to your
`PATH` if you want to use `t3` from another folder. Run `t3 --help` for the full
reference.

The upstream `t3.codes` install scripts, `npx t3`, Winget, Homebrew and AUR
packages fetch upstream T3 Code, not NeoCode. Do not use them to install or
update this fork.

## Desktop integration

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

## Mobile

The NeoCode fork does not currently publish mobile store builds. Upstream
[T3 Code for iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824)
and [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)
are upstream products, not NeoCode downloads. Source mobile setup is described
in the [mobile README](../../apps/mobile/README.md).

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## NeoPi

Open **Settings → NeoCore** in the web or desktop app to enable NeoPi and configure
its executable, profile and environment. These controls remain available even
when the Models page cannot read the native catalog.

1. Download NeoPi for the machine that runs your sessions from
   [NeoPi releases](https://github.com/PsychedelicShayna/neopi/releases), following
   that release's installation instructions. Extract an archive before selecting
   the executable; **Binary path** needs the actual `npi` executable, not its
   download archive or the NeoCode AppImage.
2. Make `npi` available on that machine's `PATH`, or enter its full executable
   path in **Settings → NeoCore → Binary path**. On Linux, an unpacked executable
   may need `chmod +x /path/to/npi`. A GUI launched from the desktop can have a
   different `PATH` from your terminal; use the full path if discovery cannot
   find it. For WSL, install and select the executable inside the chosen distro.
3. Select **Profile** if you use an `OMP_PROFILE`, then open **Models** to
   configure NeoPi's inference providers and model roles.

Ordinary fork release builds do not bundle NeoPi. A Linux build explicitly
distributed as NeoPi-enabled can include it at `resources/bin/npi` inside the
application. NeoCode discovers that copy automatically; do not copy an
AppImage's temporary mount path into **Binary path**. Such a build also runs its
bundled terminal agent with `./NeoCode-<version>-x86_64.AppImage --npi --help`
(replace the filename with that build's exact name). The NeoCode `t3` server
archive is not a NeoPi executable.

Use **Settings → Models** to inspect native inference providers, authentication,
models and roles. Catalog limits that NeoPi does not know are shown as **Unknown**;
they do not prevent opening the page or choosing an otherwise available model.

NeoCode runs only NeoPi. OpenAI Codex, Anthropic, Cursor, and other inference
providers exposed by NeoPi remain available. They are model backends, not separate
NeoCode agent runtimes.

Saved conversations from other runtimes remain in the database and can still be
read, renamed, or archived. Their history is read-only and cannot be resumed as a
NeoPi session. New threads ignore obsolete runtime defaults and use an available
NeoPi instance without changing the old conversations.

Setup does not scan or import Claude Code or Codex projects. Add a project folder
explicitly from the workspace, or use **Resume NeoPi session** for native history.

NeoPi automatically checks `npi`, then `npi-nightly`, the desktop app's bundled
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

Use **Models** to manage NeoPi's inference-provider accounts and scoped model
choices. Login and cancellation are handled by the selected native connection.
Cancelling a login does not undo an account save that already completed; native
failures remain visible so you can retry from Models. API-key and local models
can work even when authentication is reported as unknown.

**New thread** creates a session directly in NeoPi. You do not need to add a
project or initialize a repository first. The session uses NeoPi's normal session
folders and can also be opened with `npi --resume`.

To continue a terminal session in NeoCode, use **Resume NeoPi session** in the
sidebar or command palette. Discovery reads the enabled NeoPi instances without
starting their sessions. Each result keeps its configured profile and native
file identity. If one instance cannot load its catalog, its error remains visible
while sessions from healthy instances stay available.
Return to the NeoCode window or reopen the session browser to refresh the list
after starting a session in another terminal.

Opening a session reads its native journal; it does not import a second
conversation into NeoCode's database. Windows on the same server share the
connection to that file. Closing a window does not stop its running turn.
When a terminal already owns the session, NeoCode attaches through its control
connection rather than starting a second writer. Disconnecting that attachment
leaves the terminal running.
After **Disconnect**, select the same session again to reconnect. If observing a
session fails while the environment is still connected, switch away and reopen
that session to resume its updates. Switching to another thread without
disconnecting keeps a healthy session's updates flowing in the background.

If graphical browser or device tools are unavailable in a terminal session that
was already running before a NeoPi update, reopen that session in the updated
terminal runtime. Installing a new binary does not update an existing process.

The conversation follows NeoPi's selected branch, including turns started from
the terminal. While reconnecting, NeoCode retains the displayed conversation and
requests a fresh native snapshot without resending your prompt.
Only requests still pending in NeoPi are shown after reconnect; approvals and
input requests answered in another window are not shown again.
Sending a prompt brings the latest content into view. Scrolling back through
older history stops automatic following until you send again.

You can attach images and files to native messages without creating a project.
Images reach NeoPi as image input; files remain available to the session after
the upload draft is cleared. If a send fails, keep the draft and retry rather
than uploading the same files again.
After acceptance, matching drafts in other open windows are cleared too. Text,
context and attachments added while the send is pending remain in the composer.

Commands such as `/usage`, `/context`, and `/model` show NeoPi's preformatted
report in the conversation, preserving its spacing and colors without leaving
your session. These results stay in the open client's conversation view through
reconnects; they are not added to the session's saved journal.

For a native session working in a Git repository, **Diff** shows working-tree
changes in that session's folder, even when it is outside the folder where
NeoCode started. Native sessions do not create the turn snapshots used by
turn-based diffs.

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
start or restart a session. Use **Refresh** for role-definition changes. Enable
**Follow model changes** to refresh when NeoPi reports model or effort changes.
Browsing role fallbacks does not pause following; closing the inspector or
turning following off stops updates.

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
Upgrade the NeoPi executable separately; Models manages provider sign-in through it.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating NeoCode](./updating.md): update the app and connected servers.
