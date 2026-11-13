import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderSummary } from "./providerStatus";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("neopi"),
  driver: ProviderDriverKind.make("neopi"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("getProviderSummary", () => {
  it("does not hide a provider error behind a previous authenticated state", () => {
    const failed = {
      ...provider,
      status: "error" as const,
      message: "The provider process failed to start.",
    };
    expect(getProviderSummary(failed)).toEqual(
      getProviderSummary({ ...failed, auth: { status: "unknown" } }),
    );
  });

  it("keeps authentication failures actionable when their provider status is error", () => {
    const unauthenticated = {
      ...provider,
      status: "error" as const,
      auth: { status: "unauthenticated" as const },
      message: "The runtime needs authentication.",
    };
    expect(getProviderSummary(unauthenticated)).toEqual(
      getProviderSummary({ ...unauthenticated, status: "ready" }),
    );
  });
});
