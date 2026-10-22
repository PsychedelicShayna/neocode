# NeoCode mobile

NeoCode uses the existing T3 Code mobile application with fork-owned package IDs.
Android distribution is a signed, self-contained APK installed with ADB. It does not use
the upstream Play Store listing or Expo OTA project.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

The three variants can coexist with each other and with upstream T3 Code:

| Variant       | Application ID                                | URL scheme        |
| ------------- | --------------------------------------------- | ----------------- |
| `development` | `io.github.psychedelicshayna.neocode.dev`     | `neocode-dev`     |
| `preview`     | `io.github.psychedelicshayna.neocode.preview` | `neocode-preview` |
| `production`  | `io.github.psychedelicshayna.neocode`         | `neocode`         |

The iOS bundle IDs use the same values unless a Personal Team build explicitly overrides
its identifier. No upstream Apple team, associated domain, EAS owner, project ID, channel
or store submission target is configured. Expo updates are disabled for every variant,
even if an old environment sets `T3CODE_MOBILE_UPDATES_ENABLED=1`.

Run commands from `apps/mobile`.

T3 Connect is optional and disabled in a fresh clone. Public configuration belongs in the
repository-root `.env` or `.env.local`, not an `apps/mobile/.env` file. See
[`../../.env.example`](../../.env.example).

## Development

For simulator/emulator development, select and boot a device, then ensure its native client matches
this checkout before starting Metro:

```bash
node ../../scripts/mobile-native-client.ts ensure ios <simulator-udid>
# Or: node ../../scripts/mobile-native-client.ts ensure android <emulator-serial>
vp run dev:client
```

The helper compares a local Expo fingerprint and the installed binary with its last successful
build record. It builds and installs missing, stale, or unverified clients and reuses matching ones.
Use `check` instead of `ensure` for a read-only decision: exit 0 means compatible, 2 means a build is
needed, and 1 means an operational error. Run it on the simulator host; no EAS login is required.
An externally installed client is unverified until the helper builds it once.

Start Metro for an already verified dev client:

```bash
vp run dev:client
```

Metro keeps its transform cache between ordinary starts. If the cache itself is causing stale or
invalid output, clear it for one development-client start:

```bash
vp run dev:client:reset
```

Run that reset once after installing or changing the Uniwind dependency patch. Cached transforms
can otherwise reference its previous pnpm package path. Ordinary Metro starts still keep the cache.

Component edits use Fast Refresh. See [mobile development lifecycle](../../docs/internals/mobile-development.md)
before changing runtime ownership or refresh behavior.

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

After changing a native dependency patch, rerun CocoaPods before rebuilding an existing iOS
project. pnpm gives each patch hash a new package path; Pods can otherwise keep compiling the
previous directory.

If your Xcode account only has a Personal Team, use a bundle identifier you control and opt into the
reduced-capability local build. Personal Team builds omit the widget and share extensions, push
entitlement, and native Sign in with Apple entitlement; builds without this opt-in are unchanged.

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.dev \
vp run ios:dev
```

Build and install a self-contained Release app that does not need Metro:

```bash
vp run ios:release
```

The Personal Team equivalent also needs a unique bundle identifier:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code \
vp run ios:release
```

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Force the review diff highlighter engine:

```bash
EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=javascript vp run ios:dev
```

`javascript` is the default and recommended setting for the review diff screen. Set `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=native` only when you explicitly want to test the native Shiki engine.

Inspect the resolved Expo config for a variant:

```bash
vp run config:dev
vp run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## Android APK and ADB

Use Node 24.13.1 or newer within Node 24, the repository's `vp` CLI and installed workspace
dependencies from `vp i`. The lockfile currently selects Expo 57 and React Native 0.86.3.
Native compilation requires JDK 17, Android SDK platform 36, build-tools 36.0.0,
NDK 27.1.12297006 and CMake, with ReactAndroid requesting 3.30.5. Set `JAVA_HOME` and
`ANDROID_HOME` explicitly. The checked-in
Gradle wrapper downloads its pinned Gradle version if needed. The APK script does not
install JS dependencies, SDK packages globally, or anything on a device.

Metro bundles the shared workspace packages from TypeScript source. Relative imports
in those packages must use the source file extension, not an emitted `.js` path.

The Shiki native dependency links its packaged Android ABI library. A host
`libonig.so` is not an Android build prerequisite and must not enter the APK link.

Keep a dedicated release keystore outside the checkout and back it up. All future APK
updates must use that same signing key. To create one once:

```bash
mkdir -p "$HOME/.local/share/neocode-signing"
keytool -genkeypair -keystore "$HOME/.local/share/neocode-signing/release.jks" \
  -alias neocode -keyalg RSA -keysize 4096 -validity 10000
```

From the repository root, set these variables in a private shell. Do not put passwords
in command arguments, source control or a PR:

```bash
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME="$HOME/Android/Sdk"
export NEOCODE_ANDROID_KEYSTORE="$HOME/.local/share/neocode-signing/release.jks"
export NEOCODE_ANDROID_KEY_ALIAS=neocode
read -rs -p 'Keystore password: ' NEOCODE_ANDROID_STORE_PASSWORD; echo
export NEOCODE_ANDROID_STORE_PASSWORD
read -rs -p 'Key password: ' NEOCODE_ANDROID_KEY_PASSWORD; echo
export NEOCODE_ANDROID_KEY_PASSWORD
node scripts/build-mobile-apk.mjs --version-code 1 \
  --output "$HOME/.cache/neocode-apk/neocode-1.apk"
```

The script regenerates only the ignored `apps/mobile/android` directory, bundles the JS
into a Release APK, signs it with the supplied key, verifies the signature with
`apksigner`, and writes an adjacent SHA-256 file. It refuses tracked native files and
missing signing credentials. It does not fall back to Expo's debug release key.
No Metro, EAS login or store account is needed. This is a reproducible build procedure,
not a promise that separate builds produce byte-identical APKs.

The default APK includes arm64-v8a, armeabi-v7a and x86_64. For a known arm64 device,
add `--architectures arm64-v8a`. Android 7/API 24 is the minimum. Run builds through the
workspace's polite relay and exclusive heavy lock on the owner's machine.

Only after the owner identifies and authorizes the target:

```bash
adb devices -l
adb -s <authorized-serial> install -r "$HOME/.cache/neocode-apk/neocode-1.apk"
adb -s <authorized-serial> shell am start -a android.intent.action.VIEW \
  -d 'neocode://' io.github.psychedelicshayna.neocode
```

For the next APK, increase `--version-code`, keep the same application ID and signing
key, then use `install -r` again. This preserves NeoCode's app-private connection catalog,
credentials, preferences and drafts. A signing mismatch is an error to resolve with the
original key, not a reason to uninstall or clear data. Never uninstall upstream T3 Code.

### Pairing and preserving existing connections

The new package has a separate Android sandbox. Upstream connections and private data stay
where they are; they do not migrate automatically. Do not use `pm clear`, uninstall,
copy private app databases, or assume Android backup bridges these packages.

Keep upstream installed. In NeoCode, open Settings, Connections, Add environment and
scan or paste a fresh pairing URL issued by the same server. Re-enter the existing
direct/tailnet server URL and display label intentionally. For relay connections,
the deployment needs its own configured relay and authentication credentials.
Never copy a consumed pairing token or a refresh token between application sandboxes.
Threads, projects and native NeoPi journals remain on the connected environment, not
in the APK. Re-pairing to that environment restores their visibility without replacing them.

For an explicit pairing-link import, the QR/paste flow understands both `neocode://`
and upstream `t3code://` wrappers carrying `pairingUrl`. NeoCode registers only its own
URL schemes, so upstream links still open upstream rather than being hijacked.

### Native runtime compatibility and proof

Settings, Connections, the environment detail page has Resume NeoPi session. Discovery
includes all native project folders and shows terminal ownership and attachability.
At least one project must exist in that environment to supply discovery context.
The server resolves the selected session's real cwd and project when resuming; mobile
does not move a session into that context project.

Open Models from Home, Settings, the thread sidebar, or a chat's session-configuration panel.
The page uses NeoPi's native model catalog and role definitions. It supports global
and project-scoped role assignments, fixed/inherited/automatic effort, ordered effort
rules, provider API keys, native login prompts and account removal. NeoPi resolves
selectors and rejects conflicting edits; mobile does not run a second model resolver.
The chat's configuration panel remains a read-only snapshot with explicit Refresh.

The main conversation reads the canonical native branch, including history before
compaction or context resets. Use Load older native entries to page backward. Session
tree inspects the complete append-only journal across branches; load older journal
pages to reach earlier forks. Messages, reasoning, tool payloads, images, summaries,
reset markers and unknown native records remain inspectable.

Navigate from an entry to restore a user draft or select another branch without
deleting its future. Summary instructions and reopened ask answers stay with that
native file. Saving a replacement answer does not immediately continue the agent:
review the rebuilt branch, then acknowledge Resume. Starting a stopped native owner
for navigation requires the separate explicit action. Unsent local drafts survive
file switches; a pre-attachment draft retained beside an existing native draft has
its own restore action.

Unavailable features, server errors, native stream gaps and discovery diagnostics
are displayed, never treated as successful empty history. Local outbox messages are
marked separately from native history.

Usage, NeoPi stats opens the actual native stats document for the chosen environment
and NeoPi runtime. NeoPi owns its session analysis, traces, indexing and errors.
Mobile does not recalculate or combine its statistics. The Limits tab keeps live quota
pools, reset actions, environment filtering and pull-to-refresh.

Native stats requires the compatible server's authenticated `/api/neopi-stats` routes
and NeoPi's hosted stats support. A missing capability or disconnected environment is an
explicit error, never a fallback to the old transcript-derived Usage page. Requests use
the existing cookie/bearer/DPoP connection transport. Credentials do not enter the WebView.
Expo's streaming fetch carries live updates and trace bodies; document MessagePorts
cross the native boundary through a local adapter with the shared path allowlist,
backpressure and cancellation. Closing the view releases its server-owned stats process.

This client requires a compatible NeoCode server with the native session journal,
live conversation, tree-navigation and Models contracts, plus a NeoPi runtime
implementing those capabilities. It is not a client for arbitrary upstream server
versions. Terminal handoff has no mobile control; use NeoPi on the host for that
action. iOS widgets and native header chrome are not Android features. Android uses
its existing Material controls.

The screens patch targets 4.26.2. Its Kotlin managers implement the generated setters
for `subtitle`, `largeSubtitle`, `navigationItemStyle`, `headerCenterBarButtonItems`,
`headerToolbarItems` and header-subview `identifier`. These props describe iOS chrome,
not Android functionality. Android logs unsupported supplied values instead of silently
discarding them. Older 4.25.2 patch instructions about missing setters are obsolete.
Do not reuse an old `node_modules` tree after the patch hash changes.

Source changes are not device proof. Before accepting #145, retain the signed APK and
checksum, record its signing certificate and ABI, install it on the authorized target,
and capture startup, pairing, existing-project visibility, native discovery/resume,
Models edits and login cancellation, live native history, branch navigation and
re-answer acknowledgement, native stats and traces, disconnect/error handling, quota
limits and an in-place update with connections intact.
Record the tested NeoCode commit and NeoPi version. Neither a successful compile nor
an emulator-only screenshot establishes physical-device compatibility.

## EAS

The optional EAS profiles build internal binaries without upstream channels or submission
targets. Local APK builds above are the supported sideload path. EAS will require a newly
created, maintainer-owned project before use; no project ID or owner is invented here.
Do not run inherited mobile production/OTA workflows against upstream credentials.
Enabling OTA distribution later requires an explicit fork-owned update service and a
native rebuild. This client never downloads upstream replacement bundles.
