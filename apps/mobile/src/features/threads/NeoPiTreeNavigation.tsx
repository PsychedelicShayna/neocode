import { nativeIdentityKey, nativeNavigationGuards } from "@t3tools/client-runtime/neopi-conversation";
import { nativeAskQuestions, nativeAskReanswer } from "@t3tools/client-runtime/neopi-tree";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { NeoPiNavigateTreeInput, NeoPiNavigateTreeResult, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Image, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { estimateBase64ByteSize } from "../../lib/base64";
import { pickComposerImages, type DraftComposerImageAttachment } from "../../lib/composerImages";
import { uuidv4 } from "../../lib/uuid";
import { nativeConversationAtoms, nativeSessionDraftKey, useNeoPiConversation } from "../../state/neopiConversation";
import { emptyNativeTreeDraft, emptyNativeTreeTargetDraft, type NativeAnswerImage, type NativeTreeTargetDraft } from "../../state/native-tree-draft";
import { replaceComposerDraftFromNative, updateNativeTreeDraft, useComposerDraft } from "../../state/use-composer-drafts";
import { useAtomCommand } from "../../state/use-atom-command";
import { NativeError, NativeField, NativeJson } from "./NativeNeoPiControls";

export function nativeEditorImages(result: Pick<NeoPiNavigateTreeResult, "editorImages">): DraftComposerImageAttachment[] {
  return (result.editorImages ?? []).map((image, index) => {
    if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(image.mimeType)) throw new Error(`Unsupported native draft image: ${image.mimeType}. The previous draft was not changed.`);
    const dataUrl = `data:${image.mimeType};base64,${image.data}`;
    return { type: "image", id: uuidv4(), name: `native-draft-${index + 1}.${image.mimeType.split("/")[1]}`, mimeType: image.mimeType, sizeBytes: estimateBase64ByteSize(image.data), previewUri: dataUrl, dataUrl };
  });
}

export function NeoPiTreeNavigation({ threadRef, targetId }: { threadRef: ScopedThreadRef; targetId: string }) {
  const { conversation, connection, refresh } = useNeoPiConversation(threadRef);
  const navigate = useAtomCommand(nativeConversationAtoms.navigate, { reportFailure: false });
  const resume = useAtomCommand(nativeConversationAtoms.resume, { reportFailure: false });
  const cancel = useAtomCommand(nativeConversationAtoms.cancel, { reportFailure: false });
  const identity = conversation.identity;
  const nativeKey = identity ? nativeSessionDraftKey(threadRef, identity) : null;
  const draft = useComposerDraft(nativeKey);
  const tree = draft.nativeTree ?? emptyNativeTreeDraft();
  const target = tree.targets[targetId] ?? emptyNativeTreeTargetDraft();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const active = useRef(true);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const patch = (change: Partial<NativeTreeTargetDraft>) => {
    if (nativeKey) updateNativeTreeDraft(nativeKey, current => ({ ...current, targets: { ...current.targets, [targetId]: { ...(current.targets[targetId] ?? emptyNativeTreeTargetDraft()), ...change } } }));
  };
  useEffect(() => {
    if (target.result?.outcome === "ask_reopen" && identity && target.result.leafId !== identity.leafId) patch({ result: null, answers: {}, images: [], message: "The native branch changed. Reopen the question from its current tree." });
  }, [identity?.leafId, target.result]);
  const ask = useMemo(() => {
    if (!target.result?.reopenAsk) return null;
    try { return { questions: nativeAskQuestions(target.result.reopenAsk.questions), error: null }; }
    catch (cause) { return { questions: [], error: cause instanceof Error ? cause.message : "Unsupported native question record." }; }
  }, [target.result]);
  const canNavigate = connection?.status === "connected" && connection.canNavigate && !conversation.needsSnapshot;
  const perform = async (reanswerAskResult?: NeoPiNavigateTreeInput["reanswerAskResult"], startIfStopped = false) => {
    if (!identity || !nativeKey || pendingRef.current || (!canNavigate && !startIfStopped)) return;
    const capturedKey = nativeKey;
    const capturedIdentity = identity;
    const setCaptured = (change: Partial<NativeTreeTargetDraft>, result?: NeoPiNavigateTreeResult) => updateNativeTreeDraft(capturedKey, current => ({ ...current, ...(result?.resumeToken ? { resumeResult: result } : {}), targets: { ...current.targets, [targetId]: { ...(current.targets[targetId] ?? emptyNativeTreeTargetDraft()), ...change } } }));
    pendingRef.current = true; setPending(true); setCaptured({ message: null });
    try {
      const response = await navigate({ environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId, ...nativeNavigationGuards(capturedIdentity), targetId, summarize: target.summarize, ...(target.instructions.trim() ? { customInstructions: target.instructions } : {}), allowAskReopen: true, ...(startIfStopped ? { startIfStopped: true } : {}), ...(reanswerAskResult ? { reanswerAskResult } : {}) } });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      if (response.value.status !== "available") throw new Error(response.value.status === "error" ? `${response.value.code}: ${response.value.message}` : response.value.reason);
      const result = response.value.result;
      const latest = currentIdentity.current;
      const changedAgain = latest && (nativeIdentityKey(latest) !== nativeIdentityKey(capturedIdentity) || latest.leafId !== capturedIdentity.leafId && latest.leafId !== result.leafId);
      setCaptured({ result, message: result.outcome === "ask_reopen" ? "Answer the reopened native question. The branch has not moved." : result.outcome === "cancelled" ? "Native navigation cancelled. The branch did not move." : result.outcome === "unchanged" ? "The native leaf is unchanged." : result.resumeToken ? "Answer saved on its branch. Review the rebuilt transcript before resuming." : "Native branch selected. Alternate branches remain in the same file." }, result);
      if ((result.outcome === "navigated" || result.outcome === "unchanged") && !changedAgain && (result.editorText !== undefined || result.editorImages !== undefined)) {
        const attachments = nativeEditorImages(result);
        // Write the captured native-file draft, never whichever thread alias is now selected.
        replaceComposerDraftFromNative(capturedKey, { text: result.editorText ?? "", attachments });
      }
      if (changedAgain) setCaptured({ message: "Native navigation finished, but the session or branch moved again. Its result remains recorded; the current draft was not replaced." });
      if (active.current) refresh();
    } catch (cause) { setCaptured({ message: cause instanceof Error ? cause.message : "Native navigation failed." }); }
    finally { pendingRef.current = false; if (active.current) setPending(false); }
  };
  const savedResume = tree.resumeResult;
  const rebuilt = !!(savedResume?.resumeToken && identity && !conversation.needsSnapshot && identity.sessionId === savedResume.sessionId && identity.leafId === savedResume.leafId && (!savedResume.sessionFile || savedResume.sessionFile === identity.sessionFile) && conversation.entries.some(entry => entry.id === savedResume.leafId));
  const acknowledge = async () => {
    if (!nativeKey || !identity || !savedResume?.resumeToken || !rebuilt || pendingRef.current || connection?.status !== "connected") return;
    const capturedKey = nativeKey;
    pendingRef.current = true; setPending(true);
    try {
      const response = await resume({ environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId, ...nativeNavigationGuards(identity), resumeToken: savedResume.resumeToken } });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      if (response.value.status !== "available") throw new Error(response.value.status === "error" ? response.value.message : response.value.reason);
      updateNativeTreeDraft(capturedKey, current => ({ ...current, resumeResult: null }));
      if (active.current) { patch({ result: null, message: "Native continuation acknowledged after the transcript rebuilt." }); refresh(); }
    } catch (cause) { if (active.current) patch({ message: cause instanceof Error ? cause.message : "Could not resume the native session." }); }
    finally { pendingRef.current = false; if (active.current) setPending(false); }
  };
  const addImages = async () => {
    if (!nativeKey) return;
    const capturedKey = nativeKey;
    try {
      const picked = await pickComposerImages({ existingCount: target.images.length });
      if (picked.error) throw new Error(picked.error);
      const images = await Promise.all(picked.images.map(async (image): Promise<NativeAnswerImage> => {
        if (image.dataUrl) {
          const comma = image.dataUrl.indexOf(",");
          if (comma < 0) throw new Error("The selected image has no inline bytes.");
          return { type: "image", mimeType: image.mimeType, data: image.dataUrl.slice(comma + 1) };
        }
        if (!image.fileUri) throw new Error("The selected image has no owned bytes.");
        const { File } = await import("expo-file-system");
        return { type: "image", mimeType: image.mimeType, data: await new File(image.fileUri).base64() };
      }));
      updateNativeTreeDraft(capturedKey, current => { const previous = current.targets[targetId] ?? emptyNativeTreeTargetDraft(); return { ...current, targets: { ...current.targets, [targetId]: { ...previous, images: [...previous.images, ...images] } } }; });
    } catch (cause) { if (active.current) patch({ message: cause instanceof Error ? cause.message : "Could not read answer images." }); }
  };
  if (!identity || !identity.sessionFile || !nativeKey) return <NativeError message="Navigation requires a canonical native session file. Refresh the native connection." />;
  return <View className="gap-3 border-y border-border-subtle py-4"><Text className="text-sm text-foreground-muted">Navigate inside this native file. Selecting a user entry restores its draft; its future is not deleted.</Text><MaterialButton label={target.summarize ? "Carry native summary: on" : "Carry native summary: off"} disabled={pending} onPress={() => patch({ summarize: !target.summarize })} />{target.summarize ? <NativeField label="Summary instructions" value={target.instructions} multiline disabled={pending} onChange={instructions => patch({ instructions })} /> : null}<View className="flex-row flex-wrap gap-2"><MaterialButton label="Navigate here" disabled={!canNavigate || pending} onPress={() => void perform()} />{connection?.ownership === "stopped" && !conversation.needsSnapshot ? <MaterialButton label="Start stopped native session and navigate" disabled={pending} onPress={() => void perform(undefined, true)} /> : null}{pending ? <MaterialButton label="Cancel navigation" onPress={() => void cancel({ environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId } }).then(response => patch({ message: response._tag === "Success" && response.value.status === "available" ? "Cancellation requested. Waiting for the native outcome." : "Could not request cancellation. Refresh to inspect the native leaf." }))} /> : null}</View>{!canNavigate ? <Text className="text-xs text-foreground-muted">{connection?.reason ?? "Navigation requires a connected native owner with tree support."}</Text> : null}{target.message ? <Text accessibilityRole="alert" selectable className="text-sm text-foreground">{target.message}</Text> : null}{target.result ? <NativeJson value={target.result} label="Native navigation result" /> : null}{ask ? <View className="gap-4"><NativeError message={ask.error} />{ask.questions.map(question => { const answer = target.answers[question.id] ?? { selectedOptions: [], customInput: "" }; return <View key={question.id} className="gap-2"><Text className="font-t3-medium text-foreground">{question.question}</Text>{question.options.map(option => <View key={option.label} className="gap-1"><MaterialButton label={option.label} tone={answer.selectedOptions.includes(option.label) ? "primary" : "secondary"} disabled={pending} onPress={() => { const selectedOptions = question.multi ? answer.selectedOptions.includes(option.label) ? answer.selectedOptions.filter(value => value !== option.label) : [...answer.selectedOptions, option.label] : [option.label]; patch({ answers: { ...target.answers, [question.id]: { ...answer, selectedOptions } } }); }} />{option.description ? <Text className="text-xs text-foreground-muted">{option.description}</Text> : null}{option.preview ? <Text selectable className="font-mono text-xs text-foreground-muted">{option.preview}</Text> : null}</View>)}<NativeField label={`Free answer: ${question.question}`} value={answer.customInput} multiline disabled={pending} onChange={customInput => patch({ answers: { ...target.answers, [question.id]: { ...answer, customInput } } })} /></View>; })}<MaterialButton label="Add answer images" disabled={pending} onPress={() => void addImages()} />{target.images.map((image, index) => <View key={index} className="gap-2"><Image source={{ uri: `data:${image.mimeType};base64,${image.data}` }} style={{ height: 100, width: 140 }} resizeMode="contain" accessibilityLabel={`Answer image ${index + 1}`} /><MaterialButton label={`Remove image ${index + 1}`} disabled={pending} onPress={() => patch({ images: target.images.filter((_, at) => at !== index) })} /></View>)}<NativeJson value={target.result?.reopenAsk} label="Native ask record" /><MaterialButton label="Save new answer on this branch" disabled={pending || !canNavigate || !!ask.error} onPress={() => { try { const answer = nativeAskReanswer(ask.questions, target.answers); void perform({ ...answer, content: [...answer.content, ...target.images] }); } catch (cause) { patch({ message: cause instanceof Error ? cause.message : "Could not encode the native answer." }); } }} /><MaterialButton label="Cancel re-answer" disabled={pending} onPress={() => patch({ result: null, answers: {}, images: [], message: "Re-answer cancelled. The branch is unchanged." })} /></View> : null}{savedResume?.resumeToken ? <View className="gap-2"><Text className="text-xs text-foreground-muted">{rebuilt ? "The transcript matches the saved answer's native leaf. Resume requires your acknowledgement." : "Waiting for the rebuilt matching native leaf. An intervening branch change or owner restart can invalidate this continuation."}</Text><MaterialButton label="Resume after rebuilt transcript" disabled={!rebuilt || pending || connection?.status !== "connected"} onPress={() => void acknowledge()} /><MaterialButton label="Keep answer without resuming" disabled={pending} onPress={() => { updateNativeTreeDraft(nativeKey, current => ({ ...current, resumeResult: null })); patch({ message: "The saved answer remains on its branch. No continuation was requested." }); }} /></View> : null}</View>;
}
