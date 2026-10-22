import { createNeoPiThemesState } from "@t3tools/client-runtime/state/neopiThemes";
import { connectionAtomRuntime } from "../connection/runtime";

const state = createNeoPiThemesState(connectionAtomRuntime);
export const neopiThemesUpdate = state.update;
export const neopiThemesWatch = state.watch;
