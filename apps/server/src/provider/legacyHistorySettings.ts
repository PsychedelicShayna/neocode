import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const OpaqueHistorySettings = Schema.Record(Schema.String, Schema.Unknown);
export type OpaqueHistorySettings = typeof OpaqueHistorySettings.Type;

const pathSetting = Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("")));

export const ClaudeHistorySettings = Schema.StructWithRest(
  Schema.Struct({ homePath: pathSetting }),
  [OpaqueHistorySettings],
);
export type ClaudeHistorySettings = typeof ClaudeHistorySettings.Type;

export const CodexHistorySettings = Schema.StructWithRest(
  Schema.Struct({ homePath: pathSetting, shadowHomePath: pathSetting, setupMode: pathSetting }),
  [OpaqueHistorySettings],
);
export type CodexHistorySettings = typeof CodexHistorySettings.Type;
