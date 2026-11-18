/**
 * Replays the shape a fast primary produces (cumulative `message_update` frames,
 * each carrying the whole body so far) through the real projection and cursor
 * reader, and reports how many frames per second the fold keeps up with. The
 * assertion is a floor an order of magnitude above the producer's rate (measured:
 * about 30,000 frames per second, 3 ms of fold and 0.3 ms per read for 3,200 frames
 * of up to 80 KB), so a view's delay behind a fast primary is round trips, never CPU.
 */
import { assert, describe, it } from "@effect/vitest";
import type { NeoPiNativeCursor, NeoPiNativeObservationDomain } from "@t3tools/contracts";

import { readNeoPiNativeObservation } from "./NeoPiNativeCursor.ts";
import { NeoPiNativeProjection } from "./NeoPiNativeProjection.ts";

const sessionId = "native-id";
const domain: NeoPiNativeObservationDomain = {
  serverIncarnation: "bench",
  ownerEpoch: 0,
  projectionIncarnation: 0,
  buildAttempt: 0,
  branchGeneration: 0,
};
const LIMITS = { scanSteps: 1024, replyBytes: 512 * 1024 };
const BLOCK = "x".repeat(96);

const published = () => {
  const projection = new NeoPiNativeProjection({
    domain,
    tombstoneCapacity: 4096,
    journalCapacity: 512,
  });
  projection.setInboxObserved(true);
  projection.fold({
    type: "journal_state",
    reason: "identity",
    sessionId,
    sessionFile: "/s/a.jsonl",
    leafId: null,
  });
  projection.beginBuildAttempt();
  const mark = projection.mark();
  projection.applyStateReply({ sessionId }, mark);
  projection.applySubagentsReply({ subagents: [] }, mark);
  projection.applySubagentHistoryReply(null, mark);
  projection.applyJournalPage({ sessionId, entries: [] }, mark);
  return projection;
};

const body = (blocks: number) => ({
  role: "assistant",
  content: Array.from({ length: blocks }, (_, index) => ({
    type: "text",
    text: `${index} ${BLOCK}`,
  })),
});

/** Four loops of 800 cumulative updates; children optionally interleave lifecycle and progress. */
const frames = (children: number) => {
  const out: Array<Record<string, unknown>> = [];
  for (let loop = 0; loop < 4; loop++) {
    const messageId = `loop-${loop}`;
    out.push({ type: "message_start", messageId, message: body(1) });
    for (let block = 1; block <= 800; block++) {
      out.push({ type: "message_update", messageId, message: body(block) });
      if (children > 0 && block % 8 === 0) {
        const id = `child-${(block / 8) % children}`;
        const payload = {
          id,
          runToken: `r${loop}`,
          agent: "task",
          agentSource: "bundled",
          index: 0,
        };
        out.push({
          type: block % 16 === 0 ? "subagent_progress" : "subagent_lifecycle",
          payload:
            block % 16 === 0
              ? { ...payload, progress: { id, status: "running", description: `step ${block}` } }
              : { ...payload, status: "started" },
        });
      }
    }
    out.push({ type: "message_end", messageId, message: body(800) });
  }
  return out;
};

const replay = (children: number) => {
  const projection = published();
  const input = frames(children);
  let cursor: NeoPiNativeCursor | null = null;
  let reads = 0;
  let entities = 0;
  let bytes = 0;
  let foldMs = 0;
  let readMs = 0;
  for (const [index, frame] of input.entries()) {
    const foldStart = performance.now();
    projection.fold(frame);
    foldMs += performance.now() - foldStart;
    // One reader keeps reading while frames arrive, as the long-poll does.
    if (index % 10 === 9) {
      const readStart = performance.now();
      const reply = readNeoPiNativeObservation(projection, cursor, LIMITS, "reader");
      readMs += performance.now() - readStart;
      reads++;
      if (reply.type === "pass") {
        cursor = reply.continuation;
        entities += reply.entities.length;
        bytes += JSON.stringify(reply).length;
      }
    }
  }
  return { frames: input.length, reads, entities, bytes, foldMs, readMs };
};

describe("native projection throughput", () => {
  for (const children of [0, 26]) {
    it(`folds and reads a fast primary's cumulative frames (${children} children)`, () => {
      const result = replay(children);
      const rate = result.frames / ((result.foldMs + result.readMs) / 1000);
      // The producer makes about 270 frames per second; an order of magnitude of margin.
      assert.isAbove(rate, 2700);
    });
  }
});
