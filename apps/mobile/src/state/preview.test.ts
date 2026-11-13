import {
  EnvironmentId,
  ThreadId,
  type PreviewEvent,
  type PreviewListResult,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, onTestFinished, vi } from "vite-plus/test";

const sources = vi.hoisted(() => ({
  lists: new Map<string, Atom.Writable<AsyncResult.AsyncResult<PreviewListResult>>>(),
  events: new Map<string, Atom.Writable<AsyncResult.AsyncResult<PreviewEvent>>>(),
}));

vi.mock("@t3tools/client-runtime/state/preview", () => ({
  createPreviewEnvironmentAtoms: () => ({
    list: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) => {
      const source = sources.lists.get(
        scopedThreadKey({
          environmentId: EnvironmentId.make(environmentId),
          threadId: ThreadId.make(input.threadId),
        }),
      );
      if (!source) throw new Error("Missing list source");
      return source;
    },
    events: ({ environmentId }: { environmentId: string }) => {
      const source = sources.events.get(environmentId);
      if (!source) throw new Error("Missing event source");
      return source;
    },
  }),
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./query", () => ({
  useEnvironmentQuery: () => {
    throw new Error("Unexpected query hook");
  },
}));
vi.mock("./session", () => ({
  environmentSession: {},
  usePreparedConnection: () => {
    throw new Error("Unexpected connection hook");
  },
}));

import { threadPreviewTabsAtom } from "./preview";

function snapshot(threadId: string, tabId: string, title: string): PreviewSessionSnapshot {
  return {
    threadId,
    tabId,
    navStatus: { _tag: "Success", url: "https://example.com/", title },
    canGoBack: false,
    canGoForward: false,
    runtime: "server",
    updatedAt: "2026-11-11T10:00:00.000Z",
  };
}

it("scopes authoritative resync snapshots and rejects lists older than the resync", () => {
  sources.lists.clear();
  sources.events.clear();
  const registry = AtomRegistry.make();
  const unmounts: Array<() => void> = [];
  onTestFinished(() => {
    for (const unmount of unmounts) unmount();
    registry.dispose();
    sources.lists.clear();
    sources.events.clear();
  });
  const environmentId = EnvironmentId.make("preview-resync-environment");
  const eventSource = Atom.make<AsyncResult.AsyncResult<PreviewEvent>>(AsyncResult.initial());
  sources.events.set(environmentId, eventSource);
  const watch = (id: string) => {
    const threadId = ThreadId.make(id);
    const key = scopedThreadKey({ environmentId, threadId });
    const listSource = Atom.make<AsyncResult.AsyncResult<PreviewListResult>>(
      AsyncResult.success({
        serverEpoch: "epoch",
        revision: 1,
        sessions: [snapshot(id, `${id}-old`, "Old")],
      }),
    );
    sources.lists.set(key, listSource);
    const atom = threadPreviewTabsAtom(key);
    unmounts.push(registry.mount(atom));
    return { atom, listSource };
  };
  const first = watch("first");
  const second = watch("second");
  expect(registry.get(first.atom).sessions.map((session) => session.tabId)).toEqual(["first-old"]);
  const firstCurrent = snapshot("first", "first-current", "Current");
  const secondCurrent = snapshot("second", "second-current", "Second");
  registry.set(
    eventSource,
    AsyncResult.success({
      type: "resync",
      serverEpoch: "epoch",
      revision: 10,
      sessions: [firstCurrent, secondCurrent],
    }),
  );
  expect(registry.get(first.atom).sessions).toEqual([firstCurrent]);
  expect(registry.get(second.atom).sessions).toEqual([secondCurrent]);

  registry.set(
    first.listSource,
    AsyncResult.success({
      serverEpoch: "epoch",
      revision: 4,
      sessions: [snapshot("first", "first-old", "Stale")],
    }),
  );
  expect(registry.get(first.atom).sessions).toEqual([firstCurrent]);
  const navigated = snapshot("first", "first-current", "Navigated");
  registry.set(
    eventSource,
    AsyncResult.success({
      type: "navigated",
      serverEpoch: "epoch",
      revision: 11,
      threadId: "first",
      tabId: "first-current",
      createdAt: "2026-11-11T10:00:01.000Z",
      snapshot: navigated,
    }),
  );
  expect(registry.get(first.atom).sessions).toEqual([navigated]);
  expect(registry.get(second.atom).sessions).toEqual([secondCurrent]);
  registry.set(
    eventSource,
    AsyncResult.success({
      type: "resync",
      serverEpoch: "epoch",
      revision: 12,
      sessions: [secondCurrent],
    }),
  );
  expect(registry.get(first.atom).sessions).toEqual([]);
  expect(registry.get(second.atom).sessions).toEqual([secondCurrent]);
});
