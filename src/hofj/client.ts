import type { Env } from "../types";

export class HofjApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
    public retryable: boolean,
  ) {
    super(`HOFJ ${status}: ${detail}`);
    this.name = "HofjApiError";
  }
}

export interface SearchProduct {
  productId: number;
  title: string;
  price: number;
  currency: string;
  primaryCategory: string;
  primaryDestination: string;
  primaryVenue?: string;
  country: string;
  minDate: string;
  maxDate: string;
  defaultDurationInDays: number;
}

export interface SearchResponse {
  data: { total: number; products: SearchProduct[] };
}

export interface CreateItineraryResponse {
  data: { itineraryId: string };
}

export interface ProductDetail {
  data: {
    id: number;
    title: string;
    shortDescription: string | null;
    description: string | null;
  };
}

export interface ItinerarySnapshot {
  data: {
    productId: string;
    title: string;
    titleVenue: string;
    totalPrice: { amount: string; currency: string };
    startDate: string;
    endDate: string;
    checkout: { status: string; total: { amount: string; currency: string } };
  };
}

export interface CustomerPayload {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: {
    street1: string;
    postalCode: string;
    city: string;
    region: string;
    countryCode: string;
  };
}

export interface PaxPayload {
  refId: string;
  firstName?: string;
  lastName?: string;
}

/** Test-only failure scenarios for STUB_MODE (see Env.STUB_MODE's doc,
 * types.ts), added 2026-09-15 so test/conversation.test.ts can exercise
 * conversation.ts's compromise/error branches deterministically — the
 * default stub behavior is a single always-succeeding product, which
 * only ever reaches the happy path. A test selects a scenario by putting
 * `SCENARIO:<key>` anywhere in `slots.preferences` (it flows straight
 * into the search keyword via buildKeyword(), engine/matcher.ts) — the
 * stub search() below returns that scenario's specific product(s), and
 * every later call keyed on the resulting itineraryId
 * (getItinerary/putCustomer/confirmBooking) looks up which scenario it
 * belongs to (see `stubItineraryScenario`) to decide how to respond.
 * Each productId is a fixed, reserved sentinel — never a real HOFJ id. */
const STUB_SCENARIOS = {
  // createItinerary fails unless called with the product's own minDate —
  // exercises openRealCartAndAttemptPayment's date-fallback/
  // date_shift_confirm branch (conversation.ts).
  date_shift: { productId: 9001, minDate: "2026-01-01", maxDate: "2027-12-31" },
  // createItinerary succeeds, but getItinerary reports a real total
  // wildly different from what search() advertised — exercises the
  // price_changed branch.
  price_changed: { productId: 9002, minDate: "2026-01-01", maxDate: "2027-12-31" },
  // createItinerary ALWAYS fails, even on its own minDate — exercises
  // the "genuinely unavailable, reject and search again" branch. A
  // second, always-succeeding product is returned alongside it so the
  // automatic retry search has something to actually find.
  unavailable: { productId: 9003, minDate: "2026-01-01", maxDate: "2027-12-31" },
  // putCustomer/putPax reject the traveller's data with a 400 the FIRST
  // time for a given itineraryId, then accept it on retry — exercises
  // the "reset traveller data and re-collect" correction branch.
  customer_rejected: { productId: 9004, minDate: "2026-01-01", maxDate: "2027-12-31" },
  // confirmBooking returns 200 but checkout.status never actually moves
  // off "BookingInitiated" — reproduces the real, still-open bug this
  // session is blocked on (see ARCHITECTURE.md, the Carlo email
  // thread) — exercises the booking_unverified branch.
  never_confirms: { productId: 9005, minDate: "2026-01-01", maxDate: "2027-12-31" },
} as const;

function findScenarioByKeyword(keyword: string | undefined): keyof typeof STUB_SCENARIOS | null {
  if (!keyword) return null;
  for (const key of Object.keys(STUB_SCENARIOS) as (keyof typeof STUB_SCENARIOS)[]) {
    if (keyword.includes(`SCENARIO:${key}`)) return key;
  }
  return null;
}

function findScenarioByProductId(productId: number): keyof typeof STUB_SCENARIOS | null {
  for (const [key, cfg] of Object.entries(STUB_SCENARIOS) as [keyof typeof STUB_SCENARIOS, { productId: number }][]) {
    if (cfg.productId === productId) return key;
  }
  return null;
}

/** Thin, typed wrapper over the House of Journeys distribution API.
 * Retries transient upstream failures (429/502/503) once with backoff;
 * surfaces permission/config errors (401/403/400) immediately since those
 * are never fixed by retrying. */
export class HofjClient {
  private readonly base: string;
  /** The account's primary/default brand (from HOFJ_BRAND) — public so
   * callers that need to tag search results with the brand they actually
   * came from (see engine/matcher.ts) don't have to duplicate this string
   * themselves. */
  readonly brand: string;
  private readonly locale: string;
  private readonly key: string;
  /** See Env.STUB_MODE's doc, types.ts — never true outside
   * wrangler.loadtest.jsonc. */
  private readonly stub: boolean;
  /** Load-test-only bookkeeping: which stub itineraryIds have had a stub
   * confirmBooking() call, so a subsequent stub getItinerary() reports a
   * real state transition (not stuck on "BookingInitiated" forever) —
   * mirrors the real upstream behavior this client verified live
   * 2026-09-14/15 (see confirmBooking's doc below). Instance-scoped
   * (one HofjClient per ConversationDO, see conversation.ts), so this
   * never leaks across conversations. */
  private readonly stubConfirmed = new Set<string>();
  /** Which test scenario (see STUB_SCENARIOS above) a given stub
   * itineraryId belongs to, plus the party size it was created with —
   * recorded at createItinerary time (the only call that sees productId/
   * adults directly; getItinerary/putCustomer/confirmBooking only ever
   * see the itineraryId, so this is how they know which canned behavior
   * to follow and what real total to report). `scenario` is null for
   * the plain default product (productId 1). Instance-scoped, same
   * reasoning as `stubConfirmed`. */
  private readonly stubItineraries = new Map<string, { scenario: keyof typeof STUB_SCENARIOS | null; adults: number }>();
  /** Whether the customer_rejected scenario's one-time 400 has already
   * fired in THIS conversation — a plain boolean, not per-itineraryId:
   * openRealCartAndAttemptPayment always calls createItinerary again on
   * retry (an existing, accepted behavior, see that method's own doc,
   * conversation.ts), which mints a NEW itineraryId each time — tracking
   * "once" per itineraryId would never actually stop rejecting, since
   * the retry's itineraryId is always one this hasn't seen before. One
   * HofjClient per ConversationDO (see conversation.ts) means one real
   * booking flow per instance, so a single flag is the correct scope. */
  private stubCustomerRejectedOnce = false;

  constructor(env: Env) {
    this.base = env.HOFJ_BASE_URL;
    this.brand = env.HOFJ_BRAND;
    this.locale = env.HOFJ_LOCALE;
    this.key = env.HOFJ_API_KEY;
    this.stub = env.STUB_MODE === "1";
  }

  /** Instant, deterministic canned responses for STUB_MODE — no
   * fetch(), no real quota consumed. Small artificial delays keep
   * latency metrics meaningful (not literally 0ms) without the real 15s
   * upstream timeout risk. The default (no SCENARIO marker, see
   * STUB_SCENARIOS above) stays exactly what it always was: a single
   * always-succeeding product, internally consistent (fixed
   * price/budget/adults) so a load-test conversation reaches "booked"
   * in the fewest turns without ever tripping a compromise loop that
   * has nothing to do with what that test measures (see
   * loadtest/scale-50k.js) — unchanged by everything below. */
  private async stubRequest<T>(method: string, path: string, opts: { query?: Record<string, unknown>; body?: unknown } = {}): Promise<T> {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    if (path === "/v1/recommendations/search") {
      await wait(50);
      const scenario = findScenarioByKeyword(opts.query?.keyword as string | undefined);
      if (!scenario) {
        return {
          data: {
            total: 1,
            products: [
              {
                productId: 1,
                title: "Stub Tennis Package",
                price: 250,
                currency: "EUR",
                primaryCategory: "tennis",
                primaryDestination: "Roma",
                country: "IT",
                minDate: "2026-01-01",
                maxDate: "2027-12-31",
                defaultDurationInDays: 3,
              },
            ],
          },
        } as T;
      }
      const cfg = STUB_SCENARIOS[scenario];
      const scenarioProduct = {
        productId: cfg.productId,
        title: `Stub Scenario: ${scenario}`,
        price: 250,
        currency: "EUR",
        primaryCategory: "tennis",
        primaryDestination: "Roma",
        country: "IT",
        minDate: cfg.minDate,
        maxDate: cfg.maxDate,
        defaultDurationInDays: 3,
      };
      // "unavailable" always fails at createItinerary, even on its own
      // minDate — pair it with the plain default product (ranked
      // second) so the automatic retry search this triggers actually
      // finds something, same as a real "original truly unbookable"
      // recovery.
      const products =
        scenario === "unavailable"
          ? [
              scenarioProduct,
              { ...scenarioProduct, productId: 1, title: "Stub Tennis Package (fallback)" },
            ]
          : [scenarioProduct];
      return { data: { total: products.length, products } } as T;
    }

    if (path.startsWith("/v1/products/")) {
      await wait(40);
      return { data: { id: 1, title: "Stub Tennis Package", shortDescription: "stub", description: "Stub product description." } } as T;
    }

    if (path === "/v1/itineraries" && method === "POST") {
      const body = opts.body as { productId: number; startDate: string; adults: number } | undefined;
      const productId = body?.productId ?? 1;
      const scenario = findScenarioByProductId(productId);
      await wait(80);
      if (scenario === "date_shift" && body!.startDate !== STUB_SCENARIOS.date_shift.minDate) {
        throw new HofjApiError(400, "RESERVATION_PERIOD_ERROR (stub: date_shift scenario, wrong startDate)", false);
      }
      if (scenario === "unavailable") {
        throw new HofjApiError(404, "NOT_FOUND_ERROR (stub: unavailable scenario, always fails)", false);
      }
      const itineraryId = `stub-${crypto.randomUUID()}`;
      this.stubItineraries.set(itineraryId, { scenario, adults: body?.adults ?? 2 });
      return { data: { itineraryId } } as T;
    }

    if (/^\/v1\/itineraries\/[^/]+$/.test(path) && method === "GET") {
      const itineraryId = path.split("/")[3]!;
      const info = this.stubItineraries.get(itineraryId);
      await wait(70);
      // "price_changed" reports a real total wildly different from what
      // search() advertised (250/person); everything else scales
      // consistently with the real party size recorded at
      // createItinerary time (not hardcoded to 2, so DSL-driven tests
      // with a different `adults` value don't spuriously trip this
      // branch by accident).
      const amount = info?.scenario === "price_changed" ? "999" : String(250 * (info?.adults ?? 2));
      // "never_confirms" reproduces the real, still-open bug this
      // session is blocked on (see ARCHITECTURE.md): checkout.status
      // never moves off "BookingInitiated" even after a real-looking
      // confirmBooking 200 — everything else follows stubConfirmed
      // normally.
      const status = info?.scenario === "never_confirms" ? "BookingInitiated" : this.stubConfirmed.has(itineraryId) ? "Booked" : "BookingInitiated";
      return {
        data: {
          productId: "1",
          title: "Stub Tennis Package",
          titleVenue: "Roma",
          totalPrice: { amount, currency: "EUR" },
          startDate: "2026-09-25",
          endDate: "2026-09-28",
          checkout: { status, total: { amount, currency: "EUR" } },
        },
      } as T;
    }

    if (path.endsWith("/customer")) {
      const itineraryId = path.split("/")[3]!;
      const info = this.stubItineraries.get(itineraryId);
      await wait(50);
      if (info?.scenario === "customer_rejected" && !this.stubCustomerRejectedOnce) {
        this.stubCustomerRejectedOnce = true;
        throw new HofjApiError(400, "INVALID_CUSTOMER_DATA (stub: customer_rejected scenario, first attempt only)", false);
      }
      return undefined as T;
    }
    if (path.endsWith("/pax")) {
      await wait(50);
      return undefined as T;
    }

    if (path.endsWith("/payment")) {
      await wait(50);
      return { data: "stub-client-secret" } as T;
    }

    if (path === "/v1/bookings" && method === "POST") {
      const itineraryId = (opts.body as { itineraryId?: string } | undefined)?.itineraryId ?? "";
      const info = this.stubItineraries.get(itineraryId);
      // Real reservation code IS the itineraryId, by construction —
      // confirmed by Carlo (Vela/HOFJ, email 2026-09-15, see
      // ARCHITECTURE.md) — true here too, even for "never_confirms":
      // the 200 itself is genuine, only checkout.status never catches up.
      if (info?.scenario !== "never_confirms") this.stubConfirmed.add(itineraryId);
      await wait(90);
      return { data: itineraryId } as T;
    }

    if (path === "/v1/quota") {
      return { data: { remainingInWindow: 100, limitPerMinute: 100 } } as T;
    }
    throw new Error(`stubRequest: unhandled path ${method} ${path}`);
  }

  private async request<T>(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      brand?: string;
      /** Set for any POST that isn't a documented upsert — retrying a
       * transient error on a true "create" call risks leaving a second,
       * orphaned resource behind if the first attempt actually succeeded
       * server-side and only the response was lost. POST /v1/itineraries
       * is exactly that case (spec: "Create a new itinerary"); POST
       * /v1/bookings is explicitly documented as an upsert keyed by
       * itineraryId, so it stays safe to retry. */
      noRetry?: boolean;
    } = {},
  ): Promise<T> {
    if (this.stub) return this.stubRequest<T>(method, path, { query: opts.query, body: opts.body });

    const url = new URL(this.base + path);
    url.searchParams.set("brand", opts.brand ?? this.brand);
    url.searchParams.set("locale", this.locale);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const doFetch = () =>
      fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.key}`,
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });

    let res = await doFetch();
    if (!opts.noRetry && (res.status === 429 || res.status === 502 || res.status === 503)) {
      await new Promise((r) => setTimeout(r, 400));
      res = await doFetch();
    }

    if (!res.ok) {
      // Read as text first, then try to parse: verified live that
      // res.json() can throw here even though the exact same response body
      // is valid JSON when fetched with curl directly (large error bodies
      // with escaped stack traces — worth having the raw text either way,
      // since a parse failure previously collapsed the real upstream
      // detail down to a useless generic "Bad Gateway").
      const raw = await res.text().catch(() => "");
      let detail = raw || res.statusText;
      try {
        const problem = JSON.parse(raw) as { detail?: string; title?: string };
        detail = problem.detail ?? problem.title ?? detail;
      } catch {
        // not JSON (or empty) — keep the raw text as the detail
      }
      const retryable = res.status === 429 || res.status === 502 || res.status === 503;
      throw new HofjApiError(res.status, detail, retryable);
    }
    return res.json<T>();
  }

  search(params: {
    keyword?: string;
    destination?: string;
    category?: string;
    priceMax?: number;
    dateFrom?: string;
    dateTo?: string;
    topN?: number;
    brand?: string;
  }): Promise<SearchResponse> {
    return this.request("GET", "/v1/recommendations/search", {
      brand: params.brand,
      query: {
        keyword: params.keyword,
        destination: params.destination,
        category: params.category,
        price_max: params.priceMax,
        date_from: params.dateFrom,
        date_to: params.dateTo,
        top_n: params.topN ?? 5,
      },
    });
  }

  /** `brand` MUST be the brand the product was actually searched under
   * (see Candidate.brand's doc, types.ts) — regression found live
   * 2026-09-14: every call in this itinerary-scoped group used to default
   * to the client's own primary brand (`this.brand`, set from
   * HOFJ_BRAND) regardless of where the product came from, so a
   * Weebora-sourced padel candidate always 404ed at createItinerary,
   * misread for hours as "this specific product isn't bookable" when it
   * was really just being looked up against the wrong brand's catalog. */
  createItinerary(input: {
    productId: number | string;
    startDate: string;
    adults: number;
    rooms: number;
    brand: string;
  }): Promise<CreateItineraryResponse> {
    // The OpenAPI spec documents productId as oneOf(integer, string), but
    // the actual brand-site upstream (verified live) enforces a strict Zod
    // number check and 400s on a numeric string. Always coerce.
    const { brand, ...body } = input;
    return this.request("POST", "/v1/itineraries", {
      body: { ...body, productId: Number(body.productId), currency: "EUR" },
      brand,
      noRetry: true, // creates a new cart each call — see request()'s noRetry doc
    });
  }

  getItinerary(itineraryId: string, brand: string): Promise<ItinerarySnapshot> {
    return this.request("GET", `/v1/itineraries/${itineraryId}`, { brand });
  }

  putCustomer(itineraryId: string, customer: CustomerPayload, brand: string): Promise<void> {
    return this.request("PUT", `/v1/itineraries/${itineraryId}/customer`, { body: customer, brand });
  }

  putPax(itineraryId: string, pax: PaxPayload[], brand: string): Promise<void> {
    return this.request("PUT", `/v1/itineraries/${itineraryId}/pax`, { body: pax, brand });
  }

  /** Refresh the Stripe PaymentIntent and return its client_secret — THE
   * critical call in the payment pipeline, not an optional/discardable
   * one (see attemptPayment, conversation.ts). Was broken all day (502,
   * upstream 405) — verified FIXED live 2026-09-14 ~21:35. An earlier
   * verification that day found confirming THIS client_secret's
   * PaymentIntent with our own key 404ed ("resource_missing"), which was
   * read at the time as "belongs to an account we can't touch" — Carlo
   * (Vela/HOFJ, email 2026-09-15) corrected the real cause: HOFJ's own
   * booking confirmation is ASYNCHRONOUS, triggered only when Stripe
   * notifies HOFJ that THIS specific PaymentIntent (the one returned
   * here, created under HOFJ's own account/webhook subscription) was
   * paid — a separate PaymentIntent we mint ourselves (the old
   * createPaymentIntent() bypass, now removed from stripe/client.ts) is
   * invisible to that webhook, so POST /v1/bookings correctly stays
   * "pending" (surfaced as checkout.status "BookingInitiated") forever,
   * no matter how many times it's retried — not a bug in HOFJ's signal,
   * a wrong PaymentIntent on our side. See ARCHITECTURE.md for the full
   * correction and the live re-verification after this fix. */
  getPaymentIntent(itineraryId: string, brand: string): Promise<{ data: string }> {
    return this.request("GET", `/v1/itineraries/${itineraryId}/payment`, { brand });
  }

  /** Confirm the booking after Stripe payment succeeds. `paymentType`
   * ("full" or "plan"/deposit) used to be silently rejected by the
   * gateway regardless of value — verified FIXED live 2026-09-14 ~21:35
   * (real 200, no more ZodError). `paymentIntentId`/`paymentStatus`
   * (documented in the full spec, `GET /v1/openapi.json`) are what let
   * the brand site attach the right payment to the booking.
   *
   * `data` echoes back the itineraryId rather than an "R-12345"-shaped
   * code — Carlo (Vela/HOFJ, email 2026-09-15) confirmed this IS the real
   * reservation code by construction, not a degenerate response; the
   * "R-12345" example in the OpenAPI spec is simply wrong and gets
   * corrected on their side. `checkout.status` staying "BookingInitiated"
   * after a 200, though, was real — see getPaymentIntent's doc above for
   * the actual root cause (a PaymentIntent HOFJ's webhook never sees) and
   * conversation.ts (attemptPayment) for the fix. */
  confirmBooking(
    itineraryId: string,
    brand: string,
    paymentType: "full" | "plan" = "full",
    payment?: { paymentIntentId: string; paymentStatus: string },
  ): Promise<{ data: string }> {
    return this.request("POST", "/v1/bookings", { body: { itineraryId, paymentType, ...payment }, brand });
  }

  getQuota(): Promise<{ data: { remainingInWindow: number; limitPerMinute: number } }> {
    return this.request("GET", "/v1/quota");
  }

  /** Product-level detail (marketing description) — deliberately NOT the
   * same as getItinerary()'s richer travelDetail.includedList/
   * cancellationPolicy, which only exist once a real cart is opened.
   * Used to answer an ad-hoc question about the current proposal
   * ("cosa include il pacchetto?") WITHOUT opening a real itinerary for
   * every proposal just to answer a question — Giuseppe's explicit call
   * (2026-09-14, see ARCHITECTURE.md scope-cut) that a real cart only
   * gets opened after confirmation, never during a still-negotiable
   * proposal. */
  getProduct(productId: number | string, brand: string): Promise<ProductDetail> {
    return this.request("GET", `/v1/products/${productId}`, { brand });
  }
}
