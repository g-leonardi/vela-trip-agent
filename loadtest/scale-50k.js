// k6 load test for the Vela scalability twist: "50,000 travellers inside
// a ten-minute window. The HOFJ API enforces a per-client rolling 60s
// quota... What to add: a load test we can run ourselves, targeting YOUR
// OWN edge with HOFJ responses recorded/stubbed — never point 50k
// simulated travellers at HOFJ staging."
//
// Run with (against a local `wrangler dev --config wrangler.loadtest.jsonc`,
// see package.json's loadtest:dev script — NEVER against wrangler.jsonc,
// the production config, which never sets STUB_MODE):
//
//   npm run loadtest:dev            # in one terminal
//   k6 run loadtest/scale-50k.js    # in another
//
// This is a THIRD, separate scenario file — it does not replace
// loadtest/booking-flow.js's two small scenarios that hit the real HOFJ
// API and real Workers AI (see that file's own header for why those stay
// exactly as they are, unmodified, as an honest calibration point).
// STUB_MODE (see Env.STUB_MODE, types.ts) replaces HOFJ/Stripe/AI with
// instant in-process canned responses, so this test measures ONE thing:
// whether THIS Worker's own architecture (Durable Object fan-out, the
// HofjQuotaGate admission control, discovery caching/coalescing) survives
// 50,000 concurrent conversations without turning into 50,000+ upstream
// calls or a wall of bare 500s — never real HOFJ, real Stripe, or real
// Workers AI/Anthropic cost, by construction, not by discipline.
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:8788";
const TOTAL_TRAVELLERS = Number(__ENV.TRAVELLERS || 50000);
const WINDOW_SECONDS = Number(__ENV.WINDOW_SECONDS || 600); // "ten minutes"
const PEAK_RATE = Math.ceil((TOTAL_TRAVELLERS / WINDOW_SECONDS) * 1.4); // real launch mornings aren't a perfectly flat line
// Ramp-up/ramp-down get 30s each for a quick smoke run (small
// WINDOW_SECONDS, e.g. a CI/dev sanity check) and 90s each at full scale;
// whatever's left goes to the sustained-peak middle stage.
const EDGE_SECONDS = Math.max(10, Math.min(90, Math.floor(WINDOW_SECONDS / 4)));
const HOLD_SECONDS = Math.max(1, WINDOW_SECONDS - 2 * EDGE_SECONDS);

const bookedCounter = new Counter("vela_travellers_booked");
const failedCounter = new Counter("vela_travellers_failed");
const backpressureCounter = new Counter("vela_backpressure_replies");
const abandonedCounter = new Counter("vela_travellers_abandoned_max_turns");
const turnsToOutcome = new Trend("vela_turns_to_outcome");

export const options = {
  scenarios: {
    scale_50k: {
      executor: "ramping-arrival-rate",
      exec: "traveller",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 500,
      maxVUs: 4000,
      stages: [
        { target: PEAK_RATE, duration: `${EDGE_SECONDS}s` }, // launch-morning ramp, not a slow build-up
        { target: PEAK_RATE, duration: `${HOLD_SECONDS}s` }, // sustained peak for the bulk of the window
        { target: 0, duration: `${EDGE_SECONDS}s` }, // tail off
      ],
    },
  },
  thresholds: {
    // The claim under test is NOT "every traveller books instantly" —
    // under real admission control some are honestly asked to wait. It
    // IS "the Worker never returns a bare failure": a backpressure reply
    // is still a 200 with an honest message (see engine/ai.ts's
    // "backpressure" directive), so this threshold is meaningful, not
    // hollow.
    http_req_failed: ["rate<0.02"],
    // acquireCriticalOrWait (hofj/quotaClient.ts) bounds any single P0
    // wait to 3s; a little headroom above that for DO/network overhead.
    http_req_duration: ["p(95)<4000"],
  },
};

const MAX_TURNS = 6; // one-shot slot fill (stub interpret() fills everything at once) + confirm + a couple of backpressure retries

export function traveller() {
  const sessionId = `loadtest-${__VU}-${__ITER}-${Date.now()}`;
  let turn = 0;
  let outcome = "abandoned_max_turns";

  while (turn < MAX_TURNS) {
    turn++;
    const res = http.post(`${BASE_URL}/api/message`, JSON.stringify({ text: "prenota il mio viaggio", sessionId }), {
      headers: { "content-type": "application/json" },
      timeout: "20s",
    });
    const ok = check(res, { "http 200": (r) => r.status === 200 });
    if (!ok) {
      outcome = "http_error";
      break;
    }
    let body;
    try {
      body = JSON.parse(res.body);
    } catch {
      outcome = "bad_json";
      break;
    }
    const stage = body.state && body.state.stage;
    if (stage === "booked") {
      outcome = "booked";
      break;
    }
    if (stage === "failed") {
      outcome = "failed";
      break;
    }
    if (typeof body.reply === "string" && body.reply.indexOf("[stub:backpressure]") !== -1) {
      backpressureCounter.add(1);
    }
    sleep(0.3); // a real traveller takes a beat between messages
  }

  turnsToOutcome.add(turn);
  if (outcome === "booked") bookedCounter.add(1);
  else if (outcome === "abandoned_max_turns") abandonedCounter.add(1);
  else failedCounter.add(1);
}

// One GET at the very end, outside the ramp — reads the single shared
// HofjQuotaGate DO's lifetime counters plus this isolate's discovery
// cache counters. This is the actual quantitative proof the twist asks
// for: totalGranted (real, if stubbed, HOFJ calls actually admitted)
// should be nowhere near 50,000 travellers × 5-6 calls each, because most
// search() calls were absorbed by the cache/coalescing layer before ever
// reaching the gate, and P0 booking calls were paced by admission control
// rather than all firing at once.
export function teardown() {
  const res = http.get(`${BASE_URL}/api/debug/quota-stats`);
  console.log(`quota-stats: ${res.body}`);
}
