import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ThreadId,
  type NeoPiNavigateTreeResult,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { composerTargetKey, useComposerDraftStore } from "../../composerDraftStore";
import {
  nativeDraftImages,
  restoreNativeDraft,
  switchNativeDraftIdentity,
} from "./neopiNativeDraft";
import { nativeAskQuestions, nativeAskReanswer } from "@t3tools/client-runtime/neopi-tree";
import { removeLocalStorageItem } from "../../hooks/useLocalStorage";

const thread = scopeThreadRef(EnvironmentId.make("native-env"), ThreadId.make("native-thread"));
const result = (overrides: Partial<NeoPiNavigateTreeResult> = {}): NeoPiNavigateTreeResult => ({
  sessionId: "native",
  sessionFile: "/native/session.jsonl",
  leafId: "parent",
  outcome: "navigated",
  cancelled: false,
  ...overrides,
});
const initialStore = useComposerDraftStore.getState();
afterEach(() => {
  useComposerDraftStore.setState(initialStore, true);
  removeLocalStorageItem(`neocode:native-draft-binding:${composerTargetKey(thread)}`);
});

describe("native tree draft restoration", () => {
  it("parks drafts by canonical file even when copied sessions retain their session ID", () => {
    const native = { sessionId: "same-id", sessionFile: "/native/first.jsonl", leafId: "a" };
    useComposerDraftStore.getState().setPrompt(thread, "first file draft");
    switchNativeDraftIdentity(thread, native);
    switchNativeDraftIdentity(thread, { ...native, sessionFile: "/native/copy.jsonl" });
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[composerTargetKey(thread)],
    ).toBeUndefined();
    useComposerDraftStore.getState().setPrompt(thread, "copied file draft");
    switchNativeDraftIdentity(thread, native);
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[composerTargetKey(thread)]?.prompt,
    ).toBe("first file draft");
    switchNativeDraftIdentity(thread, { ...native, sessionFile: "/native/copy.jsonl" });
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[composerTargetKey(thread)]?.prompt,
    ).toBe("copied file draft");
  });
  it("restores text and every native image in its original order without sending", async () => {
    useComposerDraftStore.getState().setPrompt(thread, "old unsent draft");
    const editorImages = Array.from(
      { length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 2 },
      (_, index) => ({
        type: "image" as const,
        mimeType: "image/png",
        data: btoa(`native-image-${index}`),
      }),
    );
    restoreNativeDraft(thread, result({ editorText: "selected native request", editorImages }));
    const draft = useComposerDraftStore.getState().draftsByThreadKey[composerTargetKey(thread)];
    expect(draft?.prompt).toBe("selected native request");
    expect(draft?.images).toHaveLength(editorImages.length);
    expect(await Promise.all(draft!.images.map((image) => image.file.text()))).toEqual(
      editorImages.map((_, index) => `native-image-${index}`),
    );
  });

  it("decodes all images before replacing the current composer content", () => {
    useComposerDraftStore.getState().setPrompt(thread, "preserve me");
    expect(() =>
      restoreNativeDraft(
        thread,
        result({
          editorText: "replacement",
          editorImages: [{ type: "image", mimeType: "image/png", data: "%%%not-base64%%%" }],
        }),
      ),
    ).toThrow();
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[composerTargetKey(thread)]?.prompt,
    ).toBe("preserve me");
  });

  it("does not clear a draft for ordinary leaf navigation with no native draft result", () => {
    useComposerDraftStore.getState().setPrompt(thread, "keep local text");
    restoreNativeDraft(thread, result());
    expect(
      useComposerDraftStore.getState().draftsByThreadKey[composerTargetKey(thread)]?.prompt,
    ).toBe("keep local text");
    expect(nativeDraftImages(result())).toEqual([]);
  });
});

describe("native ask re-answer", () => {
  const questions = nativeAskQuestions([
    {
      id: "route",
      question: "Which route?",
      options: [
        { label: "direct", description: "No relay", preview: "direct preview" },
        { label: "relay" },
      ],
    },
    {
      id: "checks",
      question: "Which checks?",
      multi: true,
      options: [{ label: "unit" }, { label: "browser" }],
    },
  ]);
  it("preserves native question identity, options, multiple selection and free input", () => {
    const answer = nativeAskReanswer(questions, {
      route: { selectedOptions: ["direct"], customInput: "Use the LAN" },
      checks: { selectedOptions: ["browser", "unit"], customInput: "" },
    });
    expect(answer.details?.results).toEqual([
      {
        id: "route",
        question: "Which route?",
        options: ["direct", "relay"],
        multi: false,
        selectedOptions: ["direct"],
        customInput: "Use the LAN",
      },
      {
        id: "checks",
        question: "Which checks?",
        options: ["unit", "browser"],
        multi: true,
        selectedOptions: ["browser", "unit"],
      },
    ]);
    expect(answer.content).toEqual([
      { type: "text", text: "User answers:\nroute: direct, Use the LAN\nchecks: browser, unit" },
    ]);
  });
  it("rejects missing answers and stale options instead of silently selecting defaults", () => {
    expect(() => nativeAskReanswer(questions, {})).toThrow('Answer "Which route?"');
    expect(() =>
      nativeAskReanswer(questions, {
        route: { selectedOptions: ["removed-option"], customInput: "" },
        checks: { selectedOptions: ["unit"], customInput: "" },
      }),
    ).toThrow("no longer matches");
    expect(() =>
      nativeAskReanswer(questions, {
        route: { selectedOptions: ["direct", "relay"], customInput: "" },
        checks: { selectedOptions: ["unit"], customInput: "" },
      }),
    ).toThrow("no longer matches");
  });
  it("leaves future or malformed question records for explicit native inspection", () => {
    expect(() =>
      nativeAskQuestions([
        { id: "new-kind", question: "Pick", options: [{ value: "unsupported" }] },
      ]),
    ).toThrow("without a label");
  });
});
