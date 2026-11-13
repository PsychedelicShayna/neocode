import type { UsageProviderKind } from "@t3tools/contracts";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

const USAGE_PROVIDER_KINDS: readonly UsageProviderKind[] = [
  "codex",
  "claude",
  "grok",
  "cursor",
  "opencode",
  "antigravity",
  "pi",
  "muse",
  "neopi",
];

export function usageProviderKind(driver: string): UsageProviderKind | null {
  if (driver === "claudeAgent") return "claude";
  return USAGE_PROVIDER_KINDS.find((kind) => kind === driver) ?? null;
}

export function useProviderColors(): Record<UsageProviderKind, string> {
  const { themeAppearance: scheme } = useAppearancePreferences();
  return {
    claude: "#d97757",
    codex: scheme === "dark" ? "#e6e6e6" : "#3c3c43",
    grok: scheme === "dark" ? "#a1a1aa" : "#52525b",
    cursor: "#8b8b8b",
    opencode: "#5b9bbd",
    antigravity: "#8c7bd1",
    neopi: "#f97316",
    pi: "#4d9f8a",
    muse: "#0866ff",
  };
}
