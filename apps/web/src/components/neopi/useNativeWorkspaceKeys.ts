import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef } from "react";
import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { dispatchKeybindingCommand } from "~/commandTable";
import { isElectron } from "~/env";
import { resolveShortcutCommand } from "~/keybindings";
import { isPreviewFocused } from "~/lib/previewFocus";
import { isTerminalCloseConfirmPending } from "~/lib/terminalCloseConfirm";
import {
  preventRepeatedTerminalCloseShortcut,
  preventTerminalCloseShortcut,
} from "~/lib/terminalCloseShortcut";
import { getTerminalFocusOwner } from "~/lib/terminalFocus";

export interface NativeWorkspaceKeyState {
  readonly terminalOpen: boolean;
  readonly previewOpen: boolean;
  readonly modelPickerOpen: boolean;
}

/**
 * The native session workspace's keybindings: each key resolves against the
 * workspace's state and runs the command the table holds for the workspace.
 * `readState` is read at each key.
 */
export function useNativeWorkspaceKeys(
  keybindings: ResolvedKeybindingsConfig,
  readState: () => NativeWorkspaceKeyState,
): void {
  const latest = useRef(readState);
  useLayoutEffect(() => {
    latest.current = readState;
  });
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (
        preventRepeatedTerminalCloseShortcut(event, keybindings) ||
        (isTerminalCloseConfirmPending() && preventTerminalCloseShortcut(event, keybindings))
      ) {
        event.stopPropagation();
        return;
      }
      if (isCommandPaletteOpen()) return;
      const terminalFocus = getTerminalFocusOwner();
      if (event.defaultPrevented && terminalFocus === null) return;
      const state = latest.current();
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: terminalFocus !== null,
          terminalOpen: state.terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen: state.previewOpen,
          modelPickerOpen: state.modelPickerOpen,
          editableFocus:
            event.target instanceof HTMLElement &&
            Boolean(event.target.closest("input,textarea,select,[contenteditable=true]")),
          isWeb: !isElectron,
          isDesktop: isElectron,
          nativeSession: true,
          composerFocus:
            event.target instanceof HTMLElement &&
            event.target.closest("[data-composer-rich-text]") !== null,
        },
      });
      if (!command) return;
      // Escape that ends an IME composition belongs to the input method.
      if (command === "thread.stop" && event.isComposing) return;
      dispatchKeybindingCommand(command, event, "workspace");
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [keybindings]);
}
