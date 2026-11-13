import {
  WS_METHODS,
  type NeoPiJournalEntry,
  type NeoPiJournalPage,
  type NeoPiJournalStreamEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import {
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import {
  emptyNativeConversation,
  reduceNativeConversation,
  sameNativeSession,
  type NativeConversation,
  type NativeIdentity,
} from "../neopiConversation.ts";

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export interface NativeConversationFeed {
  readonly conversation: NativeConversation;
  readonly connection: Extract<NeoPiJournalStreamEvent, { type: "connection" }> | null;
  readonly busy: boolean | null;
}
export const emptyNativeConversationFeed = (): NativeConversationFeed => ({
  conversation: emptyNativeConversation(),
  connection: null,
  busy: null,
});

export function applyNativeConversationEvent(
  feed: NativeConversationFeed,
  event: NeoPiJournalStreamEvent,
): NativeConversationFeed {
  const state = feed.conversation;
  if (event.type === "connection")
    return {
      connection: event,
      busy:
        event.status === "connected" && typeof event.state?.isStreaming === "boolean"
          ? event.state.isStreaming
          : null,
      conversation:
        event.status === "connected"
          ? state
          : reduceNativeConversation(state, { type: "disconnect" }),
    };
  if (event.type === "snapshot")
    return { ...feed, conversation: reduceNativeConversation(state, event) };
  const frame = event.event;
  if (frame.type === "agent_start")
    return {
      ...feed,
      busy: true,
      conversation: reduceNativeConversation(state, { type: "turn_started" }),
    };
  if (frame.type === "agent_end") return { ...feed, busy: false };
  let conversation = state;
  if (
    typeof frame.sessionId === "string" &&
    (typeof frame.sessionFile === "string" || frame.sessionFile === null) &&
    (typeof frame.leafId === "string" || frame.leafId === null)
  ) {
    const identity: NativeIdentity = {
      sessionId: frame.sessionId,
      sessionFile: frame.sessionFile,
      leafId: frame.leafId,
    };
    if (
      (frame.type === "message_start" ||
        frame.type === "message_update" ||
        frame.type === "message_end") &&
      !sameNativeSession(state.identity, identity)
    )
      return feed;
    if (frame.type === "journal_state") {
      // A reconnect boundary can predate the page already rendered by the client.
      // Recover durable IDs without moving that hydrated branch backwards.
      if (frame.reason !== "snapshot" || !sameNativeSession(state.identity, identity))
        conversation = reduceNativeConversation(state, { type: "identity", identity });
      if (frame.reason === "snapshot" && Array.isArray(frame.messageEntryIds)) {
        const messageEntryIds = frame.messageEntryIds.flatMap((value) => {
          const pair = record(value);
          return typeof pair.messageId === "string" && typeof pair.entryId === "string"
            ? [{ messageId: pair.messageId, entryId: pair.entryId }]
            : [];
        });
        conversation = reduceNativeConversation(conversation, {
          type: "persistence_snapshot",
          identity,
          messageEntryIds,
        });
      }
    }
    if (frame.type === "journal_entry") {
      const entry = record(frame.entry);
      if (
        typeof entry.id === "string" &&
        typeof entry.type === "string" &&
        typeof entry.timestamp === "string" &&
        (typeof entry.parentId === "string" || entry.parentId === null)
      )
        conversation = reduceNativeConversation(state, {
          type: "entry",
          identity,
          entry: entry as NeoPiJournalEntry,
        });
    }
    if (
      frame.type === "message_persisted" &&
      typeof frame.messageId === "string" &&
      typeof frame.entryId === "string"
    )
      conversation = reduceNativeConversation(state, {
        type: "persisted",
        identity,
        messageId: frame.messageId,
        entryId: frame.entryId,
      });
  }
  if (
    (frame.type === "message_start" ||
      frame.type === "message_update" ||
      frame.type === "message_end") &&
    typeof frame.messageId === "string"
  ) {
    conversation = reduceNativeConversation(state, {
      type: "message",
      messageId: frame.messageId,
      message: record(frame.message),
    });
    if (frame.snapshot === true) return { ...feed, conversation, busy: true };
  }
  return conversation === state ? feed : { ...feed, conversation };
}

interface NativeConversationView extends NativeConversationFeed {
  readonly paging: boolean;
  readonly pagingError: string | null;
}

class NativeConversationReadError extends Schema.TaggedError<NativeConversationReadError>()(
  "NativeConversationReadError",
  { message: Schema.String },
) {}

function conversationView<E>(
  source: Atom.Atom<AsyncResult.AsyncResult<NativeConversationFeed, E>>,
) {
  type ViewResult = AsyncResult.AsyncResult<NativeConversationView, E>;
  const self = Atom.writable<ViewResult, (current: ViewResult) => ViewResult>(
    (get): ViewResult => {
      let sourceEntries: NativeConversation["entries"] | null = null;
      let refreshRevision = -1;
      let recoveryScheduled = false;
      let active = true;
      const recovery = get.registry.schedulerAsync.makeDispatcher();
      get.addFinalizer(() => {
        active = false;
      });
      const project = (result: AsyncResult.AsyncResult<NativeConversationFeed, E>): ViewResult => {
        const previous = get.self<ViewResult>();
        const previousValue = Option.getOrUndefined(Option.flatMap(previous, AsyncResult.value));
        if (AsyncResult.isFailure(result))
          return AsyncResult.failureWithPrevious(result.cause, {
            previous,
            waiting: result.waiting,
          });
        if (!AsyncResult.isSuccess(result))
          return previousValue
            ? AsyncResult.success(previousValue, { waiting: true })
            : AsyncResult.initial(result.waiting);
        const next = result.value.conversation;
        const prior = previousValue?.conversation;
        let conversation = next;
        if (prior && next.identity && sameNativeSession(prior.identity, next.identity)) {
          const unchanged = sourceEntries === next.entries;
          const entries = unchanged
            ? prior.entries
            : reduceNativeConversation(prior, {
                type: "snapshot",
                page: {
                  ...next.identity,
                  sessionFile: next.identity.sessionFile ?? "",
                  entries: next.entries,
                  totalEntries: next.entries.length,
                  ...(next.cursor ? { nextCursor: next.cursor } : {}),
                },
              }).entries;
          const keepCursor =
            prior.identity?.leafId === next.identity.leafId && prior.cursorLeaf === next.cursorLeaf;
          conversation = {
            ...next,
            entries,
            ...(keepCursor ? { cursor: prior.cursor, cursorLeaf: prior.cursorLeaf } : {}),
          };
        }
        sourceEntries = next.entries;
        return AsyncResult.success(
          {
            ...result.value,
            conversation,
            paging: previousValue?.paging ?? false,
            pagingError:
              prior?.identity && next.identity && sameNativeSession(prior.identity, next.identity)
                ? (previousValue?.pagingError ?? null)
                : null,
          },
          result,
        );
      };
      get.subscribe(source, (result) => {
        const next = project(result);
        get.setSelf(next);
        if (
          recoveryScheduled ||
          !AsyncResult.isSuccess(next) ||
          !next.value.conversation.needsSnapshot ||
          !next.value.conversation.identity ||
          next.value.connection?.status !== "connected"
        )
          return;
        recoveryScheduled = true;
        recovery.scheduleTask(() => {
          recoveryScheduled = false;
          if (!active) return;
          const current = Option.flatMap(get.self<ViewResult>(), AsyncResult.value);
          if (Option.isNone(current)) return;
          const { conversation, connection } = current.value;
          if (
            !conversation.identity ||
            !conversation.needsSnapshot ||
            connection?.status !== "connected" ||
            refreshRevision === conversation.revision
          )
            return;
          refreshRevision = conversation.revision;
          get.refresh(source);
        }, 0);
      });
      return project(get.once(source));
    },
    (context, update: (current: ViewResult) => ViewResult) =>
      context.setSelf(update(context.get(self))),
    (refresh) => refresh(source),
  ).pipe(Atom.setIdleTTL(0));
  return self;
}

/** Reduce every frame before React observes the atom, including frames in one render batch. */
export function createNeoPiConversationAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const source = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:neopi-sessions:journal-live",
    tag: WS_METHODS.neopiSessionsWatchJournal,
    idleTtlMs: 0,
    transform: (stream) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          return SubscriptionRef.changes(supervisor.session).pipe(
            Stream.switchMap((session) => {
              const current = Option.getOrNull(session);
              const disconnected: NeoPiJournalStreamEvent = {
                type: "connection",
                status: "disconnected",
                ownership: "unknown",
                canNavigate: false,
                reason: "Reconnect to follow native conversation changes.",
              };
              const initial = Stream.succeed({ session: current, event: disconnected });
              return current === null
                ? initial
                : initial.pipe(
                    Stream.concat(
                      stream.pipe(Stream.map((event) => ({ session: current, event }))),
                    ),
                  );
            }),
            Stream.filterEffect((value) =>
              SubscriptionRef.get(supervisor.session).pipe(
                Effect.map((session) => Option.getOrNull(session) === value.session),
              ),
            ),
            Stream.map((value) => value.event),
            Stream.scan(emptyNativeConversationFeed, applyNativeConversationEvent),
          );
        }),
      ),
  });
  const views = Atom.family((atom: ReturnType<typeof source>) => conversationView(atom));
  const owned = (target: Parameters<typeof source>[0]) => views(source(target));
  const loadOlder = createEnvironmentCommand(runtime, {
    label: "environment-data:neopi-sessions:older",
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }: Parameters<typeof source>[0]) =>
        JSON.stringify([environmentId, input.threadId]),
    },
    execute: Effect.fn("nativeConversation.loadOlder")(function* (
      input: Parameters<typeof source>[0]["input"],
      registry: AtomRegistry.AtomRegistry,
      environmentId: Parameters<typeof source>[0]["environmentId"],
    ) {
      const atom = owned({ environmentId, input });
      yield* AtomRegistry.mount(registry, atom);
      const initial = registry.get(atom);
      if (!AsyncResult.isSuccess(initial) || initial.value.paging) return;
      const captured = initial.value.conversation;
      const identity = captured.identity;
      if (!identity || captured.needsSnapshot) return;
      const currentMatches = (value: NativeConversationView) =>
        value.connection === initial.value.connection &&
        value.conversation.revision === captured.revision &&
        !value.conversation.needsSnapshot &&
        sameNativeSession(value.conversation.identity, identity) &&
        value.conversation.identity?.leafId === identity.leafId;
      const update = (f: (value: NativeConversationView) => NativeConversationView) =>
        registry.set(atom, (result) => AsyncResult.map(result, f));
      const isCurrent = () => {
        const result = registry.get(atom);
        return AsyncResult.isSuccess(result) && currentMatches(result.value);
      };
      const fetchPage = Effect.fn("nativeConversation.readOlder")(function* (cursor?: string) {
        const response = yield* request(WS_METHODS.neopiSessionsJournal, {
          ...input,
          scope: "branch",
          direction: "backward",
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        if (response.status !== "available")
          return yield* new NativeConversationReadError({
            message: response.status === "error" ? response.message : response.reason,
          });
        return response.page;
      });
      const applyPage = (page: NeoPiJournalPage) => {
        if (!sameNativeSession(identity, page) || page.leafId !== identity.leafId) return false;
        if (!isCurrent()) return false;
        update((value) => ({
          ...value,
          conversation: reduceNativeConversation(
            { ...value.conversation, cursorLeaf: identity.leafId },
            { type: "older", page, revision: captured.revision },
          ),
        }));
        return true;
      };
      update((value) => ({ ...value, paging: true, pagingError: null }));
      yield* Effect.gen(function* () {
        let cursor = captured.cursor;
        if (captured.cursorLeaf !== identity.leafId) {
          const first = yield* fetchPage();
          if (!applyPage(first)) return;
          cursor = first.nextCursor;
        }
        if (!cursor || !isCurrent()) return;
        applyPage(yield* fetchPage(cursor));
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() =>
            update((value) => ({
              ...value,
              paging: false,
              pagingError:
                currentMatches(value) && Exit.isFailure(exit)
                  ? String(Cause.squash(exit.cause))
                  : value.pagingError,
            })),
          ),
        ),
      );
    }, Effect.scoped),
  });
  return {
    watch: (target: Parameters<typeof source>[0]) => owned(target),
    loadOlder,
    navigate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:neopi-sessions:navigate-tree",
      tag: WS_METHODS.neopiSessionsNavigateTree,
    }),
    resume: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:neopi-sessions:resume-tree",
      tag: WS_METHODS.neopiSessionsResumeTree,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:neopi-sessions:cancel-navigation",
      tag: WS_METHODS.neopiSessionsCancelNavigation,
    }),
  };
}
