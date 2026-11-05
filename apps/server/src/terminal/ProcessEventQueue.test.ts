import { describe, expect, it, vi } from "vite-plus/test";

import { ProcessEventQueue } from "./ProcessEventQueue.ts";
import type { PtyProcess } from "./PtyAdapter.ts";

function processHandle(): PtyProcess {
  return {
    pid: 42,
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
    onData: () => () => undefined,
    onExit: () => () => undefined,
  };
}

describe("PTY process event FIFO", () => {
  it("accounts only outstanding chunks while a sustained backlog never empties", () => {
    const queue = new ProcessEventQueue();
    const process = processHandle();
    queue.push({ type: "output", data: "0" }, process);
    for (let index = 1; index <= 10_000; index += 1) {
      const data = String(index);
      queue.push({ type: "output", data }, process);
      expect(queue.shift()).toEqual({ type: "output", data: String(index - 1) });
      expect(queue.size).toBe(1);
      expect(queue.bufferedBytes).toBe(data.length * 2);
    }
    queue.push({ type: "exit", event: { exitCode: 0, signal: null } }, process);
    expect(queue.shift()).toEqual({ type: "output", data: "10000" });
    expect(queue.shift()).toEqual({ type: "exit", event: { exitCode: 0, signal: null } });
    expect(queue.size).toBe(0);
    expect(queue.bufferedBytes).toBe(0);
    expect(queue.shift()).toBeUndefined();
    expect(process.pause).not.toHaveBeenCalled();
  });

  it("pauses on retained string bytes and resumes only after the low watermark", () => {
    const queue = new ProcessEventQueue();
    const process = processHandle();
    const data = "🙂".repeat(32_768); // 128 KiB of UTF-16 storage per chunk.
    for (let index = 0; index < 8; index += 1) queue.push({ type: "output", data }, process);
    expect(queue.bufferedBytes).toBe(1024 * 1024);
    expect(process.pause).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 5; index += 1) queue.shift();
    expect(process.resume).not.toHaveBeenCalled();
    queue.shift();
    expect(process.resume).toHaveBeenCalledTimes(1);
    expect(queue.bufferedBytes).toBe(256 * 1024);
  });

  it("also bounds tiny-event backlog and resumes a paused process when cleared", () => {
    const queue = new ProcessEventQueue();
    const process = processHandle();
    for (let index = 0; index < 1024; index += 1) {
      queue.push({ type: "output", data: "" }, process);
    }
    expect(process.pause).toHaveBeenCalledTimes(1);
    queue.clear();
    expect(process.resume).toHaveBeenCalledTimes(1);
    expect(queue.size).toBe(0);
    expect(queue.bufferedBytes).toBe(0);
    queue.clear();
    expect(process.resume).toHaveBeenCalledTimes(1);
    queue.push({ type: "output", data: "next process" }, process);
    expect(queue.shift()).toEqual({ type: "output", data: "next process" });
  });
});
