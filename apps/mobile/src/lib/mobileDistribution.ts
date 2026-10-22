export type MobileAppVariant = "development" | "preview" | "production";

/** Separate packages and schemes leave upstream installs and their private data untouched. */
export const MOBILE_APP_IDENTITIES = {
  development: {
    applicationId: "io.github.psychedelicshayna.neocode.dev",
    scheme: "neocode-dev",
  },
  preview: {
    applicationId: "io.github.psychedelicshayna.neocode.preview",
    scheme: "neocode-preview",
  },
  production: {
    applicationId: "io.github.psychedelicshayna.neocode",
    scheme: "neocode",
  },
} as const;

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
