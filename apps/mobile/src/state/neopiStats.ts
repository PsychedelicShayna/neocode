import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import { requestNativeStats, type NativeStatsRequest } from "@t3tools/client-runtime/state/neopiStats";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { fetch as streamingFetch } from "expo/fetch";

import { connectionAtomRuntime } from "../connection/runtime";

// RN's global fetch buffers responses. Scope Expo's streaming implementation to
// native stats so SSE and trace reads retain their pull/cancel behavior.
const statsHttpClient = remoteHttpClientLayer(streamingFetch);
export const nativeStatsRequest = createEnvironmentCommand(connectionAtomRuntime, {
  label: "Mobile native stats request",
  execute: (input: NativeStatsRequest) => requestNativeStats(input).pipe(Effect.provide(statsHttpClient)),
});
