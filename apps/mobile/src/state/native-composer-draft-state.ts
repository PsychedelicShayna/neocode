import type { ComposerDraft } from "./use-composer-drafts";

const emptyDraft = (): ComposerDraft => ({ text: "", attachments: [] });
const canonicalContent = (draft: ComposerDraft): ComposerDraft => {
  const { nativeSessionKey: _binding, ...content } = draft;
  return content;
};

/** Thread keys are UI aliases. Native-file keys retain each session's draft across identity switches. */
export function bindNativeComposerDraft(
  current: Record<string, ComposerDraft>,
  alias: string,
  canonical: string,
) {
  const previous = current[alias] ?? emptyDraft();
  if (previous.nativeSessionKey === canonical) return current;
  const next = { ...current };
  if (previous.nativeSessionKey) next[previous.nativeSessionKey] = canonicalContent(previous);
  const saved = next[canonical];
  const draft = saved ?? (previous.nativeSessionKey ? emptyDraft() : canonicalContent(previous));
  // If a second alias already has an unsent legacy draft, retain it independently.
  if (saved && !previous.nativeSessionKey && (previous.text || previous.attachments.length)) {
    next[`${alias}-unbound-draft`] = canonicalContent(previous);
  }
  next[canonical] = canonicalContent(draft);
  next[alias] = { ...draft, nativeSessionKey: canonical };
  return next;
}

/** Normal composer writes update the canonical copy and any aliases for that same native file. */
export function syncNativeComposerDrafts(
  current: Record<string, ComposerDraft>,
  changed: Record<string, ComposerDraft>,
) {
  if (current === changed) return current;
  let next = changed;
  const canonicalChanges = new Set<string>();
  for (const draft of Object.values(changed)) {
    if (
      draft.nativeSessionKey &&
      changed[draft.nativeSessionKey] !== current[draft.nativeSessionKey]
    )
      canonicalChanges.add(draft.nativeSessionKey);
  }
  for (const [alias, draft] of Object.entries(changed)) {
    const key = draft.nativeSessionKey ?? current[alias]?.nativeSessionKey;
    if (!key || draft === current[alias]) continue;
    if (next === changed) next = { ...changed };
    const bound = draft.nativeSessionKey === key ? draft : { ...draft, nativeSessionKey: key };
    next[alias] = bound;
    next[key] = canonicalContent(bound);
    canonicalChanges.add(key);
  }
  for (const [alias, previous] of Object.entries(current)) {
    if (!previous.nativeSessionKey || alias in changed) continue;
    if (next === changed) next = { ...changed };
    const empty = {
      ...emptyDraft(),
      ...(previous.nativeTree ? { nativeTree: previous.nativeTree } : {}),
    };
    next[previous.nativeSessionKey] = empty;
    next[alias] = { ...empty, nativeSessionKey: previous.nativeSessionKey };
    canonicalChanges.add(previous.nativeSessionKey);
  }
  for (const [alias, draft] of Object.entries(next)) {
    if (!draft.nativeSessionKey || !canonicalChanges.has(draft.nativeSessionKey)) continue;
    const canonical = next[draft.nativeSessionKey];
    if (canonical) {
      if (next === changed) next = { ...changed };
      next[alias] = { ...canonical, nativeSessionKey: draft.nativeSessionKey };
    }
  }
  return next;
}

/** A same-session file move transfers the draft; a fork still gets its own draft. */
export function relocateNativeComposerDraft(
  current: Record<string, ComposerDraft>,
  from: string,
  to: string,
): Record<string, ComposerDraft> {
  if (from === to || !current[from]) return current;
  const source = canonicalContent(current[from]);
  const destination = current[to];
  const text =
    !destination?.text || destination.text === source.text
      ? source.text
      : [source.text, destination.text].filter(Boolean).join("\n\n");
  const attachments = destination
    ? [
        ...new Map(
          [...destination.attachments, ...source.attachments].map((item) => [item.id, item]),
        ).values(),
      ]
    : source.attachments;
  const records = new Map(
    [...(destination?.context?.records ?? []), ...(source.context?.records ?? [])].map((record) => [
      record.contextId,
      record,
    ]),
  );
  const moved: ComposerDraft = {
    ...destination,
    ...source,
    text,
    attachments,
    ...(records.size ? { context: { version: 1, records: [...records.values()] } } : {}),
    ...(source.importedShareIds || destination?.importedShareIds
      ? {
          importedShareIds: [
            ...new Set([
              ...(destination?.importedShareIds ?? []),
              ...(source.importedShareIds ?? []),
            ]),
          ],
        }
      : {}),
  };
  const { [from]: _old, ...next } = current;
  next[to] = moved;
  for (const [key, draft] of Object.entries(next)) {
    if (draft.nativeSessionKey === from) next[key] = { ...moved, nativeSessionKey: to };
  }
  return next;
}
