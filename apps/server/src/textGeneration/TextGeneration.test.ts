import { it } from "@effect/vitest";
import {
  DEFAULT_TEXT_GENERATION_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";
import * as TextGenerators from "./TextGenerators.ts";

const unexpectedExecution = () => Effect.die("Unexpected runtime execution in text routing test");

function fixtureInstance(
  snapshot: ServerProvider,
  textGeneration: TextGeneration.TextGeneration["Service"],
): ProviderInstance {
  return {
    instanceId: snapshot.instanceId,
    driverKind: snapshot.driver,
    continuationIdentity: { driverKind: snapshot.driver, continuationKey: snapshot.instanceId },
    displayName: undefined,
    enabled: true,
    snapshot: {
      getSnapshot: Effect.succeed(snapshot),
      refresh: Effect.succeed(snapshot),
      streamChanges: Stream.empty,
      applyUsageLimits: unexpectedExecution,
    },
    orchestrationAdapter: ProviderAdapterV2.of({
      instanceId: snapshot.instanceId,
      driver: snapshot.driver,
      getCapabilities: unexpectedExecution,
      planSelectionTransition: unexpectedExecution,
      openSession: unexpectedExecution,
    }),
    textGeneration,
  };
}

const readySnapshot = (instanceId: ProviderInstanceId): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make("neopi"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  version: null,
  checkedAt: "1970-01-01T00:00:00Z",
  models: [],
  slashCommands: [],
  skills: [],
});

const serviceWith = (
  instances: ReadonlyArray<ProviderInstance>,
  runner: TextGenerators.TextGenerators["Service"]["runner"] = () => Effect.undefined,
) =>
  TextGeneration.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          listInstances: Effect.succeed(instances),
          getInstance: (id) =>
            Effect.succeed(instances.find((instance) => instance.instanceId === id)),
        }),
        ServerSettings.layerTest({
          providerInstances: Object.fromEntries(
            instances.map((instance) => [
              instance.instanceId,
              { driver: instance.driverKind, enabled: true, config: {} },
            ]),
          ),
        }),
        Layer.mock(TextGenerators.TextGenerators)({ runner }),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: unexpectedExecution,
        }),
      ),
    ),
  );

it.effect.each([
  "ready",
  "pending",
  "exhausted",
  "not installed",
  "signed out",
  "signed out, fallback failed",
] as const)("text generation preflight: %s", (primaryState) =>
  Effect.gen(function* () {
    const primary = ProviderInstanceId.make("neopi-primary");
    const fallback = ProviderInstanceId.make("neopi-fallback");
    const selection = {
      instanceId: primary,
      model: "anthropic/chat-model",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    const calls: ModelSelection[] = [];
    const instances = [primary, fallback].map((instanceId) => {
      const snapshot: ServerProvider = {
        ...readySnapshot(instanceId),
        ...(primaryState === "pending" && instanceId === primary
          ? { installed: false, status: "warning", auth: { status: "unknown" } }
          : {}),
        ...(primaryState === "not installed" && instanceId === primary
          ? { installed: false, status: "error", auth: { status: "unknown" } }
          : {}),
        ...(primaryState.startsWith("signed out") && instanceId === primary
          ? { status: "error", auth: { status: "unauthenticated" } }
          : {}),
        ...(primaryState === "signed out, fallback failed" && instanceId === fallback
          ? { status: "error", auth: { status: "unknown" } }
          : {}),
        ...(primaryState === "exhausted" && instanceId === primary
          ? {
              usageLimits: {
                checkedAt: "1970-01-01T00:00:00Z",
                windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 100 }],
              },
            }
          : {}),
      };
      return fixtureInstance(
        snapshot,
        TextGeneration.TextGeneration.of({
          generateCommitMessage: unexpectedExecution,
          generatePrContent: unexpectedExecution,
          generateBranchName: unexpectedExecution,
          generateReviewGuide: unexpectedExecution,
          generateTranscriptionPostProcessing: unexpectedExecution,
          generateThreadTitle: (input) =>
            Effect.sync(() => {
              calls.push(input.modelSelection);
              return { title: "Generated title" };
            }),
        }),
      );
    });
    const service = yield* serviceWith(instances);
    expect(
      yield* service.generateThreadTitle({
        cwd: "/tmp",
        message: "hello",
        linkedContext: "",
        modelSelection: selection,
      }),
    ).toEqual({ title: "Generated title" });
    expect(calls).toEqual([
      primaryState === "ready" ||
      primaryState === "pending" ||
      primaryState === "signed out, fallback failed"
        ? selection
        : { instanceId: fallback, model: DEFAULT_TEXT_GENERATION_MODEL },
    ]);
  }),
);

it.effect(
  "a review guide aimed at a text generator falls back to a native agent that can read the checkout",
  () =>
    Effect.gen(function* () {
      const native = ProviderInstanceId.make("neopi-review");
      const calls: ModelSelection[] = [];
      const instance = fixtureInstance(
        readySnapshot(native),
        TextGeneration.TextGeneration.of({
          generateCommitMessage: unexpectedExecution,
          generatePrContent: unexpectedExecution,
          generateBranchName: unexpectedExecution,
          generateThreadTitle: unexpectedExecution,
          generateTranscriptionPostProcessing: unexpectedExecution,
          generateReviewGuide: (input) =>
            Effect.sync(() => {
              calls.push(input.modelSelection);
              return { stops: [] };
            }),
        }),
      );
      const runner: TextGenerators.TextGenerators["Service"]["runner"] = (id) =>
        Effect.succeed(id === "openrouter" ? unexpectedExecution : undefined);
      const input = {
        cwd: "/tmp",
        number: 1,
        title: "Change",
        description: "",
        baseBranch: "main",
        baseCommit: "abc",
        settledReview: "",
        modelSelection: { instanceId: ProviderInstanceId.make("openrouter"), model: "some/model" },
      };
      yield* (yield* serviceWith([instance], runner)).generateReviewGuide(input);
      expect(calls.map((selection) => selection.instanceId)).toEqual([native]);
      const failure = yield* (yield* serviceWith([], runner))
        .generateReviewGuide(input)
        .pipe(Effect.flip);
      expect(failure._tag).toBe("TextGenerationError");
      expect(failure.operation).toBe("generateReviewGuide");
    }),
);
