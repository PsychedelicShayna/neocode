import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getOnboardingProviderState,
  selectOnboardingProvidersByDriver,
} from "./providerReadiness.logic";

const readyNeoPi: ServerProvider = {
  instanceId: ProviderInstanceId.make("neopi"),
  driver: ProviderDriverKind.make("neopi"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("getOnboardingProviderState", () => {
  it("treats an enabled NeoPi runtime with ready status and unknown authentication as ready", () => {
    expect(getOnboardingProviderState(readyNeoPi)).toBe("ready");
  });

  it("treats authenticated providers as ready only when their provider status is ready", () => {
    expect(getOnboardingProviderState({ ...readyNeoPi, auth: { status: "authenticated" } })).toBe(
      "ready",
    );
    expect(
      getOnboardingProviderState({
        ...readyNeoPi,
        auth: { status: "authenticated" },
        status: "error",
      }),
    ).toBe("attention");
    expect(
      getOnboardingProviderState({
        ...readyNeoPi,
        auth: { status: "authenticated" },
        status: "warning",
      }),
    ).toBe("attention");
  });

  it("offers sign-in only when the server reports an authentication failure", () => {
    expect(
      getOnboardingProviderState({
        ...readyNeoPi,
        status: "error",
        auth: { status: "unauthenticated" },
      }),
    ).toBe("signIn");
    expect(getOnboardingProviderState({ ...readyNeoPi, status: "error" })).toBe("attention");
    expect(getOnboardingProviderState({ ...readyNeoPi, status: "warning" })).toBe("attention");
  });

  it("does not offer installation or sign-in for disabled providers", () => {
    expect(getOnboardingProviderState({ ...readyNeoPi, enabled: false, installed: false })).toBe(
      "disabled",
    );
    expect(getOnboardingProviderState({ ...readyNeoPi, status: "disabled" })).toBe("disabled");
  });

  it("offers installation only when an enabled provider is missing", () => {
    expect(getOnboardingProviderState({ ...readyNeoPi, installed: false, status: "error" })).toBe(
      "install",
    );
  });

  it("waits for a provider snapshot before offering an action", () => {
    expect(getOnboardingProviderState(undefined)).toBe("checking");
  });
});

describe("selectOnboardingProvidersByDriver", () => {
  it("prefers a ready instance with unknown authentication to an unauthenticated instance", () => {
    const signedOutNeoPi: ServerProvider = {
      ...readyNeoPi,
      instanceId: ProviderInstanceId.make("neopi_work"),
      status: "error",
      auth: { status: "unauthenticated" },
    };

    expect(selectOnboardingProvidersByDriver([signedOutNeoPi, readyNeoPi]).get("neopi")).toBe(
      readyNeoPi,
    );
  });

  it("prefers a provider with an actionable sign-in over a failed provider", () => {
    const failedNeoPi: ServerProvider = { ...readyNeoPi, status: "error" };
    const signedOutNeoPi: ServerProvider = {
      ...readyNeoPi,
      instanceId: ProviderInstanceId.make("neopi_work"),
      status: "error",
      auth: { status: "unauthenticated" },
    };

    expect(selectOnboardingProvidersByDriver([failedNeoPi, signedOutNeoPi]).get("neopi")).toBe(
      signedOutNeoPi,
    );
  });

  it("prefers installed providers over missing or disabled instances", () => {
    const disabledNeoPi: ServerProvider = { ...readyNeoPi, enabled: false };
    const missingNeoPi: ServerProvider = {
      ...readyNeoPi,
      instanceId: ProviderInstanceId.make("neopi_work"),
      installed: false,
      status: "error",
    };

    expect(
      selectOnboardingProvidersByDriver([disabledNeoPi, missingNeoPi, readyNeoPi]).get("neopi"),
    ).toBe(readyNeoPi);
  });

  it("handles provider snapshots that have not arrived", () => {
    expect(selectOnboardingProvidersByDriver(undefined).size).toBe(0);
  });

  it("keeps a ready custom account when the default account is signed out", () => {
    const signedOutDefault: ServerProvider = {
      ...readyNeoPi,
      status: "error",
      auth: { status: "unauthenticated" },
    };
    const readyCustom: ServerProvider = {
      ...readyNeoPi,
      instanceId: ProviderInstanceId.make("neopi_work"),
    };

    expect(selectOnboardingProvidersByDriver([signedOutDefault, readyCustom]).get("neopi")).toBe(
      readyCustom,
    );
  });
});
