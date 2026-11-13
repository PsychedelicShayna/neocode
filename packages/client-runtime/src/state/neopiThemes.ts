import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createNeoPiThemesState<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
) {
  return {
    read: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:neopi-themes:read",
      tag: WS_METHODS.neopiThemesRead,
    }),
    palette: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:neopi-themes:palette",
      tag: WS_METHODS.neopiThemesPalette,
    }),
  };
}
