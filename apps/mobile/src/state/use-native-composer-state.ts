import { useAtomValue } from "@effect/atom-react";
import { workspaceKey } from "@t3tools/client-runtime/environment";
import type { NativeSessionTarget } from "@t3tools/client-runtime/neopi-native-sessions";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { nextPastedTextFileName, pastedTextDisposition } from "@t3tools/client-runtime/text-paste";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { prepareTurnAttachments } from "../lib/attachmentUpload";
import { canUploadComposerAttachment } from "../lib/composerAttachmentUploadQueue";
import {
  composerContextSendBlockReason,
  serializeNativeComposerMessage,
  uploadedComposerContext,
} from "../lib/composerContext";
import { retainComposerAttachmentFileForPreview } from "../lib/composerAttachmentPreviewRetention";
import {
  convertPastedImagesToAttachments,
  createPastedTextComposerAttachment,
  isFileBackedComposerAttachment,
  pickComposerFiles,
  pickComposerMedia,
  type DraftComposerAttachment,
} from "../lib/composerImages";
import type { ComposerTextPaste } from "../native/T3ComposerEditor.types";
import { useServerConfigs } from "./entities";
import { nativeSessionAtoms, type useNativeSession } from "./neopiNativeSessions";
import {
  appendComposerDraftAttachments,
  captureComposerDraftInsertion,
  clearComposerDraftContent,
  composerContextImportsAtom,
  countComposerDraftAttachmentsAfterSelection,
  flushComposerDrafts,
  getComposerDraftSnapshot,
  insertComposerDraftText,
  removeComposerDraftAttachment,
  setComposerDraftAttachmentUpload,
  setComposerDraftText,
  useComposerDraft,
  waitForComposerDraftsLoaded,
  type ComposerDraftInsertion,
} from "./use-composer-drafts";

/** The ordinary durable mobile draft, delivered to the canonical native owner, not the SQL outbox. */
export function useNativeComposerState({
  target,
  request,
  connected,
}: {
  target: NativeSessionTarget;
  request: ReturnType<typeof useNativeSession>["request"];
  connected: boolean;
}) {
  const key = workspaceKey(target);
  const draft = useComposerDraft(key);
  const serverConfig = useServerConfigs().get(target.environmentId) ?? null;
  const imports = useAtomValue(composerContextImportsAtom);
  const [sending, setSending] = useState(false);
  const [pendingPastes, setPendingPastes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const pastedNames = useRef(new Set<string>());
  const capabilities = serverConfig?.environment.capabilities;
  const blockReason =
    (imports[key] ? "Copying context…" : null) ??
    (pendingPastes > 0 ? "Attaching pasted text…" : null) ??
    (draft.text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS
      ? `Messages can contain at most ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS} characters.`
      : null) ??
    composerContextSendBlockReason(draft.context) ??
    (draft.attachments.some((attachment) => !canUploadComposerAttachment(attachment, serverConfig))
      ? "An attachment exceeds this server's upload limits or is not supported."
      : null);

  const append = (
    attachments: readonly DraftComposerAttachment[],
    insertion: ComposerDraftInsertion,
    problem?: string | null,
  ) => {
    const rejected = appendComposerDraftAttachments(key, attachments, {
      appendReference: true,
      insertion,
    });
    const errors = [
      ...(problem ? [problem] : []),
      ...(rejected
        ? [
            `Messages can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments or the available context capacity.`,
          ]
        : []),
    ];
    if (errors.length) setError(errors.join("\n\n"));
  };
  const pickMedia = async () => {
    const insertion = captureComposerDraftInsertion(key);
    try {
      const result = await pickComposerMedia({
        existingCount: countComposerDraftAttachmentsAfterSelection(key, insertion),
        maxVideoBytes:
          capabilities?.attachmentUploads === true
            ? capabilities.fileAttachments?.maxUploadBytes
            : undefined,
      });
      append(result.attachments, insertion, result.error);
    } catch (cause) {
      setError(String(cause));
    }
  };
  const pickFiles = async () => {
    const maxBytes = capabilities?.fileAttachments?.maxUploadBytes;
    if (capabilities?.attachmentUploads !== true || maxBytes === undefined) {
      setError("This server does not support file attachments.");
      return;
    }
    const insertion = captureComposerDraftInsertion(key);
    try {
      const result = await pickComposerFiles({
        existingCount: countComposerDraftAttachmentsAfterSelection(key, insertion),
        maxBytes,
      });
      append(result.files, insertion, result.error);
    } catch (cause) {
      setError(String(cause));
    }
  };
  const pasteImages = async (uris: readonly string[]) => {
    const insertion = captureComposerDraftInsertion(key);
    try {
      append(
        await convertPastedImagesToAttachments({
          uris,
          existingCount: countComposerDraftAttachmentsAfterSelection(key, insertion),
        }),
        insertion,
      );
    } catch (cause) {
      setError(String(cause));
    }
  };
  const pasteText = async (paste: ComposerTextPaste) => {
    const insertion = { text: paste.value, ...paste.selection };
    const wouldExceedInputLimit =
      paste.value.length - (paste.selection.end - paste.selection.start) + paste.text.length >
      PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
    const advertisedMax =
      capabilities?.attachmentUploads === true
        ? capabilities.fileAttachments?.maxUploadBytes
        : undefined;
    const maxBytes =
      advertisedMax === undefined ? null : clampFileAttachmentUploadBytes(advertisedMax);
    const shouldAttach =
      pastedTextDisposition({ text: paste.text, wouldExceedInputLimit, canAttach: true }) ===
      "attachment";
    if (
      !shouldAttach ||
      maxBytes === null ||
      new TextEncoder().encode(paste.text).byteLength > maxBytes ||
      countComposerDraftAttachmentsAfterSelection(key, insertion) >=
        PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      if (wouldExceedInputLimit)
        setError("Pasted text is too large. Remove text or an attachment, then paste again.");
      else insertComposerDraftText(key, paste.text, insertion);
      return;
    }
    setPendingPastes((count) => count + 1);
    try {
      for (const attachment of getComposerDraftSnapshot(key).attachments)
        pastedNames.current.add(attachment.name);
      const name = nextPastedTextFileName([...pastedNames.current]);
      pastedNames.current.add(name);
      append(
        [await createPastedTextComposerAttachment({ text: paste.text, name, maxBytes })],
        insertion,
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPendingPastes((count) => count - 1);
    }
  };
  const send = async () => {
    if (sendingRef.current || !connected || blockReason) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    const releases: (() => void)[] = [];
    try {
      await waitForComposerDraftsLoaded();
      const snapshot = getComposerDraftSnapshot(key);
      if (!snapshot.text.trim() && !snapshot.attachments.length) return;
      const invalid =
        composerContextSendBlockReason(snapshot.context) ??
        (snapshot.attachments.some(
          (attachment) => !canUploadComposerAttachment(attachment, serverConfig),
        )
          ? "An attachment exceeds this server's upload limits or is not supported."
          : null);
      if (invalid) throw new Error(invalid);
      if (snapshot.text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS)
        throw new Error(
          `Messages can contain at most ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS} characters.`,
        );
      if (snapshot.attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS)
        throw new Error(
          `Messages can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
        );
      if (snapshot.attachments.length && capabilities?.attachmentUploads !== true)
        throw new Error("This server does not support native attachment uploads.");
      for (const attachment of snapshot.attachments) {
        if (isFileBackedComposerAttachment(attachment))
          releases.push(retainComposerAttachmentFileForPreview(attachment));
      }
      const prepared = await prepareTurnAttachments({
        environmentId: target.environmentId,
        attachments: snapshot.attachments,
        supportsImageUploads: true,
        persistUploadedReferences: async (attachments) => {
          for (const attachment of attachments) setComposerDraftAttachmentUpload(key, attachment);
          await flushComposerDrafts();
          return "persisted";
        },
      });
      if (prepared.status !== "ready") return;
      // Native delivery requires actual uploaded ids, never legacy inline upload shapes.
      const attachments = prepared.attachments.map((attachment) => {
        if ("dataUrl" in attachment || typeof attachment.id !== "string")
          throw new Error("The attachment was not uploaded. Reconnect and try again.");
        return attachment;
      });
      const message = serializeNativeComposerMessage(
        snapshot.text,
        uploadedComposerContext(snapshot.context, snapshot.attachments, attachments),
      );
      // While NeoPi runs, a prompt steers in at the next tool boundary rather
      // than waiting invisibly for the whole run.
      await request(
        {
          type: "prompt",
          message,
          ...(nativeSessionAtoms.cached(target)?.busy ? { streamingBehavior: "steer" } : {}),
        },
        attachments,
      );
      clearComposerDraftContent(key, { acceptedSnapshot: snapshot });
    } catch (cause) {
      setError(String(cause));
    } finally {
      for (const release of releases) release();
      sendingRef.current = false;
      setSending(false);
    }
  };
  return {
    key,
    draft,
    serverConfig,
    sending,
    error,
    blockReason,
    canSend:
      connected &&
      !sending &&
      !blockReason &&
      Boolean(draft.text.trim() || draft.attachments.length),
    setText: (value: string) => setComposerDraftText(key, value),
    removeAttachment: (id: string) => removeComposerDraftAttachment(key, id),
    pickMedia,
    pickFiles,
    pasteImages,
    pasteText,
    send,
  };
}
