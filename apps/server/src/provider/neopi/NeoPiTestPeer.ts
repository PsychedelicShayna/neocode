import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner, type ChildProcess } from "effect/process";

export type Command = { id?: string; type: string; [key: string]: unknown };
export type Emitter = (frame: unknown) => Effect.Effect<void>;
const decodeCommand = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
export const encodeCommand = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
export const commandArguments = (command: ChildProcess.StandardCommand) =>
  command.args.map((word) => (typeof word === "string" ? word : Redacted.value(word)));
export const defaultReady = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  capabilities: ["rpc-ui"],
};
export const answer = (cmd: Command, emit: Emitter, data: unknown = {}) =>
  emit({ type: "response", id: cmd.id, command: cmd.type, success: true, data });

export const testPeer = Effect.fn("testPeer")(function* (
  handler: (cmd: Command, emit: Emitter) => Effect.Effect<void>,
  ready: unknown = defaultReady,
  startup?: { stdout?: unknown; stderr?: unknown },
  closeOnStdin = false,
  // A stubborn peer ignores every kill and never reports an exit.
  stubborn = false,
) {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const exited = yield* Deferred.make<string | null>();
  const commands: Command[] = [];
  const signals: string[] = [];
  const received = yield* Effect.acquireRelease(Queue.unbounded<void>(), Queue.shutdown);
  const awaitCommand = Effect.fn("NativeTestPeer.awaitCommand")(function* (
    predicate: (command: Command) => boolean,
  ) {
    let command = commands.find(predicate);
    while (command === undefined) {
      yield* Queue.take(received);
      command = commands.find(predicate);
    }
    return command;
  });
  const emit: Emitter = (frame) =>
    Queue.offer(stdout, new TextEncoder().encode(`${JSON.stringify(frame)}\n`)).pipe(Effect.asVoid);
  const finish = Effect.fn("NativeTestPeer.finish")(function* (signal: string | null) {
    yield* Queue.end(stdout).pipe(Effect.ignore);
    yield* Deferred.succeed(exited, signal).pipe(Effect.ignore);
  });
  if (!startup) yield* emit(ready);
  yield* Effect.gen(function* () {
    let pending = "";
    while (true) {
      pending += new TextDecoder().decode(yield* Queue.take(stdin));
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const command = decodeCommand(line) as Command;
        commands.push(command);
        yield* Queue.offer(received, undefined);
        yield* ready === defaultReady && command.type === "negotiate_protocol"
          ? answer(command, emit, { protocolVersion: 2 })
          : handler(command, emit);
      }
    }
  }).pipe(Effect.ignore, Effect.forkScoped);
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    exitCode: Deferred.await(exited).pipe(
      Effect.flatMap((signal) =>
        signal
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "exitCode",
                cause: new Error(`Process interrupted due to receipt of signal: '${signal}'`),
              }),
            )
          : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      ),
    ),
    isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
    kill: (options) =>
      stubborn
        ? Effect.sync(() => {
            signals.push(options?.killSignal ?? "SIGTERM");
          })
        : Effect.gen(function* () {
            signals.push(options?.killSignal ?? "SIGTERM");
            if (options?.forceKillAfter) {
              yield* Effect.sleep(options.forceKillAfter);
              signals.push("SIGKILL");
              yield* finish("SIGKILL");
            } else yield* finish(options?.killSignal ?? "SIGTERM");
          }),
    stdin: Sink.forEach((chunk: Uint8Array) => Queue.offer(stdin, chunk)).pipe(
      Sink.ensuring(closeOnStdin ? finish(null) : Effect.void),
    ),
    stdout: startup
      ? startup.stdout === undefined
        ? Stream.empty
        : Stream.make(new TextEncoder().encode(`${encodeCommand(startup.stdout)}\n`))
      : Stream.fromQueue(stdout),
    stderr:
      startup?.stderr === undefined
        ? Stream.empty
        : Stream.make(new TextEncoder().encode(`${encodeCommand(startup.stderr)}\n`)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
  return { handle, commands, emit, finish, signals, awaitCommand };
});
