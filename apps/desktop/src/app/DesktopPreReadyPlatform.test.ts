import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const {
  appendSwitchMock,
  getSwitchValueMock,
  hasSwitchMock,
  registerSchemesMock,
  setDesktopNameMock,
  mkdirSyncMock,
  writeFileSyncMock,
  copyFileSyncMock,
  execFileSyncMock,
  readFileSyncMock,
  appState,
} = vi.hoisted(() => ({
  appendSwitchMock: vi.fn(),
  getSwitchValueMock: vi.fn(),
  hasSwitchMock: vi.fn(),
  registerSchemesMock: vi.fn(),
  setDesktopNameMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  copyFileSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  appState: { isPackaged: true },
}));

vi.mock("electron", () => ({
  app: {
    setDesktopName: setDesktopNameMock,
    getVersion: () => "0.0.37",
    getAppPath: () => "/source/apps/desktop/dist-electron/main.cjs",
    get isPackaged() {
      return appState.isPackaged;
    },
    commandLine: {
      appendSwitch: appendSwitchMock,
      getSwitchValue: getSwitchValueMock,
      hasSwitch: hasSwitchMock,
    },
  },
  protocol: {
    registerSchemesAsPrivileged: registerSchemesMock,
  },
}));

vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  copyFileSync: copyFileSyncMock,
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import { escapeDesktopEntryExecArgument } from "./DesktopUrlRegistration.ts";

describe("DesktopPreReadyPlatform", () => {
  beforeEach(() => {
    appendSwitchMock.mockReset();
    getSwitchValueMock.mockReset();
    hasSwitchMock.mockReset();
    registerSchemesMock.mockReset();
    setDesktopNameMock.mockReset();
    mkdirSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    copyFileSyncMock.mockReset();
    execFileSyncMock.mockReset();
    readFileSyncMock.mockReset().mockReturnValue("{}");
    appState.isPackaged = true;
  });

  it.effect("preserves an explicit Linux password-store switch", () => {
    hasSwitchMock.mockImplementation((name) => name === "password-store");
    getSwitchValueMock.mockReturnValue(" basic ");
    return Effect.gen(function* () {
      const options = yield* DesktopPreReadyPlatform.DesktopPreReadyElectronOptions;
      assert.equal(options.linuxPasswordStoreCommandLine, "basic");
      assert.isFalse(appendSwitchMock.mock.calls.some(([name]) => name === "password-store"));
    }).pipe(
      Effect.provide(
        DesktopPreReadyPlatform.layer.pipe(
          Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
          Layer.provide(DesktopConfig.layerTest({})),
        ),
      ),
    );
  });

  it.effect("persists Linux scaling synchronously across relaunches and settings rewrites", () => {
    vi.stubEnv("T3CODE_HOME", "/isolated");
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    const settingsPath = "/isolated/userdata/desktop-settings.json";
    const files = new Map([[settingsPath, "{}"]]);
    const commandLine = new Map<string, string>();
    readFileSyncMock.mockImplementation((path: string) => {
      const contents = files.get(path);
      if (contents === undefined) throw new Error("ENOENT");
      return contents;
    });
    writeFileSyncMock.mockImplementation((path: string, contents: string) => {
      files.set(path, contents);
    });
    hasSwitchMock.mockImplementation((name: string) => commandLine.has(name));
    getSwitchValueMock.mockImplementation((name: string) => commandLine.get(name) ?? "");
    appendSwitchMock.mockImplementation((name: string, value: string) => {
      commandLine.set(name, value);
    });
    const launch = Effect.gen(function* () {
      const startup = Promise.resolve().then(() => commandLine.get("force-device-scale-factor"));
      yield* DesktopPreReadyPlatform.make;
      return yield* Effect.promise(() => startup);
    });

    return Effect.gen(function* () {
      for (const explicitScale of ["1.75", "1"]) {
        commandLine.clear();
        commandLine.set("force-device-scale-factor", explicitScale);
        appendSwitchMock.mockClear();
        assert.equal(yield* launch, explicitScale);
        assert.isFalse(
          appendSwitchMock.mock.calls.some(([name]) => name === "force-device-scale-factor"),
        );

        // The settings service discards fields it does not own when rewriting its document.
        files.set(settingsPath, JSON.stringify({ linuxPasswordStore: "basic" }));
        commandLine.clear();
        assert.equal(yield* launch, explicitScale);
      }
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  });

  it.effect.each([
    { previousEntry: undefined, label: "missing" },
    { previousEntry: 'Exec="/Applications/deleted-previous.AppImage" %U', label: "stale" },
  ])("prepares a $label Linux desktop entry before startup yields", ({ previousEntry }) => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    getSwitchValueMock.mockReturnValue("");
    let desktopName = "t3code.desktop";
    let desktopEntry = previousEntry;
    let iconInstalled = false;
    copyFileSyncMock.mockImplementation((_source: string, destination: string) => {
      iconInstalled = destination === "/xdg/icons/com.t3tools.T3Code.desktop.png";
    });
    setDesktopNameMock.mockImplementation((name: string) => {
      desktopName = name;
    });
    writeFileSyncMock.mockImplementation((path: string, contents: string) => {
      if (path === "/xdg/applications/com.t3tools.T3Code.desktop") desktopEntry = contents;
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const portalIdentity = Promise.resolve().then(() => ({
          desktopName,
          desktopEntry,
          iconInstalled,
        }));
        yield* Layer.build(
          DesktopPreReadyPlatform.layer.pipe(
            Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
            Layer.provide(
              DesktopConfig.layerTest({
                XDG_DATA_HOME: "/xdg",
                APPIMAGE: "/Applications/current.AppImage",
              }),
            ),
          ),
        );
        const identity = yield* Effect.promise(() => portalIdentity);
        assert.equal(identity.desktopName, "com.t3tools.T3Code.desktop");
        assert.include(identity.desktopEntry ?? "", "/Applications/current.AppImage %U");
        assert.include(identity.desktopEntry ?? "", "MimeType=x-scheme-handler/t3code;");
        assert.include(
          identity.desktopEntry ?? "",
          "Icon=/xdg/icons/com.t3tools.T3Code.desktop.png",
        );
        assert.isTrue(identity.iconInstalled);
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
  });

  it.effect("points the early portal entry at a configured distribution launcher", () => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    getSwitchValueMock.mockReturnValue("");

    return Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(
          DesktopPreReadyPlatform.layer.pipe(
            Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
            Layer.provide(
              DesktopConfig.layerTest({
                XDG_DATA_HOME: "/xdg",
                APPIMAGE: "/Applications/current.AppImage",
                T3CODE_DESKTOP_LAUNCHER_PATH: " /opt/T3 Code/t3code ",
              }),
            ),
          ),
        );
        const entry = writeFileSyncMock.mock.calls.find(
          ([path]) => path === "/xdg/applications/com.t3tools.T3Code.desktop",
        )?.[1];
        assert.include(entry, '"/opt/T3 Code/t3code" %U');
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
  });

  it.effect("ordinary source startup leaves the installed handler untouched", () => {
    appState.isPackaged = false;
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    hasSwitchMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue('Exec=/usr/bin/env "/Applications/installed.AppImage" %U');
    return Effect.gen(function* () {
      yield* DesktopPreReadyPlatform.make;
      yield* DesktopPreReadyPlatform.make;
      assert.equal(writeFileSyncMock.mock.calls.length, 0);
      assert.equal(mkdirSyncMock.mock.calls.length, 0);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  });

  it.effect("explicit source registration writes the full app once", () => {
    appState.isPackaged = false;
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    hasSwitchMock.mockImplementation((name) => name === "register-url-handler");
    let entry = "";
    readFileSyncMock.mockImplementation((path: string) =>
      path.endsWith(".desktop") ? entry : "{}",
    );
    writeFileSyncMock.mockImplementation((_path: string, content: string) => {
      entry = content;
    });
    return Effect.gen(function* () {
      const options = yield* DesktopPreReadyPlatform.make;
      yield* DesktopPreReadyPlatform.make;
      assert.equal(writeFileSyncMock.mock.calls.length, 1);
      const appEntry = options.urlRegistration.command.at(-1)!;
      assert.notEqual(appEntry, "/source/apps/desktop/dist-electron/main.cjs");
      assert.include(entry, `${escapeDesktopEntryExecArgument(appEntry)} %U`);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
    );
  });
});
