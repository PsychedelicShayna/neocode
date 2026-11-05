import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nativeDictationAvailability } from "./nativeDictation";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const base = {
  isDesktop: true,
  localEnvironmentDisabled: false,
  environmentId: local,
  primaryEnvironmentId: local,
  attachment: "owned" as const,
  capabilities: ["dictation"] as readonly string[] | null,
  connected: true,
  sttEnabled: true as boolean | undefined,
};

const reasonOf = (input: Parameters<typeof nativeDictationAvailability>[0]) => {
  const result = nativeDictationAvailability(input);
  if (result.kind !== "disabled") throw new Error(`expected disabled, got ${result.kind}`);
  return result.reason;
};

describe("native dictation availability", () => {
  it("is enabled for an owned session and a terminal-attached one that both advertise dictation", () => {
    expect(nativeDictationAvailability(base)).toEqual({ kind: "enabled" });
    expect(nativeDictationAvailability({ ...base, attachment: "terminal" })).toEqual({
      kind: "enabled",
    });
  });

  it("treats an unreported stt setting as usable and lets NeoPi refuse at start", () => {
    expect(nativeDictationAvailability({ ...base, sttEnabled: undefined })).toEqual({
      kind: "enabled",
    });
  });

  it("has no microphone control outside the desktop app", () => {
    expect(nativeDictationAvailability({ ...base, isDesktop: false })).toEqual({ kind: "hidden" });
  });

  it("explains a session on another computer", () => {
    for (const input of [
      { ...base, environmentId: remote },
      { ...base, primaryEnvironmentId: null },
      { ...base, localEnvironmentDisabled: true },
    ])
      expect(reasonOf(input)).toMatch(/computer running NeoPi/);
  });

  it("waits for the connection before judging capabilities", () => {
    expect(reasonOf({ ...base, capabilities: null })).toMatch(/once NeoPi is connected/);
    expect(reasonOf({ ...base, connected: false })).toMatch(/once NeoPi is connected/);
  });

  it("names the terminal case when its NeoPi does not advertise dictation", () => {
    const terminal = reasonOf({ ...base, attachment: "terminal", capabilities: [] });
    expect(terminal).toMatch(/terminal/);
    expect(terminal).toMatch(/Update NeoPi/);
    const owned = reasonOf({ ...base, capabilities: ["session_journal"] });
    expect(owned).toMatch(/does not support dictation/);
    expect(owned).not.toBe(terminal);
  });

  it("points at stt.enabled when speech-to-text is off, in either attachment", () => {
    for (const attachment of ["owned", "terminal"] as const)
      expect(reasonOf({ ...base, attachment, sttEnabled: false })).toMatch(/stt\.enabled/);
  });

  it("reports a missing capability before a disabled setting", () => {
    expect(reasonOf({ ...base, capabilities: [], sttEnabled: false })).toMatch(
      /does not support dictation/,
    );
  });
});
