import { createNativeStatsRequest } from "@t3tools/client-runtime/state/neopiStats";
import { connectionAtomRuntime } from "../connection/runtime";

export const nativeStatsRequest = createNativeStatsRequest(connectionAtomRuntime);
