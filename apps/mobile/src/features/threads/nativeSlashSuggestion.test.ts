import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { describe, expect, it, vi } from "vite-plus/test";
import { selectNativeSlashSuggestion } from "./nativeSlashSuggestion";

describe("native slash suggestions during dictation", () => {
  it.each(["preparing", "recording", "transcribing"] as const)(
    "does not replace or submit the draft while %s",
    (phase) => {
      let voice: VoiceInputState = { phase: "idle", error: null, errorAction: null };
      const composer = { setText: vi.fn(), send: vi.fn(async () => {}) };
      // A touch queued before the composer redraws must read the current voice phase.
      const chooseCommand = () => selectNativeSlashSuggestion(() => voice, composer, "/model ");
      const chooseArgument = () =>
        selectNativeSlashSuggestion(() => voice, composer, "/model Example", true);
      voice = { phase, error: null, errorAction: null };

      chooseCommand();
      chooseArgument();
      expect(composer.setText).not.toHaveBeenCalled();
      expect(composer.send).not.toHaveBeenCalled();
    },
  );

  it.each(["idle", "error"] as const)("allows choices when voice is %s", (phase) => {
    const voice: VoiceInputState = { phase, error: null, errorAction: null };
    const composer = { setText: vi.fn(), send: vi.fn(async () => {}) };
    selectNativeSlashSuggestion(() => voice, composer, "/model ");
    expect(composer.setText).toHaveBeenLastCalledWith("/model ");
    expect(composer.send).not.toHaveBeenCalled();

    selectNativeSlashSuggestion(() => voice, composer, "/model Example", true);
    expect(composer.setText).toHaveBeenLastCalledWith("/model Example");
    expect(composer.send).toHaveBeenCalledTimes(1);
  });
});
