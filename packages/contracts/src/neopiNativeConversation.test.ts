import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NeoPiJournalNativeEvent, NeoPiJournalStreamEvent, NeoPiNavigateTreeInput, NeoPiResumeTreeInput, NeoPiTreeOperationResult } from "./neopiNativeConversation.ts";

const identity = { sessionId: "session", sessionFile: "/sessions/native.jsonl", leafId: "entry" };
describe("native conversation wire", () => {
  it.effect("keeps full native records and process-local durability associations", () => Effect.gen(function* () {
    const event = { type: "journal_entry", ...identity, entry: { id: "entry", parentId: null, type: "future_extension", timestamp: "2026-10-22T00:00:00Z", future: { blocks: [{ type: "image", data: "encoded", mimeType: "image/png" }] } } };
    const decoded = yield* Schema.decodeUnknownEffect(NeoPiJournalNativeEvent)(event);
    assert.deepEqual(yield* Schema.encodeEffect(NeoPiJournalNativeEvent)(decoded), event);
    const frame = { type: "native", event: { type: "message_persisted", ...identity, messageId: "msg-42", entryId: "entry", future: true } };
    const wire = yield* Schema.decodeUnknownEffect(NeoPiJournalStreamEvent)(frame);
    assert.deepEqual(yield* Schema.encodeEffect(NeoPiJournalStreamEvent)(wire), frame);
  }));

  it("requires native identity and leaf guards and keeps acknowledgement separate", () => {
    const options = { threadId: "thread", expectedSessionId: "session", expectedSessionFile: "/sessions/native.jsonl", expectedLeafId: null, targetId: "entry" };
    const decode = Schema.decodeUnknownOption(NeoPiNavigateTreeInput);
    assert.equal(decode(options)._tag, "Some");
    const { expectedLeafId: _, ...withoutLeaf } = options;
    assert.equal(decode(withoutLeaf)._tag, "None");
    assert.equal(Schema.decodeUnknownOption(NeoPiResumeTreeInput)(options)._tag, "None");
    assert.equal(Schema.decodeUnknownOption(NeoPiResumeTreeInput)({ ...options, resumeToken: "opaque" })._tag, "Some");
  });

  it.effect("preserves draft image order and native ask preview without treating it as navigation", () => Effect.gen(function* () {
    const value = { status: "available", result: { ...identity, outcome: "ask_reopen", cancelled: false,
      editorText: "draft", editorImages: [{ type: "image", data: "first", mimeType: "image/png" }, { type: "image", data: "second", mimeType: "image/jpeg" }],
      reopenAsk: { toolCallId: "ask-1", questions: [{ id: "question", question: "Choose", options: [{ label: "Yes", value: "yes" }], customFuture: true }] } } };
    const decoded = yield* Schema.decodeUnknownEffect(NeoPiTreeOperationResult)(value);
    assert.deepEqual(yield* Schema.encodeEffect(NeoPiTreeOperationResult)(decoded), value);
  }));
});
