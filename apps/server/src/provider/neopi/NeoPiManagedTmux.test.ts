import { it as effectIt } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution, type SpawnExecutableResolver } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  bindManagedTmuxOwner,
  bindOrStartManagedTmux,
  makeManagedTmuxHost,
  managedTmuxLaunchPlan,
  verifyManagedTmuxLease,
  managedTmuxClient,
  managedTmuxConfig,
  resolveManagedTmuxOwner,
  type ManagedTmuxConfig,
} from "./NeoPiManagedTmux.ts";

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }));
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
  writeFile: vi.fn(async () => {}),
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

  it("uses one server PATH resolution for pane probes and attaches by verified session id", async () => {
    const target = await prepare();
    await lookup(target);
    const owner = await lookup(target);
    expect(exec.mock.calls.map(([file]) => file)).toEqual([executable, executable]);
    expect(managedTmuxClient(target, owner)).toEqual({
      executable,
      args: ["-N", "-S", socket, "attach-session", "-E", "-t", "$2"],
    });
    expect(resolveExecutable).toHaveBeenCalledExactlyOnceWith("tmux", "linux", env);
  });

  it("refuses explicitly without probing when tmux is absent from the server PATH", async () => {
    resolveExecutable.mockReturnValue(undefined);
    await expect(lookup(await prepare())).rejects.toMatchObject({ code: "tmux_unavailable" });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("managed tmux owner startup", () => {
  const source = {
    binary: "/opt/npi nightly",
    cwd: "/workspace dir",
    extra: ["--model", "fixture"],
    executable,
  };
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
          "--cwd",
          "/workspace dir",
          "--no-title",
          "--model",
          "fixture",
          "--new-session",
        ]);
        expect(yield* managedTmuxLaunchPlan({ ...source, sessionFile })).toEqual([
          "/opt/npi nightly",
          "--cwd",
          "/workspace dir",
          "--no-title",
          "--model",
          "fixture",
          "--session",
          sessionFile,
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

  effectIt.effect("rebinds a persisted owner by its complete identity without launching", () =>
    Effect.gen(function* () {
      const rebind = vi.fn(() => Effect.succeed(binding));
      const launch = vi.fn(() => Effect.succeed(binding));
      expect(yield* bindOrStartManagedTmux(binding, rebind, launch)).toEqual({
        kind: "bound",
        binding,
      });
      expect(rebind).toHaveBeenCalledExactlyOnceWith(binding);
      expect(launch).not.toHaveBeenCalled();
      rebind.mockReturnValue(Effect.succeed({ ...binding, owner: { ...owner, imageId: "other" } }));
      expect(yield* Effect.flip(bindOrStartManagedTmux(binding, rebind, launch))).toMatchObject({
        code: "tmux_owner_changed",
      });
      expect(launch).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect(
    "discards a lease-losing startup and selects the original holder without typing into the pane",
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
        const host = makeManagedTmuxHost(ownedState, executable);
        const verifyLease = vi.fn(() => Effect.void);
        const start = () =>
          host.launch({
            ...source,
            env: {},
            providerInstanceId: ProviderInstanceId.make("neopi"),
            profile: null,
            sessionFile,
            registry: Effect.succeed('{"version":1,"sessions":[]}'),
            canonicalize: Effect.succeed,
            controlEnabled: Effect.succeed(true),
            readHolderPid: Effect.succeed(999),
            verifyLease,
          });
        const rebind = vi.fn(() =>
          Effect.succeed({
            ...binding,
            providerInstanceId: ProviderInstanceId.make("neopi"),
            profile: null,
          }),
        );
        const findHolder = vi.fn(() => Effect.succeed("original-holder"));
        expect(yield* bindOrStartManagedTmux(undefined, rebind, start, findHolder)).toEqual({
          kind: "contended",
          instanceId: "original-holder",
        });
        const commands = exec.mock.calls.map(([, args]) => args);
        expect(commands.filter((args) => args.includes("new-session"))).toHaveLength(1);
        expect(commands.filter((args) => args.includes("kill-session"))).toEqual([
          ["-u", "-S", ownedSocket, "-N", "kill-session", "-t", "$2"],
        ]);
        expect(commands.some((args) => args.includes("send-keys"))).toBe(false);
        expect(verifyLease).not.toHaveBeenCalled();
        expect(rebind).not.toHaveBeenCalled();
      }),
  );

  it("requires native evidence that the authenticated pane PID holds the lease", () => {
    const catalog = {
      id: owner.sessionId,
      inUse: { pid: owner.pid },
      control: { instanceId: owner.instanceId },
    };
    expect(() => verifyManagedTmuxLease(owner, catalog)).not.toThrow();
    // The already authenticated pane and publication remain live when the gate is free.
    // An advisory sidecar reporting the same PID is not a catalog inUse observation.
    const advisoryOnly = { ...catalog, inUse: null, leaseRecordPid: owner.pid };
    for (const reported of [
      undefined,
      advisoryOnly,
      { ...catalog, inUse: { pid: 0 } },
      { ...catalog, inUse: { pid: 999 } },
      { ...catalog, control: { instanceId: "other" } },
    ]) {
      expect(() => verifyManagedTmuxLease(owner, reported)).toThrow(
        expect.objectContaining({ code: "tmux_lease_unverified" }),
      );
    }
  });
});
