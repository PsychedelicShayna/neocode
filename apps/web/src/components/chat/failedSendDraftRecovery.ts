import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { create } from "zustand";

import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import { readAttachmentUpload, releaseDraftAttachments } from "../../lib/attachmentUploadQueue";
import { cloneComposerImageForRetry } from "../ChatView.logic";

export type SubmittedComposerDraft = Pick<
  ComposerThreadDraftState,
  | "prompt"
  | "images"
  | "files"
  | "terminalContexts"
  | "previewAnnotations"
  | "reviewComments"
  | "threadContexts"
  | "environmentContexts"
>;

type CapturedSubmission = {
  readonly draft: SubmittedComposerDraft;
  readonly status: "pending" | "failed";
};

type SubmissionOutcomes = {
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "userMessageId" | "status">>;
  readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId" | "rootNodeId">>;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "runAttemptId" | "nodeId" | "inputAccepted">
  >;
};

interface FailedSendDraftStore {
  readonly submissionsByThreadKey: Readonly<
    Record<string, Readonly<Record<string, CapturedSubmission>>>
  >;
  capture: (target: ScopedThreadRef, messageId: string, draft: SubmittedComposerDraft) => void;
  reconcile: (target: ScopedThreadRef, outcomes: SubmissionOutcomes) => void;
  fail: (target: ScopedThreadRef, messageId: string) => void;
  restore: (target: ScopedThreadRef, messageId: string) => ComposerThreadDraftState | null;
  discard: (target: ScopedThreadRef, messageId: string) => void;
  discardThread: (target: ScopedThreadRef) => void;
}

/** In-memory ownership survives routes, not a renderer reload or window close. */
export const useFailedSendDraftStore = create<FailedSendDraftStore>((set, get) => {
  const previousOutcomes = new Map<string, SubmissionOutcomes>();
  const entries = (target: ScopedThreadRef) =>
    get().submissionsByThreadKey[scopedThreadKey(target)] ?? {};
  const remove = (target: ScopedThreadRef, messageId: string) => {
    set((state) => {
      const key = scopedThreadKey(target);
      const submissions = { ...state.submissionsByThreadKey[key] };
      delete submissions[messageId];
      const submissionsByThreadKey = { ...state.submissionsByThreadKey };
      if (Object.keys(submissions).length === 0) {
        delete submissionsByThreadKey[key];
        previousOutcomes.delete(key);
      } else submissionsByThreadKey[key] = submissions;
      return { submissionsByThreadKey };
    });
  };
  return {
    submissionsByThreadKey: {},
    capture: (target, messageId, draft) => {
      previousOutcomes.delete(scopedThreadKey(target));
      // Uploads can finish after the composer snapshot was taken. Keep the current
      // server id, especially for a hydrated file whose only bytes live there.
      const files = draft.files.map((file) => {
        const upload = readAttachmentUpload(file.id);
        return upload?.status === "ready" && upload.environmentId === target.environmentId
          ? {
              ...file,
              uploadedAttachmentId: upload.attachmentId,
              uploadEnvironmentId: upload.environmentId,
            }
          : file;
      });
      set((state) => ({
        submissionsByThreadKey: {
          ...state.submissionsByThreadKey,
          [scopedThreadKey(target)]: {
            ...entries(target),
            [messageId]: { draft: { ...draft, files }, status: "pending" },
          },
        },
      }));
    },
    reconcile: (target, outcomes) => {
      const key = scopedThreadKey(target);
      const submissions = get().submissionsByThreadKey[key];
      if (!submissions) return;
      const previous = previousOutcomes.get(key);
      if (
        previous?.runs === outcomes.runs &&
        previous.attempts === outcomes.attempts &&
        previous.providerTurns === outcomes.providerTurns
      )
        return;
      previousOutcomes.set(key, outcomes);
      const attempts = new Map(outcomes.attempts.map((attempt) => [attempt.id, attempt]));
      const acceptedRuns = new Set<OrchestrationV2Run["id"]>();
      for (const turn of outcomes.providerTurns) {
        if (!turn.inputAccepted || turn.runAttemptId === null) continue;
        const attempt = attempts.get(turn.runAttemptId);
        if (attempt?.rootNodeId === turn.nodeId) acceptedRuns.add(attempt.runId);
      }
      for (const run of outcomes.runs) {
        if (!submissions[run.userMessageId]) continue;
        if (acceptedRuns.has(run.id)) get().discard(target, run.userMessageId);
        else if (
          run.status === "failed" ||
          run.status === "interrupted" ||
          run.status === "cancelled"
        )
          get().fail(target, run.userMessageId);
      }
    },
    fail: (target, messageId) => {
      const entry = entries(target)[messageId];
      if (!entry || entry.status === "failed") return;
      set((state) => ({
        submissionsByThreadKey: {
          ...state.submissionsByThreadKey,
          [scopedThreadKey(target)]: {
            ...entries(target),
            [messageId]: { ...entry, status: "failed" },
          },
        },
      }));
    },
    restore: (target, messageId) => {
      const submissions = entries(target);
      const entry = submissions[messageId];
      if (
        !entry ||
        entry.status !== "failed" ||
        Object.values(submissions).some((other) => other !== entry && other.status === "pending")
      )
        return null;
      const restored = restoreFailedSendDraft(target, entry.draft);
      // This is a transfer: the restored composer now owns the pending uploads.
      if (restored) remove(target, messageId);
      return restored;
    },
    discard: (target, messageId) => {
      const entry = entries(target)[messageId];
      if (!entry) return;
      remove(target, messageId);
      releaseDraftAttachments([...entry.draft.images, ...entry.draft.files]);
    },
    discardThread: (target) => {
      for (const messageId of Object.keys(entries(target))) get().discard(target, messageId);
    },
  };
});

/** Restore only into an empty draft; a retained recovery never overwrites newer work. */
export function restoreFailedSendDraft(
  target: ComposerThreadTarget,
  submitted: SubmittedComposerDraft,
): ComposerThreadDraftState | null {
  const store = useComposerDraftStore.getState();
  const current = store.getComposerDraft(target);
  if ((current?.prompt.length ?? 0) > 0 || composerDraftHasUserContent(current)) return null;
  store.addImages(target, submitted.images.map(cloneComposerImageForRetry), {
    allowDuplicates: true,
  });
  store.addFiles(target, submitted.files, { allowDuplicates: true, appendReference: false });
  store.setTerminalContexts(target, submitted.terminalContexts);
  store.setPreviewAnnotations(target, submitted.previewAnnotations);
  store.setReviewComments(target, submitted.reviewComments);
  store.setThreadContexts(target, submitted.threadContexts);
  store.setEnvironmentContexts(target, submitted.environmentContexts);
  store.setPrompt(target, submitted.prompt);
  return useComposerDraftStore.getState().getComposerDraft(target);
}
