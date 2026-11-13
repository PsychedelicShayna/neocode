import * as HostProcess from "@t3tools/shared/HostProcess";
import type { CodexHistorySettings } from "./legacyHistorySettings.ts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

/** Locate old transcripts without preparing credentials or launching their runtimes. */
export const resolveLegacyCodexHome = Effect.fn("resolveLegacyCodexHome")(function* (
  config: CodexHistorySettings,
) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const configured = config.homePath.trim();
  return path.resolve(configured ? expandHomePath(configured, home) : path.join(home, ".codex"));
});
