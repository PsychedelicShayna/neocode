import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../lib/utils";
import { Tab } from "./ui/tab";

const MODIFIERS = [restrictToHorizontalAxis, restrictToFirstScrollableAncestor];
// A tab is also a click target; a drag starts only once the pointer has really moved.
const ACTIVATION_CONSTRAINT = { distance: 6 };

/**
 * Pointer-drag reordering for a row of `SortableTab`s. `onMove` receives the
 * dragged id and the index it was dropped on; persisting the order is the caller's.
 */
export function SortableTabs({
  ids,
  onMove,
  children,
}: {
  readonly ids: readonly string[];
  readonly onMove: (id: string, toIndex: number) => void;
  readonly children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: ACTIVATION_CONSTRAINT }),
  );
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const toIndex = ids.indexOf(String(over.id));
    if (toIndex !== -1) onMove(String(active.id), toIndex);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={MODIFIERS}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={ids as string[]} strategy={horizontalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

/** A `Tab` that can be dragged within its `SortableTabs`. */
export function SortableTab({
  id,
  style,
  className,
  ...props
}: ComponentProps<typeof Tab> & { readonly id: string }) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id });
  return (
    <Tab
      ref={setNodeRef}
      style={{ ...style, transform: CSS.Translate.toString(transform), transition }}
      className={cn("relative", isDragging && "z-10 shadow-md", className)}
      {...listeners}
      {...props}
    />
  );
}
