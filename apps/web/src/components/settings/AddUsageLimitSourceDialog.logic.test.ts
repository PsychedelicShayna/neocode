import { UsageLimitSourceId } from "@t3tools/contracts";
import { applyServerSettingsPatch, DEFAULT_SERVER_SETTINGS } from "@t3tools/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";

import { buildUsageLimitSourcePatch } from "./AddUsageLimitSourceDialog.logic";

const source = (url: string, managementKey: string) => ({
  kind: "cliproxy" as const,
  url,
  managementKey,
  enabled: true,
});

const collidingUrls = [
  ["http://hub:8318", "https://hub:8318"],
  ["https://hub:8318", "https://hub-8318"],
  ["https://hub/first", "https://hub/second"],
  ["https://hub:8318", "https://hub:8318"],
] as const;

describe("buildUsageLimitSourcePatch", () => {
  it.each(collidingUrls)("preserves existing hub %s when adding %s", (existingUrl, addedUrl) => {
    const legacyId = UsageLimitSourceId.make("cliproxy-hub-8318");
    const existing = source(existingUrl, "original-secret");
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      usageLimitSources: { [legacyId]: existing },
    };

    const patch = buildUsageLimitSourcePatch({
      label: "  Second hub  ",
      url: `  ${addedUrl}  `,
      managementKey: "  new-secret  ",
    });
    const addedId = Object.keys(patch.usageLimitSources)[0]!;
    const updated = applyServerSettingsPatch(current, patch);

    expect(addedId).not.toBe(legacyId);
    expect(Object.keys(updated.usageLimitSources)).toHaveLength(2);
    expect(updated.usageLimitSources[legacyId]).toEqual(existing);
    expect(updated.usageLimitSources[addedId]).toEqual({
      ...source(addedUrl, "new-secret"),
      label: "Second hub",
    });
  });

  it.each(collidingUrls)("keeps independent additions of %s and %s", (firstUrl, secondUrl) => {
    // Both patches are created before either client's settings snapshot has updated.
    const firstPatch = buildUsageLimitSourcePatch({
      label: "",
      url: firstUrl,
      managementKey: "first-secret",
    });
    const secondPatch = buildUsageLimitSourcePatch({
      label: "",
      url: secondUrl,
      managementKey: "second-secret",
    });
    const firstId = Object.keys(firstPatch.usageLimitSources)[0]!;
    const secondId = Object.keys(secondPatch.usageLimitSources)[0]!;
    const updated = applyServerSettingsPatch(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, firstPatch),
      secondPatch,
    );

    expect(firstId).not.toBe(secondId);
    expect(updated.usageLimitSources).toEqual({
      [firstId]: source(firstUrl, "first-secret"),
      [secondId]: source(secondUrl, "second-secret"),
    });
  });
});
