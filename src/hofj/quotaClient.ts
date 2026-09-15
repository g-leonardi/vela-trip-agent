import type { Env } from "../types";

/** Thrown when a DISCOVERY call (P3 — search/getProduct) can't get quota
 * even after the cache/coalescing layer already absorbed what it could.
 * Callers degrade honestly instead of failing the conversation — see
 * conversation.ts's backpressure handling and ARCHITECTURE.md. */
export class QuotaExhaustedError extends Error {
  constructor(public retryAfterMs: number) {
    super("HOFJ quota exhausted");
  }
}

function gate(env: Env) {
  return env.HOFJ_QUOTA_GATE.getByName("gate");
}

/** For P0 (booking-critical) calls that haven't caused any side effect
 * yet: worth a short, bounded wait for quota to free up rather than
 * failing outright, since nothing has been committed if we give up. Never
 * blocks longer than `maxWaitMs` in total — this runs inside a single
 * HTTP request/response turn, not a background job. Returns false (never
 * throws) if quota never freed up in time; the caller is responsible for
 * replying honestly and leaving state exactly as it was, so the traveller's
 * NEXT message safely retries from scratch. */
// Deliberately short: this is a voice-first agent ("pensato per essere
// ascoltato più che letto", see engine/ai.ts) — a traveller shouldn't sit
// in silence for 8+ seconds waiting on a single HTTP response. Measured
// live under a deliberately oversubscribed load test (loadtest/scale-50k.js,
// see ARCHITECTURE.md): an 8s wait pushed p95 request latency past 8s
// under sustained overload; 3s keeps individual turns snappy and lets the
// backpressure reply itself ("ci riprovo tra poco" / "scrivimi tra
// qualche secondo") carry the waiting experience across turns instead of
// one long silent hold.
export async function acquireCriticalOrWait(env: Env, maxWaitMs = 3000, cost = 1): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const result = await gate(env).acquire(cost);
    if (result.granted) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((r) => setTimeout(r, Math.min(result.retryAfterMs, remaining, 1500)));
  }
}

/** For P2 (optional) calls whose result is either discardable
 * (getPaymentIntent) or gracefully degradable (getProduct): one quick,
 * non-blocking check — no retry loop, since the whole point of this tier
 * is to shed load first, not queue for it. */
export async function acquireOptional(env: Env, cost = 1): Promise<boolean> {
  const result = await gate(env).acquire(cost);
  return result.granted;
}

/** For P3 (discovery) calls made on a genuine cache miss — a denial here
 * means "don't call HOFJ right now", surfaced as QuotaExhaustedError so
 * the caller can give the traveller an honest, non-terminal backpressure
 * reply instead of a bare failure. */
export async function acquireDiscoveryOrThrow(env: Env, cost = 1): Promise<void> {
  const result = await gate(env).acquire(cost);
  if (!result.granted) throw new QuotaExhaustedError(result.retryAfterMs);
}
