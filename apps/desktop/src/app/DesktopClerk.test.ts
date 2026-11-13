// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous module-level fixtures are created before Effect test layers exist.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Plain fixture paths are needed before Effect test layers exist.
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";
import * as NodePathLayer from "@effect/platform-node/NodePath";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { afterAll, beforeEach, vi } from "vite-plus/test";

const clerkStateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-clerk-"));
afterAll(() => {
  NodeFS.rmSync(clerkStateDir, { recursive: true, force: true });
});

const { createClerkBridgeMock, requestSingleInstanceLockMock, storageAdapter, storageMock } =
  vi.hoisted(() => ({
    createClerkBridgeMock: vi.fn(),
    requestSingleInstanceLockMock: vi.fn(() => true),
    storageAdapter: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    storageMock: vi.fn(),
  }));

vi.mock("@clerk/electron", () => ({ createClerkBridge: createClerkBridgeMock }));
vi.mock("@clerk/electron/storage", () => ({ storage: storageMock }));
vi.mock("electron", () => ({ app: { setAsDefaultProtocolClient: vi.fn(() => true) } }));

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import { resolveDesktopUrlRegistration } from "./DesktopUrlRegistration.ts";

const fixture = (
  input: {
    isDevelopment?: boolean;
    platform?: NodeJS.Platform;
    fileSystemLayer?: Layer.Layer<FileSystem.FileSystem>;
    onLink?: (url: string) => void;
  } = {},
) => {
  const isDevelopment = input.isDevelopment ?? true;
  const platform = input.platform ?? "darwin";
  const events: string[] = [];
  const appEvents = new NodeEvents.EventEmitter();
  const activated = Promise.withResolvers<void>();
  const received: string[] = [];
  const loaded: string[] = [];
  let activations = 0;
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: clerkStateDir,
    baseDir: "/tmp/.t3",
    homeDirectory: "/tmp",
    path: { join: NodePath.posix.join, resolve: NodePath.posix.resolve },
    isDevelopment,
    appDataDirectory: "/tmp/app-data",
    platform,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
  const electronApp = {
    setPath: (name: string, value: string) =>
      Effect.sync(() => {
        events.push(`setPath:${name}:${value}`);
      }),
    requestSingleInstanceLock: Effect.sync(() => {
      events.push("requestSingleInstanceLock");
      return requestSingleInstanceLockMock();
    }),
    quit: Effect.sync(() => {
      events.push("quit");
    }),
    on: (name: string, listener: (...args: unknown[]) => void) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          events.push(`on:${name}`);
          appEvents.on(name, listener);
        }),
        () =>
          Effect.sync(() => {
            appEvents.removeListener(name, listener);
          }),
      ).pipe(Effect.asVoid),
  } as unknown as ElectronApp.ElectronApp["Service"];
  const desktopWindow = {
    activate: Effect.sync(() => {
      activations++;
      activated.resolve();
    }),
  } as unknown as DesktopWindow.DesktopWindow["Service"];
  const window = {
    loadURL: async (url: string) => {
      loaded.push(url);
    },
  };
  const electronWindow = {
    currentMainOrFirst: Effect.succeedSome(window),
    reveal: () => desktopWindow.activate,
  } as unknown as ElectronWindow.ElectronWindow["Service"];
  const webLinks = DesktopWebLinks.DesktopWebLinks.of({
    receive: (url) =>
      Effect.sync(() => {
        received.push(url);
        input.onLink?.(url);
      }),
    setRendererReady: () => Effect.void,
  });
  const layer = DesktopClerk.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodePathLayer.layerPosix,
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        Layer.succeed(DesktopWindow.DesktopWindow, desktopWindow),
        Layer.succeed(ElectronWindow.ElectronWindow, electronWindow),
        Layer.succeed(DesktopWebLinks.DesktopWebLinks, webLinks),
        Layer.succeed(HostProcess.Arguments, ["electron"]),
        Layer.effect(
          DesktopState.DesktopState,
          Effect.gen(function* () {
            const quitting = yield* Ref.make(false);
            return { quitting } as DesktopState.DesktopState["Service"];
          }),
        ),
        Layer.succeed(DesktopPreReadyPlatform.DesktopPreReadyElectronOptions, {
          linux: null,
          linuxPasswordStoreCommandLine: null,
          urlRegistration: resolveDesktopUrlRegistration({
            platform,
            isDevelopment,
            isPackaged: false,
            explicitRegistration: false,
            execPath: "/electron",
            appPath: "/app",
          }),
        }),
        input.fileSystemLayer ?? FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
      ),
    ),
  );
  return { layer, events, appEvents, activated, received, loaded, activations: () => activations };
};

describe("DesktopClerk", () => {
  beforeEach(() => {
    createClerkBridgeMock
      .mockReset()
      .mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    requestSingleInstanceLockMock.mockReset().mockReturnValue(true);
    storageMock.mockReset().mockReturnValue(storageAdapter);
  });

  it.each([
    { platform: "darwin" as const, isDevelopment: false, profile: "t3code-v2" },
    { platform: "linux" as const, isDevelopment: false, profile: "t3code-v2" },
    { platform: "win32" as const, isDevelopment: false, profile: "t3code-v2" },
    { platform: "win32" as const, isDevelopment: true, profile: "t3code-dev" },
  ])("sets the profile and claims its lock before yielding ($platform, $profile)", (input) => {
    const f = fixture({ ...input, fileSystemLayer: DesktopPreReadyFileSystem.layer });
    const cleanup = vi.fn();
    createClerkBridgeMock.mockImplementation(() => {
      f.events.push("createClerkBridge");
      return { cleanup, isPrimaryInstance: true };
    });
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- A synchronous build is the pre-ready contract being exercised.
    Effect.runSync(Effect.scoped(Layer.build(f.layer)));
    assert.deepEqual(f.events, [
      `setPath:userData:/tmp/app-data/${input.profile}`,
      "requestSingleInstanceLock",
      "on:second-instance",
      "on:open-url",
      "createClerkBridge",
    ]);
    assert.equal(cleanup.mock.calls.length, 1);
  });

  it.effect("preserves bridge initialization failures", () => {
    const cause = new Error("bridge initialization failed");
    createClerkBridgeMock.mockImplementationOnce(() => {
      throw cause;
    });
    return Effect.gen(function* () {
      const error = yield* Effect.scoped(Layer.build(fixture().layer)).pipe(Effect.flip);
      assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeInitializationError);
      assert.equal(error.stateDir, clerkStateDir);
      assert.equal(error.isDevelopment, true);
      assert.strictEqual(error.cause, cause);
    });
  });

  it.effect("preserves bridge cleanup failures", () => {
    const cause = new Error("bridge cleanup failed");
    createClerkBridgeMock.mockReturnValueOnce({
      cleanup: () => {
        throw cause;
      },
      isPrimaryInstance: true,
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.scoped(Layer.build(fixture({ isDevelopment: false }).layer)),
      );
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeCleanupError);
        assert.equal(error.stateDir, clerkStateDir);
        assert.equal(error.isDevelopment, false);
        assert.strictEqual(error.cause, cause);
      }
    });
  });

  it.effect.each(
    ["bridge lock", "before configure", "after configure"].flatMap((boundary) => [
      { boundary, argv: ["electron"] },
      { boundary, argv: ["electron", "t3code://clerk/callback?code=private"] },
    ]),
  )("retains activation at $boundary with $argv", ({ boundary, argv }) => {
    const f = fixture();
    const oauthUrls: string[] = [];
    const callback = (_event: unknown, args: string[]) => {
      oauthUrls.push(...args.filter((arg) => arg.startsWith("t3code://")));
    };
    const cleanup = vi.fn();
    createClerkBridgeMock.mockImplementation(() => {
      f.appEvents.on("second-instance", callback);
      if (boundary === "bridge lock") f.appEvents.emit("second-instance", {}, argv);
      return {
        isPrimaryInstance: true,
        cleanup: () => {
          f.appEvents.removeListener("second-instance", callback);
          cleanup();
        },
      };
    });
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        if (boundary === "before configure") f.appEvents.emit("second-instance", {}, argv);
        assert.equal(f.activations(), 0);
        yield* clerk.configure;
        if (boundary === "after configure") f.appEvents.emit("second-instance", {}, argv);
        yield* Effect.promise(() => f.activated.promise);
        assert.equal(f.activations(), 1);
        assert.deepEqual(oauthUrls, argv.slice(1));
        assert.notInclude(f.events, "quit");
      }).pipe(Effect.provide(f.layer), Effect.scoped);
      f.appEvents.emit("second-instance", {}, argv);
      assert.equal(f.activations(), 1);
      assert.deepEqual(oauthUrls, argv.slice(1));
      assert.equal(f.appEvents.listenerCount("second-instance"), 0);
      assert.equal(cleanup.mock.calls.length, 1);
    });
  });

  it.effect("delivers queued startup links once before later links", () => {
    const first = "t3code://new?prompt=first";
    const second = "t3code://threads/env-1/thread-1";
    const later = "t3code://new?prompt=later";
    const pair = "t3code://pair?pairingUrl=https%3A%2F%2Fvps.example.com%2F%23token%3Dabc";
    const delivered = Promise.withResolvers<void>();
    const f = fixture({
      onLink: (url) => {
        if (url === later) delivered.resolve();
      },
    });
    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      f.appEvents.emit("second-instance", {}, ["electron", first]);
      f.appEvents.emit("second-instance", {}, ["electron", second]);
      f.appEvents.emit("open-url", { preventDefault: vi.fn() }, pair);
      assert.deepEqual(f.received, []);
      yield* clerk.configure;
      f.appEvents.emit("second-instance", {}, ["electron", later]);
      yield* Effect.promise(() => delivered.promise);
      assert.deepEqual(f.received, [pair, first, second, later]);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect.each(["darwin", "win32", "linux"] as const)(
    "interrupts a second launch before Clerk or runtime construction on %s",
    (platform) => {
      requestSingleInstanceLockMock.mockReturnValueOnce(false);
      const f = fixture({ platform, isDevelopment: false });
      const runtime = f.layer.pipe(
        Layer.flatMap(() =>
          Layer.effectDiscard(
            Effect.sync(() => {
              f.events.push("initializeApplicationRuntime");
            }),
          ),
        ),
      );
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(Effect.scoped(Layer.build(runtime)));
        assert.isTrue(Exit.hasInterrupts(exit));
        assert.deepEqual(f.events, [
          "setPath:userData:/tmp/app-data/t3code-v2",
          "requestSingleInstanceLock",
          "quit",
        ]);
        assert.equal(createClerkBridgeMock.mock.calls.length, 0);
        assert.equal(storageMock.mock.calls.length, 0);
      });
    },
  );

  it.effect("sanitizes provider return links and leaves Clerk callbacks to the SDK", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* clerk.configure;
      const event = { preventDefault: vi.fn() };
      f.appEvents.emit("open-url", event, "t3code-dev://app/auth/callback?code=clerk-code");
      f.appEvents.emit("open-url", event, "t3code://app/welcome");
      assert.deepEqual(f.loaded, []);
      assert.equal(event.preventDefault.mock.calls.length, 0);
      f.appEvents.emit("second-instance", {}, [
        "electron",
        "t3code-dev://app/settings/providers?instanceId=work&code=never-forward",
      ]);
      yield* Effect.promise(() => f.activated.promise);
      assert.deepEqual(f.loaded, ["t3code-dev://app/settings/providers?instanceId=work"]);
      f.appEvents.emit("open-url", event, "t3code-dev://app/welcome#agents:machine-id");
      assert.equal(event.preventDefault.mock.calls.length, 1);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });

  it.effect("hands web and app links to the renderer and leaves other links alone", () => {
    const pair = "t3code://pair?pairingUrl=https%3A%2F%2Fvps.example.com%2F%23token%3Dabc";
    const delivered = Promise.withResolvers<void>();
    const f = fixture({
      onLink: (url) => {
        if (url === pair) delivered.resolve();
      },
    });
    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* clerk.configure;
      const open = (url: string) => {
        const event = { preventDefault: vi.fn() };
        f.appEvents.emit("open-url", event, url);
        return event.preventDefault.mock.calls.length;
      };
      for (const url of [
        "https://example.com/page",
        "http://localhost:3000/",
        "t3code://new?prompt=hi",
        "t3code://threads/env-1/thread-1",
        pair,
      ]) {
        assert.equal(open(url), 1);
      }
      for (const url of ["t3code://pair", "mailto:hello@example.com", "t3code://somewhere-else"]) {
        assert.equal(open(url), 0);
      }
      yield* Effect.promise(() => delivered.promise);
      assert.deepEqual(f.received, [
        "https://example.com/page",
        "http://localhost:3000/",
        "t3code://new?prompt=hi",
        "t3code://threads/env-1/thread-1",
        pair,
      ]);
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  });
});
