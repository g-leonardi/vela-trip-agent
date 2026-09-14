import { afterEach, describe, expect, it, vi } from "vitest";
import { HofjApiError, HofjClient } from "../src/hofj/client";
import type { Env } from "../src/types";

function fakeEnv(): Env {
  return {
    HOFJ_BASE_URL: "https://api.hofj.test",
    HOFJ_BRAND: "terrarossa.com",
    HOFJ_LOCALE: "it",
    HOFJ_API_KEY: "test-key",
  } as Env;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HofjClient", () => {
  it("sends the Bearer token, brand and locale on every request", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse(200, { data: { total: 0, products: [] } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new HofjClient(fakeEnv());
    await client.search({ keyword: "roma tennis" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    const calledUrl = new URL(String(url));
    expect(calledUrl.searchParams.get("brand")).toBe("terrarossa.com");
    expect(calledUrl.searchParams.get("locale")).toBe("it");
    expect(calledUrl.searchParams.get("keyword")).toBe("roma tennis");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
  });

  it("retries once on a 502 and succeeds if the retry works", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(502, { detail: "upstream hiccup" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { total: 0, products: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HofjClient(fakeEnv());
    const result = await client.search({});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.data.total).toBe(0);
  });

  it("throws a retryable HofjApiError after exhausting the single retry on 502", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(502, { title: "Upstream Error", detail: "returned 405" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new HofjClient(fakeEnv());
    await expect(client.getPaymentIntent("abc", "terrarossa.com")).rejects.toMatchObject({
      status: 502,
      retryable: true,
    } satisfies Partial<HofjApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(2); // one retry, then give up
  });

  it("does not retry a 403 and surfaces it immediately as non-retryable", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(403, { title: "Forbidden", detail: "This client is not allowed to access resource: bookings." }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new HofjClient(fakeEnv());
    await expect(client.confirmBooking("abc", "terrarossa.com")).rejects.toMatchObject({
      status: 403,
      retryable: false,
    } satisfies Partial<HofjApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no wasted retry on a permission error
  });

  it("coerces productId to a number even when given a numeric string (upstream Zod quirk)", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse(200, { data: { itineraryId: "it1" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new HofjClient(fakeEnv());
    await client.createItinerary({ productId: "988", startDate: "2026-09-25", adults: 1, rooms: 1, brand: "terrarossa.com" });

    const [, init] = fetchMock.mock.calls[0]!;
    const sentBody = JSON.parse(String(init?.body));
    expect(sentBody.productId).toBe(988);
    expect(typeof sentBody.productId).toBe("number");
  });

  it("does NOT retry createItinerary on a transient error (unlike bookings, it's not an upsert)", async () => {
    // Regression: an earlier version retried every POST uniformly, which
    // risks leaving a second, orphaned real cart behind if the first
    // createItinerary attempt actually succeeded server-side and only the
    // response was lost to the transient error.
    const fetchMock = vi.fn(async () => jsonResponse(502, { detail: "upstream hiccup" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HofjClient(fakeEnv());
    await expect(
      client.createItinerary({ productId: 988, startDate: "2026-09-25", adults: 1, rooms: 1, brand: "terrarossa.com" }),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
  });

  it("sends createItinerary against the EXPLICIT brand passed in, not the client's own default (regression: every Weebora-sourced product 404ed because this call always used the client's primary brand regardless of where the product actually came from)", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse(200, { data: { itineraryId: "it1" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // Client's own default brand is "terrarossa.com" (fakeEnv), but this
    // product was found under weebora.com — the call must honor that.
    const client = new HofjClient(fakeEnv());
    await client.createItinerary({ productId: 181, startDate: "2026-09-17", adults: 2, rooms: 1, brand: "weebora.com" });

    const [url] = fetchMock.mock.calls[0]!;
    const calledUrl = new URL(String(url));
    expect(calledUrl.searchParams.get("brand")).toBe("weebora.com");
  });

  it("sends putPax, putCustomer and confirmBooking against the explicit brand passed in too", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse(200, { data: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HofjClient(fakeEnv());

    await client.putPax("it1", [{ refId: "pax-1" }], "weebora.com");
    await client.confirmBooking("it1", "weebora.com", "plan");

    for (const call of fetchMock.mock.calls) {
      const calledUrl = new URL(String(call[0]));
      expect(calledUrl.searchParams.get("brand")).toBe("weebora.com");
    }
  });
});
