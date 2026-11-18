import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  NeoPiNativeEssentialEnvelope,
  NeoPiNativeObservedJournalEntry,
  NeoPiNativeSessionsReadInput,
  NeoPiNativeSessionsReadResult,
  NeoPiNativeSessionsSetDemandInput,
  NeoPiStopOutcome,
} from "./neopiNativeSessions.ts";

const domain = {
  serverIncarnation: "server-1",
  ownerEpoch: 2,
  projectionIncarnation: 3,
  buildAttempt: 1,
  branchGeneration: 0,
};
const cursor = {
  epoch: domain,
  base: 10,
  pass: {
    kind: "incremental" as const,
    passId: "pass-1",
    watermark: 14,
    lastOrdinal: 7,
    afterOrdinal: 3,
    segment: { key: "message:b", revision: 13, nextIndex: 1 },
  },
  inboxSeq: 4,
  journalAt: "entry-9",
};
const decodeStopOutcome = Schema.decodeUnknownSync(NeoPiStopOutcome);
const decodeEnvelope = Schema.decodeUnknownSync(NeoPiNativeEssentialEnvelope);

describe("native observation wire", () => {
  it("builds the stop outcome from whitelisted fields and drops the private ones", () => {
    const decoded = decodeStopOutcome({
      stopType: "refusal",
      category: null,
      explanation: "declined",
      errorClassificationMessage: "classified",
      errorStatus: 400,
      errorId: 7,
      fallback_credit_token: "secret",
      fallback_has_prefill_claim: true,
    });
    assert.deepStrictEqual(decoded, {
      stopType: "refusal",
      category: null,
      explanation: "declined",
      errorClassificationMessage: "classified",
      errorStatus: 400,
      errorId: 7,
    });
  });

  it("rejects a message that still carries raw stopDetails, at every boundary", () => {
    const raw = { role: "assistant", stopDetails: { type: "refusal", fallback_credit_token: "x" } };
    const read = Schema.decodeUnknownOption(NeoPiNativeSessionsReadResult);
    const entity = {
      key: "message:a",
      ordinal: 1,
      revision: 5,
      value: { class: "message", messageId: "a", phase: "ended", entryId: null, message: raw },
    };
    const pass = {
      type: "pass",
      passId: "pass-1",
      kind: "incremental",
      baseCursor: cursor,
      coveredThrough: 14,
      continuation: { ...cursor, pass: null, base: 14 },
      complete: false,
      promoted: false,
      entities: [entity],
      tombstones: [],
      segments: [],
      inbox: [],
      journal: null,
    };
    assert.equal(read(pass)._tag, "None");
    const { stopDetails: _dropped, ...filtered } = raw;
    assert.equal(
      read({ ...pass, entities: [{ ...entity, value: { ...entity.value, message: filtered } }] })
        ._tag,
      "Some",
    );

    const journal = Schema.decodeUnknownOption(NeoPiNativeObservedJournalEntry);
    const entry = {
      id: "entry-1",
      parentId: null,
      type: "message",
      timestamp: "2026-11-18T00:00:00Z",
      message: raw,
    };
    assert.equal(journal(entry)._tag, "None");
    assert.equal(journal({ ...entry, message: filtered })._tag, "Some");
  });

  it("round-trips a cursor mid-pass, including an oversized value in transit", () => {
    const input = { leaseId: "lease-1", readId: 3, cursor };
    const codec = NeoPiNativeSessionsReadInput;
    const encoded = Schema.encodeSync(codec)(Schema.decodeUnknownSync(codec)(input));
    assert.deepStrictEqual(encoded, input);
    assert.equal(
      Schema.decodeUnknownOption(codec)({ ...input, readId: -1 })._tag,
      "None",
      "readId is a non-negative sequence",
    );
  });

  it("requires a run token on child demand", () => {
    const decode = Schema.decodeUnknownOption(NeoPiNativeSessionsSetDemandInput);
    const base = { leaseId: "lease-1", generation: 1 };
    assert.equal(
      decode({
        ...base,
        demand: [{ kind: "roster" }, { kind: "child", childId: "c", runToken: "r" }],
      })._tag,
      "Some",
    );
    assert.equal(decode({ ...base, demand: [{ kind: "child", childId: "c" }] })._tag, "None");
  });

  it("decodes essential envelopes and refuses raw native frames", () => {
    const decode = Schema.decodeUnknownOption(NeoPiNativeEssentialEnvelope);
    const leased = {
      type: "leased",
      leaseId: "lease-1",
      domain,
      creditWindow: 8,
      readDeadlineMs: 25_000,
    } as const;
    assert.deepStrictEqual(decodeEnvelope(leased), leased);
    assert.equal(decode({ type: "lifecycle", revision: 20, state: "owner-stopped" })._tag, "Some");
    assert.equal(decode({ type: "lifecycle", revision: 20, state: "gone" })._tag, "None");
    assert.equal(decode({ type: "event", frame: { type: "agent_start" } })._tag, "None");
  });
});
