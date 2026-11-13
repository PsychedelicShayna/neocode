import { ArrowUpIcon, Clock3Icon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { Button, InlineButton } from "../ui/button";
import type { NativeQueuedMessage } from "./nativeTimeline";

const VISIBLE_ROWS = 3;

export function NativeQueuedMessages(props: {
  readonly messages: readonly NativeQueuedMessage[];
  readonly onSendNow: ((id: string) => void) | undefined;
  readonly onWithdraw: ((id: string) => void) | undefined;
}) {
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  if (props.messages.length === 0) return null;
  const visible = showAll ? props.messages : props.messages.slice(0, VISIBLE_ROWS);
  return (
    <section aria-label="Queued messages" className="flex flex-col gap-3 px-3 py-2">
      <div id={listId} className="flex flex-col gap-3">
        {visible.map((message) => {
          const sending = message.sending !== undefined;
          const contextCount =
            message.terminalContexts.length +
            message.previewAnnotations.length +
            message.reviewComments.length;
          return (
            <div
              key={message.id}
              className="flex flex-col items-end gap-1"
              data-queued-message-id={message.id}
            >
              <div className="max-w-[80%] rounded-2xl border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
                {message.prompt ? (
                  <p className="whitespace-pre-wrap wrap-anywhere">{message.prompt}</p>
                ) : null}
                {contextCount > 0 ? (
                  <p className="text-xs">
                    {contextCount} context {contextCount === 1 ? "item" : "items"}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock3Icon aria-hidden className="size-3.5" />
                <span>
                  {sending ? "Sending" : message.lane === "steering" ? "Steering" : "Queued"}
                </span>
                {message.lane === "followUp" && !sending && props.onSendNow ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label="Send now"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => props.onSendNow?.(message.id)}
                  >
                    <ArrowUpIcon aria-hidden className="size-3.5" />
                  </Button>
                ) : null}
                {!sending && props.onWithdraw ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label="Cancel and return to the composer"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => props.onWithdraw?.(message.id)}
                  >
                    <XIcon aria-hidden className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {props.messages.length > VISIBLE_ROWS ? (
        <div className="self-end">
          <InlineButton
            tone="muted"
            aria-expanded={showAll}
            aria-controls={listId}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? "Show fewer" : `Show all ${props.messages.length} queued`}
          </InlineButton>
        </div>
      ) : null}
    </section>
  );
}
