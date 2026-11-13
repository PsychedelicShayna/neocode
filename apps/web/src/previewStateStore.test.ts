import {
  scopedThreadKey,
  scopeThreadRef,
  workspaceResourceId,
} from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type PreviewEvent,
  type PreviewSessionSnapshot,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { startPreviewTitleRecording } from "./browserHistoryStore";
import {
  __testing,
  applyPreviewDesktopState,
  applyPreviewServerEvent as applyPreviewServerEventImpl,
  applyPreviewServerSnapshot,
  updatePreviewServerSnapshot,
  beginPreviewSessionClose,
  cancelPreviewSessionClose,
  previewStateAtom,
  previewThreadRefsAtom,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  rememberPreviewUrl,
  resetPreviewStateForTests,
  setActivePreviewTab,
} from "./previewStateStore";
import { appAtomRegistry } from "./rpc/atomRegistry";

const environmentId = "env-1" as EnvironmentId;
const ref = scopeThreadRef(environmentId, ThreadId.make("thread-1"));

const makeSnapshot = (overrides: Partial<PreviewSessionSnapshot> = {}): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId: "tab_a",
  navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

type PreviewEventDraft = PreviewEvent extends infer Event
  ? Event extends { readonly revision: number }
    ? Omit<Event, "revision" | "serverEpoch">
    : never
  : never;

const serverEpoch = "server-a";
let nextServerRevision = 0;
const applyPreviewServerEvent = (eventRef: typeof ref, event: PreviewEventDraft): void => {
  nextServerRevision += 1;
  applyPreviewServerEventImpl(eventRef, {
    ...event,
    serverEpoch,
    revision: nextServerRevision,
  } as PreviewEvent);
};

beforeEach(() => {
  nextServerRevision = 0;
  resetPreviewStateForTests();
});

describe("previewStateStore (single-tab)", () => {
  it("resized event updates tab viewport without changing the active tab", () => {
    const active = makeSnapshot({ tabId: "tab_a" });
    const background = makeSnapshot({ tabId: "tab_b" });
    applyPreviewServerSnapshot(ref, background);
    applyPreviewServerSnapshot(ref, active);

    applyPreviewServerEvent(ref, {
      type: "resized",
      threadId: "thread-1",
      tabId: background.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
      snapshot: {
        ...background,
        viewport: { _tag: "preset", presetId: "pixel-8", width: 412, height: 915 },
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
    });

    const state = readThreadPreviewState(ref);
    expect(state.activeTabId).toBe(active.tabId);
    expect(state.sessions[background.tabId]?.viewport).toEqual({
      _tag: "preset",
      presetId: "pixel-8",
      width: 412,
      height: 915,
    });
  });

  it("failed event for a non-active tab is ignored", () => {
    const snapshot = makeSnapshot({ tabId: "tab_a" });
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "failed",
      threadId: "thread-1",
      tabId: "tab_b",
      createdAt: "2026-01-01T00:00:01.000Z",
      url: "http://localhost:9999/",
      title: "",
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
    });
    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.navStatus._tag).toBe("Loading");
  });

  it("optimistically removes a session before the server close event arrives", () => {
    const first = makeSnapshot({ tabId: "tab_a" });
    const second = makeSnapshot({
      tabId: "tab_b",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    applyPreviewServerSnapshot(ref, first);
    applyPreviewServerSnapshot(ref, second);

    beginPreviewSessionClose(ref, second.tabId);

    const state = readThreadPreviewState(ref);
    expect(Object.keys(state.sessions)).toEqual([first.tabId]);
    expect(state.activeTabId).toBe(first.tabId);
    expect(state.snapshot?.tabId).toBe(first.tabId);
  });

  it("treats a late server close event after optimistic removal as a no-op", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    beginPreviewSessionClose(ref, snapshot.tabId);

    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.snapshot).toBeNull();
  });

  it("does not resurrect an intentionally closed tab from a stale list snapshot", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    beginPreviewSessionClose(ref, snapshot.tabId);

    applyPreviewServerSnapshot(ref, snapshot);

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.snapshot).toBeNull();
  });

  it("can restore a suppressed tab after a failed close", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    beginPreviewSessionClose(ref, snapshot.tabId);

    cancelPreviewSessionClose(ref, snapshot, snapshot.tabId);

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({ [snapshot.tabId]: snapshot });
    expect(state.snapshot).toEqual(snapshot);
  });

  it("does not publish duplicate desktop browser state", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerSnapshot(ref, snapshot);
    const overlay = {
      hasWebContents: true,
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system" as const,
      audioMuted: false,
      audible: false,
      controller: "none" as const,
      favicon: {
        dataUrl: "data:image/png;base64,AA==",
        pageUrl: "https://example.com",
        capturedAt: 1,
      },
    };
    let updateCount = 0;
    const unsubscribe = appAtomRegistry.subscribe(previewStateAtom(scopedThreadKey(ref)), () => {
      updateCount += 1;
    });

    applyPreviewDesktopState(ref, snapshot.tabId, overlay);
    applyPreviewDesktopState(ref, snapshot.tabId, { ...overlay, favicon: { ...overlay.favicon } });
    unsubscribe();

    expect(updateCount).toBe(1);
  });

  it("retains multiple tabs and switches active desktop state", () => {
    const first = makeSnapshot();
    const second = { ...makeSnapshot(), tabId: "tab_2", updatedAt: "2026-01-02T00:00:00.000Z" };
    applyPreviewServerSnapshot(ref, first);
    applyPreviewServerSnapshot(ref, second);
    applyPreviewDesktopState(ref, first.tabId, {
      hasWebContents: true,
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "none",
      favicon: null,
    });
    setActivePreviewTab(ref, first.tabId);

    const state = readThreadPreviewState(ref);
    expect(Object.keys(state.sessions)).toEqual([first.tabId, second.tabId]);
    expect(state.snapshot?.tabId).toBe(first.tabId);
    expect(state.desktopOverlay?.canGoBack).toBe(true);
  });

  it("reconciles an authoritative session list without focusing a background tab", () => {
    const active = makeSnapshot({ tabId: "tab_a" });
    const stale = makeSnapshot({
      tabId: "tab_stale",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    applyPreviewServerSnapshot(ref, stale);
    applyPreviewServerSnapshot(ref, active);
    applyPreviewDesktopState(ref, stale.tabId, {
      hasWebContents: true,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "none",
      favicon: null,
    });

    reconcilePreviewServerSessions(ref, { sessions: [active], serverEpoch, revision: 1 });

    const state = readThreadPreviewState(ref);
    expect(Object.keys(state.sessions)).toEqual([active.tabId]);
    expect(state.activeTabId).toBe(active.tabId);
    expect(state.snapshot).toEqual(active);
    expect(state.desktopByTabId[stale.tabId]).toBeUndefined();
  });

  it("keeps the state object when a refetched list changes nothing", () => {
    reconcilePreviewServerSessions(ref, { sessions: [], serverEpoch, revision: 1 });
    const loaded = readThreadPreviewState(ref);

    reconcilePreviewServerSessions(ref, { sessions: [], serverEpoch, revision: 1 });
    expect(readThreadPreviewState(ref)).toBe(loaded);

    const snapshot = makeSnapshot();
    reconcilePreviewServerSessions(ref, { sessions: [snapshot], serverEpoch, revision: 2 });
    expect(readThreadPreviewState(ref).sessions).toEqual({ [snapshot.tabId]: snapshot });
  });

  it("reconciles a global resync after missed closes and ignores older events", () => {
    const stale = makeSnapshot({ tabId: "tab_stale" });
    const current = makeSnapshot({ tabId: "tab_current", updatedAt: "2026-01-01T00:00:01.000Z" });
    const other = makeSnapshot({ threadId: "thread-2", tabId: "tab_other" });
    const otherRef = scopeThreadRef(environmentId, ThreadId.make(other.threadId));
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: stale.threadId,
      tabId: stale.tabId,
      createdAt: stale.updatedAt,
      snapshot: stale,
    });
    applyPreviewServerEventImpl(ref, {
      type: "resync",
      sessions: [current, other],
      serverEpoch,
      revision: 2,
    });

    expect(readThreadPreviewState(ref).sessions).toEqual({ [current.tabId]: current });
    expect(readThreadPreviewState(ref).serverRevision).toBe(2);
    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: stale.threadId,
      tabId: stale.tabId,
      createdAt: stale.updatedAt,
      snapshot: stale,
      serverEpoch,
      revision: 1,
    });
    expect(readThreadPreviewState(ref).sessions).toEqual({ [current.tabId]: current });

    applyPreviewServerEventImpl(otherRef, {
      type: "resync",
      sessions: [current, other],
      serverEpoch,
      revision: 2,
    });
    expect(readThreadPreviewState(otherRef).sessions).toEqual({ [other.tabId]: other });
  });

  it("ignores a list response older than the latest server event", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });

    reconcilePreviewServerSessions(ref, { sessions: [], serverEpoch, revision: 0 });

    expect(readThreadPreviewState(ref).sessions).toEqual({ [snapshot.tabId]: snapshot });
    expect(readThreadPreviewState(ref).listLoaded).toBe(false);

    const olderTab = makeSnapshot({ tabId: "tab_before_event" });
    reconcilePreviewServerSessions(ref, {
      sessions: [olderTab, snapshot],
      serverEpoch,
      revision: 2,
    });
    expect(readThreadPreviewState(ref).listLoaded).toBe(true);
    expect(readThreadPreviewState(ref).sessions).toEqual({
      [olderTab.tabId]: olderTab,
      [snapshot.tabId]: snapshot,
    });
  });

  it("does not resurrect a tab from an event older than its close", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEvent(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      snapshot,
    });
    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      serverEpoch,
      revision: 1,
      snapshot,
    });

    expect(readThreadPreviewState(ref).sessions).toEqual({});
  });

  it("accepts a lower revision from a newly restarted server", () => {
    const snapshot = makeSnapshot();
    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: snapshot.updatedAt,
      serverEpoch,
      revision: 12,
      snapshot,
    });

    reconcilePreviewServerSessions(ref, {
      sessions: [],
      serverEpoch: "server-b",
      revision: 0,
    });

    const state = readThreadPreviewState(ref);
    expect(state.sessions).toEqual({});
    expect(state.serverEpoch).toBe("server-b");
    expect(state.serverRevision).toBe(0);
  });

  it("does not carry raw-tab state across a server restart", () => {
    const previous = makeSnapshot({
      navStatus: { _tag: "Success", url: "https://old.example", title: "Old" },
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
    applyPreviewServerEventImpl(ref, {
      type: "opened",
      threadId: "thread-1",
      tabId: previous.tabId,
      createdAt: previous.updatedAt,
      serverEpoch,
      revision: 12,
      snapshot: previous,
    });
    beginPreviewSessionClose(ref, previous.tabId);
    applyPreviewDesktopState(ref, previous.tabId, {
      hasWebContents: true,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      zoomFactor: 1,
      pictureInPicture: false,
      colorScheme: "system",
      audioMuted: false,
      audible: false,
      controller: "none",
      favicon: null,
    });
    const restarted = makeSnapshot({
      navStatus: { _tag: "Success", url: "https://new.example", title: "New" },
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    reconcilePreviewServerSessions(ref, {
      sessions: [restarted],
      serverEpoch: "server-b",
      revision: 0,
    });

    const state = readThreadPreviewState(ref);
    expect(state.sessions[restarted.tabId]).toEqual(restarted);
    expect(state.suppressedTabIds).toEqual(new Set());
    expect(state.desktopByTabId).toEqual({});
    expect(state.desktopOverlay).toBeNull();
  });

  it("does not replace a streamed snapshot with older SWR data", () => {
    applyPreviewServerSnapshot(
      ref,
      makeSnapshot({
        navStatus: { _tag: "Success", url: "http://localhost:5173/new", title: "New" },
        updatedAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    applyPreviewServerSnapshot(
      ref,
      makeSnapshot({
        navStatus: { _tag: "Success", url: "http://localhost:5173/old", title: "Old" },
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    const state = readThreadPreviewState(ref);
    expect(state.snapshot?.navStatus).toEqual({
      _tag: "Success",
      url: "http://localhost:5173/new",
      title: "New",
    });
  });
});

describe("native preview state isolation", () => {
  it("does not import another canonical session's tab or viewport through snapshots or events", () => {
    const target = {
      environmentId,
      ref: {
        providerInstanceId: ProviderInstanceId.make("profile-a"),
        sessionFile: "/sessions/a.jsonl",
      },
    };
    const other = { ...target, ref: { ...target.ref, sessionFile: "/sessions/b.jsonl" } };
    const ownSnapshot = makeSnapshot({ threadId: workspaceResourceId(target) });
    const otherSnapshot = makeSnapshot({
      threadId: workspaceResourceId(other),
      viewport: { _tag: "freeform", width: 400, height: 300 },
    });
    applyPreviewServerSnapshot(target, ownSnapshot);
    applyPreviewServerSnapshot(other, otherSnapshot);
    updatePreviewServerSnapshot(target, otherSnapshot);
    applyPreviewServerEventImpl(target, {
      type: "resized",
      threadId: workspaceResourceId(other),
      tabId: otherSnapshot.tabId,
      snapshot: otherSnapshot,
      createdAt: otherSnapshot.updatedAt,
      serverEpoch,
      revision: 1,
    });
    reconcilePreviewServerSessions(target, {
      serverEpoch,
      revision: 2,
      sessions: [ownSnapshot, { ...otherSnapshot, tabId: "foreign-tab" }],
    });
    expect(readThreadPreviewState(target).sessions).toEqual({ tab_a: ownSnapshot });
    expect(readThreadPreviewState(other).sessions).toEqual({ tab_a: otherSnapshot });
    beginPreviewSessionClose(target, ownSnapshot.tabId);
    expect(readThreadPreviewState(target).snapshot).toBeNull();
    expect(readThreadPreviewState(other).snapshot).toEqual(otherSnapshot);
  });
});

describe("preview state lifetime", () => {
  beforeEach(() => {
    appAtomRegistry.reset();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    resetPreviewStateForTests();
    appAtomRegistry.reset();
    // Registry disposal queues removals; finish them before replacing its scheduler's timers.
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it("releases idle state for both changed and merely visited workspaces", async () => {
    const stopRecording = startPreviewTitleRecording();
    try {
      const visited = Array.from({ length: 200 }, (_, index) =>
        scopeThreadRef(environmentId, ThreadId.make(`idle-${index}`)),
      );
      const atoms = visited.map((workspace, index) => {
        if (index % 2 === 0) rememberPreviewUrl(workspace, `http://localhost:${5000 + index}/`);
        else readThreadPreviewState(workspace);
        return previewStateAtom(scopedThreadKey(workspace));
      });

      expect(appAtomRegistry.get(previewThreadRefsAtom).size).toBe(0);
      await vi.runAllTimersAsync();

      expect(atoms.every((atom) => !appAtomRegistry.getNodes().has(atom))).toBe(true);
      expect(readThreadPreviewState(visited[0]!)).toEqual(__testing.EMPTY_THREAD_PREVIEW_STATE);
    } finally {
      stopRecording();
    }
  });

  it("keeps live background sessions without a mounted preview host and releases them on close", async () => {
    const snapshot = makeSnapshot();
    const atom = previewStateAtom(scopedThreadKey(ref));
    const stopRecording = startPreviewTitleRecording();
    try {
      applyPreviewServerSnapshot(ref, snapshot);
      await vi.runAllTimersAsync();
      expect(appAtomRegistry.getNodes().has(atom)).toBe(true);
      expect(readThreadPreviewState(ref).snapshot).toEqual(snapshot);
      expect(appAtomRegistry.get(previewThreadRefsAtom).get(scopedThreadKey(ref))).toEqual(ref);

      applyPreviewServerEvent(ref, {
        type: "closed",
        threadId: "thread-1",
        tabId: snapshot.tabId,
        createdAt: "2026-01-01T00:00:01.000Z",
      });
      await vi.runAllTimersAsync();
      expect(appAtomRegistry.getNodes().has(atom)).toBe(false);
      expect(appAtomRegistry.get(previewThreadRefsAtom).has(scopedThreadKey(ref))).toBe(false);
    } finally {
      stopRecording();
    }
  });

  it("retains optimistic close tombstones until the close receipt arrives", async () => {
    const snapshot = makeSnapshot();
    const atom = previewStateAtom(scopedThreadKey(ref));
    applyPreviewServerSnapshot(ref, snapshot);
    beginPreviewSessionClose(ref, snapshot.tabId);
    await vi.runAllTimersAsync();
    expect(appAtomRegistry.getNodes().has(atom)).toBe(true);
    applyPreviewServerSnapshot(ref, snapshot);
    expect(readThreadPreviewState(ref).snapshot).toBeNull();
    expect(readThreadPreviewState(ref).suppressedTabIds.has(snapshot.tabId)).toBe(true);

    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: snapshot.tabId,
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await vi.runAllTimersAsync();
    expect(appAtomRegistry.getNodes().has(atom)).toBe(false);
  });

  it("preserves an idle workspace while it is being viewed, then expires after unmount", async () => {
    const atom = previewStateAtom(scopedThreadKey(ref));
    const unmount = appAtomRegistry.mount(atom);
    rememberPreviewUrl(ref, "http://localhost:5173/");
    await vi.runAllTimersAsync();
    expect(readThreadPreviewState(ref).recentlySeenUrls).toEqual(["http://localhost:5173/"]);

    unmount();
    await vi.runAllTimersAsync();
    expect(appAtomRegistry.getNodes().has(atom)).toBe(false);
  });
});
