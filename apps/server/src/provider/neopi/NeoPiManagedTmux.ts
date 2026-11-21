// @effect-diagnostics nodeBuiltinImport:off -- Unix socket ownership and canonical paths are local OS facts.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { NeoPiNativeSessionRef, NeoPiNativeSessionsError } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ManagedOwnerLiveness } from "./NeoPiManagedLifecycle.ts";
import { isMissing, killManagedProcess, observeManagedProcess } from "./NeoPiManagedProcess.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const isNativeSessionsError = Schema.is(NeoPiNativeSessionsError);

// First slice: configure one already-running owner. No client may supply a socket or tmux command.
const Config = Schema.fromJsonString(
  Schema.Struct({
    ...NeoPiNativeSessionRef.fields,
    socket: Schema.NonEmptyString,
    session: Schema.NonEmptyString,
  }),
);
const decodeConfig = Schema.decodeUnknownSync(Config);
export type TmuxTarget = {
  readonly executable: string | undefined;
  readonly socket: string;
  readonly session: string;
};
export type ManagedTmuxConfig = typeof Config.Type & TmuxTarget;
export const resolveTmuxExecutable = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;
  const resolveExecutable = yield* SpawnExecutableResolution;
  const tmux =
    platform === "linux" || platform === "darwin"
      ? resolveExecutable("tmux", platform, env)
      : undefined;
  return tmux === undefined ? undefined : NodePath.resolve(tmux);
});
export const managedTmuxConfig = Effect.fnUntraced(function* (value: string | undefined) {
  if (value === undefined) return undefined;
  const config = decodeConfig(value);
  return { ...config, executable: yield* resolveTmuxExecutable };
});

const ControlStatus = Schema.Struct({
  instanceId: Schema.String,
  imageId: Schema.String,
  role: Schema.String,
  pid: Schema.Int,
  ready: Schema.Boolean,
  cwd: Schema.String,
  tmux: Schema.Struct({ pane: Schema.NullOr(Schema.String) }),
  session: Schema.Struct({
    sessionFile: Schema.optional(Schema.NullOr(Schema.String)),
    sessionId: Schema.String,
  }),
});
const Publication = Schema.Struct({
  instanceId: Schema.String,
  imageId: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  sessionFile: Schema.NullOr(Schema.String),
  profile: Schema.NullOr(Schema.String),
  pid: Schema.Int,
  role: Schema.String,
  tmuxPane: Schema.NullOr(Schema.String),
  procStartTicks: Schema.optional(Schema.NullOr(Schema.Int)),
});
const Registry = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    sessions: Schema.Array(
      // Older and unrelated control entries need not have the same snapshot schema.
      Schema.Struct({ meta: Schema.Unknown, snapshot: Schema.Unknown }),
    ),
  }),
);
const decodePublication = Schema.decodeUnknownOption(Publication);
const decodeStatus = Schema.decodeUnknownOption(ControlStatus);
const decodeRegistry = Schema.decodeUnknownOption(Registry);

interface ManagedPane {
  readonly executable: string;
  readonly session: string;
  readonly window: string;
  readonly pane: string;
  readonly pid: number;
}
export interface ManagedTmuxOwner extends ManagedPane {
  readonly instanceId: string;
  readonly imageId: string;
  readonly sessionId: string;
}
const unavailable = () =>
  new NeoPiNativeSessionsError({
    message: "This managed tmux pane's NeoPi control is disabled or unavailable.",
    code: "tmux_control_unavailable",
  });
const wrongSession = () =>
  new NeoPiNativeSessionsError({
    message: "This managed tmux pane belongs to a different native session or profile.",
    code: "session_changed",
  });
export const managedForceStopRecovery = "Exit with /exit in the old TUI, then reopen the session.";

const changedOwner = (recovery = "Reopen the view.") =>
  new NeoPiNativeSessionsError({
    message: `The managed tmux pane's NeoPi control identity changed. ${recovery}`,
    code: "tmux_owner_changed",
  });
const noOwner = () =>
  new NeoPiNativeSessionsError({
    message: "No managed tmux owner is running in the configured private socket and session.",
    code: "tmux_no_owner",
  });

export function verifyManagedTmuxStatus(owner: ManagedTmuxOwner, file: string, raw: unknown) {
  const decoded = decodeStatus(raw);
  if (decoded._tag === "None" || !decoded.value.ready) throw unavailable();
  const status = decoded.value;
  if (
    status.instanceId !== owner.instanceId ||
    status.imageId !== owner.imageId ||
    status.pid !== owner.pid ||
    status.role !== "tui" ||
    status.tmux.pane !== owner.pane
  ) {
    throw changedOwner();
  }
  if (status.session.sessionFile !== file || status.session.sessionId !== owner.sessionId) {
    throw wrongSession();
  }
  return status.cwd;
}

/** The registry inputs here use canonical file paths, not a catalog row keyed only by file. */
export function bindManagedTmuxOwner(
  requested: { readonly sessionFile?: string; readonly profile: string | null },
  pane: ManagedPane,
  entries: ReadonlyArray<{ readonly meta: unknown; readonly snapshot: unknown }>,
): ManagedTmuxOwner {
  return bindPublication(requested, pane, entries).owner;
}

function bindPublication(
  requested: { readonly sessionFile?: string; readonly profile: string | null },
  pane: ManagedPane,
  entries: ReadonlyArray<{ readonly meta: unknown; readonly snapshot: unknown }>,
) {
  let match: { meta: typeof Publication.Type; snapshot: unknown } | undefined;
  for (const { meta, snapshot } of entries) {
    const decoded = decodePublication(meta);
    if (decoded._tag === "None") continue;
    const publication = decoded.value;
    if (
      publication.pid !== pane.pid ||
      publication.tmuxPane !== pane.pane ||
      publication.role !== "tui"
    )
      continue;
    if (match) throw changedOwner();
    match = { meta: publication, snapshot };
  }
  if (!match) throw unavailable();
  const { meta, snapshot } = match;
  if (!meta.sessionFile || !meta.sessionId) throw unavailable();
  if (
    (requested.sessionFile !== undefined && meta.sessionFile !== requested.sessionFile) ||
    meta.profile !== requested.profile
  )
    throw wrongSession();
  const owner = {
    ...pane,
    instanceId: meta.instanceId,
    imageId: meta.imageId,
    sessionId: meta.sessionId,
  };
  verifyManagedTmuxStatus(owner, meta.sessionFile, snapshot);
  return { owner, sessionFile: meta.sessionFile, procStartTicks: meta.procStartTicks };
}

const tmuxMissing = () =>
  new NeoPiNativeSessionsError({
    message: "The managed TUI view requires tmux on the server's PATH on a Unix host.",
    code: "tmux_unavailable",
  });

/**
 * Prestarted managed servers must use a 0700 socket directory, `exit-unattached off`,
 * `destroy-unattached off`, `allow-passthrough off`, `window-size latest` and
 * `aggressive-resize off`. Keep one window and direct-exec main pane in the owner
 * session. Recovery uses a separate session (linked main window, independent current
 * window) and `attach-session -f ignore-size`. Same-UID explicit socket access is
 * not a security boundary. This probe never starts or changes a tmux server.
 */
async function checkPrivateSocket(socketPath: string) {
  const [path, socket, directory] = await Promise.all([
    NodeFSP.realpath(socketPath),
    NodeFSP.lstat(socketPath),
    NodeFSP.lstat(NodePath.dirname(socketPath)),
  ]);
  if (
    path !== socketPath ||
    !socket.isSocket() ||
    socket.uid !== process.getuid?.() ||
    !directory.isDirectory() ||
    directory.uid !== socket.uid ||
    (directory.mode & 0o077) !== 0
  )
    throw noOwner();
}

const readPane = Effect.fnUntraced(function* (config: TmuxTarget) {
  const { executable } = config;
  if (executable === undefined) return yield* tmuxMissing();
  return yield* Effect.tryPromise({
    try: async (signal) => {
      if (!NodePath.isAbsolute(config.socket)) throw noOwner();
      await checkPrivateSocket(config.socket);
      const { stdout } = await exec(
        executable,
        [
          "-N",
          "-S",
          config.socket,
          "list-panes",
          "-s",
          "-t",
          `=${config.session}:`,
          "-F",
          "#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}|#{pane_dead}|#{allow-passthrough}",
        ],
        { signal, timeout: 3000, maxBuffer: 65536 },
      );
      const matched = /^(\$\d+)\|(@\d+)\|(%\d+)\|([1-9]\d*)\|0\|(?:off|0)\n?$/.exec(stdout);
      if (!matched) throw noOwner();
      return {
        executable,
        session: matched[1]!,
        window: matched[2]!,
        pane: matched[3]!,
        pid: Number(matched[4]),
      };
    },
    catch: (cause) => (isNativeSessionsError(cause) ? cause : noOwner()),
  });
});

export const sameManagedTmuxOwner = (a: ManagedTmuxOwner, b: ManagedTmuxOwner) =>
  a.instanceId === b.instanceId &&
  a.imageId === b.imageId &&
  a.sessionId === b.sessionId &&
  a.session === b.session &&
  a.window === b.window &&
  a.pane === b.pane &&
  a.pid === b.pid;

export const managedTmuxClient = (
  config: ManagedTmuxConfig | TmuxBindingIdentity,
  owner: ManagedTmuxOwner,
) => {
  // A configured name can be reused; a generated UUID survives numeric ID reuse.
  const target = "owner" in config ? `=${config.session}:` : owner.session;
  return {
    executable: owner.executable,
    args: ["-N", "-S", config.socket, "attach-session", "-E", "-t", target],
  };
};

const resolvePublication = Effect.fnUntraced(function* (
  config: TmuxTarget,
  requested: { readonly sessionFile?: string; readonly profile: string | null },
  registry: Effect.Effect<string | undefined>,
  canonicalize: (file: string) => Effect.Effect<string, NeoPiNativeSessionsError>,
) {
  const pane = yield* readPane(config);
  const decoded = decodeRegistry(yield* registry);
  if (decoded._tag === "None") return yield* unavailable();
  // Canonicalize only candidates for this pane, not every entry in a shared registry.
  const candidates = yield* Effect.forEach(decoded.value.sessions, ({ meta: raw, snapshot }) =>
    Effect.gen(function* () {
      const entry = decodePublication(raw);
      if (
        entry._tag === "None" ||
        entry.value.pid !== pane.pid ||
        entry.value.tmuxPane !== pane.pane
      )
        return { meta: raw, snapshot };
      const meta = entry.value;
      const status = decodeStatus(snapshot);
      return {
        meta: {
          ...meta,
          sessionFile: meta.sessionFile ? yield* canonicalize(meta.sessionFile) : null,
        },
        snapshot:
          status._tag === "None" || !status.value.session.sessionFile
            ? snapshot
            : {
                ...status.value,
                session: {
                  ...status.value.session,
                  sessionFile: yield* canonicalize(status.value.session.sessionFile),
                },
              },
      };
    }),
  );
  return yield* Effect.try({
    try: () => bindPublication(requested, pane, candidates),
    catch: (cause) => (isNativeSessionsError(cause) ? cause : unavailable()),
  });
});

export const resolveManagedTmuxOwner = Effect.fnUntraced(function* (
  config: TmuxTarget,
  requested: { readonly sessionFile: string; readonly profile: string | null },
  registry: Effect.Effect<string | undefined>,
  canonicalize: (file: string) => Effect.Effect<string, NeoPiNativeSessionsError>,
) {
  return (yield* resolvePublication(config, requested, registry, canonicalize)).owner;
});

const Binding = Schema.Struct({
  socket: Schema.String,
  session: Schema.String,
  ...NeoPiNativeSessionRef.fields,
  profile: Schema.NullOr(Schema.String),
  // Keep legacy records readable so they are refused explicitly, not treated as absent.
  neoPiBinary: Schema.optional(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
  process: Schema.optional(Schema.Struct({ start: Schema.String, image: Schema.String })),
  owner: Schema.Struct({
    executable: Schema.String,
    session: Schema.String,
    window: Schema.String,
    pane: Schema.String,
    pid: Schema.Number,
    instanceId: Schema.String,
    imageId: Schema.String,
    sessionId: Schema.String,
  }),
});

export function managedControlPublication(
  binding: ManagedTmuxBinding,
  registry: string | undefined,
) {
  const decoded = decodeRegistry(registry);
  if (decoded._tag === "None") return undefined;
  const { owner } = binding;
  for (const entry of decoded.value.sessions) {
    const pub = decodePublication(entry.meta);
    if (pub._tag === "None") continue;
    const meta = pub.value;
    if (
      meta.instanceId !== owner.instanceId &&
      (meta.pid !== owner.pid || meta.tmuxPane !== owner.pane)
    )
      continue;
    if (
      meta.instanceId !== owner.instanceId ||
      meta.imageId !== owner.imageId ||
      meta.pid !== owner.pid ||
      meta.tmuxPane !== owner.pane ||
      meta.role !== "tui" ||
      meta.profile !== binding.profile ||
      meta.sessionFile !== binding.sessionFile ||
      meta.sessionId !== owner.sessionId
    ) {
      return { kind: "changed" as const };
    }
    let snapshot: unknown;
    if (entry.snapshot !== null) {
      try {
        verifyManagedTmuxStatus(owner, binding.sessionFile, entry.snapshot);
        snapshot = entry.snapshot;
      } catch (cause) {
        if (isNativeSessionsError(cause) && cause.code !== "tmux_control_unavailable")
          return { kind: "changed" as const };
      }
    }
    return { kind: "same" as const, snapshot };
  }
  return undefined;
}
export type ManagedTmuxBinding = typeof Binding.Type;
type TmuxBindingIdentity = Pick<ManagedTmuxBinding, "socket" | "session" | "sessionFile" | "owner">;
const bindingJson = Schema.fromJsonString(Binding);
const decodeBinding = Schema.decodeUnknownSync(bindingJson);
const encodeBinding = Schema.encodeSync(bindingJson);
const tmuxError = (code: string, message: string) =>
  new NeoPiNativeSessionsError({ code, message });

export const rebindManagedTmux = Effect.fnUntraced(function* <B extends TmuxBindingIdentity>(
  saved: B,
  rebind: (saved: B) => Effect.Effect<B, NeoPiNativeSessionsError>,
) {
  const binding = yield* rebind(saved);
  if (
    binding.socket !== saved.socket ||
    binding.session !== saved.session ||
    binding.sessionFile !== saved.sessionFile ||
    !sameManagedTmuxOwner(binding.owner, saved.owner)
  )
    return yield* changedOwner();
  return binding;
});

const LeaseHolder = Schema.Struct({
  pid: Schema.Int,
  instanceId: Schema.NonEmptyString,
  imageId: Schema.NonEmptyString,
});
const LeaseReport = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      status: Schema.Literal("held"),
      sessionFile: Schema.String,
      holder: LeaseHolder,
    }),
    Schema.Struct({ status: Schema.Literal("held_unknown"), sessionFile: Schema.String }),
    Schema.Struct({ status: Schema.Literal("not_held"), sessionFile: Schema.String }),
    Schema.Struct({
      status: Schema.Literal("inspection_failed"),
      sessionFile: Schema.String,
      reason: Schema.String,
    }),
  ]),
);
const decodeLeaseReport = Schema.decodeUnknownOption(LeaseReport);

interface LeaseCommandOutput {
  readonly ok: boolean;
  readonly out: string;
  readonly err: string;
}

const unverifiedLease = (reason: string) =>
  tmuxError("tmux_lease_unverified", `Could not verify the NeoPi session lease: ${reason}`);

function leaseHolder(sessionFile: string, output: LeaseCommandOutput) {
  if (!output.ok) {
    const diagnostic = output.err || output.out;
    if (/(?:unknown|unrecognized|unsupported|unexpected) (?:option|flag).*--file/i.test(diagnostic))
      throw tmuxError(
        "tmux_lease_unsupported",
        "NeoPi too old for tmux sessions. Update NeoPi to a release with exact-file lease queries.",
      );
    throw unverifiedLease(diagnostic.trim().split("\n", 1)[0] || "the lease command failed.");
  }
  const decoded = decodeLeaseReport(output.out);
  if (decoded._tag === "None") throw unverifiedLease("NeoPi returned an invalid lease report.");
  const report = decoded.value;
  if (report.sessionFile !== sessionFile)
    throw unverifiedLease("NeoPi reported a different session file.");
  switch (report.status) {
    case "held":
      return report.holder;
    case "not_held":
      return undefined;
    case "held_unknown":
      throw unverifiedLease("the lease is held, but NeoPi could not attest its holder.");
    case "inspection_failed":
      throw unverifiedLease(report.reason || "NeoPi could not inspect the lease.");
  }
}

export const verifyManagedTmuxLease = Effect.fnUntraced(function* (
  binding: Pick<TmuxBindingIdentity, "sessionFile" | "owner">,
  query: Effect.Effect<LeaseCommandOutput, NeoPiNativeSessionsError>,
) {
  const output = yield* query;
  return yield* Effect.try({
    try: () => {
      const holder = leaseHolder(binding.sessionFile, output);
      if (!holder) throw unverifiedLease("the lease is not held.");
      if (holder.pid !== binding.owner.pid)
        throw unverifiedLease(
          `the lease is held by PID ${holder.pid}, not managed pane PID ${binding.owner.pid}.`,
        );
      if (
        holder.instanceId !== binding.owner.instanceId ||
        holder.imageId !== binding.owner.imageId
      )
        throw unverifiedLease(
          "the lease holder's control identity does not match the managed pane.",
        );
    },
    catch: (cause) => (isNativeSessionsError(cause) ? cause : unverifiedLease(String(cause))),
  });
});

const requireUnheldLease = Effect.fnUntraced(function* (
  file: string,
  query: Effect.Effect<LeaseCommandOutput, NeoPiNativeSessionsError>,
) {
  const output = yield* query;
  return yield* Effect.try({
    try: () => {
      const holder = leaseHolder(file, output);
      if (holder)
        throw tmuxError(
          "session_in_use",
          `The native session is already open elsewhere (PID ${holder.pid}).`,
        );
    },
    catch: (cause) => (isNativeSessionsError(cause) ? cause : unverifiedLease(String(cause))),
  });
});

export const managedTmuxLaunchPlan = Effect.fnUntraced(function* (input: {
  readonly executable: string | undefined;
  readonly binary: string;
  readonly cwd: string;
  readonly sessionFile?: string;
  readonly extra: ReadonlyArray<string>;
}) {
  if (!input.executable) return yield* tmuxMissing();
  if (input.extra.some((arg) => arg.split("=", 1)[0] === "--no-control-socket"))
    return yield* unavailable();
  if (input.extra.length > 0)
    return yield* tmuxError(
      "tmux_launch_failed",
      "Managed tmux launches do not accept configured NeoPi launch arguments. Clear Launch arguments in NeoCode settings and configure defaults in the NeoPi profile.",
    );
  // Extensions can shadow builtins. Keep each value in the same token as its
  // option so NeoPi's extension-aware reparse never treats it as a prompt.
  return [
    input.binary,
    `--cwd=${input.cwd}`,
    "--no-title",
    input.sessionFile ? `--session=${input.sessionFile}` : "--new-session",
  ];
});

const managedConfigText = [
  "set -s exit-unattached off",
  "set -g destroy-unattached off",
  "set -g allow-passthrough off",
  "set -gw window-size latest",
  "set -gw aggressive-resize off",
  "set -g default-shell /bin/sh",
  "",
].join("\n");

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const paneEnvironment = {
  TMUX: true,
  TMUX_PANE: true,
  TERM: true,
  TERM_PROGRAM: true,
  TERM_PROGRAM_VERSION: true,
  PWD: true,
  SHLVL: true,
  _: true,
};

const managedPaneExports = (env: Readonly<Record<string, string>>) =>
  Object.entries(env)
    .filter(
      ([key]) =>
        !Object.hasOwn(paneEnvironment, key) &&
        !/^(?:T3CODE_|VITE_|OMP_HOST_)/.test(key) &&
        /^[A-Za-z_][A-Za-z_0-9]*$/.test(key),
    )
    .map(([key, value]) => `export ${key}=${shellQuote(value)}\n`)
    .join("");

const MonitorGrant = Schema.Struct({
  capability: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  agentId: Schema.String,
  kind: Schema.Literals(["sub", "advisor"]),
  canChat: Schema.Boolean,
});
const decodeMonitorGrant = Schema.decodeUnknownSync(MonitorGrant);

export function decodeManagedMonitorGrant(agentId: string, reply: unknown) {
  const grant = decodeMonitorGrant(reply);
  if (grant.agentId !== agentId || (grant.kind === "advisor" && grant.canChat)) {
    throw tmuxError("tmux_monitor_grant", "NeoPi returned an invalid grant for this agent.");
  }
  return grant.capability;
}

/** The independent session keeps the monitor's selection and size out of the main TUI. */
export const openManagedTmuxMonitor = Effect.fnUntraced(function* (input: {
  readonly socket: string;
  readonly owner: ManagedTmuxOwner;
  readonly cwd: string;
  readonly binary: string;
  readonly env: Readonly<Record<string, string>>;
  readonly capability: string;
}) {
  const { owner, socket } = input;
  const name = `monitor-${NodeCrypto.randomUUID()}`;
  // Session IDs can be reused when a new tmux server starts on the same socket.
  const target = `=${name}:`;
  const launchFile = NodePath.join(NodePath.dirname(socket), `${name}.sh`);
  const capabilityFile = `${launchFile}.cap`;
  const prefix = ["-N", "-S", socket];
  const run = (args: string[]) =>
    exec(owner.executable, [...prefix, ...args], { timeout: 3000, maxBuffer: 65536 });
  const cleanup = async () => {
    // Normal detach may have removed the session before the stream finalizer ran.
    await run(["kill-session", "-t", target]).catch(() => undefined);
    await Promise.all([
      NodeFSP.rm(launchFile, { force: true }),
      NodeFSP.rm(capabilityFile, { force: true }),
    ]);
  };
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        await checkPrivateSocket(socket);
        try {
          const argv = [
            input.binary,
            "monitor",
            "attach",
            owner.instanceId,
            "--capability-file",
            capabilityFile,
          ];
          // Leave room for tmux's dead-pane banner even if NeoPi refuses the socket
          // before the embedded client has attached and resized the window.
          const script = `/bin/rm -f -- ${shellQuote(launchFile)}\n${managedPaneExports(input.env)}printf '\\n\\n'\nexec ${argv.map(shellQuote).join(" ")}\n`;
          await NodeFSP.writeFile(capabilityFile, input.capability, { mode: 0o600, flag: "wx" });
          await NodeFSP.writeFile(launchFile, script, { mode: 0o600, flag: "wx" });
          await run([
            "new-session",
            "-dE",
            "-s",
            name,
            "-n",
            "NeoPi Monitor",
            "-c",
            input.cwd,
            "/bin/sleep",
            "30",
            // Configure this window before starting NeoPi. The host, not NeoCode, counts
            // sockets (including external monitors). Keep its refusal visible in the PTY.
            ";",
            "set-option",
            "-w",
            "-t",
            target,
            "remain-on-exit",
            "failed",
            ";",
            "set-option",
            "-t",
            target,
            "prefix",
            "None",
            ";",
            "set-option",
            "-t",
            target,
            "prefix2",
            "None",
            ";",
            "set-option",
            "-t",
            target,
            "status",
            "off",
            ";",
            "respawn-pane",
            "-k",
            "-t",
            target,
            "/bin/sh",
            launchFile,
          ]);
        } catch (cause) {
          await cleanup();
          throw cause;
        }
      },
      catch: () => tmuxError("tmux_monitor_launch", "Could not open the NeoPi agent monitor."),
    }),
    () => Effect.promise(cleanup).pipe(Effect.ignoreCause({ log: true })),
  );
  return {
    executable: owner.executable,
    args: [
      ...prefix,
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
    ],
  };
});

// Only retirees unlink bindings. Serialize compare-and-unlink across server
// processes; publication still uses a no-replace link. A lock on the private
// directory itself needs no crash recovery.
const unlinkExitedBinding = `
import fcntl, hashlib, os, sys
directory, name, expected, stop = sys.argv[1:]
fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
fcntl.flock(fd, fcntl.LOCK_EX)
try:
    entry = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
    with os.fdopen(entry, 'rb') as handle:
        if hashlib.sha256(handle.read()).hexdigest() != expected:
            sys.exit(42)
    os.unlink(name, dir_fd=fd)
except FileNotFoundError:
    sys.exit(42)
try:
    os.unlink(stop, dir_fd=fd)
except FileNotFoundError:
    pass
`;

export const makeManagedTmuxHost = (
  stateDir: string,
  executable: string | undefined,
  platform: NodeJS.Platform,
) => {
  const directory = NodePath.join(stateDir, "nt");
  const socket = NodePath.join(directory, "s");
  const configFile = NodePath.join(directory, "tmux.conf");
  const checkDirectory = async () => {
    const stat = await NodeFSP.lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      (await NodeFSP.realpath(directory)) !== directory
    )
      throw new Error("Not a canonical private directory");
  };
  const fileKey = (file: string) => NodeCrypto.createHash("sha256").update(file).digest("hex");
  const bindingFile = (file: string) => NodePath.join(directory, `${fileKey(file)}.json`);
  const stopFile = (binding: ManagedTmuxBinding) =>
    NodePath.join(directory, `stop-${fileKey(`${binding.sessionFile}\0${binding.owner.imageId}`)}`);
  const stopTime = (binding: ManagedTmuxBinding) =>
    Effect.tryPromise({
      try: async () => {
        try {
          return (await NodeFSP.lstat(stopFile(binding))).mtimeMs;
        } catch (cause) {
          if (isMissing(cause)) return undefined;
          throw cause;
        }
      },
      catch: storageError,
    });
  const markStop = (binding: ManagedTmuxBinding) =>
    Effect.tryPromise({
      try: async () => {
        await checkDirectory();
        try {
          await NodeFSP.writeFile(stopFile(binding), "", { mode: 0o600, flag: "wx" });
          return true;
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "EEXIST") return false;
          throw cause;
        }
      },
      catch: storageError,
    });
  const storageError = () =>
    tmuxError(
      "tmux_storage_unavailable",
      "The managed tmux identities could not be read or saved.",
    );
  const readPrivateBinding = async (file: string) => {
    await checkDirectory();
    const path = bindingFile(file);
    const stat = await NodeFSP.lstat(path);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("Not a private binding");
    const raw = await NodeFSP.readFile(path, "utf8");
    const binding = decodeBinding(raw);
    if (binding.sessionFile !== file || binding.socket !== socket)
      throw new Error("Wrong tmux identity");
    return { raw, binding };
  };
  const read = (file: string) =>
    Effect.tryPromise({
      try: async () => {
        try {
          return (await readPrivateBinding(file)).binding;
        } catch (cause) {
          if (isMissing(cause)) return undefined;
          throw cause;
        }
      },
      catch: storageError,
    });
  const retireExited = (binding: ManagedTmuxBinding) =>
    Effect.tryPromise({
      try: async (signal) => {
        const { raw, binding: current } = await readPrivateBinding(binding.sessionFile);
        if (encodeBinding(current) !== encodeBinding(binding)) throw changedOwner();
        await exec(
          "/usr/bin/python3",
          [
            "-I",
            "-S",
            "-c",
            unlinkExitedBinding,
            directory,
            NodePath.basename(bindingFile(binding.sessionFile)),
            NodeCrypto.createHash("sha256").update(raw).digest("hex"),
            NodePath.basename(stopFile(binding)),
          ],
          { signal, timeout: 3000, maxBuffer: 65536 },
        );
      },
      catch: (cause) =>
        isNativeSessionsError(cause) ||
        isMissing(cause) ||
        (cause instanceof Error && "code" in cause && cause.code === 42)
          ? changedOwner()
          : storageError(),
    });
  const list = Effect.tryPromise({
    try: async () => {
      try {
        await checkDirectory();
        return await NodeFSP.readdir(directory);
      } catch (cause) {
        if (isMissing(cause)) return [];
        throw cause;
      }
    },
    catch: storageError,
  }).pipe(
    Effect.flatMap((names) =>
      Effect.forEach(
        names.filter((name) => /^[0-9a-f]{64}\.json$/.test(name)),
        (name) =>
          Effect.tryPromise({
            try: async () => {
              const path = NodePath.join(directory, name);
              const stat = await NodeFSP.lstat(path);
              if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
                return undefined;
              const binding = decodeBinding(await NodeFSP.readFile(path, "utf8"));
              return binding.socket === socket &&
                NodePath.basename(bindingFile(binding.sessionFile)) === name
                ? binding
                : undefined;
            },
            catch: storageError,
          }).pipe(Effect.orElseSucceed(() => undefined)),
        { concurrency: 8 },
      ),
    ),
    Effect.map((entries) => entries.filter((entry) => entry !== undefined)),
  );
  const save = (binding: ManagedTmuxBinding) =>
    Effect.tryPromise({
      try: async () => {
        const temp = NodePath.join(directory, `${NodeCrypto.randomUUID()}.tmp`);
        try {
          await NodeFSP.writeFile(temp, encodeBinding(binding), { mode: 0o600, flag: "wx" });
          // Do not replace another server incarnation's publication record.
          await NodeFSP.link(temp, bindingFile(binding.sessionFile));
        } finally {
          await NodeFSP.rm(temp, { force: true });
        }
      },
      catch: storageError,
    });
  const target = (session: string): TmuxTarget => ({ socket, session, executable });
  // One tmux query for the sidebar, not one subprocess for each historical session.
  const panes = Effect.tryPromise({
    try: async (signal) => {
      if (!executable) throw tmuxMissing();
      try {
        await checkPrivateSocket(socket);
      } catch (cause) {
        if (isMissing(cause)) return [];
        throw cause;
      }
      try {
        const { stdout } = await exec(
          executable,
          [
            "-N",
            "-S",
            socket,
            "list-panes",
            "-a",
            "-F",
            "#{session_name}|#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}|#{pane_dead}",
          ],
          { signal, timeout: 3000, maxBuffer: 65536 },
        );
        const rows = stdout.trimEnd().split("\n").filter(Boolean);
        if (!rows.every((row) => /^[^|]+\|\$\d+\|@\d+\|%\d+\|[1-9]\d*\|[01]$/.test(row)))
          throw new Error("Unrecognized tmux pane inventory");
        return rows;
      } catch (cause) {
        // tmux can leave a socket inode when its last session exits. A failed
        // tmux command is not enough: verify that the private socket has no listener.
        const { promise, resolve } = Promise.withResolvers<boolean>();
        const probe = NodeNet.createConnection({ path: socket, signal });
        probe.once("connect", () => {
          probe.destroy();
          resolve(false);
        });
        probe.once("error", (error) =>
          resolve(isMissing(error) || ("code" in error && error.code === "ECONNREFUSED")),
        );
        probe.setTimeout(1000, () => {
          probe.destroy();
          resolve(false);
        });
        if (await promise) return [];
        throw cause;
      }
    },
    catch: () => tmuxError("tmux_unavailable", "The managed tmux server did not report its panes."),
  });
  const evidence = async (binding: ManagedTmuxBinding, rows: readonly string[] | undefined) => {
    const { owner } = binding;
    const prefix = `${binding.session}|${owner.session}|${owner.window}|${owner.pane}|`;
    const exact = `${prefix}${owner.pid}|`;
    const live = rows?.includes(`${exact}0`) ?? false;
    const deadOrMissing =
      rows !== undefined &&
      (rows.includes(`${exact}1`) || !rows.some((row) => row.startsWith(prefix)));
    const observed = await observeManagedProcess(platform, owner.pid);
    const expected = binding.process;
    const matchesSavedProcess =
      expected !== undefined &&
      observed.state === "alive" &&
      observed.identity.start === expected.start &&
      observed.identity.image === expected.image;
    const sameProcess = observed.state === "alive" && (!expected || matchesSavedProcess);
    const oldProcessGone =
      observed.state === "gone" ||
      (expected && observed.state === "alive" && observed.identity.start !== expected.start);
    const liveness: ManagedOwnerLiveness =
      deadOrMissing && oldProcessGone
        ? "exited"
        : live && (sameProcess || (platform !== "linux" && observed.state === "unknown"))
          ? "alive"
          : "unknown";
    return { liveness, forceTargetVerified: platform === "linux" && live && matchesSavedProcess };
  };
  const observe = (binding: ManagedTmuxBinding, rows: readonly string[] | undefined) =>
    Effect.promise(() => evidence(binding, rows));
  const force = (binding: ManagedTmuxBinding): Effect.Effect<void, NeoPiNativeSessionsError> =>
    Effect.gen(function* () {
      if (platform !== "linux" || !binding.process)
        return yield* tmuxError(
          "tmux_force_unsupported",
          "Force Stop requires a verified Linux process image.",
        );
      const owner = yield* readPane(target(binding.session)).pipe(
        Effect.mapError((error) =>
          error.code === "tmux_no_owner"
            ? tmuxError(error.code, `${error.message} ${managedForceStopRecovery}`)
            : error,
        ),
      );
      if (
        owner.session !== binding.owner.session ||
        owner.window !== binding.owner.window ||
        owner.pane !== binding.owner.pane ||
        owner.pid !== binding.owner.pid
      )
        return yield* changedOwner(managedForceStopRecovery);
      const identity = binding.process;
      yield* Effect.tryPromise({
        try: (signal) => killManagedProcess(owner.pid, identity, signal),
        catch: () =>
          tmuxError(
            "tmux_force_unconfirmed",
            `Could not signal the exact managed owner with a pidfd. ${managedForceStopRecovery}`,
          ),
      });
    });
  const launch = Effect.fnUntraced(function* (input: {
    readonly providerInstanceId: ManagedTmuxBinding["providerInstanceId"];
    readonly profile: string | null;
    readonly neoPiBinary: NonNullable<ManagedTmuxBinding["neoPiBinary"]>;
    readonly env: Record<string, string>;
    readonly cwd: string;
    readonly sessionFile?: string;
    readonly extra: ReadonlyArray<string>;
    readonly controlEnabled: Effect.Effect<boolean, NeoPiNativeSessionsError>;
    readonly registry: Effect.Effect<string | undefined>;
    readonly canonicalize: (file: string) => Effect.Effect<string, NeoPiNativeSessionsError>;
    readonly queryLease: (
      file: string,
    ) => Effect.Effect<LeaseCommandOutput, NeoPiNativeSessionsError>;
  }) {
    if (executable === undefined) return yield* tmuxMissing();
    if (platform !== "linux")
      return yield* tmuxError(
        "tmux_lease_unsupported",
        "NeoPi tmux sessions require Linux file lease queries.",
      );
    const argv = yield* managedTmuxLaunchPlan({
      ...input,
      executable,
      binary: input.neoPiBinary.path,
    });
    if (!(yield* input.controlEnabled)) return yield* unavailable();
    if (input.sessionFile)
      yield* requireUnheldLease(input.sessionFile, input.queryLease(input.sessionFile));
    const session = `native-${NodeCrypto.randomUUID()}`;
    const launchFile = NodePath.join(directory, `${session}.sh`);
    const paneTarget = target(session);
    const run = (args: string[], signal?: AbortSignal) =>
      exec(executable, ["-u", "-S", socket, ...args], {
        ...(signal ? { signal } : {}),
        timeout: 3000,
        maxBuffer: 65536,
        // The daemon must not keep this provider's credentials in its global environment.
        env: { PATH: "/usr/bin:/bin", HOME: input.env.HOME, LANG: "en_US.UTF-8" },
      });
    const start = Effect.tryPromise({
      try: async (signal) => {
        await NodeFSP.mkdir(directory, { mode: 0o700 }).catch((cause) => {
          if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
        });
        await checkDirectory();
        const socketStat = await NodeFSP.lstat(socket).catch((cause) => {
          if (isMissing(cause)) return undefined;
          throw cause;
        });
        if (socketStat && (!socketStat.isSocket() || socketStat.uid !== process.getuid?.()))
          throw new Error("Not a private tmux socket");
        const tmpConfig = `${launchFile}.conf`;
        try {
          await NodeFSP.writeFile(tmpConfig, managedConfigText, { mode: 0o600, flag: "wx" });
          await NodeFSP.rename(tmpConfig, configFile);
        } finally {
          await NodeFSP.rm(tmpConfig, { force: true });
        }
        // Login shell configuration must not run, and configured secrets never appear in argv.
        // The launcher replaces itself so the tmux pane PID is the exact NeoPi owner PID.
        const script = `/bin/rm -f -- ${shellQuote(launchFile)}\n${managedPaneExports(input.env)}exec ${argv.map(shellQuote).join(" ")}\n`;
        await NodeFSP.writeFile(launchFile, script, { mode: 0o600, flag: "wx" });
        try {
          const { stdout } = await run(
            [
              "-f",
              configFile,
              "new-session",
              "-dEP",
              "-F",
              "#{session_id}",
              "-s",
              session,
              "-n",
              "NeoPi",
              "-c",
              input.cwd,
              "/bin/sh",
              launchFile,
            ],
            signal,
          );
          const id = stdout.trim();
          if (!/^\$\d+$/.test(id)) throw new Error("No tmux session ID returned");
          return id;
        } catch (cause) {
          await NodeFSP.rm(launchFile, { force: true });
          throw cause;
        }
      },
      catch: () =>
        tmuxError(
          "tmux_launch_failed",
          "Could not create NeoPi's detached session in NeoCode's private tmux server.",
        ),
    });
    let persisted = false;
    return yield* Effect.acquireUseRelease(
      start,
      (id) =>
        Effect.gen(function* () {
          const result = yield* Effect.gen(function* () {
            for (;;) {
              const found = yield* resolvePublication(
                paneTarget,
                input,
                input.registry,
                input.canonicalize,
              ).pipe(Effect.result);
              if (found._tag === "Success") {
                const binding: ManagedTmuxBinding = {
                  owner: found.success.owner,
                  sessionFile: found.success.sessionFile,
                  socket,
                  session,
                  providerInstanceId: input.providerInstanceId,
                  profile: input.profile,
                  neoPiBinary: input.neoPiBinary,
                };
                if (binding.owner.session !== id) return yield* changedOwner();
                const observed = yield* Effect.promise(() =>
                  observeManagedProcess(platform, binding.owner.pid),
                );
                const lockedBinding =
                  observed.state === "alive" &&
                  found.success.procStartTicks === Number(observed.identity.start)
                    ? { ...binding, process: observed.identity }
                    : binding;
                yield* verifyManagedTmuxLease(binding, input.queryLease(binding.sessionFile));
                yield* save(lockedBinding).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      persisted = true;
                    }),
                  ),
                  Effect.uninterruptible,
                );
                return lockedBinding;
              }
              if (found.failure.code !== "tmux_control_unavailable") return yield* found.failure;
              yield* Effect.sleep("250 millis");
            }
          }).pipe(Effect.timeout("15 seconds"), Effect.result);
          if (result._tag === "Failure") {
            // A competing writer can win after the initial check. The losing pane can stop
            // or stay unready in NeoPi's conflict chooser; never respond to that chooser.
            if (
              input.sessionFile &&
              (!isNativeSessionsError(result.failure) || result.failure.code === "tmux_no_owner")
            )
              yield* requireUnheldLease(input.sessionFile, input.queryLease(input.sessionFile));
            return yield* isNativeSessionsError(result.failure) ? result.failure : unavailable();
          }
          return result.success;
        }),
      (id) =>
        persisted
          ? Effect.void
          : Effect.tryPromise(async () => {
              // Cancel only this unbound startup. Never respond to a TUI prompt with fork/read-only.
              const pane = await run([
                "-N",
                "list-panes",
                "-s",
                "-t",
                `=${session}:`,
                "-F",
                "#{session_id}",
              ]);
              if (pane.stdout.trim() === id)
                await run(["-N", "kill-session", "-t", `=${session}:`]);
            }).pipe(Effect.ignore),
    );
  });
  return { read, list, launch, target, panes, observe, retireExited, force, stopTime, markStop };
};
