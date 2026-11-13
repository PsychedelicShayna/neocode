import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { refreshUsageLimits } from "./usage.ts";

describe("limits refresh cooldown", () => {
  it("shares an in-flight check and skips duplicate automatic refreshes", async () => {
    const id = EnvironmentId.make("limits-in-flight");
    const oldCheck = Promise.withResolvers<string>();
    const first = refreshUsageLimits(id, () => oldCheck.promise, true);
    const newCheck = vi.fn(async () => "new limits");
    const manual = refreshUsageLimits(id, newCheck);
    expect(await refreshUsageLimits(id, newCheck, true)).toBeUndefined();
    expect(newCheck).not.toHaveBeenCalled();
    oldCheck.resolve("old limits");
    expect(await first).toBe("old limits");
    expect(await manual).toBe("old limits");
    expect(newCheck).not.toHaveBeenCalled();
  });

  it("joins manual calls and gates automatic refreshes after success or failure", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      for (const fails of [false, true]) {
        const id = EnvironmentId.make(`limits-${fails}`);
        const pending = Promise.withResolvers<string>();
        const refresh = vi.fn(() => pending.promise);
        const first = refreshUsageLimits(id, refresh, true);
        await refreshUsageLimits(id, refresh, true);
        const manual = refreshUsageLimits(id, refresh);
        const settled = vi.fn();
        void manual.then(settled, settled);
        expect(settled).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledTimes(1);
        if (fails) {
          const firstFailure = expect(first).rejects.toThrow("unavailable");
          const manualFailure = expect(manual).rejects.toThrow("unavailable");
          pending.reject(new Error("unavailable"));
          await Promise.all([firstFailure, manualFailure]);
        } else {
          pending.resolve("quota");
          expect(await first).toBe("quota");
          expect(await manual).toBe("quota");
        }
        expect(settled).toHaveBeenCalledTimes(1);
        const next = vi.fn(async () => undefined);
        clock.mockReturnValue(300_999);
        await refreshUsageLimits(id, next, true);
        expect(next).not.toHaveBeenCalled();
        clock.mockReturnValue(301_000);
        await refreshUsageLimits(id, next, true);
        expect(next).toHaveBeenCalledTimes(1);
        await refreshUsageLimits(id, next);
        expect(next).toHaveBeenCalledTimes(2);
        clock.mockReturnValue(1_000);
      }
    } finally {
      clock.mockRestore();
    }
  });
});
