import { managedCapabilityDenial, type ManagedPolicySummary } from "@t3tools/contracts";

/**
 * The phone joins by signing in to T3 Connect, which shares the primary computer. Another
 * computer, a build without T3 Connect, or a policy that turns it off gets no Phone section.
 */
export function welcomeOffersPhone(input: {
  readonly isPrimary: boolean;
  readonly cloud: boolean;
  // Relay read and write access, which sharing this computer through T3 Connect needs.
  readonly canShare: boolean;
  readonly policy: ManagedPolicySummary | undefined;
}) {
  return (
    input.isPrimary &&
    input.cloud &&
    input.canShare &&
    managedCapabilityDenial(input.policy, "remoteClients") === undefined &&
    managedCapabilityDenial(input.policy, "connect") === undefined
  );
}
