import type { NeoPiNavigateTreeInput } from "@t3tools/contracts";
import { journalRecord } from "./neopiJournal.logic";

export function nativeAskQuestions(questions: ReadonlyArray<Readonly<Record<string, unknown>>>) {
  return questions.map((question) => {
    if (typeof question.id !== "string" || typeof question.question !== "string" || !Array.isArray(question.options))
      throw new Error("NeoPi returned an unsupported ask question. Its native record is preserved below.");
    const options = question.options.map((value) => {
      const option = journalRecord(value);
      if (typeof option.label !== "string") throw new Error("NeoPi returned an ask option without a label.");
      return { label: option.label, description: typeof option.description === "string" ? option.description : undefined,
        preview: typeof option.preview === "string" ? option.preview : undefined };
    });
    return { id: question.id, question: question.question, multi: question.multi === true, options };
  });
}
export interface NativeAskAnswer { readonly selectedOptions: ReadonlyArray<string>; readonly customInput: string }
export function nativeAskReanswer(questions: ReturnType<typeof nativeAskQuestions>, answers: Readonly<Record<string, NativeAskAnswer>>): NonNullable<NeoPiNavigateTreeInput["reanswerAskResult"]> {
  const results = questions.map((question) => {
    const answer = answers[question.id];
    if (!answer || (!answer.selectedOptions.length && !answer.customInput.trim())) throw new Error(`Answer "${question.question}" before submitting.`);
    const labels = question.options.map((option) => option.label);
    if (answer.selectedOptions.some((value) => !labels.includes(value)) || (!question.multi && answer.selectedOptions.length > 1))
      throw new Error("The answer no longer matches the native question.");
    return { id: question.id, question: question.question, options: labels, multi: question.multi,
      selectedOptions: [...answer.selectedOptions], ...(answer.customInput ? { customInput: answer.customInput } : {}) };
  });
  return { content: [{ type: "text", text: `User answers:\n${results.map((result) => `${result.id}: ${[...result.selectedOptions, ...(result.customInput ? [result.customInput] : [])].join(", ")}`).join("\n")}` }],
    details: { results }, isError: false };
}
