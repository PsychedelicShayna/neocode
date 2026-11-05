import type {
  ProviderInstanceId,
  ProviderDriverKind,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { memo, useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
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
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import { TooltipProvider } from "../ui/tooltip";
import { providerModelKey } from "../../modelOrdering";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
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
  onInstanceModelChange: (
    instanceId: ProviderInstanceId,
    model: string,
    choice?: NativeModelChoice,
  ) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedRail, setSelectedRail] = useState<string | null>(() => {
    if (!props.model) return null;
    const group = nativeSwitcherGroup({ slug: props.model, name: props.model });
    return group === ROLES_GROUP ? ROLES_KEY : providerRailKey(group);
  });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const highlightedRef = useRef<string | null>(null);
  const serverKeybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindings = props.keybindings ?? serverKeybindings;
  const favorites = useClientSettings().favorites;
  const updateSettings = useUpdateClientSettings();
  const favoriteKeys = useMemo(
    () => new Set(favorites.map((favorite) => providerModelKey(favorite.provider, favorite.model))),
    [favorites],
  );
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
  const queried = useMemo(
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
  // The rail and Favorites describe the whole catalog. They keep the last unfiltered
  // answer while a search is typed or refetched instead of collapsing to the matches.
  const [browse, setBrowse] = useState<ReadonlyArray<NativeSwitcherModel>>(EMPTY_MODELS);
  const browseModels = query === "" && !native.pending ? queried : browse;
  if (browseModels !== browse) setBrowse(browseModels);
  // While NeoPi ranks a typed query, the unfiltered catalog narrows locally so results appear
  // at once; the ranked answer then replaces them, keeping the user's highlighted row in place.
  const highlightPinRef = useRef<{ key: string; index: number } | null>(null);
  const searchModels = useMemo(
    () =>
      native.pending
        ? filterNativeSwitcherModels(browseModels, query)
        : pinNativeSwitcherModel(queried, highlightPinRef.current),
    [native.pending, browseModels, query, queried],
  );
  const models = query === "" ? browseModels : searchModels;
  const allModelsByKey = useMemo(
    () =>
      new Map(models.map((model) => [modelPickerModelKey(model.instanceId, model.slug), model])),
    [models],
  );
  const rail = useMemo<ReadonlyArray<ModelPickerRailEntry>>(() => {
    const providers = [
      ...new Set(
        applicableEntries
          .flatMap((entry) =>
            (props.modelOptionsByInstance.get(entry.instanceId) ?? []).map(nativeSwitcherGroup),
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
  }, [applicableEntries, props.modelOptionsByInstance, browseModels]);
  const effectiveRail = rail.some((entry) => entry.key === selectedRail)
    ? selectedRail
    : (rail[0]?.key ?? null);
  const visibleModels = useMemo(() => {
    if (query !== "") return models;
    if (effectiveRail === ROLES_KEY) return models.filter((model) => model.group === ROLES_GROUP);
    if (effectiveRail === FAVORITES_KEY)
      return models.filter(
        (model) =>
          model.group !== ROLES_GROUP &&
          favoriteKeys.has(providerModelKey(model.instanceId, model.slug)),
      );
    return models.filter((model) => providerRailKey(model.group) === effectiveRail);
  }, [models, query, effectiveRail, favoriteKeys]);
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
      const parsed = parseModelPickerModelKey(key);
      const model = parsed
        ? visibleModels.find(
            (row) => row.instanceId === parsed.instanceId && row.slug === parsed.slug,
          )
        : undefined;
      if (!model || disabledReason(model.instanceId, model.slug)) return;
      if (additive && props.onToggleModel) props.onToggleModel(model.instanceId, model.slug);
      else props.onInstanceModelChange(model.instanceId, model.slug, model.choice);
    },
    [visibleModels, disabledReason, props.onToggleModel, props.onInstanceModelChange],
  );
  const toggleFavorite = useCallback(
    (instanceId: ProviderInstanceId, slug: string) => {
      const key = providerModelKey(instanceId, slug);
      void updateSettings({
        favorites: favoriteKeys.has(key)
          ? favorites.filter(
              (favorite) => providerModelKey(favorite.provider, favorite.model) !== key,
            )
          : [...favorites, { provider: instanceId, model: slug }],
      });
    },
    [favorites, favoriteKeys, updateSettings],
  );
  const focusSearch = useCallback(() => searchInputRef.current?.focus({ preventScroll: true }), []);
  const selectRail = useCallback(
    (key: string) => {
      highlightedRef.current = null;
      highlightPinRef.current = null;
      setSelectedRail(key);
      setQuery("");
      focusSearch();
    },
    [focusSearch],
  );
  // The popover's own focus management can land on the rail or the trigger first,
  // so the search box claims focus again after layout, the next frame and the next task.
  useLayoutEffect(() => {
    focusSearch();
    const frame = window.requestAnimationFrame(focusSearch);
    const timeout = window.setTimeout(focusSearch, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [focusSearch]);
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
        const index = rail.findIndex((entry) => entry.key === effectiveRail);
        const next =
          rail[
            (index + (command === "modelPicker.nextProvider" ? 1 : -1) + rail.length) % rail.length
          ];
        if (next) selectRail(next.key);
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
    rail,
    effectiveRail,
    selectRail,
    jumpKeys,
    select,
    props.onRequestClose,
  ]);
  const extraData = useMemo(
    () => ({ selectedKeys, jumpLabels, disabledReason, favoriteKeys, searching: query !== "" }),
    [selectedKeys, jumpLabels, disabledReason, favoriteKeys, query],
  );
  const showProvider = query !== "" || effectiveRail === FAVORITES_KEY;

  return (
    <TooltipProvider delay={0}>
      <div
        className="flex h-[min(26rem,var(--available-height,70vh))] min-h-0 w-[min(36rem,calc(100vw-2rem))] overflow-hidden rounded-[calc(var(--radius-lg)-1px)]"
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
          multiple={props.onToggleModel !== undefined}
          value={
            props.onToggleModel
              ? [...selectedKeys]
              : modelPickerModelKey(props.activeInstanceId, props.model)
          }
          onItemHighlighted={(key, details) => {
            highlightedRef.current = typeof key === "string" ? key : null;
            highlightPinRef.current =
              typeof key === "string" && details.reason !== "none" && details.index >= 0
                ? { key, index: details.index }
                : highlightPinRef.current;
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
                highlightPinRef.current = null;
                setQuery(event.target.value);
              }}
              onKeyDown={(event) => {
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
            <div className="min-h-0 flex-1 overflow-hidden">
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
                        isFavorite={favoriteKeys.has(
                          providerModelKey(model.instanceId, model.slug),
                        )}
                        showProvider={showProvider}
                        jumpLabel={jumpLabels.get(key) ?? null}
                        disabledReason={disabledReason(model.instanceId, model.slug)}
                        onToggleFavorite={() => toggleFavorite(model.instanceId, model.slug)}
                      />
                    ) : null;
                  }}
                  estimatedItemSize={44}
                  drawDistance={480}
                  recycleItems
                  className="h-full overflow-x-hidden overscroll-y-contain"
                />
              </ComboboxListVirtualized>
            </div>
            {!native.pending && native.errors.length === 0 ? (
              <ComboboxEmpty className="empty:h-0">
                {query === "" && effectiveRail === FAVORITES_KEY
                  ? "Star a model to pin it here."
                  : "No native models match this query."}
              </ComboboxEmpty>
            ) : null}
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});
