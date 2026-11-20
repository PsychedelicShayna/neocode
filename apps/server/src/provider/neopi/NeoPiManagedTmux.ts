// @effect-diagnostics nodeBuiltinImport:off -- Unix socket ownership and canonical paths are local OS facts.
import * as NodeChildProcess from "node:child_process";
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
export type ManagedTmuxConfig = typeof Config.Type & { readonly executable: string | undefined };
export const managedTmuxConfig = Effect.fnUntraced(function* (value: string | undefined) {
  if (value === undefined) return undefined;
  const config = decodeConfig(value);
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;
  const resolveExecutable = yield* SpawnExecutableResolution;
  const tmux = platform === "win32" ? undefined : resolveExecutable("tmux", platform, env);
  return { ...config, executable: tmux === undefined ? undefined : NodePath.posix.resolve(tmux) };
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
  requested: { readonly sessionFile: string; readonly profile: string | null },
  pane: ManagedPane,
  entries: ReadonlyArray<{ readonly meta: unknown; readonly snapshot: unknown }>,
): ManagedTmuxOwner {
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
  if (
    meta.sessionFile !== requested.sessionFile ||
    meta.profile !== requested.profile ||
    !meta.sessionId
  )
    throw wrongSession();
  const owner = {
    ...pane,
    instanceId: meta.instanceId,
    imageId: meta.imageId,
    sessionId: meta.sessionId,
  };
  verifyManagedTmuxStatus(owner, requested.sessionFile, snapshot);
  return owner;
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
const readPane = Effect.fnUntraced(function* (config: ManagedTmuxConfig) {
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

export const managedTmuxClient = (config: ManagedTmuxConfig, owner: ManagedTmuxOwner) => ({
  executable: owner.executable,
  args: ["-N", "-S", config.socket, "attach-session", "-E", "-t", owner.session],
});

export const resolveManagedTmuxOwner = Effect.fnUntraced(function* (
  config: ManagedTmuxConfig,
  requested: { readonly sessionFile: string; readonly profile: string | null },
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
    try: () => bindManagedTmuxOwner(requested, pane, candidates),
    catch: (cause) => (isNativeSessionsError(cause) ? cause : unavailable()),
  });
});
