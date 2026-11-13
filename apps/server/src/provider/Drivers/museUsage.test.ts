import { expect, it } from "@effect/vitest";
import { totalTokens } from "@t3tools/provider-core/server/usage";

import { museUsageFormat } from "./museUsage.ts";

const entry = () => ({
  schema_version: 1,
  record_type: "event",
  payload_type: "runtime.session",
  payload_schema_version: 1,
  id: "envelope-1",
  recorded_at: 1_785_578_400_123_456,
  stream: { kind: "session", id: "session-1" },
  payload: {
    source_run_record_id: "inference-1",
    event: {
      kind: "model_completed",
      model: "muse-wonder-full-1.0",
      usage: {
        input_tokens: 100,
        cached_tokens: 60,
        cache_read_tokens: 60,
        cache_write_tokens: 10,
        output_tokens: 20,
        reasoning_tokens: 8,
      },
    },
  },
});
const parse = (value: unknown) => museUsageFormat.parseLine(JSON.stringify(value), undefined);

it("normalizes inclusive cache and reasoning counters without doubling the subsets", () => {
  const [record] = parse(entry());
  expect(record).toMatchObject({
    provider: "muse",
    timestampMs: Date.parse("2026-08-01T10:00:00.123Z"),
    sessionId: "session-1",
    model: "muse-wonder-full-1.0",
    reportedCostUsd: null,
    totals: {
      uncachedInputTokens: 30,
      cachedInputTokens: 60,
      cacheCreationTokens: 10,
      outputTokens: 20,
      reasoningTokens: 8,
    },
  });
  expect(totalTokens(record!.totals)).toBe(120);
  const value = entry();
  const { cache_read_tokens: _read, ...usage } = value.payload.event.usage;
  expect(
    parse({ ...value, payload: { ...value.payload, event: { ...value.payload.event, usage } } }),
  ).toEqual([record]);
});

it("keeps individual inference identity across copied parent/child envelopes", () => {
  const original = entry();
  const [first] = parse(original);
  const [copy] = parse({ ...original, id: "copy", stream: { kind: "session", id: "child" } });
  expect(copy?.dedupeKey).toBe(first?.dedupeKey);
  const next = entry();
  next.payload.source_run_record_id = "inference-2";
  expect(parse(next)[0]?.dedupeKey).not.toBe(first?.dedupeKey);
  const { source_run_record_id: _source, ...payload } = original.payload;
  const fallback = parse({ ...original, payload });
  expect(fallback[0]?.dedupeKey).toBe(JSON.stringify(["muse", original.id]));
});

it("includes automated review inference models and ignores workflow and telemetry rollups", () => {
  const value = entry();
  expect(
    parse({
      ...value,
      payload: {
        ...value.payload,
        event: {
          ...value.payload.event,
          kind: "automated_review_completed",
          model: { model_id: "review-model", provider_id: "meta" },
        },
      },
    })[0]?.model,
  ).toBe("review-model");
  for (const kind of [
    "workflow_completed",
    "goal_usage_attribution",
    "turn_completed",
    "usage_summary",
  ]) {
    expect(
      parse({ ...value, payload: { ...value.payload, event: { ...value.payload.event, kind } } }),
    ).toEqual([]);
  }
  expect(parse({ ...value, payload_type: "run.telemetry" })).toEqual([]);
  expect(parse({ ...value, record_type: "snapshot" })).toEqual([]);
  expect(parse({ ...value, stream: { kind: "run", id: "run-1" } })).toEqual([]);
});

it("includes native version 3 automated review inferences", () => {
  const value = entry();
  const review = {
    ...value,
    payload_schema_version: 3,
    payload: {
      ...value.payload,
      event: {
        ...value.payload.event,
        kind: "automated_review_completed",
        model: { provider_id: "meta", model_id: "review-model", reasoning_effort: "high" },
        usage: {
          input_tokens: 100,
          cached_input_tokens: 60,
          output_tokens: 20,
          reasoning_tokens: 8,
        },
      },
    },
  };
  expect(parse(review)).toEqual([
    {
      ...parse(value)[0],
      model: "review-model",
      totals: {
        uncachedInputTokens: 40,
        cachedInputTokens: 60,
        cacheCreationTokens: 0,
        outputTokens: 20,
        reasoningTokens: 8,
      },
    },
  ]);
  expect(museUsageFormat.parseProjected(review, undefined)).toEqual(parse(review));
});

it("handles malformed and partial data and rejects unsupported timestamps or schemas", () => {
  expect(museUsageFormat.parseLine("not json", undefined)).toEqual([]);
  expect(museUsageFormat.parseLine(JSON.stringify(entry()).slice(0, -1), undefined)).toEqual([]);
  for (const recorded_at of [NaN, Infinity, -1, "1785578400123456", Number.MAX_SAFE_INTEGER + 1]) {
    expect(museUsageFormat.parseProjected({ ...entry(), recorded_at }, undefined)).toEqual([]);
  }
  expect(parse({ ...entry(), schema_version: 2 })).toEqual([]);
  expect(parse({ ...entry(), payload_schema_version: 2 })).toEqual([]);
  expect(parse({ ...entry(), id: "" })).toEqual([]);
  expect(parse({ ...entry(), payload: { event: { kind: "model_completed" } } })).toEqual([]);
  const value = entry();
  const result = parse({
    ...value,
    payload: {
      event: {
        ...value.payload.event,
        usage: {
          input_tokens: 10,
          cache_read_tokens: 20,
          cache_write_tokens: 8,
          output_tokens: 3,
          reasoning_tokens: 9,
        },
      },
    },
  });
  expect(result[0]?.totals).toEqual({
    uncachedInputTokens: 0,
    cachedInputTokens: 10,
    cacheCreationTokens: 0,
    outputTokens: 3,
    reasoningTokens: 3,
  });
  expect(
    parse({
      ...value,
      payload: {
        event: { ...value.payload.event, usage: { input_tokens: -5, output_tokens: "20" } },
      },
    }),
  ).toEqual([]);
});
