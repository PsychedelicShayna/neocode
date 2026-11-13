import type { KeybindingCommand } from "@t3tools/contracts";
import { nativeRecord } from "@t3tools/client-runtime/neopi-native-sessions";
import { nativeEffortLabel } from "./nativeTraits";

/** Keybinding commands only the native session workspace implements. */
const NATIVE_SESSION_COMMANDS = [
  "composer.thinking.cycle",
  "composer.role.cycleForward",
  "composer.role.cycleBackward",
  "transcript.thinking.toggle",
  "transcript.tools.toggleExpand",
] as const satisfies readonly KeybindingCommand[];
export type NativeSessionCommand = (typeof NATIVE_SESSION_COMMANDS)[number];

export function isNativeSessionCommand(
  command: KeybindingCommand | null,
): command is NativeSessionCommand {
  return NATIVE_SESSION_COMMANDS.some((candidate) => candidate === command);
}

/** Advertised in NeoPi's `ready` frame once `cycle_role` exists. */
export const NATIVE_CYCLE_ROLE_CAPABILITY = "cycle_role";

export const NATIVE_ROLE_CYCLE_UNSUPPORTED =
  "Cycling roles needs a newer NeoPi. Update NeoPi to use this shortcut.";

/** `cycle_thinking_level` answers `{ level }`, or null when the model has no levels to cycle. */
export function nativeThinkingCycleNotice(result: unknown): string {
  const level = nativeRecord(result).level;
  return typeof level === "string"
    ? `Reasoning: ${nativeEffortLabel(level)}`
    : "This model has no reasoning levels to cycle.";
}

/** `cycle_role` answers `{ role, model, thinkingLevel? }`, or null with fewer than two role models. */
export function nativeRoleCycleNotice(result: unknown): string {
  const record = nativeRecord(result);
  if (typeof record.role !== "string") return "Only one role model is available.";
  const model = nativeRecord(record.model);
  const modelName = [model.name, model.id].find((value) => typeof value === "string");
  return [
    `Role: ${record.role}`,
    typeof modelName === "string" ? modelName : null,
    typeof record.thinkingLevel === "string" ? nativeEffortLabel(record.thinkingLevel) : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}
