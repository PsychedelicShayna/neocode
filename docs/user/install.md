# Install NeoCode

NeoCode runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

Download this fork from [NeoCode releases](https://github.com/PsychedelicShayna/neocode/releases).
For a source checkout, follow the [development guide](../operations/development.md).
The T3 Code installers and package-manager entries below install upstream T3 Code,
not NeoCode. Existing `t3` commands, data directories and deep links retain their names.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch NeoCode and configure providers afterwards. NeoPi is enabled by default;
explicit saved provider and model choices are preserved.

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
`npi` arguments). Authenticate with `npi` before using accounts that require it.

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

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install the provider CLIs inside that distro. T3 Code installs its own
server runtime there automatically; the first launch after an app update can
take longer.

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

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

Fresh installations enable only NeoPi and list it first. Enable other harnesses
in Settings when you want to use them. Existing enabled harnesses stay enabled,
including choices saved before provider toggles were written explicitly.
New threads prefer a ready NeoPi instance when no saved provider/model choice
applies; an enabled, ready alternative remains available when NeoPi is not usable.
Project defaults and saved selections are preserved.

| Provider    | Install and authenticate                                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.                                                                       |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                                |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                       |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                          |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                    |
| NeoPi       | On Linux, the NeoPi-enabled AppImage includes `npi`; elsewhere install the NeoPi `npi` CLI or a compatible `omp` CLI. Configure authentication in that CLI. |
| Antigravity | Install and sign in with Google from T3 Code's provider settings.                                                                                           |

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

If the session is still open in a terminal, NeoCode attaches to that terminal's
process instead of opening a second writer: messages you send from NeoCode run
there. Turns started directly in the terminal are not mirrored live; close the
terminal session and reopen its bound row to restore them. While attached, use
the terminal to change modes, model settings, or compact history; NeoCode cannot
change those owner-controlled settings.

To inspect the connected session's model and role configuration, open **NeoPi
session configuration** in the thread header. It shows the native session
identity, ownership, current model and effort, and NeoPi's configured role
fallbacks and resolutions. This view is read-only. Use **Refresh** for a new
snapshot, or enable **Follow model changes** to refresh when NeoPi reports model
or effort changes. Following stops when you close the inspector or turn it off.
Role-definition changes may still need Refresh. Opening the inspector does not
start a stopped session or change the terminal's settings.

Open the right panel and choose **Native history**, either in its launcher or
the **+** menu, to inspect a NeoPi thread's canonical journal. **Active branch**
reads the branch selected by NeoPi when the snapshot starts. **Whole journal**
includes alternate branches. Select
an entry to inspect its content, native ID and parent. Compaction, context-reset
and branch-summary records remain visible. Tools and system-event filters change
only what the panel shows.

Use **Load older entries** to page through the complete snapshot, including
history beyond the chat import's limits. **Refresh snapshot** starts a new read.
The panel does not follow live changes. If the active branch changes during
paging, NeoCode discards the old snapshot and asks you to refresh rather than
mixing branches.

This view is read-only. It does not start a stopped agent, change model settings,
move NeoPi's active leaf or replace the main chat's imported transcript. Live
sessions are read through their existing owner; stopped sessions use NeoPi's
read-only journal command. The configured NeoPi must advertise `session_journal`.
Unknown entry and content types remain available as canonical JSON. Native
images, text, reasoning, tool calls and results use their recorded content;
extension-specific media without a recognized native format can be inspected in
JSON rather than being silently removed.

To go the other way, use **Continue in terminal** in a NeoPi thread's header:
NeoCode stops its NeoPi process and copies the command that reopens the same
native session in `npi`. If the terminal still owns the session, NeoCode only
detaches and explains which process keeps it open instead of offering a resume
command. After terminal continuation, close that session and use **Resume NeoPi
session** again to return to the same NeoCode thread with its new turns.

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

Other provider CLIs must be on the server's `PATH`. If T3 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Antigravity can use its managed runtime without a `PATH` entry.

T3 Code warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when T3 Code can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, T3 Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating T3 Code](./updating.md): update the app and connected servers.
