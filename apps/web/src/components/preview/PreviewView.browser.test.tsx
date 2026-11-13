import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
} from "@t3tools/contracts";
import { type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

import type { PreviewableServer } from "./useDiscoveredLocalServers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async (_tabId: string, _url: string): Promise<void> => undefined),
  rememberPreviewUrl: vi.fn(),
  readPreparedConnection: vi.fn(() => ({ httpBaseUrl: "http://172.25.85.75:3773" })),
  readEnvironmentScope: vi.fn((_environmentId?: unknown, _scope?: unknown) => true),
  setAnnotationSendEnabled: vi.fn(async (_tabId: string, _enabled: boolean): Promise<void> => {}),
  cancelPickElement: vi.fn(async (_tabId: string) => undefined),
  openPictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  closePictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  pickElement: vi.fn(),
  addPreviewAnnotation: vi.fn(),
  addImage: vi.fn(),
  pictureInPicture: false,
  showEmptyState: false,
  loading: false,
  nativeServerTab: false,
  serverEpoch: null as string | null,
  servers: [] as PreviewableServer[],
  recordingTabIds: new Set<string>(),
  recordingRuntimeTabId: null as string | null,
  recordVisitForThread: vi.fn(),
}));

const STUB_BROWSER_DEFAULTS = {
  viewport: FILL_PREVIEW_VIEWPORT,
  zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
  appearance: DEFAULT_PREVIEW_APPEARANCE,
  autoShowFloatingPreview: true,
  profiles: BUILT_IN_BROWSER_PROFILES,
  profileId: DEFAULT_BROWSER_PROFILE_ID,
};

// The desktop bridge only exists inside Electron; the view reads it once at import.
vi.mock(import("./previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    navigate: mocks.navigate,
    pickElement: mocks.pickElement,
    annotationVoice: { onEvent: () => () => {}, update: async () => {} },
    setAnnotationSendEnabled: mocks.setAnnotationSendEnabled,
    cancelPickElement: mocks.cancelPickElement,
    refresh: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    hardReload: vi.fn(async () => undefined),
    openDevTools: vi.fn(async () => undefined),
    setColorScheme: vi.fn(async () => undefined),
    zoomIn: vi.fn(async () => undefined),
    zoomOut: vi.fn(async () => undefined),
    resetZoom: vi.fn(async () => undefined),
    clearCookies: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    pictureInPicture: {
      open: mocks.openPictureInPicture,
      close: mocks.closePictureInPicture,
    },
  } as never,
}));
vi.mock(import("~/browserHistoryStore"), async (original) => ({
  ...(await original()),
  recordVisitForThread: mocks.recordVisitForThread,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: mocks.readPreparedConnection as never,
  readEnvironmentScope: mocks.readEnvironmentScope,
  useEnvironmentScope: mocks.readEnvironmentScope,
}));
vi.mock(import("~/browser/browserDefaults"), async (original) => ({
  ...(await original()),
  useBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
  getBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
}));
vi.mock(import("~/previewStateStore"), async (original) => ({
  ...(await original()),
  rememberPreviewUrl: mocks.rememberPreviewUrl,
  useThreadPreviewState: (() => ({
    activeTabId: "tab-1",
    serverEpoch: mocks.serverEpoch,
    desktopByTabId: {
      "tab-1": {
        hasWebContents: true,
        canGoBack: false,
        canGoForward: false,
        loading: mocks.loading,
        zoomFactor: 1,
        pictureInPicture: mocks.pictureInPicture,
        colorScheme: "system",
        audioMuted: false,
        audible: false,
        controller: "none",
      },
    },
    recentlySeenUrls: [],
    sessions: mocks.showEmptyState
      ? {}
      : {
          "tab-1": {
            threadId: "thread-1",
            tabId: "tab-1",
            runtime: mocks.nativeServerTab ? "server" : "desktop",
            navStatus: { _tag: "Success", url: "http://example.com/", title: "Example" },
            canGoBack: false,
            canGoForward: false,
            updatedAt: "2026-07-13T00:00:00.000Z",
          },
        },
  })) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => ({ label: "WSL" })) as never,
  useEnvironmentHttpBaseUrl: () => "http://172.25.85.75:3773",
  usePrimaryEnvironmentId: () => null,
}));
vi.mock(import("~/browser/browserRecording"), async (original) => ({
  ...(await original()),
  findActiveBrowserRecordingRuntimeTabId: () => mocks.recordingRuntimeTabId,
  useActiveBrowserRecordingTabIds: () => mocks.recordingTabIds,
}));
vi.mock(import("./useDiscoveredLocalServers"), async (original) => ({
  ...(await original()),
  useDiscoveredLocalServers: () => mocks.servers,
}));
vi.mock(import("./usePreviewSession"), async (original) => ({
  ...(await original()),
  usePreviewSession: () => {},
}));

vi.mock(import("~/browser/previewRuntime"), async (original) => ({
  ...(await original()),
  useRendersServerTabNatively: () => mocks.nativeServerTab,
}));

vi.mock(import("~/browser/browserViewportActions"), { spy: true });

import { useComposerDraftStore } from "~/composerDraftStore";
import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { dispatchPreviewAction } from "./previewActionBus";
import { PreviewView } from "./PreviewView";
import { ToastProvider } from "~/components/ui/toast";

const TEST_THREAD_REF = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;
const TEST_RUNTIME_TAB_ID = previewRuntimeTabId(TEST_THREAD_REF, null, "tab-1");

function view(onSendAnnotation?: ComponentProps<typeof PreviewView>["onSendAnnotation"]) {
  return (
    <PreviewView
      threadRef={TEST_THREAD_REF}
      tabId="tab-1"
      visible
      {...(onSendAnnotation ? { onSendAnnotation } : {})}
    />
  );
}

function annotation(id: string, screenshot: unknown = null) {
  return {
    id,
    pageUrl: "https://example.com/dashboard",
    pageTitle: "Dashboard",
    comment: "Tighten this spacing",
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot,
    createdAt: "2026-07-27T00:00:00.000Z",
  };
}

// The mocked modules and stores are shared by the whole file, so every test starts by
// resetting them.
function setup() {
  vi.clearAllMocks();
  mocks.readEnvironmentScope.mockReset().mockReturnValue(true);
  mocks.setAnnotationSendEnabled.mockReset().mockResolvedValue(undefined);
  mocks.pickElement.mockReset();
  mocks.pictureInPicture = false;
  mocks.showEmptyState = false;
  mocks.loading = false;
  mocks.nativeServerTab = false;
  mocks.serverEpoch = null;
  mocks.servers = [];
  mocks.recordingTabIds = new Set();
  mocks.recordingRuntimeTabId = null;
  useComposerDraftStore.setState({
    addPreviewAnnotation: mocks.addPreviewAnnotation,
    addImage: mocks.addImage,
  });
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useBrowserPointerStore.setState({ byTabId: {} });
}

describe("PreviewView", () => {
  it("keeps a replacement browser's cursor independent of an older recording", async () => {
    setup();
    mocks.recordingTabIds.add(TEST_RUNTIME_TAB_ID);
    mocks.recordingRuntimeTabId = TEST_RUNTIME_TAB_ID;
    const pointer = {
      phase: "move" as const,
      x: 10,
      y: 20,
      sequence: 1,
      createdAt: "2026-07-27T00:00:00.000Z",
    };
    useBrowserPointerStore.getState().apply({ ...pointer, tabId: TEST_RUNTIME_TAB_ID });
    const container = document.createElement("div");
    Object.assign(container.style, { display: "flex", width: "640px", height: "480px" });
    await using screen = await render(view(), { container });
    await vi.waitFor(() =>
      expect(document.querySelector("[data-agent-browser-cursor]")).toBeNull(),
    );
    mocks.serverEpoch = "replacement-server";
    const replacement = previewRuntimeTabId(TEST_THREAD_REF, mocks.serverEpoch, "tab-1");
    await act(() => useBrowserPointerStore.getState().apply({ ...pointer, tabId: replacement }));
    await screen.rerender(view());
    await vi.waitFor(() =>
      expect(document.querySelector("[data-agent-browser-cursor]")).not.toBeNull(),
    );
    expect(mocks.recordingTabIds.has(TEST_RUNTIME_TAB_ID)).toBe(true);
  });

  it.each(["replacement-runtime", "same-runtime", "hidden-panel"] as const)(
    "ignores a superseded pick without disturbing its replacement (%s)",
    async (change) => {
      setup();
      const first = deferred<unknown>();
      const second = deferred<unknown>();
      const onSendAnnotation = vi.fn();
      mocks.pickElement.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      await using screen = await render(view(onSendAnnotation));
      const firstFocus = page.getByRole("textbox").element() as HTMLElement;
      using firstRestore = vi.spyOn(firstFocus, "focus");
      const firstButton = page
        .getByRole("button", { name: "Annotate preview" })
        .element() as HTMLButtonElement;
      firstFocus.focus();
      await act(() => firstButton.click());

      if (change === "hidden-panel") {
        await screen.rerender(
          <PreviewView
            threadRef={TEST_THREAD_REF}
            tabId="tab-1"
            visible={false}
            onSendAnnotation={onSendAnnotation}
          />,
        );
        await act(() => firstButton.click());
        expect(mocks.pickElement).toHaveBeenCalledOnce();
      } else {
        mocks.serverEpoch = "replacement-server";
        await screen.rerender(view(onSendAnnotation));
      }
      expect(mocks.cancelPickElement).toHaveBeenCalledExactlyOnceWith(TEST_RUNTIME_TAB_ID);
      if (change !== "replacement-runtime") {
        mocks.serverEpoch = null;
        await screen.rerender(view(onSendAnnotation));
      }

      const replacementRuntime = previewRuntimeTabId(TEST_THREAD_REF, mocks.serverEpoch, "tab-1");
      const secondFocus = page
        .getByRole("button", { name: "Annotate preview" })
        .element() as HTMLButtonElement;
      using secondRestore = vi.spyOn(secondFocus, "focus");
      secondFocus.focus();
      await act(() => secondFocus.click());
      expect(mocks.pickElement.mock.calls[1]?.[0]).toBe(replacementRuntime);
      firstRestore.mockClear();
      secondRestore.mockClear();
      await act(async () => {
        first.resolve({
          annotation: annotation("stale"),
          submission: "send",
          screenshotFailed: true,
        });
        await first.promise;
      });
      expect(mocks.addPreviewAnnotation).not.toHaveBeenCalled();
      expect(mocks.addImage).not.toHaveBeenCalled();
      expect(onSendAnnotation).not.toHaveBeenCalled();
      expect(firstRestore).not.toHaveBeenCalled();
      expect(secondRestore).not.toHaveBeenCalled();

      const current = annotation("current");
      await act(async () => {
        second.resolve({ annotation: current, submission: "send" });
        await second.promise;
      });
      expect(mocks.addPreviewAnnotation).toHaveBeenCalledExactlyOnceWith(TEST_THREAD_REF, current);
      expect(onSendAnnotation).toHaveBeenCalledExactlyOnceWith(current, null);
      expect(secondRestore).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(firstRestore).not.toHaveBeenCalled();
    },
  );

  it("ignores a successful response after the current pick was explicitly cancelled", async () => {
    setup();
    const pick = deferred<unknown>();
    const onSendAnnotation = vi.fn();
    mocks.pickElement.mockReturnValueOnce(pick.promise);
    await using _screen = await render(view(onSendAnnotation));
    const opener = page.getByRole("textbox").element() as HTMLElement;
    using restoreFocus = vi.spyOn(opener, "focus");
    const button = page
      .getByRole("button", { name: "Annotate preview" })
      .element() as HTMLButtonElement;
    opener.focus();
    await act(() => button.click());
    restoreFocus.mockClear();
    await act(() => button.click());
    expect(mocks.cancelPickElement).toHaveBeenCalledExactlyOnceWith(TEST_RUNTIME_TAB_ID);
    await act(async () => {
      pick.resolve({ annotation: annotation("cancelled"), submission: "send" });
      await pick.promise;
    });
    expect(mocks.addPreviewAnnotation).not.toHaveBeenCalled();
    expect(onSendAnnotation).not.toHaveBeenCalled();
    expect(restoreFocus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("cancels on unmount without applying a late result or restoring focus", async () => {
    setup();
    const pick = deferred<unknown>();
    const onSendAnnotation = vi.fn();
    mocks.pickElement.mockReturnValueOnce(pick.promise);
    await using screen = await render(view(onSendAnnotation));
    const opener = page.getByRole("textbox").element() as HTMLElement;
    using restoreFocus = vi.spyOn(opener, "focus");
    const button = page
      .getByRole("button", { name: "Annotate preview" })
      .element() as HTMLButtonElement;
    opener.focus();
    await act(() => button.click());
    restoreFocus.mockClear();
    await screen.unmount();
    expect(mocks.cancelPickElement).toHaveBeenCalledExactlyOnceWith(TEST_RUNTIME_TAB_ID);
    await act(async () => {
      pick.resolve({ annotation: annotation("closed"), submission: "send" });
      await pick.promise;
    });
    expect(mocks.addPreviewAnnotation).not.toHaveBeenCalled();
    expect(onSendAnnotation).not.toHaveBeenCalled();
    expect(restoreFocus).not.toHaveBeenCalled();
  });

  it.each(["mailto:alice@example.com", "http://"])(
    "reports rejected address %s without navigating or recording it",
    async (address) => {
      setup();
      await using _screen = await render(<ToastProvider timeout={0}>{view()}</ToastProvider>);
      const input = page.getByPlaceholder("Search or enter URL");
      await input.fill(address);
      await userEvent.keyboard("{Enter}");

      await expect.element(page.getByText("Could not open this address")).toBeVisible();
      await expect.element(page.getByText("Enter an http or https URL.")).toBeVisible();
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(mocks.recordVisitForThread).not.toHaveBeenCalled();
      await userEvent.click(page.getByRole("button", { name: "Dismiss notification" }));
    },
  );

  it("retains the annotation locally when its own environment loses access during capture", async () => {
    setup();
    const picked = annotation("annotation-revoked");
    const onSendAnnotation = vi.fn();
    let submitPick: (() => void) | undefined;
    mocks.pickElement.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          submitPick = () => resolve({ annotation: picked, submission: "send" });
        }),
    );
    await using screen = await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(submitPick).toBeDefined());
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, true);

    mocks.readEnvironmentScope.mockImplementation(
      (environmentId?: unknown) => environmentId !== TEST_THREAD_REF.environmentId,
    );
    await screen.rerender(view(onSendAnnotation));
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, false);
    await act(async () => submitPick!());
    await vi.waitFor(() =>
      expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, picked),
    );
    expect(onSendAnnotation).not.toHaveBeenCalled();

    mocks.readEnvironmentScope.mockReturnValue(true);
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await screen.rerender(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(picked, null));
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, true);
  });

  it("still sends annotation text when the picked element's crop is malformed", async () => {
    setup();
    const picked = annotation("annotation-2", {
      dataUrl: "data:image/png;base64,%%%",
      width: 10,
      height: 10,
      cropRect: { x: 0, y: 0, width: 10, height: 10 },
    });
    const onSendAnnotation = vi.fn();
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await using _screen = await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));

    const sent = { ...picked, screenshot: null };
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(sent, null));
    expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, sent);
    expect(mocks.addImage).not.toHaveBeenCalled();
  });

  it("focuses and selects the address from forwarded desktop actions only while visible", async () => {
    setup();
    using stack = new DisposableStack();
    const previousBridge = window.desktopBridge;
    stack.defer(() => {
      if (previousBridge) window.desktopBridge = previousBridge;
      else delete window.desktopBridge;
    });
    const listeners = new Set<(action: string) => void>();
    window.desktopBridge = {
      getWindowZoomFactor: () => 1,
      onMenuAction: (listener: (action: string) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as NonNullable<typeof window.desktopBridge>;
    await using screen = await render(view());
    const address = page.getByRole("textbox");
    const input = address.element() as HTMLInputElement;
    const forward = () =>
      act(() => {
        listeners.forEach((listener) => listener("preview.focusUrl"));
      });

    await forward();
    await expect.element(address).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    await act(() => input.blur());
    await forward();
    await expect.element(address).toHaveFocus();

    await act(() => input.blur());
    await screen.rerender(
      <PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible={false} />,
    );
    await forward();
    await expect.element(address).not.toHaveFocus();
    expect(listeners.size).toBe(0);
  });

  it("focuses the address bar each time the focus-url shortcut fires", async () => {
    setup();
    await using _screen = await render(view());
    const address = page.getByRole("textbox");

    await act(() => dispatchPreviewAction("focus-url"));
    await expect.element(address).toHaveFocus();

    (address.element() as HTMLInputElement).blur();
    await expect.element(address).not.toHaveFocus();
    await act(() => dispatchPreviewAction("focus-url"));
    await expect.element(address).toHaveFocus();
  });
});
