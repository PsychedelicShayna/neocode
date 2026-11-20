import type { NativeSessionTarget } from "@t3tools/client-runtime/neopi-native-sessions";
import { forgetFocusedTerminal } from "~/lib/terminalFocus";
import { useRightPanelStore } from "~/rightPanelStore";
import { useTerminalUiStateStore } from "~/terminalUiStateStore";

/**
 * Stops one workspace terminal and clears its history. Only once the server
 * has closed it does it leave the drawer (and its right-panel surface, if any)
 * and lose its last-focused record; a failed close leaves everything as it was.
 */
export async function closeNativeTerminal<Result extends { readonly _tag: string }>(input: {
  readonly close: (value: {
    readonly environmentId: NativeSessionTarget["environmentId"];
    readonly input: { threadId: string; terminalId: string; deleteHistory: true };
  }) => Promise<Result>;
  readonly target: NativeSessionTarget;
  readonly threadId: string;
  readonly terminalId: string;
  readonly surfaceId: string | null;
}): Promise<Result> {
  const { close, target, threadId, terminalId, surfaceId } = input;
  const result = await close({
    environmentId: target.environmentId,
    input: { threadId, terminalId, deleteHistory: true },
  });
  if (result._tag === "Failure") return result;
  useTerminalUiStateStore.getState().closeTerminal(target, terminalId);
  if (surfaceId) useRightPanelStore.getState().closeTerminal(target, surfaceId, terminalId);
  forgetFocusedTerminal({ environmentId: target.environmentId, threadId, terminalId });
  return result;
}
