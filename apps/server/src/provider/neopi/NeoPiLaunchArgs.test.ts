// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { buildNeoPiLaunchPlan, isSharedNeoPiCursor } from "./NeoPiLaunchArgs.ts";

const input = {
  binary: "npi",
  cwd: "/tmp/project",
  t3Home: "/tmp/t3home",
  projectId: "project-1",
  profile: "work",
  runtimeMode: "approval-required" as const,
};

describe("NeoPi launch plan", () => {
  it.effect("isolates fresh sessions and resumes the exact file", () =>
    Effect.gen(function* () {
      const fresh = yield* buildNeoPiLaunchPlan(input);
      NodeAssert.deepEqual(fresh.args, [
        "--mode",
        "rpc-ui",
        "--cwd",
        "/tmp/project",
        "--no-title",
        "--session-dir",
        "/tmp/t3home/neopi/sessions/work/project-1",
        "--approval-mode",
        "always-ask",
      ]);
      NodeAssert.equal(fresh.env.OMP_PROFILE, "work");
      const resume = yield* buildNeoPiLaunchPlan({
        ...input,
        cursor: {
          v: 1,
          sessionDir: fresh.sessionDir,
          sessionFile: `${fresh.sessionDir}/file.jsonl`,
          sessionId: "s",
          turnBoundaries: [],
        },
      });
      NodeAssert.deepEqual(resume.args.slice(-2), ["--approval-mode", "always-ask"]);
      NodeAssert.equal(
        resume.args[resume.args.indexOf("--session") + 1],
        `${fresh.sessionDir}/file.jsonl`,
      );
    }),
  );
  it.effect("opts only supported owned runtimes into bounded parent-death cleanup", () =>
    Effect.gen(function* () {
      const supported = yield* buildNeoPiLaunchPlan({ ...input, exitWithParent: true });
      const legacy = yield* buildNeoPiLaunchPlan(input);
      NodeAssert.ok(supported.args.includes("--exit-with-parent"));
      NodeAssert.ok(!legacy.args.includes("--exit-with-parent"));
      NodeAssert.equal(supported.command, legacy.command);
      NodeAssert.equal(supported.sessionDir, legacy.sessionDir);
    }),
  );
  it.effect(
    "maps both unrestricted modes to yolo and never lets extra args override identity",
    () =>
      Effect.gen(function* () {
        for (const runtimeMode of ["auto", "full-access"] as const) {
          const plan = yield* buildNeoPiLaunchPlan({ ...input, runtimeMode });
          NodeAssert.equal(plan.args[plan.args.indexOf("--approval-mode") + 1], "yolo");
        }
        for (const flag of [
          "--session=evil",
          "--session-dir",
          "--resume",
          "-r",
          "-c",
          "--continue",
          "--fork",
          "--mode=rpc",
          "--cwd",
          "--profile=foreign",
          "-p",
          "--approval-mode",
          "--yolo",
          "--auto-approve",
          "--no-session",
          "--new-session",
          "--exit-with-parent",
        ]) {
          const result = yield* buildNeoPiLaunchPlan({
            ...input,
            launchArgs: `${flag} value`,
          }).pipe(Effect.flip);
          NodeAssert.equal(result.code, "settings");
          NodeAssert.ok(result.message.includes(result.flag!));
        }
      }),
  );
  it.effect("keeps live files isolated until a cooperating lease exists", () =>
    Effect.gen(function* () {
      const isolated = yield* buildNeoPiLaunchPlan({
        ...input,
        profile: "",
      });
      NodeAssert.equal(isolated.identity.kind, "fresh");
      NodeAssert.equal(isolated.sessionDir, "/tmp/t3home/neopi/sessions/default/project-1");
      NodeAssert.equal(isolated.env.OMP_PROFILE, process.env.OMP_PROFILE);
      NodeAssert.ok(isolated.args.includes("--session-dir"));
      NodeAssert.ok(!isolated.args.includes("--new-session"));
    }),
  );
  it.effect("requires both cooperating capabilities and retains saved isolated cursors", () =>
    Effect.gen(function* () {
      const shared = yield* buildNeoPiLaunchPlan({ ...input, sharedSession: true });
      NodeAssert.ok(shared.args.includes("--new-session"));
      NodeAssert.ok(!shared.args.includes("--session-dir"));
      NodeAssert.equal(shared.sessionDir, "");
      const resumed = yield* buildNeoPiLaunchPlan({
        ...input,
        sharedSession: true,
        cursor: {
          v: 1,
          sessionFile: "/tmp/t3home/neopi/sessions/work/project-1/old.jsonl",
          sessionDir: "/tmp/t3home/neopi/sessions/work/project-1",
          sessionId: "old",
          turnBoundaries: [],
        },
      });
      NodeAssert.ok(!resumed.args.includes("--new-session"));
      NodeAssert.ok(resumed.args.includes("--session-dir"));
      NodeAssert.equal(resumed.identity.kind, "resume");
    }),
  );
  it.effect("keeps legacy isolated cursors isolated but protects unmarked shared cursors", () =>
    Effect.gen(function* () {
      const cursor = {
        v: 1 as const,
        sessionId: "s",
        sessionDir: "/tmp/t3home/neopi/sessions/old-profile/old-project",
        sessionFile: "/tmp/t3home/neopi/sessions/old-profile/old-project/session.jsonl",
        turnBoundaries: [],
      };
      NodeAssert.equal(isSharedNeoPiCursor(cursor, input.t3Home), false);
      NodeAssert.equal(
        isSharedNeoPiCursor(
          {
            ...cursor,
            sessionDir: "/tmp/omp-sessions",
            sessionFile: "/tmp/omp-sessions/session.jsonl",
          },
          input.t3Home,
        ),
        true,
      );
      NodeAssert.equal(isSharedNeoPiCursor({ ...cursor, sharedSession: true }, input.t3Home), true);
      NodeAssert.equal(
        isSharedNeoPiCursor(
          { ...cursor, sharedSession: false, sessionDir: "/tmp/omp-sessions" },
          input.t3Home,
        ),
        true,
      );
    }),
  );
  it.effect(
    "preserves the process environment, applies instance overrides, then the selected profile",
    () =>
      Effect.gen(function* () {
        const planned = yield* buildNeoPiLaunchPlan({
          ...input,
          env: {
            HOME: "/tmp/isolated-home",
            OMP_PROFILE: "environment-profile",
            CUSTOM_TOKEN: "instance",
          },
        });
        NodeAssert.equal(planned.env.HOME, "/tmp/isolated-home");
        NodeAssert.equal(planned.env.CUSTOM_TOKEN, "instance");
        NodeAssert.equal(planned.env.OMP_PROFILE, "work");
        NodeAssert.equal(planned.env.PATH, process.env.PATH);
        const noProfile = yield* buildNeoPiLaunchPlan({
          ...input,
          profile: "",
          env: { OMP_PROFILE: "environment-profile" },
        });
        NodeAssert.equal(noProfile.env.OMP_PROFILE, "environment-profile");
      }),
  );
});
