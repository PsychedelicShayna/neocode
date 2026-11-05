// @vitest-environment jsdom

import { ApprovalRequestId } from "@t3tools/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";

const prompt: PendingUserInput = {
  requestId: ApprovalRequestId.make("request-1"),
  createdAt: "2026-08-15T00:00:00.000Z",
  questions: [
    {
      id: "question-1",
      header: "Approach",
      question: "Which approach should the migration take?",
      options: [
        { label: "Incremental", description: "Move one module at a time" },
        { label: "Big bang", description: "Move everything in one release" },
      ],
      multiSelect: false,
    },
  ],
  dismissible: true,
};

function renderPanel(pendingUserInput: PendingUserInput = prompt) {
  return renderToStaticMarkup(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[pendingUserInput]}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={() => {}}
      onAdvance={() => {}}
      onDismiss={() => {}}
    />,
  );
}

describe("ComposerPendingUserInputPanel", () => {
  it("renders the header as a disclosure control for the question body", () => {
    const markup = renderPanel();

    const toggle = markup.match(/<button[^>]*data-pending-user-input-toggle="[^"]*"[^>]*>/)?.[0];
    expect(toggle).toBeDefined();
    expect(toggle).toContain('data-pending-user-input-toggle="expanded"');
    expect(toggle).toContain('aria-expanded="true"');
    expect(toggle).toContain('type="button"');

    const controlledId = toggle?.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controlledId).toBeDefined();
    expect(markup).toMatch(new RegExp(`<div[^>]*\\sid="${controlledId}"`));
  });

  it("offers dismiss only for async questions", () => {
    expect(renderPanel()).toContain("data-pending-user-input-dismiss");
    expect(renderPanel({ ...prompt, dismissible: false })).not.toContain(
      "data-pending-user-input-dismiss",
    );
  });

  it("starts expanded so the question and its options are visible", () => {
    const markup = renderPanel();

    expect(markup).toContain("Approach");
    expect(markup).toContain("Which approach should the migration take?");
    expect(markup).toContain("Incremental");
    expect(markup).toContain("Big bang");
  });
});

describe("pending question auto-advance lifetime", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function QuestionFlow() {
    const [questionIndex, setQuestionIndex] = useState(0);
    const pendingPrompt: PendingUserInput = {
      ...prompt,
      questions: [
        ...prompt.questions,
        { ...prompt.questions[0]!, id: "question-2", header: "Second question" },
      ],
    };
    const advance = () => setQuestionIndex(questionIndex + 1);
    return questionIndex > 1 ? (
      <p>Submitted answers</p>
    ) : (
      <>
        <ComposerPendingUserInputPanel
          pendingUserInputs={[pendingPrompt]}
          respondingRequestIds={[]}
          answers={{
            "question-1": { selectedOptionValues: ["Incremental"] },
            "question-2": { selectedOptionValues: ["Incremental"] },
          }}
          questionIndex={questionIndex}
          onToggleOption={() => {}}
          onAdvance={advance}
          onDismiss={() => {}}
        />
        <button type="button" onClick={advance}>
          Continue manually
        </button>
      </>
    );
  }

  it.each([false, true])(
    "advances only once when manual navigation is %s",
    async (manualNavigation) => {
      await act(async () => root.render(<QuestionFlow />));
      const option = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Incremental"),
      );
      if (!option) throw new Error("Expected the first answer option");
      await act(async () => option.click());
      if (manualNavigation) {
        const continueButton = Array.from(container.querySelectorAll("button")).find(
          (button) => button.textContent === "Continue manually",
        );
        if (!continueButton) throw new Error("Expected manual navigation");
        await act(async () => continueButton.click());
      }
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(container.textContent).toContain("Second question");
      expect(container.textContent).not.toContain("Submitted answers");
    },
  );
});
