import type {
  NeoPiNativeCursor,
  NeoPiNativeEntity,
  NeoPiNativeObservationDomain,
  NeoPiNativeSessionsReadResult,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  readNeoPiNativeObservation,
  type NeoPiNativeReadLimits,
  type NeoPiNativeReadSource,
} from "./NeoPiNativeCursor.ts";
import {
  NeoPiNativeJournalTail,
  NeoPiNativeKeyedStore,
  NeoPiNativeProjection,
} from "./NeoPiNativeProjection.ts";

const domain: NeoPiNativeObservationDomain = {
  serverIncarnation: "server-1",
  ownerEpoch: 1,
  projectionIncarnation: 0,
  buildAttempt: 0,
  branchGeneration: 0,
};

/** An entity small enough that two never fit one reply of `ONE_KEY`. */
const presentation = (n: number) => ({ class: "presentation" as const, value: { n } });
const ONE_KEY: NeoPiNativeReadLimits = { scanSteps: 1000, replyBytes: 160 };

const storeSource = (store: NeoPiNativeKeyedStore): NeoPiNativeReadSource => ({
  domain,
  published: true,
  store,
  journal: new NeoPiNativeJournalTail(16),
  horizonCursor: undefined,
  inbox: [],
});

type PassReply = Extract<NeoPiNativeSessionsReadResult, { type: "pass" }>;

const passReply = (reply: NeoPiNativeSessionsReadResult): PassReply => {
  assert.equal(reply.type, "pass");
  return reply as PassReply;
};

/**
 * The client side of C2, as small as the rule: keep the newest revision per
 * key, remove only by tombstone, and when a `full` pass completes remove what
 * the pass did not return unless held at a revision above its watermark.
 * Journal entry ids it has received are kept to check join coherence.
 */
class Mirror {
  readonly held = new Map<string, NeoPiNativeEntity>();
  readonly entryIds = new Set<string>();
  cursor: NeoPiNativeCursor | null = null;
  #passId: string | null = null;
  #returned = new Set<string>();
  #segments = new Map<string, string[]>();

  apply(result: NeoPiNativeSessionsReadResult): PassReply | undefined {
    if (result.type !== "pass") return undefined;
    if (result.promoted || result.passId !== this.#passId) {
      this.#passId = result.passId;
      this.#returned = new Set();
    }
    for (const entry of result.journal?.entries ?? []) this.entryIds.add(entry.id);
    const take = (entity: NeoPiNativeEntity) => {
      this.#returned.add(entity.key);
      const held = this.held.get(entity.key);
      if (!held || held.revision < entity.revision) this.held.set(entity.key, entity);
    };
    for (const entity of result.entities) take(entity);
    for (const segment of result.segments) {
      const parts = segment.index === 0 ? [] : (this.#segments.get(segment.key) ?? []);
      parts[segment.index] = segment.data;
      this.#segments.set(segment.key, parts);
      if (segment.index + 1 === segment.count) {
        this.#segments.delete(segment.key);
        take(JSON.parse(parts.join("")) as NeoPiNativeEntity);
      }
    }
    for (const tombstone of result.tombstones) {
      const held = this.held.get(tombstone.key);
      if (held && held.revision < tombstone.revision) this.held.delete(tombstone.key);
    }
    if (result.kind === "full" && result.continuation.pass === null)
      for (const [key, held] of this.held)
        if (!this.#returned.has(key) && held.revision <= result.coveredThrough)
          this.held.delete(key);
    this.cursor = result.continuation;
    return result;
  }

  read(source: NeoPiNativeReadSource, limits: NeoPiNativeReadLimits): PassReply {
    return passReply(this.apply(readNeoPiNativeObservation(source, this.cursor, limits))!);
  }

  /** Reads until the server answers `unchanged`. */
  drain(source: NeoPiNativeReadSource, limits: NeoPiNativeReadLimits): void {
    for (let reads = 0; ; reads++) {
      assert.isBelow(reads, 100);
      if (this.apply(readNeoPiNativeObservation(source, this.cursor, limits)) === undefined) return;
    }
  }
}

const liveKeys = (store: NeoPiNativeKeyedStore) =>
  [...store.values()].filter((record) => record.value !== null).map((record) => record.key);

describe("NeoPiNativeCursor", () => {
  it("S10 each pass ends with both hot keys, and keys born during it arrive in the next", () => {
    const store = new NeoPiNativeKeyedStore(10_000);
    const source = storeSource(store);
    const mirror = new Mirror();
    store.put("a", presentation(0));
    store.put("b", presentation(0));
    mirror.read(source, { scanSteps: 1000, replyBytes: 10_000 });
    let completedPasses = 0;
    let readsInPass = 0;
    let delivered = new Set<string>();
    let cohortEnd = 0;
    for (let n = 1; n <= 60; n++) {
      store.put("a", presentation(2 * n - 1));
      store.put("b", presentation(2 * n));
      store.put(`new-${n}`, presentation(n));
      // Tombstone churn: a key created and removed before every read.
      store.put(`churn-${n}`, presentation(n));
      store.remove(`churn-${n}`);
      const reply = mirror.read(source, ONE_KEY);
      assert.isFalse(reply.promoted);
      assert.isAtMost(reply.entities.length, 1);
      const pass = reply.baseCursor.pass!;
      cohortEnd = pass.lastOrdinal;
      for (const entity of reply.entities) {
        assert.isAtMost(
          entity.ordinal,
          cohortEnd,
          "a key born after the cut waits for the next pass",
        );
        delivered.add(entity.key);
      }
      readsInPass++;
      if (reply.continuation.pass !== null) {
        // The position never passes a cohort key that changed and was not sent.
        const after = reply.continuation.pass.afterOrdinal ?? 0;
        for (const record of store.values())
          if (
            record.ordinal <= after &&
            record.revision > reply.baseCursor.base &&
            record.revision <= pass.watermark
          )
            assert.isTrue(
              delivered.has(record.key) || record.value === null,
              `skipped ${record.key}`,
            );
        continue;
      }
      completedPasses++;
      assert.isTrue(delivered.has("a") && delivered.has("b"), "both hot keys inside every pass");
      for (const record of store.values())
        if (record.value !== null && record.ordinal <= cohortEnd)
          assert.isTrue(mirror.held.has(record.key), `${record.key} missing after its pass`);
      assert.isAtMost(readsInPass, cohortEnd + 1);
      readsInPass = 0;
      delivered = new Set();
    }
    assert.isAtLeast(completedPasses, 3);
  });

  it("S17 a horizon that overtakes base on every reply promotes once and completes", () => {
    const store = new NeoPiNativeKeyedStore(0);
    const source = storeSource(store);
    const mirror = new Mirror();
    for (let key = 1; key <= 6; key++) store.put(`k${key}`, presentation(0));
    mirror.read(source, { scanSteps: 1000, replyBytes: 10_000 });
    for (let key = 1; key <= 6; key++) store.put(`k${key}`, presentation(1));
    store.put("k3", presentation(2));
    let promotions = 0;
    let replies = 0;
    let fullPassId: string | null = null;
    for (;;) {
      const reply = mirror.read(source, ONE_KEY);
      replies++;
      if (reply.promoted) {
        promotions++;
        fullPassId = reply.passId;
        // After the cut, the client learns k5 from another current update; it
        // is then removed, and its tombstone expires at once.
        store.put("k5", presentation(9));
        const k5 = store.get("k5")!;
        mirror.held.set("k5", {
          key: "k5",
          ordinal: k5.ordinal,
          revision: k5.revision,
          value: presentation(9),
        });
        store.remove("k5");
        store.remove("k3");
      } else if (fullPassId !== null)
        assert.equal(reply.passId, fullPassId, "the full pass is never restarted");
      if (reply.continuation.pass === null) {
        assert.equal(reply.kind, "full");
        break;
      }
      // Advance the horizon past the starting base between every pair of replies.
      store.put(`churn-${replies}`, presentation(replies));
      store.remove(`churn-${replies}`);
      assert.isBelow(replies, 40);
    }
    assert.equal(promotions, 1);
    assert.isFalse(mirror.held.has("k3"), "stale membership removed at full-pass completion");
    assert.isTrue(mirror.held.has("k5"), "a key held above the watermark is not removed");
    for (const key of ["k1", "k2", "k4", "k6"])
      assert.equal(mirror.held.get(key)?.value.class, "presentation");
  });

  describe("S17a promotion takes a fresh cut", () => {
    /** Through the prefix: watermark 10, cohort a, b; `a` skipped, `c` born at 11, `b` returned at 12, deleted at 13. */
    const prefix = () => {
      const store = new NeoPiNativeKeyedStore(0);
      const source = storeSource(store);
      const mirror = new Mirror();
      store.put("a", presentation(1));
      store.put("b", presentation(2));
      mirror.read(source, { scanSteps: 1000, replyBytes: 10_000 });
      while (store.revision < 10) store.put("b", presentation(store.revision + 1));
      const first = mirror.read(source, { ...ONE_KEY, scanSteps: 1 });
      assert.deepEqual(
        {
          kind: first.kind,
          watermark: first.baseCursor.pass?.watermark,
          sent: first.entities.length,
        },
        { kind: "incremental", watermark: 10, sent: 0 },
      );
      store.put("c", presentation(11));
      store.put("b", presentation(12));
      const second = mirror.read(source, { ...ONE_KEY, scanSteps: 1 });
      assert.deepEqual(
        second.entities.map((entity) => [entity.key, entity.revision]),
        [["b", 12]],
      );
      assert.isNotNull(second.continuation.pass);
      store.remove("b");
      assert.deepEqual([store.revision, store.horizon], [13, 13]);
      return { store, source, mirror, incrementalPassId: second.passId };
    };

    it("captures watermark 13 with c in the cohort and removes b at completion", () => {
      const { store, source, mirror, incrementalPassId } = prefix();
      const promoted = mirror.read(source, { ...ONE_KEY, scanSteps: 2 });
      assert.isTrue(promoted.promoted);
      assert.equal(promoted.kind, "full");
      assert.notEqual(promoted.passId, incrementalPassId);
      assert.deepEqual(
        [
          promoted.baseCursor.pass?.watermark,
          promoted.baseCursor.pass?.lastOrdinal,
          promoted.baseCursor.base,
        ],
        [13, store.get("c")!.ordinal, 2],
      );
      assert.deepEqual(
        promoted.entities.map((entity) => entity.key),
        ["a"],
      );
      store.put("d", presentation(14));
      // The client learns `a` at 15 from another current update; `a` is then
      // deleted, which moves the horizon again.
      store.put("a", presentation(15));
      mirror.held.set("a", { key: "a", ordinal: 1, revision: 15, value: presentation(15) });
      store.remove("a");
      assert.equal(store.horizon, 16);
      const last = mirror.read(source, { ...ONE_KEY, scanSteps: 2 });
      assert.isFalse(last.promoted, "moving the horizon again does not restart the full pass");
      assert.equal(last.passId, promoted.passId);
      assert.deepEqual(
        last.entities.map((entity) => entity.key),
        ["c"],
      );
      assert.isNull(last.continuation.pass);
      assert.deepEqual([last.coveredThrough, last.continuation.base], [13, 13]);
      assert.isFalse(mirror.held.has("b"), "b at 12 is not newer than 13");
      assert.isTrue(mirror.held.has("a"), "a learned at 15 is not removed");
      assert.isFalse(mirror.held.has("d"), "d was born after the cut");
      const next = mirror.read(source, { scanSteps: 1000, replyBytes: 10_000 });
      assert.include(
        next.entities.map((entity) => entity.key),
        "d",
      );
      assert.deepEqual([...mirror.held.keys()].sort(), liveKeys(store).sort());
    });

    it("negative: keeping the old cohort while moving the watermark never returns c", () => {
      const { store, source, mirror } = prefix();
      const held = mirror.cursor!;
      mirror.cursor = {
        ...held,
        pass: {
          kind: "full",
          passId: "old-cohort",
          watermark: 13,
          lastOrdinal: held.pass!.lastOrdinal,
          afterOrdinal: null,
          segment: null,
        },
      };
      for (let reads = 0; reads < 10 && mirror.cursor?.pass !== null; reads++)
        mirror.read(source, { ...ONE_KEY, scanSteps: 2 });
      // Later traffic starts ordinary incremental passes above the moved watermark.
      store.put("e", presentation(14));
      mirror.drain(source, { scanSteps: 1000, replyBytes: 10_000 });
      assert.isTrue(liveKeys(store).includes("c"));
      assert.isFalse(mirror.held.has("c"), "the wrong rule skips the key born between the cuts");
    });
  });

  it("S11 a rebase larger than several replies completes while every key changes, joins held together", () => {
    const sessionId = "session-1";
    const projection = new NeoPiNativeProjection({
      domain,
      tombstoneCapacity: 1000,
      journalCapacity: 64,
    });
    projection.fold({
      type: "journal_state",
      reason: "identity",
      sessionId,
      sessionFile: "/s.jsonl",
      leafId: null,
    });
    projection.applyStateReply({ sessionId }, projection.mark());
    projection.applyJournalPage({ sessionId, entries: [] }, projection.mark());
    const body = (id: number, length: number) => ({
      role: "assistant",
      content: [{ type: "text", text: `${id}:`.padEnd(length, "x") }],
    });
    const ids = Array.from({ length: 10 }, (_, index) => `m${index}`);
    for (const [index, messageId] of ids.entries())
      projection.fold({ type: "message_start", messageId, message: body(index, 80) });
    const stale = new Mirror();
    stale.cursor = {
      epoch: { ...domain, ownerEpoch: 0 },
      base: 999,
      pass: null,
      inboxSeq: 0,
      journalAt: "gone",
    };
    const mirror = new Mirror();
    const limits = { scanSteps: 1000, replyBytes: 600 };
    let parent: string | null = null;
    let reads = 0;
    let length = 80;
    const seen = new Set<string>();
    let retired = 0;
    let rebased = false;
    const firstStale = stale.read(projection, limits);
    // Invariant 1: the fence decides the reply before any key is read.
    assert.deepEqual(
      [firstStale.kind, firstStale.baseCursor.epoch, firstStale.journal],
      ["full", projection.domain, null],
    );
    for (;;) {
      const reply = mirror.read(projection, limits);
      reads++;
      for (const tombstone of reply.tombstones) {
        const record = projection.store.get(tombstone.key);
        if (record?.joinEntryId)
          assert.isTrue(mirror.entryIds.has(record.joinEntryId), "retired only with its entry");
      }
      // No missing body: once delivered, a message stays a held body until its
      // durable entry is held.
      for (const messageId of ids) {
        const held = mirror.held.has(`message:${messageId}`);
        if (seen.has(messageId))
          assert.isTrue(
            held || mirror.entryIds.has(`entry-${messageId}`),
            `${messageId} lost without its entry`,
          );
        if (held) seen.add(messageId);
      }
      if (reads === 1)
        assert.isNotNull(reply.continuation.pass, "the rebase spans several replies");
      if (reply.continuation.pass === null) {
        if (retired === 4) break;
        rebased = true;
      }
      assert.isBelow(reads, 60, "passes complete without producer quiescence");
      // Every mutable key changes between reads.
      length += 7;
      for (const [index, messageId] of ids.entries())
        projection.fold({ type: "message_update", messageId, message: body(index, length) });
      // Once the rebase completed, retire the next key in scan order: alias,
      // then a burst of entries so its join entry is several replies away from
      // the reply that reaches its tombstone.
      const retiring = ids[retired];
      if (rebased && retiring !== undefined && retired < 4) {
        retired++;
        projection.fold({
          type: "message_end",
          messageId: retiring,
          message: body(retired, length),
        });
        projection.fold({
          type: "message_persisted",
          sessionId,
          messageId: retiring,
          entryId: `entry-${retiring}`,
        });
        for (let filler = 0; filler < 8; filler++) {
          const id = `filler-${reads}-${filler}`;
          projection.fold({
            type: "journal_entry",
            sessionId,
            entry: { id, parentId: parent, type: "custom", timestamp: "t", data: "y".repeat(200) },
          });
          parent = id;
        }
        projection.fold({
          type: "journal_entry",
          sessionId,
          entry: {
            id: `entry-${retiring}`,
            parentId: parent,
            type: "message",
            timestamp: "t",
            message: body(retired, length),
          },
        });
        parent = `entry-${retiring}`;
      }
    }
    mirror.drain(projection, limits);
    for (const messageId of ids.slice(0, 4)) {
      assert.isFalse(
        mirror.held.has(`message:${messageId}`),
        `${messageId} duplicated after its entry`,
      );
      assert.isTrue(mirror.entryIds.has(`entry-${messageId}`));
    }
    for (const messageId of ids.slice(4)) assert.isTrue(mirror.held.has(`message:${messageId}`));
  });

  it("S14 an idle cursor reads unchanged, and essential state outranks an older bulk reply", () => {
    const sessionId = "session-1";
    const essential: number[] = [];
    const projection = new NeoPiNativeProjection({
      domain,
      tombstoneCapacity: 100,
      journalCapacity: 16,
      onEssential: (envelope) => essential.push(envelope.revision),
    });
    assert.deepEqual(readNeoPiNativeObservation(projection, null, ONE_KEY), { type: "building" });
    projection.fold({
      type: "journal_state",
      reason: "identity",
      sessionId,
      sessionFile: "/s.jsonl",
      leafId: null,
    });
    projection.applyStateReply({ sessionId, isStreaming: true }, projection.mark());
    projection.applyJournalPage({ sessionId, entries: [] }, projection.mark());
    const mirror = new Mirror();
    const bulk = mirror.read(projection, { scanSteps: 100, replyBytes: 10_000 });
    assert.isNull(bulk.continuation.pass);
    assert.deepEqual(readNeoPiNativeObservation(projection, mirror.cursor, ONE_KEY), {
      type: "unchanged",
    });
    projection.fold({
      type: "extension_ui_request",
      id: "dialog-1",
      method: "confirm",
      title: "?",
    });
    const newest = Math.max(...bulk.entities.map((entity) => entity.revision), bulk.coveredThrough);
    assert.isAbove(
      essential[essential.length - 1]!,
      newest,
      "one revision space for essential and bulk",
    );
  });

  it("segments a value above the reply budget and restarts on a newer revision", () => {
    const store = new NeoPiNativeKeyedStore(10);
    const source = storeSource(store);
    const mirror = new Mirror();
    const big = (tag: string) => ({
      class: "presentation" as const,
      value: { text: `${tag}"é😀`.repeat(60) },
    });
    store.put("big", big("v1"));
    store.put("small", presentation(1));
    const limits = { scanSteps: 100, replyBytes: 400 };
    const first = mirror.read(source, limits);
    assert.equal(first.segments[0]?.index, 0);
    store.put("big", big("v2"));
    let reads = 1;
    while (mirror.cursor?.pass !== null) {
      const reply = mirror.read(source, limits);
      for (const segment of reply.segments)
        assert.isAtMost(JSON.stringify(segment).length, limits.replyBytes / 2);
      reads++;
      assert.isBelow(reads, 200);
    }
    assert.deepEqual(mirror.held.get("big")?.value, big("v2"));
    assert.deepEqual(mirror.held.get("small")?.value, presentation(1));
  });
});
