import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/**
 * Every connected client polls the native session listing, but the answer is
 * the same for all of them. One scan serves every caller for `ttl`; callers
 * arriving during a scan join it instead of starting another; a failed scan
 * is never reused; and with nobody asking nothing runs, so the poll pauses
 * itself. `invalidate` forces the next caller to rescan.
 */
export const makeSharedListing = Effect.fn("NeoPiSharedListing.make")(function* <
  Source,
  A,
  E,
>(input: { readonly scan: (source: Source) => Effect.Effect<A, E>; readonly ttl: Duration.Input }) {
  const sources = new Map<string, Source>();
  const cache = yield* Cache.makeWith((key: string) => input.scan(sources.get(key) as Source), {
    capacity: 16,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? input.ttl : Duration.zero),
  });
  return {
    /** The latest `source` for a key is the one a rescan uses. */
    get: (key: string, source: Source) =>
      Effect.suspend(() => {
        sources.set(key, source);
        return Cache.get(cache, key);
      }),
    invalidate: Cache.invalidateAll(cache),
  };
});
