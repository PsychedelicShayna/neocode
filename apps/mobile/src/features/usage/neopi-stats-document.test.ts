import { runInNewContext } from "node:vm";
import type { NativeStatsTransportInput } from "@t3tools/client-runtime/neopi-stats-bridge";
import { describe, expect, it, vi } from "vite-plus/test";
import { createMobileStatsBridge, nativeStatsDocument } from "./neopi-stats-document";

type TestPort = {
  onmessage: ((event: { data: unknown }) => void) | null;
  onmessageerror: (() => void) | null;
  start: () => void;
  close: () => void;
  postMessage: (data: unknown) => void;
};

type TestWindow = {
  parent: { postMessage: (data: unknown, origin: string, ports?: TestPort[]) => void };
  ReactNativeWebView: { postMessage: (data: string) => void };
  addEventListener: (name: string, callback: () => void) => void;
  __neocodeStatsReceive?: (packet: unknown) => void;
};

const request = {
  type: "neopi-stats-request",
  version: 1,
  path: "/api/status",
  method: "GET",
  headers: {},
};

function documentContext(post: (data: string) => void) {
  const listeners = new Map<string, () => void>();
  const window: TestWindow = {
    parent: { postMessage: vi.fn() },
    ReactNativeWebView: { postMessage: post },
    addEventListener: (name, callback) => {
      listeners.set(name, callback);
    },
  };
  const context = { window };
  const html = nativeStatsDocument(
    "<!doctype html><html><head></head><body></body></html>",
    "view-bridge",
  );
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("The native document adapter was not installed.");
  runInNewContext(script, context);
  return { window, context, listeners };
}

describe("native stats mobile MessagePort serialization", () => {
  it("round-trips binary packets through the RN string bridge without exposing an authenticated URL", async () => {
    const lifetime = new AbortController();
    let receive: (data: string) => void = () => {};
    const document = documentContext((data) => receive(data));
    let finish: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const packets: unknown[] = [];
    const port: TestPort = {
      onmessage: null,
      onmessageerror: null,
      start: vi.fn(),
      close: vi.fn(),
      postMessage: (data) => {
        packets.push(data);
        if (typeof data !== "object" || data === null || !("type" in data)) return;
        if (data.type === "end") finish();
        else if (data.type === "headers" || data.type === "chunk")
          queueMicrotask(() => port.onmessage?.({ data: { type: "pull" } }));
      },
    };
    const execute = vi.fn(async (input: NativeStatsTransportInput) => {
      const bytes = new Uint8Array([255, 0, 60]);
      await input.consume({
        status: 200,
        ok: true,
        headers: new Headers(),
        text: async () => "",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      });
      return true;
    });
    const host = createMobileStatsBridge({
      bridgeId: "view-bridge",
      lifetime: lifetime.signal,
      execute,
      inject: (script) => {
        runInNewContext(script, document.context);
      },
    });
    receive = host.receive;
    document.window.parent.postMessage(request, "*", [port]);
    await ended;
    expect(execute).toHaveBeenCalledOnce();
    const chunk = packets.find(
      (packet) =>
        typeof packet === "object" &&
        packet !== null &&
        "type" in packet &&
        packet.type === "chunk",
    );
    expect(chunk).toBeDefined();
    if (typeof chunk !== "object" || chunk === null || !("bytes" in chunk))
      throw new Error("Missing native bytes.");
    expect(Array.from(chunk.bytes as Uint8Array)).toEqual([255, 0, 60]);
    expect(execute.mock.calls[0]?.[0].path).toBe("/api/status");
    host.dispose();
  });

  it("rejects packets from an old view and discards late packets after disposal", () => {
    const execute = vi.fn(async () => true);
    const host = createMobileStatsBridge({
      bridgeId: "current",
      lifetime: new AbortController().signal,
      execute,
      inject: vi.fn(),
    });
    host.receive(JSON.stringify({ bridge: "old", id: "1", type: "request", data: request }));
    host.dispose();
    host.receive(JSON.stringify({ bridge: "current", id: "1", type: "request", data: request }));
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels outstanding local ports when the native document closes", () => {
    const post = vi.fn();
    const document = documentContext(post);
    const port: TestPort = {
      onmessage: null,
      onmessageerror: null,
      start: vi.fn(),
      close: vi.fn(),
      postMessage: vi.fn(),
    };
    document.window.parent.postMessage(request, "*", [port]);
    document.listeners.get("pagehide")?.();
    expect(post.mock.calls.map(([value]) => JSON.parse(value).type)).toEqual(["request", "cancel"]);
    expect(port.close).toHaveBeenCalledOnce();
  });
});
