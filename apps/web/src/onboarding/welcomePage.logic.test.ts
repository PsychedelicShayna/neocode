import { type ManagedPolicySummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { welcomeOffersPhone } from "./welcomePage.logic";

describe("welcomeOffersPhone", () => {
  it("offers the phone only through T3 Connect on the primary computer, and only when allowed", () => {
    const policy = (limits: ManagedPolicySummary["limits"]): ManagedPolicySummary => ({
      organization: "Acme",
      lockedSettings: [],
      ...(limits === undefined ? {} : { limits }),
    });
    const offers = (input: Partial<Parameters<typeof welcomeOffersPhone>[0]>) =>
      welcomeOffersPhone({
        isPrimary: true,
        cloud: true,
        canShare: true,
        policy: undefined,
        ...input,
      });

    expect(offers({})).toBe(true);
    expect(offers({ cloud: false })).toBe(false);
    expect(offers({ canShare: false })).toBe(false);
    expect(offers({ policy: policy({ connect: false }) })).toBe(false);
    expect(offers({ policy: policy({ clients: ["desktop"] }) })).toBe(false);
    expect(offers({ isPrimary: false })).toBe(false);
  });
});
