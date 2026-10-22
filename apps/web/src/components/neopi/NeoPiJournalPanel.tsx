import type { NeoPiJournalOptions, ScopedThreadRef } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import { neopiSessionJournal } from "../../state/neopiSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { NeoPiJournalContent } from "./NeoPiJournalContent";
import { NeoPiTreeNavigation } from "./NeoPiTreeNavigation";
import {
  extendNeoPiJournalSnapshot,
  journalEntryCategory,
  journalEntryLabel,
  journalTreeRows,
  type NeoPiJournalSnapshot,
} from "./neopiJournal.logic";

export function NeoPiJournalPanel({ threadRef, cwd }: {
  threadRef: ScopedThreadRef;
  cwd?: string | undefined;
}) {
  const read = useAtomCommand(neopiSessionJournal, { reportFailure: false });
  const [scope, setScope] = useState<"branch" | "journal">("journal");
  const [snapshot, setSnapshot] = useState<NeoPiJournalSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(true);
  const [showSystem, setShowSystem] = useState(true);
  const [filter, setFilter] = useState("");
  const request = useRef(0);
  const snapshotRef = useRef<NeoPiJournalSnapshot | null>(null);

  const load = useCallback(async (selectedScope: "branch" | "journal", restart: boolean) => {
    const previous = restart ? null : snapshotRef.current;
    if (!restart && !previous?.page.nextCursor) return;
    const generation = ++request.current;
    if (restart) {
      snapshotRef.current = null;
      setSnapshot(null);
    }
    setError(null);
    setPending(true);
    try {
      const options: NeoPiJournalOptions = {
        scope: selectedScope,
        direction: "backward",
        limit: 100,
        ...(previous?.page.nextCursor ? { cursor: previous.page.nextCursor } : {}),
      };
      const result = await read({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, ...options },
      });
      if (request.current !== generation) return;
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
      const value = result.value;
      if (value.status !== "available") {
        // Never leave an old branch visible or silently restart it after leaf_changed.
        snapshotRef.current = null;
        setSnapshot(null);
        setError(value.status === "error" ? `${value.code}: ${value.message}` : value.reason);
        return;
      }
      const next = extendNeoPiJournalSnapshot(previous, value);
      snapshotRef.current = next;
      setSnapshot(next);
      setSelectedId((current) => current ??
        (next.entries.some((entry) => entry.id === next.page.leafId)
          ? next.page.leafId
          : next.entries.at(-1)?.id ?? null));
    } catch (cause) {
      if (request.current !== generation) return;
      snapshotRef.current = null;
      setSnapshot(null);
      setError(cause instanceof Error ? cause.message : "Could not read native history.");
    } finally {
      if (request.current === generation) setPending(false);
    }
  }, [read, threadRef.environmentId, threadRef.threadId]);

  useEffect(() => {
    void load("journal", true);
    return () => { request.current++; };
  }, [load]);

  const entries = snapshot?.entries;
  const searchable = useMemo(() => journalTreeRows(entries ?? []).map((row) => ({
    row,
    text: `${journalEntryLabel(row.entry)} ${row.entry.id} ${row.entry.parentId ?? ""} ${typeof row.entry.summary === "string" ? row.entry.summary : ""}`.toLocaleLowerCase(),
  })), [entries]);
  const rows = useMemo(() => searchable.filter(({ row: { entry }, text }) => {
    const category = journalEntryCategory(entry);
    return (showTools || category !== "tool") && (showSystem || category !== "system") &&
      text.includes(filter.toLocaleLowerCase());
  }).map(({ row }) => row), [searchable, showTools, showSystem, filter]);
  const selected = entries?.find((entry) => entry.id === selectedId);
  const byId = useMemo(() => new Map(entries?.map((entry) => [entry.id, entry])), [entries]);
  const renderRow = useCallback(({ item }: { item: ReturnType<typeof journalTreeRows>[number] }) => (
    <button type="button" onClick={() => setSelectedId(item.entry.id)}
      aria-pressed={selectedId === item.entry.id}
      className={cn("block w-full border-b px-3 py-2 text-left text-xs hover:bg-accent/60", selectedId === item.entry.id && "bg-accent")}
      style={{ paddingLeft: `${12 + Math.min(item.depth, 12) * 10}px` }}>
      <span className="flex items-center gap-2">
        <span className="truncate font-medium">{journalEntryLabel(item.entry)}</span>
        {item.entry.id === snapshot?.page.leafId ? <span className="shrink-0 text-muted-foreground">snapshot leaf</span> : null}
        {item.childCount > 1 ? <span className="shrink-0 text-muted-foreground">{item.childCount} branches</span> : null}
      </span>
      <span className="block truncate font-mono text-muted-foreground">
        {item.entry.id} ← {item.entry.parentId ?? "root"}{item.missingParent ? " · parent not loaded" : ""}
      </span>
    </button>
  ), [selectedId, snapshot?.page.leafId]);

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Native history and tree">
      <header className="shrink-0 space-y-3 border-b p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Native history / tree</h2>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void load(scope, true)}>
            Refresh snapshot
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Inspect every branch, then use Navigate here to select a native context. Alternate branches stay in the same file.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={scope === "branch" ? "secondary" : "ghost"} disabled={pending}
            onClick={() => { setScope("branch"); void load("branch", true); }}>
            Active branch
          </Button>
          <Button size="sm" variant={scope === "journal" ? "secondary" : "ghost"} disabled={pending}
            onClick={() => { setScope("journal"); void load("journal", true); }}>
            Whole journal
          </Button>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={showTools} onChange={(event) => setShowTools(event.currentTarget.checked)} />Tools
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={showSystem} onChange={(event) => setShowSystem(event.currentTarget.checked)} />System events
          </label>
        <label className="block text-xs">
          Filter loaded tree entries
          <input type="search" value={filter} onChange={(event) => setFilter(event.currentTarget.value)}
            className="mt-1 block w-full rounded border bg-background px-2 py-1" placeholder="Entry kind, ID or summary" />
        </label>
        </div>
        {snapshot ? (
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>{snapshot.entries.length} / {snapshot.page.totalEntries} native entries · {rows.length} visible</p>
            <p className="break-all font-mono">{snapshot.page.sessionId} · active leaf at snapshot {snapshot.page.leafId ?? "none"}</p>
            <p className="break-all font-mono">{snapshot.page.sessionFile}</p>
          </div>
        ) : null}
        {error ? <p role="alert" className="text-xs text-destructive">{error} Use Refresh snapshot to start again.</p> : null}
        {pending ? <p role="status" className="text-xs text-muted-foreground">Reading native journal…</p> : null}
        {snapshot?.page.nextCursor ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => void load(scope, false)}>Load older entries</Button>
        ) : snapshot && snapshot.entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">The native snapshot is empty.</p>
        ) : null}
      </header>
      {rows.length > 0 ? (
        <div className="min-h-0 flex-1 basis-1/3 border-b">
          <LegendList data={rows} keyExtractor={(row) => row.entry.id} renderItem={renderRow}
            estimatedItemSize={52} recycleItems extraData={selectedId} maintainVisibleContentPosition
            className="h-full overflow-auto" aria-label="Native journal tree nodes" />
        </div>
      ) : null}
      {selectedId ? (
        <div className="max-h-[50%] shrink-0 overflow-auto px-4">
          <p className="mt-2 break-all font-mono text-xs text-muted-foreground">Target · {selectedId}</p>
          <NeoPiTreeNavigation key={selectedId} threadRef={threadRef} targetId={selectedId}
            onNavigated={() => void load(scope, true)} />
        </div>
      ) : null}
      {selected ? (
        <article className="min-h-0 flex-1 basis-2/3 overflow-auto p-4" key={selected.id}>
          <h3 className="mb-2 text-sm font-medium">{journalEntryLabel(selected)}</h3>
          <div className="mb-4 space-y-1 break-all text-xs text-muted-foreground">
            <p className="font-mono">{selected.id}</p>
            <p>{selected.timestamp}</p>
            <p>Parent · {selected.parentId === null ? "root" : byId.has(selected.parentId) ? (
              <button type="button" className="cursor-pointer underline" onClick={() => setSelectedId(selected.parentId)}>{selected.parentId}</button>
            ) : `${selected.parentId} · load older entries to inspect`}</p>
          </div>
          <NeoPiJournalContent entry={selected} threadRef={threadRef} cwd={cwd} />
        </article>
      ) : null}
    </section>
  );
}
