import {
  type PreviewCloseInput,
  type PreviewEvent,
  type PreviewError,
  PreviewInvalidUrlError,
  type PreviewListInput,
  type PreviewListResult,
  type PreviewOpenInput,
  type PreviewReportStatusInput,
  type PreviewResizeInput,
  type PreviewAdjustInput,
  FILL_PREVIEW_VIEWPORT,
  PreviewSessionLookupError,
  PreviewWorkspaceContextError,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import {
  isPreviewUrlNormalizationError,
  newPreviewTabId,
  normalizePreviewUrl,
} from "@t3tools/shared/preview";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { PreviewControlRequiredError } from "@t3tools/contracts";

import { nativeWorkspaceResourceId } from "@t3tools/shared/neopiWorkspace";
import { boundedEventStream } from "../boundedEventStream.ts";

export class PreviewManager extends Context.Service<
  PreviewManager,
  {
    readonly open: (
      input: PreviewOpenInput & {
        readonly automationOwner?: string;
        /** Runs before the `opened` event publishes, so subscribers find state keyed by the tab. */
        readonly beforePublish?: (snapshot: PreviewSessionSnapshot) => void;
      },
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly reportStatus: (
      input: PreviewReportStatusInput & { readonly serverControlled?: boolean },
    ) => Effect.Effect<void, PreviewError>;
    /** Records that a server tab runs headless. It stays headless until it closes. */
    readonly markHeadless: (
      input: PreviewCloseInput & { readonly tabId: string },
    ) => Effect.Effect<void, PreviewError>;
    readonly requestReveal: (
      input: PreviewCloseInput & { readonly tabId: string; readonly force: boolean },
    ) => Effect.Effect<void, PreviewError>;
    readonly resize: (
      input: PreviewResizeInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly adjust: (
      input: PreviewAdjustInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly close: (input: PreviewCloseInput) => Effect.Effect<void, PreviewError>;
    readonly list: (input: PreviewListInput) => Effect.Effect<PreviewListResult>;
    readonly events: Stream.Stream<PreviewEvent>;
    readonly subscribe: (
      listener: (event: PreviewMutationEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;
  }
>()("t3/preview/Manager/PreviewManager") {}

interface PreviewSessionState {
  readonly threadId: string;
  readonly tabId: string;
  readonly snapshot: PreviewSessionSnapshot;
}

interface ManagerState {
  readonly sessions: ReadonlyMap<string, PreviewSessionState>;
  readonly revision: number;
}

const initialState: ManagerState = { sessions: new Map(), revision: 0 };

type PreviewMutationEvent = Exclude<PreviewEvent, { readonly type: "resync" }>;
type PreviewResyncEvent = Extract<PreviewEvent, { readonly type: "resync" }>;
type PreviewEventDraft = PreviewMutationEvent extends infer Event
  ? Event extends { readonly revision: number }
    ? Omit<Event, "revision" | "serverEpoch">
    : never
  : never;

const compositeKey = (threadId: string, tabId: string): string => `${threadId}\u0000${tabId}`;

const sessionsForThread = (
  state: ManagerState,
  threadId: string,
): ReadonlyArray<PreviewSessionState> => {
  const out: PreviewSessionState[] = [];
  for (const session of state.sessions.values()) {
    if (session.threadId === threadId) out.push(session);
  }
  return out;
};

function retainedPreviewEventBytes(event: PreviewMutationEvent): number {
  let chars =
    event.threadId.length + event.tabId.length + event.createdAt.length + event.serverEpoch.length;
  chars +=
    (event.sessionRef?.providerInstanceId.length ?? 0) +
    (event.sessionRef?.sessionFile.length ?? 0);
  if (event.type === "failed") {
    chars += event.url.length + event.title.length + event.description.length;
  } else if ("snapshot" in event) {
    const snapshot = event.snapshot;
    chars +=
      snapshot.threadId.length +
      snapshot.tabId.length +
      snapshot.updatedAt.length +
      (snapshot.profileId?.length ?? 0) +
      (snapshot.automationOwner?.length ?? 0) +
      (snapshot.revealRequest?.id.length ?? 0);
    chars +=
      (snapshot.sessionRef?.providerInstanceId.length ?? 0) +
      (snapshot.sessionRef?.sessionFile.length ?? 0);
    const status = snapshot.navStatus;
    if (status._tag !== "Idle") {
      chars += status.url.length + status.title.length;
      if (status._tag === "LoadFailed") chars += status.description.length;
    }
  }
  // UTF-16 upper-bound plus object overhead: no serialization on the writer path.
  return 256 + 2 * chars;
}

const normalizeUrl = (rawUrl: string): Effect.Effect<string, PreviewInvalidUrlError> =>
  Effect.try({
    try: () => normalizePreviewUrl(rawUrl),
    catch: (cause) => {
      if (isPreviewUrlNormalizationError(cause)) {
        return new PreviewInvalidUrlError({
          inputLength: cause.inputLength,
          reason: cause.reason,
          protocol: cause.protocol,
          cause,
        });
      }

      return new PreviewInvalidUrlError({
        inputLength: rawUrl.length,
        reason: "unexpected",
        cause,
      });
    },
  });

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** @public */
export const make = Effect.gen(function* PreviewManagerMake() {
  const random = yield* SecureRandom.SecureRandom;
  const serverEpoch = yield* random.uuidV4();
  const stateRef = yield* SynchronizedRef.make<ManagerState>(initialState);
  const listeners = new Set<(event: PreviewMutationEvent) => Effect.Effect<void>>();
  const subscribe: PreviewManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    });
  const publish = (event: PreviewMutationEvent) =>
    Effect.forEach(listeners, (listener) => listener(event), { discard: true });
  const resync = SynchronizedRef.get(stateRef).pipe(
    Effect.map((state): ReadonlyArray<PreviewResyncEvent> => [
      {
        type: "resync",
        sessions: Array.from(state.sessions.values(), (session) => session.snapshot),
        serverEpoch,
        revision: state.revision,
      },
    ]),
  );
  const events: Stream.Stream<PreviewEvent> = Stream.suspend(() => {
    let revision = -1;
    return boundedEventStream(subscribe, resync, retainedPreviewEventBytes).pipe(
      Stream.filter((event) => {
        if (event.revision <= revision) return false;
        revision = event.revision;
        return true;
      }),
    );
  });

  // Publish inside the state lock; subscriber-local bounded FIFOs never await consumers.
  const mutateExistingSession = <R, E>(
    threadId: string,
    tabId: string,
    mutator: (
      session: PreviewSessionState,
    ) => Effect.Effect<{ next: PreviewSessionState; emit: PreviewEventDraft | null; result: R }, E>,
  ): Effect.Effect<R, E | PreviewSessionLookupError> => {
    type ModifyResult =
      | { kind: "fail"; error: PreviewSessionLookupError }
      | { kind: "ok"; result: R };

    return SynchronizedRef.modifyEffect(stateRef, (state) => {
      const session = state.sessions.get(compositeKey(threadId, tabId));
      if (!session) {
        return Effect.succeed([
          { kind: "fail", error: new PreviewSessionLookupError({ threadId, tabId }) },
          state,
        ] as readonly [ModifyResult, ManagerState]);
      }
      return mutator(session).pipe(
        Effect.flatMap(
          Effect.fn("PreviewManager.commitMutation")(function* ({ next, emit, result }) {
            const revision = emit ? state.revision + 1 : state.revision;
            if (emit) {
              yield* publish({
                ...emit,
                ...(next.snapshot.sessionRef === undefined
                  ? {}
                  : { sessionRef: next.snapshot.sessionRef }),
                revision,
                serverEpoch,
              } as PreviewMutationEvent);
            }
            const sessions = new Map(state.sessions);
            sessions.set(compositeKey(threadId, tabId), next);
            return [{ kind: "ok", result } as ModifyResult, { sessions, revision }] as readonly [
              ModifyResult,
              ManagerState,
            ];
          }),
        ),
      );
    }).pipe(
      Effect.flatMap((modify) =>
        modify.kind === "fail" ? Effect.fail(modify.error) : Effect.succeed(modify.result),
      ),
    );
  };

  const open: PreviewManager["Service"]["open"] = Effect.fn("PreviewManager.open")(
    function* (input) {
      if (
        input.sessionRef === undefined
          ? input.threadId.startsWith("native:")
          : input.threadId !== nativeWorkspaceResourceId(input.sessionRef)
      ) {
        return yield* new PreviewWorkspaceContextError({
          threadId: input.threadId,
          cause: new Error("The preview resource does not match its native session."),
        });
      }
      const runtime = input.runtime;
      // Persisted client surfaces must not bind to a different tab after a server restart.
      const tabId = `${newPreviewTabId()}${runtime === "server" ? `_${serverEpoch}` : ""}`;
      const updatedAt = yield* currentIsoTimestamp;
      const snapshot: PreviewSessionSnapshot = {
        threadId: input.threadId,
        ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
        tabId,
        navStatus: input.url
          ? { _tag: "Loading", url: yield* normalizeUrl(input.url), title: "" }
          : { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        viewport: input.viewport ?? FILL_PREVIEW_VIEWPORT,
        ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
        ...(runtime === undefined ? {} : { runtime }),
        ...(runtime === "server" && input.automationOwner !== undefined
          ? { automationOwner: input.automationOwner }
          : {}),
        ...(input.reveal === undefined ? {} : { reveal: input.reveal }),
        updatedAt,
      };
      yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
        Effect.gen(function* () {
          const revision = state.revision + 1;
          const sessions = new Map(state.sessions);
          sessions.set(compositeKey(input.threadId, tabId), {
            threadId: input.threadId,
            tabId,
            snapshot,
          });
          input.beforePublish?.(snapshot);
          yield* publish({
            type: "opened",
            threadId: input.threadId,
            ...(snapshot.sessionRef === undefined ? {} : { sessionRef: snapshot.sessionRef }),
            tabId,
            createdAt: snapshot.updatedAt,
            serverEpoch,
            revision,
            snapshot,
          });
          return [snapshot, { sessions, revision }] as const;
        }),
      );
      return snapshot;
    },
  );

  const reportStatus: PreviewManager["Service"]["reportStatus"] = Effect.fn(
    "PreviewManager.reportStatus",
  )(function* (input) {
    yield* mutateExistingSession(
      input.threadId,
      input.tabId,
      Effect.fn("PreviewManager.reportSessionStatus")(function* (session) {
        if (session.snapshot.runtime === "server" && !input.serverControlled)
          return yield* new PreviewControlRequiredError({ tabId: input.tabId });
        const updatedAt = yield* currentIsoTimestamp;
        const snapshot: PreviewSessionSnapshot = {
          ...session.snapshot,
          navStatus: input.navStatus,
          canGoBack: input.canGoBack,
          canGoForward: input.canGoForward,
          viewport: session.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
          updatedAt,
        };
        const emit: PreviewEventDraft =
          input.navStatus._tag === "LoadFailed"
            ? {
                type: "failed",
                threadId: session.threadId,
                tabId: session.tabId,
                createdAt: snapshot.updatedAt,
                url: input.navStatus.url,
                title: input.navStatus.title,
                code: input.navStatus.code,
                description: input.navStatus.description,
                ...(input.navStatus.download === undefined
                  ? {}
                  : { download: input.navStatus.download }),
              }
            : {
                type: "navigated",
                threadId: session.threadId,
                tabId: session.tabId,
                createdAt: snapshot.updatedAt,
                snapshot,
              };
        return {
          next: { ...session, snapshot },
          emit,
          result: undefined as void,
        };
      }),
    );
  });

  const markHeadless: PreviewManager["Service"]["markHeadless"] = Effect.fn(
    "PreviewManager.markHeadless",
  )(function* (input) {
    return yield* mutateExistingSession(
      input.threadId,
      input.tabId,
      Effect.fn("PreviewManager.markSessionHeadless")(function* (session) {
        if (session.snapshot.headless) return { next: session, emit: null, result: undefined };
        const snapshot: PreviewSessionSnapshot = {
          ...session.snapshot,
          headless: true,
          updatedAt: yield* currentIsoTimestamp,
        };
        return {
          next: { ...session, snapshot },
          emit: {
            type: "resized",
            threadId: session.threadId,
            tabId: session.tabId,
            createdAt: snapshot.updatedAt,
            snapshot,
          },
          result: undefined,
        };
      }),
    );
  });

  const resize: PreviewManager["Service"]["resize"] = Effect.fn("PreviewManager.resize")(
    function* (input) {
      return yield* mutateExistingSession(
        input.threadId,
        input.tabId,
        Effect.fn("PreviewManager.resizeSession")(function* (session) {
          const updatedAt = yield* currentIsoTimestamp;
          const snapshot: PreviewSessionSnapshot = {
            ...session.snapshot,
            viewport: input.viewport,
            updatedAt,
          };
          return {
            next: { ...session, snapshot },
            emit: {
              type: "resized",
              threadId: session.threadId,
              tabId: session.tabId,
              createdAt: snapshot.updatedAt,
              snapshot,
            },
            result: snapshot,
          };
        }),
      );
    },
  );

  const adjust: PreviewManager["Service"]["adjust"] = Effect.fn("PreviewManager.adjust")(
    function* (input) {
      return yield* mutateExistingSession(
        input.threadId,
        input.tabId,
        Effect.fn("PreviewManager.adjustSession")(function* (session) {
          const updatedAt = yield* currentIsoTimestamp;
          const snapshot: PreviewSessionSnapshot = {
            ...session.snapshot,
            ...(input.colorScheme === undefined ? {} : { colorScheme: input.colorScheme }),
            ...(input.zoomFactor === undefined ? {} : { zoomFactor: input.zoomFactor }),
            updatedAt,
          };
          const request =
            input.hardReload || input.clear
              ? {
                  request: {
                    ...(input.hardReload ? { hardReload: true } : {}),
                    ...(input.clear ? { clear: input.clear } : {}),
                  },
                }
              : {};
          return {
            next: { ...session, snapshot },
            emit: {
              ...request,
              type: "resized",
              threadId: session.threadId,
              tabId: session.tabId,
              createdAt: snapshot.updatedAt,
              snapshot,
            },
            result: snapshot,
          };
        }),
      );
    },
  );

  const close: PreviewManager["Service"]["close"] = Effect.fn("PreviewManager.close")(
    function* (input) {
      const createdAt = yield* currentIsoTimestamp;
      yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
        const eventsToEmit: PreviewMutationEvent[] = [];
        const sessions = new Map(state.sessions);
        const targets = input.tabId
          ? [state.sessions.get(compositeKey(input.threadId, input.tabId))].filter(
              (entry): entry is PreviewSessionState => entry !== undefined,
            )
          : sessionsForThread(state, input.threadId);
        let revision = state.revision;
        for (const target of targets) {
          revision += 1;
          sessions.delete(compositeKey(target.threadId, target.tabId));
          eventsToEmit.push({
            type: "closed",
            threadId: target.threadId,
            ...(target.snapshot.sessionRef === undefined
              ? {}
              : { sessionRef: target.snapshot.sessionRef }),
            tabId: target.tabId,
            createdAt,
            serverEpoch,
            revision,
          });
        }
        if (eventsToEmit.length === 0) {
          return Effect.succeed([undefined, state] as const);
        }
        return Effect.as(Effect.forEach(eventsToEmit, publish, { discard: true }), [
          undefined,
          { sessions, revision },
        ] as const);
      });
    },
  );

  const list: PreviewManager["Service"]["list"] = Effect.fn("PreviewManager.list")(
    function* (input) {
      return yield* SynchronizedRef.get(stateRef).pipe(
        Effect.map((state): PreviewListResult => ({
          sessions: sessionsForThread(state, input.threadId)
            .map((s) => s.snapshot)
            .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
          serverEpoch,
          revision: state.revision,
        })),
      );
    },
  );

  const requestReveal: PreviewManager["Service"]["requestReveal"] = Effect.fn(
    "PreviewManager.requestReveal",
  )(function* (input) {
    yield* mutateExistingSession(
      input.threadId,
      input.tabId,
      Effect.fn("PreviewManager.revealSession")(function* (session) {
        const snapshot = {
          ...session.snapshot,
          reveal: true,
          revealRequest: {
            id: yield* random.uuidV4(),
            force: input.force,
          },
          updatedAt: yield* currentIsoTimestamp,
        };
        return {
          next: { ...session, snapshot },
          emit: {
            type: "navigated" as const,
            threadId: session.threadId,
            tabId: session.tabId,
            createdAt: snapshot.updatedAt,
            snapshot,
          },
          result: undefined,
        };
      }),
    );
  });

  return PreviewManager.of({
    open,
    requestReveal,
    reportStatus,
    markHeadless,
    resize,
    adjust,
    close,
    list,
    events,
    subscribe,
  });
}).pipe(Effect.withSpan("PreviewManager.make"));

export const layer = Layer.effect(PreviewManager, make);
