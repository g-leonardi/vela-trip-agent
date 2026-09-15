import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { type BucketConfig, type BucketState, initialBucket, tryAcquire } from "./tokenBucket";

const DEFAULT_CAPACITY_PER_MINUTE = 100; // buffer under HOFJ's real 120/min

/** Checkpoint storage no more often than this, even under heavy call
 * volume — the whole point of this DO is to relieve pressure on HOFJ, so
 * it must not become its own bottleneck by doing a storage write on every
 * single acquire() call (50k travellers / 10 min can mean hundreds of
 * acquire() calls/sec). The token count itself lives in memory for the
 * life of this DO instance; losing the last <2s of it on a rare mid-burst
 * eviction just means a brief, harmless over/under-admission blip, not a
 * correctness bug — this is a soft rate limiter, not money or a booking
 * record. */
const CHECKPOINT_INTERVAL_MS = 2000;

/** Single, well-known instance for the whole deployment (see
 * conversation.ts, getByName("gate")) — deliberately the ONE shared
 * serialization point for admission decisions against HOFJ's own shared
 * quota. A single global DO handling real business logic per request is
 * a known anti-pattern (see the durable-objects skill), but that's not
 * what this is: the hot path here is pure in-memory arithmetic (a token
 * bucket check), no per-call storage I/O, no external fetch — exactly the
 * "coordination atom" a DO is for, kept deliberately minimal so it can
 * sustain a very high call rate without becoming the next bottleneck it
 * exists to prevent. */
export class HofjQuotaGate extends DurableObject<Env> {
  private state: BucketState | null = null;
  private config: BucketConfig;
  private callsSinceCheckpoint = 0;
  private lastCheckpointAt = 0;
  private totalGranted = 0;
  private totalDenied = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const capacity = Number(env.HOFJ_QUOTA_PER_MIN) || DEFAULT_CAPACITY_PER_MINUTE;
    this.config = { capacityPerMinute: capacity };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.state) return;
    const stored = await this.ctx.storage.get<BucketState>("bucket");
    this.state = stored ?? initialBucket(Date.now(), this.config);
  }

  private async maybeCheckpoint(now: number): Promise<void> {
    this.callsSinceCheckpoint += 1;
    if (now - this.lastCheckpointAt < CHECKPOINT_INTERVAL_MS && this.callsSinceCheckpoint < 500) return;
    this.callsSinceCheckpoint = 0;
    this.lastCheckpointAt = now;
    await this.ctx.storage.put("bucket", this.state);
  }

  /** Ask permission to make one HOFJ call. Never blocks internally — a
   * denial is a fast, cheap answer with a suggested `retryAfterMs`; it's
   * the CALLER's job (see conversation.ts) to decide whether to wait and
   * retry (a P0 booking step) or degrade immediately (P2/P3). */
  async acquire(cost = 1): Promise<{ granted: boolean; retryAfterMs: number; remaining: number }> {
    await this.ensureLoaded();
    const now = Date.now();
    const result = tryAcquire(this.state!, now, this.config, cost);
    this.state = result.state;
    if (result.granted) this.totalGranted += 1;
    else this.totalDenied += 1;
    await this.maybeCheckpoint(now);
    return { granted: result.granted, retryAfterMs: result.retryAfterMs, remaining: Math.floor(result.state.tokens) };
  }

  /** Exposed only for the stubbed load test's own reporting (see
   * index.ts's /api/debug/quota-stats, gated to STUB_MODE) — the
   * quantitative proof that admission control is actually doing
   * something under a 50k-traveller burst, not just decoration. */
  async stats(): Promise<{ totalGranted: number; totalDenied: number; capacityPerMinute: number }> {
    return { totalGranted: this.totalGranted, totalDenied: this.totalDenied, capacityPerMinute: this.config.capacityPerMinute };
  }
}
