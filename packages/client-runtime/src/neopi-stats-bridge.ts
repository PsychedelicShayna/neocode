import { isNeoPiStatsPathAllowed } from "@t3tools/shared/neopiStats";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type { NativeStatsResponse } from "./state/neopiStats.ts";

const Request = Schema.Struct({
  type: Schema.Literal("neopi-stats-request"), version: Schema.Literal(1),
  path: Schema.String, method: Schema.Literals(["GET", "POST"]),
  headers: Schema.Record(Schema.String, Schema.String),
});
const decode = Schema.decodeUnknownOption(Request);

export interface NativeStatsTransportInput {
  readonly path: string;
  readonly method: "GET" | "POST" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly consume: (response: NativeStatsResponse) => Promise<void>;
}

export type NativeStatsPort = Pick<MessagePort, "postMessage" | "close" | "onmessage" | "onmessageerror">;

/** The source window is checked by the caller before any port or payload is accepted. */
export function connectNativeStatsPort(
  data: unknown, port: NativeStatsPort,
  execute: (input: NativeStatsTransportInput) => Promise<boolean>,
  lifetime: AbortSignal,
): () => void {
  const parsed = decode(data);
  if (Option.isNone(parsed) || !parsed.value.path.startsWith("/api/") || !isNeoPiStatsPathAllowed(parsed.value.method, parsed.value.path)) {
    port.postMessage({ type: "error", message: "Invalid native stats request." });
    port.close();
    return () => {};
  }
  const request = parsed.value;
  const abort = new AbortController();
  const signal = AbortSignal.any([lifetime, abort.signal]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finish: (() => void) | undefined;
  let reading = false;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    abort.abort();
    void reader?.cancel().catch(() => {});
    finish?.();
    port.close();
    signal.removeEventListener("abort", close);
  };
  signal.addEventListener("abort", close, { once: true });
  port.onmessageerror = close;
  port.onmessage = async ({ data: message }) => {
    if (message?.type === "cancel") { close(); return; }
    if (message?.type !== "pull" || !reader || reading || closed) return;
    reading = true;
    try {
      const { done, value } = await reader.read();
      if (closed) return;
      if (done) { port.postMessage({ type: "end" }); close(); }
      else if (value) {
        const packet = { type: "chunk", bytes: value };
        if (value.buffer instanceof ArrayBuffer) port.postMessage(packet, [value.buffer]);
        else port.postMessage(packet);
      }
    } catch { if (!closed) { port.postMessage({ type: "error", message: "Native stats stream disconnected." }); close(); } }
    finally { reading = false; }
  };
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (["x-omp-stats-action", "if-none-match", "accept"].includes(name.toLowerCase())) headers[name.toLowerCase()] = value;
  }
  void execute({
    path: request.path, method: request.method, headers, signal,
    consume: async (response) => {
      if (closed) return;
      reader = response.body?.getReader();
      port.postMessage({ type: "headers", status: response.status, headers: Object.fromEntries(response.headers) });
      if (!reader) { port.postMessage({ type: "end" }); close(); return; }
      await new Promise<void>((resolve) => { finish = resolve; if (closed) resolve(); });
    },
  }).then((ok) => {
    if (!closed && !ok) port.postMessage({ type: "error", message: "Native stats request failed. Check the environment connection." });
    close();
  }, () => { if (!closed) port.postMessage({ type: "error", message: "Native stats request failed." }); close(); });
  if (signal.aborted) close();
  return close;
}
