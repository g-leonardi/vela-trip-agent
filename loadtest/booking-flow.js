// k6 load test for the Vela conversational booking agent.
//
// Run with:   k6 run loadtest/booking-flow.js
// Against a different target: k6 run -e BASE_URL=https://... loadtest/booking-flow.js
//
// IMPORTANT — why this isn't a naive "hammer /api/message" test:
// HOFJ's own API key is rate-limited to 120 requests/minute, shared across
// whoever else is using the same test credential (see ARCHITECTURE.md,
// section 5). A load test that drives many concurrent full searches would
// burn through that shared budget in seconds and could break other people's
// testing, not just ours. So this file has two deliberately separate
// scenarios:
//
//   - `slot_filling_burst`: pushes real concurrency (up to 100 VUs) through
//     Worker -> Durable Object -> Workers AI, using a message that only
//     provides ONE slot ("sport"). That path never calls HOFJ at all (the
//     search only fires once all four required slots are known), so this
//     scenario is safe to push hard and is what actually stresses our own
//     infrastructure (DO fan-out, AI latency, cold starts).
//   - `full_booking_search`: a deliberately tiny, bounded scenario (10
//     total iterations, low concurrency) that exercises the real
//     HOFJ search call end-to-end, to get one honest latency sample for
//     the externally-bound part of the pipeline without touching the
//     shared rate limit in any meaningful way.
import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:8787";

export const options = {
  scenarios: {
    slot_filling_burst: {
      executor: "ramping-vus",
      exec: "slotFilling",
      startVUs: 0,
      stages: [
        { duration: "20s", target: 30 },
        { duration: "30s", target: 100 },
        { duration: "20s", target: 0 },
      ],
    },
    full_booking_search: {
      executor: "shared-iterations",
      exec: "fullSearch",
      vus: 3,
      iterations: 10,
      maxDuration: "60s",
      startTime: "5s", // let the burst scenario ramp up first
    },
  },
  thresholds: {
    // Applies to the Worker's own request handling; the AI call and (for
    // fullSearch) the HOFJ round trip dominate this, not our code.
    http_req_duration: ["p(95)<4000"],
    http_req_failed: ["rate<0.02"],
  },
};

function post(text, sessionId) {
  const body = JSON.stringify(sessionId ? { text, sessionId } : { text });
  return http.post(`${BASE_URL}/api/message`, body, {
    headers: { "content-type": "application/json" },
    timeout: "15s",
  });
}

const SPORT_ONLY_MESSAGES = [
  "vorrei giocare a tennis",
  "vorrei giocare a padel",
  "cerco qualcosa di tennis",
  "mi piacerebbe fare padel",
];

export function slotFilling() {
  const msg = SPORT_ONLY_MESSAGES[Math.floor(Math.random() * SPORT_ONLY_MESSAGES.length)];
  const res = post(msg);
  check(res, {
    "slot-filling: 200": (r) => r.status === 200,
    "slot-filling: got a reply": (r) => {
      try {
        return typeof JSON.parse(r.body).reply === "string";
      } catch {
        return false;
      }
    },
  });
  sleep(1);
}

// A handful of real, known-good intents (city+date verified against the
// live catalog while building this — see ARCHITECTURE.md) so this
// scenario measures the real search path, not a guaranteed "no match".
const FULL_INTENTS = [
  "vorrei giocare a tennis a Roma il 25 settembre, budget 400 euro",
  "vorrei giocare a padel a Milano il 17 ottobre, budget 250 euro",
  "cerco tennis a Roma per il 1 ottobre, budget 500 euro",
];

export function fullSearch() {
  const msg = FULL_INTENTS[Math.floor(Math.random() * FULL_INTENTS.length)];
  const res = post(msg);
  check(res, {
    "full-search: 200": (r) => r.status === 200,
    "full-search: reached proposing or asked to clarify": (r) => {
      try {
        const stage = JSON.parse(r.body).state.stage;
        return stage === "proposing" || stage === "collecting";
      } catch {
        return false;
      }
    },
  });
  sleep(2);
}
