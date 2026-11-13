import {
  UsageLimitSourceId,
  type SecretReference,
  type ServerSettingsPatch,
} from "@t3tools/contracts";

import { randomUUID } from "../../lib/utils";

/** Each Add creates a new source, even when another client adds the same URL. */
export function buildUsageLimitSourcePatch(input: {
  label: string;
  url: string;
  managementKey: string | SecretReference;
}) {
  const id = UsageLimitSourceId.make(`cliproxy-${randomUUID()}`);
  const label = input.label.trim();
  return {
    usageLimitSources: {
      [id]: {
        kind: "cliproxy",
        ...(label ? { label } : {}),
        url: input.url.trim(),
        managementKey:
          typeof input.managementKey === "string"
            ? input.managementKey.trim()
            : input.managementKey,
        enabled: true,
      },
    },
  } satisfies ServerSettingsPatch;
}
