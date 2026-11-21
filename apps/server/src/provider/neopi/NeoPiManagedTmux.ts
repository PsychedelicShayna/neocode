// @effect-diagnostics nodeBuiltinImport:off -- Unix socket ownership and canonical paths are local OS facts.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { NeoPiNativeSessionRef, NeoPiNativeSessionsError } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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
const changedOwner = () =>
  new NeoPiNativeSessionsError({
    message: "The managed tmux pane's NeoPi control identity changed. Reopen the view.",
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
  return { owner, sessionFile: meta.sessionFile };
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
const readPane = Effect.fnUntraced(function* (config: TmuxTarget) {
  const { executable } = config;
  if (executable === undefined) return yield* tmuxMissing();
  return yield* Effect.tryPromise({
    try: async (signal) => {
      if (!NodePath.isAbsolute(config.socket)) throw noOwner();
      const [path, socket, directory] = await Promise.all([
        NodeFSP.realpath(config.socket),
        NodeFSP.lstat(config.socket),
        NodeFSP.lstat(NodePath.dirname(config.socket)),
      ]);
      if (
        path !== config.socket ||
        !socket.isSocket() ||
        socket.uid !== process.getuid?.() ||
        !directory.isDirectory() ||
        directory.uid !== socket.uid ||
        (directory.mode & 0o077) !== 0
      ) {
        throw noOwner();
      }
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

export const managedTmuxClient = (config: Pick<TmuxTarget, "socket">, owner: ManagedTmuxOwner) => ({
  executable: owner.executable,
  args: ["-N", "-S", config.socket, "attach-session", "-E", "-t", owner.session],
});

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
export type ManagedTmuxBinding = typeof Binding.Type;
type TmuxBindingIdentity = Pick<ManagedTmuxBinding, "socket" | "session" | "sessionFile" | "owner">;
const bindingJson = Schema.fromJsonString(Binding);
const decodeBinding = Schema.decodeUnknownSync(bindingJson);
const encodeBinding = Schema.encodeSync(bindingJson);
const tmuxError = (code: string, message: string) =>
  new NeoPiNativeSessionsError({ code, message });

const sessionInUse = () =>
  tmuxError("session_in_use", "The native session is already open elsewhere.");

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

export const bindOrStartManagedTmux = Effect.fnUntraced(function* <B extends TmuxBindingIdentity>(
  saved: B | undefined,
  rebind: (saved: B) => Effect.Effect<B, NeoPiNativeSessionsError>,
  start: () => Effect.Effect<B, NeoPiNativeSessionsError>,
  findHolder: () => Effect.Effect<string | undefined, NeoPiNativeSessionsError> = () =>
    Effect.undefined,
) {
  if (saved) return { kind: "bound" as const, binding: yield* rebindManagedTmux(saved, rebind) };
  const started = yield* Effect.suspend(start).pipe(Effect.result);
  if (started._tag === "Success") return { kind: "bound" as const, binding: started.success };
  if (started.failure.code !== "session_in_use") return yield* started.failure;
  const instanceId = yield* findHolder();
  if (!instanceId) return yield* started.failure;
  return { kind: "contended" as const, instanceId };
});

export function verifyManagedTmuxLease(
  owner: ManagedTmuxOwner,
  catalog:
    | {
        readonly id: string;
        readonly inUse: { readonly pid: number } | null;
        readonly control: { readonly instanceId: string } | null;
      }
    | undefined,
) {
  if (
    catalog?.inUse?.pid !== owner.pid ||
    catalog.id !== owner.sessionId ||
    catalog.control?.instanceId !== owner.instanceId
  )
    throw tmuxError(
      "tmux_lease_unverified",
      "NeoPi did not verify the managed tmux owner's session lease. NeoPi v19 cannot verify untitled sessions that are absent from its catalog.",
    );
}

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
  // Managed owners need an interactive TUI with durable native identity, not a startup prompt
  // supplied through positional arguments or a different mode after the option terminator.
  if (input.extra.some((arg) => arg === "--" || arg === "--print"))
    return yield* tmuxError(
      "tmux_launch_failed",
      "NeoPi launch arguments must keep managed sessions interactive.",
    );
  return [
    input.binary,
    "--cwd",
    input.cwd,
    "--no-title",
    ...input.extra,
    ...(input.sessionFile ? ["--session", input.sessionFile] : ["--new-session"]),
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
const isMissingFile = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
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

export const makeManagedTmuxHost = (stateDir: string, executable: string | undefined) => {
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
  const storageError = () =>
    tmuxError(
      "tmux_storage_unavailable",
      "The managed tmux identities could not be read or saved.",
    );
  const read = (file: string) =>
    Effect.tryPromise({
      try: async () => {
        let raw: string;
        try {
          await checkDirectory();
          const path = bindingFile(file);
          const stat = await NodeFSP.lstat(path);
          if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
            throw new Error("Not a private binding");
          raw = await NodeFSP.readFile(path, "utf8");
        } catch (cause) {
          if (isMissingFile(cause)) return undefined;
          throw cause;
        }
        const binding = decodeBinding(raw);
        if (binding.sessionFile !== file || binding.socket !== socket)
          throw new Error("Wrong tmux identity");
        return binding;
      },
      catch: storageError,
    });
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
  const launch = Effect.fnUntraced(function* (input: {
    readonly providerInstanceId: ManagedTmuxBinding["providerInstanceId"];
    readonly profile: string | null;
    readonly binary: string;
    readonly env: Record<string, string>;
    readonly cwd: string;
    readonly sessionFile?: string;
    readonly extra: ReadonlyArray<string>;
    readonly controlEnabled: Effect.Effect<boolean, NeoPiNativeSessionsError>;
    readonly registry: Effect.Effect<string | undefined>;
    readonly canonicalize: (file: string) => Effect.Effect<string, NeoPiNativeSessionsError>;
    readonly readHolderPid: Effect.Effect<number | undefined, NeoPiNativeSessionsError>;
    readonly verifyLease: (
      binding: ManagedTmuxBinding,
    ) => Effect.Effect<void, NeoPiNativeSessionsError>;
  }) {
    if (executable === undefined) return yield* tmuxMissing();
    const argv = yield* managedTmuxLaunchPlan({ ...input, executable });
    if (!(yield* input.controlEnabled)) return yield* unavailable();
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
          if (isMissingFile(cause)) return undefined;
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
        const env = Object.entries(input.env)
          .filter(
            ([key]) =>
              !Object.hasOwn(paneEnvironment, key) &&
              !/^(?:T3CODE_|VITE_|OMP_HOST_)/.test(key) &&
              /^[A-Za-z_][A-Za-z_0-9]*$/.test(key),
          )
          .map(([key, value]) => `export ${key}=${shellQuote(value)}\n`)
          .join("");
        const script = `/bin/rm -f -- ${shellQuote(launchFile)}\n${env}exec ${argv.map(shellQuote).join(" ")}\n`;
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
                const binding = {
                  ...found.success,
                  socket,
                  session,
                  providerInstanceId: input.providerInstanceId,
                  profile: input.profile,
                };
                if (binding.owner.session !== id) return yield* changedOwner();
                yield* input.verifyLease(binding);
                yield* save(binding).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      persisted = true;
                    }),
                  ),
                  Effect.uninterruptible,
                );
                return binding;
              }
              if (
                input.sessionFile &&
                (found.failure.code === "tmux_control_unavailable" ||
                  found.failure.code === "tmux_no_owner")
              ) {
                const pane = yield* readPane(paneTarget).pipe(Effect.option);
                const holder = yield* input.readHolderPid;
                if (holder && (pane._tag === "None" || pane.value.pid !== holder))
                  return yield* sessionInUse();
              }
              if (found.failure.code !== "tmux_control_unavailable") return yield* found.failure;
              yield* Effect.sleep("250 millis");
            }
          }).pipe(Effect.timeoutOption("15 seconds"));
          if (result._tag === "None") return yield* unavailable();
          return result.value;
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
              if (pane.stdout.trim() === id) await run(["-N", "kill-session", "-t", id]);
            }).pipe(Effect.ignore),
    );
  });
  return { read, launch, target };
};
