import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { TerminalIcon } from "lucide-react";
import { useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { neopiSessionHandoff } from "../../state/neopiSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

export function NeoPiTerminalHandoff({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const thread = useThreadShell(threadRef);
  const providersByEnvironment = useEnvironmentProviders();
  const handoff = useAtomCommand(neopiSessionHandoff, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const provider =
    threadRef && thread
      ? providersByEnvironment
          .get(threadRef.environmentId)
          ?.find(
            (entry) =>
              entry.instanceId ===
              (thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId),
          )
      : null;
  if (!threadRef || !thread || provider?.driver !== "neopi") return null;

  async function continueInTerminal() {
    if (pending || !threadRef) return;
    setPending(true);
    try {
      const result = await handoff({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
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
        title: copied ? "Terminal command copied" : "Session released: copy this terminal command",
        description: command,
        timeout: 0,
      });
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
            disabled={pending}
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
