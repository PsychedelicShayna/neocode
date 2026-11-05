import type { PtyExitEvent, PtyProcess } from "./PtyAdapter.ts";

export type PendingProcessEvent =
  | { type: "output"; data: string }
  | { type: "exit"; event: PtyExitEvent };

const HIGH_BYTES = 1024 * 1024;
const LOW_BYTES = HIGH_BYTES / 4;
const HIGH_EVENTS = 1024;
const LOW_EVENTS = HIGH_EVENTS / 4;

/** Releases consumed chunks even if a busy PTY never lets the FIFO become empty. */
export class ProcessEventQueue {
  private events: Array<PendingProcessEvent | undefined> = [];
  private head = 0;
  private bytes = 0;
  private pausedProcess: PtyProcess | null = null;

  get size(): number {
    return this.events.length - this.head;
  }

  get bufferedBytes(): number {
    return this.bytes;
  }

  push(event: PendingProcessEvent, process: PtyProcess): void {
    this.events.push(event);
    // JS strings retain at most two bytes per UTF-16 code unit. Do not re-encode
    // every chunk just to decide when to stop reading from the PTY.
    if (event.type === "output") this.bytes += event.data.length * 2;
    if (this.pausedProcess === null && (this.bytes >= HIGH_BYTES || this.size >= HIGH_EVENTS)) {
      this.pausedProcess = process;
      process.pause();
    }
  }

  shift(): PendingProcessEvent | undefined {
    const event = this.events[this.head];
    if (event === undefined) return undefined;
    this.events[this.head++] = undefined;
    if (event.type === "output") this.bytes -= event.data.length * 2;
    if (this.head === this.events.length) {
      this.events.length = 0;
      this.head = 0;
    } else if (this.head >= HIGH_EVENTS && this.head * 2 >= this.events.length) {
      this.events = this.events.slice(this.head);
      this.head = 0;
    }
    if (this.bytes <= LOW_BYTES && this.size <= LOW_EVENTS) this.resume();
    return event;
  }

  clear(): void {
    this.events.length = 0;
    this.head = 0;
    this.bytes = 0;
    this.resume();
  }

  private resume(): void {
    const process = this.pausedProcess;
    this.pausedProcess = null;
    process?.resume();
  }
}
