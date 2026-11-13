import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_TERMINAL_ID,
  TerminalAttachStreamEvent,
  TerminalError,
  TerminalOpenInput,
  TerminalProviderEnvironmentError,
} from "./terminal.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const encodeTerminalError = Schema.encodeUnknownSync(TerminalError);
const decodeTerminalError = Schema.decodeUnknownSync(TerminalError);
const decodeAttachEvent = Schema.decodeSync(TerminalAttachStreamEvent);
const decodeUnknownAttachEvent = Schema.decodeUnknownSync(TerminalAttachStreamEvent);
const decodeTerminalOpen = Schema.decodeSync(TerminalOpenInput);

describe("TerminalProviderEnvironmentError", () => {
  it("round-trips its required cause without exposing it in the message", () => {
    const cause = { operation: "read-secret", detail: "secret backend unavailable" };
    const error = new TerminalProviderEnvironmentError({
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      cause,
    });
    const encoded = encodeTerminalError(error);
    const decoded = decodeTerminalError(encoded);

    expect(decoded).toMatchObject({
      _tag: "TerminalProviderEnvironmentError",
      providerInstanceId: "codex_work",
      cause,
    });
    expect(decoded.message).not.toContain("secret backend unavailable");
  });
});

describe("terminal subscriber resynchronization", () => {
  it("decodes a closed attached terminal and rejects a resync without identity", () => {
    expect(
      decodeAttachEvent({
        type: "resync",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        snapshot: null,
      }),
    ).toEqual({
      type: "resync",
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      snapshot: null,
    });
    expect(() => decodeUnknownAttachEvent({ type: "resync" })).toThrow();
  });
});

describe("TerminalOpenInput", () => {
  it("drops invalid env keys while retaining valid overrides", () => {
    const parsed = decodeTerminalOpen({
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: "/tmp/project",
      env: { "bad-key": "1", GOOD_KEY: "2" },
    });
    expect(parsed.env).toEqual({ GOOD_KEY: "2" });
  });
});
