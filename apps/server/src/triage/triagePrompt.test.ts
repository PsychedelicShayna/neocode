import { assert, it } from "@effect/vitest";

import { buildTriageLaunchPrompt } from "./triagePrompt.ts";

it("launch prompt stays a single argv-safe line naming the prompt file", () => {
  // Windows .cmd shims cannot carry multiline argv.
  const launch = buildTriageLaunchPrompt(String.raw`C:\Users\a b\.t3\userdata\triage\x\prompt.md`);
  assert.notInclude(launch, "\n");
  assert.include(launch, String.raw`C:\Users\a b\.t3\userdata\triage\x\prompt.md`);
  assert.isBelow(launch.length, 1_000);
});
