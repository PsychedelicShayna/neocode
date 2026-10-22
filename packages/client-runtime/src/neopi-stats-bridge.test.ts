import { describe, expect, it } from "vite-plus/test";
import { connectNativeStatsPort, type NativeStatsTransportInput } from "./neopi-stats-bridge.ts";

function inbox(port: MessagePort) {
  const queued: unknown[] = [];
  const waiting: Array<(value: unknown) => void> = [];
  port.onmessage = ({ data }) => { const next = waiting.shift(); if (next) next(data); else queued.push(data); };
  return () => queued.length ? Promise.resolve(queued.shift()) : new Promise<unknown>((resolve) => waiting.push(resolve));
}
const nativeRequest = (path = "/api/events") => ({ type: "neopi-stats-request", version: 1, path, method: "GET", headers: {} });

describe("native stats MessagePort transport", () => {
  it("rejects non-native paths before touching authenticated transport", async () => {
    for (const path of ["https://outside.test/", "//outside.test/", "/api/frustration/judge", "/api/unknown", "/api/session/../auth", "/api/status#fragment"]) {
      const channel = new MessageChannel();
      const next = inbox(channel.port2);
      let called = false;
      connectNativeStatsPort(nativeRequest(path), channel.port1, async () => { called = true; return true; }, new AbortController().signal);
      expect(await next()).toMatchObject({ type: "error" });
      expect(called).toBe(false);
      channel.port2.close();
    }
  });
  it("carries native bytes on demand and cancels an open SSE request on frame disposal", async () => {
    const channel = new MessageChannel();
    const next = inbox(channel.port2);
    const lifetime = new AbortController();
    const ended = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    let activeSignal: AbortSignal | undefined;
    connectNativeStatsPort(nativeRequest(), channel.port1, async (input: NativeStatsTransportInput) => {
      activeSignal = input.signal;
      try {
        await input.consume({ status: 200, ok: true, headers: new Headers({ "content-type": "text/event-stream" }), text: async () => "", body: new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode('data: {"indexingHours":9}\n\n')); },
          cancel() { cancelled.resolve(); },
        }) });
        return true;
      } finally { ended.resolve(); }
    }, lifetime.signal);
    expect(await next()).toMatchObject({ type: "headers", status: 200 });
    channel.port2.postMessage({ type: "pull" });
    const chunk = await next() as { type: string; bytes: Uint8Array };
    expect(chunk.type).toBe("chunk");
    expect(new TextDecoder().decode(chunk.bytes)).toContain('"indexingHours":9');
    lifetime.abort();
    await ended.promise;
    await cancelled.promise;
    expect(activeSignal?.aborted).toBe(true);
    channel.port2.close();
  });
  it("forwards native judgment headers but never frame-supplied credentials", async () => {
    const channel = new MessageChannel();
    const next = inbox(channel.port2);
    let forwarded: Readonly<Record<string, string>> | undefined;
    connectNativeStatsPort({ ...nativeRequest("/api/frustration/judge?range=7d"), method: "POST", headers: {
      "X-Omp-Stats-Action": "1", Authorization: "frame-credential", Cookie: "frame-cookie", "If-None-Match": '"etag"',
    } }, channel.port1, async (input) => {
      forwarded = input.headers;
      await input.consume({ status: 403, ok: false, headers: new Headers(), body: null, text: async () => "" });
      return true;
    }, new AbortController().signal);
    expect(await next()).toMatchObject({ type: "headers", status: 403 });
    expect(forwarded).toEqual({ "x-omp-stats-action": "1", "if-none-match": '"etag"' });
    expect(await next()).toEqual({ type: "end" });
    channel.port2.close();
  });
});
