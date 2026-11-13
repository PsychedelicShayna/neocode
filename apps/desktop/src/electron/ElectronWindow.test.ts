import { assert, describe, it } from "@effect/vitest";
import * as NodeEvents from "node:events";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Electron from "electron";
import * as Option from "effect/Option";
import { beforeEach, vi } from "vite-plus/test";

const {
  activateWindowsForegroundMock,
  appFocusMock,
  browserWindowMock,
  foregroundWindowMock,
  getAllWindowsMock,
  getFocusedWindowMock,
  loadWindowsForegroundApiMock,
  shellHostedForegroundMock,
  startWindowsForegroundFocusThreadMock,
  windowsForegroundFocusMock,
  windowsForegroundPrepareMock,
  windowsForegroundCloseMock,
} = vi.hoisted(() => ({
  activateWindowsForegroundMock: vi.fn(),
  appFocusMock: vi.fn(),
  browserWindowMock: vi.fn(function BrowserWindowMock() {}),
  foregroundWindowMock: vi.fn<() => bigint>(),
  getAllWindowsMock: vi.fn(),
  getFocusedWindowMock: vi.fn(),
  loadWindowsForegroundApiMock: vi.fn<() => Promise<{ getForegroundWindow: () => bigint }>>(),
  shellHostedForegroundMock: vi.fn(),
  startWindowsForegroundFocusThreadMock: vi.fn(),
  windowsForegroundFocusMock: vi.fn(),
  windowsForegroundPrepareMock: vi.fn(),
  windowsForegroundCloseMock: vi.fn(),
}));

vi.mock("./WindowsForeground.ts", () => ({
  activateWindowsForeground: activateWindowsForegroundMock,
  isWindowsShellHostedForeground: shellHostedForegroundMock,
  loadWindowsForegroundApi: loadWindowsForegroundApiMock,
}));

vi.mock("./WindowsForegroundFocusThread.ts", () => ({
  startWindowsForegroundFocusThread: startWindowsForegroundFocusThreadMock,
}));

vi.mock("electron", () => ({
  app: {
    focus: appFocusMock,
  },
  BrowserWindow: Object.assign(browserWindowMock, {
    getAllWindows: getAllWindowsMock,
    getFocusedWindow: getFocusedWindowMock,
  }),
  screen: {
    // A 200% display, so the focus target must carry converted bounds.
    dipToScreenRect: (_window: unknown, rect: Electron.Rectangle) => ({
      x: rect.x * 2,
      y: rect.y * 2,
      width: rect.width * 2,
      height: rect.height * 2,
    }),
  },
}));

import * as ElectronWindow from "./ElectronWindow.ts";

const layerTestFor = (platform: NodeJS.Platform) =>
  ElectronWindow.layer.pipe(Layer.provide(Layer.succeed(HostProcess.Platform, platform)));

const layerTest = layerTestFor("linux");

function makeWindowsRevealWindow() {
  return {
    id: 41,
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    show: vi.fn(),
    moveTop: vi.fn(),
    focus: vi.fn(),
    getTitle: vi.fn(() => "T3 Code (Dev)"),
    getBounds: vi.fn(() => ({ x: 100, y: 50, width: 1_200, height: 800 })),
    getContentBounds: vi.fn(() => ({ x: 108, y: 50, width: 1_184, height: 792 })),
    getNativeWindowHandle: vi.fn(() => Buffer.from([41, 0, 0, 0])),
    restore: vi.fn(),
  };
}

describe("ElectronWindow", () => {
  beforeEach(() => {
    activateWindowsForegroundMock.mockReset().mockResolvedValue(undefined);
    appFocusMock.mockReset();
    browserWindowMock.mockReset();
    foregroundWindowMock.mockReset().mockReturnValue(0n);
    getAllWindowsMock.mockReset();
    getFocusedWindowMock.mockReset();
    loadWindowsForegroundApiMock
      .mockReset()
      .mockImplementation(() => Promise.resolve({ getForegroundWindow: foregroundWindowMock }));
    shellHostedForegroundMock.mockReset().mockResolvedValue(false);
    startWindowsForegroundFocusThreadMock.mockReset().mockReturnValue({
      prepare: windowsForegroundPrepareMock,
      focus: windowsForegroundFocusMock,
      close: windowsForegroundCloseMock,
    });
    windowsForegroundFocusMock.mockReset().mockResolvedValue(false);
    windowsForegroundPrepareMock.mockReset().mockResolvedValue(false);
    windowsForegroundCloseMock.mockReset();
  });

  it.effect("keeps surviving renderers registered when the active window closes", () =>
    Effect.gen(function* () {
      const createWindow = (id: number) =>
        Object.assign(new NodeEvents.EventEmitter(), {
          id,
          isDestroyed: () => false,
          webContents: { id: id + 100 },
        }) as unknown as Electron.BrowserWindow & NodeEvents.EventEmitter;
      const first = createWindow(1);
      const second = createWindow(2);
      const preview = createWindow(3);
      const windows = yield* ElectronWindow.ElectronWindow;
      yield* windows.setMain(first);
      yield* windows.setMain(second);
      assert.strictEqual(Option.getOrThrow(yield* windows.main), second);
      first.emit("focus");
      assert.strictEqual(Option.getOrThrow(yield* windows.main), first);
      getFocusedWindowMock.mockReturnValue(preview);
      assert.strictEqual(Option.getOrThrow(yield* windows.focusedMainOrFirst), first);
      assert.strictEqual(Option.getOrThrow(yield* windows.fromWebContentsId(102)), second);
      assert.isTrue(Option.isNone(yield* windows.fromWebContentsId(103)));

      first.emit("closed");
      assert.equal(first.listenerCount("focus"), 0);
      assert.strictEqual(Option.getOrThrow(yield* windows.main), second);
      assert.isTrue(Option.isNone(yield* windows.fromWebContentsId(101)));
      yield* windows.clearMain(Option.some(first));
      assert.strictEqual(Option.getOrThrow(yield* windows.main), second);
      second.emit("closed");
      assert.isTrue(Option.isNone(yield* windows.main));
      const reopened = createWindow(4);
      yield* windows.setMain(reopened);
      assert.strictEqual(Option.getOrThrow(yield* windows.main), reopened);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([
    { name: "hidden", visible: false, minimized: false },
    { name: "minimized", visible: true, minimized: true },
    { name: "visible behind another window", visible: true, minimized: false },
  ])("restores, shows, focuses and raises an $name X11 window", (initial) =>
    Effect.gen(function* () {
      const state = { ...initial, focused: false, top: false };
      const window = {
        id: 41,
        isDestroyed: () => false,
        isMinimized: () => state.minimized,
        isVisible: () => state.visible,
        restore: () => {
          state.minimized = false;
        },
        show: () => {
          state.visible = true;
        },
        moveTop: () => {
          state.top = true;
        },
        focus: () => {
          state.focused = true;
        },
      } as unknown as Electron.BrowserWindow;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* electronWindow.reveal(window);
      assert.isFalse(state.minimized);
      assert.isTrue(state.visible);
      assert.isTrue(state.focused);
      assert.isTrue(state.top);
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("cancels native focus when destroyed during the foreground query", () =>
    Effect.gen(function* () {
      const window = makeWindowsRevealWindow();
      activateWindowsForegroundMock.mockRejectedValueOnce(
        new Error("Windows initially refused foreground activation"),
      );
      const queryStarted = Promise.withResolvers<void>();
      const foreground = Promise.withResolvers<{ getForegroundWindow: () => bigint }>();
      loadWindowsForegroundApiMock.mockImplementation(() => {
        queryStarted.resolve();
        return foreground.promise;
      });
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* electronWindow.prepareReveal(window as unknown as Electron.BrowserWindow);
      assert.deepEqual(windowsForegroundPrepareMock.mock.calls[0]?.[0], {
        windowId: 41,
        processId: process.pid,
        title: "T3 Code (Dev)",
        bounds: { x: 200, y: 100, width: 2_400, height: 1_600 },
        contentBounds: { x: 216, y: 100, width: 2_368, height: 1_584 },
      });
      window.getTitle.mockClear();

      const revealFiber = yield* electronWindow
        .reveal(window as unknown as Electron.BrowserWindow)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => queryStarted.promise);
      window.isDestroyed.mockReturnValue(true);
      foreground.resolve({ getForegroundWindow: foregroundWindowMock });
      yield* Fiber.join(revealFiber);

      assert.lengthOf(windowsForegroundFocusMock.mock.calls, 0);
      assert.lengthOf(window.getNativeWindowHandle.mock.calls, 1);
      assert.lengthOf(window.getTitle.mock.calls, 0);
    }).pipe(Effect.provide(layerTestFor("win32"))),
  );

  it.effect("preserves destroy failures and continues with later windows", () =>
    Effect.gen(function* () {
      const cause = new Error("window destroy failed");
      const window = {
        id: 43,
        destroy: vi.fn(() => {
          throw cause;
        }),
      } as unknown as Electron.BrowserWindow;
      const laterWindow = {
        id: 44,
        destroy: vi.fn(),
      } as unknown as Electron.BrowserWindow;
      getAllWindowsMock.mockReturnValueOnce([window, laterWindow]);

      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const exit = yield* Effect.exit(electronWindow.destroyAll);

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronWindow.ElectronWindowOperationError);
        assert.equal(error.operation, "destroy-window");
        assert.equal(error.windowId, 43);
        assert.isNull(error.channel);
        assert.strictEqual(error.cause, cause);
      }
      assert.equal(vi.mocked(laterWindow.destroy).mock.calls.length, 1);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("never falls back to an auxiliary window as the main window", () =>
    Effect.gen(function* () {
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const auxiliary = yield* electronWindow.create({}, { auxiliary: true });
      const ordinary = { isDestroyed: () => false } as unknown as Electron.BrowserWindow;
      Object.assign(auxiliary, { isDestroyed: () => false });

      getAllWindowsMock.mockReturnValue([auxiliary]);
      assert.isTrue((yield* electronWindow.currentMainOrFirst)._tag === "None");

      getAllWindowsMock.mockReturnValue([auxiliary, ordinary]);
      const current = yield* electronWindow.currentMainOrFirst;
      assert.isTrue(current._tag === "Some" && current.value === ordinary);
    }).pipe(Effect.provide(layerTest)),
  );
});
