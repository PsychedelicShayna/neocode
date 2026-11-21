import { nativeRecord } from "./neopiNativeSessions.ts";

interface NativeAskOption {
  readonly label: string;
  readonly description?: string;
  readonly preview?: string;
  readonly recommended: boolean;
}

interface NativeAskQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly multiSelect: boolean;
  readonly options: readonly NativeAskOption[];
}

export interface NativeAsk {
  readonly kind: "ask";
  readonly id: string;
  readonly questions: readonly [NativeAskQuestion, ...NativeAskQuestion[]];
}

export function selectNativeSessionDialog(
  dialogs: readonly Record<string, unknown>[],
  dismissed?: ReadonlySet<string>,
): NativeAsk | { kind: "modal"; id: string; dialog: Record<string, unknown> } | null {
  for (const dialog of dialogs) {
    if (typeof dialog.id !== "string" || dismissed?.has(dialog.id)) continue;
    if (dialog.type !== "extension_ui_request" || dialog.method !== "ask") {
      return { kind: "modal", id: dialog.id, dialog };
    }
    if (!Array.isArray(dialog.questions)) continue;
    const questions: NativeAskQuestion[] = [];
    for (const entry of dialog.questions) {
      const question = nativeRecord(entry);
      if (
        typeof question.id !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      )
        break;
      const options: NativeAskOption[] = [];
      for (const [index, item] of question.options.entries()) {
        const option = nativeRecord(item);
        if (typeof option.label !== "string") break;
        options.push({
          label: option.label,
          ...(typeof option.description === "string" ? { description: option.description } : {}),
          ...(typeof option.preview === "string" ? { preview: option.preview } : {}),
          recommended: index === question.recommended,
        });
      }
      if (options.length !== question.options.length) break;
      questions.push({
        id: question.id,
        question: question.question,
        header: typeof question.header === "string" ? question.header : "Question",
        multiSelect: question.multi === true,
        options,
      });
    }
    const [first, ...rest] = questions;
    if (first && questions.length === dialog.questions.length) {
      return { kind: "ask", id: dialog.id, questions: [first, ...rest] };
    }
  }
  return null;
}

interface Answer {
  readonly selectedOptions: readonly string[];
  readonly customInput?: string;
}

export interface NativeAskDraft {
  readonly requestId: string;
  readonly questionIndex: number;
  readonly answers: ReadonlyMap<string, Answer>;
}

export type NativeAskResponse = { type: "extension_ui_response"; id: string } & (
  | { answers: readonly (Answer & { id: string })[] }
  | { cancelled: true }
);

export type NativeAskAction =
  | { type: "option"; questionId: string; label: string }
  | { type: "custom"; questionId: string; text: string }
  | { type: "advance"; questionId: string }
  | { type: "previous" }
  | { type: "dismiss" };

export interface NativeAskProgress {
  readonly activeQuestion: NativeAskQuestion;
  readonly questionIndex: number;
  readonly selectedOptionValues: readonly string[];
  readonly customAnswer: string;
  readonly canAdvance: boolean;
  readonly isLastQuestion: boolean;
}

const EMPTY_OPTIONS: readonly string[] = [];
const EMPTY_ANSWERS: ReadonlyMap<string, Answer> = new Map();

export function nativeAskProgress(
  ask: NativeAsk,
  draft: NativeAskDraft | undefined,
): NativeAskProgress {
  const questionIndex = draft?.requestId === ask.id ? draft.questionIndex : 0;
  const activeQuestion = ask.questions[questionIndex] ?? ask.questions[0];
  const answer = draft?.requestId === ask.id ? draft.answers.get(activeQuestion.id) : undefined;
  const selectedOptionValues = answer?.selectedOptions ?? EMPTY_OPTIONS;
  const customAnswer = answer?.customInput ?? "";
  return {
    questionIndex,
    activeQuestion,
    selectedOptionValues,
    customAnswer,
    // Advancing an untouched multi question explicitly confirms an empty selection.
    canAdvance:
      activeQuestion.multiSelect ||
      selectedOptionValues.length > 0 ||
      customAnswer.trim().length > 0,
    isLastQuestion: questionIndex === ask.questions.length - 1,
  };
}

export function stepNativeAsk(
  ask: NativeAsk,
  draft: NativeAskDraft | undefined,
  action: NativeAskAction,
): { draft: NativeAskDraft | undefined; response?: NativeAskResponse } {
  const {
    questionIndex,
    activeQuestion,
    customAnswer,
    selectedOptionValues,
    canAdvance,
    isLastQuestion,
  } = nativeAskProgress(ask, draft);
  const answers = draft?.requestId === ask.id ? draft.answers : EMPTY_ANSWERS;
  if (action.type === "dismiss") {
    return { draft, response: { type: "extension_ui_response", id: ask.id, cancelled: true } };
  }
  if (action.type === "previous") {
    return { draft: { requestId: ask.id, questionIndex: Math.max(0, questionIndex - 1), answers } };
  }
  if (!("questionId" in action) || action.questionId !== activeQuestion.id) return { draft };

  const next = new Map(answers);
  if (action.type === "option") {
    if (!activeQuestion.options.some((option) => option.label === action.label)) return { draft };
    if (activeQuestion.multiSelect) {
      next.set(activeQuestion.id, {
        selectedOptions: selectedOptionValues.includes(action.label)
          ? selectedOptionValues.filter((label) => label !== action.label)
          : [...selectedOptionValues, action.label],
        customInput: customAnswer,
      });
    } else {
      next.set(activeQuestion.id, { selectedOptions: [action.label] });
    }
  } else if (action.type === "custom") {
    next.set(activeQuestion.id, {
      selectedOptions:
        activeQuestion.multiSelect || action.text.trim().length === 0
          ? selectedOptionValues
          : EMPTY_OPTIONS,
      customInput: action.text,
    });
  } else {
    if (!canAdvance) return { draft };
    next.set(activeQuestion.id, {
      selectedOptions: selectedOptionValues,
      customInput: customAnswer,
    });
    if (!isLastQuestion) {
      return { draft: { requestId: ask.id, questionIndex: questionIndex + 1, answers: next } };
    }
    const ordered = [];
    for (const question of ask.questions) {
      const answer = next.get(question.id);
      const custom = answer?.customInput?.trim();
      if (!answer || (!question.multiSelect && answer.selectedOptions.length === 0 && !custom)) {
        return { draft };
      }
      ordered.push({
        id: question.id,
        selectedOptions: answer.selectedOptions,
        ...(custom ? { customInput: custom } : {}),
      });
    }
    return { draft, response: { type: "extension_ui_response", id: ask.id, answers: ordered } };
  }
  return { draft: { requestId: ask.id, questionIndex, answers: next } };
}
