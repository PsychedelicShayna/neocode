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
