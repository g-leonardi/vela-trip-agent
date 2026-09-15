import { describe, it, expect } from "vitest";
import { initialBucket, tryAcquire } from "../src/hofj/tokenBucket";

const CONFIG = { capacityPerMinute: 100 };

describe("tokenBucket", () => {
  it("grants up to capacity, then denies", () => {
    let state = initialBucket(0, CONFIG);
    for (let i = 0; i < 100; i++) {
      const r = tryAcquire(state, 0, CONFIG);
      expect(r.granted).toBe(true);
      state = r.state;
    }
    const denied = tryAcquire(state, 0, CONFIG);
    expect(denied.granted).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills linearly over time", () => {
    let state = initialBucket(0, CONFIG);
    for (let i = 0; i < 100; i++) state = tryAcquire(state, 0, CONFIG).state;
    // Half a minute later, half the capacity should be back.
    const r = tryAcquire(state, 30_000, CONFIG);
    expect(r.granted).toBe(true);
    expect(r.state.tokens).toBeCloseTo(49, 0);
  });

  it("retryAfterMs is enough to actually succeed on retry", () => {
    let state = initialBucket(0, CONFIG);
    for (let i = 0; i < 100; i++) state = tryAcquire(state, 0, CONFIG).state;
    const denied = tryAcquire(state, 0, CONFIG);
    const retried = tryAcquire(denied.state, denied.retryAfterMs, CONFIG);
    expect(retried.granted).toBe(true);
  });

  it("never exceeds capacity even after a long idle period", () => {
    const state = initialBucket(0, CONFIG);
    const r = tryAcquire(state, 10 * 60_000, CONFIG);
    expect(r.state.tokens).toBeLessThanOrEqual(CONFIG.capacityPerMinute);
  });

  it("supports a cost greater than 1", () => {
    const state = initialBucket(0, CONFIG);
    const r = tryAcquire(state, 0, CONFIG, 5);
    expect(r.granted).toBe(true);
    expect(r.state.tokens).toBe(95);
  });
});
