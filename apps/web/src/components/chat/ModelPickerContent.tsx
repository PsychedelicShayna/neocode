import type {
  ProviderInstanceId,
  ProviderDriverKind,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { memo, useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { ModelListRow, NATIVE_MODEL_GRID } from "./ModelListRow";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import { modelPickerModelKey, parseModelPickerModelKey } from "./modelPickerKeys";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxListVirtualized,
} from "../ui/combobox";
import type { ModelEsque } from "./providerIconUtils";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import { TooltipProvider } from "../ui/tooltip";
import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  nativeSwitcherModels,
  nativeSwitcherGroup,
  NATIVE_FACT_COLUMNS,
  type NativeSelectorContext,
} from "./neopiModelSwitcher";
import { useNeoPiModelSelector } from "./useNeoPiModelSelector";

export function resolveModelPickerSelectedModel(input: {
  driverKind: ProviderDriverKind | undefined;
  model: string;
  options: ReadonlyArray<ModelEsque>;
}) {
  return input.options.find((option) => option.slug === input.model);
}
export const ModelPickerContent = memo(function ModelPickerContent(props: {
  activeInstanceId: ProviderInstanceId;
  selectorContext: NativeSelectorContext;
  model: string;
  selectedModels?: ReadonlyArray<{ instanceId: ProviderInstanceId; model: string }>;
  onToggleModel?: (instanceId: ProviderInstanceId, model: string) => void;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  terminalOpen: boolean;
  onRequestClose?: () => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<string | null>(() =>
    props.model ? nativeSwitcherGroup({ slug: props.model, name: props.model }) : null,
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const highlightedRef = useRef<string | null>(null);
  const serverKeybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindings = props.keybindings ?? serverKeybindings;
  const applicableEntries = useMemo(
    () =>
      props.instanceEntries.filter(
        (entry) =>
          entry.driverKind === "neopi" &&
          (props.lockedProvider === null || entry.driverKind === props.lockedProvider) &&
          (!props.lockedContinuationGroupKey ||
            entry.continuationGroupKey === props.lockedContinuationGroupKey),
      ),
    [props.instanceEntries, props.lockedProvider, props.lockedContinuationGroupKey],
  );
  const native = useNeoPiModelSelector(props.selectorContext, applicableEntries, query);
  const models = useMemo(
    () =>
      nativeSwitcherModels({
        entries: applicableEntries,
        results: native.results,
        activeInstanceId: props.activeInstanceId,
        activeModel: props.model,
        activeOption: props.modelOptionsByInstance
          .get(props.activeInstanceId)
          ?.find((option) => option.slug === props.model),
        includeUnavailableSelection: !native.pending && query === "",
      }),
    [
      applicableEntries,
      native.results,
      native.pending,
      props.activeInstanceId,
      props.model,
      props.modelOptionsByInstance,
      query,
    ],
  );
  const allModelsByKey = useMemo(
    () =>
      new Map(models.map((model) => [modelPickerModelKey(model.instanceId, model.slug), model])),
    [models],
  );
  const groups = useMemo(
    () => [
      ...new Set(
        applicableEntries
          .flatMap((entry) =>
            (props.modelOptionsByInstance.get(entry.instanceId) ?? []).map(nativeSwitcherGroup),
          )
          .concat(models.map((model) => model.group)),
      ),
    ],
    [applicableEntries, props.modelOptionsByInstance, models],
  );
  const effectiveGroup =
    selectedGroup !== null && groups.includes(selectedGroup) ? selectedGroup : null;
  const visibleModels = useMemo(
    () =>
      query !== "" || effectiveGroup === null
        ? models
        : models.filter((model) => model.group === effectiveGroup),
    [models, query, effectiveGroup],
  );
  const selectedKeys = useMemo(
    () =>
      new Set(
        (props.selectedModels ?? [{ instanceId: props.activeInstanceId, model: props.model }]).map(
          (selection) => modelPickerModelKey(selection.instanceId, selection.model),
        ),
      ),
    [props.selectedModels, props.activeInstanceId, props.model],
  );
  const disabledReason = useCallback(
    (instanceId: ProviderInstanceId, slug: string) => {
      const model = allModelsByKey.get(modelPickerModelKey(instanceId, slug));
      return (
        props.getModelDisabledReason?.(instanceId, slug) ??
        (model?.isUnavailable
          ? "This saved model or role is not available in the native selector scope."
          : null)
      );
    },
    [allModelsByKey, props.getModelDisabledReason],
  );
  const select = useCallback(
    (key: string, additive = false) => {
      const model = parseModelPickerModelKey(key);
      if (
        !model ||
        !visibleModels.some(
          (row) => row.instanceId === model.instanceId && row.slug === model.slug,
        ) ||
        disabledReason(model.instanceId, model.slug)
      )
        return;
      if (additive && props.onToggleModel) props.onToggleModel(model.instanceId, model.slug);
      else props.onInstanceModelChange(model.instanceId, model.slug);
    },
    [visibleModels, disabledReason, props.onToggleModel, props.onInstanceModelChange],
  );
  const focusSearch = useCallback(() => searchInputRef.current?.focus({ preventScroll: true }), []);
  const selectGroup = useCallback(
    (group: string | null) => {
      highlightedRef.current = null;
      setSelectedGroup(group);
      setQuery("");
      focusSearch();
    },
    [focusSearch],
  );
  useLayoutEffect(focusSearch, [focusSearch]);
  const allKeys = useMemo(
    () => models.map((model) => modelPickerModelKey(model.instanceId, model.slug)),
    [models],
  );
  const visibleKeys = useMemo(
    () => visibleModels.map((model) => modelPickerModelKey(model.instanceId, model.slug)),
    [visibleModels],
  );
  const modelByKey = useMemo(
    () =>
      new Map(
        visibleModels.map((model) => [modelPickerModelKey(model.instanceId, model.slug), model]),
      ),
    [visibleModels],
  );
  const shortcutContext = useMemo(
    () => ({ terminalFocus: false, terminalOpen: props.terminalOpen, modelPickerOpen: true }),
    [props.terminalOpen],
  );
  const jumpKeys = useMemo(
    () =>
      visibleModels
        .filter((model) => !disabledReason(model.instanceId, model.slug))
        .map((model) => modelPickerModelKey(model.instanceId, model.slug)),
    [visibleModels, disabledReason],
  );
  const jumpLabels = useMemo(
    () =>
      new Map(
        jumpKeys.flatMap((key, index) => {
          const command = modelPickerJumpCommandForIndex(index);
          const label = command
            ? shortcutLabelForCommand(keybindings, command, {
                platform: navigator.platform,
                context: shortcutContext,
              })
            : null;
          return label ? [[key, label] as const] : [];
        }),
      ),
    [jumpKeys, keybindings, shortcutContext],
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        props.onRequestClose?.();
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: shortcutContext,
      });
      if (command === "modelPicker.previousProvider" || command === "modelPicker.nextProvider") {
        event.preventDefault();
        event.stopPropagation();
        const choices = [null, ...groups];
        const index = choices.indexOf(effectiveGroup);
        selectGroup(
          choices[
            (index + (command === "modelPicker.nextProvider" ? 1 : -1) + choices.length) %
              choices.length
          ] ?? null,
        );
        return;
      }
      const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
      if (jumpIndex !== null) {
        event.preventDefault();
        event.stopPropagation();
        const key = jumpKeys[jumpIndex];
        if (key) select(key);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    keybindings,
    shortcutContext,
    groups,
    effectiveGroup,
    selectGroup,
    jumpKeys,
    select,
    props.onRequestClose,
  ]);
  const extraData = useMemo(
    () => ({ selectedKeys, jumpLabels, disabledReason }),
    [selectedKeys, jumpLabels, disabledReason],
  );

  return (
    <TooltipProvider delay={0}>
      <div
        className="flex h-[min(26rem,var(--available-height,70vh))] min-h-0 w-full overflow-hidden bg-background"
        data-model-picker-content="true"
      >
        <ModelPickerSidebar
          groups={groups}
          selectedGroup={effectiveGroup}
          onSelectGroup={selectGroup}
          onFocusSearch={focusSearch}
        />
        <Combobox<string, boolean>
          inline
          items={allKeys}
          filteredItems={visibleKeys}
          filter={null}
          autoHighlight
          open
          virtualized
          multiple={props.onToggleModel !== undefined}
          value={
            props.onToggleModel
              ? [...selectedKeys]
              : modelPickerModelKey(props.activeInstanceId, props.model)
          }
          onItemHighlighted={(key, details) => {
            highlightedRef.current = typeof key === "string" ? key : null;
            if (details.reason === "keyboard" && details.index >= 0)
              void listRef.current?.scrollIndexIntoView?.({
                index: details.index,
                animated: false,
              });
          }}
          onValueChange={(value, details) => {
            const key = Array.isArray(value)
              ? (value.find((key) => !selectedKeys.has(key)) ??
                [...selectedKeys].find((key) => !value.includes(key)))
              : value;
            if (typeof key === "string")
              select(key, "shiftKey" in details.event && details.event.shiftKey === true);
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <ComboboxSearchInput
              ref={searchInputRef}
              placeholder="Query native models"
              aria-label="Query native models"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (
                  (event.key === "ArrowLeft" && !query && !event.shiftKey) ||
                  (event.key === "Tab" && event.shiftKey)
                ) {
                  const sidebar = event.currentTarget
                    .closest("[data-model-picker-content]")
                    ?.querySelector("[data-model-picker-sidebar]");
                  const button = sidebar?.querySelector<HTMLButtonElement>(
                    'button[aria-pressed="true"]',
                  );
                  if (button) {
                    event.preventDefault();
                    event.stopPropagation();
                    button.focus();
                    return;
                  }
                }
                if (event.key === "Enter" && highlightedRef.current) {
                  (
                    event as typeof event & { preventBaseUIHandler?: () => void }
                  ).preventBaseUIHandler?.();
                  event.preventDefault();
                  event.stopPropagation();
                  select(highlightedRef.current, event.shiftKey);
                  return;
                }
                event.stopPropagation();
              }}
              onMouseDown={(event) => event.stopPropagation()}
              onTouchStart={(event) => event.stopPropagation()}
            />
            {native.pending ? (
              <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
                Querying native models...
              </p>
            ) : null}
            {native.errors.map((error) => (
              <p role="alert" key={error} className="px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ))}
            <div className="flex min-h-0 flex-1 flex-col overflow-x-auto overscroll-contain">
              <div className="flex min-h-0 min-w-[58rem] flex-1 flex-col">
                <div
                  className={`${NATIVE_MODEL_GRID} shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground`}
                  aria-hidden="true"
                >
                  <span>Provider / model</span>
                  {NATIVE_FACT_COLUMNS.map((label) => (
                    <span key={label} className="text-right">
                      {label}
                    </span>
                  ))}
                  <span />
                </div>
                <div className="min-h-0 flex-1">
                  <ComboboxListVirtualized>
                    <LegendList<string>
                      ref={listRef}
                      data={visibleKeys}
                      extraData={extraData}
                      keyExtractor={(key) => key}
                      renderItem={({ item: key, index }) => {
                        const model = modelByKey.get(key);
                        return model ? (
                          <ModelListRow
                            index={index}
                            model={model}
                            isSelected={selectedKeys.has(key)}
                            jumpLabel={jumpLabels.get(key) ?? null}
                            disabledReason={disabledReason(model.instanceId, model.slug)}
                          />
                        ) : null;
                      }}
                      estimatedItemSize={54}
                      drawDistance={480}
                      recycleItems
                      className="h-full overflow-x-hidden overscroll-y-contain"
                    />
                  </ComboboxListVirtualized>
                </div>
              </div>
            </div>
            {!native.pending && native.errors.length === 0 ? (
              <ComboboxEmpty className="empty:h-0">
                No native models match this query.
              </ComboboxEmpty>
            ) : null}
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});
