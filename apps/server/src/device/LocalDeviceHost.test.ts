import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessIsExecutable,
} from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import * as LocalDeviceHost from "./LocalDeviceHost.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HttpClient } from "effect/unstable/http";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as NetService from "@t3tools/shared/Net";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";

const diagnose = (
  files: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = "darwin",
) =>
  LocalDeviceHost.__testing.platformReason("android").pipe(
    Effect.provideService(HostProcessEnvironment, environment),
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: (file) => Effect.succeed(files.includes(file)),
      }),
    ),
    Effect.provide(platform === "win32" ? NodePath.layerWin32 : NodePath.layerPosix),
  );

describe("Android SDK availability", () => {
  it.effect("explains that adb alone is insufficient to launch an emulator", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(["/sdk/platform-tools/adb"], { ANDROID_HOME: "/sdk" });
      expect(reason).toContain("Android Emulator is missing");
    }),
  );

  it.effect("identifies command-line tools required by the device hub", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(["/sdk/platform-tools/adb", "/sdk/emulator/emulator"], {
        ANDROID_HOME: "/sdk",
      });
      expect(reason).toContain("Command-line Tools (latest) are missing");
    }),
  );

  it.effect("explains how to upgrade legacy command-line tools in the standard macOS SDK", () =>
    Effect.gen(function* () {
      const root = "/test/home/Library/Android/sdk";
      const reason = yield* diagnose(
        [`${root}/platform-tools/adb`, `${root}/emulator/emulator`, `${root}/tools/bin/avdmanager`],
        { HOME: "/test/home" },
      );
      expect(reason).toContain("older, unsupported version");
      expect(reason).toContain(root);
      expect(reason).toContain(
        "Install Android SDK Command-line Tools (latest) in Android Studio's SDK Manager under SDK Tools.",
      );
    }),
  );

  it.effect("recognizes legacy command-line tools on Windows", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(
        [
          "C:\\Android\\Sdk\\platform-tools\\adb.exe",
          "C:\\Android\\Sdk\\emulator\\emulator.exe",
          "C:\\Android\\Sdk\\tools\\bin\\avdmanager.bat",
        ],
        { ANDROID_HOME: "C:\\Android\\Sdk" },
        "win32",
      );
      expect(reason).toContain("older, unsupported version");
    }),
  );

  it.effect("accepts the latest command-line tools when legacy tools are also installed", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(
        [
          "/sdk/platform-tools/adb",
          "/sdk/emulator/emulator",
          "/sdk/tools/bin/avdmanager",
          "/sdk/cmdline-tools/latest/bin/avdmanager",
        ],
        { ANDROID_HOME: "/sdk" },
      );
      expect(reason).toBeNull();
    }),
  );

  it.effect("discovers the standard macOS SDK without ANDROID_HOME", () =>
    Effect.gen(function* () {
      const root = "/test/home/Library/Android/sdk";
      const reason = yield* diagnose(
        [
          `${root}/platform-tools/adb`,
          `${root}/emulator/emulator`,
          `${root}/cmdline-tools/latest/bin/avdmanager`,
        ],
        { HOME: "/test/home" },
      );
      expect(reason).toBeNull();
    }),
  );

  it.effect("reports an absent SDK without running or installing tools", () =>
    Effect.gen(function* () {
      expect(yield* diagnose([], { HOME: "/test/home" })).toContain("Android SDK was not found");
    }),
  );
});

it.effect("puts detected Android tools on the helper PATH without losing existing commands", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const environment = LocalDeviceHost.__testing.deviceHostEnvironment(
      { PATH: "/usr/bin", HOME: "/test/home" },
      "/sdk",
      "darwin",
      path,
    );
    expect(environment.PATH).toBe("/sdk/platform-tools:/sdk/emulator:/usr/bin");
    expect(environment.ANDROID_HOME).toBe("/sdk");
    expect(environment.HOME).toBe("/test/home");
  }).pipe(Effect.provide(NodePath.layer)),
);

it.effect(
  "constructs and inspects an unconfigured host without installing or starting helpers",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-consent-" });
      const host = yield* LocalDeviceHost.make().pipe(
        Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
        Effect.provideService(HostProcessEnvironment, { HOME: baseDir, PATH: "" }),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.die(new Error("Host construction must not spawn processes")),
          ),
        ),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => Effect.die(new Error("Host construction must not run commands")),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Effect.die(new Error("Host construction must not make network requests")),
          ),
        ),
      );
      expect(yield* host.current).toBeNull();
      const error = yield* host
        .ensureReady(() => Effect.die("Must not install without Node"))
        .pipe(Effect.flip, Effect.provideService(HostProcessIsExecutable, true));
      expect(error.message).toContain("Local device support requires Node.js");
      expect(error.message).toContain("Install Node.js");
      yield* host.stop;
      expect(yield* fs.exists(`${baseDir}/tools`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("closes a provisional hub when readiness or post-ready setup is interrupted", () =>
  Effect.gen(function* () {
    for (const stage of ["readiness", "maintenance"]) {
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hub-ownership-" });
        const installDir = `${baseDir}/tools/expo-device-hub/${DEVICE_HUB_VERSION}`;
        const entryDir = `${installDir}/node_modules/expo-device-hub/dist/server`;
        yield* fs.makeDirectory(entryDir, { recursive: true });
        yield* fs.writeFileString(`${entryDir}/cli.mjs`, "");
        yield* fs.writeFileString(`${installDir}/.install-complete`, DEVICE_HUB_VERSION);
        const paused = yield* Deferred.make<void>();
        let children = 0;
        const host = yield* LocalDeviceHost.make().pipe(
          Effect.provide(
            Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer),
          ),
          Effect.provideService(HostProcessEnvironment, { HOME: baseDir, PATH: "" }),
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(HostProcessIsExecutable, false),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.gen(function* () {
                children++;
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    children--;
                  }),
                );
                return ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(123),
                  stdout: Stream.empty,
                  stderr: Stream.empty,
                  all: Stream.empty,
                  exitCode: Effect.never,
                  isRunning: Effect.succeed(true),
                  kill: () => Effect.void,
                  stdin: Sink.drain,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                  unref: Effect.succeed(Effect.void),
                });
              }),
            ),
          ),
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: () => Deferred.succeed(paused, undefined).pipe(Effect.andThen(Effect.never)),
          }),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              stage === "readiness"
                ? Deferred.succeed(paused, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok"))),
            ),
          ),
        );
        const startup = yield* host.ensureReady(() => Effect.void).pipe(Effect.forkChild);
        yield* Deferred.await(paused);
        expect(children).toBe(1);
        yield* Fiber.interrupt(startup);
        expect(children).toBe(0);
        expect(yield* host.current).toBeNull();
      }).pipe(Effect.scoped);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
