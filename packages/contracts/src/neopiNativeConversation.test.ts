import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  NeoPiJournalNativeEvent,
  NeoPiJournalStreamEvent,
  NeoPiNavigateTreeInput,
  NeoPiResumeTreeInput,
  NeoPiTreeOperationResult,
  NeoPiStreamingMessageSnapshot,
} from "./neopiNativeConversation.ts";

const identity = { sessionId: "session", sessionFile: "/sessions/native.jsonl", leafId: "entry" };
const decodeJournalEventOption = Schema.decodeUnknownOption(NeoPiJournalNativeEvent);
const decodeJournalEvent = Schema.decodeEffect(NeoPiJournalNativeEvent);
const encodeJournalEvent = Schema.encodeEffect(NeoPiJournalNativeEvent);
const decodeJournalStreamEvent = Schema.decodeEffect(NeoPiJournalStreamEvent);
const encodeJournalStreamEvent = Schema.encodeEffect(NeoPiJournalStreamEvent);
const decodeNavigateTreeOption = Schema.decodeUnknownOption(NeoPiNavigateTreeInput);
const decodeResumeTreeUnknownOption = Schema.decodeUnknownOption(NeoPiResumeTreeInput);
const decodeResumeTreeOption = Schema.decodeOption(NeoPiResumeTreeInput);
const decodeTreeOperation = Schema.decodeEffect(NeoPiTreeOperationResult);
const encodeTreeOperation = Schema.encodeEffect(NeoPiTreeOperationResult);
const decodeStreamingSnapshot = Schema.decodeEffect(NeoPiStreamingMessageSnapshot);
const encodeStreamingSnapshot = Schema.encodeEffect(NeoPiStreamingMessageSnapshot);
const decodeStreamingSnapshotOption = Schema.decodeUnknownOption(NeoPiStreamingMessageSnapshot);

describe("native conversation wire", () => {
  it("accepts optional snapshot recovery IDs and rejects malformed associations", () => {
    const snapshot = { type: "journal_state", reason: "snapshot", ...identity };
    const decode = decodeJournalEventOption;
    assert.equal(decode(snapshot)._tag, "Some");
    assert.equal(decode({ ...snapshot, messageEntryIds: [] })._tag, "Some");
    assert.equal(
      decode({ ...snapshot, messageEntryIds: [{ messageId: "live-1", entryId: "entry" }] })._tag,
      "Some",
    );
    assert.equal(decode({ ...snapshot, messageEntryIds: [{ messageId: "live-1" }] })._tag, "None");
    assert.equal(
      decode({ ...snapshot, messageEntryIds: [{ messageId: 1, entryId: "entry" }] })._tag,
      "None",
    );
  });

  it.effect("keeps full native records and process-local durability associations", () =>
    Effect.gen(function* () {
      const event = {
        type: "journal_entry",
        ...identity,
        entry: {
          id: "entry",
          parentId: null,
          type: "future_extension",
          timestamp: "2026-10-22T00:00:00Z",
          future: { blocks: [{ type: "image", data: "encoded", mimeType: "image/png" }] },
        },
      } as const;
      const decoded = yield* decodeJournalEvent(event);
      assert.deepEqual(yield* encodeJournalEvent(decoded), event);
      const frame = {
        type: "native",
        event: {
          type: "message_persisted",
          ...identity,
          messageId: "msg-42",
          entryId: "entry",
          future: true,
        },
      } as const;
      const wire = yield* decodeJournalStreamEvent(frame);
      assert.deepEqual(yield* encodeJournalStreamEvent(wire), frame);
    }),
  );

  it("requires native identity and leaf guards and keeps acknowledgement separate", () => {
    const options = {
      threadId: "thread",
      expectedSessionId: "session",
      expectedSessionFile: "/sessions/native.jsonl",
      expectedLeafId: null,
      targetId: "entry",
    };
    const decode = decodeNavigateTreeOption;
    assert.equal(decode(options)._tag, "Some");
    const { expectedLeafId: _, ...withoutLeaf } = options;
    assert.equal(decode(withoutLeaf)._tag, "None");
    assert.equal(decodeResumeTreeUnknownOption(options)._tag, "None");
    assert.equal(decodeResumeTreeOption({ ...options, resumeToken: "opaque" })._tag, "Some");
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
        const decoded = yield* decodeTreeOperation(value);
        assert.deepEqual(yield* encodeTreeOperation(decoded), value);
      }),
  );

  it.effect("keeps authoritative unsaved snapshots distinct from durability receipts", () =>
    Effect.gen(function* () {
      const snapshot = {
        type: "message_start",
        snapshot: true,
        ...identity,
        messageId: "msg-running",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "native thought" },
            { type: "text", text: "partial" },
          ],
          future: ["preserved"],
        },
      } as const;
      const decoded = yield* decodeStreamingSnapshot(snapshot);
      assert.deepEqual(yield* encodeStreamingSnapshot(decoded), snapshot);
      assert.equal("entryId" in decoded, false);
      assert.equal(decodeJournalEventOption(snapshot)._tag, "None");
      const { messageId: _, ...withoutMessageId } = snapshot;
      assert.equal(decodeStreamingSnapshotOption(withoutMessageId)._tag, "None");
    }),
  );
});
