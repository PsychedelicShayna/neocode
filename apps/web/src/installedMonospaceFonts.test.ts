import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isMonospaceFamily } from "./appearanceFonts";

vi.mock("./appearanceFonts", () => ({ isMonospaceFamily: vi.fn() }));

const STORAGE_KEY = "t3code:monospace-font-families:v1";
// Survives vi.resetModules, standing in for storage across app launches.
const stored = new Map<string, string>();

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  stored.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    },
  });
  vi.mocked(isMonospaceFamily).mockReset();
  // Every measurement fills one 8ms slice, so each slice classifies one family.
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.mocked(isMonospaceFamily).mockImplementation((family) => {
    now += 10;
    return !family.startsWith("Proportional");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// A fresh module instance is a fresh app launch; storage carries over.
async function launch() {
  const { scanInstalledMonospaceFonts } = await import("./installedMonospaceFonts");
  vi.mocked(isMonospaceFamily).mockClear();
  return async (
    families: readonly string[],
    options: { saved?: string; abortAfter?: number } = {},
  ) => {
    const controller = new AbortController();
    const progress: (readonly string[])[] = [];
    const result = scanInstalledMonospaceFonts(families, controller.signal, {
      saved: options.saved ?? "",
      onProgress: (found) => {
        progress.push(found);
        if (progress.length === options.abortAfter) controller.abort();
      },
    });
    await vi.runAllTimersAsync();
    return {
      progress,
      final: await result,
      measured: vi.mocked(isMonospaceFamily).mock.calls.map(([f]) => f),
    };
  };
}

describe("installed monospace font discovery", () => {
  it("lists families slice by slice, likely fixed-width names first, never reordering rows", async () => {
    const scan = await launch();
    const families = ["Anonymous", "Courier Prime", "Inconsolata", "Proportional Sans", "Zed Mono"];
    const { progress, final, measured } = await scan(families);

    expect(measured).toEqual([
      "Courier Prime",
      "Zed Mono",
      "Anonymous",
      "Inconsolata",
      "Proportional Sans",
    ]);
    expect(progress).toEqual([
      [],
      ["Courier Prime"],
      ["Courier Prime", "Zed Mono"],
      ["Courier Prime", "Zed Mono", "Anonymous"],
      ["Courier Prime", "Zed Mono", "Anonymous", "Inconsolata"],
    ]);
    expect(final).toEqual(progress.at(-1));
  });

  it("offers the saved family before any measurement and does not list it twice", async () => {
    const scan = await launch();
    const { progress, final } = await scan(["Alpha Mono", "Iosevka", "Zeta Mono"], {
      saved: "Iosevka",
    });
    expect(progress[0]).toEqual(["Iosevka"]);
    expect(final).toEqual(["Iosevka", "Alpha Mono", "Zeta Mono"]);
  });

  it("reopens and relaunches from remembered results, sorted, without measuring again", async () => {
    const families = ["Anonymous", "Courier Prime", "Proportional Sans", "Zed Mono"];
    await (
      await launch()
    )(families);

    const relaunched = await (await launch())(families);
    expect(relaunched.measured).toEqual([]);
    expect(relaunched.progress).toEqual([["Anonymous", "Courier Prime", "Zed Mono"]]);
    expect(relaunched.final).toEqual(["Anonymous", "Courier Prime", "Zed Mono"]);
  });

  it("measures only new families after a launch and forgets uninstalled ones", async () => {
    await (
      await launch()
    )(["Anonymous", "Gone Mono"]);

    const next = await (await launch())(["Anonymous", "New Mono"]);
    expect(next.measured).toEqual(["New Mono"]);
    expect(Object.keys(JSON.parse(stored.get(STORAGE_KEY)!)).sort()).toEqual([
      "Anonymous",
      "New Mono",
    ]);

    const reinstalled = await (await launch())(["Anonymous", "Gone Mono", "New Mono"]);
    expect(reinstalled.measured).toEqual(["Gone Mono"]);
  });

  it("stops measuring when the picker closes and keeps what it classified", async () => {
    const families = ["Alpha Mono", "Beta Mono", "Gamma Mono"];
    const closed = await (await launch())(families, { abortAfter: 2 });
    expect(closed.measured).toEqual(["Alpha Mono"]);

    const reopened = await (await launch())(families);
    expect(reopened.measured).toEqual(["Beta Mono", "Gamma Mono"]);
    expect(reopened.progress[0]).toEqual(["Alpha Mono"]);
  });

  it("measures nothing when closed before the first slice", async () => {
    const { scanInstalledMonospaceFonts } = await import("./installedMonospaceFonts");
    const controller = new AbortController();
    const result = scanInstalledMonospaceFonts(["Unvisited Font"], controller.signal, {
      saved: "",
      onProgress: () => controller.abort(),
    });
    await vi.runAllTimersAsync();
    await result;
    expect(isMonospaceFamily).not.toHaveBeenCalled();
  });
});
