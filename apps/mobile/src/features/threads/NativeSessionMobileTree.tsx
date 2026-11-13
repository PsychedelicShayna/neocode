import type { NeoPiJournalEntry } from "@t3tools/contracts";
import {
  nativeRecord,
  nativeSessionKey,
  type NativeSessionTarget,
} from "@t3tools/client-runtime/neopi-native-sessions";
import { journalEntryLabel, journalTreeRows } from "@t3tools/client-runtime/neopi-journal";
import { nativeNavigationGuards } from "@t3tools/client-runtime/neopi-conversation";
import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { Button } from "../../components/ui/Button";
import { nativeSessionAtoms, useNativeSession } from "../../state/neopiNativeSessions";
import { useEnvironmentQuery } from "../../state/query";
import { NativeError, NativeModal } from "./NativeNeoPiControls";
import { NeoPiJournalContent } from "./NeoPiJournalContent";

type Request = (command: Record<string, unknown> & { type: string }) => Promise<unknown>;
interface TreeProps {
  target: NativeSessionTarget;
  request: Request;
  onClose: () => void;
}
export function NativeSessionMobileTree(props: TreeProps) {
  return <NativeSessionMobileTreeBody key={nativeSessionKey(props.target)} {...props} />;
}
function NativeSessionMobileTreeBody({ target, request, onClose }: TreeProps) {
  const { feed } = useNativeSession(target);
  const tree = useEnvironmentQuery(
    nativeSessionAtoms.tree({
      environmentId: target.environmentId,
      input: { ref: target.ref },
    }),
  );
  const entries = useMemo(() => {
    const roots = nativeRecord(tree.data).tree;
    const result: NeoPiJournalEntry[] = [];
    const remaining = Array.isArray(roots) ? [...roots].reverse() : [];
    while (remaining.length) {
      const node = nativeRecord(remaining.pop());
      const entry = nativeRecord(node.entry);
      if (
        typeof entry.id === "string" &&
        typeof entry.type === "string" &&
        typeof entry.timestamp === "string" &&
        (entry.parentId === null || typeof entry.parentId === "string")
      )
        result.push(entry as NeoPiJournalEntry);
      if (Array.isArray(node.children)) remaining.push(...[...node.children].reverse());
    }
    return result;
  }, [tree.data]);
  const [selected, setSelected] = useState<NeoPiJournalEntry | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = async () => {
    if (!selected || !feed.conversation.identity || pending) return;
    setPending(true);
    try {
      const result = nativeRecord(
        await request({
          type: "navigate_tree",
          targetId: selected.id,
          ...nativeNavigationGuards(feed.conversation.identity),
        }),
      );
      if (result.cancelled !== true) onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <NativeModal title="Session tree" onClose={onClose}>
      <ScrollView contentContainerClassName="gap-2 px-4 pb-6">
        <NativeError message={error ?? tree.error} />
        {journalTreeRows(entries).map(({ entry, depth }) => (
          <View key={entry.id} style={{ paddingLeft: Math.min(depth, 12) * 12 }}>
            <Button
              label={`${entry.id === feed.conversation.identity?.leafId ? "● " : ""}${journalEntryLabel(entry)}`}
              tone="text"
              onPress={() => setSelected(entry)}
            />
          </View>
        ))}
        {selected ? (
          <NeoPiJournalContent
            entry={selected}
            environmentId={target.environmentId}
            nativeRef={feed.session?.ref ?? target.ref}
            cwd={feed.session?.cwd ?? null}
          />
        ) : null}
        <Button
          label="Continue from here"
          disabled={!selected || !feed.conversation.identity || pending}
          onPress={() => void navigate()}
        />
      </ScrollView>
    </NativeModal>
  );
}
