import { type ReactNode, useRef } from "react";

import { Sheet, SheetPopup } from "./ui/sheet";
import { previewBridge } from "./preview/previewBridge";

export function RightPanelSheet(props: {
  animationDurationMs: number;
  children: ReactNode;
  open: boolean;
  browserSurface?: boolean;
  onClose: () => void;
}) {
  const popupRef = useRef<HTMLDivElement | null>(null);
  const hostedBrowser = props.browserSurface && previewBridge !== null;

  return (
    <Sheet
      open={props.open}
      // The persistent guest lives outside the popup: do not hide it from assistive
      // technology or trap focus away from it. Other right-panel sheets stay modal.
      modal={!hostedBrowser}
      onOpenChange={(open, details) => {
        if (!open && hostedBrowser) {
          const viewport = popupRef.current?.parentElement;
          const target = details.event.target;
          // Preserve modal-sheet dismissal semantics: only its own backdrop or
          // viewport dismisses, not the external guest, mini-player or another dialog.
          if (
            details.reason === "focus-out" ||
            (details.reason === "outside-press" &&
              target !== viewport &&
              target !== viewport?.previousElementSibling)
          ) {
            details.cancel();
            return;
          }
        }
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        ref={popupRef}
        transitionDurationMs={props.animationDurationMs}
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(42vw,28rem)] min-w-80 max-w-[28rem] max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0 wco:mt-(--workspace-topbar-height) wco:h-[calc(100%-var(--workspace-topbar-height))] wco:max-h-[calc(100%-var(--workspace-topbar-height))]"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
