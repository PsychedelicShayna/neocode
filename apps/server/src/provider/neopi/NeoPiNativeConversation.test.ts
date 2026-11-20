import { assert, describe, it } from "@effect/vitest";
import { ThreadId, type NeoPiNavigateTreeResult } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeNeoPiNativeConversationWith } from "./NeoPiNativeConversation.ts";
import type { NeoPiNativeOwner } from "./NeoPiNativeOwner.ts";

const identity = { sessionId: "native", sessionFile: "/sessions/native.jsonl" };
const entry = {
  id: "e1",
  parentId: null,
  type: "message",
  timestamp: "2026-10-22T00:00:00Z",
  message: { role: "user", content: "hello" },
};
const page = { ...identity, leafId: "e1", entries: [entry], totalEntries: 1 };
const capabilities = new Set([
  "session_journal",
  "session_journal_events",
  "session_tree_navigation",
]);
const threadId = ThreadId.make("thread");
const expected = {
  expectedSessionId: identity.sessionId,
  expectedSessionFile: identity.sessionFile,
  expectedLeafId: "e1",
};
const makeOwner = (request?: NeoPiNativeOwner["request"]): NeoPiNativeOwner => ({
  ownership: "terminal",
  capabilities,
  request:
    request ??
    ((command) =>
      Effect.succeed(command.type === "get_state" ? { ...identity, isStreaming: false } : page)),
});

describe("native conversation authority", () => {
  it.effect("forwards same-file drafts, ordered images and asks without automatic resume", () =>
    Effect.gen(function* () {
      const calls: Array<Record<string, unknown>> = [];
      const native: NeoPiNavigateTreeResult = {
        ...identity,
        leafId: "new",
        outcome: "navigated",
        cancelled: false,
        editorText: "restored",
        editorImages: [
          { type: "image", data: "one", mimeType: "image/png" },
          { type: "image", data: "two", mimeType: "image/png" },
        ],
        askReanswerCommitted: true,
        resumeToken: "native-token",
      };
      const owner = makeOwner((command) =>
        Effect.sync(() => {
          calls.push(command);
          return command.type === "resume_tree" ? { resumed: true } : native;
        }),
      );
      const service = yield* makeNeoPiNativeConversationWith(() =>
        Effect.succeed({ owner, expected: identity }),
      );
      const input = {
        threadId,
        ...expected,
        targetId: "ask",
        allowAskReopen: true,
        reanswerAskResult: {
          content: [{ type: "text" as const, text: "fresh" }],
          details: { selectedOptions: ["yes"] },
        },
      };
      assert.deepEqual(yield* service.navigate(input), { status: "available", result: native });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], {
        type: "navigate_tree",
        ...expected,
        targetId: "ask",
        allowAskReopen: true,
        reanswerAskResult: input.reanswerAskResult,
      });
      assert.deepEqual(
        yield* service.resume({
          threadId,
          ...expected,
          expectedLeafId: "new",
          resumeToken: "native-token",
        }),
        { status: "available", result: { resumed: true } },
      );
      assert.equal(calls[1]?.type, "resume_tree");
    }),
  );

  it.effect("forwards cancellation only to the pending navigation owner", () =>
    Effect.gen(function* () {
      const admitted = yield* Deferred.make<void>();
      const done = yield* Deferred.make<unknown>();
      const calls: string[] = [];
      const owner = makeOwner((command) =>
        Effect.gen(function* () {
          calls.push(command.type);
          if (command.type === "navigate_tree") {
            yield* Deferred.succeed(admitted, undefined);
            return yield* Deferred.await(done);
          }
          yield* Deferred.succeed(done, {
            ...identity,
            leafId: "e1",
            outcome: "cancelled",
            cancelled: true,
            aborted: true,
          });
          return {};
        }),
      );
      const service = yield* makeNeoPiNativeConversationWith(() =>
        Effect.succeed({ owner, expected: identity }),
      );
      assert.equal((yield* service.cancel(threadId)).status, "unavailable");
      const run = yield* service
        .navigate({ threadId, ...expected, targetId: "e1", summarize: true })
        .pipe(Effect.forkChild);
      yield* Deferred.await(admitted);
      assert.equal((yield* service.cancel(threadId)).status, "available");
      assert.deepEqual(yield* Fiber.join(run), {
        status: "available",
        result: { ...identity, leafId: "e1", outcome: "cancelled", cancelled: true, aborted: true },
      });
      assert.deepEqual(calls, ["navigate_tree", "abort"]);
    }),
  );

  it.effect("does not start stopped sessions or forward foreign navigation", () =>
    Effect.gen(function* () {
      const stopped = yield* makeNeoPiNativeConversationWith(() => Effect.succeed(undefined));
      assert.equal(
        (yield* stopped.navigate({ threadId, ...expected, targetId: "e1" })).status,
        "unavailable",
      );
      let called = false;
      const owner = makeOwner(() =>
        Effect.sync(() => {
          called = true;
          return {};
        }),
      );
      const service = yield* makeNeoPiNativeConversationWith(() =>
        Effect.succeed({ owner, expected: identity }),
      );
      const result = yield* service.navigate({
        threadId,
        ...expected,
        expectedSessionFile: "/sessions/foreign",
        targetId: "e1",
      });
      assert.equal(result.status === "error" && result.code, "session_changed");
      assert.equal(called, false);
    }),
  );

  it.effect("starts a stopped session only on explicit navigation", () =>
    Effect.gen(function* () {
      let started = false;
      const calls: Array<Record<string, unknown>> = [];
      const owner = makeOwner((command) =>
        Effect.sync(() => {
          calls.push(command);
          return { ...identity, leafId: "e1", outcome: "unchanged", cancelled: false };
        }),
      );
      const service = yield* makeNeoPiNativeConversationWith(
        () => Effect.succeed(started ? { owner, expected: identity } : undefined),
        () =>
          Effect.sync(() => {
            started = true;
          }),
      );
      assert.equal(
        (yield* service.navigate({ threadId, ...expected, targetId: "e1" })).status,
        "unavailable",
      );
      assert.equal(started, false);
      assert.equal(
        (yield* service.navigate({ threadId, ...expected, targetId: "e1", startIfStopped: true }))
          .status,
        "available",
      );
      assert.equal(started, true);
      assert.equal(calls[0]?.type, "navigate_tree");
      assert.equal("startIfStopped" in calls[0]!, false);
      assert.equal(
        calls.some((command) => command.type === "prompt"),
        false,
      );
    }),
  );
});
