import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  resolveServerBackedAppDisplayName,
  resolveServerBackedAppStageLabel,
} from "./branding.logic";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();

  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  globalThis.window = originalWindow;
});

describe("branding", () => {
  it("prefers desktop stage metadata over a competing hosted channel", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "latest");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getAppBranding: () => ({
            baseName: "Example App",
            stageLabel: "Nightly",
            displayName: "Example App (Nightly)",
          }),
        },
      },
    });

    const branding = await import("./branding");

    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
  });

  it("normalizes hosted app channel metadata", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", " NIGHTLY ");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBe("nightly");
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBe("Nightly");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe(`${branding.APP_BASE_NAME} (Nightly)`);
  });

  it("does not label the latest hosted app channel", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "latest");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBe("latest");
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBe("Latest");
    expect(branding.APP_STAGE_LABEL).toBe("Latest");
    expect(branding.APP_DISPLAY_NAME).toBe(branding.APP_BASE_NAME);
  });

  it("ignores unknown hosted app channels", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "preview");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBeNull();
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBeNull();
  });
});

describe("branding logic", () => {
  it.each([
    "0.0.28-nightly.20260616.12",
    "0.0.42-nightly.20261020.39505137750.1",
    "0.0.42-nightly.20261028.2.beb7e0771a",
    "0.0.42-preview.20261028.2.beb7e0771a",
  ])("returns Nightly for primary server version %s", (primaryServerVersion) => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion,
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Nightly");
  });

  it("updates the display name for nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "T3 Code",
        fallbackDisplayName: "T3 Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-nightly.20260616.12",
      }),
    ).toBe("T3 Code (Nightly)");
  });

  it("keeps the fallback display name for stable primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "T3 Code",
        fallbackDisplayName: "T3 Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.27",
      }),
    ).toBe("T3 Code (Alpha)");
  });

  it("keeps the fallback display name for malformed nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "T3 Code",
        fallbackDisplayName: "T3 Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-nightly.20260616",
      }),
    ).toBe("T3 Code (Alpha)");
  });

  it.each(["Alpha", "Dev", "Latest"])(
    "preserves %s identity for a stable server",
    (fallbackStageLabel) => {
      expect(
        resolveServerBackedAppStageLabel({
          primaryServerVersion: "0.0.42",
          fallbackStageLabel,
        }),
      ).toBe(fallbackStageLabel);
    },
  );
});
