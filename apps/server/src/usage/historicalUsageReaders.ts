import { ProviderDriverKind } from "@t3tools/contracts";
import type { AnyProviderDriver, ProviderDriver } from "@t3tools/provider-core/server/driver";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import {
  antigravityUsageReader,
  type AntigravityUsage,
} from "../provider/Drivers/AntigravityUsage.ts";
import { claudeUsageReader } from "../provider/Drivers/claudeUsage.ts";
import { codexUsageReader } from "../provider/Drivers/codexUsage.ts";
import { grokUsageReader } from "../provider/Drivers/grokUsage.ts";
import { openCodeUsageReader } from "../provider/Drivers/opencodeUsage.ts";
import { PiHistorySettings, piUsageReader } from "../provider/Drivers/piUsage.ts";
import type { CodexUsageHistory } from "./CodexUsageHistory.ts";
import {
  ClaudeHistorySettings,
  CodexHistorySettings,
  OpaqueHistorySettings,
} from "../provider/legacyHistorySettings.ts";

export type HistoricalUsageReadersEnv =
  | FileSystem.FileSystem
  | Path.Path
  | AntigravityUsage
  | CodexUsageHistory;

export type HistoricalUsageReader<Config> = Pick<
  ProviderDriver<Config>,
  "driverKind" | "configSchema"
>;

type HistoricalUsageSource = Pick<
  AnyProviderDriver<never, HistoricalUsageReadersEnv>,
  "driverKind" | "configSchema" | "usage"
>;

// Historical schemas/readers never register or instantiate execution drivers.
export const HISTORICAL_USAGE_READERS: ReadonlyArray<HistoricalUsageSource> = [
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    configSchema: ClaudeHistorySettings,
    usage: claudeUsageReader,
  },
  {
    driverKind: ProviderDriverKind.make("codex"),
    configSchema: CodexHistorySettings,
    usage: codexUsageReader,
  },
  {
    driverKind: ProviderDriverKind.make("grok"),
    configSchema: OpaqueHistorySettings,
    usage: grokUsageReader,
  },
  {
    driverKind: ProviderDriverKind.make("pi"),
    configSchema: PiHistorySettings,
    usage: piUsageReader,
  },
  {
    driverKind: ProviderDriverKind.make("opencode"),
    configSchema: OpaqueHistorySettings,
    usage: openCodeUsageReader,
  },
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    configSchema: OpaqueHistorySettings,
    usage: antigravityUsageReader,
  },
];
