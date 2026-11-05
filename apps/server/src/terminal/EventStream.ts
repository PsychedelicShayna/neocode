import {
  DEFAULT_TERMINAL_ID,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  type TerminalEventsStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { TerminalManager } from "./Manager.ts";
import { boundedEventStream } from "../boundedEventStream.ts";

type Event = TerminalEvent | TerminalAttachStreamEvent;

function retainedBytes(event: Event): number {
  const snapshot = "snapshot" in event ? event.snapshot : null;
  return (
    256 +
    2 *
      (("threadId" in event ? event.threadId.length + event.terminalId.length : 0) +
        (event.type === "output" ? event.data.length : 0) +
        (event.type === "error" ? event.message.length : 0) +
        (event.type === "activity" ? event.label.length : 0) +
        (snapshot === null
          ? 0
          : snapshot.history.length +
            snapshot.cwd.length +
            (snapshot.worktreePath?.length ?? 0) +
            snapshot.threadId.length +
            snapshot.terminalId.length +
            snapshot.label.length +
            snapshot.updatedAt.length))
  );
}

export function terminalAttachStream(
  manager: Pick<TerminalManager["Service"], "attachStream" | "getSnapshot">,
  input: TerminalAttachInput,
) {
  return Stream.suspend(() => {
    let sequence = -1;
    const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
    return boundedEventStream(
      (listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>) =>
        manager.attachStream(input, listener),
      manager.getSnapshot({ threadId: input.threadId, terminalId }).pipe(
        Effect.map((snapshot): ReadonlyArray<TerminalAttachStreamEvent> => {
          sequence = snapshot?.sequence ?? -1;
          return [{ type: "resync", threadId: input.threadId, terminalId, snapshot }];
        }),
      ),
      retainedBytes,
    ).pipe(
      Stream.filter((event) => {
        if (event.type === "snapshot" || event.type === "resync") {
          sequence = event.snapshot?.sequence ?? -1;
          return true;
        }
        // Output may have entered the manager history before publishEvent yielded
        // to this subscriber. Never replay bytes already included in the resync.
        if (event.sequence !== undefined) {
          if (event.sequence <= sequence) return false;
          sequence = event.sequence;
        }
        return true;
      }),
    );
  });
}

export function terminalEventsStream(manager: Pick<TerminalManager["Service"], "subscribe">) {
  return boundedEventStream(
    (listener: (event: TerminalEvent) => Effect.Effect<void>) => manager.subscribe(listener),
    Effect.succeed<ReadonlyArray<TerminalEventsStreamEvent>>([{ type: "resync" }]),
    retainedBytes,
  );
}
