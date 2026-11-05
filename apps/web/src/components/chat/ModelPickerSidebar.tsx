import { Toolbar } from "@base-ui/react/toolbar";
import { StarIcon } from "lucide-react";
import { memo } from "react";
import { cn } from "~/lib/utils";

export interface ModelPickerRailEntry {
  readonly key: string;
  readonly label: string;
  /** Roles and Favorites sit above the providers, set apart by a divider. */
  readonly pinned: boolean;
}

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  entries: ReadonlyArray<ModelPickerRailEntry>;
  /** `null` while a search spans every provider, so no entry reads as the active filter. */
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onFocusSearch: () => void;
}) {
  return (
    <Toolbar.Root
      className="w-28 shrink-0 overflow-y-auto border-r border-border p-1.5 sm:w-36"
      data-model-picker-sidebar="true"
      aria-label="Roles, favorites and inference providers"
      orientation="vertical"
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" && !event.altKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          props.onFocusSearch();
        }
      }}
    >
      {props.entries.map((entry, index) => (
        <div key={entry.key}>
          {!entry.pinned && props.entries[index - 1]?.pinned ? (
            <div role="separator" className="mx-1 my-1.5 border-t border-border" />
          ) : null}
          <Toolbar.Button
            type="button"
            aria-pressed={props.selectedKey === entry.key}
            className={cn(
              "flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-2 text-left text-xs text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
              props.selectedKey === entry.key && "bg-accent font-medium text-accent-foreground",
            )}
            onClick={() => props.onSelect(entry.key)}
            title={entry.label}
          >
            {entry.key === "favorites" ? <StarIcon className="size-3 shrink-0" /> : null}
            <span className="truncate">{entry.label}</span>
          </Toolbar.Button>
        </div>
      ))}
    </Toolbar.Root>
  );
});
