# NeoCode

NeoCode is NeoPi's graphical frontend, built from upstream [T3 Code](https://github.com/pingdotgg/t3code). NeoPi owns execution, sessions and harness configuration. Models and inference providers come from the connected NeoPi runtime.

Saved conversations from retired harnesses remain readable. New work runs through NeoPi.

## Installation

Download the desktop app from [NeoCode releases](https://github.com/PsychedelicShayna/neocode/releases).
Choose a stable release, or a **Pre-release** if you want nightly builds. The fork
currently publishes Linux x64 AppImage/`.deb` and unsigned Windows x64 installers;
upstream T3 Code installers, npm packages and package-manager entries are not NeoCode.

On Linux, download the `NeoCode-…-x86_64.AppImage` asset, open a terminal in its
download folder, and use its exact filename in both commands:

```bash
chmod +x ./NeoCode-<version>-x86_64.AppImage
./NeoCode-<version>-x86_64.AppImage
```

Replace `<version>` with the downloaded release's full version. Debian/Ubuntu
users can install that release's `.deb` with `sudo apt install ./NeoCode-<version>-amd64.deb`.
On Windows, use the release's `NeoCode-…-x64.exe`; it is unsigned, so review the
download source and security warning before deciding whether to run it.

Then follow [Install and first run](docs/user/install.md#neopi) to download NeoPi
and select its executable in **Settings → NeoCore**. Ordinary fork releases do not
bundle NeoPi; a separately labeled NeoPi-enabled Linux build can. Models and
provider authentication are managed through NeoPi. For a source checkout, use the
[development guide](docs/operations/development.md).

## Upstream

T3 Code provides the foundation for the web, desktop and mobile clients. Its
authors retain their copyright and attribution; NeoCode develops as a distinct
open-source project centered on NeoPi.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- [NeoPi setup and profiles](./docs/user/install.md#neopi)
- [Run the server as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

NeoCode uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

File NeoCode bugs and feature requests in [this fork's issue tracker](https://github.com/PsychedelicShayna/neocode/issues).
