import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  NeoPiNavigateTreeInput,
  NeoPiResumeTreeInput,
  NeoPiTreeOperationResult,
} from "./neopiNativeConversation.ts";

const identity = { sessionId: "session", sessionFile: "/sessions/native.jsonl", leafId: "entry" };
describe("native conversation wire", () => {
  it("requires native identity and leaf guards and keeps acknowledgement separate", () => {
    const options = {
      threadId: "thread",
      expectedSessionId: "session",
      expectedSessionFile: "/sessions/native.jsonl",
      expectedLeafId: null,
      targetId: "entry",
    };
    const decode = Schema.decodeUnknownOption(NeoPiNavigateTreeInput);
    assert.equal(decode(options)._tag, "Some");
    const { expectedLeafId: _, ...withoutLeaf } = options;
    assert.equal(decode(withoutLeaf)._tag, "None");
    assert.equal(Schema.decodeUnknownOption(NeoPiResumeTreeInput)(options)._tag, "None");
    assert.equal(
      Schema.decodeUnknownOption(NeoPiResumeTreeInput)({ ...options, resumeToken: "opaque" })._tag,
      "Some",
    );
  });

  it.effect(
    "preserves draft image order and native ask preview without treating it as navigation",
    () =>
      Effect.gen(function* () {
        const value = {
          status: "available",
          result: {
            ...identity,
            outcome: "ask_reopen",
            cancelled: false,
            editorText: "draft",
            editorImages: [
              { type: "image", data: "first", mimeType: "image/png" },
              { type: "image", data: "second", mimeType: "image/jpeg" },
            ],
            reopenAsk: {
              toolCallId: "ask-1",
              questions: [
                {
                  id: "question",
                  question: "Choose",
                  options: [{ label: "Yes", value: "yes" }],
                  customFuture: true,
                },
              ],
            },
          },
        } as const;
        const decoded = yield* Schema.decodeUnknownEffect(NeoPiTreeOperationResult)(value);
        assert.deepEqual(yield* Schema.encodeEffect(NeoPiTreeOperationResult)(decoded), value);
      }),
  );
});
