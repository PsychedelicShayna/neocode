import { extendNeoPiJournalSnapshot, journalEntryCategory, journalEntryLabel, journalRecord, journalTreeRows, type NeoPiJournalSnapshot } from "@t3tools/client-runtime/neopi-journal";
import { nativeIdentityKey } from "@t3tools/client-runtime/neopi-conversation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { nativeJournalRead, useNeoPiConversation } from "../../state/neopiConversation";
import { useAtomCommand } from "../../state/use-atom-command";
import { NativeChoice, NativeError, NativeField, NativeModal } from "./NativeNeoPiControls";
import { NeoPiJournalContent } from "./NeoPiJournalContent";
import { NeoPiTreeNavigation } from "./NeoPiTreeNavigation";

type Category = "all" | "message" | "tool" | "system";

export function NeoPiSessionTree({ threadRef, cwd, onClose }: { threadRef: ScopedThreadRef; cwd: string | null; onClose: () => void }) {
  const read = useAtomCommand(nativeJournalRead, { reportFailure: false });
  const { conversation } = useNeoPiConversation(threadRef);
  const [snapshot, setSnapshot] = useState<NeoPiJournalSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const active = useRef(true);
  const current = useRef(snapshot);
  current.current = snapshot;
  const nativeKey = conversation.identity ? nativeIdentityKey(conversation.identity) : null;
  async function load(older: boolean) {
    const captured = older ? current.current : null;
    if (older && !captured?.page.nextCursor) return;
    const request = ++generation.current;
    setPending(true); setError(null);
    if (!older) setSnapshot(null);
    try {
      const response = await read({ environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId, scope: "journal", direction: "backward", limit: 100, ...(captured?.page.nextCursor ? { cursor: captured.page.nextCursor } : {}) } });
      if (!active.current || request !== generation.current) return;
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      if (response.value.status !== "available") {
        if (response.value.status === "error" && (response.value.code === "leaf_changed" || response.value.code === "stale_cursor")) setSnapshot(null);
        throw new Error(response.value.status === "error" ? response.value.message : response.value.reason);
      }
      setSnapshot(extendNeoPiJournalSnapshot(captured, response.value));
    } catch (cause) {
      if (!active.current || request !== generation.current) return;
      setError(cause instanceof Error ? cause.message : "Could not read the native journal.");
      if (older && cause instanceof Error && cause.message.includes("snapshot changed")) setSnapshot(null);
    } finally { if (active.current && request === generation.current) setPending(false); }
  }
  useEffect(() => {
    active.current = true;
    setSelectedId(null);
    void load(false);
    return () => { active.current = false; generation.current++; };
  }, [threadRef.environmentId, threadRef.threadId, nativeKey]);
  const rows = useMemo(() => journalTreeRows(snapshot?.entries ?? []).filter(row => {
    if (category !== "all" && journalEntryCategory(row.entry) !== category) return false;
    const message = journalRecord(row.entry.message);
    const content = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map(block => journalRecord(block).text ?? "").join(" ") : "";
    return `${row.entry.id} ${journalEntryLabel(row.entry)} ${content}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  }), [snapshot?.entries, category, query]);
  const selected = snapshot?.entries.find(entry => entry.id === selectedId);
  const changed = snapshot && conversation.identity && snapshot.page.leafId !== conversation.identity.leafId;
  return <NativeModal title="Native session tree" onClose={onClose}>
    <View className="gap-3 px-4 pb-3"><Text className="text-xs text-foreground-muted">Canonical append-only journal. Branches, compactions and context resets remain inspectable; navigation does not delete their future.</Text><NativeChoice label="Entry filter" value={category} options={[{ value: "all", label: "All entries" }, { value: "message", label: "Messages" }, { value: "tool", label: "Tools" }, { value: "system", label: "System" }]} onChange={setCategory} /><NativeField label="Search native entries" value={query} onChange={setQuery} /><View className="flex-row flex-wrap gap-2"><MaterialButton label="Refresh journal" disabled={pending} onPress={() => void load(false)} />{snapshot?.page.nextCursor ? <MaterialButton label="Load older journal entries" disabled={pending || !!changed} onPress={() => void load(true)} /> : null}</View><NativeError message={error} />{pending ? <Text className="text-xs text-foreground-muted">Reading canonical native entries…</Text> : null}{snapshot ? <Text selectable className="text-xs text-foreground-muted">{snapshot.entries.length} of {snapshot.page.totalEntries} native entries loaded · leaf {snapshot.page.leafId ?? "root"}</Text> : null}{changed ? <Text className="text-xs text-foreground-muted">The live leaf changed. This is a pinned inspection snapshot. Refresh before paging further.</Text> : null}</View>
    <FlatList data={rows} keyExtractor={row => row.entry.id} ListEmptyComponent={<Text className="px-4 py-3 text-foreground-muted">{pending ? "Reading native history…" : snapshot ? "No matching entries in the loaded journal pages." : "No native snapshot is available. No SQL history is substituted."}</Text>} renderItem={({ item: row }) => <Pressable accessibilityRole="button" onPress={() => setSelectedId(row.entry.id)} className="gap-1 border-b border-border-subtle px-4 py-3" style={{ paddingLeft: 16 + Math.min(row.depth, 12) * 12 }}><Text className="font-t3-medium text-foreground">{journalEntryLabel(row.entry)}{row.entry.id === conversation.identity?.leafId ? " · Current leaf" : ""}</Text><Text selectable className="text-xs text-foreground-muted">{row.entry.id} · depth {row.depth} · {row.childCount} children{row.missingParent ? " · Parent is on an unloaded page" : ""}</Text><Text className="text-xs text-foreground-muted">{row.entry.timestamp}</Text></Pressable>} />
    {selected ? <NativeModal title={journalEntryLabel(selected)} onClose={() => setSelectedId(null)}><ScrollView contentContainerClassName="gap-4 p-4"><Text selectable className="font-mono text-xs text-foreground-muted">{selected.id}{"\n"}Parent: {selected.parentId ?? "root"}</Text><NeoPiJournalContent entry={selected} threadRef={threadRef} cwd={cwd} /><NeoPiTreeNavigation key={`${snapshot?.page.sessionFile}:${selected.id}`} threadRef={threadRef} targetId={selected.id} /></ScrollView></NativeModal> : null}
  </NativeModal>;
}
