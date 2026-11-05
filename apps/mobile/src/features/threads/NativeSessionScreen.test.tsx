// @vitest-environment jsdom

import { act, useCallback, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import { CommonActions, StackRouter } from "@react-navigation/native";
import {
  EnvironmentId,
  ProviderInstanceId,
  WS_METHODS,
  type NeoPiJournalEntry,
} from "@t3tools/contracts";
import {
  emptyNativeSessionFeed,
  type NativeSession,
  type NativeSessionTarget,
  type NativeSessionUpdate,
  type NativeTranscriptRow,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { createNativeSessionAtoms } from "@t3tools/client-runtime/state/neopi-native-sessions";
import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { EnvironmentRegistry } from "../../../../../packages/client-runtime/src/connection/registry";
import { EnvironmentSupervisor } from "../../../../../packages/client-runtime/src/connection/supervisor";
import type { WsRpcProtocolClient } from "../../../../../packages/client-runtime/src/rpc/protocol";
import type { RpcSession } from "../../../../../packages/client-runtime/src/rpc/session";
import { NativeSessionScreen } from "./NativeSessionScreen";

type Router = ReturnType<typeof StackRouter>;
type Action = Parameters<Router["getStateForAction"]>[1];
const fixture = vi.hoisted(() => ({
  current: undefined as Effect.Success<ReturnType<typeof makeHarness>> | undefined,
  draftText: "",
  navigation: undefined as
    | {
        navigate: (name: string, params?: object) => void;
        dispatch: (action: Action) => void;
        addListener: () => () => void;
      }
    | undefined,
}));

// Keep the installed router/actions, replacing only the native navigation hook.
// Resolve through native's own dependency graph, without adding a direct router
// dependency or importing React Native's platform entry into the DOM harness.
vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const nativeRequire = createRequire(import.meta.resolve("@react-navigation/native"));
  const coreRequire = createRequire(nativeRequire.resolve("@react-navigation/core"));
  const routers = await import(
    pathToFileURL(coreRequire.resolve("@react-navigation/routers")).href
  );
  return { ...routers, useNavigation: () => fixture.navigation };
});

// This is only the React adapter: registry subscription, watch boundary,
// refresh, cache, transport requests and close commands are all production atoms.
vi.mock("../../state/neopiNativeSessions", () => ({
  get nativeSessionAtoms() {
    return fixture.current!.atoms;
  },
  useNativeSession(target: NativeSessionTarget) {
    const { atoms, registry } = fixture.current!;
    const watch = atoms.watch({ environmentId: target.environmentId, input: { ref: target.ref } });
    const subscribe = useCallback(
      (notify: () => void) => registry.subscribe(watch, notify),
      [registry, watch],
    );
    const snapshot = useCallback(() => registry.get(watch), [registry, watch]);
    const result = useSyncExternalStore(subscribe, snapshot, snapshot);
    const request = useCallback(
      async (command: Record<string, unknown> & { type: string }) => {
        const reply = await atoms.request.run(registry, {
          environmentId: target.environmentId,
          input: { ref: target.ref, command },
        });
        if (reply._tag === "Failure") throw Cause.squash(reply.cause);
        return reply.value;
      },
      [atoms, registry, target],
    );
    const feed = AsyncResult.isSuccess(result)
      ? result.value
      : (atoms.cached(target) ?? emptyNativeSessionFeed());
    return {
      feed,
      request,
      error: AsyncResult.isFailure(result) ? String(Cause.squash(result.cause)) : feed.error,
    };
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand<W, A, E>(command: AtomCommand<W, A, E>) {
    const { registry } = fixture.current!;
    return useCallback((input: W) => command.run(registry, input), [command, registry]);
  },
}));

// Native visuals and unrelated composer persistence are outside this regression.
// In particular, both exit handlers below are supplied by the real screen.
vi.mock("react-native", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Platform: { OS: "android" },
    View: Box,
    ScrollView: Box,
    KeyboardAvoidingView: Box,
    FlatList: forwardRef<
      { scrollToEnd: () => void },
      {
        data: readonly NativeTranscriptRow[];
        renderItem: (info: { item: NativeTranscriptRow }) => ReactNode;
        keyExtractor: (item: NativeTranscriptRow) => string;
        ListHeaderComponent?: ReactNode;
      }
    >(function FlatList({ data, renderItem, keyExtractor, ListHeaderComponent }, ref) {
      useImperativeHandle(ref, () => ({ scrollToEnd: () => {} }), []);
      return (
        <div>
          {ListHeaderComponent}
          {data.map((item) => (
            <div key={keyExtractor(item)}>{renderItem({ item })}</div>
          ))}
        </div>
      );
    }),
  };
});
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/MaterialButton", () => ({
  MaterialButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ScreenHeader", () => ({
  ScreenHeader: ({ title, onBack }: { title: string; onBack: () => void }) => (
    <header>
      <button onClick={onBack}>Back</button>
      {title}
    </header>
  ),
}));
vi.mock("../../state/use-native-composer-state", () => ({
  useNativeComposerState: () => ({
    key: "unused-draft",
    draft: { text: fixture.draftText },
    setText: (text: string) => {
      fixture.draftText = text;
    },
    send: vi.fn(),
  }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  setComposerDraftText: vi.fn(),
  waitForComposerDraftsLoaded: vi.fn(),
}));
vi.mock("./NativeSessionComposer", () => ({ NativeSessionComposer: () => null }));
vi.mock("./NativeSessionWorkspaceControls", () => ({
  NativeSessionWorkspaceControls: () => null,
  NativeSessionAgents: () => null,
}));
vi.mock("./NativeNeoPiControls", () => ({
  NativeField: () => null,
  NativeModal: () => null,
  NativeError: ({ message }: { message: string | null }) =>
    message ? <p role="alert">{message}</p> : null,
}));
vi.mock("./NeoPiJournalContent", () => ({
  NeoPiJournalContent: ({ entry }: { entry: NeoPiJournalEntry }) => (
    <span>{JSON.stringify(entry)}</span>
  ),
}));
vi.mock("./NativeCommandOutput", () => ({
  NativeCommandOutput: ({ text }: { text: string }) => <pre>{text}</pre>,
}));
vi.mock("./NativeSessionMobileTree", () => ({ NativeSessionMobileTree: () => null }));
vi.mock("./NeoPiModelsScreen", () => ({ NeoPiModelsEntry: () => null }));

const ref = {
  providerInstanceId: ProviderInstanceId.make("neopi"),
  sessionFile: "/sessions/mobile-retained.jsonl",
};
const session: NativeSession = {
  ref,
  sessionId: "mobile-retained",
  cwd: "/workspace",
  attachment: "terminal",
  capabilities: [],
  state: { sessionName: "Retained conversation" },
};
const user: NeoPiJournalEntry = {
  id: "question",
  parentId: null,
  timestamp: "2026-10-28T00:00:00Z",
  type: "message",
  message: { role: "user", content: "Keep this question after reopening" },
};
const closedReason = "The native connection was explicitly closed.";

const makeHarness = Effect.fnUntraced(function* (
  options: {
    readonly session?: NativeSession;
    readonly request?: (
      command: Record<string, unknown> & { type: string },
    ) => Effect.Effect<unknown>;
  } = {},
) {
  const currentSession = options.session ?? session;
  const active = new Set<Queue.Queue<NativeSessionUpdate>>();
  let watches = 0;
  let closes = 0;
  const publish = (update: NativeSessionUpdate) => {
    for (const events of active) Queue.offerUnsafe(events, update);
  };
  const closeOwner = () => publish({ type: "closed", reason: closedReason });
  const client = {
    [WS_METHODS.neopiNativeSessionsOpen]: () => Effect.succeed(currentSession),
    [WS_METHODS.neopiNativeSessionsClose]: () =>
      Effect.sync(() => {
        closes++;
        closeOwner();
        return { closed: true };
      }),
    [WS_METHODS.neopiNativeSessionsRequest]: (input: {
      command: Record<string, unknown> & { type: string };
    }) =>
      options.request?.(input.command) ??
      Effect.succeed(
        input.command.type === "get_subagents"
          ? { subagents: [] }
          : input.command.type === "get_available_commands"
            ? { commands: [] }
            : {},
      ),
    [WS_METHODS.neopiNativeSessionsWatch]: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<NativeSessionUpdate>();
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              watches++;
              active.add(events);
            }),
            () =>
              Effect.sync(() => {
                active.delete(events);
              }),
          );
          return Stream.concat(
            Stream.succeed<NativeSessionUpdate>({
              type: "snapshot",
              session: currentSession,
              journal: {
                sessionId: session.sessionId,
                sessionFile: ref.sessionFile,
                leafId: user.id,
                entries: [user],
                totalEntries: 1,
              },
            }),
            Stream.fromQueue(events).pipe(Stream.takeUntil((update) => update.type === "closed")),
          );
        }),
      ),
  } as unknown as WsRpcProtocolClient;
  const environmentId = EnvironmentId.make("mobile-retained-listener");
  const connection = { client } as RpcSession;
  const supervisor = EnvironmentSupervisor.of({
    target: { environmentId },
    session: yield* SubscriptionRef.make(Option.some(connection)),
  } as EnvironmentSupervisor["Service"]);
  const environments = EnvironmentRegistry.of({
    run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    followStream: (_id, stream) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"]);
  const atoms = createNativeSessionAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry, environments)),
  );
  // Same controllable task scheduler as the runtime atom lifetime tests. Drain
  // actual dispatchers, not timers, polling, or a fixed number of microtasks.
  const scheduled = new Set<() => void>();
  const registry = AtomRegistry.make({
    scheduleTask: (f) => {
      const task = () => {
        if (scheduled.delete(task)) f();
      };
      scheduled.add(task);
      queueMicrotask(task);
      return () => {
        scheduled.delete(task);
      };
    },
  });
  const flush = () => {
    while (scheduled.size) scheduled.values().next().value!();
  };
  return {
    atoms,
    registry,
    flush,
    publish,
    closeOwner,
    target: { environmentId, ref },
    counts: () => ({ watches, closes, active: active.size }),
  };
});

describe("NativeSessionScreen exit and canonical reselection", () => {
  it.effect.each(["Disconnect session", "Back"])(
    "%s releases the closed watch boundary before reopening the same session",
    (exit) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* Effect.promise(async () => {
          vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
          fixture.current = h;
          const container = document.createElement("div");
          document.body.append(container);
          const root = createRoot(container);
          const router = StackRouter({ initialRouteName: "Home" });
          const options = {
            routeNames: ["Home", "NativeSession"],
            routeParamList: {},
            routeGetIdList: {},
          };
          let state = router.getInitialState(options);
          const render = () => root.render(<RouteHost />);
          const dispatch = (action: Action) => {
            const next = router.getStateForAction(state, action, options);
            if (!next) throw new Error(`Unhandled navigation action: ${action.type}`);
            state = router.getRehydratedState(next, options);
            render();
          };
          fixture.navigation = {
            dispatch,
            navigate: (name, params) => dispatch(CommonActions.navigate(name, params)),
            addListener: () => () => {},
          };
          function RouteHost() {
            // NativeStack keeps every retained route mounted. Only removed route
            // keys unmount their real screen and release its registry listener.
            return state.routes.map((route, index) => (
              <section
                key={route.key}
                hidden={index !== state.index}
                data-focused={index === state.index}
              >
                {route.name === "Home" ? (
                  <h1>Sessions</h1>
                ) : (
                  <NativeSessionScreen
                    route={{
                      params: route.params as {
                        environmentId: string;
                        providerInstanceId: string;
                        sessionFile: string;
                      },
                    }}
                  />
                )}
              </section>
            ));
          }
          const focused = () => container.querySelector<HTMLElement>('[data-focused="true"]')!;
          const selectCanonicalSession = async () => {
            // Match the browser's open-before-navigate flow, using the server's
            // returned canonical ref rather than a different session/route key.
            const opened = await h.atoms.open.run(h.registry, {
              environmentId: h.target.environmentId,
              input: ref,
            });
            expect(opened._tag).toBe("Success");
            if (opened._tag === "Failure") throw Cause.squash(opened.cause);
            fixture.navigation!.navigate("NativeSession", {
              environmentId: h.target.environmentId,
              ...opened.value.ref,
            });
          };
          try {
            await act(async () => {
              render();
              await selectCanonicalSession();
            });
            await act(async () => {
              h.flush();
            });
            expect(focused().textContent).toContain("Keep this question after reopening");
            expect(focused().textContent).not.toContain("Reconnecting");
            await act(async () => {
              h.publish({
                type: "event",
                frame: { type: "command_output", text: "Retained native output" },
              });
              h.flush();
            });
            expect(focused().textContent).toContain("Retained native output");
            expect(h.counts()).toEqual({ watches: 1, closes: 0, active: 1 });

            await act(async () => {
              const button = Array.from(focused().querySelectorAll("button")).find(
                (button) => button.textContent === exit,
              );
              expect(button).toBeDefined();
              button!.click();
            });
            await act(async () => {
              h.flush();
            });
            expect(focused().textContent).toBe("Sessions");
            expect(h.counts().closes).toBe(exit === "Back" ? 0 : 1);
            if (exit === "Back") {
              // Back itself must leave the owner running. Its terminal can close
              // while we're away; a warm observation still records that closure.
              await act(async () => {
                h.closeOwner();
                h.flush();
              });
            }
            expect(h.atoms.cached(h.target)?.error).toBe(closedReason);
            expect(h.counts().active).toBe(0);

            // This drain is essential: idleTTL=0 removes the mount boundary only
            // after its last listener leaves and the disposal dispatcher runs.
            h.flush();
            await act(async () => {
              await selectCanonicalSession();
            });
            await act(async () => {
              h.flush();
            });

            // Bounded RED on navigate('Home'): the retained old screen keeps the
            // closed boundary alive, so the newly focused real screen still shows
            // Reconnecting. Never wait forever for an impossible second watch.
            expect(focused().textContent).not.toContain("Reconnecting");
            expect(focused().textContent).not.toContain(closedReason);
            expect(focused().textContent).toContain("Keep this question after reopening");
            expect(focused().textContent).toContain("Retained native output");
            expect(h.counts()).toEqual({ watches: 2, closes: exit === "Back" ? 0 : 1, active: 1 });
            await act(async () => {
              h.publish({
                type: "event",
                frame: {
                  type: "message_update",
                  messageId: "new-live",
                  message: { role: "assistant", content: "Live after reopening" },
                },
              });
              h.flush();
            });
            expect(focused().textContent).toContain("Live after reopening");
          } finally {
            await act(async () => {
              root.unmount();
            });
            h.registry.dispose();
            h.flush();
            container.remove();
            fixture.current = undefined;
            fixture.navigation = undefined;
            vi.unstubAllGlobals();
          }
        });
      }),
  );
});

describe("NativeSessionScreen command argument completions", () => {
  it.effect("hides results from the previous prefix during debounce and the next request", () =>
    Effect.gen(function* () {
      let resolveNext: ((value: unknown) => void) | undefined;
      const h = yield* makeHarness({
        session: { ...session, capabilities: ["command_completions"] },
        request: (command) => {
          if (command.type === "get_available_commands")
            return Effect.succeed({ commands: [{ name: "personality" }] });
          if (command.type !== "get_command_completions") return Effect.succeed({});
          if (command.prefix === "a")
            return Effect.succeed({
              items: [{ value: "Angel", label: "Angel", submitsCommand: true }],
            });
          return Effect.promise(
            () =>
              new Promise<unknown>((resolve) => {
                resolveNext = resolve;
              }),
          );
        },
      });
      yield* Effect.promise(async () => {
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        fixture.current = h;
        fixture.draftText = "/personality a";
        fixture.navigation = {
          navigate: () => {},
          dispatch: () => {},
          addListener: () => () => {},
        };
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        const route = {
          params: { environmentId: h.target.environmentId, ...ref },
        };
        const render = () => root.render(<NativeSessionScreen route={route} />);
        try {
          await act(async () => {
            await h.atoms.open.run(h.registry, {
              environmentId: h.target.environmentId,
              input: ref,
            });
            render();
          });
          await act(async () => h.flush());
          await act(async () => {
            await vi.advanceTimersByTimeAsync(80);
          });
          expect(container.textContent).toContain("Angel");

          await act(async () => {
            fixture.draftText = "/personality b";
            render();
          });
          expect(container.textContent).not.toContain("Angel");
          expect(resolveNext).toBeUndefined();

          await act(async () => {
            await vi.advanceTimersByTimeAsync(80);
          });
          expect(resolveNext).toBeDefined();
          expect(container.textContent).not.toContain("Angel");
          await act(async () => {
            resolveNext!({ items: [{ value: "Bunny", label: "Bunny", submitsCommand: true }] });
          });
          expect(container.textContent).toContain("Bunny");
          expect(container.textContent).not.toContain("Angel");
        } finally {
          await act(async () => root.unmount());
          h.registry.dispose();
          h.flush();
          container.remove();
          fixture.current = undefined;
          fixture.navigation = undefined;
          fixture.draftText = "";
          vi.useRealTimers();
          vi.unstubAllGlobals();
        }
      });
    }),
  );
});
