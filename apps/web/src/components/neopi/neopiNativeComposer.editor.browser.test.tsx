import { createRef, useState, type RefObject } from "react";
import { describe, expect, it } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  composerTargetKey,
  persistComposerDraftSnapshot,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../../composerDraftStore";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../composerContextPresentation";
import { consumeNativeDraft, consumeNativeDraftNotification } from "./neopiNativeComposer";

const target = {
  environmentId: EnvironmentId.make("native-consumption-test"),
  ref: {
    providerInstanceId: ProviderInstanceId.make("neopi"),
    sessionFile: "/sessions/accepted.jsonl",
  },
};
const otherTarget = { ...target, ref: { ...target.ref, sessionFile: "/sessions/other.jsonl" } };
const key = composerTargetKey(target);
const acceptedText = "Reply with the single word RECONNECTED.";

function NativeDraftEditor({
  editorRef,
}: {
  editorRef: RefObject<ComposerPromptEditorHandle | null>;
}) {
  const draft = useComposerThreadDraft(target);
  const [cursor, setCursor] = useState(12);
  return (
    <ComposerPromptEditor
      value={draft.prompt}
      cursor={cursor}
      contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
      skills={[]}
      disabled={false}
      placeholder="Ask anything"
      onChange={(prompt, nextCursor) => {
        useComposerDraftStore.getState().setPrompt(target, prompt);
        setCursor(nextCursor);
      }}
      onPaste={(event) => event.preventDefault()}
      editorRef={editorRef}
    />
  );
}

async function setup() {
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  await useComposerDraftStore.persist.clearStorage();
  return {
    async [Symbol.asyncDispose]() {
      useComposerDraftStore.setState({ draftsByThreadKey: {} });
      await useComposerDraftStore.persist.clearStorage();
    },
  };
}

describe("native acceptance with the real controlled editor", () => {
  it.each(["", "\nNext question"])(
    "does not resurrect accepted text when immediate refocus moves a mid-text caret (suffix %j)",
    async (suffix) => {
      await using _drafts = await setup();
      const editorRef = createRef<ComposerPromptEditorHandle>();
      useComposerDraftStore.getState().setPrompt(target, acceptedText);
      const submitted = useComposerDraftStore.getState().getComposerDraft(target)!;
      useComposerDraftStore.getState().setPrompt(target, acceptedText + suffix);
      // The editor owns local focus; routing is outside this acceptance regression.
      await using screen = await render(<NativeDraftEditor editorRef={editorRef} />, {
        router: false,
      });
      expect(editorRef.current?.readSnapshot().cursor).toBe(12);

      await act(async () => {
        // Consumption commits before an immediate imperative focus operation.
        await Promise.resolve();
        consumeNativeDraft(target, submitted, []);
        editorRef.current?.focusAtEnd();
      });

      expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(suffix);
      expect(editorRef.current?.readSnapshot().value).toBe(suffix);
      expect(screen.container.textContent).not.toContain(acceptedText);
    },
  );

  it("consumes a peer's accepted snapshot against an observer's edits and persists only that result", async () => {
    await using _drafts = await setup();
    useComposerDraftStore.getState().setPrompt(target, acceptedText);
    const submitted = useComposerDraftStore.getState().getComposerDraft(target)!;

    // The observing renderer owns independent in-memory drafts. Apply only the
    // accepted snapshot to its current content, not the sender's whole store.
    useComposerDraftStore.getState().setPrompt(target, acceptedText + "\nObserver addition");
    useComposerDraftStore.getState().setPrompt(otherTarget, "Keep another session's draft");
    await consumeNativeDraftNotification({
      key,
      snapshot: persistComposerDraftSnapshot(submitted),
      images: [],
    });

    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "\nObserver addition",
    );
    expect(useComposerDraftStore.getState().getComposerDraft(otherTarget)?.prompt).toBe(
      "Keep another session's draft",
    );
    window.dispatchEvent(new Event("beforeunload"));
    const persisted = JSON.parse(window.localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY)!);
    expect(persisted.state.draftsByThreadKey[key].prompt).toBe("\nObserver addition");
    expect(persisted.state.draftsByThreadKey[composerTargetKey(otherTarget)].prompt).toBe(
      "Keep another session's draft",
    );
  });

  it("leaves a replaced observer prompt and other sessions intact", async () => {
    await using _drafts = await setup();
    useComposerDraftStore.getState().setPrompt(target, acceptedText);
    const submitted = useComposerDraftStore.getState().getComposerDraft(target)!;
    useComposerDraftStore.getState().setPrompt(target, "Actually ask something else");
    useComposerDraftStore.getState().setPrompt(otherTarget, "Unrelated draft");

    await consumeNativeDraftNotification({
      key,
      snapshot: persistComposerDraftSnapshot(submitted),
      images: [],
    });

    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "Actually ask something else",
    );
    expect(useComposerDraftStore.getState().getComposerDraft(otherTarget)?.prompt).toBe(
      "Unrelated draft",
    );
  });

  it.each([false, true])(
    "compares actual image bytes and retains an in-flight same-ID replacement (%s)",
    async (replaceDuringRead) => {
      await using _drafts = await setup();
      useComposerDraftStore.getState().setPrompt(target, acceptedText);
      const base = useComposerDraftStore.getState().getComposerDraft(target)!;
      const file = new File(["image"], "capture.png", { type: "image/png" });
      const image = {
        type: "image" as const,
        id: "capture",
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
        previewUrl: "data:image/png;base64,aW1hZ2U=",
      };
      const persisted = {
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: image.previewUrl,
      };
      const submitted = { ...base, images: [image], persistedAttachments: [persisted] };
      useComposerDraftStore.setState({ draftsByThreadKey: { [key]: submitted } });
      const pending = consumeNativeDraftNotification({
        key,
        snapshot: persistComposerDraftSnapshot(submitted),
        images: [image],
      });
      const replacement = {
        ...image,
        file: new File(["different bytes"], image.name, { type: image.mimeType }),
        previewUrl: "blob:replacement",
      };
      if (replaceDuringRead) {
        // Leave the old persisted data URL deliberately: a late image-persist
        // effect must not make metadata evidence of the replacement's bytes.
        useComposerDraftStore.setState({
          draftsByThreadKey: { [key]: { ...submitted, images: [replacement] } },
        });
      }
      await pending;
      const remaining = useComposerDraftStore.getState().getComposerDraft(target)!;
      expect(remaining.prompt).toBe("");
      expect(remaining.images).toEqual(replaceDuringRead ? [replacement] : []);
      expect(remaining.persistedAttachments).toEqual(replaceDuringRead ? [persisted] : []);
    },
  );
});
