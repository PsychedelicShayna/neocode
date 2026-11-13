import { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { coreTurnTokenUsage, emptyCoreState, mapCoreFrame } from "./core.ts";
import { mapperTestContext } from "./mapperTestContext.ts";

const decodeEvent = Schema.decodeSync(ProviderAdapterV2Event);
function harness(child = false) {
  const ctx = mapperTestContext(child);
  let state = emptyCoreState();
  const events: ProviderAdapterV2Event[] = [];
  return {
    events,
    feed(frame: unknown) {
      const result = mapCoreFrame(ctx, frame, state);
      state = result.state;
      for (const event of result.events) {
        decodeEvent(event);
        if (event.type === "provider_session.updated")
          Object.assign(ctx, { providerSession: event.providerSession });
        if (event.type === "provider_thread.updated")
          Object.assign(ctx, { providerThread: event.providerThread });
        if (event.type === "provider_turn.updated")
          Object.assign(ctx, { providerTurn: event.providerTurn });
      }
      events.push(...result.events);
      return result.events;
    },
    items() {
      const items = events.flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      return [...new Map(items.map((item) => [item.id, item])).values()];
    },
    current: () => ctx,
    usage: () => coreTurnTokenUsage(state),
  };
}

const assistant = (text: string, usage?: object) => ({
  role: "assistant",
  timestamp: 123,
  provider: "openai",
  model: "example",
  content: [{ type: "text", text }],
  ...(usage ? { usage } : {}),
});

function terminalEvents(events: ProviderAdapterV2Event[]) {
  return events.filter((event) => event.type === "turn.terminal");
}

describe("NeoPi core mapper", () => {
  it("keeps interleaved reasoning and assistant text distinct and completes reasoning first", () => {
    const h = harness();
    h.feed({ type: "agent_start" });
    h.feed({ type: "message_start", message: assistant("") });
    for (const [type, contentIndex, delta] of [
      ["thinking_delta", 0, "first "],
      ["text_delta", 1, "hello "],
      ["thinking_delta", 0, "thought"],
      ["text_delta", 1, "world"],
    ] as const) {
      h.feed({ type: "message_update", assistantMessageEvent: { type, contentIndex, delta } });
    }
    h.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "hello world" },
    });
    expect(h.items().map((item) => item.status)).toEqual(["running", "running"]);
    const completed = h
      .feed({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "first thought" },
      })
      .flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []));
    expect(completed).toMatchObject([
      { type: "reasoning", text: "first thought", streaming: false, status: "completed" },
      { type: "assistant_message", text: "hello world", streaming: false, status: "completed" },
    ]);
    expect(completed[0]?.id).not.toBe(completed[1]?.id);
    const messages = h.events.filter((event) => event.type === "message.updated");
    expect(messages.at(-1)?.message).toMatchObject({
      text: "hello world",
      streaming: false,
      nodeId: "root-node",
      threadId: "thread-test",
    });
    expect(new Set(messages.map((event) => event.message.id)).size).toBe(1);
    const assistantItem = completed.find((item) => item.type === "assistant_message");
    expect(assistantItem?.messageId).toBe(messages.at(-1)?.message.id);
  });

  it("uses an explicitly empty final body instead of retaining a stale partial", () => {
    const h = harness();
    h.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "partial" },
    });
    h.feed({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "" } });
    expect(h.items()).toMatchObject([{ type: "assistant_message", text: "", streaming: false }]);
    expect(h.events.filter((event) => event.type === "message.updated").at(-1)?.message.text).toBe(
      "",
    );
  });

  it("sums typed usage once per assistant message, counts cache, and distinguishes partial turns", () => {
    const h = harness();
    const first = assistant("first", {
      input: 100,
      cacheRead: 900,
      cacheWrite: 50,
      output: 40,
      reasoningTokens: 10,
      cost: { total: 0.023 },
    });
    const second = { ...assistant("second"), timestamp: 124 };
    h.feed({ type: "agent_start" });
    h.feed({ type: "message_start", message: first });
    h.feed({ type: "message_end", message: first });
    h.feed({ type: "message_start", message: second });
    h.feed({ type: "message_end", message: second });
    h.feed({ type: "subagent_lifecycle", id: "sub-1", status: "started" });
    h.feed({ type: "agent_end", messages: [first, second] });
    const usage = {
      usageScope: "main_agent",
      hasSubagents: true,
      usageStatus: "partial",
      inputTokens: 1050,
      cachedInputTokens: 900,
      cacheCreationTokens: 50,
      outputTokens: 40,
      reasoningTokens: 10,
    };
    expect(h.usage()).toEqual(usage);
    h.feed({ type: "t3.turn.outcome", state: "completed" });
    expect(h.current().providerTurn?.turnTokenUsage).toEqual(usage);
    expect(h.current().providerTurn?.status).toBe("completed");
  });

  it("pairs compacted suffix messages and a message_end arriving after turn_end", () => {
    const h = harness();
    h.feed({ type: "agent_start" });
    const first = assistant("one", { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 });
    const second = { ...assistant("two"), timestamp: 124 };
    h.feed({ type: "message_start", message: first });
    h.feed({ type: "message_end", message: first });
    h.feed({ type: "message_start", message: second });
    h.feed({ type: "turn_end" });
    h.feed({ type: "message_end", message: second });
    h.feed({ type: "agent_end", messages: [second] });
    expect(h.usage()).toMatchObject({ inputTokens: 3, outputTokens: 2, usageStatus: "partial" });
  });

  it("reports context occupancy rather than lifetime totals without losing model options", () => {
    const h = harness();
    h.feed({
      type: "t3.state",
      state: {
        model: { provider: "openai", id: "gpt" },
        contextUsage: { tokens: 742, contextWindow: 200000, percent: 0.37 },
        tokenUsage: { input: 99999, output: 77777 },
      },
    });
    expect(h.current().providerThread.contextUsage).toMatchObject({
      usedTokens: 742,
      maxTokens: 200000,
    });
    expect(h.current().providerThread.nativeMetadata?.modelSelection).toEqual({
      instanceId: "neopi-test",
      model: "openai/gpt",
      options: [{ id: "fastMode", value: true }],
    });
    h.feed({ type: "t3.state", state: { contextUsage: { tokens: 0, contextWindow: 0 } } });
    expect(h.current().providerThread.contextUsage).toEqual({
      usedTokens: 0,
    });
  });

  it("keeps retry failures nonterminal until the authoritative native outcome and ignores duplicate terminals", () => {
    const h = harness();
    h.feed({ type: "agent_start" });
    h.feed({ type: "auto_retry_start", attempt: 1, errorMessage: "temporary" });
    h.feed({ type: "auto_retry_end", success: false, finalError: "retry exhausted" });
    h.feed({ type: "agent_end", messages: [] });
    expect(h.items()).toMatchObject([
      { type: "system_notice", message: "temporary", providerMetadata: { attempt: 1 } },
      { type: "system_notice", message: "retry exhausted" },
    ]);
    expect(terminalEvents(h.events)).toEqual([]);
    h.feed({ type: "t3.turn.outcome", state: "failed", errorMessage: "provider rejected request" });
    expect(terminalEvents(h.events)).toMatchObject([
      {
        status: "failed",
        failure: { class: "provider_error", message: "provider rejected request" },
      },
    ]);
    expect(h.current().providerTurn?.turnTokenUsage).toMatchObject({ usageStatus: "unavailable" });
    expect(terminalEvents(h.feed({ type: "t3.turn.outcome", state: "failed" }))).toEqual([]);
  });

  it("refreshes native model and effort without replacing unrelated options and preserves diagnostic metadata", () => {
    const h = harness();
    h.feed({
      type: "config_update",
      model: { provider: "openai", id: "gpt-5" },
      thinkingLevel: "high",
    });
    h.feed({ type: "agent_start" });
    expect(h.current().providerTurn?.model).toBe("openai/gpt-5");
    h.feed({ type: "thinking_level_changed", thinkingLevel: "medium" });
    expect(h.current().providerThread.nativeMetadata?.modelSelection?.options).toEqual([
      { id: "fastMode", value: true },
      { id: "reasoningEffort", value: "medium" },
    ]);
    h.feed({
      type: "retry_fallback_applied",
      from: "openai/gpt-5",
      to: "openai/gpt-4",
      role: "default",
    });
    expect(h.current().providerThread.nativeMetadata?.modelSelection?.model).toBe("openai/gpt-4");
    h.feed({ type: "thinking_level_changed", configured: null });
    expect(h.current().providerThread.nativeMetadata?.modelSelection?.options).toEqual([
      { id: "fastMode", value: true },
    ]);
    h.feed({ type: "notice", level: "error", source: "extension", message: "bad" });
    h.feed({
      type: "extension_error",
      extensionPath: "/x",
      event: "session_start",
      error: "broken extension",
    });
    expect(h.items()).toMatchObject([
      {
        type: "system_notice",
        providerMetadata: { fromModel: "openai/gpt-5", toModel: "openai/gpt-4" },
      },
      {
        type: "system_notice",
        message: "bad",
        providerMetadata: { level: "error", source: "extension" },
      },
      {
        type: "system_notice",
        message: "broken extension",
        providerMetadata: { extensionPath: "/x", event: "session_start" },
      },
    ]);
    expect(terminalEvents(h.events)).toEqual([]);
  });

  it("updates one compaction with late counts while keeping aborted and skipped attempts distinct", () => {
    const h = harness();
    h.feed({ type: "auto_compaction_start" });
    h.feed({ type: "auto_compaction_end", result: { tokensBefore: 8100, summary: "summary" } });
    h.feed({ type: "t3.compaction", beforeTokens: 8100, afterTokens: 3200, summary: "summary" });
    h.feed({ type: "auto_compaction_start" });
    h.feed({ type: "auto_compaction_end", aborted: true, errorMessage: "cancelled" });
    h.feed({ type: "auto_compaction_start" });
    h.feed({ type: "auto_compaction_end", skipped: true });
    expect(h.items()).toMatchObject([
      {
        type: "compaction",
        status: "completed",
        beforeTokenCount: 8100,
        afterTokenCount: 3200,
        summary: "summary",
      },
      { type: "compaction", status: "failed" },
      { type: "compaction", status: "cancelled" },
    ]);
  });

  it("keeps one turn and sums both phases when a nonterminal agent run continues", () => {
    const h = harness();
    h.feed({ type: "agent_start" });
    h.feed({ type: "message_start", message: assistant("") });
    h.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "first" },
    });
    h.feed({ type: "message_end", message: assistant("first", { input: 8, output: 3 }) });
    h.feed({ type: "agent_end", isTerminal: false });
    expect(h.feed({ type: "agent_start" })).toEqual([]);
    h.feed({ type: "message_start", message: assistant("") });
    h.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "second" },
    });
    h.feed({ type: "message_end", message: assistant("second", { input: 12, output: 4 }) });
    h.feed({ type: "agent_end", isTerminal: true });
    h.feed({ type: "t3.turn.outcome", state: "completed" });
    expect(terminalEvents(h.events)).toMatchObject([{ status: "completed" }]);
    expect(h.current().providerTurn?.turnTokenUsage).toMatchObject({
      usageStatus: "complete",
      inputTokens: 20,
      outputTokens: 7,
    });
    expect(h.items()).toMatchObject([
      { type: "assistant_message", text: "first", status: "completed" },
      { type: "assistant_message", text: "second", status: "completed" },
    ]);
  });

  it("attributes nested content to its child node and parent item without settling the root", () => {
    const h = harness(true);
    h.feed({ type: "agent_start" });
    h.feed({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "child" },
    });
    h.feed({ type: "message_end", message: assistant("child", { input: 2, output: 1 }) });
    h.feed({ type: "agent_end", messages: [] });
    h.feed({ type: "t3.turn.outcome", state: "completed" });
    expect(terminalEvents(h.events)).toEqual([]);
    expect(h.items()).toMatchObject([
      {
        nodeId: "child-node",
        providerThreadId: "child-thread",
        providerTurnId: "child-turn",
        parentItemId: "parent-tool",
        text: "child",
        status: "completed",
      },
    ]);
  });

  it("preserves process-exit details and distinguishes recoverable failure from graceful stop", () => {
    const h = harness();
    h.feed({
      type: "t3.session.exited",
      recoverable: true,
      code: 7,
      signal: "SIGTERM",
      stderrTail: " detail ",
    });
    expect(h.current().providerSession).toMatchObject({
      status: "error",
      lastError: "NeoPi process exited (code 7, signal SIGTERM): detail",
    });
    h.feed({ type: "t3.session.exited", recoverable: false, code: 0 });
    expect(h.current().providerSession).toMatchObject({ status: "stopped", lastError: null });
  });
});
