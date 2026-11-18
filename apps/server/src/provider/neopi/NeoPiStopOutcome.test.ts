import type { NeoPiNativeObservationDomain } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { readNeoPiNativeObservation } from "./NeoPiNativeCursor.ts";
import { NeoPiNativeProjection } from "./NeoPiNativeProjection.ts";
import { observeNeoPiJournalEntry, observeNeoPiMessage } from "./NeoPiStopOutcome.ts";

const TOKEN = "fct_secret_token_7f3a";
const FROZEN_REQUEST = "frozen-request-marker-91c2";
const sessionId = "session-1";
const domain: NeoPiNativeObservationDomain = {
  serverIncarnation: "server-1",
  ownerEpoch: 1,
  projectionIncarnation: 0,
  buildAttempt: 0,
  branchGeneration: 0,
};

/** A refused assistant message as the provider layer builds it, before (no N18) or after (N18) NeoPi's own reduction. */
const refused = (withN18: boolean) => ({
  role: "assistant",
  content: [{ type: "text", text: "partial prose" }],
  stopReason: "error",
  errorMessage: "Refusal (cyber): declined",
  errorClassificationMessage: "refusal",
  errorStatus: 400,
  errorId: 4242,
  stopDetails: withN18
    ? { type: "refusal", category: "cyber", explanation: "declined" }
    : {
        type: "refusal",
        category: "cyber",
        explanation: "declined",
        fallback_credit_token: TOKEN,
        fallback_has_prefill_claim: true,
      },
  ...(withN18
    ? {}
    : {
        fallbackCreditHandle: {
          token: TOKEN,
          prefillClaim: true,
          params: { marker: FROZEN_REQUEST },
          refusedContent: [{ type: "text", text: "partial prose" }],
        },
      }),
});

const OUTCOME = {
  stopType: "refusal",
  category: "cyber",
  explanation: "declined",
  errorClassificationMessage: "refusal",
  errorStatus: 400,
  errorId: 4242,
};

const leaks = (value: unknown) => {
  const json = JSON.stringify(value);
  return [
    "fallback_credit_token",
    "fallback_has_prefill_claim",
    "fallbackCreditHandle",
    TOKEN,
    FROZEN_REQUEST,
  ].filter((needle) => json.includes(needle));
};

describe("NeoPiStopOutcome", () => {
  it("builds the outcome from whitelisted fields only, each exactly as given", () => {
    const { message, stopOutcome } = observeNeoPiMessage({
      role: "assistant",
      stopDetails: { type: "end_turn", category: null, explanation: 7, extra: "x" },
      errorStatus: "500",
      errorId: 3,
    });
    assert.deepEqual(stopOutcome, { stopType: "end_turn", category: null, errorId: 3 });
    assert.deepEqual(message, { role: "assistant", errorStatus: "500", errorId: 3 });
    assert.isUndefined(observeNeoPiMessage({ role: "user", content: "hi" }).stopOutcome);
  });

  for (const withN18 of [false, true])
    it(`§3.5 neither fallback value nor the handle reaches a reply or stored record (${withN18 ? "with" : "without"} N18)`, () => {
      const projection = new NeoPiNativeProjection({
        domain,
        tombstoneCapacity: 100,
        journalCapacity: 100,
      });
      projection.fold({
        type: "journal_state",
        reason: "identity",
        sessionId,
        sessionFile: "/s.jsonl",
        leafId: null,
      });
      projection.applyStateReply({ sessionId }, projection.mark());
      projection.applySubagentsReply({ subagents: [] }, projection.mark());
      // Journal page reply, then each live boundary: snapshot message, live end, journal entry.
      projection.applyJournalPage(
        {
          sessionId,
          entries: [
            {
              id: "e1",
              parentId: null,
              type: "message",
              timestamp: "t",
              message: refused(withN18),
            },
          ],
        },
        projection.mark(),
      );
      projection.fold({
        type: "message_start",
        messageId: "snap",
        snapshot: true,
        message: refused(withN18),
      });
      projection.fold({
        type: "journal_entry",
        sessionId,
        entry: {
          id: "e2",
          parentId: "e1",
          type: "message",
          timestamp: "t",
          message: refused(withN18),
        },
      });
      // After the entry, so the entry is not held waiting for this message's association.
      projection.fold({ type: "message_end", messageId: "live", message: refused(withN18) });
      const reply = readNeoPiNativeObservation(projection, null, {
        scanSteps: 100,
        replyBytes: 1_000_000,
      });
      assert.equal(reply.type, "pass");
      assert.deepEqual(leaks(reply), []);
      assert.deepEqual(leaks([...projection.store.values()].map((record) => record.value)), []);
      const journal = [];
      for (let position = projection.journal.start; position < projection.journal.end; position++)
        journal.push(projection.journal.at(position));
      assert.deepEqual(leaks(journal), []);
      if (reply.type !== "pass") return;
      const outcomes = [
        ...reply.entities.map((entity) =>
          entity.value.class === "message" ? entity.value.stopOutcome : null,
        ),
        ...(reply.journal?.entries ?? []).map((entry) => entry.stopOutcome),
      ].filter((outcome) => outcome !== null);
      assert.deepEqual(outcomes, [OUTCOME, OUTCOME, OUTCOME, OUTCOME]);
      const entry = observeNeoPiJournalEntry({
        id: "e3",
        parentId: null,
        type: "message",
        timestamp: "t",
        message: refused(withN18),
        stopOutcome: { stopType: TOKEN },
      });
      assert.deepEqual(leaks(entry), []);
    });
});
