import { describe, expect, it } from "vite-plus/test";
import { nativeAskQuestions, nativeAskReanswer } from "@t3tools/client-runtime/neopi-tree";

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
