import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const neopiSessionList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:neopi-sessions:list",
  tag: WS_METHODS.neopiSessionsList,
  staleTimeMs: 5_000,
  idleTtlMs: 0,
});

export const neopiSessionResume = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:neopi-sessions:resume",
  tag: WS_METHODS.neopiSessionsResume,
});

export const neopiSessionConfiguration = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "mobile:neopi-sessions:configuration",
    tag: WS_METHODS.neopiSessionsConfiguration,
    staleTimeMs: 0,
    idleTtlMs: 0,
  },
);
