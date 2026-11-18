import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Hoisted so every fresh module instance after vi.resetModules shares one mock.
const isMonospaceFamily = vi.hoisted(() => vi.fn<(family: string) => boolean>());
vi.mock("./appearanceFonts", () => ({ isMonospaceFamily }));

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
  isMonospaceFamily.mockReset();
  // Every measurement fills one 8ms slice, so each slice classifies one family.
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  isMonospaceFamily.mockImplementation((family) => {
    now += 10;
    return !family.startsWith("Proportional");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// A fresh module instance is a fresh app launch: nothing carries over but
// storage. Calling the returned scan again within one launch is a reopen.
async function launch() {
  vi.resetModules();
  const { scanInstalledMonospaceFonts } = await import("./installedMonospaceFonts");
  isMonospaceFamily.mockClear();
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
      measured: isMonospaceFamily.mock.calls.map(([f]) => f),
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

  it("relaunches from stored results, sorted, without measuring again", async () => {
    const families = ["Anonymous", "Courier Prime", "Proportional Sans", "Zed Mono"];
    const first = await (await launch())(families);
    expect(first.final).toEqual(["Courier Prime", "Zed Mono", "Anonymous"]);

    const relaunched = await (await launch())(families);
    expect(relaunched.measured).toEqual([]);
    expect(relaunched.progress).toEqual([["Anonymous", "Courier Prime", "Zed Mono"]]);
    expect(relaunched.final).toEqual(["Anonymous", "Courier Prime", "Zed Mono"]);
  });

  it("keeps results from a scan that overlaps another scan's cancellation", async () => {
    const { scanInstalledMonospaceFonts } = await import("./installedMonospaceFonts");
    const families = ["Alpha Mono", "Beta Mono", "Gamma Mono", "Delta Mono"];
    const first = new AbortController();
    const closed = scanInstalledMonospaceFonts(families, first.signal, {
      saved: "",
      onProgress: (found) => {
        if (found.length > 0) first.abort();
      },
    });
    // The first picker measures one slice and closes; its cancellation is
    // still queued when the other picker opens.
    await vi.runOnlyPendingTimersAsync();
    expect(isMonospaceFamily).toHaveBeenCalledTimes(1);
    const opened = scanInstalledMonospaceFonts(families, new AbortController().signal, {
      saved: "",
      onProgress: () => {},
    });
    await vi.runAllTimersAsync();
    await closed;
    expect(await opened).toEqual(families);
    expect(isMonospaceFamily).toHaveBeenCalledTimes(families.length);

    const relaunched = await (await launch())(families);
    expect(relaunched.measured).toEqual([]);
    expect(relaunched.final).toEqual(families);
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

  it("stops measuring when the picker closes and resumes where it stopped on reopen", async () => {
    const families = ["Alpha Mono", "Beta Mono", "Gamma Mono"];
    const scan = await launch();
    const closed = await scan(families, { abortAfter: 2 });
    expect(closed.measured).toEqual(["Alpha Mono"]);

    isMonospaceFamily.mockClear();
    const reopened = await scan(families);
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

  it("reports fonts left to measure until a scan completes, across launches", async () => {
    const families = ["Alpha Mono", "Beta Mono", "Proportional Sans"];
    let module = await import("./installedMonospaceFonts");
    expect(module.hasUnclassifiedFonts(families)).toBe(true);

    await (
      await launch()
    )(families, { abortAfter: 2 });
    module = await import("./installedMonospaceFonts");
    expect(module.hasUnclassifiedFonts(families)).toBe(true);

    await (
      await launch()
    )(families);
    module = await import("./installedMonospaceFonts");
    expect(module.hasUnclassifiedFonts(families)).toBe(false);
    expect(module.hasUnclassifiedFonts([...families, "New Mono"])).toBe(true);

    vi.resetModules();
    const relaunched = await import("./installedMonospaceFonts");
    expect(relaunched.hasUnclassifiedFonts(families)).toBe(false);
  });
});
