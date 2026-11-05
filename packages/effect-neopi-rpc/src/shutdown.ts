/** Each owned RPC peer gets stdin EOF first, then this much SIGTERM grace. */
export const DEFAULT_CLOSE_GRACE_MS = 5_000;
/** How long to drain stdout/stderr after process death before releasing readers. */
export const DEFAULT_STDIO_DRAIN_MS = 250;
/**
 * EOF and TERM windows, the final exit receipt wait, and process-group/reader slack.
 * A supervising backend's own force-kill deadline must exceed this child budget.
 */
export const DEFAULT_CLOSE_BUDGET_MS = DEFAULT_CLOSE_GRACE_MS * 3 + DEFAULT_STDIO_DRAIN_MS + 1_500;
