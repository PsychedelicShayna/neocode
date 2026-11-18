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

import type { NeoPiNativeJournalTail, NeoPiNativeKeyedStore } from "./NeoPiNativeProjection.ts";

/**
 * The bulk cursor reader (r12 §2.3 C2). Pure and synchronous: one call answers
 * one `read` from the projection's current state and the client-held cursor.
 * The server keeps nothing per observer between reads.
 */

/** What a read needs from a projection. `NeoPiNativeProjection` satisfies it. */
export interface NeoPiNativeReadSource {
  readonly domain: NeoPiNativeObservationDomain;
  readonly published: boolean;
  readonly store: NeoPiNativeKeyedStore;
  readonly journal: NeoPiNativeJournalTail;
  readonly horizonCursor: string | undefined;
  /** Ascending, contiguous `seq`. */
  readonly inbox: readonly NeoPiNativeInboxRecord[];
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
 * Answers one read. Pass rules are r12 C2's, in order:
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
 * Coherence (C2 "Reply coherence"): the domain fence is decided before any key;
 * the journal slice comes first, and a retired message or tool's tombstone is
 * held until the reader holds the durable entry that replaced it (invariant
 * 2); absence never removes in a patch (invariant 3), and only a completed
 * `full` pass lets the client reconcile membership (invariant 4).
 */
export function readNeoPiNativeObservation(
  source: NeoPiNativeReadSource,
  cursor: NeoPiNativeCursor | null,
  limits: NeoPiNativeReadLimits,
): NeoPiNativeSessionsReadResult {
  if (!source.published) return { type: "building" };
  const { store, journal, domain } = source;
  const sameDomain = cursor !== null && sameObservationDomain(cursor.epoch, domain);
  let base = sameDomain ? cursor.base : 0;
  let journalAt = sameDomain ? cursor.journalAt : null;
  let inboxSeq = sameDomain ? cursor.inboxSeq : 0;
  const lastInboxSeq = source.inbox[source.inbox.length - 1]?.seq ?? 0;
  const headId = journal.head?.id ?? null;

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
  let budget = limits.replyBytes;
  let journalSlice: NeoPiNativeJournalSlice | null = null;
  let coveredPosition = -1;
  const atPosition = journalAt === null ? -1 : journal.positionOf(journalAt);
  if (atPosition >= 0) {
    const entries: NeoPiNativeObservedJournalEntry[] = [];
    let used = 0;
    for (let position = atPosition + 1; position < journal.end; position++) {
      const entry = journal.at(position)!;
      const bytes = encodedBytes(entry);
      if (entries.length > 0 && used + bytes > budget / 2) break;
      entries.push(entry);
      used += bytes;
    }
    coveredPosition = atPosition + entries.length;
    const last = entries[entries.length - 1];
    if (last) {
      journalSlice = { continuity: "append", leafId: last.id, entries };
      journalAt = last.id;
      budget -= used;
    }
  } else if (journal.end > journal.start) {
    // C3.4: a reader behind the ring takes a fresh horizon page backward from
    // the leaf; what does not fit stays a placeholder on the client.
    const entries: NeoPiNativeObservedJournalEntry[] = [];
    let used = 0;
    let first = journal.end;
    for (let position = journal.end - 1; position >= journal.start; position--) {
      const entry = journal.at(position)!;
      const bytes = encodedBytes(entry);
      if (entries.length > 0 && used + bytes > budget / 2) break;
      entries.push(entry);
      used += bytes;
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
    coveredPosition = journal.end - 1;
    budget -= used;
  } else journalAt = null;
  const covered = (entryId: string) => {
    const position = journal.positionOf(entryId);
    return position < 0 || position <= coveredPosition;
  };

  const entities: NeoPiNativeEntity[] = [];
  const tombstones: NeoPiNativeTombstone[] = [];
  const segments: NeoPiNativeSegment[] = [];
  const segmentBudget = Math.max(1, Math.floor(limits.replyBytes / 2) - 160);
  let afterOrdinal = pass.afterOrdinal;
  let segment = pass.segment;
  let completed = pass.kind === "incremental" && pass.watermark === base;
  let sent = 0;
  for (
    let index = store.indexAfter(afterOrdinal), steps = 0;
    !completed && steps < limits.scanSteps;
    steps++
  ) {
    const record = store.recordAt(index);
    if (!record || record.ordinal > pass.lastOrdinal) {
      completed = true;
      break;
    }
    // A retired record's tombstone waits for its durable entry wherever it
    // would act: sent in an incremental pass, or removed by absence when a
    // full pass completes.
    if (
      record.value === null &&
      !record.removed &&
      record.joinEntryId !== null &&
      (pass.kind === "full" || record.revision > base) &&
      !covered(record.joinEntryId)
    )
      break;
    if (
      record.removed ||
      (pass.kind === "incremental" ? record.revision <= base : record.value === null)
    ) {
      afterOrdinal = record.ordinal;
      segment = null;
      index++;
      continue;
    }
    if (record.value === null) {
      const tombstone = { key: record.key, ordinal: record.ordinal, revision: record.revision };
      const bytes = encodedBytes(tombstone);
      if (sent > 0 && bytes > budget) break;
      tombstones.push(tombstone);
      budget -= bytes;
      sent++;
      afterOrdinal = record.ordinal;
      segment = null;
      index++;
      continue;
    }
    const entity: NeoPiNativeEntity = {
      key: record.key,
      ordinal: record.ordinal,
      revision: record.revision,
      value: record.value,
    };
    const json = JSON.stringify(entity);
    const bytes = utf8Length(json);
    if (bytes <= budget && (segment?.key !== record.key || segment.revision !== record.revision)) {
      entities.push(entity);
      budget -= bytes;
      sent++;
      segment = null;
      afterOrdinal = record.ordinal;
      index++;
      continue;
    }
    if (sent > 0) break;
    // Browser-hop segmentation (r12 §2.7 R1): one segment per reply; a newer
    // revision restarts at index 0.
    const bounds = segmentBounds(json, segmentBudget);
    const count = bounds.length - 1;
    const next =
      segment?.key === record.key && segment.revision === record.revision ? segment.nextIndex : 0;
    segments.push({
      key: record.key,
      revision: record.revision,
      index: next,
      count,
      encodedBytes: bytes,
      data: json.slice(bounds[next], bounds[next + 1]),
    });
    sent++;
    if (next + 1 < count)
      segment = { key: record.key, revision: record.revision, nextIndex: next + 1 };
    else {
      segment = null;
      afterOrdinal = record.ordinal;
    }
    break;
  }

  const inbox: NeoPiNativeInboxRecord[] = [];
  const firstSeq = source.inbox[0]?.seq ?? 1;
  for (let index = Math.max(0, inboxSeq - firstSeq + 1); index < source.inbox.length; index++) {
    const record = source.inbox[index]!;
    const bytes = encodedBytes(record);
    if (inbox.length > 0 && bytes > budget) break;
    inbox.push(record);
    budget -= bytes;
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
