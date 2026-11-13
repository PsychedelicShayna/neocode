import { MOBILE_APP_IDENTITIES } from "../../../../packages/shared/src/mobileDistribution.ts";

export type MobileAppVariant = "development" | "preview" | "production";

export const MOBILE_LINK_PREFIXES = Object.values(MOBILE_APP_IDENTITIES).map(
  ({ scheme }) => `${scheme}://`,
);

export function androidVersionCode(value: string | undefined): number {
  if (value === undefined) return 1;
  const code = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(code) || code < 1 || code > 2_100_000_000) {
    throw new Error("NEOCODE_ANDROID_VERSION_CODE must be an integer between 1 and 2100000000.");
  }
  return code;
}
