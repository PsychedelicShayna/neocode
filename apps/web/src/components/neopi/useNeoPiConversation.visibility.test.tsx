// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ResponseStreamingMode,
} from "@t3tools/contracts";
import type { NativeSessionFeed } from "@t3tools/client-runtime/neopi-native-sessions";
import { createTranscriptProjector } from "@t3tools/client-runtime/neopi-transcript";
import { afterEach, expect, it, vi } from "vite-plus/test";

const control = vi.hoisted(() => ({
  leases: 0,
  purposes: [] as Array<string | undefined>,
  visibility: "visible" as DocumentVisibilityState,
  feed: undefined as NativeSessionFeed | undefined,
  responseStreamingMode: "paragraph" as ResponseStreamingMode,
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/neopiSessions", () => ({ neopiSessionJournal: {} }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => () => Promise.resolve({ _tag: "Failure" }),
}));
vi.mock("../../state/nativeWorkspaceRelocation", () => ({ relocateNativeWorkspace: () => {} }));
vi.mock("./neopiNativeDraft", () => ({ useNativeDraftIdentity: () => {} }));
vi.mock("../chat/ExpandedImageDialog", () => ({ ExpandedImageDialog: () => null }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    responseStreamingMode: control.responseStreamingMode,
  }),
}));
// Keep the actual bound view and native projection; replace only the virtual list.
vi.mock("../chat/MessagesTimeline", () => ({ MessagesTimeline: () => null }));
// The thread's ref resolves at once; the controller's lease is an atom lifetime, as in the
// native session visibility test. The real thread observation atoms compose them. Imports
// are inside the hoisted mock factories because static bindings are not initialized yet.
vi.mock("@t3tools/client-runtime/state/runtime", async (original) => {
  const actual = await original<typeof import("@t3tools/client-runtime/state/runtime")>();
  const { Atom, AsyncResult } = await import("effect/unstable/reactivity");
  const { ProviderInstanceId } = await import("@t3tools/contracts");
  const ref = Atom.make(
    AsyncResult.success({
      status: "available" as const,
      ref: { providerInstanceId: ProviderInstanceId.make("neopi"), sessionFile: "/session" },
      sessionId: "s-1",
      runtime: "gui" as const,
    }),
  ).pipe(Atom.keepAlive);
  return { ...actual, createEnvironmentRpcQueryAtomFamily: () => () => ref };
});
vi.mock("../../state/neopiNativeSessions", async () => {
  const { Atom, AsyncResult } = await import("effect/unstable/reactivity");
  const { emptyNativeSessionFeed } = await import("@t3tools/client-runtime/neopi-native-sessions");
  const lease = Atom.make((get) => {
    control.leases++;
    get.addFinalizer(() => {
      control.leases--;
    });
    return AsyncResult.success(control.feed ?? emptyNativeSessionFeed());
  }).pipe(Atom.setIdleTTL(0));
  const concealed = Atom.make(() => AsyncResult.initial()).pipe(Atom.setIdleTTL(0));
  const visible = () => control.visibility === "visible";
  const { useSyncExternalStore } = await import("react");
  const subscribe = (changed: () => void) => {
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  };
  return {
    usePageVisible: () => useSyncExternalStore(subscribe, visible),
    nativeSessionAtoms: {
      view: (_target: unknown, shown: boolean, purpose?: string) => {
        if (shown) control.purposes.push(purpose);
        return shown ? lease : concealed;
      },
      watch: () => lease,
      cached: () => undefined,
    },
  };
});
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import {
  emptyNativeSessionFeed,
  reduceNativeSessionFeed,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { MessagesTimeline } from "../chat/MessagesTimeline";
import { NativeTimelineView } from "./NativeTimelineView";
import { NeoPiConversation } from "./NeoPiConversation";
import { useThreadNativeObservation } from "./useNeoPiConversation";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
let renderer: ReactTestRenderer | undefined;
function ThreadView() {
  useThreadNativeObservation(threadRef);
  return null;
}
const setVisibility = async (value: DocumentVisibilityState) => {
  await act(async () => {
    control.visibility = value;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // The unsubscribed observation is released a microtask after `act` ends; drain once more.
  await act(async () => {
    await vi.runAllTimersAsync();
  });
};

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
    await vi.runAllTimersAsync();
  });
  control.feed = undefined;
  appAtomRegistry.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("holds a thread lease only while the document is visible, never keyed on focus", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(
      <AppAtomRegistryProvider>
        <ThreadView />
      </AppAtomRegistryProvider>,
    );
    await vi.runAllTimersAsync();
  });
  expect(control.leases).toBe(1);
  expect(control.purposes.every((purpose) => purpose === "thread")).toBe(true);
  await act(async () => {
    window.dispatchEvent(new Event("blur"));
    await vi.runAllTimersAsync();
  });
  expect(control.leases).toBe(1);
  await setVisibility("hidden");
  expect(control.leases).toBe(0);
  await setVisibility("visible");
  expect(control.leases).toBe(1);
});

it.each([
  ["async-work", "token"],
  ["continuation", "token"],
  ["async-work", "paragraph"],
  ["continuation", "paragraph"],
] as const)(
  "matches bound and standalone %s pause presentation in %s mode",
  async (runPause, mode) => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    control.responseStreamingMode = mode;
    const empty = emptyNativeSessionFeed();
    const ready = "Finished paragraph.\n\n";
    const body = `${ready}Incomplete tail`;
    const feed = reduceNativeSessionFeed(
      {
        ...empty,
        busy: true,
        connected: true,
        observer: { phase: "observing", reason: null },
        conversation: {
          ...empty.conversation,
          identity: { sessionId: "s-1", sessionFile: "/session", leafId: null },
          pending: [
            {
              messageId: "prompt",
              message: { role: "user", content: [{ type: "text", text: "Hello" }] },
            },
            {
              messageId: "answer",
              message: {
                role: "assistant",
                content: [{ type: "text", text: body }],
              },
            },
          ],
        },
      },
      {
        type: "status",
        revision: 1,
        live: { state: "busy", isStreaming: false, pendingDialogs: 0, branch: null, runPause },
      },
    );
    control.feed = feed;
    const standaloneRows = createTranscriptProjector()(
      {
        entries: feed.conversation.entries,
        pending: feed.conversation.pending,
        leafId: feed.conversation.identity?.leafId ?? null,
      },
      { debug: false },
    );
    await act(async () => {
      renderer = create(
        <AppAtomRegistryProvider>
          <section id="bound">
            <NeoPiConversation
              threadRef={threadRef}
              projectId={ProjectId.make("project")}
              composerInset={0}
              ownerStatus={undefined}
              onOpenTree={() => {}}
            />
          </section>
          <section id="standalone">
            <NativeTimelineView
              rows={standaloneRows}
              busy={feed.busy}
              runPaused={feed.runPause !== null}
              environmentId={threadRef.environmentId}
              timelineKey="standalone"
              cwd={undefined}
              loadEarlier={null}
              onImageExpand={() => {}}
            />
          </section>
        </AppAtomRegistryProvider>,
      );
      await vi.runAllTimersAsync();
    });
    const presentation = (id: string) => {
      const { timelineEntries, latestTurn, runningTurnId } = renderer!.root
        .findByProps({ id })
        .findByType(MessagesTimeline).props as ComponentProps<typeof MessagesTimeline>;
      const reply = timelineEntries
        .flatMap((entry) => (entry.kind === "message" ? [entry.message] : []))
        .find((message) => message.role === "assistant");
      return {
        text: reply?.text,
        streaming: reply?.streaming,
        turnState: latestTurn?.state,
        running: runningTurnId !== null,
      };
    };
    const standalone = presentation("standalone");
    expect(standalone).toEqual({
      text: mode === "paragraph" ? ready : body,
      streaming: false,
      turnState: "running",
      running: true,
    });
    expect(presentation("bound")).toEqual(standalone);
  },
);
