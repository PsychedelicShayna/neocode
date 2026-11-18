import { BotIcon, ListChecksIcon } from "lucide-react";
import { NATIVE_JOBS_CAPABILITY } from "@t3tools/client-runtime/neopi-native-jobs";
import type {
  NativeSessionFeed,
  NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";
import {
  IDLE_SUBAGENT_FLASH,
  formatActiveDuration,
  liveSubagentCount,
  nativeActiveMs,
  nativeStatusFacts,
  reduceSubagentFlash,
  subagentFlashFor,
  type SubagentFlash,
} from "@t3tools/client-runtime/neopi-native-status";
import { useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { APP_BASE_NAME } from "../../branding";
import { cn } from "../../lib/utils";
import { useNativeSessionRequest, useNativeSessionSlice } from "../../state/neopiNativeSessions";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { useRightPanelStore } from "../../rightPanelStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Each slice is its own subscription: the bar re-renders on the values it shows,
// never on the streamed tokens that change the rest of the feed.
const selectState = (feed: NativeSessionFeed) => feed.session?.state;
const selectCwd = (feed: NativeSessionFeed) => feed.session?.cwd;
const selectConnected = (feed: NativeSessionFeed) => feed.connected;
const selectAgents = (feed: NativeSessionFeed) => feed.agents;
/** Whether the running-subagent count is real: read, failed to read, or not read yet. */
const selectAgentCountState = (feed: NativeSessionFeed) =>
  feed.agentsKnown
    ? "known"
    : feed.reconciliationError?.operation === "subagents"
      ? "unavailable"
      : "unknown";
const selectJobs = (feed: NativeSessionFeed) => feed.jobs;
const selectActivity = (feed: NativeSessionFeed) => feed.activity;
const selectCapabilities = (feed: NativeSessionFeed) => feed.session?.capabilities;

/** How long a spawn, exit or error colour holds before the chip eases back to neutral. */
const FLASH_HOLD_MS = 1200;

/**
 * The subagent count's pending flash. One timer per burst: every event restarts
 * the hold, so overlapping spawns and exits read as a single flash.
 */
function useSubagentFlash(agents: NativeSessionFeed["agents"]): SubagentFlash | null {
  const [flash, dispatch] = useReducer(reduceSubagentFlash, IDLE_SUBAGENT_FLASH);
  const previous = useRef(agents);
  useEffect(() => {
    const event = subagentFlashFor(previous.current, agents);
    previous.current = agents;
    if (event) dispatch(event);
  }, [agents]);
  useEffect(() => {
    if (flash.kind === null) return;
    const timer = setTimeout(() => dispatch("settle"), FLASH_HOLD_MS);
    return () => clearTimeout(timer);
  }, [flash.kind, flash.pulse]);
  return flash.kind;
}

const CHIP_BASE =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring";

function StatusItem(props: {
  readonly label: string;
  readonly title: string;
  /** Container-query classes that drop the item as the main column narrows. */
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <span
      aria-label={props.label}
      title={props.title}
      className={cn("shrink-0 whitespace-nowrap", props.className)}
    >
      {props.children}
    </span>
  );
}

function SubagentChip({ target }: { target: NativeSessionTarget }) {
  const agents = useNativeSessionSlice(target, selectAgents);
  const flash = useSubagentFlash(agents);
  const countState = useNativeSessionSlice(target, selectAgentCountState);
  const live = liveSubagentCount(agents);
  // A started frame proves at least one; otherwise an empty roster is only unknown until the inventory lands.
  const count = countState === "known" || live > 0 ? live : null;
  const label =
    count !== null
      ? `${count} running ${count === 1 ? "subagent" : "subagents"}`
      : countState === "unavailable"
        ? "Subagent count unavailable."
        : "Checking subagents.";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${label}. Open the Agents panel.`}
            data-flash={flash ?? undefined}
            className={cn(
              CHIP_BASE,
              // The colour change is a one-shot transition: quick into the flash, slow back out.
              "bg-primary/10 text-primary transition-colors duration-1000 ease-out",
              "data-[flash]:duration-100",
              "data-[flash=spawn]:bg-success/25 data-[flash=spawn]:text-success-foreground",
              "data-[flash=exit]:bg-destructive/25 data-[flash=exit]:text-destructive-foreground",
              "data-[flash=error]:bg-warning/30 data-[flash=error]:text-warning-foreground",
            )}
            onClick={() => useRightPanelStore.getState().open(target, "agents")}
          />
        }
      >
        <BotIcon className="size-3" />
        {count ?? (countState === "unavailable" ? "—" : "…")}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function JobsChip({
  target,
  reportedRunning,
}: {
  target: NativeSessionTarget;
  /** `get_state.runningJobCount`, used until the job feed has reported its own count. */
  reportedRunning: number | null;
}) {
  const capabilities = useNativeSessionSlice(target, selectCapabilities);
  const jobs = useNativeSessionSlice(target, selectJobs);
  const supported = capabilities?.includes(NATIVE_JOBS_CAPABILITY) === true;
  // Zero only once NeoPi has said so; before its first answer the count is unknown, not none.
  const count = jobs.runningCount ?? reportedRunning;
  const label = !supported
    ? "Background tasks need a newer NeoPi."
    : count === null
      ? "Checking background tasks."
      : `${count} running background ${count === 1 ? "task" : "tasks"}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${label} Open the Background tasks panel.`}
            className={cn(
              CHIP_BASE,
              supported && count !== null && count > 0
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent/50",
            )}
            onClick={() => useRightPanelStore.getState().open(target, "background-tasks")}
          />
        }
      >
        <ListChecksIcon className="size-3" />
        {supported ? (count ?? "…") : "—"}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Working time. While a turn runs it ticks once a second by writing the text
 * node directly, so the bar itself never re-renders for the clock.
 */
function ActiveTime({ target, reported }: { target: NativeSessionTarget; reported: boolean }) {
  const activity = useNativeSessionSlice(target, selectActivity);
  const textRef = useRef<HTMLSpanElement>(null);
  const running = activity.openedAt !== null;
  useEffect(() => {
    if (!running) return;
    const update = () => {
      if (textRef.current)
        textRef.current.textContent = formatActiveDuration(nativeActiveMs(activity, Date.now()));
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [running, activity]);
  const elapsed = nativeActiveMs(activity, Date.now());
  // Hidden until the first second of work, as in the NeoPi TUI.
  if (!running && elapsed < 1000) return null;
  return (
    <StatusItem
      label="Active time"
      title={
        reported
          ? "Time NeoPi spent working in this session."
          : "Time the agent spent working while NeoCode watched this session."
      }
      className="hidden @xl/status-bar:inline"
    >
      <span ref={textRef}>{formatActiveDuration(elapsed)}</span>
    </StatusItem>
  );
}

function ContextMeter({
  context,
}: {
  context: NonNullable<ReturnType<typeof nativeStatusFacts>["context"]>;
}) {
  const percent = Math.min(100, context.percent);
  return (
    <StatusItem
      label="Context"
      title={`${context.tokens?.toLocaleString() ?? "Unknown"} / ${context.contextWindow.toLocaleString()} context tokens`}
      className="hidden items-center gap-1.5 @lg/status-bar:inline-flex"
    >
      <span
        role="meter"
        aria-label="Context utilization"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1 w-10 overflow-hidden rounded-full bg-muted"
      >
        <span
          className={cn(
            "block h-full",
            percent >= 90 ? "bg-destructive" : percent >= 75 ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${percent}%` }}
        />
      </span>
      {context.percent.toFixed(0)}%
    </StatusItem>
  );
}

/**
 * Compact session status under the composer, spanning the main column. Facts come
 * from NeoPi's `get_state`, re-read by the feed after turns, compaction, journal
 * commits, model changes and (for a terminal-owned session) on a slow timer while
 * the tab is visible, plus the feed's lifecycle frames; a value NeoPi did not
 * report is left out rather than guessed.
 */
export function NativeSessionStatusBar({ target }: { target: NativeSessionTarget }) {
  const state = useNativeSessionSlice(target, selectState);
  const cwd = useNativeSessionSlice(target, selectCwd);
  const connected = useNativeSessionSlice(target, selectConnected);
  const request = useNativeSessionRequest(target);
  // Selecting a session (or its connection coming back) reads NeoPi's current
  // telemetry; the reconciler's own reads cover everything after that. The
  // result lands in the feed through the request atom.
  useEffect(() => {
    if (!connected) return;
    void request({ type: "get_state", includeDump: false }).catch(() => undefined);
  }, [connected, request]);
  const facts = useMemo(() => (state ? nativeStatusFacts(state) : null), [state]);
  const gitStatus = useEnvironmentQuery(
    cwd ? vcsEnvironment.status({ environmentId: target.environmentId, input: { cwd } }) : null,
  );
  const project = cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
  const branch = gitStatus.data?.isRepo ? gitStatus.data.refName : null;
  return (
    <div
      role="status"
      aria-label="Session status"
      className="@container/status-bar flex h-6 shrink-0 items-center gap-3 border-t border-border/60 bg-background px-3 text-xs text-muted-foreground tabular-nums sm:px-4"
    >
      <span className="hidden shrink-0 font-semibold text-foreground/70 @4xl/status-bar:inline">
        {APP_BASE_NAME}
      </span>
      <span
        className="min-w-0 flex-1 truncate"
        title={cwd ?? undefined}
        aria-label="Project and branch"
      >
        {project}
        {branch ? <span className="text-muted-foreground/70"> · {branch}</span> : null}
        {connected ? null : <span className="text-warning-foreground"> · disconnected</span>}
      </span>
      {facts?.hostname ? (
        <StatusItem
          label="Host"
          title="The machine running NeoPi"
          className="hidden @4xl/status-bar:inline"
        >
          {facts.hostname}
        </StatusItem>
      ) : null}
      {facts?.model ? (
        <StatusItem
          label="Model"
          title={`${facts.model}${facts.thinkingLevel ? `, effort ${facts.thinkingLevel}` : ""}`}
          className="inline-block max-w-[40%] truncate text-foreground/80"
        >
          {facts.model}
          {facts.thinkingLevel ? ` · ${facts.thinkingLevel}` : ""}
        </StatusItem>
      ) : null}
      {facts?.context ? <ContextMeter context={facts.context} /> : null}
      {facts && facts.cacheHitPercent !== null ? (
        <StatusItem
          label="Cache hit rate"
          title="Cache reads as a share of all prompt tokens in this session"
          className="hidden @2xl/status-bar:inline"
        >
          cache {facts.cacheHitPercent.toFixed(0)}%
        </StatusItem>
      ) : null}
      {facts && facts.tokensPerSecond !== null ? (
        <StatusItem
          label="Output speed"
          title="Output tokens per second, as NeoPi measured the latest response"
          className="hidden @2xl/status-bar:inline"
        >
          {facts.tokensPerSecond.toFixed(1)} tok/s
        </StatusItem>
      ) : null}
      {facts?.cost ? (
        <StatusItem
          label="Session cost"
          title={
            facts.cost.partial
              ? "Recorded session cost including completed subagents. Advisor spend is not restored yet."
              : "Recorded session cost including completed subagents and advisors."
          }
          className="hidden @3xl/status-bar:inline"
        >
          ${facts.cost.amount.toFixed(2)}
        </StatusItem>
      ) : null}
      <ActiveTime target={target} reported={state?.activeTimeMs !== undefined} />
      <span className="flex shrink-0 items-center gap-1">
        <SubagentChip target={target} />
        <JobsChip target={target} reportedRunning={facts?.runningJobCount ?? null} />
      </span>
    </div>
  );
}
