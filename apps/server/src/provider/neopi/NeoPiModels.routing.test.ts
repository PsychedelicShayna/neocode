import { assert, it } from "@effect/vitest";
import {
  NeoPiNativeSessionsError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type NeoPiModelsTarget,
  type NeoPiNativeSessionRef,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { makeNeoPiModels } from "./NeoPiModels.ts";
import type { NeoPiModelsConnection } from "./NeoPiModelsConnection.ts";
import { registerNeoPiSessionCatalogSource } from "./NeoPiSessionCatalogSource.ts";

const instanceId = ProviderInstanceId.make("models-native");
const projectId = ProjectId.make("models-project");
const native: NeoPiModelsConnection = {
  capabilities: new Set(["models_configuration"]),
  request: () => Effect.die("Routing must not send a native command"),
  respondUi: () => Effect.void,
  validate: Effect.void,
  ui: Stream.empty,
  changes: Stream.empty,
};

const fixture = Effect.gen(function* () {
  const configurationCwds: string[] = [];
  const ownerRefs: NeoPiNativeSessionRef[] = [];
  const instance = registerNeoPiSessionCatalogSource(
    {
      instanceId,
      driverKind: ProviderDriverKind.make("neopi"),
      enabled: true,
    } as ProviderInstance,
    {
      binary: "/configured/npi",
      env: {},
      profile: "configured",
      capabilities: new Set(["models_configuration"]),
      probe: { status: "compatible", version: "fixture" },
      modelsConnection: (cwd) =>
        Effect.sync(() => {
          configurationCwds.push(cwd);
          return native;
        }),
    },
  );
  const layer = Layer.mergeAll(
    Layer.mock(ProviderInstanceRegistry)({
      getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getProjectShellById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({ workspaceRoot: "/project-configuration" } as OrchestrationProjectShell)
            : Option.none(),
        ),
    }),
    Layer.mock(ServerConfig)({ cwd: "/global-configuration" }),
  );
  const service = yield* makeNeoPiModels((ref) => {
    ownerRefs.push(ref);
    return ref.sessionFile === "/connected/native.jsonl"
      ? Effect.succeed(native)
      : Effect.fail(
          new NeoPiNativeSessionsError({
            code: "closed",
            message: "Open this native session first.",
          }),
        );
  }).pipe(Effect.provide(layer));
  return { service, configurationCwds, ownerRefs };
});

it.effect("routes global and project Models to scoped configuration cwd, not a SQL session", () =>
  Effect.gen(function* () {
    const { service, configurationCwds, ownerRefs } = yield* fixture;
    assert.strictEqual(yield* service.connection({ providerInstanceId: instanceId }), native);
    assert.strictEqual(
      yield* service.connection({ providerInstanceId: instanceId, projectId }),
      native,
    );
    assert.deepEqual(configurationCwds, ["/global-configuration", "/project-configuration"]);
    assert.deepEqual(ownerRefs, []);
    const missing = yield* Effect.result(
      service.connection({ providerInstanceId: instanceId, projectId: ProjectId.make("missing") }),
    );
    assert.equal(missing._tag, "Failure");
    assert.equal(configurationCwds.length, 2);
  }).pipe(Effect.scoped),
);

it.effect(
  "uses only the already connected native owner and never falls back to configuration",
  () =>
    Effect.gen(function* () {
      const { service, configurationCwds, ownerRefs } = yield* fixture;
      const ref = { providerInstanceId: instanceId, sessionFile: "/connected/native.jsonl" };
      assert.strictEqual(yield* service.connection({ ...ref, projectId }), native);
      const closed = yield* Effect.result(
        service.connection({ ...ref, sessionFile: "/closed/native.jsonl" }),
      );
      assert.equal(closed._tag, "Failure");
      assert.deepEqual(ownerRefs, [ref, { ...ref, sessionFile: "/closed/native.jsonl" }]);
      assert.deepEqual(configurationCwds, []);
    }).pipe(Effect.scoped),
);

it.effect(
  "rejects a stale SQL thread target rather than mutating global or native configuration",
  () =>
    Effect.gen(function* () {
      const { service, configurationCwds, ownerRefs } = yield* fixture;
      const stale = {
        providerInstanceId: instanceId,
        threadId: "archived-thread",
      } as NeoPiModelsTarget;
      const result = yield* Effect.result(service.connection(stale));
      assert.equal(result._tag, "Failure");
      assert.deepEqual(configurationCwds, []);
      assert.deepEqual(ownerRefs, []);
    }).pipe(Effect.scoped),
);
