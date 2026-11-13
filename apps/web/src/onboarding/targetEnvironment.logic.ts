import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

export function isOnboardingRelayEnvironment(environment: {
  readonly entry: { readonly target: ConnectionTarget };
}): boolean {
  return environment.entry.target._tag === "RelayConnectionTarget";
}

/** Never choose a credential destination implicitly when setup includes several computers. */
export function resolveOnboardingNeoProxyTarget(
  environmentIds: readonly EnvironmentId[],
  chosenTarget: EnvironmentId | null,
): EnvironmentId | null {
  if (environmentIds.length === 1) return environmentIds[0] ?? null;
  return chosenTarget !== null && environmentIds.includes(chosenTarget) ? chosenTarget : null;
}
