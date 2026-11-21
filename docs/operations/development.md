# Development

## First checkout

Install `vp` using the [root README](../../README.md#install-vp). The checkout requires Node 24;
Bun is optional. From the repository root:

```sh
vp i
vp run dev
```

Open the pairing URL printed by the dev runner. The bare origin does not authenticate
a new browser.

Prefer a container? See [Dev container](../internals/devcontainer.md) for VS Code and Codespaces setup.

## Choosing a dev process

Use `vp run dev` for server and web, or `vp run dev:desktop` for the Electron client.
`dev:server` and `dev:web` start those processes separately.
See the [mobile README](../../apps/mobile/README.md) for native builds and Metro.

Flags go directly after the task name, for example `vp run dev --home-dir /tmp/t3code-dev`.
Add `--browser` to open a browser automatically.

### State and ports

Linked worktrees default to their own `.t3/userdata`, even when `T3CODE_HOME` is set.
The main checkout defaults to `~/.t3/dev/userdata`. An explicit `--home-dir` wins in both cases.
Never run a development server against the live `~/.t3/userdata`.
See [test data](../../AGENTS.md#test-data) for copying a consistent database snapshot.

Read ports from the `[dev-runner]` output. Worktrees derive stable preferences from their paths,
but occupied ports can shift them. `T3CODE_PORT_OFFSET` or `T3CODE_DEV_INSTANCE` can select a
different preference when needed.

### Host native sessions in tmux

Set `T3CODE_NEOPI_TMUX=1` in the **NeoCode server's** environment and restart
NeoCode. This is off by default and requires Linux, `tmux` on the server's
`PATH`, and NeoPi with control enabled and exact-file lease queries.

When you start a new native session or open an existing one without a live
owner, NeoCode starts its NeoPi TUI on a private tmux socket in the NeoCode
state directory. NeoCode proceeds only if NeoPi attests that the exact pane
process owns the session file lease, including before the first turn is written.
Open **TUI** to see the same owner. Closing the view or restarting NeoCode
does not stop the owner; reopening the session reconnects without starting another.
In the **Agents** panel, select a subagent and choose **Monitor**, or choose
**Monitor** beside an advisor. This opens a separate tmux window in the
embedded terminal, without starting or replacing the session's NeoPi writer.
Subagents can receive chat through their owner; advisor monitors are view-only.
**Hide monitor** or leave the Agents panel to close the window and release its
connection. NeoPi admits up to 32 simultaneous monitor connections per owner,
including monitors opened outside NeoCode. At capacity the monitor reports
the refusal; close an existing monitor before opening another. The limit does
not restrict the number of agents that can run.

Turning the opt-in off leaves existing tmux owners running and ignores their
saved managed bindings. NeoCode uses ordinary native session discovery: it
attaches to a live owner through its control endpoint, or refuses the open if
the session is in use but cannot be attached. It does not start a replacement
while the session is in use. The managed **TUI** view is not available for
these owners while the opt-in is off.

If another writer holds the lease or NeoPi cannot attest the pane's lease,
NeoCode refuses the managed open. Update older NeoPi builds before enabling
this mode. Missing tmux or disabled control is also an error; NeoCode does not
fall back to a direct owner while the setting is on.

### Attach a prestarted NeoPi TUI

On a Unix host with `tmux` on the NeoCode server's `PATH`, opt in by setting the server's
`T3CODE_NEOPI_MANAGED_TMUX` to a JSON binding for one existing native session:

```json
{
  "providerInstanceId": "neopi",
  "sessionFile": "/absolute/path/to/session.jsonl",
  "socket": "/absolute/private/directory/neocode.sock",
  "session": "owner"
}
```

The dedicated socket must be in a directory owned by the server user and
inaccessible to other users. Start the owner with the same NeoPi profile and
control registry as the configured provider instance. Run NeoPi directly as the
only pane in the only window of the configured tmux session; do not leave a
wrapper process as the pane's PID. Leave control enabled. Set `exit-unattached
off`, `destroy-unattached off`, `allow-passthrough off`, `window-size latest`,
and `aggressive-resize off` in the dedicated tmux configuration.

Open the existing native session and select **TUI** at the far right of its
status bar. Closing the view detaches its tmux client, not the NeoPi owner.
Reopening NeoCode rechecks the same binding. The managed path reports an
unavailable or conflicting owner and never falls back to launching one.
For external recovery, link the window into a separate tmux session with
independent window selection and attach there with `-f ignore-size`; don't
attach directly to the embedded view's session.

### Sharing and remote debugging

`vp run dev --share` publishes the web port over the machine's tailnet and prints a pairing URL
for that origin. Give the tester the complete URL, including its token. The dev runner removes
its mapping on exit.

Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset. Vite proxies the backend through the browser's
origin so the same build works over localhost and remote connections.

Shared runs enable bundled dev to avoid a network round trip for each import level.
`T3CODE_BUNDLED_DEV=0` opts out when debugging bundler differences. Two reload traps matter
when changing this setup:

- The web entry must dynamically import the app so React refresh initializes before application
  chunks. Static imports can work on first load and fail after a route split.
- Bundled dev rebuilds Tailwind through watched files. Its ordinary Vite hot-update hook expects
  a server/module graph that Rolldown does not provide.

The workarounds live in the [web entry](../../apps/web/src/bootstrap.ts) and
[Tailwind plugin](../../apps/web/vite/tailwind.ts).

#### Reusable dev credential

Use this only on a hostname where you trust every service. Browsers send cookies to all ports
on that hostname. Any service you visit there can receive the reusable admin credential,
including services unrelated to T3 Code. If you run untrusted services on that hostname, keep
normal per-environment pairing instead.

To use one browser profile across web dev worktrees on the same hostname, generate one fixed
value once:

```sh
openssl rand -hex 32
```

Put that value in the main checkout's gitignored `.env`:

```dotenv
T3CODE_DEV_AUTH_TOKEN=<the value generated above>
```

The `t3.json` Setup Worktree action links that file to each worktree's `.env`. The dev runner reads repository env files at startup. `.env.local` and inherited process
environment values override `.env`, so no per-worktree export is needed after setup.

For a manual worktree or launcher without that link, export the same fixed value instead:

```sh
export T3CODE_DEV_AUTH_TOKEN="<the value generated above>"
```

Do not generate a new value at startup. Start or restart `vp run dev --share` after configuration,
then open its printed startup pairing URL once per browser profile on that hostname. Later web dev
servers on the same hostname accept the shared cookie across ports. The cookie expires after 30
days. Reload an old tab if its URL now serves a replacement environment.

The token and startup pairing URLs are reusable administrative secrets. Never put them in a
commit, pull request, or public output. Every server still seeds its own auth database record at
startup and keeps its own SQLite data, signing key, and revocation state. Desktop and non-dev
servers ignore the value. See [environment authentication](../internals/environment-auth.md#reusable-dev-credential)
for the security model.

## Running prebuilt desktop output from source

`vp run start:desktop` and `node apps/desktop/scripts/start-electron.mjs`
launch the checkout's existing application bundles. They prepare the native
browser-secret helper and Electron runtime, but do not rebuild the renderer,
server, desktop main process or preloads. Updating source alone leaves the
previous bundles in use.

With Node 24, workspace dependencies and a valid Electron runtime installed,
run this sequence from the checkout the source launcher actually targets:

```sh
vp run build:desktop
vp run start:desktop
```

On Linux, the browser-secret helper also requires a C compiler, `pkg-config`
and the libsecret development files. The full build runs web, server and
desktop in dependency order. It emits `apps/web/dist`, copies the renderer to
`apps/server/dist/client`, builds `apps/server/dist/bin.mjs`, and writes desktop
main, preload and companion bundles to `apps/desktop/dist-electron`.
Rebuild after changing source or build inputs. An unchanged build can be
launched again without rebuilding.

Check a desktop entry's `Exec` before choosing the checkout. An absolute source
launcher path still uses that checkout when another worktree has been rebuilt.
A packaged AppImage or extracted `AppRun` uses its installed release instead;
building source does not replace that installation. `vp run dev:desktop` is
the separate development/watch workflow.

For worktree diagnostics, launch that worktree's emitted output in the
[isolated verification environment](../../AGENTS.md#verifying), with private
Electron profile and T3 state. Source-production startup does not inherit the
dev runner's automatic per-worktree state isolation. Do not use the unchanged
normal desktop entry to test a different worktree.

The Linux `t3code:` URL handler belongs to the packaged installation. Ordinary
source startup leaves that association alone. To deliberately register source
output, pass `--register-url-handler` when invoking Electron with
`apps/desktop/dist-electron/main.cjs`; the registered command includes that
entrypoint. Verify the effective association with
`xdg-mime query default x-scheme-handler/t3code`, then dispatch a URL to check
the command too. A successful association query alone does not prove launch.

## Checks

Run checks for the files and packages you changed:

```sh
vp test run <files>
vp lint <files>
vp run --filter <package> typecheck
```

Use `vp run lint:mobile` for native mobile changes. CI owns the full suite; see
[ci.yml](../../.github/workflows/ci.yml) for its current jobs.
The [manual Windows lane](../../.github/workflows/windows-tests.yml) is available for focused
Windows investigation while that suite is not a required gate.

### Unused code

`vp run knip:check` checks unused files and dependencies across the repo, then
unused runtime exports in `apps/server`, `apps/desktop`, `apps/web`, and every internal package under
`packages/`. CI enforces both checks.
Exported types and Effect schemas are allowed without consumers. The schema preprocessor
recognizes schema types, including aliases and schema classes; functions that create or decode
schemas remain checked. Canonical Effect service construction APIs stay exported with an explicit
`@public` annotation, which Knip recognizes. Completely unused files remain checked too.
Named exports in web UI component modules are kept as complete component sets. Knip ignores
unused exports in `apps/web/src/components/ui/*.tsx`, while still reporting an entire unused file.
Use `vp run knip --workspace apps/web` to audit one workspace, including exports,
or `vp run knip:production --workspace apps/web` to find code kept alive only by tests.
The full export audit still has findings and is not a repo-wide CI gate. Extend the
export check's workspace selectors as more workspaces become clean. Review callers before
deleting code; production mode can also report development scripts and test fixtures.
Runtime-discovered entrypoints and dependency exceptions belong in [knip.jsonc](../../knip.jsonc).

## Desktop artifacts

Local artifact builds are unsigned by default and write to `release/`:

```sh
vp run dist:desktop:dmg
vp run dist:desktop:linux
vp run dist:desktop:win
```

DMGs default to the host architecture. Use `--arch` to choose another target and `--keep-stage`
to retain packaging files for inspection. Run `vp run dist:desktop:artifact --help` for other
options.

### Diagnostic desktop launches

After building with `vp run build:desktop`, `vp run test:desktop-smoke` uses the
installed Electron runtime through the shared diagnostic process harness. GUI
verification follows [AGENTS.md's authorization boundaries](../../AGENTS.md#verifying). On Linux it requires installed `unshare`,
`dbus-run-session` and `xvfb-run`, with permission to create user/PID/mount namespaces;
it fails before launching the application if those namespaces are unavailable.
It does not download a runtime or register a URL handler.

The owned `test:desktop-smoke` launcher supplies `T3CODE_DESKTOP_SMOKE_ROOT` and a
complete isolated environment. Desktop startup preserves that environment without
running shell profiles, `launchctl` or PowerShell probes, or rediscovering a live
session bus. A private `HOME` alone cannot prevent system profiles from running.
Do not use this context on ordinary desktop launches: they still need normal
environment hydration. The context skips hydration; it does not create a sandbox.

Every invocation owns its profile, state and process identities. Full output and
process-inspection logs remain at the printed paths. State is removed only after
verified teardown and a clear mount inspection. If either cannot be verified, state
is retained for diagnosis; the harness never automatically unmounts anything.

The selected cleanup policy is conservative: terminate diagnostic descendants,
including those that detach from the launch process group. Linux runs the private
bus, display and application in a PID namespace; terminating its init kills even
unobserved detached descendants. Windows uses non-breakaway, kill-on-close Job
Objects. POSIX group signals remain creation-identity checked. macOS has no kernel
descendant container in this harness: discovery failure can leave unobserved
detached descendants, so cleanup reports failure, retains state and requires owner
recovery rather than claiming complete containment.

The explicit owner proof driver is
`node apps/desktop/scripts/isolated-gui-process.proof.mjs --case real`.
Its fault cases exercise the same lifecycle, not a separate cleanup implementation.
These GUI cases are deliberately excluded from automatic test discovery.
Knip registers the driver and its filename-loaded fixture/preload hook as explicit
desktop entrypoints. That metadata does not run these GUI cases automatically or
exempt them from static analysis.

### Linux AppImage prerequisites

Build on Linux because the browser-secret helper links against the host's libsecret. Install
Rust, C/C++ build tools, libsecret development headers, pkg-config, and ImageMagick.

Ubuntu and Debian:

```sh
sudo apt-get update
sudo apt-get install cargo rustc build-essential libsecret-1-dev pkg-config imagemagick
```

Fedora:

```sh
sudo dnf install rust cargo gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick
```

Arch Linux:

```sh
sudo pacman -S rust base-devel libsecret pkgconf imagemagick
```

The C toolchain, pkg-config, and libsecret headers are also needed for Linux desktop development.

### macOS DMG prerequisites

Install the Xcode Command Line Tools with `xcode-select --install` and install Rust.
For a cross-architecture or universal build, add the requested Rust targets:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### Windows installer prerequisites

Install Rust, Python 3, and Visual Studio Build Tools with **Desktop development with C++**.
Include the Windows SDK and the MSVC build tools and Spectre-mitigated libraries for the target
architecture. Add its Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc
# For an ARM64 installer:
rustup target add aarch64-pc-windows-msvc
```

NSIS is downloaded by electron-builder. WSL support additionally needs the Linux CLI archive
passed as `--wsl-runtime`; see the
[release runbook](./release.md#windows-payload-topology-and-update-validation).

### Signing and passkeys

Add `--signed` after configuring the platform credentials in the
[release runbook](./release.md). macOS passkeys need a signed, provisioned app; follow the
[Connect setup](./connect-setup.md#desktop-passkeys) for local signing and renderer HMR.
