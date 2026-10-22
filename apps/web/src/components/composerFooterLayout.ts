export const COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX = 620;
export const COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX = 780;

export function shouldUseCompactComposerFooter(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  const breakpoint = options?.hasWideActions
    ? COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX
    : COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX;
  return width !== null && width < breakpoint;
}

export function shouldUseCompactComposerPrimaryActions(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  if (!options?.hasWideActions) {
    return false;
  }
  return width !== null && width < COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX;
}

export interface RestingComposerControlsMeasurement {
  gap: number;
  naturalFixedWidth: number;
  minimumFixedWidth: number;
  blockWidths: readonly number[];
  overflowWidth: number;
  iconOnlyBlockWidths?: readonly number[];
}

function restingComposerControlsWidth(
  input: RestingComposerControlsMeasurement,
  hiddenCount: number,
  fixedWidth = input.naturalFixedWidth,
  iconOnlyCount = 0,
): number {
  const { blockWidths, gap } = input;
  const visibleCount = blockWidths.length - hiddenCount;
  return (
    fixedWidth +
    blockWidths
      .slice(0, visibleCount)
      .reduce(
        (sum, width, index) =>
          sum +
          (index >= blockWidths.length - iconOnlyCount
            ? (input.iconOnlyBlockWidths?.[index] ?? width)
            : width),
        0,
      ) +
    (hiddenCount > 0 ? input.overflowWidth : 0) +
    gap * (visibleCount + (hiddenCount > 0 ? 1 : 0))
  );
}

/**
 * The width the resting controls take with nothing moved into overflow.
 *
 * The context strip reserves this much for the composer before deciding
 * whether its own labels may expand. Judging against the currently visible
 * controls instead lets the strip expand into space the composer just gave
 * up, which shrinks the host, hides the controls again, and repeats.
 */
export function resolveRestingComposerControlsNaturalWidth(
  input: RestingComposerControlsMeasurement,
): number {
  return restingComposerControlsWidth(input, 0);
}

/**
 * Fit footer controls using natural widths: remove trailing labels first,
 * then move trailing blocks into overflow. Resting and expanded share this
 * decision, including the slack needed to safely restore controls.
 *
 * Trailing blocks compact before the model picker shrinks. Once they are all in
 * the overflow menu, the picker may contract to its minimum readable width;
 * below that the whole cluster hides rather than clipping.
 */
const RESTING_CONTROLS_SLACK_PX = 1;

export function resolveRestingComposerControlsLayout(
  input: RestingComposerControlsMeasurement & {
    hostWidth: number;
    previous?: { hiddenCount: number; iconOnlyCount?: number; visible: boolean };
  },
): { hiddenCount: number; iconOnlyCount?: number; visible: boolean } {
  const { blockWidths, hostWidth, previous } = input;
  const iconSteps = input.iconOnlyBlockWidths ? blockWidths.length : 0;
  const previousStep = previous
    ? previous.hiddenCount > 0
      ? iconSteps + Math.min(previous.hiddenCount, blockWidths.length)
      : Math.min(previous.iconOnlyCount ?? 0, iconSteps)
    : 0;
  let step = 0;
  const widthAtStep = (candidate: number, fixedWidth = input.naturalFixedWidth) =>
    restingComposerControlsWidth(
      input,
      Math.max(0, candidate - iconSteps),
      fixedWidth,
      Math.min(candidate, iconSteps),
    );
  // Promotions need a pixel of slack: recovering a flexible picker's natural
  // width can jitter by a fraction of a pixel across renders. Demotions are
  // immediate so a threshold cannot clip or flip React between layouts.
  while (
    step < iconSteps + blockWidths.length &&
    widthAtStep(step) > hostWidth - (step < previousStep ? RESTING_CONTROLS_SLACK_PX : 0)
  ) {
    step += 1;
  }
  const hiddenCount = Math.max(0, step - iconSteps);
  const iconOnlyCount = Math.min(step, iconSteps);
  const minimumWidth = widthAtStep(step, input.minimumFixedWidth);
  const visible =
    previous && !previous.visible
      ? minimumWidth <= hostWidth - RESTING_CONTROLS_SLACK_PX
      : minimumWidth <= hostWidth;
  return { hiddenCount, ...(input.iconOnlyBlockWidths ? { iconOnlyCount } : {}), visible };
}

export function resolveScrollToEndClearance(input: {
  overlayHeight: number;
  mainSurfaceTop: number;
  button: { left: number; right: number };
  attachments: ReadonlyArray<{ top: number; left: number; right: number }>;
}): number {
  let contentTop = input.mainSurfaceTop;
  let top = contentTop;
  for (const attachment of input.attachments) {
    contentTop = Math.min(contentTop, attachment.top);
    if (attachment.left < input.button.right && attachment.right > input.button.left) {
      top = Math.min(top, attachment.top);
    }
  }
  return Math.ceil(input.overlayHeight - (top - contentTop));
}
