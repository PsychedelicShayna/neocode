import { makeNeoPiModelsClientState } from "@t3tools/client-runtime/neopi-models";
import { connectionAtomRuntime } from "../connection/runtime";

export const neopiModels = makeNeoPiModelsClientState(connectionAtomRuntime);
