import { it as effectIt } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution, type SpawnExecutableResolver } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  bindManagedTmuxOwner,
  rebindManagedTmux,
  makeManagedTmuxHost,
  managedControlPublication,
  managedTmuxLaunchPlan,
  verifyManagedTmuxLease,
  managedTmuxClient,
  managedTmuxConfig,
  resolveManagedTmuxOwner,
  openManagedTmuxMonitor,
  decodeManagedMonitorGrant,
  type ManagedTmuxBinding,
  type ManagedTmuxConfig,
} from "./NeoPiManagedTmux.ts";

const { exec, writeFile } = vi.hoisted(() => ({
  exec: vi.fn(),
  writeFile: vi.fn(async (_path: string, _data: string, _options: unknown) => {}),
}));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: exec }),
}));

const socket = "/private/owner.sock";
const ownedState = "/feature-state";
const ownedDirectory = `${ownedState}/nt`;
const ownedSocket = `${ownedDirectory}/s`;
vi.mock("node:fs/promises", () => ({
  realpath: vi.fn(async (path: string) => path),
  lstat: vi.fn(async (path: string) => ({
    isSocket: () => path === socket || path === ownedSocket,
    isDirectory: () => path === "/private" || path === ownedDirectory,
    uid: process.getuid?.(),
    mode: 0o700,
  })),
  mkdir: vi.fn(async () => {}),
  link: vi.fn(async () => {}),
  writeFile,
  rename: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
}));

const executable = "/server-path/bin/tmux";
const pane = { executable, session: "$2", window: "@3", pane: "%4", pid: 321 };
const sessionFile = "/profile/sessions/session.jsonl";
const publication = {
  instanceId: "0123456789abcdef",
  imageId: "this-image",
  sessionId: "native-session",
  sessionFile,
  profile: "work",
  pid: 321,
  role: "tui",
  tmuxPane: "%4",
};
const status = {
  instanceId: publication.instanceId,
  imageId: publication.imageId,
  session: { sessionId: publication.sessionId, sessionFile },
  ready: true,
  cwd: "/project",
  pid: 321,
  role: "tui",
  tmux: { pane: "%4" },
};
const entry = { meta: publication, snapshot: status };
const requested = { sessionFile, profile: "work" };

describe("managed tmux ownership", () => {
  it("binds the exact pane and ready control image, not a matching file from a different pane owner", () => {
    const other = { ...entry, meta: { ...publication, pid: 999, instanceId: "other" } };
    expect(bindManagedTmuxOwner(requested, pane, [other, entry])).toEqual({
      ...pane,
      instanceId: publication.instanceId,
      imageId: publication.imageId,
      sessionId: publication.sessionId,
    });
  });

  it("refuses a live pane without an attachable endpoint", () => {
    expect(() => bindManagedTmuxOwner(requested, pane, [])).toThrow(
      /control.*disabled or unavailable/i,
    );
    expect(() => bindManagedTmuxOwner(requested, pane, [{ ...entry, snapshot: null }])).toThrow(
      /control.*disabled or unavailable/i,
    );
  });

  it("refuses the pane when its publication is for a different session or profile", () => {
    expect(() =>
      bindManagedTmuxOwner({ ...requested, sessionFile: "/profile/other.jsonl" }, pane, [entry]),
    ).toThrow(/different native session/i);
    expect(() => bindManagedTmuxOwner({ ...requested, profile: "other" }, pane, [entry])).toThrow(
      /different native session/i,
    );
  });

  it("refuses a publication replaced by a different control image", () => {
    expect(() =>
      bindManagedTmuxOwner(requested, pane, [
        { ...entry, snapshot: { ...status, imageId: "new-image" } },
      ]),
    ).toThrow(/changed/i);
  });
});

describe("managed tmux pane lookup", () => {
  const config = {
    ...requested,
    providerInstanceId: ProviderInstanceId.make("neopi"),
    socket,
    session: "owner",
  };
  const env = { PATH: "/server-path/bin" };
  const resolveExecutable = vi.fn<SpawnExecutableResolver>();
  const prepare = (session = config.session) =>
    managedTmuxConfig(JSON.stringify({ ...config, session })).pipe(
      Effect.provideService(HostProcessEnvironment, env),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(SpawnExecutableResolution, resolveExecutable),
      Effect.map((target) => {
        if (!target) throw new Error("Expected managed tmux configuration");
        return target;
      }),
      Effect.runPromise,
    );
  const lookup = (target: ManagedTmuxConfig) =>
    resolveManagedTmuxOwner(
      target,
      requested,
      Effect.succeed(JSON.stringify({ version: 1, sessions: [entry] })),
      Effect.succeed,
    ).pipe(Effect.runPromise);

  const ownerPane = "$2|@3|%4|321|0|off\n";
  const otherPane = "$9|@8|%7|654|0|off\n";

  beforeEach(() => {
    resolveExecutable.mockReset();
    resolveExecutable.mockReturnValue(executable);
    exec.mockReset();
    exec.mockImplementation(async (_file: string, args: readonly string[]) => {
      const target = args[args.indexOf("-t") + 1];
      // The unqualified window target finds another session's window named "owner".
      if (target === "=owner") return { stdout: otherPane };
      if (target === "=owner:") return { stdout: ownerPane };
      // The unqualified name can also fall back to a session prefix.
      if (target === "=own") return { stdout: ownerPane };
      throw new Error(`can't find session: ${target}`);
    });
  });

  it("selects the exact session rather than another session's same-named window", async () => {
    await expect(lookup(await prepare())).resolves.toMatchObject(pane);
  });

  it("refuses a session-name prefix instead of selecting the matching session", async () => {
    await expect(lookup(await prepare("own"))).rejects.toMatchObject({ code: "tmux_no_owner" });
  });

  it("uses one server PATH resolution and refuses a replacement of the configured session", async () => {
    const target = await prepare();
    await lookup(target);
    const owner = await lookup(target);
    expect(exec.mock.calls.map(([file]) => file)).toEqual([executable, executable]);
    // After the probe, the original ID is gone and the configured name resolves to $9.
    exec.mockImplementation(async (_file: string, args: readonly string[]) => {
      if (args.at(-1) === "=owner:") return { stdout: otherPane };
      throw new Error(`can't find session: ${args.at(-1)}`);
    });
    const client = managedTmuxClient(target, owner);
    await expect(exec(client.executable, client.args)).rejects.toThrow("can't find session: $2");
    expect(client).toEqual({
      executable,
      args: ["-N", "-S", socket, "attach-session", "-E", "-t", "$2"],
    });
    expect(resolveExecutable).toHaveBeenCalledExactlyOnceWith("tmux", "linux", env);
  });

  it("targets the exact generated owner name even when its numeric ID is reused", async () => {
    const target = await prepare();
    const owner = await lookup(target);
    const binding: ManagedTmuxBinding = {
      ...config,
      session: "native-01234567-89ab-4def-8123-456789abcdef",
      owner,
    };
    exec.mockImplementation(async (_file: string, args: readonly string[]) => {
      if (args.at(-1) === "$2") return { stdout: otherPane };
      throw new Error(`can't find session: ${args.at(-1)}`);
    });
    const client = managedTmuxClient(binding, owner);
    await expect(exec(client.executable, client.args)).rejects.toThrow(
      "can't find session: =native-01234567-89ab-4def-8123-456789abcdef:",
    );
  });

  it("refuses explicitly without probing when tmux is absent from the server PATH", async () => {
    resolveExecutable.mockReturnValue(undefined);
    await expect(lookup(await prepare())).rejects.toMatchObject({ code: "tmux_unavailable" });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("managed tmux monitor", () => {
  const owner = { ...pane, ...publication };
  const open = (capability = "a".repeat(64)) =>
    openManagedTmuxMonitor({
      socket,
      owner,
      cwd: "/project",
      binary: "/private/npi nightly",
      env: { PI_CONTROL_DIR: "/private/control" },
      capability,
    });

  effectIt.effect(
    "isolates the monitor in its own window, preserves native refusals, and closes on hide",
    () =>
      Effect.gen(function* () {
        writeFile.mockClear();
        exec.mockReset();
        exec.mockResolvedValue({ stdout: "" });
        const observed = yield* Effect.gen(function* () {
          const client = yield* open();
          expect(exec.mock.calls.some(([, args]) => args.includes("kill-session"))).toBe(false);
          return client;
        }).pipe(Effect.scoped);
        const [tmux, launch] = exec.mock.calls[0]!;
        expect(tmux).toBe(executable);
        expect(launch.slice(0, 5)).toEqual(["-N", "-S", socket, "new-session", "-dE"]);
        expect(launch).toContain("remain-on-exit");
        expect(launch).toContain("failed"); // NeoPi's authoritative connection-limit refusal stays visible.
        expect(launch).not.toContain(owner.session);
        expect(launch.join(" ")).not.toContain("a".repeat(64));
        const [grantWrite, scriptWrite] = writeFile.mock.calls;
        expect(grantWrite).toEqual([
          expect.stringMatching(/\/monitor-.*\.cap$/),
          "a".repeat(64),
          { mode: 0o600, flag: "wx" },
        ]);
        expect(scriptWrite?.[1]).toContain(
          `exec '/private/npi nightly' 'monitor' 'attach' '${owner.instanceId}' '--capability-file' '${grantWrite?.[0]}'`,
        );
        expect(scriptWrite?.[1]).not.toMatch(/--(?:session|new-session|mode|exit-with-parent)\b/);
        expect(scriptWrite?.[1]).not.toContain("a".repeat(64));
        const name = launch[launch.indexOf("-s") + 1];
        expect(name).toMatch(/^monitor-[0-9a-f-]{36}$/);
        const target = `=${name}:`;
        expect(observed.args).toEqual([
          "-N",
          "-S",
          socket,
          "attach-session",
          "-E",
          "-t",
          target,
          ";",
          "set-option",
          "-t",
          target,
          "destroy-unattached",
          "on",
        ]);
        expect(exec.mock.calls.at(-1)?.[1]).toEqual([
          "-N",
          "-S",
          socket,
          "kill-session",
          "-t",
          target,
        ]);
      }),
  );

  effectIt.effect("leaves a replacement owner alone when tmux reuses the monitor's ID", () =>
    Effect.gen(function* () {
      const replacement = { attached: false, destroyUnattached: "off", alive: true };
      let restarted = false;
      exec.mockReset();
      exec.mockImplementation(async (_file: string, args: string[]) => {
        if (args[3] === "new-session") return { stdout: "$0\n" };
        if (!restarted) throw new Error("Expected the tmux server to have restarted");

        for (const command of args.slice(3).join(" ").split(" ; ")) {
          const [verb, ...options] = command.split(" ");
          const target = options[options.indexOf("-t") + 1];
          if (target !== "$0") continue; // The old monitor name is absent on the new server.
          if (verb === "attach-session") replacement.attached = true;
          if (verb === "set-option") replacement.destroyUnattached = options.at(-1)!;
          if (verb === "kill-session") replacement.alive = false;
        }
        return { stdout: "" };
      });

      yield* Effect.gen(function* () {
        const client = yield* open();
        restarted = true;
        yield* Effect.promise(() => exec(client.executable, client.args));
      }).pipe(Effect.scoped);

      expect(replacement).toEqual({ attached: false, destroyUnattached: "off", alive: true });
    }),
  );

  it("pins a grant to the requested agent and refuses writable advisor grants", () => {
    const capability = "a".repeat(64);
    const grant = { capability, agentId: "advisor-a", kind: "advisor", canChat: false };
    expect(decodeManagedMonitorGrant("advisor-a", grant)).toBe(capability);
    expect(() => decodeManagedMonitorGrant("advisor-a", { ...grant, canChat: true })).toThrow();
    expect(() => decodeManagedMonitorGrant("advisor-b", grant)).toThrow();
    expect(
      decodeManagedMonitorGrant("worker", {
        capability,
        agentId: "worker",
        kind: "sub",
        canChat: true,
      }),
    ).toBe(capability);
  });
});

describe("managed lifetime pane evidence", () => {
  const binding = {
    socket: ownedSocket,
    providerInstanceId: ProviderInstanceId.make("neopi"),
    ...requested,
    session: "owner",
    owner: bindManagedTmuxOwner(requested, pane, [entry]),
    process: { start: "1001", image: "1:2002" },
  };

  it("refuses a replacement control image published in the original pane at the original PID", () => {
    const replacement = {
      ...entry,
      meta: { ...publication, instanceId: "replacement", imageId: "changed" },
    };
    expect(
      managedControlPublication(binding, JSON.stringify({ version: 1, sessions: [replacement] })),
    ).toEqual({ kind: "changed" });
  });

  effectIt.effect("Force Stop validates the pane before signaling the exact process", () =>
    Effect.gen(function* () {
      const host = makeManagedTmuxHost(ownedState, executable, "linux");
      exec.mockReset();
      exec.mockResolvedValueOnce({ stdout: "$2|@3|%9|321|0|off\n" });
      expect(yield* Effect.flip(host.force(binding))).toMatchObject({
        code: "tmux_owner_changed",
      });
      expect(exec).toHaveBeenCalledTimes(1);
      exec.mockResolvedValueOnce({ stdout: "$2|@3|%4|321|0|off\n" });
      exec.mockResolvedValueOnce({ stdout: "" });
      yield* host.force(binding);
      expect(exec.mock.calls[1]?.[1].slice(0, 6)).toEqual([
        "-N",
        "-S",
        ownedSocket,
        "list-panes",
        "-s",
        "-t",
      ]);
      expect(exec.mock.calls[2]?.[0]).toBe("/usr/bin/python3");
      expect(exec.mock.calls[2]?.[1].slice(-3)).toEqual(["321", "1001", "1:2002"]);
    }),
  );
});

describe("managed tmux owner startup", () => {
  const source = {
    binary: "/opt/npi nightly",
    cwd: "/workspace dir",
    extra: [],
    executable,
  };
  const neoPiBinary = { path: source.binary, sha256: "a".repeat(64) };
  const owner = {
    ...pane,
    instanceId: publication.instanceId,
    imageId: publication.imageId,
    sessionId: publication.sessionId,
  };
  const binding = { socket, session: "owner", sessionFile, owner };

  effectIt.effect(
    "launches an interactive process with explicit fresh or exact-file selection",
    () =>
      Effect.gen(function* () {
        expect(yield* managedTmuxLaunchPlan(source)).toEqual([
          "/opt/npi nightly",
          "--cwd=/workspace dir",
          "--no-title",
          "--new-session",
        ]);
        expect(yield* managedTmuxLaunchPlan({ ...source, sessionFile })).toEqual([
          "/opt/npi nightly",
          "--cwd=/workspace dir",
          "--no-title",
          `--session=${sessionFile}`,
        ]);
      }),
  );

  effectIt.effect("refuses missing tmux or an explicit control opt-out before launch", () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.flip(managedTmuxLaunchPlan({ ...source, executable: undefined })),
      ).toMatchObject({ code: "tmux_unavailable" });
      expect(
        yield* Effect.flip(managedTmuxLaunchPlan({ ...source, extra: ["--no-control-socket"] })),
      ).toMatchObject({ code: "tmux_control_unavailable" });
    }),
  );

  effectIt.effect("refuses configured argv before a shadowed option can submit a prompt", () =>
    Effect.gen(function* () {
      for (const extra of [
        ["do work"],
        ["--model", "plain-startup-prompt"],
        ["--model=plain-startup-prompt"],
        ["--no-skills"],
        ["--model", "fixture", "do work"],
        ["--no-skills", "do work"],
        ["--unknown", "do work"],
        ["@attachment.txt"],
        ["-p", "do work"],
      ]) {
        const result = yield* managedTmuxLaunchPlan({ ...source, extra }).pipe(Effect.result);
        expect(result._tag, extra.join(" ")).toBe("Failure");
      }
    }),
  );

  effectIt.effect("rebinds a persisted owner by its complete identity without launching", () =>
    Effect.gen(function* () {
      const rebind = vi.fn(() => Effect.succeed(binding));
      expect(yield* rebindManagedTmux(binding, rebind)).toEqual(binding);
      expect(rebind).toHaveBeenCalledExactlyOnceWith(binding);
      rebind.mockReturnValue(Effect.succeed({ ...binding, owner: { ...owner, imageId: "other" } }));
      expect(yield* Effect.flip(rebindManagedTmux(binding, rebind))).toMatchObject({
        code: "tmux_owner_changed",
      });
    }),
  );

  effectIt.effect(
    "discards a lease-losing startup and refuses work without typing into the pane",
    () =>
      Effect.gen(function* () {
        exec.mockReset();
        let replacementKilled = false;
        exec.mockImplementation(async (_file: string, args: string[]) => {
          if (args.includes("new-session") || args.includes("#{session_id}"))
            return { stdout: "$2\n" };
          if (args.includes("list-panes")) return { stdout: "$2|@3|%4|321|1|off\n" };
          if (args.includes("kill-session")) {
            // The server was replaced after the last list-panes, which returned $2.
            if (args.at(-1) === "$2") replacementKilled = true;
            throw new Error("can't find session");
          }
          throw new Error("Unexpected tmux command");
        });
        const host = makeManagedTmuxHost(ownedState, executable, "linux");
        const queryLease = vi
          .fn()
          .mockReturnValueOnce(Effect.succeed(leaseOutput({ status: "not_held", sessionFile })))
          .mockReturnValueOnce(
            Effect.succeed(
              leaseOutput({
                ...held,
                holder: { ...held.holder, pid: 999 },
              }),
            ),
          );
        expect(
          yield* Effect.flip(
            host.launch({
              ...source,
              neoPiBinary,
              env: {},
              providerInstanceId: ProviderInstanceId.make("neopi"),
              profile: null,
              sessionFile,
              registry: Effect.succeed('{"version":1,"sessions":[]}'),
              canonicalize: Effect.succeed,
              controlEnabled: Effect.succeed(true),
              queryLease,
            }),
          ),
        ).toMatchObject({ code: "session_in_use", message: expect.stringContaining("PID 999") });
        const commands = exec.mock.calls.map(([, args]) => args);
        const launches = commands.filter((args) => args.includes("new-session"));
        expect(launches).toHaveLength(1);
        const launch = launches[0]!;
        const name = launch[launch.indexOf("-s") + 1];
        expect(commands.filter((args) => args.includes("kill-session"))).toEqual([
          ["-u", "-S", ownedSocket, "-N", "kill-session", "-t", `=${name}:`],
        ]);
        expect(replacementKilled).toBe(false);
        expect(commands.some((args) => args.includes("send-keys"))).toBe(false);
        expect(queryLease.mock.calls).toEqual([[sessionFile], [sessionFile]]);
      }),
  );

  const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
  const leaseOutput = (report: unknown) => ({
    ok: true,
    out: encodeJson(report),
    err: "",
  });
  const held = {
    status: "held",
    sessionFile,
    holder: { pid: owner.pid, instanceId: owner.instanceId, imageId: owner.imageId },
  };

  effectIt.effect(
    "accepts the exact file lease attested by the authenticated pane PID and control image",
    () => verifyManagedTmuxLease(binding, Effect.succeed(leaseOutput(held))),
  );

  for (const [report, reason] of [
    [{ ...held, holder: { ...held.holder, pid: 999 } }, /held by PID 999/],
    [{ ...held, holder: { ...held.holder, imageId: "different" } }, /control identity/],
    [{ ...held, sessionFile: "/other.jsonl" }, /different session file/],
    [{ status: "held_unknown", sessionFile, leaseRecordPid: owner.pid }, /could not attest/],
    [{ status: "not_held", sessionFile }, /not held/],
    [
      { status: "inspection_failed", sessionFile, reason: "native probe unavailable" },
      /native probe unavailable/,
    ],
  ] as const) {
    effectIt.effect(`refuses an unverified lease: ${reason.source}`, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          verifyManagedTmuxLease(binding, Effect.succeed(leaseOutput(report))),
        );
        expect(failure.message).toMatch(reason);
      }),
    );
  }

  effectIt.effect(
    "refuses older NeoPi with an actionable reason instead of falling back to its catalog",
    () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          verifyManagedTmuxLease(
            binding,
            Effect.succeed({
              ok: false,
              out: "",
              err: "error: Unknown option '--file'.",
            }),
          ),
        );
        expect(failure).toMatchObject({
          code: "tmux_lease_unsupported",
          message: expect.stringContaining("NeoPi too old for tmux sessions"),
        });
      }),
  );

  for (const [report, accepted] of [
    [held, true],
    [{ ...held, holder: { ...held.holder, pid: 999 } }, false],
  ] as const) {
    effectIt.effect(
      `only binds a brand-new untitled session with an attested pane (${accepted})`,
      () =>
        Effect.gen(function* () {
          exec.mockReset();
          exec.mockImplementation(async (_file: string, args: string[]) => {
            if (args.includes("new-session") || args.includes("#{session_id}"))
              return { stdout: "$2\n" };
            if (args.includes("list-panes")) return { stdout: "$2|@3|%4|321|0|off\n" };
            if (args.includes("kill-session")) return { stdout: "" };
            throw new Error("Unexpected tmux command");
          });
          const host = makeManagedTmuxHost(ownedState, executable, "linux");
          const result = yield* host
            .launch({
              ...source,
              neoPiBinary,
              env: {},
              providerInstanceId: ProviderInstanceId.make("neopi"),
              profile: "work",
              registry: Effect.succeed(encodeJson({ version: 1, sessions: [entry] })),
              canonicalize: Effect.succeed,
              controlEnabled: Effect.succeed(true),
              queryLease: (file) => {
                expect(file).toBe(sessionFile);
                return Effect.succeed(leaseOutput(report));
              },
            })
            .pipe(Effect.result);
          expect(result._tag).toBe(accepted ? "Success" : "Failure");
          if (result._tag === "Success")
            expect(result.success).toMatchObject({ sessionFile, neoPiBinary });
          const commands = exec.mock.calls.map(([, args]) => args);
          expect(commands.some((args) => args.includes("kill-session"))).toBe(!accepted);
          expect(commands.some((args) => args.includes("send-keys"))).toBe(false);
        }),
    );
  }
});
