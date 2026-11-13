import { nativeRecord } from "@t3tools/client-runtime/neopi-native-sessions";
import {
  type ModelCapabilities,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/** NeoPi's level names read as titles; one it adds later stays as it sent it. */
export function nativeEffortLabel(level: string): string {
  return EFFORT_LABELS[level] ?? level;
}

const NATIVE_EFFORT_OPTION_ID = "effort";
const NATIVE_FAST_MODE_OPTION_ID = "fastMode";

export type NativeTraitsCommand =
  | { readonly type: "set_thinking_level"; readonly level: string }
  | { readonly type: "set_fast_mode"; readonly enabled: boolean };

export interface NativeTraitsState {
  /** NeoPi's current thinking level for the session, when it reports one. */
  readonly thinkingLevel: string | null;
  /** Levels NeoPi offers for the current model (`get_available_thinking_levels`). */
  readonly levels: readonly string[];
  readonly fastModeSupported: boolean;
  readonly fastModeEnabled: boolean;
}

/** Reads the `get_available_thinking_levels` response; anything unexpected yields no levels. */
export function parseNativeThinkingLevels(response: unknown): readonly string[] {
  const levels = nativeRecord(response).levels;
  return Array.isArray(levels)
    ? levels.filter((level): level is string => typeof level === "string" && level.length > 0)
    : [];
}

/** Reads the traits NeoPi reports in `get_state`; the model carries `supportsFastMode`. */
export function nativeTraitsStateFromSession(
  state: Readonly<Record<string, unknown>>,
  levels: readonly string[],
): NativeTraitsState {
  return {
    thinkingLevel: typeof state.thinkingLevel === "string" ? state.thinkingLevel : null,
    levels,
    fastModeSupported: nativeRecord(state.model).supportsFastMode === true,
    fastModeEnabled: state.fastModeEnabled === true,
  };
}

/**
 * Stock traits descriptors for the native session. The effort list is exactly what NeoPi
 * advertised for the model; the fast toggle only exists when the model supports it.
 */
export function nativeTraitsDescriptors(
  traits: NativeTraitsState,
): readonly ProviderOptionDescriptor[] {
  const levels =
    traits.thinkingLevel !== null && !traits.levels.includes(traits.thinkingLevel)
      ? [...traits.levels, traits.thinkingLevel]
      : traits.levels;
  return [
    ...(levels.length > 1
      ? [
          {
            id: NATIVE_EFFORT_OPTION_ID,
            label: "Effort",
            type: "select" as const,
            options: levels.map((level) => ({ id: level, label: EFFORT_LABELS[level] ?? level })),
            ...(traits.thinkingLevel !== null ? { currentValue: traits.thinkingLevel } : {}),
          },
        ]
      : []),
    ...(traits.fastModeSupported
      ? [
          {
            id: NATIVE_FAST_MODE_OPTION_ID,
            label: "Fast mode",
            type: "boolean" as const,
            currentValue: traits.fastModeEnabled,
          },
        ]
      : []),
  ];
}

/** A one-model catalog so the stock TraitsPicker renders the native descriptors. */
export function nativeTraitsModels(
  model: string,
  descriptors: readonly ProviderOptionDescriptor[],
): readonly ServerProviderModel[] {
  const capabilities: ModelCapabilities = { optionDescriptors: descriptors };
  return [{ slug: model, name: model, isCustom: false, capabilities }];
}

/** RPCs that turn the stock picker's next selections into the native session's new traits. */
export function nativeTraitsCommands(
  traits: Pick<NativeTraitsState, "thinkingLevel" | "fastModeEnabled">,
  next: readonly ProviderOptionSelection[] | undefined,
): readonly NativeTraitsCommand[] {
  const commands: NativeTraitsCommand[] = [];
  for (const selection of next ?? []) {
    if (
      selection.id === NATIVE_EFFORT_OPTION_ID &&
      typeof selection.value === "string" &&
      selection.value !== traits.thinkingLevel
    ) {
      commands.push({ type: "set_thinking_level", level: selection.value });
    }
    if (
      selection.id === NATIVE_FAST_MODE_OPTION_ID &&
      typeof selection.value === "boolean" &&
      selection.value !== traits.fastModeEnabled
    ) {
      commands.push({ type: "set_fast_mode", enabled: selection.value });
    }
  }
  return commands;
}
