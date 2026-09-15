/** Pure token-bucket math for the HOFJ quota gate — deliberately separate
 * from HofjQuotaGate (the Durable Object, quotaGate.ts) so the actual
 * admission arithmetic is unit-testable without any DO/runtime machinery,
 * same split already used everywhere else in this codebase (matcher.ts,
 * dates.ts are pure; the DO/HTTP layer just calls into them). */

export interface BucketState {
  tokens: number;
  lastRefillAt: number; // ms epoch
}

export interface BucketConfig {
  /** Deliberately set BELOW HOFJ's real rolling limit (120/min, verified
   * live via a single GET /v1/quota call — see ARCHITECTURE.md) — the
   * bucket's own window is fixed (continuous refill) while HOFJ's is a
   * rolling 60s window we can't observe without spending quota to check
   * it, so a safety margin absorbs that skew instead of finding out the
   * hard way. */
  capacityPerMinute: number;
}

export function initialBucket(now: number, config: BucketConfig): BucketState {
  return { tokens: config.capacityPerMinute, lastRefillAt: now };
}

export function refill(state: BucketState, now: number, config: BucketConfig): BucketState {
  const elapsedMs = Math.max(0, now - state.lastRefillAt);
  const refillPerMs = config.capacityPerMinute / 60_000;
  const tokens = Math.min(config.capacityPerMinute, state.tokens + elapsedMs * refillPerMs);
  return { tokens, lastRefillAt: now };
}

export interface AcquireResult {
  granted: boolean;
  state: BucketState;
  /** 0 when granted; otherwise how long until enough tokens exist to grant
   * `cost` again — a caller with patience (a P0 booking step) can sleep
   * this long and retry; a caller without (P3 discovery, already behind a
   * cache) should treat this as "not now" and degrade instead. */
  retryAfterMs: number;
}

export function tryAcquire(state: BucketState, now: number, config: BucketConfig, cost = 1): AcquireResult {
  const refilled = refill(state, now, config);
  if (refilled.tokens >= cost) {
    return { granted: true, state: { tokens: refilled.tokens - cost, lastRefillAt: refilled.lastRefillAt }, retryAfterMs: 0 };
  }
  const refillPerMs = config.capacityPerMinute / 60_000;
  const deficit = cost - refilled.tokens;
  const retryAfterMs = Math.ceil(deficit / refillPerMs);
  return { granted: false, state: refilled, retryAfterMs };
}
