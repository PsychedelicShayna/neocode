import * as NodeOS from "node:os";
import type { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Path from "effect/Path";
import { expandHomePath } from "../pathExpansion.ts";

/** Locate old transcripts without preparing credentials or launching their runtimes. */
export const resolveLegacyCodexHome = Effect.fn("resolveLegacyCodexHome")(function* (
  config: CodexSettings,
) {
  const path = yield* Path.Path;
  return path.resolve(config.homePath.trim() ? expandHomePath(config.homePath) : path.join(NodeOS.homedir(), ".codex"));
});

export const legacyAntigravityDirectories = Effect.fn("legacyAntigravityDirectories")(
  function* (stateDir: string, instanceId: ProviderInstanceId) {
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;
    const key = Encoding.encodeHex(yield* crypto.digest("SHA-256", new TextEncoder().encode(instanceId)));
    return {
      profile: path.join(stateDir, "providers", "antigravity", key),
      runtimeTemp: path.join(stateDir, "antigravity-tmp", key.slice(0, 12)),
    };
  },
);
