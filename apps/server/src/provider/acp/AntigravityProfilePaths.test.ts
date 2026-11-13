import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodePath from "@effect/platform-node/NodePath";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolveAntigravityInstanceDirectories } from "./AntigravityProfilePaths.ts";

it.effect("keeps saved profiles separate for instance IDs that differ only by case", () =>
  Effect.gen(function* () {
    const first = yield* resolveAntigravityInstanceDirectories(
      "/userdata",
      ProviderInstanceId.make("antigravity"),
    );
    const second = yield* resolveAntigravityInstanceDirectories(
      "/userdata",
      ProviderInstanceId.make("Antigravity"),
    );
    expect(first.profile).toBe(
      "/userdata/providers/antigravity/ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32",
    );
    expect(first.profile.toLowerCase()).not.toBe(second.profile.toLowerCase());
  }).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, NodePath.layerPosix))),
);
