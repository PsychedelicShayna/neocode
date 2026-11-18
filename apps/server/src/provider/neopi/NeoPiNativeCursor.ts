import type {
  NeoPiNativeCursor,
  NeoPiNativeEntity,
  NeoPiNativeInboxRecord,
  NeoPiNativeJournalSlice,
  NeoPiNativeObservationDomain,
  NeoPiNativeObservedJournalEntry,
  NeoPiNativePass,
  NeoPiNativeSegment,
  NeoPiNativeSessionsReadResult,
  NeoPiNativeTombstone,
} from "@t3tools/contracts";

import type {
  NeoPiNativeFence,
  NeoPiNativeJournalTail,
  NeoPiNativeKeyedStore,
  NeoPiNativeStoreRecord,
} from "./NeoPiNativeProjection.ts";

/**
 * The bulk cursor reader (r12 §2.3 C2). Synchronous: one call answers one
 * `read` from the projection's current state and the client-held cursor. Per
 * reader the server keeps only the oversized value that reader is in the
 * middle of receiving (its partly sent response), never a backlog.
 */

/** What a read needs from a projection. `NeoPiNativeProjection` satisfies it. */
export interface NeoPiNativeReadSource {
  readonly domain: NeoPiNativeObservationDomain;
  readonly published: boolean;
  readonly store: NeoPiNativeKeyedStore;
  readonly journal: NeoPiNativeJournalTail;
  /** Entries at and after this absolute position are held from readers. */
  readonly deliverableJournalEnd: number;
  readonly horizonCursor: string | undefined;
  /** Ascending `seq`; a `gap` stands for its whole `fromSeq..toSeq` interval. */
  readonly inbox: readonly NeoPiNativeInboxRecord[];
  /** Decides a leaf announced without its entry before anything is read (see the projection). */
  settlePendingLeaf(): NeoPiNativeFence;
}

export interface NeoPiNativeReadLimits {
  /** Records visited per read, whether or not they are sent. */
  readonly scanSteps: number;
  /** Encoded bytes per reply; a value above half of it is sent in segments. */
  readonly replyBytes: number;
}

/** C2 "Identity domains": any field differing makes a cursor unusable. */
export function sameObservationDomain(
  left: NeoPiNativeObservationDomain,
  right: NeoPiNativeObservationDomain,
): boolean {
  return (
    left.serverIncarnation === right.serverIncarnation &&
    left.ownerEpoch === right.ownerEpoch &&
    left.projectionIncarnation === right.projectionIncarnation &&
    left.buildAttempt === right.buildAttempt &&
    left.branchGeneration === right.branchGeneration
  );
}

/**
 * A new pass captures its watermark and cohort together, once (C2: "it
 * captures, together and once, a new watermark (the current revision) and a
 * new `lastOrdinal` (the current highest ordinal), issues a new `passId` and
 * resets `afterKey`"; the position is `afterOrdinal` here). The pass id names
 * the cut, so two passes with one id have one cohort.
 */
function startPass(kind: "incremental" | "full", store: NeoPiNativeKeyedStore): NeoPiNativePass {
  return {
    kind,
    passId: `${kind}:${store.revision}:${store.lastOrdinal}`,
    watermark: store.revision,
    lastOrdinal: store.lastOrdinal,
    afterOrdinal: null,
    segment: null,
  };
}

/** UTF-8 bytes of a string with no lone surrogates (any `JSON.stringify` output). */
function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

const encodedBytes = (value: unknown) => utf8Length(JSON.stringify(value));

/**
 * Cuts `json` into pieces whose encoding as a JSON string stays within
 * `budget` bytes, never inside a surrogate pair. The cut depends only on
 * `json` and `budget`, so every read of one revision cuts it the same way.
 */
function segmentBounds(json: string, budget: number): number[] {
  const bounds = [0];
  let used = 2;
  for (let index = 0; index < json.length;) {
    const code = json.charCodeAt(index);
    const pair = code >= 0xd800 && code < 0xdc00;
    const width = pair
      ? 4
      : code === 0x22 || code === 0x5c
        ? 2
        : code < 0x20
          ? 6
          : code < 0x80
            ? 1
            : code < 0x800
              ? 2
              : 3;
    if (used + width > budget && index > bounds[bounds.length - 1]!) {
      bounds.push(index);
      used = 2;
    }
    used += width;
    index += pair ? 2 : 1;
  }
  bounds.push(json.length);
  return bounds;
}

/**
 * Answers one read for `reader` (its lease id). Pass rules are r12 C2's, in order:
 *
 * - A null cursor or a cursor from another identity domain starts a full pass
 *   (a rebase); so does a pass starting with `base` older than the tombstone
 *   horizon.
 * - An incremental pass whose `base` the horizon overtakes is promoted once:
 *   "Promotion ends the incremental pass without completing it; `base` is not
 *   advanced. At that read the server starts a full pass exactly as it does for
 *   a read whose `base` is already older than the horizon" (C2 "Promotion,
 *   stated exactly (r9)"). The full pass then keeps its own cut whatever the
 *   horizon does.
 * - A pass visits its fixed cohort (ordinal ≤ `lastOrdinal`) in ordinal order
 *   and never advances past a record it did not send or skip, so a byte cut
 *   neither skips nor repeats a key. When the cohort is exhausted, `base`
 *   becomes the watermark.
 *
 * Coherence (C2 "Reply coherence"): the domain fence is decided before any key.
 * Invariant 2, "a message's alias, its durable entry and its retirement form
 * one join, applied together or held": the journal slice comes first and stops
 * at an entry whose live copy is not known yet; a retirement whose entry is in
 * this reply's slice is sent in the same reply; a retirement whose entry the
 * reader can still receive waits for it; a retirement whose entry is out of
 * reach (behind a horizon page or out of the ring) is sent with `joinEntryId`,
 * so the client keeps the live row until it holds that entry. Absence never
 * removes in a patch (invariant 3), and only a completed `full` pass lets the
 * client reconcile membership (invariant 4).
 */
export function readNeoPiNativeObservation(
  source: NeoPiNativeReadSource,
  cursor: NeoPiNativeCursor | null,
  limits: NeoPiNativeReadLimits,
  reader: string,
): NeoPiNativeSessionsReadResult {
  // A quiet move to a leaf the tail no longer holds is decided here, so the
  // next read already serves the new branch with no further native frame.
  source.settlePendingLeaf();
  if (!source.published) return { type: "building" };
  const { store, journal, domain } = source;
  const sameDomain = cursor !== null && sameObservationDomain(cursor.epoch, domain);
  let base = sameDomain ? cursor.base : 0;
  let journalAt = sameDomain ? cursor.journalAt : null;
  let inboxSeq = sameDomain ? cursor.inboxSeq : 0;
  const lastInboxSeq = source.inbox[source.inbox.length - 1]?.seq ?? 0;
  const deliverableEnd = Math.max(
    journal.start,
    Math.min(source.deliverableJournalEnd, journal.end),
  );
  const headId = journal.at(deliverableEnd - 1)?.id ?? null;

  let pass: NeoPiNativePass;
  let promoted = false;
  let startedHere = true;
  if (!sameDomain) pass = startPass("full", store);
  else if (cursor.pass === null) {
    if (base === store.revision && journalAt === headId && inboxSeq >= lastInboxSeq)
      return { type: "unchanged" };
    pass = startPass(base < store.horizon ? "full" : "incremental", store);
  } else if (cursor.pass.kind === "incremental" && base < store.horizon) {
    pass = startPass("full", store);
    promoted = true;
  } else {
    pass = cursor.pass;
    startedHere = false;
  }
  const baseCursor: NeoPiNativeCursor = { epoch: domain, base, pass, inboxSeq, journalAt };

  // Journal first, at most half the reply unless one entry alone is larger.
  // Every journal entry, key and inbox record visited is one scan step.
  // `replyBytes` bounds the payload; the reply's framing (two cursors and the
  // fixed fields) is added on top and bounded by the cursor's own size.
  let budget = limits.replyBytes;
  let steps = 0;
  let journalSlice: NeoPiNativeJournalSlice | null = null;
  /** Absolute positions the reader holds after this reply, continuously: [historyStart, coveredPosition]. */
  let historyStart = journal.start;
  let coveredPosition = -1;
  // A reader of this domain that held an empty history follows appends from
  // the tail's start, as long as nothing has been evicted since it restarted.
  const heldNothing =
    sameDomain && cursor !== null && journalAt === null && journal.start === journal.origin;
  const atPosition = heldNothing
    ? journal.start - 1
    : journalAt === null
      ? -1
      : journal.positionOf(journalAt);
  if ((atPosition >= 0 || heldNothing) && atPosition < deliverableEnd) {
    const entries: NeoPiNativeObservedJournalEntry[] = [];
    let used = 0;
    for (let position = atPosition + 1; position < deliverableEnd; position++) {
      const entry = journal.at(position)!;
      const bytes = encodedBytes(entry);
      if (entries.length > 0 && (used + bytes > budget / 2 || steps >= limits.scanSteps)) break;
      entries.push(entry);
      used += bytes;
      steps++;
    }
    coveredPosition = atPosition + entries.length;
    const last = entries[entries.length - 1];
    if (last) {
      journalSlice = { continuity: "append", leafId: last.id, entries };
      journalAt = last.id;
      budget -= used;
    }
  } else if (deliverableEnd > journal.start) {
    // C3.4: a reader behind the ring takes a fresh horizon page backward from
    // the leaf; what does not fit stays a placeholder on the client.
    const entries: NeoPiNativeObservedJournalEntry[] = [];
    let used = 0;
    let first = deliverableEnd;
    for (let position = deliverableEnd - 1; position >= journal.start; position--) {
      const entry = journal.at(position)!;
      const bytes = encodedBytes(entry);
      if (entries.length > 0 && (used + bytes > budget / 2 || steps >= limits.scanSteps)) break;
      entries.push(entry);
      used += bytes;
      steps++;
      first = position;
    }
    entries.reverse();
    const nextCursor = first === journal.start ? source.horizonCursor : undefined;
    journalSlice = {
      continuity: "horizon",
      leafId: headId,
      entries,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
    journalAt = headId;
    historyStart = first;
    coveredPosition = deliverableEnd - 1;
    budget -= used;
  } else if (atPosition < 0) journalAt = null;
  /**
   * `covered`: the reader holds the entry after this reply. `later`: it will
   * receive it by following appends. `unreachable`: it can only get it by
   * loading history (behind its horizon page, or out of the ring).
   */
  const joinState = (entryId: string): "covered" | "later" | "unreachable" => {
    const position = journal.positionOf(entryId);
    if (position < 0 || position < historyStart) return "unreachable";
    return position <= coveredPosition ? "covered" : "later";
  };

  const entities: NeoPiNativeEntity[] = [];
  const tombstones: NeoPiNativeTombstone[] = [];
  const tombstoneKeys = new Set<string>();
  const segments: NeoPiNativeSegment[] = [];
  const tombstoneOf = (record: NeoPiNativeStoreRecord): NeoPiNativeTombstone => ({
    key: record.key,
    ordinal: record.ordinal,
    revision: record.revision,
    ...(record.joinEntryId === null ? {} : { joinEntryId: record.joinEntryId }),
  });
  // Retirements joined to entries in this slice travel with them.
  for (const entry of journalSlice?.entries ?? [])
    for (const record of store.retiredBy(entry.id) ?? []) {
      if (record.value !== null || record.removed) continue;
      if (pass.kind === "incremental" && record.revision <= base) continue;
      const tombstone = tombstoneOf(record);
      tombstones.push(tombstone);
      tombstoneKeys.add(record.key);
      budget -= encodedBytes(tombstone);
    }

  const segmentBudget = Math.max(1, Math.floor(limits.replyBytes / 2) - 160);
  let afterOrdinal = pass.afterOrdinal;
  let segment = pass.segment;
  let completed = pass.kind === "incremental" && pass.watermark === base;
  let sent = 0;
  for (
    let index = store.indexAfter(afterOrdinal);
    !completed && steps < limits.scanSteps;
    steps++
  ) {
    const record = store.recordAt(index);
    if (!record || record.ordinal > pass.lastOrdinal) {
      completed = true;
      break;
    }
    const advance = () => {
      afterOrdinal = record.ordinal;
      segment = null;
      index++;
    };
    const retired = record.value === null && !record.removed;
    const joined = retired && record.joinEntryId !== null;
    // A full pass sends a retirement only when it carries a join, so the
    // client learns the join instead of removing the row by absence.
    if (
      record.removed ||
      (pass.kind === "incremental" ? record.revision <= base : retired && !joined)
    ) {
      advance();
      continue;
    }
    if (retired) {
      if (joined && joinState(record.joinEntryId!) === "later") break;
      if (!tombstoneKeys.has(record.key)) {
        const tombstone = tombstoneOf(record);
        const bytes = encodedBytes(tombstone);
        if (sent > 0 && bytes > budget) break;
        tombstones.push(tombstone);
        tombstoneKeys.add(record.key);
        budget -= bytes;
      }
      sent++;
      advance();
      continue;
    }
    const entity: NeoPiNativeEntity = {
      key: record.key,
      ordinal: record.ordinal,
      revision: record.revision,
      value: record.value!,
    };
    const json = JSON.stringify(entity);
    const bytes = utf8Length(json);
    const continuing = segment?.key === record.key ? segment : null;
    if (bytes <= budget && continuing === null) {
      entities.push(entity);
      budget -= bytes;
      sent++;
      advance();
      continue;
    }
    if (sent > 0) break;
    // Browser-hop segmentation (r12 §2.7 R1): one segment per reply, cut from
    // the reader's own frozen encoding, so a pass finishes "in a bounded number
    // of reads under fair service whatever the producer does" (C2 "Progress,
    // stated exactly"): neither a changing value nor another reader restarts
    // the transfer, and the newer revision comes with the next pass.
    const held = store.transferOf(reader);
    const resumes =
      held !== undefined &&
      continuing !== null &&
      held.key === record.key &&
      held.revision === continuing.revision;
    const encoding = resumes
      ? held
      : store.beginTransfer(reader, record, json, () => segmentBounds(json, segmentBudget));
    const next = resumes ? continuing.nextIndex : 0;
    const count = encoding.bounds.length - 1;
    segments.push({
      key: record.key,
      revision: encoding.revision,
      index: next,
      count,
      encodedBytes: utf8Length(encoding.json),
      data: encoding.json.slice(encoding.bounds[next], encoding.bounds[next + 1]),
    });
    sent++;
    if (next + 1 < count)
      segment = { key: record.key, revision: encoding.revision, nextIndex: next + 1 };
    else {
      store.endTransfer(reader);
      advance();
    }
    break;
  }

  const inbox: NeoPiNativeInboxRecord[] = [];
  let low = 0;
  let high = source.inbox.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (source.inbox[middle]!.seq <= inboxSeq) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < source.inbox.length; index++) {
    const record = source.inbox[index]!;
    const bytes = encodedBytes(record);
    if (inbox.length > 0 && (bytes > budget || steps >= limits.scanSteps)) break;
    inbox.push(record);
    budget -= bytes;
    steps++;
    inboxSeq = record.seq;
  }

  if (completed) base = pass.watermark;
  const continuation: NeoPiNativeCursor = {
    epoch: domain,
    base,
    pass: completed ? null : { ...pass, afterOrdinal, segment },
    inboxSeq,
    journalAt,
  };
  return {
    type: "pass",
    passId: pass.passId,
    kind: pass.kind,
    baseCursor,
    coveredThrough: pass.watermark,
    continuation,
    complete: completed && startedHere,
    promoted,
    entities,
    tombstones,
    segments,
    inbox,
    journal: journalSlice,
  };
}
