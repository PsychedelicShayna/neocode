import type { EnvironmentId, NeoPiNativeSessionRef } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { nativeNavigationGuards } from "@t3tools/client-runtime/neopi-conversation";
import {
  nativeRecord,
  type NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";
import {
  SESSION_TREE_FILTERS,
  SESSION_TREE_LEVEL_CELLS,
  decodeSessionTree,
  describeSessionTreeEntry,
  filterSessionTree,
  projectSessionTree,
  sessionTreePrefix,
  sessionTreeScrollOffset,
  type SessionTreeFilter,
  type SessionTreeKind,
  type SessionTreeProjection,
  type SessionTreeRow,
  type SessionTreeSnapshot,
} from "@t3tools/client-runtime/neopi-session-tree";
import { ChevronDownIcon, ChevronRightIcon, CircleAlertIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useNativeSession } from "../../state/neopiNativeSessions";
import { formatShortTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { NeoPiJournalContent } from "./NeoPiJournalContent";

type Command = Record<string, unknown> & { type: string };
type Request = (command: Command) => Promise<unknown>;

const ROW_HEIGHT = 24;
const OVERSCAN_ROWS = 10;
/** Width of one monospace gutter cell at the row's text size. */
const GUTTER_CELL_PX = 7.2;
/** Live entries arrive in bursts while the agent works; one refresh covers a burst. */
const REFRESH_DELAY_MS = 400;

const FILTER_ITEMS = [
  { value: "default", label: "Default" },
  { value: "no-tools", label: "No tools" },
  { value: "user-only", label: "User only" },
  { value: "labeled-only", label: "Labeled" },
  { value: "all", label: "All" },
] satisfies { value: SessionTreeFilter; label: string }[];

const KIND_STYLES: Record<SessionTreeKind, string> = {
  user: "text-info-foreground",
  assistant: "text-success-foreground",
  tool: "text-muted-foreground",
  summary: "text-warning-foreground",
  custom: "text-warning-foreground",
  system: "text-muted-foreground/70",
};

const asFilter = (value: unknown): SessionTreeFilter =>
  SESSION_TREE_FILTERS.find((filter) => filter === value) ?? "default";

/**
 * The native session tree beside the chat. NeoPi owns the tree; this reads its
 * `get_tree`, lays it out like the TUI's `/tree`, and issues the same guarded
 * `navigate_tree`. Only identity primitives reach the body, so streaming
 * tokens do not re-render a long tree.
 */
export function NativeSessionTreePanel({
  target,
  request,
  execute,
  onNavigated,
}: {
  target: NativeSessionTarget;
  /** Plain reads. */
  request: Request;
  /** Commands that change the session; refreshes the workspace state afterwards. */
  execute: Request;
  onNavigated: (result: Record<string, unknown>) => void;
}) {
  const { feed, conversation, session } = useNativeSession(target);
  const identity = conversation.identity;
  return (
    <TreeBody
      key={`${identity?.sessionId ?? ""}|${identity?.sessionFile ?? ""}`}
      environmentId={target.environmentId}
      nativeRef={session?.ref ?? target.ref}
      cwd={session?.cwd}
      connected={feed.connected}
      sessionId={identity?.sessionId ?? null}
      sessionFile={identity?.sessionFile ?? null}
      leafId={identity?.leafId ?? null}
      request={request}
      execute={execute}
      onNavigated={onNavigated}
    />
  );
}

interface View {
  /** First row index inside the viewport. */
  first: number;
  count: number;
  width: number;
}

const TreeBody = memo(function TreeBody({
  environmentId,
  nativeRef,
  cwd,
  connected,
  sessionId,
  sessionFile,
  leafId,
  request,
  execute,
  onNavigated,
}: {
  environmentId: EnvironmentId;
  nativeRef: NeoPiNativeSessionRef;
  cwd: string | undefined;
  connected: boolean;
  sessionId: string | null;
  sessionFile: string | null;
  leafId: string | null;
  request: Request;
  execute: Request;
  onNavigated: (result: Record<string, unknown>) => void;
}) {
  const timestampFormat = useEnvironmentSettings(
    environmentId,
    (settings) => settings.timestampFormat,
  );
  const domId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [snapshot, setSnapshot] = useState<SessionTreeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState<SessionTreeFilter>("default");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>({ first: 0, count: 24, width: 480 });

  // Refresh follows the live leaf, throttled to one request per burst of entries.
  const generation = useRef(0);
  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = decodeSessionTree(await request({ type: "get_tree" }));
      if (mine !== generation.current) return;
      setSnapshot(next);
      setError(null);
    } catch (cause) {
      if (mine === generation.current) setError(String(cause));
    }
  }, [request]);
  const loadedOnce = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // A pending refresh reads the latest tree when it fires, so later changes join it.
    if (!connected || sessionId === null || refreshTimer.current !== null) return;
    refreshTimer.current = setTimeout(
      () => {
        refreshTimer.current = null;
        loadedOnce.current = true;
        void load();
      },
      loadedOnce.current ? REFRESH_DELAY_MS : 0,
    );
  }, [connected, sessionId, sessionFile, leafId, load]);
  useEffect(
    () => () => {
      if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
      generation.current++;
    },
    [],
  );

  const projection = useMemo<SessionTreeProjection | null>(
    () => (snapshot ? projectSessionTree(snapshot.items, snapshot.leafId, collapsed) : null),
    [snapshot, collapsed],
  );
  const rows = useMemo(
    () => (projection ? filterSessionTree(projection, filter, deferredQuery) : []),
    [projection, filter, deferredQuery],
  );
  const indexById = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows]);
  const itemById = useMemo(
    () => new Map(snapshot?.items.map((item) => [item.entry.id, item])),
    [snapshot],
  );
  const rowById = useMemo(
    () => new Map(projection?.rows.map((row) => [row.id, row])),
    [projection],
  );

  const candidateId = selectedId ?? snapshot?.leafId ?? null;
  const activeId = candidateId !== null && indexById.has(candidateId) ? candidateId : null;
  const selected = activeId === null ? undefined : itemById.get(activeId);
  const treeLeafId = snapshot?.leafId ?? null;
  const leafIndex = treeLeafId === null ? undefined : indexById.get(treeLeafId);
  const leafIndexRef = useRef(leafIndex);
  leafIndexRef.current = leafIndex;

  // Reveal rows by scrolling the minimum distance, or centre one.
  const reveal = useCallback((index: number, centre = false) => {
    const element = listRef.current;
    if (!element) return;
    const top = index * ROW_HEIGHT;
    if (centre) element.scrollTop = Math.max(0, top - (element.clientHeight - ROW_HEIGHT) / 2);
    else if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
  }, []);

  // The current leaf stays in view as the agent adds entries, unless the user scrolled away.
  const following = useRef(true);
  const shownLeaf = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (treeLeafId === null || leafIndex === undefined || shownLeaf.current === treeLeafId) return;
    const firstTime = shownLeaf.current === null;
    shownLeaf.current = treeLeafId;
    if (firstTime) reveal(leafIndex, true);
    else if (following.current) reveal(leafIndex);
  }, [treeLeafId, leafIndex, reveal]);
  useEffect(() => {
    const index = leafIndexRef.current;
    following.current =
      index === undefined || (index >= view.first - 1 && index <= view.first + view.count + 1);
  }, [view.first, view.count]);

  const ready = projection !== null;
  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const measure = () =>
      setView((current) => {
        const count = Math.ceil(element.clientHeight / ROW_HEIGHT) + 1;
        const width = element.clientWidth;
        return current.count === count && current.width === width
          ? current
          : { ...current, count, width };
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ready]);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const first = Math.floor((listRef.current?.scrollTop ?? 0) / ROW_HEIGHT);
      setView((current) => (current.first === first ? current : { ...current, first }));
    });
  }, []);

  const select = useCallback((id: string) => setSelectedId(id), []);
  const toggle = useCallback(
    (id: string) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );

  const navigate = async (summarize: boolean) => {
    if (!selected || sessionId === null || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = nativeRecord(
        await execute({
          type: "navigate_tree",
          targetId: selected.entry.id,
          ...(summarize ? { summarize: true } : {}),
          ...nativeNavigationGuards({ sessionId, sessionFile, leafId }),
        }),
      );
      if (result.cancelled !== true) onNavigated(result);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };

  const moveTo = (index: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, index));
    const row = rows[clamped];
    if (!row) return;
    setSelectedId(row.id);
    reveal(clamped);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey)
      return;
    const current = activeId === null ? undefined : indexById.get(activeId);
    const row = activeId === null ? undefined : rowById.get(activeId);
    const handled = (action: () => void) => {
      event.preventDefault();
      action();
    };
    switch (event.key) {
      case "ArrowDown":
        return handled(() => moveTo(current === undefined ? (leafIndex ?? 0) : current + 1));
      case "ArrowUp":
        return handled(() => moveTo(current === undefined ? (leafIndex ?? 0) : current - 1));
      case "PageDown":
        return handled(() => moveTo((current ?? 0) + view.count - 1));
      case "PageUp":
        return handled(() => moveTo((current ?? 0) - view.count + 1));
      case "Home":
        return handled(() => moveTo(0));
      case "End":
        return handled(() => moveTo(rows.length - 1));
      case "ArrowRight":
        return handled(() => {
          if (row?.collapsed) toggle(row.id);
        });
      case "ArrowLeft":
        return handled(() => {
          if (!row) return;
          if (row.childCount > 0 && !row.collapsed) return toggle(row.id);
          // Otherwise step out to the nearest ancestor that is still listed.
          let parentId = row.item.entry.parentId;
          while (parentId !== null && !indexById.has(parentId))
            parentId = itemById.get(parentId)?.entry.parentId ?? null;
          if (parentId !== null) moveTo(indexById.get(parentId)!);
        });
      case "Enter":
        return handled(() => void navigate(event.shiftKey));
      case "/":
        return handled(() => searchRef.current?.focus());
    }
  };

  if (!projection)
    return (
      <p
        role={error ? "alert" : "status"}
        className={cn("p-3 text-xs", error ? "text-destructive" : "text-muted-foreground")}
      >
        {error ?? (connected ? "Loading session tree…" : "The native session is not connected.")}
      </p>
    );

  const first = Math.max(0, view.first - OVERSCAN_ROWS);
  const last = Math.min(rows.length, view.first + view.count + OVERSCAN_ROWS);
  let deepest = 0;
  for (let index = view.first; index < Math.min(rows.length, view.first + view.count); index++)
    deepest = Math.max(deepest, rows[index]!.depth);
  const scrollOffset = sessionTreeScrollOffset(
    deepest,
    Math.floor((view.width * 0.45) / (SESSION_TREE_LEVEL_CELLS * GUTTER_CELL_PX)),
  );
  const isCurrent = selected !== undefined && selected.entry.id === treeLeafId;

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Session tree">
      <div className="flex shrink-0 items-center gap-1.5 border-b p-2">
        <Input
          ref={searchRef}
          type="search"
          size="compact"
          aria-label="Search session tree"
          placeholder="Search entries"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setQuery("");
              listRef.current?.focus();
            } else if (event.key === "ArrowDown" || event.key === "Enter") {
              event.preventDefault();
              listRef.current?.focus();
            }
          }}
        />
        <Select
          modal={false}
          value={filter}
          onValueChange={(value) => setFilter(asFilter(value))}
          items={FILTER_ITEMS}
        >
          <SelectTrigger
            variant="ghost"
            size="xs"
            className="w-28 shrink-0"
            aria-label="Filter session tree"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {FILTER_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div
        ref={listRef}
        role="tree"
        tabIndex={0}
        aria-label="Session entries"
        aria-activedescendant={
          activeId !== null && indexById.has(activeId) ? `${domId}-${activeId}` : undefined
        }
        className="relative min-h-24 flex-1 overflow-y-auto overflow-x-hidden outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        {rows.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            {projection.rows.length === 0
              ? "No entries yet."
              : `${projection.rows.length} entries hidden by the current filter or search.`}
          </p>
        ) : (
          <div className="relative" style={{ height: rows.length * ROW_HEIGHT }}>
            {rows.slice(first, last).map((row, offset) => (
              <TreeRow
                key={row.id}
                domId={`${domId}-${row.id}`}
                row={row}
                top={(first + offset) * ROW_HEIGHT}
                toolCalls={projection.toolCalls}
                scrollOffset={scrollOffset}
                selected={row.id === activeId}
                timestampFormat={timestampFormat}
                onSelect={select}
                onToggle={toggle}
              />
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 border-t px-2 py-1 text-2xs text-muted-foreground">
        <span className="tabular-nums">
          {rows.length} of {projection.rows.length} entries
        </span>
        <span>Enter goes there · Shift+Enter summarizes · / searches</span>
      </div>
      {error ? (
        <p role="alert" className="shrink-0 border-t px-2 py-1.5 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {selected ? (
        <div className="flex max-h-[45%] min-h-0 shrink-0 flex-col border-t">
          <div className="flex shrink-0 items-center gap-1.5 p-2">
            <Button
              size="xs"
              disabled={isCurrent || pending || sessionId === null}
              onClick={() => void navigate(false)}
            >
              {isCurrent ? "Current position" : pending ? "Moving…" : "Go to this point"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={isCurrent || pending || sessionId === null}
              onClick={() => void navigate(true)}
            >
              Go and summarize
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
            <NeoPiJournalContent
              entry={selected.entry}
              environmentId={environmentId}
              nativeRef={nativeRef}
              cwd={cwd}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
});

const TreeRow = memo(function TreeRow({
  domId,
  row,
  top,
  toolCalls,
  scrollOffset,
  selected,
  timestampFormat,
  onSelect,
  onToggle,
}: {
  domId: string;
  row: SessionTreeRow;
  top: number;
  toolCalls: SessionTreeProjection["toolCalls"];
  scrollOffset: number;
  selected: boolean;
  timestampFormat: TimestampFormat;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const { entry, label } = row.item;
  const described = describeSessionTreeEntry(entry, toolCalls);
  const hasBranches = row.childCount > 1 || row.collapsed;
  return (
    <div
      id={domId}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      aria-expanded={row.childCount > 0 ? !row.collapsed : undefined}
      title={`${described.label}: ${described.text}`}
      style={{ top, height: ROW_HEIGHT }}
      className={cn(
        "absolute inset-x-0 flex cursor-pointer select-none items-center gap-1.5 px-2 text-xs",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        !row.onActivePath && !selected && "text-muted-foreground",
      )}
      onClick={() => onSelect(row.id)}
    >
      <span aria-hidden className="shrink-0 whitespace-pre font-mono text-muted-foreground/60">
        {sessionTreePrefix(row, scrollOffset)}
      </span>
      {hasBranches ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={row.collapsed ? "Expand branch" : "Collapse branch"}
          className="-mx-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-accent"
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(row.id);
          }}
        >
          {row.collapsed ? (
            <ChevronRightIcon className="size-3" />
          ) : (
            <ChevronDownIcon className="size-3" />
          )}
        </button>
      ) : null}
      <span
        aria-hidden
        className={cn(
          "shrink-0 rounded-full",
          row.isLeaf
            ? "size-2 bg-primary"
            : row.onActivePath
              ? "size-1.5 bg-primary/50"
              : "size-1.5",
        )}
      />
      <span className={cn("max-w-24 shrink-0 truncate font-medium", KIND_STYLES[described.kind])}>
        {described.label}
      </span>
      {label ? <span className="shrink-0 text-warning-foreground">[{label}]</span> : null}
      {row.collapsed ? (
        <span className="shrink-0 text-muted-foreground">[+{row.hiddenCount}]</span>
      ) : null}
      {described.error ? (
        <CircleAlertIcon aria-label="Error" className="size-3 shrink-0 text-destructive" />
      ) : null}
      <span className={cn("min-w-0 flex-1 truncate", described.error && "text-destructive")}>
        {described.text}
      </span>
      <time
        dateTime={entry.timestamp}
        className="shrink-0 text-2xs tabular-nums text-muted-foreground"
      >
        {formatShortTimestamp(entry.timestamp, timestampFormat)}
      </time>
    </div>
  );
});
