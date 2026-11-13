import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { makeNativeOrchestratorHarness } from "../../../orchestration-v2/testkit/NativeOrchestratorTestHarness.ts";
import { emptyCoreState, mapCoreFrame } from "./core.ts";
import { scopedItemId } from "./MapCtx.ts";
import { mapperTestContext } from "./mapperTestContext.ts";
import { emptySubagentState, mapSubagentFrame } from "./subagents.ts";

const decodeEvent = Schema.decodeSync(ProviderAdapterV2Event);

const ctx = mapperTestContext;
const childTaskId = (id: string, generation = 1) => scopedItemId(ctx(), `task:${id}#${generation}`);

function assistant(text: string, usage?: object) {
  return {
    role: "assistant",
    timestamp: 100,
    provider: "openai",
    model: "example",
    content: [{ type: "text", text }],
    ...(usage ? { usage } : {}),
  };
}

function feed(frames: readonly unknown[]) {
  const context = ctx();
  let core = emptyCoreState();
  let subagents = emptySubagentState();
  const events: ProviderAdapterV2Event[] = [];
  for (const frame of frames) {
    const mappedCore = mapCoreFrame(context, frame, core);
    const mapped = mapSubagentFrame(context, frame, subagents);
    core = mappedCore.state;
    subagents = mapped.state;
    for (const event of [...mappedCore.events, ...mapped.events]) {
      decodeEvent(event);
      if (event.type === "provider_turn.updated")
        Object.assign(context, { providerTurn: event.providerTurn });
      if (event.type === "provider_thread.updated")
        Object.assign(context, { providerThread: event.providerThread });
      if (event.type === "provider_session.updated")
        Object.assign(context, { providerSession: event.providerSession });
      events.push(event);
    }
  }
  return { events, core, subagents };
}

function ofType<T extends ProviderAdapterV2Event["type"]>(
  events: readonly ProviderAdapterV2Event[],
  type: T,
): Extract<ProviderAdapterV2Event, { type: T }>[] {
  return events.filter(
    (event): event is Extract<ProviderAdapterV2Event, { type: T }> => event.type === type,
  );
}

const usage = (input: number, output: number, cacheRead = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  cost: { total: 0.01 },
});

describe("NeoPi subagent mapper", () => {
  it("projects lifecycle, progress and isolated child usage onto V2 subagents", () => {
    const first = assistant("one", usage(10, 4, 1));
    const second = { ...assistant("two", usage(3, 5)), timestamp: 101 };
    const { events, core } = feed([
      { type: "agent_start" },
      {
        type: "subagent_lifecycle",
        payload: {
          id: "child-1",
          status: "started",
          agent: "scout",
          description: "Inspect the mapper",
          parentToolCallId: "tool-parent",
          index: 0,
        },
      },
      {
        type: "subagent_event",
        payload: {
          id: "child-1",
          event: { type: "message_end", message: first },
        },
      },
      {
        type: "subagent_event",
        payload: {
          id: "child-1",
          event: { type: "message_end", message: second },
        },
      },
      {
        type: "subagent_progress",
        payload: {
          index: 0,
          agent: "scout",
          task: "Inspect the mapper",
          progress: { id: "child-1", status: "running", recentOutput: ["reading core"] },
        },
      },
      {
        type: "subagent_progress",
        payload: {
          index: 0,
          agent: "scout",
          task: "Inspect the mapper",
          progress: { id: "child-1", status: "running", recentOutput: ["summing usage"] },
        },
      },
      {
        type: "subagent_lifecycle",
        payload: { id: "child-1", status: "completed", agent: "scout", index: 0 },
      },
      { type: "t3.turn.outcome", state: "completed" },
    ]);

    const updates = ofType(events, "subagent.updated").map((event) => event.subagent);
    expect(updates[0]).toMatchObject({
      id: childTaskId("child-1"),
      prompt: "Inspect the mapper",
      origin: "provider_native",
      parentNodeId: ctx().nodeId,
      providerThreadId: null,
      childThreadId: null,
    });
    expect(updates.filter((entry) => entry.progress).map((entry) => entry.progress)).toContain(
      "reading core",
    );
    expect(updates.filter((entry) => entry.progress).map((entry) => entry.progress)).toContain(
      "summing usage",
    );
    expect(updates.at(-1)).toMatchObject({
      id: childTaskId("child-1"),
      status: "completed",
      turnTokenUsage: {
        usageStatus: "complete",
        inputTokens: 14,
        outputTokens: 9,
        cachedInputTokens: 1,
      },
    });
    const item = ofType(events, "turn_item.updated").find(
      (event) => event.turnItem.type === "subagent",
    );
    expect(item?.turnItem).toMatchObject({ parentItemId: scopedItemId(ctx(), "tool-parent") });
    expect(ofType(events, "turn.terminal")).toHaveLength(1);
    expect(core.hasSubagents).toBe(false);
    const completed = ofType(events, "provider_turn.updated").at(-1);
    expect(completed?.providerTurn.turnTokenUsage).toEqual({
      usageScope: "main_agent",
      hasSubagents: true,
      usageStatus: "unavailable",
    });
  });

  it("attributes child tools and text to the child and keeps them out of parent transcript events", () => {
    const { events } = feed([
      {
        type: "subagent_lifecycle",
        payload: {
          id: "child-1",
          status: "started",
          description: "Search",
          parentToolCallId: "tool-parent",
          agent: "scout",
          index: 0,
        },
      },
      {
        type: "subagent_event",
        payload: {
          id: "child-1",
          event: {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "CHILD-SECRET", contentIndex: 0 },
          },
        },
      },
      {
        type: "subagent_event",
        payload: {
          id: "child-1",
          event: {
            type: "tool_execution_start",
            toolCallId: "bash-1",
            toolName: "bash",
            args: { command: "pwd" },
          },
        },
      },
      {
        type: "subagent_event",
        payload: {
          id: "child-1",
          event: {
            type: "tool_execution_end",
            toolCallId: "bash-1",
            toolName: "bash",
            result: { content: [{ type: "text", text: "workspace" }] },
          },
        },
      },
      {
        type: "subagent_event",
        payload: { id: "child-1", event: { type: "agent_end", messages: [] } },
      },
    ]);

    expect(ofType(events, "turn.terminal")).toEqual([]);
    expect(ofType(events, "message.updated")).toEqual([]);
    expect(
      ofType(events, "turn_item.updated").some(
        (event) =>
          event.turnItem.type === "assistant_message" || event.turnItem.type === "reasoning",
      ),
    ).toBe(false);
    expect(ofType(events, "subagent.updated").at(-1)?.subagent).toMatchObject({
      id: childTaskId("child-1"),
      progress: "CHILD-SECRET",
    });
    const tool = ofType(events, "turn_item.updated").find(
      (event) =>
        event.turnItem.type === "command_execution" && event.turnItem.status === "completed",
    )?.turnItem;
    expect(tool).toMatchObject({
      nodeId: childTaskId("child-1"),
      parentItemId: childTaskId("child-1"),
      output: "workspace",
    });
    expect(tool?.id).toContain("child-1");
  });

  it("starts a distinct task when a completed child id is reused", () => {
    const started = (id: string) => ({
      type: "subagent_lifecycle",
      payload: { id, status: "started", description: id, agent: "scout", index: 0 },
    });
    const { events } = feed([
      started("child-1"),
      { type: "subagent_lifecycle", payload: { id: "child-1", status: "completed", index: 0 } },
      started("child-1"),
    ]);
    const starts = ofType(events, "subagent.updated").filter(
      (event) => event.subagent.status === "running",
    );
    expect(starts.map((event) => event.subagent.id)).toEqual([
      childTaskId("child-1"),
      childTaskId("child-1", 2),
    ]);
  });

  it("separates a reused child name across runtime restarts and keeps its error off the parent", () => {
    const frame = { type: "subagent_lifecycle", payload: { id: "named-child", status: "started" } };
    const a = mapSubagentFrame(ctx(), frame, emptySubagentState());
    const restarted = { ...ctx(), sessionKey: "restarted-session" };
    const b = mapSubagentFrame(restarted, frame, emptySubagentState());
    expect(ofType(a.events, "subagent.updated")[0]?.subagent.id).toBe(childTaskId("named-child"));
    expect(ofType(b.events, "subagent.updated")[0]?.subagent.id).toBe(
      scopedItemId(restarted, "task:named-child#1"),
    );
    expect(ofType(a.events, "subagent.updated")[0]?.subagent.id).not.toBe(
      ofType(b.events, "subagent.updated")[0]?.subagent.id,
    );
    const error = mapSubagentFrame(
      ctx(),
      {
        type: "subagent_event",
        payload: {
          id: "named-child",
          event: { type: "notice", level: "error", message: "Child failed" },
        },
      },
      a.state,
    );
    expect(ofType(error.events, "message.updated")).toEqual([]);
    expect(ofType(error.events, "turn.terminal")).toEqual([]);
    expect(ofType(error.events, "subagent.updated")[0]?.subagent).toMatchObject({
      id: childTaskId("named-child"),
      progress: "Child failed",
    });
  });
  it("enriches a completed snapshot without reopening it or accepting progress after settlement", () => {
    const { events, subagents } = feed([
      {
        type: "subagent_progress",
        payload: {
          task: "Inspect",
          progress: { id: "child", status: "completed", recentOutput: ["done"] },
        },
      },
      {
        type: "subagent_event",
        payload: {
          id: "child",
          event: { type: "message_end", message: assistant("final", usage(8, 2)) },
        },
      },
      { type: "subagent_progress", payload: { progress: { id: "child", status: "running" } } },
      { type: "subagent_lifecycle", payload: { id: "child", status: "completed" } },
      {
        type: "subagent_progress",
        payload: {
          progress: { id: "child", status: "running", recentOutput: ["stale"] },
        },
      },
    ]);
    const updates = ofType(events, "subagent.updated").map((event) => event.subagent);
    expect(updates.every((entry) => entry.status === "completed")).toBe(true);
    expect(updates.at(-1)).toMatchObject({
      result: "final",
      turnTokenUsage: { inputTokens: 8, outputTokens: 2 },
    });
    expect(subagents.generations.child).toBe(1);
  });

  it("links nested children to the tool owner and counts each completed tool once", () => {
    const toolStart = {
      type: "tool_execution_start",
      toolCallId: "spawn",
      toolName: "bash",
      args: { command: "pwd" },
    };
    const toolEnd = {
      type: "tool_execution_end",
      toolCallId: "spawn",
      toolName: "bash",
      result: { content: [{ type: "text", text: "root" }] },
    };
    const { events } = feed([
      { type: "subagent_lifecycle", payload: { id: "parent", status: "started", agent: "scout" } },
      {
        type: "subagent_event",
        payload: {
          id: "parent",
          event: {
            type: "agent_start",
            model: { provider: "openai", id: "native" },
            thinkingLevel: "high",
          },
        },
      },
      { type: "subagent_event", payload: { id: "parent", event: toolStart } },
      {
        type: "subagent_lifecycle",
        payload: { id: "nested", status: "started", parentToolCallId: "spawn" },
      },
      { type: "subagent_event", payload: { id: "parent", event: toolEnd } },
      { type: "subagent_event", payload: { id: "parent", event: toolEnd } },
      { type: "subagent_lifecycle", payload: { id: "parent", status: "completed" } },
    ]);
    const updates = ofType(events, "subagent.updated").map((event) => event.subagent);
    expect(updates.find((entry) => entry.id === childTaskId("nested"))).toMatchObject({
      parentNodeId: childTaskId("parent"),
      childThreadId: null,
      providerThreadId: null,
    });
    expect(updates.at(-1)).toMatchObject({
      role: "scout",
      toolUses: 1,
      modelSelection: {
        model: "openai/native",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
    expect(
      ofType(events, "turn_item.updated").find(
        (event) =>
          event.turnItem.type === "subagent" && event.turnItem.subagentId === childTaskId("nested"),
      )?.turnItem.parentItemId,
    ).toBe(scopedItemId({ ...ctx(), agentId: childTaskId("parent") }, "spawn"));
    expect(ofType(events, "app_thread.created")).toEqual([]);
  });
});

effectIt.live("child subagent text does not enter the parent message through ingestion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeNativeOrchestratorHarness("neopi-subagent-ingestion");
      yield* Effect.gen(function* () {
        const threadId = ThreadId.make("neopi-subagent-ingestion");
        yield* h.create(threadId);
        const pending = yield* h.start(threadId, "delegate");
        for (const frame of [
          {
            type: "subagent_lifecycle",
            payload: {
              id: "child-1",
              status: "started",
              description: "Look around",
              parentToolCallId: "tool-parent",
              agent: "scout",
              index: 0,
            },
          },
          {
            type: "subagent_event",
            payload: {
              id: "child-1",
              event: {
                type: "message_update",
                assistantMessageEvent: {
                  type: "text_delta",
                  delta: "CHILD-SECRET",
                  contentIndex: 0,
                },
              },
            },
          },
          {
            type: "subagent_event",
            payload: {
              id: "child-1",
              event: {
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "CHILD-SECRET" }],
                  usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0 },
                },
              },
            },
          },
          {
            type: "subagent_event",
            payload: {
              id: "child-1",
              event: { type: "notice", level: "error", message: "child-only error" },
            },
          },
          {
            type: "subagent_event",
            payload: { id: "child-1", event: { type: "agent_end", messages: [] } },
          },
          {
            type: "subagent_lifecycle",
            payload: { id: "child-1", status: "completed", agent: "scout", index: 0 },
          },
        ])
          yield* h.native.emit(frame, pending.cursor.sessionFile);
        const { projection } = yield* pending.complete("parent answer");
        assert.deepEqual(
          projection.messages
            .filter((message) => message.role === "assistant")
            .map((message) => message.text),
          ["parent answer"],
        );
        assert.isFalse(
          projection.messages.some((message) => message.text.includes("CHILD-SECRET")),
        );
        const child = projection.subagents.find((entry) => entry.id.includes("child-1"));
        assert.equal(child?.status, "completed");
        assert.equal(child?.result, "CHILD-SECRET");
        assert.equal(child?.turnTokenUsage?.inputTokens, 8);
        assert.equal(projection.runs[0]?.status, "completed");
        assert.equal(projection.providerSessions.at(-1)?.status, "ready");
      }).pipe(Effect.provide(h.services()));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
