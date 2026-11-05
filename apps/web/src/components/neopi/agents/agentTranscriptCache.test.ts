import { describe, expect, it } from "vite-plus/test";
import { createTranscriptCache } from "./agentTranscriptCache";

const transcript = (agentId: string, nextByte: number) => ({ agentId, entries: [], nextByte });

describe("agent transcript cache", () => {
  it("drops the least recently used entries past the count and byte budgets", () => {
    const cache = createTranscriptCache({ maxEntries: 3, maxBytes: 100, ttlMs: 60_000 });
    cache.set("a", transcript("a", 10));
    cache.set("b", transcript("b", 10));
    cache.set("c", transcript("c", 10));
    expect(cache.get("a")).not.toBeNull();
    cache.set("d", transcript("d", 10));
    expect(cache.get("b")).toBeNull();
    expect(cache.size).toBe(3);
    cache.set("e", transcript("e", 95));
    expect(cache.size).toBe(1);
    expect(cache.get("e")).not.toBeNull();
  });

  it("always keeps the entry just written, however large", () => {
    const cache = createTranscriptCache({ maxEntries: 2, maxBytes: 10, ttlMs: 60_000 });
    cache.set("big", transcript("big", 1_000_000));
    expect(cache.get("big")?.nextByte).toBe(1_000_000);
    cache.set("big", transcript("big", 2_000_000));
    expect(cache.get("big")?.nextByte).toBe(2_000_000);
  });

  it("expires entries untouched for the TTL, and a read renews them", () => {
    let clock = 0;
    const cache = createTranscriptCache(
      { maxEntries: 8, maxBytes: 1_000, ttlMs: 100 },
      () => clock,
    );
    cache.set("a", transcript("a", 1));
    cache.set("b", transcript("b", 1));
    clock = 80;
    expect(cache.get("a")).not.toBeNull();
    clock = 150;
    cache.set("c", transcript("c", 1));
    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")).not.toBeNull();
    clock = 400;
    expect(cache.get("a")).toBeNull();
  });
});
