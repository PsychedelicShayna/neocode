import { useLegendListRef } from "~/hooks/useLegendListRef";
import { useStableCallback } from "~/hooks/useStableCallback";
import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  memo,
  useState,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { ModelListRow } from "./ModelListRow";
import { ModelPickerSidebar, type ModelPickerRailEntry } from "./ModelPickerSidebar";
import { modelPickerModelKey, parseModelPickerModelKey } from "./modelPickerKeys";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxListVirtualized,
} from "../ui/combobox";
import type { ModelEsque } from "./providerIconUtils";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { registerModelPickerContent } from "../../modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import {
  useEnvironmentModelPreferences,
  useToggleEnvironmentModelFavorite,
} from "~/hooks/useSettings";
import { announce } from "~/lib/announce";
import { cn } from "~/lib/utils";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { TooltipProvider } from "../ui/tooltip";
import { providerModelKey } from "../../modelOrdering";
import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  nativeSwitcherModels,
  nativeSwitcherGroup,
  ROLES_GROUP,
  type NativeModelChoice,
  type NativeSelectorContext,
  type NativeSwitcherModel,
  filterNativeSwitcherModels,
  pinNativeSwitcherModel,
} from "./neopiModelSwitcher";
import { useNeoPiModelSelector } from "./useNeoPiModelSelector";

const ROLES_KEY = "roles";
const FAVORITES_KEY = "favorites";
const providerRailKey = (group: string) => `provider:${group}`;
const EMPTY_MODELS: ReadonlyArray<NativeSwitcherModel> = [];

export function resolveModelPickerSelectedModel(input: {
  driverKind: ProviderDriverKind | undefined;
  model: string;
  options: ReadonlyArray<ModelEsque>;
}) {
  return input.options.find((option) => option.slug === input.model);
}
const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();
const MODEL_LIST_ESTIMATED_ITEM_SIZE = 44;
const ROW_UNITS = 11;
const ROW_SEPARATOR_UNITS = 0.5;
const LIST_CHROME_UNITS = 15.5;

function ModelListSeparator() {
  return <div className="h-0.5" />;
}

function modelJumpLabelsByKey(
  modelKeys: ReadonlyArray<string>,
  keybindings: ResolvedKeybindingsConfig,
  terminalOpen: boolean,
): ReadonlyMap<string, string> {
  const shortcutLabelOptions = {
    platform: navigator.platform,
    context: { terminalFocus: false, terminalOpen, modelPickerOpen: true },
  };
  const mapping = new Map<string, string>();
  for (const [index, modelKey] of modelKeys.entries()) {
    const command = modelPickerJumpCommandForIndex(index);
    const label = command && shortcutLabelForCommand(keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(modelKey, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_MODEL_JUMP_LABELS;
}

function ModelPickerList({
  listRef,
  itemKeys,
  extraData,
  renderItem,
}: {
  listRef: RefObject<LegendListRef | null>;
  itemKeys: ReadonlyArray<string>;
  extraData: unknown;
  renderItem: (props: { item: string; index: number }) => ReactNode;
}) {
  const [showTopScrollFade, setShowTopScrollFade] = useState(false);
  const [showBottomScrollFade, setShowBottomScrollFade] = useState(false);
  const updateScrollFades = () => {
    const metrics = listRef.current?.getState();
    if (!metrics) return;
    setShowTopScrollFade(!metrics.isAtStart);
    setShowBottomScrollFade(!metrics.isAtEnd);
  };
  const scrollRef = useLegendListRef(listRef, updateScrollFades);

  return (
    <div
      className={cn(
        "relative min-h-0 overflow-hidden pr-px",
        itemKeys.length > 0 ? "flex-1" : "h-0",
      )}
    >
      <ComboboxListVirtualized>
        <LegendList<string>
          ref={scrollRef}
          data={itemKeys}
          extraData={extraData}
          keyExtractor={(modelKey) => modelKey}
          renderItem={renderItem}
          estimatedItemSize={MODEL_LIST_ESTIMATED_ITEM_SIZE}
          drawDistance={480}
          recycleItems
          contentContainerClassName="pl-2 pr-px"
          ItemSeparatorComponent={ModelListSeparator}
          onLayout={updateScrollFades}
          onScroll={updateScrollFades}
          onReady={updateScrollFades}
          className={cn(
            "scrollbar-gutter-stable h-full overflow-x-hidden overscroll-y-contain py-1.5 [&::-webkit-scrollbar-track]:my-2",
            getVirtualizedScrollFadeClassName({
              top: showTopScrollFade,
              bottom: showBottomScrollFade,
            }),
          )}
        />
      </ComboboxListVirtualized>
    </div>
  );
}

// Capture gives picker shortcuts priority over the composer.
function WindowKeyDownListener({ onKeyDown }: { onKeyDown: (event: KeyboardEvent) => void }) {
  const handleKeyDown = useEffectEvent(onKeyDown);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a capture-phase window keydown listener for the picker's lifetime
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKeyDown(event);
    window.addEventListener("keydown", listener, true);
    return () => {
      window.removeEventListener("keydown", listener, true);
    };
  }, []);
  return null;
}

export const ModelPickerContent = memo(function ModelPickerContent({
  activeInstanceId,
  selectorContext,
  model,
  selectedModels,
  onToggleModel,
  lockedProvider,
  lockedContinuationGroupKey,
  instanceEntries,
  keybindings: providedKeybindings,
  modelOptionsByInstance,
  terminalOpen,
  onRequestClose,
  getModelDisabledReason,
  onInstanceModelChange,
  searchInputRef,
  docked,
  onFocusEffort,
  listFooter,
}: {
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
  onInstanceModelChange: (
    instanceId: ProviderInstanceId,
    model: string,
    choice?: NativeModelChoice,
  ) => void;
  /** The owning popup supplies its initial focus target. */
  searchInputRef: RefObject<HTMLInputElement | null>;
  docked?: boolean;
  onFocusEffort?: () => void;
  listFooter?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [selectedRail, setSelectedRail] = useState<string | null>(() => {
    if (!model) return null;
    const group = nativeSwitcherGroup({ slug: model, name: model });
    return group === ROLES_GROUP ? ROLES_KEY : providerRailKey(group);
  });
  const pickerContentRef = useRef<HTMLDivElement>(null);
  const [searchHeight, setSearchHeight] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes this picker's mount to global keydown handlers
  useLayoutEffect(() => registerModelPickerContent(), []);
  const listRef = useRef<LegendListRef | null>(null);
  const highlightedRef = useRef<string | null>(null);
  const serverKeybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindings = providedKeybindings ?? serverKeybindings;
  const { favorites } = useEnvironmentModelPreferences(selectorContext.environmentId);
  const toggleFavorite = useToggleEnvironmentModelFavorite(selectorContext.environmentId);
  const favoriteKeys = new Set(
    favorites.map((favorite) => providerModelKey(favorite.provider, favorite.model)),
  );
  const applicableEntries = instanceEntries.filter(
    (entry) =>
      entry.driverKind === "neopi" &&
      (lockedProvider === null || entry.driverKind === lockedProvider) &&
      (!lockedContinuationGroupKey || entry.continuationGroupKey === lockedContinuationGroupKey),
  );
  const native = useNeoPiModelSelector(selectorContext, applicableEntries, query);
  const queried = nativeSwitcherModels({
    entries: applicableEntries,
    results: native.results,
    activeInstanceId: activeInstanceId,
    activeModel: model,
    activeOption: modelOptionsByInstance
      .get(activeInstanceId)
      ?.find((option) => option.slug === model),
    includeUnavailableSelection: !native.pending && query === "",
  });
  // Keep unfiltered native responses while searching, never a derived row-array identity.
  const [browse, setBrowse] = useState<{
    scopeKey: string;
    results: typeof native.results | null;
    includeUnavailable: boolean;
  }>({ scopeKey: native.scopeKey, results: null, includeUnavailable: false });
  const captureBrowse = query === "" && native.hasResponse;
  const browseResults = captureBrowse
    ? native.results
    : browse.scopeKey === native.scopeKey
      ? browse.results
      : null;
  const includeUnavailable = captureBrowse
    ? !native.pending
    : browse.scopeKey === native.scopeKey && browse.includeUnavailable;
  if (
    browse.results !== browseResults ||
    browse.scopeKey !== native.scopeKey ||
    browse.includeUnavailable !== includeUnavailable
  )
    setBrowse({ scopeKey: native.scopeKey, results: browseResults, includeUnavailable });
  const browseModels = captureBrowse
    ? queried
    : browseResults
      ? nativeSwitcherModels({
          entries: applicableEntries,
          results: browseResults,
          activeInstanceId,
          activeModel: model,
          activeOption: modelOptionsByInstance
            .get(activeInstanceId)
            ?.find((option) => option.slug === model),
          includeUnavailableSelection: includeUnavailable,
        })
      : EMPTY_MODELS;
  // While NeoPi ranks a typed query, the unfiltered catalog narrows locally so results appear
  // at once; the ranked answer then replaces them, keeping the user's highlighted row in place.
  const [highlightPin, setHighlightPin] = useState<{ key: string; index: number } | null>(null);
  const searchModels = native.hasResponse
    ? pinNativeSwitcherModel(queried, highlightPin)
    : filterNativeSwitcherModels(browseModels, query);
  const models = query === "" ? browseModels : searchModels;
  const allModelsByKey = new Map(
    models.map((model) => [modelPickerModelKey(model.instanceId, model.slug), model]),
  );
  const rail: ReadonlyArray<ModelPickerRailEntry> = (() => {
    const providers = [
      ...new Set(
        applicableEntries
          .flatMap((entry) =>
            (modelOptionsByInstance.get(entry.instanceId) ?? []).map(nativeSwitcherGroup),
          )
          .concat(browseModels.map((model) => model.group)),
      ),
    ].filter((group) => group !== ROLES_GROUP);
    return [
      ...(browseModels.some((model) => model.group === ROLES_GROUP)
        ? [{ key: ROLES_KEY, label: "Roles", pinned: true }]
        : []),
      { key: FAVORITES_KEY, label: "Favorites", pinned: true },
      ...providers.map((group) => ({ key: providerRailKey(group), label: group, pinned: false })),
    ];
  })();
  const effectiveRail = rail.some((entry) => entry.key === selectedRail)
    ? selectedRail
    : (rail[0]?.key ?? null);
  const visibleModels = (() => {
    if (query !== "") return models;
    if (effectiveRail === ROLES_KEY) return models.filter((model) => model.group === ROLES_GROUP);
    if (effectiveRail === FAVORITES_KEY)
      return models.filter(
        (model) =>
          model.group !== ROLES_GROUP &&
          favoriteKeys.has(providerModelKey(model.instanceId, model.slug)),
      );
    return models.filter((model) => providerRailKey(model.group) === effectiveRail);
  })();
  const selectedKeys = new Set(
    (selectedModels ?? [{ instanceId: activeInstanceId, model: model }]).map((selection) =>
      modelPickerModelKey(selection.instanceId, selection.model),
    ),
  );
  const disabledReason = (instanceId: ProviderInstanceId, slug: string) => {
    const model = allModelsByKey.get(modelPickerModelKey(instanceId, slug));
    return (
      getModelDisabledReason?.(instanceId, slug) ??
      (model?.isUnavailable
        ? "This saved model or role is not available in the native selector scope."
        : null)
    );
  };
  const select = (key: string, additive = false) => {
    const parsed = parseModelPickerModelKey(key);
    const model = parsed
      ? visibleModels.find(
          (row) => row.instanceId === parsed.instanceId && row.slug === parsed.slug,
        )
      : undefined;
    if (!model || disabledReason(model.instanceId, model.slug)) return null;
    if (additive && onToggleModel) onToggleModel(model.instanceId, model.slug);
    else onInstanceModelChange(model.instanceId, model.slug, model.choice);
    return model;
  };
  const focusSearch = useStableCallback(() =>
    searchInputRef.current?.focus({ preventScroll: true }),
  );
  const selectRail = useStableCallback((key: string) => {
    highlightedRef.current = null;
    setHighlightPin(null);
    setSelectedRail(key);
    setQuery("");
    focusSearch();
  });
  const allKeys = models.map((model) => modelPickerModelKey(model.instanceId, model.slug));
  const visibleKeys = visibleModels.map((model) =>
    modelPickerModelKey(model.instanceId, model.slug),
  );
  const modelByKey = new Map(
    visibleModels.map((model) => [modelPickerModelKey(model.instanceId, model.slug), model]),
  );

  const shortcutContext = {
    terminalFocus: false,
    terminalOpen: terminalOpen,
    modelPickerOpen: true,
  };
  const jumpKeys = visibleModels
    .filter((model) => !disabledReason(model.instanceId, model.slug))
    .slice(0, MODEL_PICKER_JUMP_KEYBINDING_COMMANDS.length)
    .map((model) => modelPickerModelKey(model.instanceId, model.slug));
  const jumpLabels = modelJumpLabelsByKey(jumpKeys, keybindings, terminalOpen);
  const extraData = { selectedKeys, jumpLabels, disabledReason, favoriteKeys, query };
  const showProvider = query !== "" || effectiveRail === FAVORITES_KEY;
  const tallestTabUnits = (() => {
    const counts = new Map<string, number>();
    for (const model of browseModels) {
      counts.set(model.group, (counts.get(model.group) ?? 0) + 1);
      if (
        model.group !== ROLES_GROUP &&
        favoriteKeys.has(providerModelKey(model.instanceId, model.slug))
      ) {
        counts.set(FAVORITES_KEY, (counts.get(FAVORITES_KEY) ?? 0) + 1);
      }
    }
    let tallest = 0;
    for (const count of counts.values()) tallest = Math.max(tallest, count);
    return tallest === 0 ? 0 : tallest * (ROW_UNITS + ROW_SEPARATOR_UNITS) - ROW_SEPARATOR_UNITS;
  })();
  const onWindowKeyDown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.keyCode === 229 ||
      isCommandPaletteOpen()
    )
      return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onRequestClose?.();
      return;
    }
    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: shortcutContext,
    });
    if (command === "modelPicker.previousProvider" || command === "modelPicker.nextProvider") {
      event.preventDefault();
      event.stopPropagation();
      const index = rail.findIndex((entry) => entry.key === effectiveRail);
      const next =
        rail[
          (index + (command === "modelPicker.nextProvider" ? 1 : -1) + rail.length) % rail.length
        ];
      if (next) {
        selectRail(next.key);
        announce(next.label, "model-picker");
      }
      return;
    }
    const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
    if (jumpIndex === null) return;
    event.preventDefault();
    event.stopPropagation();
    const key = jumpKeys[jumpIndex];
    const selected = key ? select(key) : null;
    if (selected) announce(`Model: ${selected.name}`, "model-picker");
  };

  return (
    <TooltipProvider delay={0}>
      <WindowKeyDownListener onKeyDown={onWindowKeyDown} />
      <div
        ref={pickerContentRef}
        className={cn(
          "relative flex w-screen max-w-[36rem] flex-row overflow-hidden",
          docked ? "max-sm:h-56 max-sm:w-full max-sm:max-w-none" : "max-h-86.5",
        )}
        style={
          docked
            ? undefined
            : query !== ""
              ? { height: searchHeight }
              : {
                  minHeight: `min(calc(var(--spacing) * ${tallestTabUnits + LIST_CHROME_UNITS} + 1px), calc(var(--spacing) * 86.5))`,
                }
        }
        data-model-picker-content="true"
      >
        <ModelPickerSidebar
          entries={rail}
          selectedKey={query === "" ? effectiveRail : null}
          onSelect={selectRail}
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
          multiple={onToggleModel !== undefined}
          value={onToggleModel ? [...selectedKeys] : modelPickerModelKey(activeInstanceId, model)}
          onItemHighlighted={(key, details) => {
            highlightedRef.current = typeof key === "string" ? key : null;
            if (typeof key === "string" && details.reason !== "none" && details.index >= 0)
              setHighlightPin((previous) =>
                previous?.key === key && previous.index === details.index
                  ? previous
                  : { key, index: details.index },
              );
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
              placeholder="Search models and roles"
              aria-label="Search models and roles"
              value={query}
              onChange={(event) => {
                if (query === "") setSearchHeight(pickerContentRef.current?.offsetHeight ?? 0);
                setHighlightPin(null);
                setQuery(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) {
                  (
                    event as typeof event & { preventBaseUIHandler?: () => void }
                  ).preventBaseUIHandler?.();
                  event.stopPropagation();
                  return;
                }
                if (
                  (event.key === "ArrowLeft" && !query && !event.shiftKey) ||
                  (event.key === "Tab" && event.shiftKey)
                ) {
                  const sidebar = event.currentTarget
                    .closest("[data-model-picker-content]")
                    ?.querySelector("[data-model-picker-sidebar]");
                  const button =
                    sidebar?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ??
                    sidebar?.querySelector<HTMLButtonElement>("button");
                  if (button) {
                    event.preventDefault();
                    event.stopPropagation();
                    button.focus();
                    return;
                  }
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  onRequestClose?.();
                  return;
                }
                if (
                  onFocusEffort &&
                  event.key === "ArrowRight" &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.shiftKey &&
                  event.currentTarget.selectionStart === query.length
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  const key = highlightedRef.current;
                  const pickedNew = key !== null && !selectedKeys.has(key) && select(key) !== null;
                  if (!pickedNew) onFocusEffort();
                  return;
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
            {native.pending && visibleModels.length === 0 ? (
              <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
                Querying native models...
              </p>
            ) : null}
            {native.errors.map((error) => (
              <p role="alert" key={error} className="px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ))}
            <ModelPickerList
              listRef={listRef}
              itemKeys={visibleKeys}
              extraData={extraData}
              renderItem={({ item: key, index }) => {
                const model = modelByKey.get(key);
                return model ? (
                  <ModelListRow
                    index={index}
                    model={model}
                    isSelected={selectedKeys.has(key)}
                    isFavorite={favoriteKeys.has(providerModelKey(model.instanceId, model.slug))}
                    favoriteStarOnHover={query === "" && effectiveRail === FAVORITES_KEY}
                    showProvider={showProvider}
                    jumpLabel={jumpLabels.get(key) ?? null}
                    disabledReason={disabledReason(model.instanceId, model.slug)}
                    onToggleFavorite={toggleFavorite}
                  />
                ) : null;
              }}
            />
            {!native.pending && native.errors.length === 0 ? (
              <ComboboxEmpty className="empty:h-0">
                {query === "" && effectiveRail === FAVORITES_KEY
                  ? "Star a model to pin it here."
                  : "No native models match this query."}
              </ComboboxEmpty>
            ) : null}
            {listFooter}
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});
