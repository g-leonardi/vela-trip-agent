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
  private readonly brand: string;
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
    opts: { query?: Record<string, string | number | undefined>; body?: unknown; brand?: string } = {},
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
    if (res.status === 429 || res.status === 502 || res.status === 503) {
      // Safe to retry once, including POST: /itineraries and /bookings are
      // documented as upserts (same key returns the existing resource
      // rather than creating a duplicate).
      await new Promise((r) => setTimeout(r, 400));
      res = await doFetch();
    }

    if (!res.ok) {
      const problem = await res
        .json<{ detail?: string; title?: string }>()
        .catch((): { detail?: string; title?: string } => ({}));
      const detail = problem.detail ?? problem.title ?? res.statusText;
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

  createItinerary(input: {
    productId: number | string;
    startDate: string;
    adults: number;
    rooms: number;
  }): Promise<CreateItineraryResponse> {
    return this.request("POST", "/v1/itineraries", {
      body: { ...input, currency: "EUR" },
    });
  }

  getItinerary(itineraryId: string): Promise<ItinerarySnapshot> {
    return this.request("GET", `/v1/itineraries/${itineraryId}`);
  }

  putCustomer(itineraryId: string, customer: CustomerPayload): Promise<void> {
    return this.request("PUT", `/v1/itineraries/${itineraryId}/customer`, { body: customer });
  }

  putPax(itineraryId: string, pax: PaxPayload[]): Promise<void> {
    return this.request("PUT", `/v1/itineraries/${itineraryId}/pax`, { body: pax });
  }

  /** Refresh the Stripe PaymentIntent and return its client_secret.
   * Known-broken upstream as of 2026-09-14 (502, upstream 405) — see
   * ARCHITECTURE.md. Kept spec-correct so it starts working the moment the
   * upstream bug is fixed, since HOFJ's inventory/backend is shared and can
   * change during the session. */
  getPaymentIntent(itineraryId: string): Promise<{ data: string }> {
    return this.request("GET", `/v1/itineraries/${itineraryId}/payment`);
  }

  /** Confirm the booking after Stripe payment succeeds. Known-broken
   * upstream as of 2026-09-14 (403 forbidden-entity: the provided API key's
   * allowedEntities does not include "bookings") — see ARCHITECTURE.md. */
  confirmBooking(itineraryId: string): Promise<{ data: string }> {
    return this.request("POST", "/v1/bookings", { body: { itineraryId } });
  }

  getQuota(): Promise<{ data: { remainingInWindow: number; limitPerMinute: number } }> {
    return this.request("GET", "/v1/quota");
  }
}
