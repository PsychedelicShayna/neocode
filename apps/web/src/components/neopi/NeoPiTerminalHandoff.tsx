import type { NativeSessionTarget } from "@t3tools/client-runtime/neopi-native-sessions";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { TerminalIcon } from "lucide-react";
import { useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { nativeSessionAtoms, selectNativeSession } from "../../state/neopiNativeSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

export function NeoPiTerminalHandoff({
  target,
  connected,
}: {
  target: NativeSessionTarget;
  connected: boolean;
}) {
  const handoff = useAtomCommand(nativeSessionAtoms.handoff, { reportFailure: false });
  const [pending, setPending] = useState(false);

  async function continueInTerminal() {
    if (pending || !connected) return;
    setPending(true);
    try {
      const result = await handoff({
        environmentId: target.environmentId,
        input: { ref: target.ref },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) throw squashAtomCommandFailure(result);
        return;
      }
      const command = result.value.command;
      let copied = false;
      try {
        copied = await writeTextToClipboard(command, "NeoPi terminal command");
      } catch {
        // The session is already released; still show the command when copying fails.
      }
      toastManager.add({
        type: copied ? "success" : "warning",
        title: copied ? "Terminal command copied" : "Session released — copy this terminal command",
        description: command,
        timeout: 0,
      });
      selectNativeSession(null);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not continue in terminal",
        description:
          cause instanceof Error ? cause.message : "Unable to hand off this NeoPi session.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Continue in terminal"
            disabled={pending || !connected}
            onClick={() => {
              void continueInTerminal();
            }}
          />
        }
      >
        <TerminalIcon className="size-4" />
      </TooltipTrigger>
      <TooltipPopup>Continue in terminal</TooltipPopup>
    </Tooltip>
  );
}
