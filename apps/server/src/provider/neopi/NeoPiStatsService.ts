// @effect-diagnostics nodeBuiltinImport:off -- own captured subprocess handles, never PID discovery.
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import { ProviderInstanceId, PositiveInt } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import { ServerConfig } from "../../config.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { neoPiSessionCatalogSource, type NeoPiSessionCatalogSource } from "./NeoPiSessionCatalogSource.ts";

interface Dashboard {
  readonly origin: string;
  readonly token: string;
  readonly source: NeoPiSessionCatalogSource;
  readonly close: () => Promise<void>;
  readonly alive: () => boolean;
  users: number;
  idle: ReturnType<typeof setTimeout> | undefined;
}

const decodeReady = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
  type: Schema.Literal("neopi_stats_ready"),
  version: Schema.Literal(1),
  port: PositiveInt.check(Schema.isLessThanOrEqualTo(65535)),
})));

const launch = (source: NeoPiSessionCatalogSource, cwd: string) =>
  new Promise<Dashboard>((resolve, reject) => {
    const token = Crypto.randomBytes(32).toString("hex");
    const child = ChildProcess.spawn(source.binary, ["stats", "--headless"], {
      cwd, env: { ...process.env, ...source.env, NEOPI_STATS_HOST_TOKEN: token },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let output = "";
    let ready = false;
    let closed = false;
    const exited = new Promise<void>((done) => child.once("close", () => done()));
    const close = async () => {
      if (closed) return exited;
      closed = true;
      child.stdin.end();
      const kill = setTimeout(() => { child.kill("SIGTERM"); }, 2000);
      const force = setTimeout(() => { child.kill("SIGKILL"); }, 5000);
      try { await exited; } finally { clearTimeout(kill); clearTimeout(force); }
    };
    const timeout = setTimeout(() => {
      reject(new Error("NeoPi stats did not become ready. Update NeoPi for hosted stats support."));
      void close();
    }, 30_000);
    child.once("error", () => { clearTimeout(timeout); reject(new Error("Could not launch the configured NeoPi stats executable.")); });
    child.once("close", () => {
      clearTimeout(timeout);
      if (!ready) reject(new Error("NeoPi stats exited before readiness. Update NeoPi for hosted stats support."));
    });
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      if (ready) return;
      output += chunk.toString("utf8");
      if (output.length > 16384) { reject(new Error("Invalid NeoPi stats readiness response.")); void close(); return; }
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      try {
        const value = decodeReady(output.slice(0, newline));
        ready = true;
        clearTimeout(timeout);
        resolve({ origin: `http://127.0.0.1:${value.port}`, token, source, close,
          alive: () => child.exitCode === null && child.signalCode === null && !closed,
          users: 0, idle: undefined });
      } catch { reject(new Error("Invalid NeoPi stats readiness response.")); void close(); }
    });
  });

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const config = yield* ServerConfig;
  const dashboards = new Map<string, Promise<Dashboard>>();
  const discard = async (key: string) => {
    const pending = dashboards.get(key);
    dashboards.delete(key);
    const dashboard = await pending?.catch(() => undefined);
    if (dashboard) { clearTimeout(dashboard.idle); await dashboard.close(); }
  };
  yield* Effect.addFinalizer(() => Effect.promise(async () => {
    await Promise.all(Array.from(dashboards.keys(), discard));
  }));
  const changes = yield* registry.subscribeChanges;
  yield* Effect.gen(function* () {
    yield* PubSub.take(changes);
    const sources = new Set((yield* registry.listInstances).map(neoPiSessionCatalogSource));
    yield* Effect.promise(async () => {
      await Promise.all(Array.from(dashboards, async ([key, pending]) => {
        const dashboard = await pending.catch(() => undefined);
        if (dashboard && !sources.has(dashboard.source)) await discard(key);
      }));
    });
  }).pipe(Effect.forever, Effect.forkScoped);
  const acquire = Effect.fn("NeoPiStats.acquire")(function* (instanceId: string, viewId: string, sessionId: string, bootstrap: boolean) {
    const instance = yield* registry.getInstance(ProviderInstanceId.make(instanceId));
    const source = instance && neoPiSessionCatalogSource(instance);
    if (!source) return yield* Effect.fail(new Error("The selected NeoPi runtime is unavailable."));
    const key = `${sessionId}/${instanceId}/${viewId}`;
    let pending = dashboards.get(key);
    if (!pending) {
      if (!bootstrap) return yield* Effect.fail(new Error("This stats view has closed. Reopen Stats."));
      pending = launch(source, config.cwd);
      dashboards.set(key, pending);
      void pending.catch(() => { if (dashboards.get(key) === pending) dashboards.delete(key); });
    }
    const opening = pending;
    const dashboard = yield* Effect.tryPromise({ try: () => opening, catch: (error) => error });
    if (dashboard.source !== source || !dashboard.alive()) {
      yield* Effect.promise(() => discard(key));
      return yield* Effect.fail(new Error("The NeoPi runtime changed or stopped. Reopen Stats."));
    }
    dashboard.users++;
    clearTimeout(dashboard.idle);
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      dashboard.users--;
      if (dashboard.users === 0 && dashboards.get(key) === opening) {
        dashboard.idle = setTimeout(() => {
          if (dashboards.get(key) === opening) void discard(key);
        }, 60_000);
      }
    }));
    return dashboard;
  });
  const release = (instanceId: string, viewId: string, sessionId: string) =>
    Effect.promise(() => discard(`${sessionId}/${instanceId}/${viewId}`));
  return { acquire, release };
});

export class NeoPiStatsService extends Context.Service<NeoPiStatsService, Effect.Success<typeof make>>() (
  "t3/provider/neopi/NeoPiStatsService",
) {
  static readonly layer = Layer.effect(NeoPiStatsService, make);
}
