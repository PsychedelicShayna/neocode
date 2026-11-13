import { NeoPiDriver, type NeoPiDriverEnv } from "./Drivers/NeoPiDriver.ts";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";

export type BuiltInDriversEnv = NeoPiDriverEnv;

// Legacy driver identities remain readable, but only NeoPi may execute.
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [NeoPiDriver];
