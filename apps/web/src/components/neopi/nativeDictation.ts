import type { EnvironmentId } from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";

import { folderDropTarget } from "../chat/folderDrop";

/** Advertised in NeoPi's `ready` frame, and in a control connection's hello, when it serves `dictation_*`. */
const NATIVE_DICTATION_CAPABILITY = "dictation";

export type NativeDictationAvailability =
  /** Not the desktop app: the composer has no microphone control at all. */
  | { readonly kind: "hidden" }
  | { readonly kind: "enabled" }
  /** Shown disabled; `reason` says what is wrong and what fixes it. */
  | { readonly kind: "disabled"; readonly reason: string };

// NeoPi records its host's microphone, so dictation is local-desktop only.
// Owned and terminal sessions each need their own connection's dictation capability.
export function nativeDictationAvailability(input: {
  readonly isDesktop: boolean;
  readonly localEnvironmentDisabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly connection: Pick<PreparedConnection, "target" | "httpBaseUrl"> | null;
  readonly attachment: "owned" | "terminal" | undefined;
  /** The session connection's capabilities; null until the session has opened. */
  readonly capabilities: readonly string[] | null;
  readonly connected: boolean;
  /** NeoPi's `get_state.dictationEnabled` (`stt.enabled`); absent when NeoPi does not report it. */
  readonly sttEnabled: boolean | undefined;
}): NativeDictationAvailability {
  if (!input.isDesktop) return { kind: "hidden" };
  const disabled = (reason: string): NativeDictationAvailability => ({ kind: "disabled", reason });
  if (folderDropTarget({ ...input, isDesktopRenderer: input.isDesktop }) === "remote")
    return disabled(
      "Dictation records on the computer running NeoPi, so it only works in NeoCode on that computer. This session runs on another one.",
    );
  if (input.capabilities === null || !input.connected)
    return disabled("Dictation is available once NeoPi is connected.");
  if (!input.capabilities.includes(NATIVE_DICTATION_CAPABILITY))
    return disabled(
      input.attachment === "terminal"
        ? "This terminal's NeoPi does not offer dictation to NeoCode yet. Update NeoPi, then restart that terminal session."
        : "This NeoPi does not support dictation. Update NeoPi to use it.",
    );
  if (input.sttEnabled === false)
    return disabled(
      "Speech-to-text is off in NeoPi. Turn on stt.enabled in NeoPi's settings to dictate.",
    );
  return { kind: "enabled" };
}
