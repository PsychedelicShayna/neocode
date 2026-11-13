import type {
  ProviderInstanceId,
  ResolvedKeybindingsConfig,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";
import type { NativeSessionTarget } from "@t3tools/client-runtime/neopi-native-sessions";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import type { ModelEsque } from "../chat/providerIconUtils";
import type { NativeModelChoice } from "../chat/neopiModelSwitcher";

const NO_MODEL_OPTIONS: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>> = new Map();

/** The session's own model button: the shared picker, scoped to this session's NeoPi connection. */
export function NativeSessionModelPicker({
  target,
  providers,
  settings,
  keybindings,
  modelLabel,
  modelSelector,
  displayState,
  open,
  onOpenChange,
  disabled,
  terminalOpen,
  onSelect,
}: {
  target: NativeSessionTarget;
  providers: ReadonlyArray<ServerProvider>;
  settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;
  keybindings: ResolvedKeybindingsConfig;
  modelLabel: string;
  /** `provider/id` of the active model, matched against the selector rows. */
  modelSelector: string;
  displayState: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  terminalOpen: boolean;
  onSelect: (choice: NativeModelChoice) => void;
}) {
  const { environmentId, ref } = target;
  const entries = applyProviderInstanceSettings(
    deriveProviderInstanceEntries(
      providers.filter((provider) => provider.instanceId === ref.providerInstanceId),
    ),
    settings,
    null,
  );
  const selectorContext = {
    environmentId,
    connectedSession: {
      sessionFile: ref.sessionFile,
      providerInstanceId: ref.providerInstanceId,
    },
  };
  return (
    <ProviderModelPicker
      environmentId={environmentId}
      isComposerOwned
      activeInstanceId={ref.providerInstanceId}
      selectorContext={selectorContext}
      model={modelSelector}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={NO_MODEL_OPTIONS}
      keybindings={keybindings}
      terminalOpen={terminalOpen}
      disabled={disabled}
      open={open}
      onOpenChange={onOpenChange}
      triggerLabel={modelLabel}
      triggerDetail={displayState}
      triggerAriaLabel={`Model: ${modelLabel}${displayState ? `, ${displayState}` : ""}`}
      onInstanceModelChange={(_, __, choice) => {
        if (choice) onSelect(choice);
      }}
    />
  );
}
