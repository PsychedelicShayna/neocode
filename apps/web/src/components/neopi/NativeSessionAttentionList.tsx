import { useAtomValue } from "@effect/atom-react";
import {
  managedSessionSidebarLabel,
  nativeSessionProjectLabel,
  nativeSessionSection,
  partitionNativeSessions,
  type NativeSessionEntry,
  type NativeSessionSections,
  type NativeSessionStatus,
  type NativeSessionVisitState,
} from "@t3tools/client-runtime/neopi-native-session-attention";
import {
  nativeSessionKey,
  type NativeSessionList,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  NeoPiManagedSessionLifecycle,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  agentIdentity,
  nativeSessionIdentityKey,
  type AgentIdentity,
} from "@t3tools/shared/agentNames";
import * as Schema from "effect/Schema";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  GitBranchIcon,
  LockIcon,
  MessageCircleQuestionIcon,
  PlusIcon,
  TerminalIcon,
  Undo2Icon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { readLocalApi } from "../../localApi";
import { nativeSessionAtoms, useNativeSessionSelection } from "../../state/neopiNativeSessions";
import {
  establishNativeSessionBaseline,
  markNativeSessionVisited,
  useNativeSessionVisits,
} from "../../state/neopiNativeSessionVisits";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { AgentLabel } from "./AgentLabel";
import { SidebarGroup } from "../ui/sidebar";
import { prStatusIndicator } from "../ThreadStatusIndicators";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { OpenNativeSession } from "./NativeSessionSidebar";

// Rows mounted at first and added per step as the list scrolls near its end.
// Hundreds of sessions are normal; mounting all of them made sidebar resizing
// lay out every row on each frame.
const ROWS_STEP = 60;
// The settled shelf is a deep tail: recent history first, the rest on request.
const SETTLED_INITIAL_COUNT = 10;
const SETTLED_PAGE_COUNT = 25;
// Owner state and activity change underneath an idle list, so it re-reads
// while visible. One catalog read per interval, shared by every consumer.
const REFRESH_INTERVAL_MS = 10_000;
const SETTLED_SHELF_EXPANDED_KEY = "neocode:sidebar:native-settled-expanded";
// Before the first list lands nothing has a baseline, so nothing reads as unseen.
const NO_VISITS: NativeSessionVisitState = { baseline: "9999-12-31T00:00:00.000Z", visited: {} };
const NO_OVERRIDES: ReadonlyMap<string, boolean> = new Map();

type NativeSessionSummary = NativeSessionList["sessions"][number];
type Section = "attention" | "working" | "recent" | "settled";

/** Everything a row draws, as primitives, so an unchanged row is skipped across refreshes. */
interface RowModel {
  readonly key: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly title: string;
  readonly cwd: string;
  readonly project: string;
  readonly liveBranch: string | null;
  readonly status: NativeSessionStatus;
  readonly settled: boolean;
  readonly active: boolean;
  /** Another process holds the file and NeoCode cannot attach. */
  readonly locked: boolean;
  readonly terminalOwned: boolean;
  readonly ownerImage: string | undefined;
  readonly ownerLiveness: NeoPiManagedSessionLifecycle["liveness"] | undefined;
  readonly stopState: NeoPiManagedSessionLifecycle["stop"] | undefined;
  readonly stopWork: NeoPiManagedSessionLifecycle["work"];
  readonly canForceStop: boolean;
  readonly timeLabel: string;
}

type ListItem =
  | { readonly kind: "label"; readonly key: string; readonly label: string }
  | { readonly kind: "row"; readonly model: RowModel; readonly section: Section }
  | {
      readonly kind: "shelf";
      readonly expanded: boolean;
      readonly count: number;
    }
  | { readonly kind: "more"; readonly count: number };

const compactTimeLabel = (iso: string) => {
  const label = formatRelativeTimeLabel(iso);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
};

function toRowModel(
  { session, status }: NativeSessionEntry<NativeSessionSummary>,
  active: boolean,
): RowModel {
  const { ref } = session;
  const settled = nativeSessionSection(session, status) === "settled";
  return {
    key: `${ref.providerInstanceId}:${ref.sessionFile}`,
    providerInstanceId: ref.providerInstanceId,
    sessionId: session.sessionId,
    sessionFile: ref.sessionFile,
    title: session.title?.trim() || session.firstMessage.trim() || "New session",
    cwd: session.cwd,
    project: nativeSessionProjectLabel(session.cwd),
    liveBranch: session.live?.branch ?? null,
    status,
    settled,
    active,
    locked: session.owner.kind === "process" && !session.owner.attachable,
    terminalOwned: session.owner.kind === "process",
    ownerImage: session.managed?.imageId,
    ownerLiveness: session.managed?.liveness,
    stopState: session.managed?.stop,
    stopWork: session.managed?.work ?? null,
    canForceStop: session.managed?.canForceStop ?? false,
    timeLabel: compactTimeLabel((settled ? session.settledAt : undefined) ?? session.modifiedAt),
  };
}

const sameRow = (a: RowModel, b: RowModel) =>
  (Object.keys(a) as Array<keyof RowModel>).every((field) => a[field] === b[field]);

const SECTION_LABELS: Record<Exclude<Section, "settled">, string> = {
  attention: "Needs attention",
  working: "Working",
  recent: "Recent",
};

function buildItems(input: {
  readonly sections: NativeSessionSections<NativeSessionSummary>;
  readonly modelOf: (entry: NativeSessionEntry<NativeSessionSummary>) => RowModel;
  readonly shelfExpanded: boolean;
  readonly settledVisible: number;
}): ListItem[] {
  const { sections, modelOf } = input;
  const items: ListItem[] = [];
  for (const section of ["attention", "working", "recent"] as const) {
    if (sections[section].length === 0) continue;
    items.push({ kind: "label", key: section, label: SECTION_LABELS[section] });
    for (const entry of sections[section])
      items.push({ kind: "row", model: modelOf(entry), section });
  }
  if (sections.settled.length > 0) {
    items.push({ kind: "shelf", expanded: input.shelfExpanded, count: sections.settled.length });
    if (input.shelfExpanded) {
      for (const entry of sections.settled.slice(0, input.settledVisible))
        items.push({ kind: "row", model: modelOf(entry), section: "settled" });
      const hidden = sections.settled.length - input.settledVisible;
      if (hidden > 0) items.push({ kind: "more", count: hidden });
    } else {
      // A collapsed shelf still shows the session being worked in, like T3's.
      const open = sections.settled.find((entry) => modelOf(entry).active);
      if (open) items.push({ kind: "row", model: modelOf(open), section: "settled" });
    }
  }
  return items;
}

const STATUS_PRESENTATION = {
  waiting: {
    label: "Waiting",
    className: "text-warning-foreground",
    Icon: MessageCircleQuestionIcon,
  },
  done: {
    label: "Done",
    className: "text-emerald-700 dark:text-emerald-300",
    Icon: CircleCheckIcon,
  },
  working: {
    label: "Working",
    className: "text-sky-600 dark:text-sky-400",
    Icon: CircleDashedIcon,
  },
} as const;

/** Mounts a child's subscriptions only while the row is near the viewport. */
function useNearViewport() {
  const [near, setNear] = useState(false);
  const ref = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      {
        root: element.closest("[data-slot=scroll-area-viewport]"),
        rootMargin: "120px 0px",
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [near, ref] as const;
}

/**
 * The branch and pull request under a row's title. NeoPi's own branch shows
 * at once; the version-control status (and with it the PR) is read only while
 * the row is on screen, so a long list costs nothing for what is scrolled away.
 */
function BranchLine({
  environmentId,
  cwd,
  liveBranch,
  near,
  locked,
  terminalOwned,
  identity,
}: {
  environmentId: EnvironmentId;
  identity: AgentIdentity;
  cwd: string;
  liveBranch: string | null;
  near: boolean;
  locked: boolean;
  terminalOwned: boolean;
}) {
  const status = useEnvironmentQuery(
    near && cwd ? vcsEnvironment.status({ environmentId, input: { cwd } }) : null,
  );
  const branch = liveBranch ?? status.data?.refName ?? null;
  const pr = prStatusIndicator(status.data?.pr ?? null, status.data?.sourceControlProvider);
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
      {branch ? (
        <>
          <GitBranchIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/40" />
          <span className="min-w-0 flex-1 truncate text-muted-foreground/40">{branch}</span>
        </>
      ) : (
        <span className="flex-1" />
      )}
      <AgentLabel identity={identity} />
      {terminalOwned ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={locked ? "In use by another process" : "Open in a terminal"}
                className="inline-flex shrink-0 items-center text-muted-foreground/65"
              />
            }
          >
            {locked ? <LockIcon className="size-3" /> : <TerminalIcon className="size-3" />}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {locked ? "In use by another process" : "Open in a terminal"}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {pr && status.data?.pr ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={pr.tooltip}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                className={cn(
                  "inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm tabular-nums outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
                  pr.colorClass,
                )}
              />
            }
          >
            <pr.Icon aria-hidden className="size-3 shrink-0" />
            {status.data.pr.number}
          </TooltipTrigger>
          <TooltipPopup side="top">{pr.tooltip}</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

interface RowActions {
  readonly onChoose: (row: RowModel) => void;
  readonly onSettle: (row: RowModel, settled: boolean) => void;
  readonly onContextMenu: (event: ReactMouseEvent, row: RowModel) => void;
}

const settleButtonClassName =
  "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100";

interface RowProps {
  environmentId: EnvironmentId;
  model: RowModel;
  variant: "card" | "slim";
  actions: RowActions;
}

function areRowPropsEqual(previous: RowProps, next: RowProps) {
  return (
    previous.environmentId === next.environmentId &&
    previous.variant === next.variant &&
    previous.actions === next.actions &&
    sameRow(previous.model, next.model)
  );
}

const NativeSessionRow = memo(function NativeSessionRow({
  environmentId,
  model,
  variant,
  actions,
}: RowProps) {
  const { status, active } = model;
  // A pure hash of the id; memoized so a streamed refresh does not redo it.
  const identity = useMemo(
    () =>
      agentIdentity(
        nativeSessionIdentityKey({ sessionId: model.sessionId, sessionFile: model.sessionFile }),
      ),
    [model.sessionId, model.sessionFile],
  );
  // Work in the background recedes; only blocked and unseen rows stay at full strength.
  const recede = status === "working" || status === "idle" || model.settled;
  const [near, nearRef] = useNearViewport();
  const presentation = status === "idle" ? null : STATUS_PRESENTATION[status];
  // Blocked or running sessions return on their own; settling them would only bounce.
  const canSettle = model.settled || (status !== "waiting" && status !== "working");
  const handleClick = useCallback(() => actions.onChoose(model), [actions, model]);
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      actions.onChoose(model);
    },
    [actions, model],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => actions.onContextMenu(event, model),
    [actions, model],
  );
  const handleSettle = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      actions.onSettle(model, !model.settled);
    },
    [actions, model],
  );
  const rowClassName = cn(
    "group/sidebar-row relative w-full overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    model.locked ? "cursor-not-allowed" : "cursor-pointer",
    active
      ? "bg-sidebar-row-active text-sidebar-foreground"
      : recede
        ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
    // A working session fades as a whole row so it asks for less than one that needs you.
    status === "working" &&
      !active &&
      "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
  );
  const lifecycleLabel =
    model.ownerLiveness && model.stopState
      ? managedSessionSidebarLabel(model.ownerLiveness, model.stopState, status)
      : undefined;
  const labelStatus = lifecycleLabel ?? presentation?.label;
  const label = `${model.title}${labelStatus ? `, ${labelStatus}` : ""}`;
  const settleButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={model.settled ? "Un-settle session" : "Settle session"}
            onClick={handleSettle}
            className={cn(
              settleButtonClassName,
              // The card's status label gives way on hover, so the button may take its width.
              variant === "card" && "group-hover/sidebar-row:static",
            )}
          />
        }
      >
        {model.settled ? (
          <Undo2Icon className="mb-px size-3.5" />
        ) : (
          <>
            <CheckIcon className="size-3.5" />
            {variant === "card" ? "Settle" : null}
          </>
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {model.settled ? "Un-settle session" : "Settle session"}
      </TooltipPopup>
    </Tooltip>
  );
  const statusLabel = presentation ? (
    <span className={cn("inline-flex items-center gap-1 font-medium", presentation.className)}>
      <presentation.Icon
        aria-hidden={status !== "done"}
        aria-label={status === "done" ? "Done" : undefined}
        className="size-4 shrink-0"
      />
      <span role="status">{lifecycleLabel ?? presentation.label}</span>
    </span>
  ) : lifecycleLabel ? (
    <span role="status">{lifecycleLabel}</span>
  ) : (
    model.timeLabel
  );

  if (variant === "slim") {
    return (
      <li className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_36px]">
        <div
          role="button"
          tabIndex={0}
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={cn(rowClassName, "flex h-9 items-center gap-2.5 px-2.5")}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onContextMenu={handleContextMenu}
        >
          <span className="min-w-0 flex-1 truncate text-sm text-secondary-label/70 group-hover/sidebar-row:text-foreground group-focus-within/sidebar-row:text-foreground">
            {model.title}
          </span>
          <AgentLabel identity={identity} />
          <span className="relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end">
            <span className="inline-flex justify-end text-xs tabular-nums text-secondary-label transition-opacity group-hover/sidebar-row:opacity-0">
              {model.ownerImage ? statusLabel : model.timeLabel}
            </span>
            {settleButton}
          </span>
        </div>
      </li>
    );
  }

  return (
    <li className="list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_78px]">
      <div
        ref={nearRef}
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={rowClassName}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
      >
        <div className="relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-secondary-label text-xs",
                recede ? "font-normal" : "font-medium",
              )}
            >
              {model.project}
            </span>
            <span className="relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs">
              <span className="pointer-events-none flex items-center self-center justify-self-end tabular-nums text-secondary-label transition-opacity group-hover/sidebar-row:absolute group-hover/sidebar-row:right-0 group-hover/sidebar-row:opacity-0">
                {statusLabel}
              </span>
              {canSettle ? settleButton : null}
            </span>
          </div>
          <div className="mt-1 flex min-w-0">
            <span
              aria-hidden
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                recede ? "font-normal text-secondary-label" : "font-medium text-foreground",
              )}
            >
              {model.title}
            </span>
          </div>
          <BranchLine
            environmentId={environmentId}
            cwd={model.cwd}
            identity={identity}
            liveBranch={model.liveBranch}
            near={near}
            locked={model.locked}
            terminalOwned={model.terminalOwned}
          />
        </div>
      </div>
    </li>
  );
}, areRowPropsEqual);

function ShelfHeader({
  expanded,
  count,
  onToggle,
}: {
  expanded: boolean;
  count: number;
  onToggle: () => void;
}) {
  return (
    <li className="mx-0.5 mt-1 h-8 list-none">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex h-full w-full cursor-pointer items-center gap-2 px-2 text-left text-xs font-medium text-sidebar-muted-foreground/60"
      >
        <span className="shrink-0">{expanded ? "Settled" : `Settled (${count})`}</span>
        <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/60" />
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")}
        />
      </button>
    </li>
  );
}

/**
 * One environment's native sessions the way T3's sidebar lays out threads:
 * what needs the user first, running work dimmed, recent idle work, then a
 * collapsed shelf of settled history. Search flattens it into one list.
 */
export function NativeEnvironmentAttentionList({
  environmentId,
  label,
  query,
  open,
}: {
  environmentId: EnvironmentId;
  label?: string;
  query: string;
  open: OpenNativeSession;
}) {
  const result = useEnvironmentQuery(nativeSessionAtoms.list({ environmentId, input: {} }));
  const activity = useAtomValue(nativeSessionAtoms.activity(environmentId));
  const { refresh } = result;
  const pollingStop =
    result.data?.sessions.some(
      ({ managed }) =>
        managed?.stop === "requested" ||
        managed?.stop === "awaiting-input" ||
        managed?.stop === "forcing",
    ) ?? false;
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const interval = window.setInterval(
      refreshWhenVisible,
      pollingStop ? 2000 : REFRESH_INTERVAL_MS,
    );
    // Terminal owners can create or finish sessions without a NeoCode mutation.
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refresh, pollingStop]);

  const setSettled = useAtomCommand(nativeSessionAtoms.setSettled);
  const stopManaged = useAtomCommand(nativeSessionAtoms.stopManaged);
  const selected = useNativeSessionSelection((state) => state.target);
  const openFile = selected?.environmentId === environmentId ? selected.ref.sessionFile : null;
  const visits = useNativeSessionVisits((state) => state.environments[environmentId]) ?? NO_VISITS;

  const listed = result.data?.sessions;
  const listedRef = useRef(listed);
  useEffect(() => {
    listedRef.current = listed;
  }, [listed]);
  const hasList = listed !== undefined;
  useEffect(() => {
    const newest = listedRef.current?.[0]?.modifiedAt;
    if (hasList) establishNativeSessionBaseline(environmentId, newest ?? "");
  }, [environmentId, hasList]);
  // Looking at a session reads it: stamp it on opening and again on leaving,
  // so what finished while it was open is not reported as news afterwards.
  useEffect(() => {
    if (openFile === null) return;
    const stamp = () =>
      markNativeSessionVisited(
        environmentId,
        openFile,
        listedRef.current?.find((entry) => entry.ref.sessionFile === openFile)?.modifiedAt,
      );
    stamp();
    return stamp;
  }, [environmentId, openFile]);

  // Settling answers at once; the refreshed list then confirms it, which is
  // also when these overrides stop applying (they belong to one fetched list).
  const [optimistic, setOptimistic] = useState<{
    readonly base: typeof listed;
    readonly files: ReadonlyMap<string, boolean>;
  }>({ base: undefined, files: NO_OVERRIDES });
  const overrides = optimistic.base === listed ? optimistic.files : NO_OVERRIDES;
  const sessions = useMemo(() => {
    if (!listed || overrides.size === 0) return listed;
    const now = new Date().toISOString();
    return listed.map((session) => {
      const settled = overrides.get(session.ref.sessionFile);
      if (settled === undefined) return session;
      const { settledAt: _previous, ...rest } = session;
      return settled ? { ...rest, settledAt: now } : rest;
    });
  }, [listed, overrides]);

  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const searching = deferredQuery.length > 0;
  const [shelfExpanded, setShelfExpanded] = useLocalStorage(
    SETTLED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const toggleShelf = useCallback(
    () => setShelfExpanded((expanded) => !expanded),
    [setShelfExpanded],
  );
  const [settledVisible, setSettledVisible] = useState(SETTLED_INITIAL_COUNT);
  const showMoreSettled = useCallback(
    () => setSettledVisible((count) => count + SETTLED_PAGE_COUNT),
    [],
  );

  const items = useMemo<ListItem[]>(() => {
    if (!sessions) return [];
    const matching = searching
      ? sessions.filter((session) =>
          `${session.title ?? ""} ${session.firstMessage} ${session.cwd} ${session.live?.branch ?? ""}`
            .toLowerCase()
            .includes(deferredQuery),
        )
      : sessions;
    const sections = partitionNativeSessions(
      matching,
      visits,
      openFile,
      activity.size === 0
        ? undefined
        : (ref) => activity.get(nativeSessionKey({ environmentId, ref })),
    );
    const modelOf = (entry: NativeSessionEntry<NativeSessionSummary>) =>
      toRowModel(entry, entry.session.ref.sessionFile === openFile);
    const built: ListItem[] = searching
      ? [...sections.attention, ...sections.working, ...sections.recent, ...sections.settled]
          .toSorted((a, b) => b.session.modifiedAt.localeCompare(a.session.modifiedAt))
          .map((entry) => ({ kind: "row", model: modelOf(entry), section: "recent" }))
      : buildItems({ sections, modelOf, shelfExpanded, settledVisible });
    return built;
  }, [
    sessions,
    searching,
    deferredQuery,
    visits,
    openFile,
    activity,
    environmentId,
    shelfExpanded,
    settledVisible,
  ]);

  const [error, setError] = useState<string | null>(null);
  // Guards a second click while the first open is still in flight.
  const pendingRef = useRef(false);
  const actions = useMemo<RowActions>(() => {
    const choose = async (row: RowModel) => {
      if (pendingRef.current || row.locked) return;
      pendingRef.current = true;
      setError(null);
      try {
        await open(environmentId, {
          providerInstanceId: row.providerInstanceId,
          sessionFile: row.sessionFile,
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pendingRef.current = false;
      }
    };
    const settle = async (row: RowModel, settled: boolean) => {
      const override = (apply: (files: Map<string, boolean>) => void) =>
        setOptimistic((current) => {
          const base = listedRef.current;
          const files = new Map(current.base === base ? current.files : NO_OVERRIDES);
          apply(files);
          return { base, files };
        });
      override((files) => files.set(row.sessionFile, settled));
      const response = await setSettled({
        environmentId,
        input: {
          ref: { providerInstanceId: row.providerInstanceId, sessionFile: row.sessionFile },
          settled,
        },
      });
      if (response._tag === "Failure") override((files) => files.delete(row.sessionFile));
    };
    return {
      onChoose: (row) => void choose(row),
      onSettle: (row, settled) => void settle(row, settled),
      onContextMenu: (event, row) => {
        const api = readLocalApi();
        if (!api) return;
        event.preventDefault();
        void api.contextMenu
          .show(
            [
              { id: "open", label: "Open", disabled: row.locked },
              ...(row.ownerLiveness === "alive" && row.stopState === "idle"
                ? [{ id: "stop", label: "Stop" }]
                : []),
              ...(row.canForceStop ? [{ id: "force", label: "Force Stop" }] : []),
              ...(row.settled
                ? [{ id: "unsettle", label: "Un-settle" }]
                : row.status === "waiting" || row.status === "working"
                  ? []
                  : [{ id: "settle", label: "Settle" }]),
            ],
            { x: event.clientX, y: event.clientY },
          )
          .then(async (action) => {
            if (action === "open") return choose(row);
            if (action === "settle") return settle(row, true);
            if (action === "unsettle") return settle(row, false);
            const imageId = row.ownerImage;
            if ((action !== "stop" && action !== "force") || !imageId) return;
            const work =
              row.stopWork === "reply-and-compaction"
                ? "the current reply and context compaction"
                : row.stopWork === "reply"
                  ? "the current reply"
                  : "context compaction";
            const prompt =
              action === "force"
                ? `Force Stop "${row.title}"? This kills the NeoPi process without waiting for it to save.`
                : row.stopWork
                  ? `Stop "${row.title}"? This interrupts ${work}.`
                  : null;
            if (prompt && !(await api.dialogs.confirm(prompt, { variant: "destructive" }))) return;
            setError(null);
            const response = await stopManaged({
              environmentId,
              input: {
                ref: { providerInstanceId: row.providerInstanceId, sessionFile: row.sessionFile },
                action,
                imageId,
              },
            });
            if (response._tag === "Failure") throw squashAtomCommandFailure(response);
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
      },
    };
  }, [environmentId, open, setSettled, stopManaged]);

  // The window belongs to one view of the list; a new search starts from the first step.
  const [shown, setShown] = useState({ query: deferredQuery, limit: ROWS_STEP });
  const limit = shown.query === deferredQuery ? shown.limit : ROWS_STEP;
  const hasMore = items.length > limit;
  // Keyed by `limit`, so each step mounts a fresh sentinel and observes it again
  // even when it is still on screen after the rows above it grew.
  const sentinel = useCallback(
    (element: HTMLLIElement | null) => {
      if (!element) return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          setShown((current) => ({
            query: deferredQuery,
            limit: (current.query === deferredQuery ? current.limit : ROWS_STEP) + ROWS_STEP,
          }));
        },
        {
          root: element.closest("[data-slot=scroll-area-viewport]"),
          rootMargin: "0px 0px 600px 0px",
        },
      );
      observer.observe(element);
      return () => observer.disconnect();
    },
    [deferredQuery],
  );

  return (
    <SidebarGroup>
      {label ? (
        <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{label}</p>
      ) : null}
      {result.error || error ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? result.error}
        </p>
      ) : null}
      {result.data?.diagnostics.map((item) => (
        <p
          key={`${item.providerInstanceId}:${item.message}`}
          className="text-xs text-muted-foreground"
        >
          {item.providerInstanceId}: {item.message}
        </p>
      ))}
      <ul role="presentation" className="flex flex-col gap-px">
        {items.slice(0, limit).map((item) => {
          switch (item.kind) {
            case "label":
              return (
                <li
                  key={item.key}
                  role="presentation"
                  className="list-none px-2 pt-2 pb-0.5 text-xs font-medium text-sidebar-muted-foreground/60"
                >
                  {item.label}
                </li>
              );
            case "row":
              return (
                <NativeSessionRow
                  key={item.model.key}
                  environmentId={environmentId}
                  model={item.model}
                  variant={item.section === "settled" ? "slim" : "card"}
                  actions={actions}
                />
              );
            case "shelf":
              return (
                <ShelfHeader
                  key="shelf"
                  expanded={item.expanded}
                  count={item.count}
                  onToggle={toggleShelf}
                />
              );
            case "more":
              return (
                <li key="more" className="list-none">
                  <button
                    type="button"
                    onClick={showMoreSettled}
                    className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    <PlusIcon aria-hidden className="size-4 shrink-0" />
                    Show {Math.min(item.count, SETTLED_PAGE_COUNT)} more
                  </button>
                </li>
              );
          }
        })}
        {hasMore ? <li key={limit} ref={sentinel} aria-hidden className="h-px" /> : null}
      </ul>
      {!result.data && result.isPending ? (
        <p className="text-xs text-muted-foreground">Reading sessions…</p>
      ) : null}
    </SidebarGroup>
  );
}
