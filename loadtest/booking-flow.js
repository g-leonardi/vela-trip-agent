// Placeholder — da riempire con gli endpoint reali una volta letto il brief.
// Esegui con: k6 run loadtest/booking-flow.js
// Override base url: k6 run -e BASE_URL=https://... loadtest/booking-flow.js

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    booking_funnel: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m', target: 100 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  // TODO: sostituire con il vero funnel — es. search -> get details -> book -> confirm
  const search = http.get(`${BASE_URL}/api/search?destination=rome`);
  check(search, { 'search 200': (r) => r.status === 200 });

  sleep(1);
}
