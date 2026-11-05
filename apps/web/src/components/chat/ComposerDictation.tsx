import { MicIcon, MicOffIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { dictationStatusLabel, type ComposerDictationControl } from "./composerDictation.logic";

/** The button must not take focus from the composer's caret. */
const keepComposerFocus = (event: { preventDefault(): void }) => event.preventDefault();

/**
 * Click to start, click again to stop. The recording state is static, never animated.
 * Always present on the desktop: when dictation cannot work the button is disabled
 * and its tooltip says why and what fixes it.
 */
export function ComposerDictationButton(props: {
  readonly dictation: ComposerDictationControl;
  readonly shortcut: string | null;
}) {
  const { dictation, shortcut } = props;
  const capturing = dictation.phase === "starting" || dictation.phase === "recording";
  const unavailable = dictation.phase === "idle" ? dictation.unavailableReason : null;
  const label = capturing ? "Stop dictation" : "Dictate";
  const withShortcut = shortcut ? `${label} (${shortcut})` : label;
  const icon = capturing ? <MicOffIcon /> : <MicIcon />;
  const buttonProps = {
    type: "button",
    variant: capturing ? "destructive" : "ghost",
    size: "icon-sm",
    "aria-pressed": capturing,
    "data-composer-dictation": dictation.phase,
    onPointerDown: keepComposerFocus,
    onClick: dictation.toggle,
  } as const;
  // A disabled button receives no pointer events, so the reason hangs off a wrapper.
  if (unavailable)
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button
            {...buttonProps}
            disabled
            aria-label={`${label} unavailable: ${unavailable}`}
            data-composer-dictation-unavailable=""
          >
            {icon}
          </Button>
        </TooltipTrigger>
        <TooltipPopup className="max-w-72">{unavailable}</TooltipPopup>
      </Tooltip>
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            {...buttonProps}
            disabled={dictation.phase === "transcribing"}
            aria-label={withShortcut}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipPopup>{withShortcut}</TooltipPopup>
    </Tooltip>
  );
}

/** The live transcript while capturing, and NeoPi's own message when a capture fails. */
export function composerDictationBannerItems(
  dictation: ComposerDictationControl,
  shortcut: string | null,
): readonly ComposerBannerStackItem[] {
  const items: ComposerBannerStackItem[] = [];
  if (dictation.phase !== "idle")
    items.push({
      id: "composer-dictation",
      variant: "info",
      priority: "activity",
      icon: <MicIcon />,
      title: dictationStatusLabel(dictation.phase, shortcut),
      ...(dictation.preview ? { description: dictation.preview } : {}),
    });
  if (dictation.notice)
    items.push({
      id: "composer-dictation-notice",
      variant: "error",
      priority: "urgent",
      icon: <MicOffIcon />,
      title: dictation.notice,
      dismissLabel: "Dismiss",
      onDismiss: dictation.dismissNotice,
    });
  return items;
}
