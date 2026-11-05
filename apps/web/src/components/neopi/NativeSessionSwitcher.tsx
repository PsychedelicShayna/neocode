import {
  nativeSessionKey,
  type NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils";
import { useNativeSessionSwitcher } from "../../state/nativeSessionSwitcher";
import { nativeSessionAtoms } from "../../state/neopiNativeSessions";
import { useNativeSessionTabPresentation } from "./useNativeSessionTabPresentation";

function SwitcherRow({
  tab,
  selected,
}: {
  readonly tab: NativeSessionTarget;
  readonly selected: boolean;
}) {
  const { title, identity, status } = useNativeSessionTabPresentation(
    tab,
    nativeSessionAtoms.cached(tab) !== undefined,
  );
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <div
      ref={ref}
      role="option"
      aria-selected={selected}
      className={cn(
        "flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
        selected ? "bg-accent text-accent-foreground" : "text-foreground",
      )}
    >
      <span
        role="img"
        aria-label={status.label}
        className={cn("size-2 shrink-0 rounded-full", status.dot)}
      />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{identity.label}</span>
    </div>
  );
}

/**
 * The Ctrl+Tab session list in recently-used order, shown while the modifier is
 * held. It never takes focus: the keyboard stays with whatever had it.
 */
export function NativeSessionSwitcher() {
  const order = useNativeSessionSwitcher((state) => state.order);
  const index = useNativeSessionSwitcher((state) => state.index);
  if (!order) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[20vh] z-[130] flex justify-center px-4">
      <div
        role="listbox"
        aria-label="Switch session"
        className="dropdown-glass max-h-[50vh] w-full max-w-md overflow-y-auto rounded-lg p-1 shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]"
      >
        {order.map((tab, position) => (
          <SwitcherRow key={nativeSessionKey(tab)} tab={tab} selected={position === index} />
        ))}
      </div>
    </div>
  );
}
