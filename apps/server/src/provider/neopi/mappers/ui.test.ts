import { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { NEOPI_CAPABILITIES } from "../NeoPiCompatibility.ts";
import { scopedItemId } from "./MapCtx.ts";
import { mapperTestContext } from "./mapperTestContext.ts";
import { mapPlanProposal } from "./mode.ts";
import { emptyUiState, flushUiSettlements, mapUiRequest, NEOPI_CAP_TOOL_APPROVAL } from "./ui.ts";

const decodeEvent = Schema.decodeSync(ProviderAdapterV2Event);

function harness() {
  const ctx = mapperTestContext();
  const state = emptyUiState();
  const validate = (events: ProviderAdapterV2Event[]) => {
    for (const event of events) {
      decodeEvent(event);
      if (event.type === "provider_thread.updated")
        Object.assign(ctx, { providerThread: event.providerThread });
    }
    return events;
  };
  return {
    state,
    current: () => ctx,
    send(frame: unknown) {
      const result = mapUiRequest(ctx, frame, state);
      validate(result.events);
      return result;
    },
    flush: () => validate(flushUiSettlements(ctx, state)),
  };
}

function requests(events: ProviderAdapterV2Event[]) {
  return events.flatMap((event) =>
    event.type === "runtime_request.updated" ? [event.runtimeRequest] : [],
  );
}
function items(events: ProviderAdapterV2Event[]) {
  return events.flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []));
}
const approval = (id: string) => ({
  type: "extension_ui_request",
  method: "select",
  id,
  title: "Allow tool: bash\nReason: destructive command\nCommand: rm -rf build",
  options: ["Approve", "Deny"],
});

describe("NeoPi UI mapper", () => {
  it("keeps a live approval pending until wire delivery and exposes only native-supported choices", () => {
    const h = harness();
    const result = h.send({ ...approval("a"), timeout: 1234 });
    expect(items(result.events)).toMatchObject([
      {
        type: "approval_request",
        requestKind: "command",
        status: "waiting",
        prompt: expect.stringContaining("Timeout: 1234ms"),
        options: [{ decision: "accept" }, { decision: "decline" }],
      },
    ]);
    expect(requests(result.events)).toMatchObject([
      {
        id: result.pending?.requestId,
        status: "pending",
        nodeId: "root-node",
        nativeRequestRef: { nativeId: "a" },
        responseCapability: { type: "live", providerSessionId: "session-test" },
      },
    ]);
    expect(result.pending?.reply("acceptForSession")).toEqual({
      _tag: "ExtensionUi",
      frame: { id: "a", value: "Approve" },
    });
    expect(h.flush()).toEqual([]);
    expect(h.state.open.has("a")).toBe(true);
    result.pending?.settle("accept");
    expect(requests(h.flush())).toMatchObject([
      {
        id: result.pending?.requestId,
        status: "resolved",
        decision: "accept",
      },
    ]);
    expect(h.state.open.has("a")).toBe(false);
  });

  it("keeps similarly worded ordinary selects out of the approval path", () => {
    const h = harness();
    const result = h.send({
      type: "extension_ui_request",
      id: "choice",
      method: "select",
      title: "Would you allow tool: bash?",
      options: ["Approve", "Deny"],
    });
    expect(result.pending?.kind).toBe("user-input");
    expect(items(result.events)).toMatchObject([{ type: "user_input_request" }]);
    expect(requests(result.events)).toMatchObject([{ kind: "user_input" }]);
  });

  it("links approvals only to an unambiguous running tool and retains the exact operation", () => {
    const h = harness();
    for (const [toolCallId, command] of [
      ["tool-1", "first"],
      ["tool-2", "second"],
    ]) {
      h.send({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command } });
    }
    const ambiguous = items(h.send(approval("a")).events)[0];
    expect(ambiguous?.parentItemId).toBeNull();
    h.send({ type: "tool_execution_end", toolCallId: "tool-2" });
    const unique = items(h.send(approval("b")).events)[0];
    expect(unique).toMatchObject({
      type: "approval_request",
      parentItemId: scopedItemId(h.current(), "tool-1"),
      prompt: expect.stringContaining('Arguments: {"command":"first"}'),
    });
  });

  it("gates structured approvals on current capabilities and sends the dedicated native response", () => {
    const h = harness();
    const frame = {
      type: "tool_approval_request",
      id: "structured",
      toolCallId: "tool-3",
      toolName: "bash",
      args: { command: "rm build" },
      reason: "danger",
      details: ["Command: rm build"],
    };
    expect(h.send(frame).events).toEqual([]);
    h.send({ type: "ready", capabilities: [NEOPI_CAP_TOOL_APPROVAL] });
    const result = h.send(frame);
    expect(items(result.events)).toMatchObject([
      {
        requestKind: "command",
        parentItemId: scopedItemId(h.current(), "tool-3"),
        prompt: expect.stringContaining('Arguments: {"command":"rm build"}'),
        options: [
          { decision: "accept" },
          { decision: "acceptForSession" },
          { decision: "decline" },
        ],
      },
    ]);
    expect(result.pending?.reply("acceptForSession")).toEqual({
      _tag: "ToolApproval",
      frame: { type: "tool_approval_response", id: "structured", decision: "allow_session" },
    });
    result.pending?.settle("acceptForSession");
    expect(requests(h.flush())).toMatchObject([
      { status: "resolved", decision: "acceptForSession" },
    ]);
    h.send({ type: "ready", capabilities: [] });
    expect(h.send({ ...frame, id: "unsupported" }).events).toEqual([]);
  });

  it("keeps prelude arguments available when native approval details are absent", () => {
    const h = harness();
    h.send({ type: "ready", capabilities: [NEOPI_CAP_TOOL_APPROVAL] });
    const result = h.send({
      type: "tool_approval_request",
      id: "prelude-approval",
      toolCallId: "prelude-browser-abc",
      toolName: "browser",
      args: { url: "https://example.org/private", action: "navigate" },
      details: [],
    });
    expect(items(result.events)).toMatchObject([
      {
        type: "approval_request",
        prompt: expect.stringContaining(
          'Arguments: {"url":"https://example.org/private","action":"navigate"}',
        ),
      },
    ]);
    expect(result.pending?.reply("decline")).toEqual({
      _tag: "ToolApproval",
      frame: { type: "tool_approval_response", id: "prelude-approval", decision: "deny" },
    });
  });

  it("preserves successive answers verbatim and keeps editor prefill separate from offered choices", () => {
    const h = harness();
    const first = h.send({
      type: "extension_ui_request",
      id: "q1",
      method: "select",
      title: "Which file?",
      options: ["src/foo", "Other (type your own)"],
    });
    expect(items(first.events)).toMatchObject([
      {
        type: "user_input_request",
        questions: [{ allowCustomAnswer: false, multiSelect: false }],
      },
    ]);
    expect(first.pending?.reply({ q1: "Other (type your own)" })).toEqual({
      _tag: "ExtensionUi",
      frame: { id: "q1", value: "Other (type your own)" },
    });
    first.pending?.settle({ q1: "Other (type your own)" });
    const editor = h.send({
      type: "extension_ui_request",
      id: "q2",
      method: "editor",
      title: "Enter path",
      prefill: " src/default path ",
    });
    expect(requests(editor.events)).toMatchObject([
      { status: "resolved", answers: { q1: "Other (type your own)" } },
      { status: "pending" },
    ]);
    expect(items(editor.events).at(-1)).toMatchObject({
      type: "user_input_request",
      questions: [{ options: [], initialAnswer: " src/default path ", allowCustomAnswer: true }],
    });
    expect(editor.pending?.reply({ q2: "src/foo/bar baz" })).toEqual({
      _tag: "ExtensionUi",
      frame: { id: "q2", value: "src/foo/bar baz" },
    });
    editor.pending?.settle({ q2: "src/foo/bar baz" });
    const next = h.send({
      type: "extension_ui_request",
      id: "q3",
      method: "select",
      title: "Continue?",
      options: ["Yes", "No"],
      optionDetails: [{ description: "proceed" }, { description: "stop" }],
    });
    expect(requests(next.events)[0]?.answers).toEqual({ q2: "src/foo/bar baz" });
    expect(items(next.events).at(-1)).toMatchObject({
      questions: [
        {
          options: [
            { label: "Yes", description: "proceed" },
            { label: "No", description: "stop" },
          ],
        },
      ],
    });
  });

  it("cancels only the target and rejects late settlement after the same native id is reused", () => {
    const h = harness();
    const old = h.send(approval("a"));
    h.send({ type: "extension_ui_request", id: "b", method: "input", title: "Value" });
    const cancelled = h.send({ type: "tool_approval_cancel", targetId: "a" });
    expect(requests(cancelled.events)).toMatchObject([
      { id: old.pending?.requestId, status: "cancelled" },
    ]);
    expect(h.state.open.has("b")).toBe(true);
    const reopened = h.send(approval("a"));
    expect(reopened.pending?.requestId).not.toBe(old.pending?.requestId);
    old.pending?.settle("accept");
    expect(h.flush()).toEqual([]);
    expect(h.state.open.has("a")).toBe(true);
    const cancelledInput = h.send({
      type: "extension_ui_request",
      id: "cancel",
      method: "cancel",
      targetId: "b",
    });
    expect(requests(cancelledInput.events)).toMatchObject([
      { status: "cancelled", kind: "user_input" },
    ]);
    expect(
      items(h.send({ type: "tool_approval_cancel", targetId: "missing" }).events),
    ).toMatchObject([{ type: "system_notice" }]);
  });

  it("maps confirmations without treating absent answers as consent", () => {
    const h = harness();
    const result = h.send({
      type: "extension_ui_request",
      id: "c",
      method: "confirm",
      title: "Proceed?",
      message: "Launch task?",
      timeout: 500,
    });
    expect(items(result.events)).toMatchObject([
      {
        questions: [
          {
            question: "Launch task?\nTimeout: 500ms",
            allowCustomAnswer: false,
            options: [{ value: "true" }, { value: "false" }],
          },
        ],
      },
    ]);
    expect(result.pending?.reply({ c: true })).toEqual({
      _tag: "ExtensionUi",
      frame: { id: "c", confirmed: true },
    });
    expect(result.pending?.reply({ unrelated: "true", c: "false" })).toEqual({
      _tag: "ExtensionUi",
      frame: { id: "c", confirmed: false },
    });
    expect(result.pending?.reply({ unrelated: true })).toEqual({
      _tag: "ExtensionUi",
      frame: { id: "c", cancelled: true },
    });
  });

  it("carries native UI metadata and title updates without manufacturing pending replies", () => {
    const h = harness();
    for (const [frame, metadata] of [
      [
        { method: "notify", message: "hello", notifyType: "info" },
        { neopiUi: { kind: "notice", level: "info" } },
      ],
      [
        { method: "setStatus", statusKey: "job", statusText: "running" },
        { neopiUi: { kind: "status", key: "job", text: "running" } },
      ],
      [
        { method: "setWidget", widgetKey: "review", widgetLines: ["line"] },
        { neopiUi: { kind: "widget", key: "review", lines: ["line"] } },
      ],
      [
        { method: "set_editor_text", text: "draft" },
        { neopiUi: { kind: "editor", text: "draft" } },
      ],
      [
        { method: "open_url", url: "https://example.com/long", launchUrl: "http://localhost/go" },
        { url: "https://example.com/long", launchUrl: "http://localhost/go" },
      ],
    ] as const) {
      const result = h.send({
        type: "extension_ui_request",
        id: `notice-${frame.method}`,
        ...frame,
      });
      expect(result.pending).toBeUndefined();
      expect(items(result.events)).toMatchObject([
        { type: "system_notice", providerMetadata: metadata },
      ]);
    }
    h.send({ type: "extension_ui_request", id: "title", method: "setTitle", title: "Working" });
    expect(h.current().providerThread.nativeMetadata).toMatchObject({
      title: "Working",
      modelSelection: { model: "openai/initial", options: [{ id: "fastMode", value: true }] },
    });
  });

  it("publishes native mode transitions once without confusing chat and plan modes", () => {
    const h = harness();
    expect(
      items(h.send({ type: "t3.state", state: { mode: "plan", chatMode: "off" } }).events),
    ).toMatchObject([
      { providerMetadata: { neopiUi: { kind: "chat-mode", mode: "off" } } },
      { providerMetadata: { neopiUi: { kind: "plan-mode", mode: "plan" } } },
    ]);
    expect(items(h.send({ type: "mode_changed", mode: "default" }).events)).toMatchObject([
      { providerMetadata: { neopiUi: { kind: "plan-mode", mode: "default" } } },
    ]);
    expect(h.send({ type: "t3.state", state: { mode: "default" } }).events).toEqual([]);
    expect(items(h.send({ type: "mode_changed", mode: "plan" }).events)).toMatchObject([
      { providerMetadata: { neopiUi: { kind: "plan-mode", mode: "plan" } } },
    ]);
  });
  it("keeps native plan identities scoped to the session and turn without settling a turn", () => {
    const ctx = mapperTestContext();
    const frame = { type: "plan_proposal_request", id: "plan", planMarkdown: "# Native plan" };
    expect(mapPlanProposal(ctx, frame, new Set()).events).toEqual([]);
    const capabilities = new Set([NEOPI_CAPABILITIES.setMode]);
    const first = mapPlanProposal(ctx, frame, capabilities);
    for (const event of first.events) decodeEvent(event);
    const plan = first.events.find((event) => event.type === "plan.updated")?.plan;
    const item = first.events.find((event) => event.type === "turn_item.updated")?.turnItem;
    expect(plan).toMatchObject({
      kind: "proposed_plan",
      status: "draft",
      markdown: "# Native plan",
    });
    expect(item).toMatchObject({
      type: "proposed_plan",
      planId: plan?.id,
      markdown: "# Native plan",
    });
    expect(first.events.some((event) => event.type === "turn.terminal")).toBe(false);
    const other = mapPlanProposal(
      { ...ctx, sessionKey: "another-native-session" },
      frame,
      capabilities,
    );
    expect(other.events.find((event) => event.type === "plan.updated")?.plan.id).not.toBe(plan?.id);
  });
});
