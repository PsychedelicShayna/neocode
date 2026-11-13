import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  OrchestratorMcpFailure,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { makeNativeAdapterHarness, modelSelection, threadId } from "./NeoPiAdapterTestHarness.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";

const latestThread = (
  events: ReadonlyArray<ProviderAdapterV2Event>,
  fallback: OrchestrationV2ProviderThread,
) => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "provider_thread.updated") return event.providerThread;
  }
  return fallback;
};

it.live(
  "routes the first startup question to its real root before the first prompt can start",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeAdapterHarness();
        assert.equal(yield* h.adapter.observeNative!(threadId), undefined);
        assert.equal(h.launches.length, 0);
        const { session, providerThread } = yield* h.open();
        assert.equal(yield* h.adapter.observeNative!(threadId), undefined);
        h.askOnStartup();
        const input = h.turn(providerThread, "say hello");
        const sending = yield* session.startTurn(input).pipe(Effect.forkScoped);
        const question = yield* h.next(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
        );
        assert.equal(question.type, "runtime_request.updated");
        if (question.type !== "runtime_request.updated") return;
        assert.equal(question.runtimeRequest.nodeId, input.rootNodeId);
        assert.equal(h.prompts.length, 0);
        yield* session.respondToRuntimeRequest({
          requestId: question.runtimeRequest.id,
          decision: "accept",
        });
        yield* Fiber.join(sending);
        assert.deepEqual(h.prompts, ["say hello"]);
        const resolved = yield* h.next(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "resolved",
        );
        if (resolved.type !== "runtime_request.updated")
          throw new Error("Expected resolved request");
        assert.equal(resolved.runtimeRequest.id, question.runtimeRequest.id);
        assert.equal(resolved.runtimeRequest.nodeId, input.rootNodeId);
        const terminal = yield* h.finish("hello back");
        assert.equal(terminal.status, "completed");
        const message = h.observed.find(
          (event) => event.type === "message.updated" && event.message.text === "hello back",
        );
        if (!message || message.type !== "message.updated")
          throw new Error("Missing assistant message");
        assert.equal(message.message.nodeId, input.rootNodeId);
        assert.equal(message.message.runId, input.runId);
        const saved = latestThread(h.observed, providerThread).nativeMetadata;
        assert.equal(saved?.neopiLastTurn?.providerTurn.nodeId, input.rootNodeId);
        assert.equal(saved?.neopiResumeCursor?.sessionId, h.native().id);
        assert.equal(saved?.neopiResumeCursor?.turnBoundaries.length, 1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each([false, true])(
  "resumes and navigates canonical history without a new turn, retained owner %s",
  (retainLastTurn) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeAdapterHarness(["prompt_entry_ids", "session_tree_navigation"]);
        const owned = yield* Scope.make();
        const first = yield* h.open().pipe(Effect.provideService(Scope.Scope, owned));
        yield* first.session.startTurn(h.turn(first.providerThread, "keep this native history"));
        yield* h.finish("kept");
        const saved = latestThread(h.observed, first.providerThread);
        const { neopiLastTurn, ...metadata } = saved.nativeMetadata!;
        const durable = {
          ...saved,
          nativeMetadata: { ...metadata, ...(retainLastTurn ? { neopiLastTurn } : {}) },
        };
        const cursor = durable.nativeMetadata.neopiResumeCursor!;
        const before = [...h.native().entries];
        yield* Scope.close(owned, Exit.void);
        const reopened = yield* h.open(durable);
        const eventStart = h.observed.length;
        const promptCount = h.prompts.length;
        const resumed = yield* reopened.session.resumeThread({
          threadId,
          providerThread: reopened.providerThread,
          modelSelection,
          runtimePolicy: h.policy,
        });
        assert.equal(reopened.session.providerSession.status, "ready");
        assert.equal(h.native().id, cursor.sessionId);
        assert.equal(h.native().file, cursor.sessionFile);
        assert.deepEqual(h.native().entries, before);
        assert.deepEqual(resumed.nativeMetadata?.neopiResumeCursor, cursor);
        assert.deepEqual(h.runtimeInputs.at(-1)?.cursor, cursor);
        assert.equal(h.prompts.length, promptCount);
        const owner = yield* h.adapter.observeNative!(threadId);
        if (!owner) throw new Error("Missing resumed native owner");
        const target = before[0]!.id;
        yield* owner.request({
          type: "navigate_tree",
          targetId: target,
          expectedSessionId: cursor.sessionId,
          expectedSessionFile: cursor.sessionFile,
          expectedLeafId: before.at(-1)!.id,
        });
        const updated = yield* h.next(
          (event) =>
            event.type === "provider_thread.updated" &&
            event.providerThread.nativeMetadata?.neopiResumeCursor?.historyLeafId === target,
        );
        if (updated.type !== "provider_thread.updated")
          throw new Error("Missing native cursor update");
        assert.equal(updated.providerThread.nativeConversationHeadRef?.nativeId, target);
        assert.deepEqual(
          updated.providerThread.nativeMetadata?.neopiResumeCursor?.turnBoundaries,
          cursor.turnBoundaries,
        );
        assert.equal((yield* SubscriptionRef.get(h.runtimes.at(-1)!.cursor)).historyLeafId, target);
        assert.deepEqual(h.native().entries, before);
        assert.equal(h.prompts.length, promptCount);
        assert.equal(
          h.observed
            .slice(eventStart)
            .some(
              (event) => event.type === "provider_turn.updated" || event.type === "message.updated",
            ),
          false,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "waits for the native acknowledgment and does not reopen a turn that finished before it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeAdapterHarness();
        const { session, providerThread } = yield* h.open();
        const seen = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const accepted = yield* Deferred.make<void>();
        h.gatePrompt(
          Deferred.await(release),
          Deferred.succeed(seen, undefined).pipe(Effect.asVoid),
        );
        const input = h.turn(providerThread, "acknowledge this exact prompt");
        const sending = yield* session.startTurn(input).pipe(
          Effect.tap(() => Deferred.succeed(accepted, undefined)),
          Effect.forkScoped,
        );
        yield* Deferred.await(seen);
        assert.equal(yield* Deferred.isDone(accepted), false);
        assert.equal(
          h.observed.some(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.inputAccepted === true,
          ),
          false,
        );
        yield* h.complete("finished before acknowledgment");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(sending);
        assert.equal(yield* Deferred.isDone(accepted), true);
        const terminal = yield* h.awaitTerminal();
        assert.equal(
          h.observed.some(
            (event) =>
              event.type === "provider_turn.updated" &&
              event.providerTurn.id === terminal.providerTurnId &&
              event.providerTurn.inputAccepted === true,
          ),
          true,
        );
        const acceptedIndex = h.observed.findIndex(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.inputAccepted === true,
        );
        const terminalIndex = h.observed.findIndex(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        );
        assert.ok(acceptedIndex >= 0 && acceptedIndex < terminalIndex);
        assert.equal(session.providerSession.status, "ready");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "keeps rejected prompts recoverable and never reopens a completed turn after its acknowledgment",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeAdapterHarness();
        const { session, providerThread } = yield* h.open();
        h.failNextPrompt("native rejected this prompt");
        const rejected = yield* session
          .startTurn(h.turn(providerThread, "reject me"))
          .pipe(Effect.exit);
        assert.equal(rejected._tag, "Failure");
        if (Exit.isFailure(rejected)) assert.match(Cause.pretty(rejected.cause), /native rejected/);
        const failure = yield* h.awaitTerminal();
        assert.equal(failure.status, "failed");
        assert.equal(
          h.observed.some(
            (event) =>
              event.type === "provider_turn.updated" &&
              event.providerTurn.id === failure.providerTurnId &&
              event.providerTurn.inputAccepted === true,
          ),
          false,
        );
        assert.deepEqual(h.prompts, []);
        assert.equal(h.native().entries.length, 0);
        const retry = h.turn(latestThread(h.observed, providerThread), "retry the preserved draft");
        yield* session.startTurn(retry);
        const terminal = yield* h.finish("accepted retry");
        assert.equal(terminal.status, "completed");
        assert.equal(
          h.observed.some(
            (event) =>
              event.type === "provider_turn.updated" &&
              event.providerTurn.id === terminal.providerTurnId &&
              event.providerTurn.inputAccepted === true,
          ),
          true,
        );
        assert.equal(session.providerSession.status, "ready");
        assert.equal(
          latestThread(h.observed, providerThread).nativeMetadata?.neopiLastTurn?.providerTurn
            .status,
          "completed",
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["accept", "decline", "cancel"] as const)(
  "steers only the active native turn and resolves its scoped UI request with %s",
  (decision) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeAdapterHarness();
        const { session, providerThread } = yield* h.open();
        const input = h.turn(providerThread, "start the task");
        yield* session.startTurn(input);
        const running = yield* h.next(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running",
        );
        if (running.type !== "provider_turn.updated") throw new Error("Expected running turn");
        yield* session.steerTurn({
          threadId,
          runId: input.runId,
          providerThread,
          providerTurnId: running.providerTurn.id,
          message: { ...input.message, text: "take the other path" },
        });
        assert.equal(
          h.commands.find((command) => command.type === "steer")?.message,
          "take the other path",
        );
        yield* h.emit({
          type: "extension_ui_request",
          id: "same-native-id",
          method: "select",
          title: "Allow tool: bash",
          options: ["Approve", "Deny"],
        });
        const first = yield* h.next(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
        );
        if (first.type !== "runtime_request.updated") throw new Error("Expected request");
        yield* h.emit({
          type: "extension_ui_request",
          method: "cancel",
          targetId: "same-native-id",
        });
        yield* h.next(
          (event) =>
            event.type === "runtime_request.updated" &&
            event.runtimeRequest.id === first.runtimeRequest.id &&
            event.runtimeRequest.status === "cancelled",
        );
        yield* h.emit({
          type: "extension_ui_request",
          id: "same-native-id",
          method: "select",
          title: "Allow tool: bash",
          options: ["Approve", "Deny"],
        });
        const second = yield* h.next(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
        );
        if (second.type !== "runtime_request.updated")
          throw new Error("Expected replacement request");
        assert.notEqual(second.runtimeRequest.id, first.runtimeRequest.id);
        const stale = yield* session
          .respondToRuntimeRequest({ requestId: first.runtimeRequest.id, decision: "accept" })
          .pipe(Effect.exit);
        assert.equal(stale._tag, "Failure");
        yield* session.respondToRuntimeRequest({ requestId: second.runtimeRequest.id, decision });
        const resolved = yield* h.next(
          (event) =>
            event.type === "runtime_request.updated" &&
            event.runtimeRequest.id === second.runtimeRequest.id &&
            event.runtimeRequest.status === "resolved",
        );
        if (resolved.type !== "runtime_request.updated")
          throw new Error("Expected resolved request");
        assert.equal(resolved.runtimeRequest.decision, decision);
        assert.equal(h.responses.at(-1)?.value, decision === "accept" ? "Approve" : "Deny");
        const responses = h.responses.length;
        const duplicate = yield* session
          .respondToRuntimeRequest({ requestId: second.runtimeRequest.id, decision })
          .pipe(Effect.exit);
        assert.equal(duplicate._tag, "Failure");
        assert.equal(h.responses.length, responses);
        yield* h.finish();
        const tooLate = yield* session
          .steerTurn({
            threadId,
            runId: input.runId,
            providerThread,
            providerTurnId: running.providerTurn.id,
            message: { ...input.message, text: "stale steer" },
          })
          .pipe(Effect.exit);
        assert.equal(tooLate._tag, "Failure");
        assert.equal(h.commands.filter((command) => command.type === "steer").length, 1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each([false, true])(
  "gates native mode and usage behavior when capabilities are present: %s",
  (capable) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeAdapterHarness(
          capable ? ["set_mode", "get_usage", "prompt_entry_ids"] : ["prompt_entry_ids"],
        );
        const { session, providerThread } = yield* h.open();
        yield* session.startTurn(h.turn(providerThread, "plan the work", "plan"));
        const declared = session.providerSession.capabilities;
        assert.equal(declared.planning.emitsProposedPlan, capable);
        yield* h.finish();
        assert.equal(h.native().mode, capable ? "plan" : "default");
        const usage = yield* h.adapter.getLiveUsage("openai");
        assert.deepEqual(usage, capable ? { provider: "openai", windows: [] } : undefined);
        assert.equal(
          h.commands.some((command) => command.type === "get_usage"),
          capable,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("refines and implements native proposals without resending them as ordinary prompts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeNativeAdapterHarness();
      const { session, providerThread } = yield* h.open();
      yield* session.startTurn(h.turn(providerThread, "make a plan", "plan"));
      yield* h.propose("plan-one", "# Plan\n\n- Implement it");
      assert.deepEqual(h.proposed, []);
      yield* session.startTurn(
        h.turn(latestThread(h.observed, providerThread), "simplify step two", "plan"),
      );
      assert.equal(h.proposed.at(-1)?.decision, "refine");
      assert.equal(h.proposed.at(-1)?.feedback, "simplify step two");
      yield* h.finish("simplified plan");
      h.native().mode = "default";
      yield* h.runtimes.at(-1)!.restart("runtime-mode-change");
      yield* session.startTurn(
        h.turn(latestThread(h.observed, providerThread), "plan again", "plan"),
      );
      assert.equal(h.native().mode, "plan");
      yield* h.propose("plan-two", "# Revised\n\n- Build it");
      const implementation = h.turn(
        latestThread(h.observed, providerThread),
        "PLEASE IMPLEMENT THIS PLAN:\n# Revised\n\n- Build it",
      );
      yield* session.startTurn(implementation);
      assert.equal(h.proposed.at(-1)?.decision, "approve");
      assert.deepEqual(h.prompts, ["make a plan", "plan again"]);
      yield* h.emit({
        type: "tool_execution_start",
        toolCallId: "implementation-tool",
        toolName: "bash",
        args: { command: "build" },
      });
      const tool = yield* h.next(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
      );
      if (tool.type !== "turn_item.updated") throw new Error("Expected command item");
      assert.equal(tool.turnItem.nodeId, implementation.rootNodeId);
      assert.equal(tool.turnItem.runId, implementation.runId);
      yield* h.finish("built it");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "withdraws a native proposal before a normal prompt and keeps chat and Plan mutually exclusive",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeAdapterHarness();
        const { session, providerThread } = yield* h.open();
        yield* session.startTurn(h.turn(providerThread, "plan first", "plan"));
        yield* h.propose("withdraw-me", "# Plan");
        yield* session.startTurn(
          h.turn(latestThread(h.observed, providerThread), "answer normally"),
        );
        assert.equal(h.native().mode, "default");
        assert.deepEqual(h.prompts, ["plan first", "answer normally"]);
        yield* h.finish();
        yield* session.startTurn(h.turn(latestThread(h.observed, providerThread), "/chat chat"));
        yield* h.awaitTerminal();
        assert.equal(h.native().chatMode, "chat");
        const blocked = yield* session
          .startTurn(
            h.turn(latestThread(h.observed, providerThread), "plan while chatting", "plan"),
          )
          .pipe(Effect.exit);
        assert.equal(blocked._tag, "Failure");
        assert.equal(h.native().mode, "default");
        assert.equal(h.prompts.includes("plan while chatting"), false);
        yield* session.startTurn(
          h.turn(latestThread(h.observed, providerThread), "/chat off", "plan"),
        );
        yield* h.awaitTerminal();
        yield* session.startTurn(
          h.turn(latestThread(h.observed, providerThread), "plan after chat", "plan"),
        );
        assert.equal(h.native().chatMode, "off");
        assert.equal(h.native().mode, "plan");
        yield* h.finish();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each([undefined, "state", "history", "transcript"] as const)(
  "preserves native identity across rollback failure=%s and reopens the saved branch",
  (failure) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeAdapterHarness();
        const owned = yield* Scope.make();
        const { session, providerThread } = yield* h
          .open()
          .pipe(Effect.provideService(Scope.Scope, owned));
        yield* session.startTurn(h.turn(providerThread, "remember this"));
        yield* h.finish("remembered");
        if (failure === undefined) {
          yield* session.startTurn(
            h.turn(latestThread(h.observed, providerThread), "plan before rollback", "plan"),
          );
          yield* h.propose("branch-plan", "# Discard this plan");
        }
        const before = latestThread(h.observed, providerThread);
        const original = before.nativeMetadata!.neopiResumeCursor!;
        h.failAfterBranch(failure);
        const rolled = yield* session
          .rollbackThread({
            providerThread: before,
            providerThreadTurns: [],
            target: {
              type: "thread_start",
              checkpointId: CheckpointId.make("rewind"),
              appRunOrdinal: 0,
            },
          })
          .pipe(Effect.exit);
        const restoreOriginal = failure === "state" || failure === "transcript";
        assert.equal(rolled._tag, failure === undefined ? "Success" : "Failure");
        if (Exit.isFailure(rolled))
          assert.match(Cause.pretty(rolled.cause), /rollback|history|state/i);
        const savedThread = latestThread(h.observed, before);
        const saved = savedThread.nativeMetadata!.neopiResumeCursor!;
        assert.equal(saved.sessionFile === original.sessionFile, restoreOriginal);
        assert.equal(saved.sessionId === original.sessionId, restoreOriginal);
        assert.equal(
          saved.turnBoundaries.length,
          restoreOriginal ? original.turnBoundaries.length : 0,
        );
        yield* Scope.close(owned, Exit.void);
        const reopened = yield* h.open(savedThread);
        const snapshot = yield* reopened.session.readThreadSnapshot({
          providerThread: reopened.providerThread,
        });
        assert.equal(
          snapshot.providerThread.nativeMetadata?.neopiResumeCursor?.sessionFile,
          saved.sessionFile,
        );
        assert.equal(h.native().file, saved.sessionFile);
        assert.equal(h.native().entries.length, restoreOriginal ? 2 : 0);
        if (failure === undefined) {
          yield* reopened.session.startTurn(
            h.turn(reopened.providerThread, "plan after rollback", "plan"),
          );
          assert.equal(h.prompts.at(-1), "plan after rollback");
          assert.equal(h.native().mode, "plan");
          yield* h.finish("fresh plan");
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects a mismatched saved native cursor without starting a replacement runtime", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeNativeAdapterHarness();
      const owned = yield* Scope.make();
      const first = yield* h.open().pipe(Effect.provideService(Scope.Scope, owned));
      yield* first.session.startTurn(h.turn(first.providerThread, "retain history"));
      yield* h.finish();
      const saved = latestThread(h.observed, first.providerThread);
      yield* Scope.close(owned, Exit.void);
      const count = h.runtimes.length;
      const result = yield* Effect.scoped(
        h.open({
          ...saved,
          nativeMetadata: {
            ...saved.nativeMetadata,
            neopiResumeCursor: {
              ...saved.nativeMetadata!.neopiResumeCursor!,
              sessionId: "wrong-native-session",
            },
          },
        }),
      ).pipe(Effect.exit);
      assert.equal(result._tag, "Failure");
      assert.equal(h.runtimes.length, count);
      assert.equal(h.native().entries.length, 2);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "invalidates configuration observers across native process replacement without mutating the observed session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeNativeAdapterHarness();
        const { session, providerThread } = yield* h.open();
        yield* session.startTurn(h.turn(providerThread, "a turn"));
        yield* h.finish();
        const saved = latestThread(h.observed, providerThread).nativeMetadata!.neopiResumeCursor!;
        const observation = yield* h.adapter.observeConfiguration(threadId, saved);
        assert.equal((yield* observation.read).status, "available");
        const firstGeneration = h.runtimes.at(-1)!.processGeneration;
        yield* h.runtimes.at(-1)!.restart("runtime-mode-change");
        assert.notEqual(h.runtimes.at(-1)!.processGeneration, firstGeneration);
        const commandsBeforeRead = h.commands.length;
        assert.equal((yield* observation.read).status, "unavailable");
        assert.equal(h.commands.length, commandsBeforeRead);
        const configuration = yield* h.adapter.getConfiguration(threadId, saved);
        assert.equal(configuration.status, "available");
        if (configuration.status !== "available") return;
        assert.equal(configuration.attachment, "owned");
        assert.equal(configuration.sessionId, saved.sessionId);
        assert.equal(configuration.providerInstanceId, modelSelection.instanceId);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("keeps a background child on its original root while the next root runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeNativeAdapterHarness();
      const { session, providerThread } = yield* h.open();
      const first = h.turn(providerThread, "delegate a background task");
      yield* session.startTurn(first);
      yield* h.emit({
        type: "subagent_lifecycle",
        payload: { id: "child", status: "started", task: "background task" },
      });
      const opened = yield* h.next((event) => event.type === "subagent.updated");
      if (opened.type !== "subagent.updated") throw new Error("Expected native child");
      assert.equal(opened.subagent.parentNodeId, first.rootNodeId);
      yield* h.finish("continue in the background");
      const second = h.turn(latestThread(h.observed, providerThread), "do the next task");
      yield* session.startTurn(second);
      yield* h.emit({
        type: "subagent_progress",
        payload: { id: "child", progress: { recentOutput: "still working" } },
      });
      const progress = yield* h.next(
        (event) => event.type === "subagent.updated" && event.subagent.progress === "still working",
      );
      if (progress.type !== "subagent.updated") throw new Error("Expected child progress");
      assert.equal(progress.subagent.id, opened.subagent.id);
      assert.equal(progress.subagent.parentNodeId, first.rootNodeId);
      assert.equal(progress.subagent.runId, first.runId);
      yield* h.emit({ type: "subagent_lifecycle", payload: { id: "child", status: "completed" } });
      const completed = yield* h.next(
        (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
      );
      if (completed.type !== "subagent.updated") throw new Error("Expected completed child");
      assert.equal(completed.subagent.id, opened.subagent.id);
      assert.equal(completed.subagent.parentNodeId, first.rootNodeId);
      yield* h.finish("second root completed");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "keeps host access bound to the MCP credential rather than the V2 provider-session id",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const tools = Toolkit.make(
          Tool.make("preview_status", {
            parameters: Tool.EmptyParams,
            success: Schema.String,
            failure: OrchestratorMcpFailure,
            dependencies: [McpInvocationContext.McpInvocationContext],
          }),
        );
        const h = yield* makeNativeAdapterHarness(undefined, {
          mcpTools: McpHttpServer.toolkitRegistration(
            tools,
            McpToolAccess.toLayer(tools, {
              preview_status: McpToolAccess.readsAsWorkspace(() =>
                Effect.sync(() => {
                  calls++;
                  return "owned host";
                }),
              ),
            }),
          ).pipe(Layer.provide(McpHttpServer.layerInProcessMcpServer)),
        });
        const grant = Effect.gen(function* () {
          const issued = yield* h.mcpRegistry.issue({
            threadId,
            providerInstanceId: modelSelection.instanceId,
            capabilities: new Set(["preview"]),
          });
          yield* h.mcpSessions.set(issued.config);
          return issued.config;
        });
        const firstCredential = yield* grant;
        const owner = yield* Scope.fork(yield* Effect.scope);
        const first = yield* h.open().pipe(Effect.provideService(Scope.Scope, owner));
        assert.notEqual(first.session.providerSession.id, firstCredential.providerSessionId);
        yield* first.session.startTurn(h.turn(first.providerThread, "use the owned host"));
        yield* h.finish();
        const bridge = h.runtimeInputs.at(-1)?.hostBridge;
        assert.ok(bridge);
        const call = {
          type: "host_tool_call" as const,
          id: "host-access",
          toolCallId: "host-access",
          toolName: "preview_status",
          arguments: {},
        };
        const signal = yield* Effect.abortSignal;
        assert.notEqual((yield* bridge.handle(call, signal)).isError, true);
        assert.equal(calls, 1);
        yield* h.mcpRegistry.revokeThread(threadId);
        const replacement = yield* grant;
        assert.notEqual(replacement.providerSessionId, firstCredential.providerSessionId);
        assert.equal((yield* bridge.handle(call, signal)).isError, true);
        assert.equal(calls, 1);
        const saved = latestThread(h.observed, first.providerThread);
        yield* Scope.close(owner, Exit.void);
        const next = yield* h.open(saved);
        yield* next.session.startTurn(h.turn(next.providerThread, "use the replacement grant"));
        yield* h.finish();
        const nextBridge = h.runtimeInputs.at(-1)?.hostBridge;
        assert.ok(nextBridge);
        assert.notEqual((yield* nextBridge.handle(call, signal)).isError, true);
        assert.equal(calls, 2);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rewinds local chat commands without branching native conversation history", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeNativeAdapterHarness();
      const { session, providerThread } = yield* h.open();
      for (const text of ["/chat erp", "/chat", "/chat"]) {
        yield* session.startTurn(h.turn(latestThread(h.observed, providerThread), text));
        yield* h.awaitTerminal();
      }
      assert.equal(h.native().chatMode, "erp");
      assert.deepEqual(h.prompts, []);
      const before = latestThread(h.observed, providerThread);
      const turns = h.observed.flatMap((event) =>
        event.type === "provider_turn.updated" && event.providerTurn.status === "completed"
          ? [event.providerTurn]
          : [],
      );
      const target = turns.find((turn) => turn.ordinal === 2);
      assert.ok(target);
      const snapshot = yield* session.rollbackThread({
        providerThread: before,
        providerThreadTurns: turns,
        target: {
          type: "provider_turn",
          providerTurn: target,
          checkpointId: CheckpointId.make("local-chat"),
          appRunOrdinal: 2,
        },
      });
      const cursor = snapshot.providerThread.nativeMetadata?.neopiResumeCursor;
      assert.equal(cursor?.sessionFile, before.nativeMetadata?.neopiResumeCursor?.sessionFile);
      assert.deepEqual(
        cursor?.turnBoundaries.map((boundary) => ("kind" in boundary ? boundary.kind : "message")),
        ["local", "local"],
      );
      assert.equal(
        h.commands.some((command) => command.type === "branch"),
        false,
      );
      assert.equal(h.native().entries.length, 0);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reopens the same native history after its process exits during a turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeNativeAdapterHarness();
      const { session, providerThread } = yield* h.open();
      yield* session.startTurn(h.turn(providerThread, "before exit"));
      const saved = latestThread(h.observed, providerThread).nativeMetadata!.neopiResumeCursor!;
      const stopped = yield* SubscriptionRef.changes(h.runtimes[0]!.state).pipe(
        Stream.filter((state) => state === "stopped"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* h.exit("SIGKILL");
      const failed = yield* h.awaitTerminal();
      assert.equal(failed.status, "failed");
      yield* Fiber.join(stopped);
      yield* session.startTurn(h.turn(latestThread(h.observed, providerThread), "after exit"));
      const recovered = yield* h.finish("recovered answer");
      assert.equal(recovered.status, "completed");
      const cursor = latestThread(h.observed, providerThread).nativeMetadata!.neopiResumeCursor!;
      assert.equal(cursor.sessionFile, saved.sessionFile);
      assert.equal(cursor.sessionId, saved.sessionId);
      assert.equal(cursor.turnBoundaries.length, 2);
      assert.deepEqual(
        h.native().entries.map((entry) => entry.message.role),
        ["user", "user", "assistant"],
      );
      assert.deepEqual(h.prompts, ["before exit", "after exit"]);
      assert.isDefined(session.unloadThread);
      yield* session.unloadThread!({ providerThread });
      assert.deepEqual(yield* Effect.all(h.processIsRunning).pipe(Effect.orDie), [false, false]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
