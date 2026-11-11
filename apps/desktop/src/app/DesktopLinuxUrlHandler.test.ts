import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLinuxUrlHandler from "./DesktopLinuxUrlHandler.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import {
  resolveDesktopUrlRegistration,
  renderUrlHandlerDesktopEntry,
} from "./DesktopUrlRegistration.ts";

const makeFixture = (
  input: {
    packaged?: boolean;
    explicit?: boolean;
    development?: boolean;
    existing?: string;
    configuredDefault?: string;
    failWrite?: boolean;
    defaultExit?: number;
  } = {},
) => {
  const files: Array<{ path: string; content: string }> = [];
  const directories: string[] = [];
  const commands: Array<{ command: string; args: readonly string[] }> = [];
  const registration = resolveDesktopUrlRegistration({
    platform: "linux",
    isPackaged: input.packaged ?? true,
    explicitRegistration: input.explicit ?? false,
    isDevelopment: input.development ?? false,
    execPath: "/transient/.mount_neocode/electron",
    appPath: "/source/apps/desktop/dist-electron/main.cjs",
    appImagePath: "/Applications/Neo Code.AppImage",
  });
  const name = input.development
    ? "com.psychedelicshayna.NeoCode.Development.desktop"
    : "com.psychedelicshayna.NeoCode.desktop";
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    platform: "linux",
    isPackaged: input.packaged ?? true,
    displayName: "NeoCode",
    linuxApplicationsDir: "/xdg/applications",
    linuxDesktopEntryName: name,
    appDataDirectory: "/xdg-config",
    path: { join: (...parts: string[]) => parts.join("/") },
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
  const layer = DesktopLinuxUrlHandler.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(DesktopPreReadyPlatform.DesktopPreReadyElectronOptions, {
          linux: null,
          linuxPasswordStoreCommandLine: null,
          urlRegistration: registration,
        }),
        FileSystem.layerNoop({
          readFileString: (path) =>
            Effect.succeed(
              path.endsWith("mimeapps.list")
                ? (input.configuredDefault ?? "")
                : (input.existing ?? ""),
            ),
          makeDirectory: (path) =>
            Effect.sync(() => {
              directories.push(path);
            }),
          writeFileString: (path, content) =>
            input.failWrite
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "writeFileString",
                    pathOrDescriptor: path,
                    description: "read-only filesystem",
                  }),
                )
              : Effect.sync(() => {
                  files.push({ path, content });
                }),
        }),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const child = command as unknown as { command: string; args: readonly string[] };
            commands.push(child);
            return Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.defaultExit ?? 0)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: Stream.empty,
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            );
          }),
        ),
      ),
    ),
  );
  return {
    files,
    directories,
    commands,
    registration,
    run: Effect.gen(function* () {
      const handler = yield* DesktopLinuxUrlHandler.DesktopLinuxUrlHandler;
      yield* handler.register;
    }).pipe(Effect.provide(layer)),
  };
};

describe("DesktopLinuxUrlHandler", () => {
  it.effect("preserves installed metadata and defaults on ordinary source startup", () => {
    const fixture = makeFixture({ packaged: false, existing: "valid installed packaged owner" });
    return Effect.gen(function* () {
      yield* fixture.run;
      yield* fixture.run;
      assert.deepEqual(fixture.files, []);
      assert.deepEqual(fixture.directories, []);
      assert.deepEqual(fixture.commands, []);
    });
  });

  it.effect("registers the stable packaged command", () => {
    const fixture = makeFixture();
    return Effect.gen(function* () {
      yield* fixture.run;
      assert.equal(fixture.files[0]?.path, "/xdg/applications/com.psychedelicshayna.NeoCode.desktop");
      assert.include(fixture.files[0]?.content, '"/Applications/Neo Code.AppImage"');
      assert.notInclude(fixture.files[0]?.content, "/transient/");
      assert.deepEqual(
        fixture.commands.map(({ command }) => command),
        ["xdg-mime"],
      );
      assert.deepEqual(fixture.commands[0]?.args, [
        "default",
        "com.psychedelicshayna.NeoCode.desktop",
        "x-scheme-handler/t3code",
      ]);
    });
  });

  it.effect("keeps explicit development registration separate", () => {
    const fixture = makeFixture({ packaged: false, explicit: true, development: true });
    return Effect.gen(function* () {
      yield* fixture.run;
      assert.equal(
        fixture.files[0]?.path,
        "/xdg/applications/com.psychedelicshayna.NeoCode.Development.desktop",
      );
      assert.deepEqual(fixture.commands.at(-1)?.args, [
        "default",
        "com.psychedelicshayna.NeoCode.Development.desktop",
        "x-scheme-handler/t3code-dev",
      ]);
    });
  });

  it.effect("prepares only the separate development portal identity on normal dev startup", () => {
    const fixture = makeFixture({ packaged: false, development: true });
    return Effect.gen(function* () {
      yield* fixture.run;
      assert.equal(
        fixture.files[0]?.path,
        "/xdg/applications/com.psychedelicshayna.NeoCode.Development.desktop",
      );
      assert.include(fixture.files[0]?.content, "MimeType=x-scheme-handler/t3code-dev;");
      assert.deepEqual(fixture.commands, []);
    });
  });

  it.effect("does not rewrite unchanged pre-ready metadata or an existing default", () => {
    const seed = makeFixture();
    const fixture = makeFixture({
      configuredDefault:
        "[Default Applications]\nx-scheme-handler/t3code=com.psychedelicshayna.NeoCode.desktop;\n",
      existing: renderUrlHandlerDesktopEntry({
        displayName: "NeoCode",
        command: seed.registration.command,
        scheme: "t3code",
      }),
    });
    return Effect.gen(function* () {
      yield* fixture.run;
      assert.deepEqual(fixture.files, []);
      assert.deepEqual(fixture.directories, []);
      assert.deepEqual(fixture.commands, []);
    });
  });

  it.effect("keeps default and file errors nonfatal", () =>
    Effect.gen(function* () {
      yield* makeFixture({ defaultExit: 1 }).run;
      const write = makeFixture({ failWrite: true });
      yield* write.run;
      assert.deepEqual(write.commands, []);
    }),
  );
});
