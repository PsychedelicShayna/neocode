import type { ComponentProps } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { useNeoPiSessionStatus } from "./NeoPiSessionStatus";

type Props = ComponentProps<typeof ProviderModelPicker> & { threadRef: ScopedThreadRef | null };

export function NeoPiSessionModelPicker({ threadRef, ...props }: Props) {
  return threadRef
    ? <ObservedModelPicker key={JSON.stringify(threadRef)} threadRef={threadRef} {...props} />
    : <ProviderModelPicker {...props} />;
}

function ObservedModelPicker({ threadRef, ...props }: Omit<Props, "threadRef"> & { threadRef: ScopedThreadRef }) {
  const status = useNeoPiSessionStatus(threadRef);
  const label = status.status === "observed"
    ? `${status.model?.name ?? status.model?.id ?? "Model unavailable"} · ${status.thinkingLevel ?? "Effort unavailable"}`
    : status.status === "loading" ? "Reading native model..." : "Native model unavailable";
  return <ProviderModelPicker {...props} triggerLabel={label}
    triggerAriaLabel={`Current native model and effort: ${label}. Choose the next model.`} />;
}
