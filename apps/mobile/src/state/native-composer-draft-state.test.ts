import { describe, expect, it } from "vite-plus/test";

import { bindNativeComposerDraft, syncNativeComposerDrafts } from "./native-composer-draft-state";
import { emptyNativeTreeDraft } from "./native-tree-draft";
import type { ComposerDraft } from "./use-composer-drafts";

const draft = (text: string): ComposerDraft => ({ text, attachments: [] });

describe("canonical native mobile drafts", () => {
  it("adopts an existing unsent draft without changing another session", () => {
    const unrelated = draft("leave this alone");
    const current = { alias: draft("unsent before attachment"), unrelated };
    const next = bindNativeComposerDraft(current, "alias", "native-file-a");
    expect(next.alias).toMatchObject({ text: "unsent before attachment", nativeSessionKey: "native-file-a" });
    expect(next["native-file-a"]?.text).toBe("unsent before attachment");
    expect(next.unrelated).toBe(unrelated);
  });

  it("keeps drafts separate when one UI alias switches between native files", () => {
    const a = bindNativeComposerDraft({ alias: draft("draft A") }, "alias", "native-file-a");
    const b = bindNativeComposerDraft(a, "alias", "native-file-b");
    expect(b.alias?.text).toBe("");
    const edited = syncNativeComposerDrafts(b, { ...b, alias: { ...b.alias!, text: "draft B" } });
    const restored = bindNativeComposerDraft(edited, "alias", "native-file-a");
    expect(restored.alias?.text).toBe("draft A");
    expect(restored["native-file-b"]?.text).toBe("draft B");
    expect(bindNativeComposerDraft(restored, "alias", "native-file-b").alias?.text).toBe("draft B");
  });

  it("shares edits and native restoration only with aliases of the same file", () => {
    const a = bindNativeComposerDraft({ first: draft("A"), other: draft("B") }, "first", "native-file-a");
    const both = bindNativeComposerDraft(a, "second", "native-file-a");
    const changed = syncNativeComposerDrafts(both, { ...both, first: { ...both.first!, text: "edited A" } });
    expect(changed.second?.text).toBe("edited A");
    const restored = syncNativeComposerDrafts(changed, { ...changed, "native-file-a": draft("native restored user text") });
    expect(restored.first?.text).toBe("native restored user text");
    expect(restored.second?.text).toBe("native restored user text");
    expect(restored.other?.text).toBe("B");
  });

  it("does not resurrect a sent draft when the thread alias is cleared", () => {
    const tree = emptyNativeTreeDraft();
    const a = bindNativeComposerDraft({ first: { ...draft("send this"), nativeTree: tree } }, "first", "native-file-a");
    const both = bindNativeComposerDraft(a, "second", "native-file-a");
    const changed = { ...both };
    delete changed.first;
    const cleared = syncNativeComposerDrafts(both, changed);
    expect(cleared["native-file-a"]?.text).toBe("");
    expect(cleared.second?.text).toBe("");
    expect(cleared.first?.nativeSessionKey).toBe("native-file-a");
    expect(cleared["native-file-a"]?.nativeTree).toBe(tree);
  });

  it("retains a second alias's independent legacy draft instead of dropping it", () => {
    const existing = bindNativeComposerDraft({ first: draft("canonical"), second: draft("legacy unsent") }, "first", "native-file-a");
    const next = bindNativeComposerDraft(existing, "second", "native-file-a");
    expect(next.second?.text).toBe("canonical");
    expect(next["second-unbound-draft"]?.text).toBe("legacy unsent");
  });

  it("persists ask edits and continuation state with the native file", () => {
    const tree = { ...emptyNativeTreeDraft(), targets: { question: { summarize: true, instructions: "retain the tool trace", answers: { q: { selectedOptions: ["yes"], customInput: "with this change" } }, images: [{ type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" }], result: null, message: null } } };
    const initial = bindNativeComposerDraft({ alias: { ...draft("A"), nativeTree: tree } }, "alias", "native-file-a");
    const switched = bindNativeComposerDraft(initial, "alias", "native-file-b");
    expect(switched.alias?.nativeTree).toBeUndefined();
    expect(bindNativeComposerDraft(switched, "alias", "native-file-a").alias?.nativeTree).toEqual(tree);
  });
});
