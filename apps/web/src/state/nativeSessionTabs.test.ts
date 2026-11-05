import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  nativeSessionKey,
  type NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { describe, expect, it } from "vite-plus/test";

import {
  closeNativeSessionTab,
  moveNativeSessionTab,
  openNativeSessionTab,
  recentSessionOrder,
  recordRecentSession,
  replaceNativeSessionTab,
  stepRecentIndex,
} from "./nativeSessionTabs";

const session = (sessionFile: string): NativeSessionTarget => ({
  environmentId: EnvironmentId.make("env"),
  ref: { providerInstanceId: ProviderInstanceId.make("neopi"), sessionFile },
});
const [a, b, c] = [session("a"), session("b"), session("c")] as const;
const files = (tabs: readonly NativeSessionTarget[]) => tabs.map((tab) => tab.ref.sessionFile);

describe("native session tabs", () => {
  it("opens a session once and keeps an existing tab in place", () => {
    expect(files(openNativeSessionTab([a, b], c))).toEqual(["a", "b", "c"]);
    expect(files(openNativeSessionTab([a, b], session("a")))).toEqual(["a", "b"]);
  });

  it("treats the same file in another environment as another session", () => {
    const remote = { ...a, environmentId: EnvironmentId.make("remote") };
    expect(openNativeSessionTab([a], remote)).toHaveLength(2);
  });

  it("closes the active tab onto its right neighbour, else its left", () => {
    expect(closeNativeSessionTab([a, b, c], b, b)).toEqual({ tabs: [a, c], active: c });
    expect(closeNativeSessionTab([a, b, c], c, c)).toEqual({ tabs: [a, b], active: b });
    expect(closeNativeSessionTab([a], a, a)).toEqual({ tabs: [], active: null });
  });

  it("keeps the active tab when another one closes", () => {
    expect(closeNativeSessionTab([a, b, c], c, a)).toEqual({ tabs: [b, c], active: c });
    expect(closeNativeSessionTab([a, b], a, c)).toEqual({ tabs: [a, b], active: a });
  });

  it("drags a tab to the index it should hold afterwards", () => {
    expect(files(moveNativeSessionTab([a, b, c], a, 2))).toEqual(["b", "c", "a"]);
    expect(files(moveNativeSessionTab([a, b, c], c, 0))).toEqual(["c", "a", "b"]);
    expect(files(moveNativeSessionTab([a, b, c], b, 1))).toEqual(["a", "b", "c"]);
    expect(files(moveNativeSessionTab([a, b, c], a, 9))).toEqual(["b", "c", "a"]);
    expect(files(moveNativeSessionTab([a, b], c, 0))).toEqual(["a", "b"]);
  });

  it("moves a tab to NeoPi's new session file in place, without duplicating", () => {
    expect(files(replaceNativeSessionTab([a, b, c], b, session("b2")))).toEqual(["a", "b2", "c"]);
    expect(files(replaceNativeSessionTab([a, b, c], b, c))).toEqual(["a", "c"]);
    expect(files(replaceNativeSessionTab([a], b, c))).toEqual(["a", "c"]);
  });
});

describe("most-recently-used session switching", () => {
  const [d, e] = [session("d"), session("e")] as const;
  const keys = (list: readonly NativeSessionTarget[]) => list.map(nativeSessionKey);

  it("records the activated session at the front without duplicates", () => {
    let recent: readonly string[] = [];
    for (const target of [a, b, c, a, a, b])
      recent = recordRecentSession(recent, nativeSessionKey(target));
    expect(recent).toEqual([b, a, c].map(nativeSessionKey));
  });

  it("orders tabs by recency, active first, then never-used tabs in tab order, skipping closed ones", () => {
    const recent = [c, a, session("gone")].map(nativeSessionKey);
    expect(files(recentSessionOrder([a, b, c, d], recent, c))).toEqual(["c", "a", "b", "d"]);
    expect(files(recentSessionOrder([a, b, c], [], null))).toEqual(["a", "b", "c"]);
    // The active tab leads even when the stack has not caught up with it.
    expect(files(recentSessionOrder([a, b, c], [a].map(nativeSessionKey), b))).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("steps back through recency on next and forward on previous, wrapping", () => {
    expect(stepRecentIndex(4, 0, "next")).toBe(1);
    expect(stepRecentIndex(4, 3, "next")).toBe(0);
    expect(stepRecentIndex(4, 0, "previous")).toBe(3);
    expect(stepRecentIndex(4, 2, "previous")).toBe(1);
    expect(stepRecentIndex(0, 0, "next")).toBe(0);
  });

  it("returns to the previous session with one step after a deep jump is committed", () => {
    const tabs = [a, b, c, d, e];
    // Visited in the order b, c, d, e, then a.
    let recent: readonly string[] = [];
    for (const target of [b, c, d, e, a])
      recent = recordRecentSession(recent, nativeSessionKey(target));
    let order = recentSessionOrder(tabs, recent, a);
    expect(files(order)).toEqual(["a", "e", "d", "c", "b"]);
    // Hold Ctrl, press Tab four times, release: lands on `b`.
    let index = 0;
    for (let press = 0; press < 4; press++) index = stepRecentIndex(order.length, index, "next");
    const reached = order[index]!;
    expect(reached).toBe(b);
    recent = recordRecentSession(recent, nativeSessionKey(reached));
    // A single Ctrl+Tab returns to where we started.
    order = recentSessionOrder(tabs, recent, reached);
    expect(order[stepRecentIndex(order.length, 0, "next")]).toBe(a);
  });
});
