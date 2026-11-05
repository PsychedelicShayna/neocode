import {
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

/** Apply a native command choice only if the current voice operation allows draft edits. */
export function selectNativeSlashSuggestion(
  getVoiceState: () => VoiceInputState,
  composer: { setText: (text: string) => void; send: () => Promise<void> },
  text: string,
  submitsCommand = false,
): void {
  const state = getVoiceState();
  if (voiceInputFreezesEditor(state) || voiceInputBlocksSubmission(state)) return;
  composer.setText(text);
  if (submitsCommand) void composer.send();
}
