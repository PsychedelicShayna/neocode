import { memo } from "react";
import { CheckIcon } from "lucide-react";
import { ComboboxItem } from "../ui/combobox";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { modelPickerModelKey } from "./modelPickerKeys";
import {
  NATIVE_FACT_COLUMNS,
  nativeSwitcherFactCells,
  type NativeSwitcherModel,
} from "./neopiModelSwitcher";

export const NATIVE_MODEL_GRID =
  "grid grid-cols-[minmax(15rem,1fr)_repeat(6,5.5rem)_3rem] items-center gap-2";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: NativeSwitcherModel;
  isSelected: boolean;
  jumpLabel?: string | null;
  disabledReason?: string | null;
}) {
  const cells = nativeSwitcherFactCells(props.model);
  const row = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={modelPickerModelKey(props.model.instanceId, props.model.slug)}
      disabled={Boolean(props.disabledReason)}
      className="group w-full cursor-pointer"
    >
      <div className={`${NATIVE_MODEL_GRID} w-full py-1`}>
        <div className="min-w-0 text-left">
          <div className="flex items-center gap-1.5">
            {props.isSelected ? (
              <CheckIcon className="size-3 shrink-0" aria-label="Selected" />
            ) : null}
            <span className="truncate text-xs font-medium" title={props.model.slug}>
              {props.model.slug}
            </span>
          </div>
          <div
            className="mt-1 truncate text-xs text-muted-foreground"
            title={`${props.model.description || props.model.name}, ${props.model.instanceDisplayName}`}
          >
            {props.model.description || props.model.name}
            {props.model.isUnavailable ? ", unavailable" : ""}
          </div>
        </div>
        {cells.map((value, index) => (
          <span
            key={NATIVE_FACT_COLUMNS[index]}
            className="truncate text-right text-xs tabular-nums text-muted-foreground"
            aria-label={`${NATIVE_FACT_COLUMNS[index]}: ${value}`}
            title={`${NATIVE_FACT_COLUMNS[index]}: ${value}`}
          >
            {value}
          </span>
        ))}
        <span className="justify-self-end">
          {props.jumpLabel ? <Kbd>{props.jumpLabel}</Kbd> : null}
        </span>
      </div>
    </ComboboxItem>
  );
  return props.disabledReason ? (
    <Tooltip>
      <TooltipTrigger render={<div>{row}</div>} />
      <TooltipPopup side="top">{props.disabledReason}</TooltipPopup>
    </Tooltip>
  ) : (
    row
  );
});
