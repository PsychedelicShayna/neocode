// @effect-diagnostics nodeBuiltinImport:off -- own captured subprocess handles, never PID discovery.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { ProviderInstanceId, PositiveInt } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import { ServerConfig } from "../../config.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import {
  neoPiSessionCatalogSource,
  type NeoPiSessionCatalogSource,
} from "./NeoPiSessionCatalogSource.ts";
import { NeoPiRuntimeError } from "./NeoPiRuntimeError.ts";

interface Dashboard {
  readonly origin: string;
  readonly token: string;
  readonly source: NeoPiSessionCatalogSource;
  readonly close: Effect.Effect<void>;
  readonly alive: () => boolean;
}

interface DashboardEntry {
  readonly source: NeoPiSessionCatalogSource;
  readonly opening: Fiber.Fiber<Dashboard, NeoPiRuntimeError>;
  users: number;
  idle: Fiber.Fiber<void> | undefined;
}

const STATS_IDLE_DEBOUNCE = "30 seconds";

const decodeReady = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("neopi_stats_ready"),
      version: Schema.Literal(1),
      port: PositiveInt.check(Schema.isLessThanOrEqualTo(65535)),
    }),
  ),
);

const statsError = (cause: unknown) =>
  cause instanceof NeoPiRuntimeError
    ? cause
    : new NeoPiRuntimeError({
        code: "startup",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const launch = (source: NeoPiSessionCatalogSource, cwd: string) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const token = NodeCrypto.randomBytes(32).toString("hex");
      const child = yield* Effect.try({
        try: () =>
          NodeChildProcess.spawn(source.binary, ["stats", "--headless"], {
            cwd,
            env: { ...process.env, ...source.env, NEOPI_STATS_HOST_TOKEN: token },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }),
        catch: statsError,
      });
      let closed = false;
      const exited = new Promise<void>((done) => child.once("close", () => done()));
      const readiness = new Promise<string>((resolve, reject) => {
        let output = "";
        let settled = false;
        child.once("error", () => {
          settled = true;
          reject(
            new NeoPiRuntimeError({
              code: "spawn",
              message: "Could not launch the configured NeoPi stats executable.",
            }),
          );
        });
        child.once("close", () => {
          if (!settled) {
            settled = true;
            reject(
              new NeoPiRuntimeError({
                code: "startup",
                message:
                  "NeoPi stats exited before readiness. Update NeoPi for hosted stats support.",
              }),
            );
          }
        });
        child.stderr.resume();
        child.stdout.on("data", (chunk: Buffer) => {
          if (settled) return;
          output += chunk.toString("utf8");
          if (output.length > 16384) {
            settled = true;
            reject(
              new NeoPiRuntimeError({
                code: "startup",
                message: "Invalid NeoPi stats readiness response.",
              }),
            );
            return;
          }
          const newline = output.indexOf("\n");
          if (newline < 0) return;
          settled = true;
          try {
            const value = decodeReady(output.slice(0, newline));
            resolve(`http://127.0.0.1:${value.port}`);
          } catch (cause) {
            reject(
              new NeoPiRuntimeError({
                code: "startup",
                message: "Invalid NeoPi stats readiness response.",
                cause,
              }),
            );
          }
        });
      });
      const close = yield* Effect.cached(
        Effect.gen(function* () {
          closed = true;
          child.stdin.end();
          yield* Effect.sync(() => {
            child.kill("SIGTERM");
          }).pipe(Effect.delay("2 seconds"), Effect.forkScoped({ uninterruptible: false }));
          yield* Effect.sync(() => {
            child.kill("SIGKILL");
          }).pipe(Effect.delay("5 seconds"), Effect.forkScoped({ uninterruptible: false }));
          yield* Effect.promise(() => exited);
        }).pipe(Effect.scoped, Effect.uninterruptible),
      );
      const origin = yield* restore(
        Effect.tryPromise({
          try: () => readiness,
          catch: statsError,
        }).pipe(
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () =>
              Effect.fail(
                new NeoPiRuntimeError({
                  code: "startup",
                  message:
                    "NeoPi stats did not become ready. Update NeoPi for hosted stats support.",
                }),
              ),
          }),
        ),
      ).pipe(Effect.onError(() => close));
      return {
        origin,
        token,
        source,
        close,
        alive: () => child.exitCode === null && child.signalCode === null && !closed,
      } satisfies Dashboard;
    }),
  );

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const config = yield* ServerConfig;
  const lifetime = yield* Effect.scope;
  const dashboards = new Map<string, DashboardEntry>();
  const launches = yield* Semaphore.make(1);
  const stop = Effect.fnUntraced(function* (entry: DashboardEntry) {
    const idle = entry.idle;
    entry.idle = undefined;
    if (idle) yield* Fiber.interrupt(idle);
    // A cancelled bootstrap still owns its startup. Interrupting it runs
    // launch's captured-child cleanup rather than waiting for readiness.
    yield* Fiber.interrupt(entry.opening);
    const result = yield* Fiber.await(entry.opening);
    if (result._tag === "Success") yield* result.value.close;
  });
  const discard = Effect.fnUntraced(function* (key: string, expected?: DashboardEntry) {
    const entry = yield* launches.withPermits(1)(
      Effect.sync(() => {
        const current = dashboards.get(key);
        if (expected !== undefined && current !== expected) return;
        dashboards.delete(key);
        return current;
      }),
    );
    if (entry) yield* stop(entry);
  }, Effect.uninterruptible);
  yield* Effect.addFinalizer(() =>
    Effect.forEach(Array.from(dashboards.keys()), (key) => discard(key), { discard: true }),
  );
  const changes = yield* registry.subscribeChanges;
  yield* Effect.gen(function* () {
    yield* PubSub.take(changes);
    const sources = new Set((yield* registry.listInstances).map(neoPiSessionCatalogSource));
    yield* Effect.forEach(
      Array.from(dashboards),
      ([key, entry]) => (sources.has(entry.source) ? Effect.void : discard(key, entry)),
      { discard: true },
    );
  }).pipe(Effect.forever, Effect.forkScoped);
  const acquire = Effect.fn("NeoPiStats.acquire")(function* (
    instanceId: string,
    viewId: string,
    sessionId: string,
    bootstrap: boolean,
  ) {
    const instance = yield* registry.getInstance(ProviderInstanceId.make(instanceId));
    const source = instance && neoPiSessionCatalogSource(instance);
    if (!source)
      return yield* new NeoPiRuntimeError({
        code: "not_ready",
        message: "The selected NeoPi runtime is unavailable.",
      });
    const key = `${sessionId}/${instanceId}/${viewId}`;
    // Register the lease before awaiting readiness. Otherwise a disconnected
    // /embed request leaves an ownerless launch outside every release path.
    const entry = yield* Effect.acquireRelease(
      launches.withPermits(1)(
        Effect.gen(function* () {
          let current = dashboards.get(key);
          if (!current) {
            if (!bootstrap)
              return yield* new NeoPiRuntimeError({
                code: "closed",
                message: "This stats view has closed. Reopen Stats.",
              });
            const opening = yield* launch(source, config.cwd).pipe(
              Effect.forkIn(lifetime, { startImmediately: false, uninterruptible: false }),
            );
            current = { source, opening, users: 0, idle: undefined };
            dashboards.set(key, current);
          }
          current.users++;
          if (current.idle) {
            const idle = current.idle;
            current.idle = undefined;
            yield* Fiber.interrupt(idle);
          }
          return current;
        }),
      ),
      (current) =>
        launches.withPermits(1)(
          Effect.gen(function* () {
            current.users--;
            if (current.users !== 0 || dashboards.get(key) !== current) return;
            current.idle = yield* Effect.gen(function* () {
              if (current.users !== 0 || dashboards.get(key) !== current) return;
              dashboards.delete(key);
              current.idle = undefined;
              yield* stop(current);
            }).pipe(
              Effect.uninterruptible,
              Effect.delay(STATS_IDLE_DEBOUNCE),
              Effect.forkIn(lifetime, { uninterruptible: false }),
            );
          }),
        ),
    );
    const dashboard = yield* Fiber.join(entry.opening).pipe(
      Effect.tapError(() => discard(key, entry)),
    );
    if (dashboards.get(key) !== entry || dashboard.source !== source || !dashboard.alive()) {
      yield* discard(key, entry);
      return yield* new NeoPiRuntimeError({
        code: "closed",
        message: "The NeoPi runtime changed or stopped. Reopen Stats.",
      });
    }
    return dashboard;
  });
  const release = (instanceId: string, viewId: string, sessionId: string) =>
    discard(`${sessionId}/${instanceId}/${viewId}`);
  return { acquire, release };
});

export class NeoPiStatsService extends Context.Service<
  NeoPiStatsService,
  Effect.Success<typeof make>
>()("t3/provider/neopi/NeoPiStatsService") {
  static readonly layer = Layer.effect(NeoPiStatsService, make);
}
