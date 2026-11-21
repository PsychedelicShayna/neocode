import { emptyNativeSessionFeed, reduceNativeSessionFeed } from "./neopiNativeSessions.ts";
import { describe, expect, it } from "vite-plus/test";
import {
  nativeAskProgress,
  selectNativeSessionDialog,
  stepNativeAsk,
  type NativeAskDraft,
} from "./neopiNativeAsk.ts";

const ask = {
  type: "extension_ui_request",
  method: "ask",
  id: "native-ask",
  questions: [
    {
      id: "second-sort",
      question: "Select one",
      options: [{ label: "A", preview: "A preview" }],
      recommended: 0,
    },
    {
      id: "first-sort",
      question: "Select any",
      multi: true,
      options: [{ label: "B" }, { label: "C" }],
    },
    { id: "last", question: "Add an answer", multi: true, options: [{ label: "D" }] },
  ],
};
const generic = {
  type: "extension_ui_request",
  method: "select",
  id: "generic",
  title: "Ask",
  options: ["A"],
};

function open(request: typeof ask | typeof generic) {
  return reduceNativeSessionFeed(emptyNativeSessionFeed(), {
    type: "obligation-opened",
    revision: 1,
    id: request.id,
    request,
  });
}

function start() {
  const presentation = selectNativeSessionDialog(open(ask).dialogs);
  if (presentation?.kind !== "ask") throw new Error("Expected an inline Ask");
  let draft: NativeAskDraft | undefined;
  return {
    progress: () => nativeAskProgress(presentation, draft),
    step: (action: Parameters<typeof stepNativeAsk>[2]) => {
      const result = stepNativeAsk(presentation, draft, action);
      draft = result.draft;
      return result.response;
    },
  };
}

describe("native composer obligations", () => {
  it("presents typed Ask inline and keeps generic select on the modal path regardless of title", () => {
    expect(selectNativeSessionDialog(open(ask).dialogs)).toMatchObject({ kind: "ask", id: ask.id });
    expect(selectNativeSessionDialog(open(generic).dialogs)).toEqual({
      kind: "modal",
      id: generic.id,
      dialog: generic,
    });
  });

  it("sends single, multi and custom answers in wire question order", () => {
    const flow = start();
    expect(flow.progress().activeQuestion.options[0]).toMatchObject({
      preview: "A preview",
      recommended: true,
    });
    flow.step({ type: "option", questionId: "second-sort", label: "A" });
    expect(flow.step({ type: "advance", questionId: "second-sort" })).toBeUndefined();
    flow.step({ type: "option", questionId: "first-sort", label: "C" });
    flow.step({ type: "option", questionId: "first-sort", label: "B" });
    flow.step({ type: "custom", questionId: "first-sort", text: "  and another thing  " });
    expect(flow.progress().selectedOptionValues).toEqual(["C", "B"]);
    flow.step({ type: "advance", questionId: "first-sort" });
    flow.step({ type: "custom", questionId: "last", text: "different" });
    expect(flow.step({ type: "advance", questionId: "last" })).toEqual({
      type: "extension_ui_response",
      id: ask.id,
      answers: [
        { id: "second-sort", selectedOptions: ["A"] },
        { id: "first-sort", selectedOptions: ["C", "B"], customInput: "and another thing" },
        { id: "last", selectedOptions: [], customInput: "different" },
      ],
    });
  });

  it("does not submit an untouched single, but allows an explicitly empty multi answer", () => {
    const flow = start();
    expect(flow.step({ type: "advance", questionId: "second-sort" })).toBeUndefined();
    expect(flow.progress().activeQuestion.id).toBe("second-sort");
    flow.step({ type: "option", questionId: "second-sort", label: "A" });
    flow.step({ type: "custom", questionId: "second-sort", text: "instead" });
    flow.step({ type: "advance", questionId: "second-sort" });
    expect(flow.step({ type: "advance", questionId: "second-sort" })).toBeUndefined();
    expect(flow.progress().activeQuestion.id).toBe("first-sort");
    flow.step({ type: "advance", questionId: "first-sort" });
    expect(flow.step({ type: "advance", questionId: "last" })).toEqual({
      type: "extension_ui_response",
      id: ask.id,
      answers: [
        { id: "second-sort", selectedOptions: [], customInput: "instead" },
        { id: "first-sort", selectedOptions: [] },
        { id: "last", selectedOptions: [] },
      ],
    });
  });

  it("dismisses with a cancellation rather than an empty answer", () => {
    expect(start().step({ type: "dismiss" })).toEqual({
      type: "extension_ui_response",
      id: ask.id,
      cancelled: true,
    });
  });

  it("removes the panel as soon as the owner's cancel settles the obligation", () => {
    const cancelled = reduceNativeSessionFeed(open(ask), {
      type: "obligation-settled",
      revision: 2,
      id: ask.id,
      outcome: "cancelled",
    });
    expect(selectNativeSessionDialog(cancelled.dialogs)).toBeNull();
  });
});
