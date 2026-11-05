import { memo } from "react";
import { CheckIcon, StarIcon } from "lucide-react";
import { ComboboxItem } from "../ui/combobox";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { MenuShortcut } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { modelPickerModelKey } from "./modelPickerKeys";
import {
  NATIVE_FACT_COLUMNS,
  ROLES_GROUP,
  nativeSwitcherFactCells,
  nativeSwitcherFactSummary,
  type NativeSwitcherModel,
} from "./neopiModelSwitcher";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: NativeSwitcherModel;
  isSelected: boolean;
  isFavorite: boolean;
  /** Names the provider in the secondary text, for lists that mix providers. */
  showProvider: boolean;
  jumpLabel?: string | null;
  disabledReason?: string | null;
  onToggleFavorite: () => void;
}) {
  const { model } = props;
  const isRole = model.group === ROLES_GROUP;
  const secondary = [
    isRole ? (model.resolvedSelector ? `→ ${model.resolvedSelector}` : null) : null,
    props.showProvider && !isRole ? (model.subProvider ?? model.instanceDisplayName) : null,
    nativeSwitcherFactSummary(model),
    model.isUnavailable ? "unavailable" : null,
  ]
    .filter((part) => part)
    .join(" · ");
  const factDetail = nativeSwitcherFactCells(model)
    .map((value, index) => `${NATIVE_FACT_COLUMNS[index]}: ${value}`)
    .join("\n");
  const favoriteLabel = props.isFavorite ? "Remove from favorites" : "Add to favorites";

  const row = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={modelPickerModelKey(model.instanceId, model.slug)}
      disabled={Boolean(props.disabledReason)}
      className={cn(
        "group relative mx-1.5 w-[calc(100%-0.75rem)] !min-w-0 max-w-full cursor-pointer",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
      )}
    >
      <Tooltip>
        <TooltipTrigger render={<div className="min-w-0 flex-1 text-left" />}>
          <div className="flex min-w-0 items-center gap-1.5">
            {props.isSelected ? (
              <CheckIcon className="size-3 shrink-0" aria-label="Selected" />
            ) : null}
            <span className="truncate text-xs font-medium leading-snug">{model.name}</span>
            {model.badge === "new" ? (
              <Badge variant="outline" size="sm">
                New
              </Badge>
            ) : null}
          </div>
          {secondary ? (
            <div className="mt-0.5 truncate text-xs leading-snug text-muted-foreground/70">
              {secondary}
            </div>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="right" align="center" className="whitespace-pre-line">
          {[model.slug, model.description, factDetail].filter(Boolean).join("\n")}
        </TooltipPopup>
      </Tooltip>
      <div className="flex shrink-0 items-center gap-1.5">
        {props.jumpLabel ? <MenuShortcut>{props.jumpLabel}</MenuShortcut> : null}
        {isRole ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  className="-mr-1 shrink-0"
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onToggleFavorite();
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                  disabled={Boolean(props.disabledReason)}
                  aria-label={favoriteLabel}
                  aria-pressed={props.isFavorite}
                >
                  <StarIcon
                    className={cn(
                      "size-3.5 sm:size-3",
                      props.isFavorite && "fill-current text-warning",
                    )}
                  />
                </Button>
              }
            />
            <TooltipPopup side="top" align="center">
              {favoriteLabel}
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
    </ComboboxItem>
  );
  return props.disabledReason ? (
    <Tooltip>
      <TooltipTrigger render={<div>{row}</div>} />
      <TooltipPopup side="left" align="center">
        {props.disabledReason}
      </TooltipPopup>
    </Tooltip>
  ) : (
    row
  );
});
