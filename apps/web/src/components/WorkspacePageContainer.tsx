import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";

export type WorkspacePageWidth = "readable" | "wide" | "expanded";

const WIDTH_CLASS: Record<WorkspacePageWidth, string> = {
  readable: "max-w-4xl",
  wide: "max-w-5xl",
  expanded: "max-w-6xl",
};

export function WorkspacePageContainer({
  width = "readable",
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & { readonly width?: WorkspacePageWidth }) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-6 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) pt-6 pb-12",
        WIDTH_CLASS[width],
        className,
      )}
      {...props}
    />
  );
}
