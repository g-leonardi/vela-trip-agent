import { describe, expect, it, vi } from "vitest";
import { classify, searchCandidates } from "../src/engine/matcher";
import type { HofjClient, SearchProduct } from "../src/hofj/client";
import { EMPTY_SLOTS } from "../src/types";
import type { Slots } from "../src/types";

function product(overrides: Partial<SearchProduct>): SearchProduct {
  return {
    productId: 1,
    title: "Test Product",
    price: 300,
    currency: "EUR",
    primaryCategory: "holidays",
    primaryDestination: "rome-copy",
    primaryVenue: "some-club",
    country: "IT",
    minDate: "2026-09-01",
    maxDate: "2026-12-01",
    defaultDurationInDays: 3,
    ...overrides,
  };
}

const baseSlots: Slots = { ...EMPTY_SLOTS, sport: "tennis", city: "Roma", adults: 1 };

describe("classify", () => {
  it("returns null when there are no candidates", () => {
    expect(classify(baseSlots, [], [], true)).toBeNull();
  });

  it("classifies as exact when price, date and location all satisfy the request", () => {
    const slots: Slots = { ...baseSlots, budget: 400, dateFrom: "2026-09-25" };
    const result = classify(slots, [product({ price: 365 })], [], true);
    expect(result?.category).toBe("exact");
    expect(result?.compromise).toBeNull();
  });

  it("classifies as compromise when price exceeds budget but within tolerance", () => {
    const slots: Slots = { ...baseSlots, budget: 300, dateFrom: "2026-09-25" };
    const result = classify(slots, [product({ price: 465 })], [], true);
    expect(result?.category).toBe("compromise");
    expect(result?.compromise?.kind).toBe("price");
    expect(result?.compromise?.requested).toBe("300€");
    expect(result?.compromise?.offered).toBe("465€");
  });

  it("returns null (ask a clarifying question) when price is unreasonably far over budget", () => {
    const slots: Slots = { ...baseSlots, budget: 100, dateFrom: "2026-09-25" };
    const result = classify(slots, [product({ price: 465 })], [], true);
    expect(result).toBeNull();
  });

  it("classifies as compromise when the requested date is outside the product window but close", () => {
    const slots: Slots = { ...baseSlots, dateFrom: "2026-08-20" }; // 12 days before minDate
    const result = classify(slots, [product({ minDate: "2026-09-01", maxDate: "2026-12-01" })], [], true);
    expect(result?.category).toBe("compromise");
    expect(result?.compromise?.kind).toBe("date");
    expect(result?.compromise?.offered).toBe("2026-09-01");
  });

  it("returns null when the nearest available date is too far from what was requested", () => {
    const slots: Slots = { ...baseSlots, dateFrom: "2026-01-01" }; // months before minDate
    const result = classify(slots, [product({ minDate: "2026-09-01", maxDate: "2026-12-01" })], [], true);
    expect(result).toBeNull();
  });

  it("skips rejected products and proposes the next one", () => {
    const a = product({ productId: 1, price: 300 });
    const b = product({ productId: 2, price: 320 });
    const result = classify({ ...baseSlots, dateFrom: "2026-09-25" }, [a, b], ["1"], true);
    expect(result?.candidate.productId).toBe("2");
  });

  it("proposes the candidate's earliest availability when no date was given at all, as a compromise (regression: live loop where the dialogue just re-asked 'when?' forever instead of ever proposing)", () => {
    const slots: Slots = { ...baseSlots, budget: 400 }; // no dateFrom
    const result = classify(slots, [product({ price: 365, minDate: "2026-10-09" })], [], true);
    expect(result?.category).toBe("compromise");
    expect(result?.compromise).toEqual({ kind: "date_unspecified", requested: "", offered: "2026-10-09" });
  });

  it("lets an unresolved price compromise take priority over date_unspecified in the message (both true, but only one gets said)", () => {
    const slots: Slots = { ...baseSlots, budget: 100 }; // no dateFrom, price will also be off
    const result = classify(slots, [product({ price: 150, minDate: "2026-10-09" })], [], true);
    expect(result?.category).toBe("compromise");
    expect(result?.compromise?.kind).toBe("price");
  });

  it("flags date_unspecified when no date was given even with a generous budget", () => {
    const slots: Slots = { ...baseSlots, budget: 1000 }; // generous budget, no dateFrom
    const result = classify(slots, [product({ price: 200 })], [], true);
    // No date at all is never "exact" — the system is choosing a date on
    // the traveller's behalf, which always deserves an explicit compromise
    // confirmation, never a silent "matches exactly".
    expect(result?.category).toBe("compromise");
    expect(result?.compromise?.kind).toBe("date_unspecified");
  });

  it("flags location_unspecified when locationMatched is false, even with everything else exact", () => {
    const slots: Slots = { ...baseSlots, budget: 400, dateFrom: "2026-09-25" };
    const result = classify(slots, [product({ price: 365, primaryDestination: "milano" })], [], false);
    expect(result?.category).toBe("compromise");
    expect(result?.compromise).toEqual({ kind: "location_unspecified", requested: "Roma", offered: "milano" });
  });

  it("lets price take priority over location_unspecified in the message", () => {
    const slots: Slots = { ...baseSlots, budget: 300, dateFrom: "2026-09-25" };
    const result = classify(slots, [product({ price: 465 })], [], false);
    expect(result?.category).toBe("compromise");
    expect(result?.compromise?.kind).toBe("price");
  });
});

function fakeHofjClient(byBrand: Record<string, SearchProduct[]>): HofjClient {
  return {
    search: vi.fn(async (params: { brand?: string }) => ({
      data: { total: 0, products: byBrand[params.brand ?? "terrarossa.com"] ?? [] },
    })),
  } as unknown as HofjClient;
}

describe("searchCandidates", () => {
  it("filters out results whose city doesn't match what was requested", async () => {
    const wrongCity = product({ primaryDestination: "forte-dei-marmi", primaryVenue: "tennis-roma-fdm" });
    const rightCity = product({ productId: 2, primaryDestination: "rome-copy", title: "Roma Tennis Experience" });
    const hofj = fakeHofjClient({ "terrarossa.com": [wrongCity, rightCity] });

    const { candidates, locationMatched } = await searchCandidates(hofj, { ...baseSlots, city: "Roma" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.productId).toBe(2);
    expect(locationMatched).toBe(true);
  });

  it("understands the roma/rome IT-EN synonym", async () => {
    const rome = product({ primaryDestination: "rome", title: "Rome Tennis Getaway" });
    const hofj = fakeHofjClient({ "terrarossa.com": [rome] });
    const { candidates } = await searchCandidates(hofj, { ...baseSlots, city: "Roma" });
    expect(candidates).toHaveLength(1);
  });

  it("falls back to Weebora for padel when Terrarossa has nothing matching", async () => {
    const padelInWeebora = product({ productId: 9, primaryDestination: "valencia", title: "Padel Clinic Valencia" });
    const hofj = fakeHofjClient({
      "terrarossa.com": [],
      "weebora.com": [padelInWeebora],
    });
    const { candidates, locationMatched } = await searchCandidates(hofj, {
      ...baseSlots,
      sport: "padel",
      city: "Valencia",
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.productId).toBe(9);
    expect(locationMatched).toBe(true);
  });

  it("falls back to unfiltered results (locationMatched: false) when the given city matches nothing anywhere, instead of returning empty (regression: live user's location never resolved to a real city)", async () => {
    const elsewhere = product({ productId: 5, primaryDestination: "milano", title: "Tennis a Milano" });
    const hofj = fakeHofjClient({ "terrarossa.com": [elsewhere] });

    const { candidates, locationMatched } = await searchCandidates(hofj, { ...baseSlots, city: "Corso Smeralda" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.productId).toBe(5);
    expect(locationMatched).toBe(false);
  });

  it("locationMatched is false when no city was given at all", async () => {
    const anywhere = product({ productId: 6 });
    const hofj = fakeHofjClient({ "terrarossa.com": [anywhere] });

    const { candidates, locationMatched } = await searchCandidates(hofj, { ...baseSlots, city: null });
    expect(candidates).toHaveLength(1);
    expect(locationMatched).toBe(false);
  });

  it("tries a preferences-enriched keyword first, falls back to plain city+sport if that returns nothing", async () => {
    const match = product({ productId: 3, primaryDestination: "rome-copy", title: "Roma Tennis Experience" });
    const search = vi.fn(async (params: { keyword?: string }) => ({
      data: {
        total: params.keyword?.includes("bravo insegnante") ? 0 : 1,
        products: params.keyword?.includes("bravo insegnante") ? [] : [match],
      },
    }));
    const hofj = { search } as unknown as HofjClient;

    const { candidates } = await searchCandidates(hofj, {
      ...baseSlots,
      city: "Roma",
      preferences: "bravo insegnante",
    });

    expect(candidates).toHaveLength(1);
    expect(search).toHaveBeenCalledTimes(2); // enriched attempt, then plain fallback
    expect(search.mock.calls[0]![0].keyword).toContain("bravo insegnante");
    expect(search.mock.calls[1]![0].keyword).not.toContain("bravo insegnante");
  });

  it("skips the preferences attempt entirely when none were given (no wasted call)", async () => {
    const match = product({ productId: 4 });
    const search = vi.fn(async () => ({ data: { total: 1, products: [match] } }));
    const hofj = { search } as unknown as HofjClient;

    await searchCandidates(hofj, { ...baseSlots, city: "Roma" });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to Weebora for tennis", async () => {
    const hofj = fakeHofjClient({ "terrarossa.com": [], "weebora.com": [product({ productId: 9 })] });
    const { candidates } = await searchCandidates(hofj, { ...baseSlots, sport: "tennis" });
    expect(candidates).toHaveLength(0);
  });
});
