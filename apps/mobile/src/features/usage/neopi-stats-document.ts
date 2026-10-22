import {
  connectNativeStatsPort,
  type NativeStatsPort,
  type NativeStatsTransportInput,
} from "@t3tools/client-runtime/neopi-stats-bridge";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Envelope = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      bridge: Schema.String,
      id: Schema.String,
      type: Schema.Literal("request"),
      data: Schema.Unknown,
    }),
    Schema.Struct({
      bridge: Schema.String,
      id: Schema.String,
      type: Schema.Literals(["pull", "cancel"]),
    }),
  ]),
);
const decodeEnvelope = Schema.decodeUnknownOption(Envelope);

function javascriptData(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Native MessagePorts remain inside the document; only their packets cross RN's string bridge. */
export function nativeStatsDocument(html: string, bridgeId: string) {
  const bootstrap = `<script>(function(){
    const bridge = ${javascriptData(bridgeId)};
    const ports = new Map();
    let nextId = 0;
    const parentPostMessage = window.parent.postMessage.bind(window.parent);
    window.parent.postMessage = function(data, origin, transfer) {
      if (!data || data.type !== "neopi-stats-request") return parentPostMessage(data, origin, transfer);
      const port = transfer && transfer[0];
      if (!port || typeof port.postMessage !== "function") throw new Error("Native stats requires a MessagePort.");
      const id = String(++nextId);
      ports.set(id, port);
      port.onmessage = function(event) {
        const type = event.data && event.data.type;
        if (type !== "pull" && type !== "cancel") return;
        window.ReactNativeWebView.postMessage(JSON.stringify({bridge, id, type}));
        if (type === "cancel") { ports.delete(id); port.close(); }
      };
      port.onmessageerror = function() {
        window.ReactNativeWebView.postMessage(JSON.stringify({bridge, id, type: "cancel"}));
        ports.delete(id); port.close();
      };
      port.start();
      window.ReactNativeWebView.postMessage(JSON.stringify({bridge, id, type: "request", data}));
    };
    window.__neocodeStatsReceive = function(packet) {
      if (!packet || packet.bridge !== bridge) return;
      const port = ports.get(packet.id);
      if (!port) return;
      const data = packet.data;
      if (data && data.type === "chunk") data.bytes = new Uint8Array(data.bytes);
      port.postMessage(data);
      if (data && (data.type === "end" || data.type === "error")) { ports.delete(packet.id); port.close(); }
    };
    window.addEventListener("pagehide", function() {
      for (const [id, port] of ports) {
        window.ReactNativeWebView.postMessage(JSON.stringify({bridge, id, type: "cancel"}));
        port.close();
      }
      ports.clear();
    });
  })();</script>`;
  const head = /<head(?:\s[^>]*)?>/i;
  if (!head.test(html)) throw new Error("Native stats returned a document without a head element.");
  return html.replace(head, (open) => `${open}${bootstrap}`);
}

export function createMobileStatsBridge(input: {
  readonly bridgeId: string;
  readonly execute: (request: NativeStatsTransportInput) => Promise<boolean>;
  readonly lifetime: AbortSignal;
  readonly inject: (script: string) => void;
}) {
  const ports = new Map<string, { port: NativeStatsPort; disconnect: () => void }>();
  let disposed = false;
  return {
    receive(raw: string) {
      if (disposed || input.lifetime.aborted) return;
      const decoded = decodeEnvelope(raw);
      if (Option.isNone(decoded) || decoded.value.bridge !== input.bridgeId) return;
      const message = decoded.value;
      if (message.type !== "request") {
        const current = ports.get(message.id);
        if (current?.port.onmessage) {
          // The shared core installs arrow callbacks which consume only event.data.
          Reflect.apply(current.port.onmessage, current.port, [{ data: { type: message.type } }]);
        }
        return;
      }
      if (ports.has(message.id)) return;
      let closed = false;
      const port: NativeStatsPort = {
        onmessage: null,
        onmessageerror: null,
        postMessage(data: unknown) {
          if (disposed || closed || input.lifetime.aborted) return;
          const packet =
            typeof data === "object" &&
            data !== null &&
            "type" in data &&
            data.type === "chunk" &&
            "bytes" in data &&
            data.bytes instanceof Uint8Array
              ? { type: "chunk", bytes: Array.from(data.bytes) }
              : data;
          input.inject(
            `window.__neocodeStatsReceive(${javascriptData({ bridge: input.bridgeId, id: message.id, data: packet })}); true;`,
          );
        },
        close() {
          closed = true;
          ports.delete(message.id);
        },
      };
      const entry = { port, disconnect: () => {} };
      ports.set(message.id, entry);
      entry.disconnect = connectNativeStatsPort(message.data, port, input.execute, input.lifetime);
      // Invalid requests can close synchronously before connect returns.
      if (closed) ports.delete(message.id);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of [...ports.values()]) entry.disconnect();
      ports.clear();
    },
  };
}
