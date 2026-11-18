"use client";

import { useAtomValue } from "@effect/atom-react";
import {
  parseWorkspaceKey,
  workspaceKey,
  workspaceResourceId,
  type WorkspaceRef,
} from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  applyPreviewServerEvent,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
} from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";

class PreviewSessionThreadKeyParseError extends Schema.TaggedError<PreviewSessionThreadKeyParseError>()(
  "PreviewSessionThreadKeyParseError",
  { threadKey: Schema.String },
) {
  override get message(): string {
    return `Invalid scoped preview thread key: ${this.threadKey}`;
  }
}

const previewSessionSyncAtom = Atom.family((threadKey: string) => {
  const threadRef = parseWorkspaceKey(threadKey);
  if (threadRef === null) {
    throw new PreviewSessionThreadKeyParseError({ threadKey });
  }

  const sessionsAtom = previewEnvironment.list({
    environmentId: threadRef.environmentId,
    input: { threadId: workspaceResourceId(threadRef) },
  });
  const eventsAtom = previewEnvironment.events({
    environmentId: threadRef.environmentId,
    input: {},
  });

  return Atom.make((get) => {
    let disposed = false;
    let eventsVersion = 0;
    let discardedListRefetches = 0;

    const reconcileSessions = (result: Atom.Type<typeof sessionsAtom>) => {
      if (!AsyncResult.isSuccess(result)) return;
      if (reconcilePreviewServerSessions(threadRef, result.value)) {
        discardedListRefetches = 0;
        return;
      }
      // A list computed before an event already applied here is discarded as
      // older. Until one list has landed, fetch again, at most three times in a
      // row so a steady event stream cannot keep requesting lists; past that the
      // panel stays fail-soft until a resync or the next ordinary list.
      if (readThreadPreviewState(threadRef).listed || discardedListRefetches >= 3) return;
      discardedListRefetches += 1;
      get.refresh(sessionsAtom);
    };

    const applyLatestEvent = (result: Atom.Type<typeof eventsAtom>) => {
      if (!AsyncResult.isSuccess(result)) return;
      if (result.value.type === "resync") {
        applyPreviewServerEvent(threadRef, result.value);
        return;
      }
      if (result.value.threadId !== workspaceResourceId(threadRef)) return;
      const currentEpoch = readThreadPreviewState(threadRef).serverEpoch;
      if (currentEpoch !== null && currentEpoch !== result.value.serverEpoch) {
        get.refresh(sessionsAtom);
        return;
      }
      applyPreviewServerEvent(threadRef, result.value);
    };

    get.addFinalizer(() => {
      disposed = true;
    });
    const initialEvent = get.once(eventsAtom);
    get.subscribe(sessionsAtom, (result) => {
      reconcileSessions(result);
    });
    // A plain subscription leaves the lazy query unstarted, and refreshing an
    // unstarted query does not start it either; mounting starts the fetch.
    get.mount(sessionsAtom);
    get.subscribe(eventsAtom, (result) => {
      eventsVersion += 1;
      applyLatestEvent(result);
    });
    queueMicrotask(() => {
      if (disposed) return;
      // The cached list can predate an automation-created tab. Keep the local
      // snapshot visible until an authoritative refresh arrives instead of
      // reconciling against a stale empty result when the panel first mounts.
      get.refresh(sessionsAtom);
      if (eventsVersion === 0) applyLatestEvent(initialEvent);
    });
  }).pipe(Atom.setIdleTTL(1_000), Atom.withLabel(`preview:session-sync:${threadKey}`));
});

export function usePreviewSession(threadRef: WorkspaceRef): void {
  useAtomValue(previewSessionSyncAtom(workspaceKey(threadRef)));
}
