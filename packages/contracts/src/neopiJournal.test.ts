import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NeoPiSessionJournalInput, NeoPiSessionJournalResult } from "./neopiJournal.ts";

describe("native journal contract", () => {
  it.effect("retains unknown records and rich content through a wire round trip", () => Effect.gen(function* () {
    const value = {
      status: "available",
      providerInstanceId: "neopi-default",
      page: {
        sessionId: "session",
        sessionFile: "/native/session.jsonl",
        leafId: "extension",
        totalEntries: 2,
        nextCursor: "opaque",
        entries: [
          { id: "message", parentId: null, timestamp: "2026-10-22T00:00:00.000Z", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tool", name: "read", arguments: { path: "source.ts" } }, { type: "image", data: "encoded", mimeType: "image/png" }], providerMetadata: { future: [1, 2] } } },
          { id: "extension", parentId: "message", timestamp: "2026-10-22T00:00:00.000Z", type: "future_extension", arbitrary: { nested: [true, null, { text: "not filtered" }] } },
        ],
      },
    };
    const decoded = yield* Schema.decodeUnknownEffect(NeoPiSessionJournalResult)(value);
    const encoded = yield* Schema.encodeEffect(NeoPiSessionJournalResult)(decoded);
    assert.deepEqual(encoded, value);
  }));

  it("rejects invalid native page limits and incompatible option values", () => {
    const decode = Schema.decodeUnknownOption(NeoPiSessionJournalInput);
    for (const invalid of [0, 257, 1.5])
      assert.equal(decode({ threadId: "thread", limit: invalid })._tag, "None");
    assert.equal(decode({ threadId: "thread", scope: "folded" })._tag, "None");
    assert.equal(decode({ threadId: "thread", direction: "latest" })._tag, "None");
    assert.equal(decode({ threadId: "thread", limit: 256, scope: "journal", direction: "backward", cursor: "opaque" })._tag, "Some");
  });
});
