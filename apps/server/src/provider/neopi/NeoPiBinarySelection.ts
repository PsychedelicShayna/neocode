import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";

/** Called inside the settings write lock after probing; a user edit always wins. */
export function neoPiBinarySelectionPatch(
  before: ServerSettings,
  current: ServerSettings,
  instanceId: ProviderInstanceId,
  binary: string,
  bundled = false,
): ServerSettingsPatch | null {
  const expected = before.providerInstances[instanceId];
  const instance = current.providerInstances[instanceId];
  if (JSON.stringify(expected) !== JSON.stringify(instance)) return null;
  if (instance === undefined ? instanceId !== "neopi" : instance.driver !== "neopi") return null;
  const config = instance?.config;
  if (
    config !== undefined &&
    (config === null || typeof config !== "object" || Array.isArray(config))
  )
    return null;
  const fields = (config ?? {}) as Record<string, unknown>;
  if (bundled && fields.autoSelectedBinaryPath === binary) return null;
  if (fields.binaryPath && fields.binaryPath !== "npi") return null;
  return {
    providerInstances: {
      ...current.providerInstances,
      [instanceId]: {
        ...(instance ?? { driver: ProviderDriverKind.make("neopi") }),
        config: {
          ...fields,
          // AppImage resource paths are mount-specific; keep automatic resolution on restart.
          ...(!bundled ? { binaryPath: binary } : {}),
          autoSelectedBinaryPath: binary,
        },
      },
    },
  };
}
