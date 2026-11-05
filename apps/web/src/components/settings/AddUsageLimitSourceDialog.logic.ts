import { UsageLimitSourceId, type ServerSettingsPatch } from "@t3tools/contracts";

import { randomUUID } from "../../lib/utils";

/** Each Add creates a new source, even when another client adds the same URL. */
export function buildUsageLimitSourcePatch(input: {
  label: string;
  url: string;
  managementKey: string;
}) {
  const id = UsageLimitSourceId.make(`cliproxy-${randomUUID()}`);
  const label = input.label.trim();
  return {
    usageLimitSources: {
      [id]: {
        kind: "cliproxy",
        ...(label ? { label } : {}),
        url: input.url.trim(),
        managementKey: input.managementKey.trim(),
        enabled: true,
      },
    },
  } satisfies ServerSettingsPatch;
}
