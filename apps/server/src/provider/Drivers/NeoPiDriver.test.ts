import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  makeNativeAdapterHarness,
  instanceId,
  modelSelection,
  threadId,
} from "../neopi/NeoPiAdapterTestHarness.ts";
import { neoPiSessionCatalogSource } from "../neopi/NeoPiSessionCatalogSource.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import { NeoPiDriver } from "./NeoPiDriver.ts";

const testLayer = ProviderHostLive.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(McpSessionRegistryTestkit.layerNative),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-neopi-driver-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
      ),
    ),
  ),
);

it.layer(testLayer)("NeoPiDriver", (it) => {
  it.effect(
    "marks a configured missing binary unavailable without falling back to npi on PATH",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* NeoPiDriver.create({
            instanceId: ProviderInstanceId.make("neopi-missing"),
            displayName: "NeoPi/OMP",
            enabled: true,
            environment: [],
            config: {
              ...NeoPiDriver.defaultConfig(),
              binaryPath: "/nonexistent/t3-neopi-cli",
              enabled: true,
            },
          });
          const snapshot = yield* instance.snapshot.refresh;
          expect(snapshot.installed).toBe(false);
          expect(snapshot.status).toBe("error");
          expect(snapshot.message).toContain("/nonexistent/t3-neopi-cli");
          expect(snapshot.displayName).toBe("NeoPi/OMP");
        }),
      ),
  );
});

it.live("uses the configured executable and profile for probing and a real V2 session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const native = yield* makeNativeAdapterHarness([
        "session_catalog",
        "session_history_identity",
      ]);
      const binary = `${native.home}/configured NeoPi`;
      const profile = "personal profile";
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command))
            throw new Error("Expected a standard command");
          if (command.command !== binary || command.options.env?.OMP_PROFILE !== profile) {
            throw new Error("The configured executable and profile are required");
          }
          if (command.args[0] === "--version") {
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(123),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.make(new TextEncoder().encode("npi v1.2.3\n")),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            });
          }
          return yield* native.spawn(command);
        }),
      );
      yield* Effect.gen(function* () {
        const instance = yield* NeoPiDriver.create({
          instanceId,
          displayName: "Configured NeoPi",
          enabled: true,
          environment: [],
          config: { ...NeoPiDriver.defaultConfig(), binaryPath: binary, profile, enabled: true },
        });
        expect((yield* instance.snapshot.refresh).status).toBe("ready");
        const source = neoPiSessionCatalogSource(instance);
        if (!source?.configuration) throw new Error("Missing native configuration reader");
        expect(source.probe.status).toBe("compatible");
        expect(source.capabilities.has("session_catalog")).toBe(true);
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const session = yield* instance.orchestrationAdapter
          .openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("configured-native-session"),
            modelSelection,
            runtimePolicy: native.policy,
          })
          .pipe(Effect.provideService(Scope.Scope, scope));
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: native.policy,
        });
        yield* session.startTurn(native.turn(providerThread, "Verify configured native execution"));
        const updates = yield* session.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.nativeMetadata?.neopiResumeCursor !== undefined,
          ),
          Stream.take(1),
          Stream.runCollect,
        );
        const update = updates[0];
        if (update?.type !== "provider_thread.updated")
          throw new Error("Missing native binding update");
        const cursor = update.providerThread.nativeMetadata?.neopiResumeCursor;
        if (!cursor) throw new Error("Missing native cursor");
        const configuration = yield* source.configuration(threadId, cursor);
        expect(configuration.status).toBe("available");
        if (configuration.status !== "available") throw new Error(configuration.reason);
        expect(configuration.sessionId).toBe(native.native().id);
        expect(configuration.providerInstanceId).toBe(instanceId);
        expect(configuration.model?.id).toBe("test");
        expect(native.prompts).toEqual(["Verify configured native execution"]);
        yield* native.complete("Configured native execution complete");
        yield* session.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* Scope.close(scope, Exit.void);
        expect((yield* source.configuration(threadId, cursor)).status).toBe("unavailable");
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    }),
  ).pipe(Effect.provide(testLayer)),
);
