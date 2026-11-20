import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution, type SpawnExecutableResolver } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  bindManagedTmuxOwner,
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
vi.mock("node:fs/promises", () => ({
  realpath: vi.fn(async (path: string) => path),
  lstat: vi.fn(async (path: string) => ({
    isSocket: () => path === socket,
    isDirectory: () => path === "/private",
    uid: process.getuid?.(),
    mode: 0o700,
  })),
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
