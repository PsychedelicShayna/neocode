import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { parseNeoPiLaunchArguments } from "./NeoPiLaunchArgs.ts";

describe("native launch argument ownership", () => {
  it.effect("preserves quoted extension options without replacing native identity", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* parseNeoPiLaunchArguments('--extension "./my extension.ts" --verbose'),
        ["--extension", "./my extension.ts", "--verbose"],
      );
      assert.deepEqual(yield* parseNeoPiLaunchArguments(), []);
    }),
  );
  it.effect("rejects session, cwd, mode, profile and approval overrides", () =>
    Effect.gen(function* () {
      for (const arg of [
        "--session=/other",
        "--session-dir",
        "--new-session",
        "--no-session",
        "--resume",
        "-r",
        "--continue",
        "--fork",
        "--mode=interactive",
        "--cwd=/other",
        "--profile=other",
        "--approval-mode=yolo",
        "--yolo",
      ]) {
        const result = yield* Effect.result(parseNeoPiLaunchArguments(arg));
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.code, "settings");
      }
    }),
  );
});
