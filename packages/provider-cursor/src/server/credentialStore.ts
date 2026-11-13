import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";

const Credentials = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    backendUrl: Schema.String,
    apiKey: Schema.String,
    createdAtMs: Schema.Finite,
    apiKeyExpiresAtMs: Schema.optionalKey(Schema.Finite),
    email: Schema.optionalKey(Schema.String),
  }),
);

const decodeCredentials = Schema.decodeUnknownEffect(Credentials);
/** The unexpired API key from this instance's T3 sign-in, read without loading the SDK. */
export const readStoredCursorApiKey = Effect.fn("readStoredCursorApiKey")(function* (
  instanceId: ProviderInstanceId,
) {
  const stored = yield* (yield* (yield* ProviderHost.ProviderHost).credentials(
    "cursor",
    instanceId,
  )).get;
  if (Option.isNone(stored)) return undefined;
  const credentials = yield* decodeCredentials(new TextDecoder().decode(stored.value)).pipe(
    Effect.option,
  );
  if (Option.isNone(credentials)) return undefined;
  const { apiKey, apiKeyExpiresAtMs } = credentials.value;
  return apiKeyExpiresAtMs === undefined || apiKeyExpiresAtMs > (yield* Clock.currentTimeMillis)
    ? apiKey
    : undefined;
});
