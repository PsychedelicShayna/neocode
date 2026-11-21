import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { managedStopStatus, submitManagedStopOnce } from "./NeoPiManagedLifecycle.ts";

describe("managed owner Stop", () => {
  effectIt.effect(
    "sends once even after a lost reply and does not equate submission with exit",
    () =>
      Effect.gen(function* () {
        let claimed = false;
        const claim = Effect.sync(() => {
          if (claimed) return false;
          claimed = true;
          return true;
        });
        const dispatch = vi.fn();
        const stop = submitManagedStopOnce(
          claim,
          Effect.sync(dispatch).pipe(Effect.andThen(Effect.fail("Bridge closed before reply"))),
        );
        expect(yield* Effect.flip(stop)).toBe("Bridge closed before reply");
        yield* stop;
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(managedStopStatus("alive", 0, false, 2)).toBe("requested");
        expect(managedStopStatus("unknown", 0, false, 15_000)).toBe("unconfirmed");
        expect(managedStopStatus("exited", 0, false, 15_001)).toBe("exited");
      }),
  );

  it("preserves the pending confirmation instead of eventually offering Force Stop", () => {
    expect(managedStopStatus("alive", undefined, false, 0)).toBe("idle");
    expect(managedStopStatus("alive", 0, true, 1)).toBe("awaiting-input");
    expect(managedStopStatus("alive", 0, true, 15_000)).toBe("awaiting-input");
    expect(managedStopStatus("alive", 0, false, 15_000)).toBe("unconfirmed");
  });
});
