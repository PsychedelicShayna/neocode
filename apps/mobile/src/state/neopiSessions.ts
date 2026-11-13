import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const neopiSessionConfiguration = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "mobile:neopi-sessions:configuration",
    tag: WS_METHODS.neopiSessionsConfiguration,
    staleTimeMs: 0,
    idleTtlMs: 0,
  },
);
