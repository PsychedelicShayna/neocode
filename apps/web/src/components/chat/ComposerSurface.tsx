import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/** The prompt and checkout strip share one opaque, frame-aligned background. */
function Shell({
  contextStrip = false,
  className,
  ...props
}: ComponentProps<"div"> & { contextStrip?: boolean }) {
  return (
    <div
      data-slot="composer-shell"
      data-with-context={contextStrip || undefined}
      className={cn(
        "@container/composer-surface group/composer-surface relative isolate w-full border-t border-border bg-background pb-safe",
        "[--chat-composer-drawer-inset:0rem] [--chat-composer-glass-surface:var(--background)] [--chat-composer-outline:var(--border)]",
        className,
      )}
      {...props}
    />
  );
}

function Host({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="composer-host" className={cn("relative z-10 w-full", className)} {...props} />
  );
}

function Main({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-chat-composer-main-surface="true"
      className={cn("group relative z-10 bg-background", className)}
      {...props}
    />
  );
}

function ContextStrip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-context-strip"
      className={cn(
        "group/composer-context relative isolate flex w-full items-center gap-2 overflow-x-clip overflow-y-visible border-t border-border bg-background ps-(--workspace-gutter-start) pe-(--workspace-gutter-end) py-1",
        className,
      )}
      {...props}
    />
  );
}

export const ComposerSurface = { Shell, Host, Main, ContextStrip };
