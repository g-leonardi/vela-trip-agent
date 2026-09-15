/** Short-lived cache + request coalescing for DISCOVERY calls only
 * (search(), getProduct()) — never for final availability/booking, which
 * always stays live (see ARCHITECTURE.md, twist Phase 2 design). Two
 * layers:
 *  - an in-memory Map, fastest, but scoped to this one isolate;
 *  - the Workers Cache API (`caches.default`), shared across isolates in
 *    the same colo, so a cache miss on isolate A that isolate B already
 *    resolved a moment ago still avoids a second real HOFJ call.
 * Coalescing (an in-flight Promise map) covers the gap the cache can't:
 * several equivalent requests arriving on the SAME isolate within the
 * same still-in-progress lookup share the one real call instead of each
 * firing their own. */

const memoryCache = new Map<string, { expiresAt: number; value: unknown }>();
const inFlight = new Map<string, Promise<unknown>>();

/** Isolate-local counters, exposed via getCacheStats() — the load test's
 * quantitative evidence (see /api/debug/quota-stats, index.ts) that
 * caching/coalescing is actually absorbing repeated discovery calls, not
 * just decoration. Per-isolate like the caches themselves; the debug
 * endpoint reports whichever isolate happens to answer it, which is
 * enough for the load test's purpose (a directional proof, not an exact
 * global count — the quota gate's own totals, which ARE globally exact
 * via the single shared DO, are the authoritative admission numbers). */
const stats = { memoryHits: 0, cacheApiHits: 0, coalesced: 0, misses: 0 };

export function getCacheStats() {
  return { ...stats };
}

function cacheKeyFor(key: string): Request {
  // Cache API keys off a Request; this URL is never actually fetched,
  // just used as a stable, collision-resistant cache key.
  return new Request(`https://discovery-cache.internal/${encodeURIComponent(key)}`);
}

export async function cachedDiscoveryCall<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const mem = memoryCache.get(key);
  if (mem && mem.expiresAt > now) {
    stats.memoryHits += 1;
    return mem.value as T;
  }

  const pending = inFlight.get(key);
  if (pending) {
    stats.coalesced += 1;
    return pending as Promise<T>;
  }

  const promise = (async () => {
    try {
      let cache: Cache | undefined;
      try {
        cache = (caches as unknown as { default: Cache }).default;
      } catch {
        cache = undefined; // Cache API unavailable in this context — memory-only, still correct.
      }
      const cacheKey = cacheKeyFor(key);
      if (cache) {
        try {
          const hit = await cache.match(cacheKey);
          if (hit) {
            stats.cacheApiHits += 1;
            const value = (await hit.json()) as T;
            memoryCache.set(key, { expiresAt: now + ttlMs, value });
            return value;
          }
        } catch {
          // Cache read failed — fall through to a real fetch rather than fail the request over a cache problem.
        }
      }
      stats.misses += 1;
      const value = await fetcher();
      memoryCache.set(key, { expiresAt: now + ttlMs, value });
      if (cache) {
        try {
          await cache.put(
            cacheKey,
            new Response(JSON.stringify(value), {
              headers: { "cache-control": `max-age=${Math.ceil(ttlMs / 1000)}`, "content-type": "application/json" },
            }),
          );
        } catch {
          // Best-effort L2 write — a miss next time just costs one more real call, not a failure now.
        }
      }
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

export const DISCOVERY_TTL_MS = {
  /** Catalog data changes far slower than any single 10-minute burst —
   * still short enough that a real availability change (verified via the
   * live cart at createItinerary) is never more than this stale. */
  search: 25_000,
  /** Marketing description text — effectively static during a launch
   * window, so a longer TTL is safe and meaningfully cuts real calls. */
  product: 180_000,
} as const;
