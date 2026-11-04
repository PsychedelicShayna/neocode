import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeNeoPiConfigurationConnections } from "./NeoPiModelsConnection.ts";

const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      type: Schema.String,
    }),
  ),
);

it.live(
  "owns real no-session configuration connections by cwd and disposes their shared lifetime",
  () =>
    Effect.gen(function* () {
      const owner = yield* Scope.make();
      const launches: Array<{
        command: string;
        args: readonly string[];
        cwd: unknown;
        env: unknown;
      }> = [];
      let disposals = 0;
      const connection = yield* makeNeoPiConfigurationConnections({
        binary: "/configured/npi",
        profile: "selected-profile",
        environment: { PATH: "/configured/bin", OMP_PROFILE: "ambient-profile" },
        launchArgs: '--extension "./configuration extension.ts"',
        spawn: (command) =>
          Effect.gen(function* () {
            if (!ChildProcess.isStandardCommand(command))
              throw new Error("Expected a standard command");
            launches.push({
              command: command.command,
              args: command.args,
              cwd: command.options.cwd,
              env: command.options.env,
            });
            const outbound = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
            const done = yield* Deferred.make<void>();
            yield* Queue.offer(
              outbound,
              new TextEncoder().encode(
                JSON.stringify({
                  type: "ready",
                  protocolVersion: 1,
                  supportedProtocolVersions: [1],
                  capabilities: ["models_configuration"],
                }) + "\n",
              ),
            );
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                disposals++;
              }),
            );
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(999),
              exitCode: Deferred.await(done).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              isRunning: Deferred.isDone(done).pipe(Effect.map((finished) => !finished)),
              kill: () =>
                Effect.gen(function* () {
                  yield* Queue.end(outbound).pipe(Effect.ignore);
                  yield* Deferred.succeed(done, undefined);
                }),
              stdin: Sink.forEach((bytes: Uint8Array) =>
                Effect.gen(function* () {
                  const frame = decode(new TextDecoder().decode(bytes));
                  yield* Queue.offer(
                    outbound,
                    new TextEncoder().encode(
                      JSON.stringify({
                        type: "response",
                        id: frame.id,
                        command: frame.type,
                        success: true,
                        data: { cwd: command.options.cwd },
                      }) + "\n",
                    ),
                  );
                }),
              ),
              stdout: Stream.fromQueue(outbound),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            });
          }),
      }).pipe(Effect.provideService(Scope.Scope, owner));
      yield* Effect.gen(function* () {
        const first = yield* connection("/project/a");
        const second = yield* connection("/project/a");
        const other = yield* connection("/project/b");
        assert.strictEqual(first, second);
        assert.notStrictEqual(first, other);
        assert.deepEqual(yield* first.request({ type: "get_models_configuration" }), {
          cwd: "/project/a",
        });
        assert.equal(first.capabilities.has("models_configuration"), true);
        assert.equal(launches.length, 2);
        for (const [index, launch] of launches.entries()) {
          assert.equal(launch.command, "/configured/npi");
          assert.equal(launch.cwd, index === 0 ? "/project/a" : "/project/b");
          assert.deepEqual(launch.env, {
            PATH: "/configured/bin",
            OMP_PROFILE: "selected-profile",
          });
          assert.equal(launch.args.includes("--no-session"), true);
          assert.equal(launch.args.includes("--no-tools"), true);
          assert.equal(launch.args.includes("--session"), false);
          assert.equal(launch.args.includes("--new-session"), false);
          assert.deepEqual(launch.args.slice(-2), ["--extension", "./configuration extension.ts"]);
        }
        assert.equal(disposals, 0);
      }).pipe(Effect.scoped, Effect.ensuring(Scope.close(owner, Exit.void)));
      assert.equal(disposals, 2);
    }),
);
