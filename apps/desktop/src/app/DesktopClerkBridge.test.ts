import * as NodeEvents from "node:events";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The synchronous mock factory evaluates installed SDK source in an isolated VM.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  app: undefined as unknown as NodeEvents.EventEmitter & {
    setAsDefaultProtocolClient: ReturnType<typeof vi.fn<(scheme: string) => boolean>>;
    hasSingleInstanceLock: () => boolean;
  },
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  registerUnrelated: false,
  window: { isDestroyed: () => false, isMinimized: () => true, restore: vi.fn(), focus: vi.fn() },
  registrationError: undefined as Error | undefined,
}));

vi.mock("electron", () => ({
  get app() {
    return fixture.app;
  },
}));
vi.mock("@clerk/electron/storage", () => ({
  storage: () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} }),
}));
vi.mock("./ClerkTokenStore.ts", () => ({
  openClerkTokenStorage: (_stateDir: string, createStorage: (directory: string) => unknown) =>
    createStorage("/unused"),
}));
vi.mock("@clerk/electron", () => {
  // Execute the installed SDK, not a reimplementation of its callback matcher.
  // Its CJS module gets only the Electron facade replaced, so no native process,
  // storage, browser or default-handler operation can escape this fixture.
  const require = NodeModule.createRequire(import.meta.url);
  const sdkPath = require.resolve("@clerk/electron");
  const sdkRequire = NodeModule.createRequire(sdkPath);
  const exports = {};
  NodeVM.runInNewContext(NodeFS.readFileSync(sdkPath, "utf8"), {
    exports,
    require: (id: string) =>
      id === "electron"
        ? {
            get app() {
              return fixture.app;
            },
            ipcMain: {
              handle: (name: string, callback: (...args: unknown[]) => unknown) =>
                fixture.handlers.set(name, callback),
              removeHandler: (name: string) => fixture.handlers.delete(name),
            },
            protocol: {
              registerSchemesAsPrivileged: () => {
                if (fixture.registrationError) throw fixture.registrationError;
                if (fixture.registerUnrelated) fixture.app.setAsDefaultProtocolClient("unrelated");
              },
            },
            shell: { openExternal: async () => {} },
            BrowserWindow: { fromWebContents: () => fixture.window },
          }
        : sdkRequire(id),
    process,
    URL,
    setTimeout,
    clearTimeout,
    console: { warn: () => {} },
  });
  return exports;
});

import { createDesktopClerkBridge } from "./DesktopClerkBridge.ts";
import { resolveDesktopUrlRegistration } from "./DesktopUrlRegistration.ts";

const reset = () => {
  fixture.handlers.clear();
  fixture.registerUnrelated = false;
  fixture.registrationError = undefined;
  fixture.window.restore.mockClear();
  fixture.window.focus.mockClear();
  fixture.app = Object.assign(new NodeEvents.EventEmitter(), {
    setAsDefaultProtocolClient: vi.fn<(scheme: string) => boolean>(() => true),
    hasSingleInstanceLock: () => true,
  });
};

const registration = (packaged: boolean, explicit: boolean, development = false) =>
  resolveDesktopUrlRegistration({
    platform: "linux",
    isPackaged: packaged,
    explicitRegistration: explicit,
    isDevelopment: development,
    execPath: "/electron",
    appPath: "/app/main.cjs",
  });

describe("DesktopClerkBridge Linux ownership", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
  ] as const)(
    "leaves native registration to the shared decision for packaged=%s, explicit=%s",
    (packaged, explicit) => {
      reset();
      const nativeRegister = fixture.app.setAsDefaultProtocolClient;
      const bridge = createDesktopClerkBridge(
        "/unused",
        registration(packaged, explicit),
        "/unused-profile",
      );
      try {
        assert.equal(nativeRegister.mock.calls.length, 0);
        assert.strictEqual(fixture.app.setAsDefaultProtocolClient, nativeRegister);
        assert.equal(fixture.app.listenerCount("open-url"), 1);
        assert.equal(fixture.app.listenerCount("second-instance"), 1);
      } finally {
        bridge.cleanup();
      }
      assert.equal(fixture.app.listenerCount("open-url"), 0);
      assert.equal(fixture.app.listenerCount("second-instance"), 0);
      assert.equal(fixture.handlers.size, 0);
    },
  );

  it.each(["open-url", "second-instance"] as const)(
    "keeps pending OAuth delivery through %s exactly once",
    async (event) => {
      reset();
      const bridge = createDesktopClerkBridge(
        "/unused",
        registration(false, false),
        "/unused-profile",
      );
      try {
        const redirectHandler = [...fixture.handlers].find(([key]) =>
          key.includes("redirect"),
        )?.[1];
        const openHandler = [...fixture.handlers].find(([key]) => key.endsWith(":open"))?.[1];
        assert.isDefined(redirectHandler);
        assert.isDefined(openHandler);
        const senderFrame = {};
        const ipcEvent = {
          sender: { getType: () => "window", mainFrame: senderFrame },
          senderFrame,
        };
        const pending = openHandler!(ipcEvent, "https://accounts.example/oauth");
        const url = "t3code://app/?code=disposable%20callback&state=one";
        const emit = () =>
          event === "open-url"
            ? fixture.app.emit(event, { preventDefault() {} }, url)
            : fixture.app.emit(event, {}, ["electron", "/app/main.cjs", url]);
        emit();
        assert.deepEqual(await pending, { callbackUrl: url });
        emit();
        assert.equal(fixture.window.focus.mock.calls.length, 1);
        assert.equal(fixture.window.restore.mock.calls.length, 1);
      } finally {
        bridge.cleanup();
      }
    },
  );

  it("restores native registration even if SDK initialization throws", () => {
    reset();
    const nativeRegister = fixture.app.setAsDefaultProtocolClient;
    fixture.registrationError = new Error("registration failed");
    assert.throws(
      () => createDesktopClerkBridge("/unused", registration(false, false), "/unused-profile"),
      /registration failed/,
    );
    assert.strictEqual(fixture.app.setAsDefaultProtocolClient, nativeRegister);
  });

  it("keeps unrelated native scheme registration intact", () => {
    reset();
    fixture.registerUnrelated = true;
    const nativeRegister = fixture.app.setAsDefaultProtocolClient;
    const bridge = createDesktopClerkBridge(
      "/unused",
      registration(false, false),
      "/unused-profile",
    );
    try {
      assert.deepEqual(nativeRegister.mock.calls, [["unrelated"]]);
    } finally {
      bridge.cleanup();
    }
  });

  it("leaves non-Linux SDK registration unchanged", () => {
    reset();
    const nativeRegister = fixture.app.setAsDefaultProtocolClient;
    const bridge = createDesktopClerkBridge(
      "/unused",
      {
        ...registration(false, false),
        platform: "darwin",
      },
      "/unused-profile",
    );
    try {
      assert.deepEqual(nativeRegister.mock.calls, [["t3code"]]);
    } finally {
      bridge.cleanup();
    }
  });
});
