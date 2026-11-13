import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { PreviewAutomationHost, PreviewAutomationStatus } from "./previewAutomation.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  ConfiguredLocalServerUrls,
  DiscoveredLocalServer,
  PreviewEvent,
} from "./preview.ts";

const decodePreviewEvent = Schema.decodeUnknownSync(PreviewEvent);
const decodeServer = Schema.decodeUnknownSync(DiscoveredLocalServer);
const decodeConfiguredLocalServerUrls = Schema.decodeUnknownSync(ConfiguredLocalServerUrls);

const decodeAutomationHost = Schema.decodeUnknownSync(PreviewAutomationHost);
const decodeAutomationStatus = Schema.decodeUnknownSync(PreviewAutomationStatus);

describe("PreviewAutomationHost", () => {
  it("accepts legacy hosts and current operation advertisements", () => {
    expect(decodeAutomationHost({ clientId: "legacy", environmentId: "environment-1" })).toEqual({
      clientId: "legacy",
      environmentId: "environment-1",
    });
    expect(
      decodeAutomationHost({
        clientId: "current",
        environmentId: "environment-1",
        supportedOperations: ["status", "resize"],
      }).supportedOperations,
    ).toEqual(["status", "resize"]);
  });
});

describe("PreviewAutomationStatus", () => {
  it("accepts old hosts without viewport data and exposes it from current hosts", () => {
    const base = {
      available: true,
      visible: false,
      tabId: "preview-t",
      url: "https://example.com",
      title: "Example",
      loading: false,
    };
    expect(decodeAutomationStatus(base)).toEqual(base);
    expect(
      decodeAutomationStatus({
        ...base,
        viewportSetting: { _tag: "preset", presetId: "pixel-8", width: 412, height: 915 },
        viewport: { width: 412, height: 915 },
      }).viewport,
    ).toEqual({ width: 412, height: 915 });
  });
});

describe("PreviewEvent", () => {
  it("decodes an authoritative resync without a thread or tab id", () => {
    const event = decodePreviewEvent({
      type: "resync",
      serverEpoch: "server-a",
      revision: 2,
      sessions: [
        {
          threadId: "native:resource",
          sessionRef: {
            providerInstanceId: ProviderInstanceId.make("native"),
            sessionFile: "/sessions/example.jsonl",
          },
          tabId: "preview-t",
          navStatus: { _tag: "Idle" },
          canGoBack: false,
          canGoForward: false,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    if (event.type !== "resync") throw new Error("Expected resync");
    expect(event.sessions[0]?.sessionRef).toEqual({
      providerInstanceId: "native",
      sessionFile: "/sessions/example.jsonl",
    });
  });
});

describe("DiscoveredLocalServer", () => {
  it("decodes a server with process metadata", () => {
    const server = decodeServer({
      host: "localhost",
      port: 5173,
      url: "http://localhost:5173",
      processName: "node",
      pid: 12345,
      terminal: null,
    });
    expect(server.port).toBe(5173);
    expect(server.processName).toBe("node");
  });

  it("decodes a server without process metadata", () => {
    const server = decodeServer({
      host: "localhost",
      port: 3000,
      url: "http://localhost:3000",
      processName: null,
      pid: null,
      terminal: null,
    });
    expect(server.processName).toBeNull();
  });

  it("rejects invalid ports", () => {
    expect(() =>
      decodeServer({
        host: "localhost",
        port: 0,
        url: "http://localhost:0",
        processName: null,
        pid: null,
        terminal: null,
      }),
    ).toThrow();
    expect(() =>
      decodeServer({
        host: "localhost",
        port: 70000,
        url: "http://localhost:70000",
        processName: null,
        pid: null,
        terminal: null,
      }),
    ).toThrow();
  });
});

describe("ConfiguredLocalServerUrls", () => {
  it("bounds the number and length of probe candidates", () => {
    expect(() =>
      decodeConfiguredLocalServerUrls(
        Array.from(
          { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS + 1 },
          (_, index) => `http://localhost:${3_000 + index}`,
        ),
      ),
    ).toThrow();
    expect(() =>
      decodeConfiguredLocalServerUrls([`http://localhost/${"a".repeat(PREVIEW_URL_MAX_LENGTH)}`]),
    ).toThrow();
  });
});
