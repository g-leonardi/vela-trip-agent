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

  constructor(env: Env) {
    this.base = env.HOFJ_BASE_URL;
    this.brand = env.HOFJ_BRAND;
    this.locale = env.HOFJ_LOCALE;
    this.key = env.HOFJ_API_KEY;
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

  /** Refresh the Stripe PaymentIntent and return its client_secret. Was
   * broken all day (502, upstream 405) — verified FIXED live 2026-09-14
   * ~21:35 (real client_secret returned). Still can't be driven to
   * completion from here, though: the PaymentIntent it returns belongs to
   * a Stripe account our own key can't read (verified live: both GET and
   * confirm 404 "resource_missing") — by design, most likely, since the
   * real flow expects the traveller's own browser to confirm it
   * client-side with the brand's own publishable key. See conversation.ts
   * (attemptPayment) and ARCHITECTURE.md for the full trail. */
  getPaymentIntent(itineraryId: string, brand: string): Promise<{ data: string }> {
    return this.request("GET", `/v1/itineraries/${itineraryId}/payment`, { brand });
  }

  /** Confirm the booking after Stripe payment succeeds. `paymentType`
   * ("full" or "plan"/deposit) used to be silently rejected by the
   * gateway regardless of value — verified FIXED live 2026-09-14 ~21:35
   * (real 200, no more ZodError). But a 200 here isn't the whole story:
   * the full spec (`GET /v1/openapi.json`, not in the version originally
   * reviewed) documents two more optional fields, `paymentIntentId` and
   * `paymentStatus`, "forwarded to the brand site when present" — without
   * them the brand site has no way to know which payment to attach, and
   * verified live that the response is a degenerate one even after this
   * fix: `data` just echoes back the itineraryId instead of a real
   * "R-12345"-shaped reservation code (spec's own example), and the
   * itinerary's `checkout.status` stays "BookingInitiated" rather than
   * moving to a booked state — true even when `paymentIntentId`/
   * `paymentStatus` ARE forwarded, pointing at a real, confirmed
   * PaymentIntent from our own sanctioned-bypass Stripe account. Most
   * likely explanation: the brand site can't verify a PaymentIntent from
   * an account it doesn't itself own — expected in a *real* deployment,
   * where the traveller's own browser would confirm HOFJ's own
   * `GET .../payment` client_secret with the brand's own publishable key,
   * never something minted server-side under our own bypass account. See
   * ARCHITECTURE.md for the full trail — this is the accurate, current
   * state, not a guess. */
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
