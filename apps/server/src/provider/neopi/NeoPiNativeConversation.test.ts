import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { SessionEventFrame } from "effect-neopi-rpc/client";
import { NeoPiRpcError } from "effect-neopi-rpc/errors";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { makeNeoPiNativeConversationWith, observeNeoPiNativeOwner } from "./NeoPiNativeConversation.ts";
import { makeNeoPiNativeEventHub } from "./NeoPiNativeEventHub.ts";
import type { NeoPiNativeOwner } from "./NeoPiNativeOwner.ts";

const identity = { sessionId: "native", sessionFile: "/sessions/native.jsonl" };
const entry = { id: "e1", parentId: null, type: "message", timestamp: "2026-10-22T00:00:00Z", message: { role: "user", content: "hello" } };
const page = { ...identity, leafId: "e1", entries: [entry], totalEntries: 1 };
const capabilities = new Set(["session_journal", "session_journal_events", "session_tree_navigation"]);
const canonical = (type: string, extra: Record<string, unknown> = {}): SessionEventFrame => ({ type, ...identity, leafId: "e1", ...extra });
const threadId = ThreadId.make("thread");
const expected = { expectedSessionId: identity.sessionId, expectedSessionFile: identity.sessionFile, expectedLeafId: "e1" };
const resolveFile = (file: string) => Effect.succeed(file);
const makeOwner = (events: NeoPiNativeOwner["events"], request?: NeoPiNativeOwner["request"]): NeoPiNativeOwner => ({
  ownership: "terminal", capabilities, events,
  request: request ?? ((command) => Effect.succeed(command.type === "get_state" ? { ...identity, isStreaming: false } : page)),
});

describe("native conversation authority", () => {
  it.effect("subscribes before snapshot and deduplicates a commit during reconciliation", () => Effect.gen(function* () {
    const hub = makeNeoPiNativeEventHub();
    const events = yield* hub.subscribe;
    let reads = 0;
    const owner = makeOwner(events, (command) => Effect.gen(function* () {
      if (command.type === "get_state") return identity;
      reads++;
      yield* hub.publish(canonical("journal_entry", { entry }));
      yield* hub.publish(canonical("message_persisted", { messageId: "msg-1", entryId: "e1" }));
      yield* hub.publish({ type: "neocode_connection_closed" });
      return page;
    }));
    const result = yield* Stream.runCollect(observeNeoPiNativeOwner(owner, identity, resolveFile));
    assert.equal(reads, 1);
    assert.equal(result[0]?.type, "connection");
    assert.equal(result[1]?.type, "snapshot");
    assert.equal(result.filter((frame) => frame.type === "native" && frame.event.type === "journal_entry").length, 0);
    assert.equal(result.filter((frame) => frame.type === "native" && frame.event.type === "message_persisted").length, 1);
  }).pipe(Effect.scoped));

  it.effect("keeps external native message identities without inventing GUI turns", () => Effect.gen(function* () {
    const frames = [
      { type: "message_start", messageId: "msg-42", message: { role: "assistant", content: [] } },
      { type: "message_update", messageId: "msg-42", assistantMessageEvent: { type: "text_delta", delta: "external" } },
      { type: "message_end", messageId: "msg-42", message: { role: "assistant", content: [{ type: "text", text: "external" }] } },
      canonical("message_persisted", { messageId: "msg-42", entryId: "durable-42" }),
    ];
    const result = yield* Stream.runCollect(observeNeoPiNativeOwner(makeOwner(Stream.fromIterable(frames)), identity, resolveFile));
    assert.deepEqual(result.filter((frame) => frame.type === "native").map((frame) => frame.type === "native" ? frame.event : undefined), frames);
    assert.equal(result.some((frame) => frame.type === "native" && "turnId" in frame.event), false);
  }));

  it.effect("invalidates a foreign canonical identity before forwarding its content", () => Effect.gen(function* () {
    const result = yield* Stream.runCollect(observeNeoPiNativeOwner(makeOwner(Stream.fromIterable([
      canonical("journal_state", { reason: "identity", sessionFile: "/sessions/copied.jsonl" }),
      canonical("journal_entry", { entry: { ...entry, id: "foreign" } }),
    ])), identity, resolveFile));
    assert.equal(result.some((frame) => frame.type === "connection" && frame.status === "identity_changed"), true);
    assert.equal(result.some((frame) => frame.type === "native"), false);
  }));

  it.effect("reports native cursor errors as a reconciliation gap", () => Effect.gen(function* () {
    const owner = makeOwner(Stream.empty, (command) => command.type === "get_state" ? Effect.succeed(identity) :
      Effect.fail(new NeoPiRpcError({ code: "leaf_changed", message: "Native leaf changed" })));
    const result = yield* Stream.runCollect(observeNeoPiNativeOwner(owner, identity, resolveFile));
    assert.equal(result.length, 1);
    assert.equal(result[0]?.type === "connection" && result[0].status, "gap");
  }));

  it.effect("reconnects with a new snapshot and keeps terminal ownership read-only", () => Effect.gen(function* () {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = yield* Stream.runCollect(observeNeoPiNativeOwner(makeOwner(Stream.empty), identity, resolveFile));
      assert.equal(result[0]?.type === "connection" && result[0].ownership, "terminal");
      assert.equal(result[1]?.type, "snapshot");
      const last = result.at(-1);
      assert.equal(last?.type === "connection" && last.status, "disconnected");
    }
  }));

  it.effect("bounds a stalled observer and gives the next connection a fresh queue", () => Effect.gen(function* () {
    const hub = makeNeoPiNativeEventHub();
    const stalled = yield* hub.subscribe;
    for (let i = 0; i < 260; i++) yield* hub.publish({ type: "message_update", messageId: "msg", delta: String(i) });
    const failed = yield* Stream.runDrain(stalled).pipe(Effect.result);
    assert.equal(failed._tag, "Failure");
    const fresh = yield* hub.subscribe;
    yield* hub.publish(canonical("journal_state", { reason: "snapshot" }));
    const result = yield* Stream.runCollect(fresh.pipe(Stream.take(1)));
    assert.equal(result.length, 1);
  }).pipe(Effect.scoped));

  it.effect("forwards same-file drafts, ordered images and asks without automatic resume", () => Effect.gen(function* () {
    const calls: Array<Record<string, unknown>> = [];
    const native = { ...identity, leafId: "new", outcome: "navigated", cancelled: false,
      editorText: "restored", editorImages: [{ type: "image", data: "one", mimeType: "image/png" }, { type: "image", data: "two", mimeType: "image/png" }],
      askReanswerCommitted: true, resumeToken: "native-token" };
    const owner = makeOwner(Stream.empty, (command) => Effect.sync(() => { calls.push(command); return command.type === "resume_tree" ? { resumed: true } : native; }));
    const service = yield* makeNeoPiNativeConversationWith(() => Effect.succeed({ owner, expected: identity }), resolveFile);
    const input = { threadId, ...expected, targetId: "ask", allowAskReopen: true, reanswerAskResult: { content: [{ type: "text" as const, text: "fresh" }], details: { selectedOptions: ["yes"] } } };
    assert.deepEqual(yield* service.navigate(input), { status: "available", result: native });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { type: "navigate_tree", ...expected, targetId: "ask", allowAskReopen: true, reanswerAskResult: input.reanswerAskResult });
    assert.deepEqual(yield* service.resume({ threadId, ...expected, expectedLeafId: "new", resumeToken: "native-token" }), { status: "available", result: { resumed: true } });
    assert.equal(calls[1]?.type, "resume_tree");
  }));

  it.effect("forwards cancellation only to the pending navigation owner", () => Effect.gen(function* () {
    const admitted = yield* Deferred.make<void>();
    const done = yield* Deferred.make<unknown>();
    const calls: string[] = [];
    const owner = makeOwner(Stream.empty, (command) => Effect.gen(function* () {
      calls.push(command.type);
      if (command.type === "navigate_tree") { yield* Deferred.succeed(admitted, undefined); return yield* Deferred.await(done); }
      yield* Deferred.succeed(done, { ...identity, leafId: "e1", outcome: "cancelled", cancelled: true, aborted: true });
      return {};
    }));
    const service = yield* makeNeoPiNativeConversationWith(() => Effect.succeed({ owner, expected: identity }), resolveFile);
    assert.equal((yield* service.cancel(threadId)).status, "unavailable");
    const run = yield* service.navigate({ threadId, ...expected, targetId: "e1", summarize: true }).pipe(Effect.forkChild);
    yield* Deferred.await(admitted);
    assert.equal((yield* service.cancel(threadId)).status, "available");
    assert.deepEqual(yield* Fiber.join(run), { status: "available", result: { ...identity, leafId: "e1", outcome: "cancelled", cancelled: true, aborted: true } });
    assert.deepEqual(calls, ["navigate_tree", "abort"]);
  }));

  it.effect("does not start stopped sessions or forward foreign navigation", () => Effect.gen(function* () {
    const stopped = yield* makeNeoPiNativeConversationWith(() => Effect.succeed(undefined), resolveFile);
    assert.equal((yield* stopped.navigate({ threadId, ...expected, targetId: "e1" })).status, "unavailable");
    let called = false;
    const owner = makeOwner(Stream.empty, () => Effect.sync(() => { called = true; return {}; }));
    const service = yield* makeNeoPiNativeConversationWith(() => Effect.succeed({ owner, expected: identity }), resolveFile);
    const result = yield* service.navigate({ threadId, ...expected, expectedSessionFile: "/sessions/foreign", targetId: "e1" });
    assert.equal(result.status === "error" && result.code, "session_changed");
    assert.equal(called, false);
  }));

  it.effect("loads canonical history without starting and starts only on explicit navigation", () => Effect.gen(function* () {
    let started = false;
    const calls: Array<Record<string, unknown>> = [];
    const owner = makeOwner(Stream.empty, (command) => Effect.sync(() => {
      calls.push(command);
      return { ...identity, leafId: "e1", outcome: "unchanged", cancelled: false };
    }));
    const service = yield* makeNeoPiNativeConversationWith(
      () => Effect.succeed(started ? { owner, expected: identity } : undefined),
      resolveFile,
      () => Effect.sync(() => { started = true; }),
      () => Effect.succeed({ status: "available", providerInstanceId: ProviderInstanceId.make("neopi"), page }),
    );
    const history = yield* Stream.runCollect(service.watch(threadId));
    assert.equal(started, false);
    assert.deepEqual(history[1], { type: "snapshot", page });
    assert.equal((yield* service.navigate({ threadId, ...expected, targetId: "e1" })).status, "unavailable");
    assert.equal(started, false);
    assert.equal((yield* service.navigate({ threadId, ...expected, targetId: "e1", startIfStopped: true })).status, "available");
    assert.equal(started, true);
    assert.equal(calls[0]?.type, "navigate_tree");
    assert.equal("startIfStopped" in calls[0]!, false);
    assert.equal(calls.some((command) => command.type === "prompt"), false);
  }));
});
