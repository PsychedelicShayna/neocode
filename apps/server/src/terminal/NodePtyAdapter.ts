// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous PID identity reads guard immediately before signaling.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous PID identity reads guard immediately before signaling.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

export class NodePtyModuleLoadError extends Schema.TaggedError<NodePtyModuleLoadError>()(
  "NodePtyModuleLoadError",
  {
    platform: Schema.String,
    architecture: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load node-pty for ${this.platform}-${this.architecture}.`;
  }
}

class NodePtyCancelError extends Schema.TaggedError<NodePtyCancelError>()("NodePtyCancelError", {
  terminalPid: Schema.Number,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to cancel Windows terminal startup for ${this.terminalPid}.`;
  }
}

type NodePtyModuleLoader = () => Promise<typeof import("node-pty")>;

// node-pty's native addon stays external; single-executables need require to resolve disk modules and spawn helpers.
const requireForNodePty = NodeModule.createRequire(import.meta.url);

const loadNodePty: NodePtyModuleLoader = () =>
  Promise.resolve().then(() => requireForNodePty("node-pty") as typeof import("node-pty"));

export const NodePtyModuleLoaderRef = Context.Reference<NodePtyModuleLoader>(
  "server/terminal/NodePtyModuleLoader",
  { defaultValue: () => loadNodePty },
);

type ProcessIdentityReader = (pid: number, platform: NodeJS.Platform) => string | undefined;

const readProcessIdentity: ProcessIdentityReader = (pid, platform) => {
  try {
    if (platform === "linux") {
      const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm is parenthesized and may itself contain spaces and parentheses.
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const parent = fields[1];
      const start = fields[19];
      if (
        fields[0] === "Z" ||
        fields[0] === "X" ||
        parent !== String(process.pid) ||
        !start ||
        !/^\d+$/.test(start)
      )
        return undefined;
      return `${parent}:${start}`;
    }
    const result = NodeChildProcess.spawnSync(
      "/bin/ps",
      ["-p", String(pid), "-o", "ppid=", "-o", "lstart="],
      { encoding: "utf8", timeout: 1_000, maxBuffer: 4_096 },
    );
    if (result.error || result.status !== 0) return undefined;
    const [parent, ...start] = result.stdout.trim().split(/\s+/);
    if (parent !== String(process.pid) || start.length !== 5) return undefined;
    return `${parent}:${start.join(" ")}`;
  } catch {
    return undefined;
  }
};

/** Identity checks run only at spawn/signal time, never on the PTY output path. */
export const NodePtyProcessIdentityReaderRef = Context.Reference<ProcessIdentityReader>(
  "server/terminal/NodePtyProcessIdentityReader",
  { defaultValue: () => readProcessIdentity },
);

let didEnsureSpawnHelperExecutable = false;

const resolveNodePtySpawnHelperPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;

  const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const candidates = [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${platform}-${architecture}`, "spawn-helper"),
  ];

  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}).pipe(Effect.orElseSucceed(() => null));

const ensureNodePtySpawnHelperExecutable = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  if (platform === "win32") return;
  if (didEnsureSpawnHelperExecutable) return;

  const helperPath = yield* resolveNodePtySpawnHelperPath;
  if (!helperPath) return;
  didEnsureSpawnHelperExecutable = true;

  if (!(yield* fs.exists(helperPath))) {
    return;
  }

  yield* fs.chmod(helperPath, 0o755).pipe(Effect.orElseSucceed(() => undefined));
});

// node-pty has no public readiness event; ready_datapipe sets pid before our listener.
// Deferred pipe creation: https://github.com/microsoft/node-pty/pull/885
const waitForWindowsPid = (
  process: import("node-pty").IPty,
  trackedProcess: NodePtyProcess,
  shell: string,
) =>
  Effect.callback<void, PtyAdapter.PtySpawnError>((resume) => {
    const hasPid = () => Number.isInteger(process.pid) && process.pid > 0;
    const failure = (cause: unknown) =>
      Effect.fail(new PtyAdapter.PtySpawnError({ adapter: "node-pty", shell, cause }));

    if (hasPid()) {
      resume(Effect.void);
      return;
    }

    if (!("_socket" in process) || !(process._socket instanceof NodeNet.Socket)) {
      resume(failure(new Error("Windows PTY readiness socket is unavailable.")));
      return;
    }

    const socket = process._socket;
    const onReady = () => {
      cleanup();
      resume(
        hasPid()
          ? Effect.void
          : failure(new Error("Windows PTY became ready without a valid PID.")),
      );
    };
    const onError = (cause: Error) => {
      cleanup();
      resume(failure(cause));
    };
    const onClose = () => onError(new Error("Windows PTY closed before its PID was available."));
    let stopExit = () => {};
    const cleanup = () => {
      socket.off("ready_datapipe", onReady);
      socket.off("error", onError);
      socket.off("close", onClose);
      stopExit();
    };
    socket.once("ready_datapipe", onReady);
    socket.once("error", onError);
    socket.once("close", onClose);
    stopExit = trackedProcess.onExit(({ exitCode }) =>
      onError(
        new Error(`Windows PTY exited before its PID was available (exit code ${exitCode}).`),
      ),
    );
    return Effect.sync(cleanup);
  });

// The private agent cancels pending connections before a child exists; public kill waits for first output.
const killStartingWindowsPty = (process: import("node-pty").IPty) =>
  Effect.try({
    try: () => {
      if (
        "_agent" in process &&
        typeof process._agent === "object" &&
        process._agent !== null &&
        "kill" in process._agent &&
        typeof process._agent.kill === "function"
      ) {
        process._agent.kill();
      } else {
        process.kill();
      }
    },
    catch: (cause) => new NodePtyCancelError({ terminalPid: process.pid, cause }),
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to cancel Windows terminal startup", {
        terminalPid: process.pid,
        cause: error,
      }),
    ),
  );

class NodePtyProcess implements PtyAdapter.PtyProcess {
  private readonly process: import("node-pty").IPty;
  private readonly platform: NodeJS.Platform;
  private readonly identity: string | undefined;
  private readonly readIdentity: ProcessIdentityReader;
  private exitEvent: PtyAdapter.PtyExitEvent | undefined;
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private readonly exitSubscription: import("node-pty").IDisposable;

  constructor(
    process: import("node-pty").IPty,
    platform: NodeJS.Platform,
    readIdentity: ProcessIdentityReader,
  ) {
    this.process = process;
    this.platform = platform;
    this.readIdentity = readIdentity;
    this.identity = platform === "win32" ? undefined : readIdentity(process.pid, platform);
    this.exitSubscription = process.onExit((event) => {
      if (this.exitEvent) return;
      this.exitEvent = { exitCode: event.exitCode, signal: event.signal ?? null };
      this.exitSubscription.dispose();
      for (const listener of this.exitListeners) listener(this.exitEvent);
      this.exitListeners.clear();
    });
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  pause(): void {
    this.process.pause();
  }

  resume(): void {
    this.process.resume();
  }

  kill(signal?: string): void {
    if (this.exitEvent) return;
    if (this.platform !== "win32") {
      const current = this.readIdentity(this.pid, this.platform);
      if (!this.identity || !current || current !== this.identity)
        throw new Error("Refusing to signal a PTY process whose identity is no longer owned.");
    }
    // node-pty terminates the Windows process tree without a POSIX signal.
    this.process.kill(this.platform === "win32" ? undefined : signal);
  }

  onData(callback: (data: string) => void): () => void {
    const disposable = this.process.onData(callback);
    return () => {
      disposable.dispose();
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    if (this.exitEvent) {
      callback(this.exitEvent);
      return () => {};
    }
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  disposeExitSubscription(): void {
    this.exitSubscription.dispose();
    this.exitListeners.clear();
  }
}

const make = Effect.fn("NodePtyAdapter.make")(function* () {
  const loadNodePtyModule = yield* NodePtyModuleLoaderRef;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const readIdentity = yield* NodePtyProcessIdentityReaderRef;

  const nodePty = yield* Effect.tryPromise({
    try: loadNodePtyModule,
    catch: (cause) =>
      new NodePtyModuleLoadError({
        platform,
        architecture,
        cause,
      }),
  }).pipe(Effect.orDie);

  const ensureNodePtySpawnHelperExecutableCached = yield* Effect.cached(
    ensureNodePtySpawnHelperExecutable().pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(HostProcess.Architecture, architecture),
      Effect.orElseSucceed(() => undefined),
    ),
  );

  return PtyAdapter.PtyAdapter.of({
    spawn: Effect.fn("NodePtyAdapter.spawn")(function* (input) {
      yield* ensureNodePtySpawnHelperExecutableCached;
      // ConPTY ignores node-pty's name option for TERM; set it explicitly to avoid missing/16-color values.
      const env =
        platform === "win32" && input.env["TERM"] === undefined
          ? { ...input.env, TERM: "xterm-256color" }
          : input.env;
      const ptyProcess = yield* Effect.try({
        try: () => {
          const nativeProcess = nodePty.spawn(input.shell, input.args ?? [], {
            cwd: input.cwd,
            cols: input.cols,
            rows: input.rows,
            env,
            name: "xterm-256color",
          });
          return {
            nativeProcess,
            process: new NodePtyProcess(nativeProcess, platform, readIdentity),
          };
        },
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "node-pty",
            shell: input.shell,
            cause,
          }),
      });
      if (platform === "win32") {
        yield* waitForWindowsPid(ptyProcess.nativeProcess, ptyProcess.process, input.shell).pipe(
          Effect.onError(() =>
            Effect.sync(() => ptyProcess.process.disposeExitSubscription()).pipe(
              Effect.andThen(killStartingWindowsPty(ptyProcess.nativeProcess)),
            ),
          ),
        );
      }
      return ptyProcess.process;
    }),
  });
});

export const layer = Layer.effect(PtyAdapter.PtyAdapter, make());
