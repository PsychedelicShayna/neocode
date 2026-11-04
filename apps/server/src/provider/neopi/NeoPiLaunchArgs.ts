import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Effect from "effect/Effect";
import { NeoPiRuntimeError } from "./NeoPiRuntimeError.ts";

const protectedFlags = new Set([
  "--resume",
  "-r",
  "-c",
  "--continue",
  "--fork",
  "--mode",
  "--cwd",
  "--profile",
  "-p",
  "--approval-mode",
  "--yolo",
  "--auto-approve",
  "--no-session",
  "--new-session",
]);

export const parseNeoPiLaunchArguments = Effect.fn("parseNeoPiLaunchArguments")(function* (
  launchArgs?: string,
) {
  const extra = tokenizeCliArgs(launchArgs);
  for (const arg of extra) {
    if (arg === "--") break;
    const flag = arg.split("=", 1)[0] ?? arg;
    if (flag.startsWith("--session") || protectedFlags.has(flag))
      return yield* new NeoPiRuntimeError({
        code: "settings",
        flag,
        message: `NeoPi launch arguments may not override ${flag}`,
      });
  }
  return extra;
});
