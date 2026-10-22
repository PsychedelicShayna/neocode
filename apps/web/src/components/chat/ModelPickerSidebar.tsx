import { Toolbar } from "@base-ui/react/toolbar";
import { memo } from "react";
import { cn } from "~/lib/utils";

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  groups: ReadonlyArray<string>;
  selectedGroup: string | null;
  onSelectGroup: (group: string | null) => void;
  onFocusSearch: () => void;
}) {
  return (
    <Toolbar.Root
      className="w-32 shrink-0 overflow-y-auto border-r border-border bg-background p-1.5 sm:w-44"
      data-model-picker-sidebar="true"
      aria-label="Inference providers and roles"
      orientation="vertical"
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" && !event.altKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          props.onFocusSearch();
        }
      }}
    >
      {[null, ...props.groups].map((group) => (
        <Toolbar.Button
          key={group === null ? "all" : `group:${group}`}
          type="button"
          aria-pressed={props.selectedGroup === group}
          className={cn(
            "block w-full cursor-pointer truncate rounded-sm px-2.5 py-2 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
            props.selectedGroup === group && "bg-accent font-medium text-accent-foreground",
          )}
          onClick={() => props.onSelectGroup(group)}
          title={group ?? "All models"}
        >
          {group ?? "All models"}
        </Toolbar.Button>
      ))}
    </Toolbar.Root>
  );
});
