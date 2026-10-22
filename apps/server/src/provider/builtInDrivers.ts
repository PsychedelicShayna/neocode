import { NeoPiDriver, type NeoPiDriverEnv } from "./Drivers/NeoPiDriver.ts";
import type { AnyProviderDriver } from "./ProviderDriver.ts";

export type BuiltInDriversEnv = NeoPiDriverEnv;

/** Legacy driver identifiers remain readable, but only NeoPi can execute. */
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [NeoPiDriver];
