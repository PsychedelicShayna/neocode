import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectTurnItemForDetail,
  projectTurnItemForWire,
} from "../../../orchestration-v2/WireProjection.ts";
import { scopedItemId, type MapCtx } from "./MapCtx.ts";
import { emptyToolState, mapToolFrame, withHostToolNames, type ToolState } from "./tools.ts";

function context(): MapCtx {
  const ordinals = new Map<string, number>();
  let nextEvent = 0;
  return {
    provider: ProviderDriverKind.make("neopi"),
    providerInstanceId: ProviderInstanceId.make("neopi-1"),
    providerSessionId: ProviderSessionId.make("session-1"),
    providerThreadId: ProviderThreadId.make("provider-thread-1"),
    providerTurnId: ProviderTurnId.make("provider-turn-1"),
    threadId: ThreadId.make("thread-1"),
    turnId: TurnId.make("turn-1"),
    runId: RunId.make("run-1"),
    nodeId: NodeId.make("node-1"),
    itemOrdinal: (id) => {
      const existing = ordinals.get(id);
      if (existing !== undefined) return existing;
      const ordinal = ordinals.size;
      ordinals.set(id, ordinal);
      return ordinal;
    },
    now: () => "2026-09-27T00:00:00.000Z",
    newEventId: () => `event-${++nextEvent}`,
  };
}

function run(frames: readonly unknown[], initialState: ToolState = emptyToolState()) {
  const ctx = context();
  let state = initialState;
  const items = [];
  for (const frame of frames) {
    const mapped = mapToolFrame(ctx, frame, state);
    state = mapped.state;
    for (const event of mapped.events) {
      if (event.type !== "turn_item.updated") throw new Error(`Unexpected event ${event.type}`);
      items.push(event.turnItem);
    }
  }
  return { state, items };
}

const bashStart = (toolCallId: string) => ({
  type: "tool_execution_start",
  toolCallId,
  toolName: "bash",
  args: { command: "printf output", i: "Reading output" },
});
const bashUpdate = (toolCallId: string, text: string) => ({
  type: "tool_execution_update",
  toolCallId,
  toolName: "bash",
  partialResult: { content: [{ type: "text", text }], details: {} },
});
const bashEnd = (toolCallId: string, text: string, exitCode = 0) => ({
  type: "tool_execution_end",
  toolCallId,
  toolName: "bash",
  result: { content: [{ type: "text", text }], details: { exitCode } },
});

function commandOutputs(items: ReturnType<typeof run>["items"]) {
  return items.flatMap((item) =>
    item.type === "command_execution" && item.output !== undefined ? [item.output] : [],
  );
}

describe("NeoPi V2 tool mapper", () => {
  it("replaces rolling bash windows and keeps the authoritative final output", () => {
    const { items, state } = run([
      bashStart("bash-1"),
      ...["a", "ab", "abc", "abcde", "bcdef"].map((text) => bashUpdate("bash-1", text)),
      bashEnd("bash-1", "final line"),
      bashEnd("bash-1", "replayed result"),
    ]);
    expect(commandOutputs(items)).toEqual(["a", "ab", "abc", "abcde", "bcdef", "final line"]);
    expect(new Set(items.map((item) => item.id))).toEqual(
      new Set([scopedItemId(context(), "bash-1")]),
    );
    expect(items[0]).toMatchObject({
      type: "command_execution",
      input: "printf output",
      title: "Reading output",
      runId: "run-1",
      nodeId: "node-1",
      providerThreadId: "provider-thread-1",
      providerTurnId: "provider-turn-1",
    });
    expect(items.at(-1)).toMatchObject({ status: "completed", output: "final line", exitCode: 0 });
    expect(state.inFlightTools).toEqual({});
  });

  it("emits a split code point once without an invalid surrogate", () => {
    const { items } = run([
      bashStart("bash-1"),
      bashUpdate("bash-1", "a\ud83d"),
      bashUpdate("bash-1", "a\ud83d\ude00"),
    ]);
    expect(commandOutputs(items)).toEqual(["a", "a😀"]);
    expect(JSON.stringify(commandOutputs(items))).not.toContain("\\ud83d");
  });

  it("isolates output and ordinals for interleaved calls", () => {
    const { items } = run([
      bashStart("one"),
      bashStart("two"),
      bashUpdate("one", "first"),
      bashUpdate("two", "second"),
      bashUpdate("one", "first!"),
      bashUpdate("two", "second!"),
    ]);
    expect(
      items
        .filter((item) => item.type === "command_execution" && item.output !== undefined)
        .map((item) => [
          item.id,
          item.ordinal,
          item.type === "command_execution" ? item.output : null,
        ]),
    ).toEqual([
      [scopedItemId(context(), "one"), 0, "first"],
      [scopedItemId(context(), "two"), 1, "second"],
      [scopedItemId(context(), "one"), 0, "first!"],
      [scopedItemId(context(), "two"), 1, "second!"],
    ]);
  });

  it("retains changed paths and the native multi-file diff", () => {
    const { items } = run([
      {
        type: "tool_execution_start",
        toolCallId: "edit-1",
        toolName: "edit",
        args: { path: "src/a.ts" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "edit-1",
        toolName: "edit",
        result: {
          content: [{ type: "text", text: "Edited two files" }],
          details: {
            perFileResults: [
              { path: "src/a.ts", diff: "--- a/src/a.ts\n+++ b/src/a.ts" },
              { path: "src/b.ts", diff: "--- a/src/b.ts\n+++ b/src/b.ts" },
            ],
          },
        },
      },
    ]);
    expect(items.at(-1)).toMatchObject({
      type: "file_change",
      status: "completed",
      fileName: "src/a.ts",
      changes: [
        { path: "src/a.ts", operation: "edit" },
        { path: "src/b.ts", operation: "edit" },
      ],
      diffStr: "--- a/src/a.ts\n+++ b/src/a.ts\n--- a/src/b.ts\n+++ b/src/b.ts",
    });
  });

  it.each(["const x = 1;", ""])(
    "preserves exact written content (%j) without inventing a diff",
    (content) => {
      const { items } = run([
        {
          type: "tool_execution_start",
          toolCallId: "write-1",
          toolName: "write",
          args: { path: "new.ts", content },
        },
        {
          type: "tool_execution_end",
          toolCallId: "write-1",
          toolName: "write",
          result: { content: [{ type: "text", text: "Written successfully" }] },
        },
      ]);
      expect(items.at(-1)).toMatchObject({
        type: "file_change",
        fileName: "new.ts",
        newStr: content,
      });
      expect(items.at(-1)).not.toHaveProperty("diffStr");
    },
  );

  it.each([false, true])("recognizes host ownership before or after the start (%j)", (late) => {
    const host = { type: "host_tool_call", toolCallId: "host-1", toolName: "preview_snapshot" };
    const start = {
      type: "tool_execution_start",
      toolCallId: "host-1",
      toolName: "preview_snapshot",
      args: {},
    };
    const end = {
      type: "tool_execution_end",
      toolCallId: "host-1",
      toolName: "preview_snapshot",
      result: { content: [] },
    };
    const { items, state } = run(
      late ? [start, host, end, end] : [host, start, end, end],
      late ? emptyToolState() : withHostToolNames(emptyToolState(), ["preview_snapshot"]),
    );
    expect(items.map((item) => [item.id, item.status])).toEqual([
      [scopedItemId(context(), "host-1"), "running"],
      [scopedItemId(context(), "host-1"), "completed"],
    ]);
    expect(items.at(-1)).toMatchObject({ type: "dynamic_tool", toolSource: { key: "t3-code" } });
    expect(state.inFlightTools).toEqual({});
  });

  it("retains image content and native failure while exposing an authenticated workspace target", () => {
    const result = {
      isError: true,
      content: [{ type: "image", mimeType: "image/png", data: "cG5n" }],
      details: { meta: { source: { type: "path", value: "/workspace/diagram.png" } } },
    };
    const { items } = run([
      {
        type: "tool_execution_start",
        toolCallId: "image-1",
        toolName: "read",
        args: { path: "file:///workspace/diagram.png" },
      },
      { type: "tool_execution_end", toolCallId: "image-1", toolName: "read", result },
    ]);
    expect(items.at(-1)).toMatchObject({
      type: "dynamic_tool",
      status: "failed",
      output: result,
      viewedImagePath: "/workspace/diagram.png",
    });
  });

  it("keeps complete command output for on-demand V2 details, not live broadcasts", () => {
    const output = `line one\n${"x".repeat(3000)}\nlast 😀`;
    const { items } = run([bashStart("bash-long"), bashEnd("bash-long", output)]);
    const item = items.at(-1)!;
    expect(item).toMatchObject({ type: "command_execution", output });
    const wire = projectTurnItemForWire(item);
    expect(wire).not.toHaveProperty("output");
    expect(wire).toMatchObject({ outputOmitted: true });
    expect(projectTurnItemForDetail(item)).toMatchObject({ output });
  });

  it("accepts a final-only result and does not replace an empty final result with a stale window", () => {
    const finalOnly = run([bashEnd("final-only", "only at the end")]);
    expect(commandOutputs(finalOnly.items)).toEqual(["only at the end"]);
    const emptyFinal = run([
      bashStart("empty"),
      bashUpdate("empty", "stale"),
      bashEnd("empty", ""),
    ]);
    expect(emptyFinal.items.at(-1)).toMatchObject({ status: "completed", output: "" });
  });
});
