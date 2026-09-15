import { describe, expect, it, vi } from "vitest";
import { classify, searchCandidates } from "../src/engine/matcher";
import type { HofjClient, SearchProduct } from "../src/hofj/client";
import { EMPTY_SLOTS } from "../src/types";
import type { Slots } from "../src/types";

function product(overrides: Partial<SearchProduct & { brand: string }>): SearchProduct & { brand: string } {
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
    brand: "terrarossa.com",
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

  it("with a numeric budget, prefers a lower-ranked candidate that actually fits over the top-ranked one that doesn't (regression: selection used to always take pool[0] regardless of price, checking budget only after picking)", () => {
    const slots: Slots = { ...baseSlots, budget: 400, dateFrom: "2026-09-25" };
    const tooExpensiveButTopRanked = product({ productId: 1, price: 600 });
    const fitsButRankedLower = product({ productId: 2, price: 380 });
    const result = classify(slots, [tooExpensiveButTopRanked, fitsButRankedLower], [], true);
    expect(result?.candidate.productId).toBe("2");
    expect(result?.category).toBe("exact");
  });

  it("with a numeric budget, still respects the API's own relevance ranking among candidates that all fit", () => {
    const slots: Slots = { ...baseSlots, budget: 400, dateFrom: "2026-09-25" };
    const topRankedAndFits = product({ productId: 1, price: 350 });
    const alsoFitsButRankedLower = product({ productId: 2, price: 300 });
    const result = classify(slots, [topRankedAndFits, alsoFitsButRankedLower], [], true);
    expect(result?.candidate.productId).toBe("1");
  });

  it("with a numeric budget, falls back to the smallest overage when nothing in the pool fits", () => {
    const slots: Slots = { ...baseSlots, budget: 400, dateFrom: "2026-09-25" };
    const topRankedBigOverage = product({ productId: 1, price: 600 });
    const smallerOverage = product({ productId: 2, price: 450 });
    const result = classify(slots, [topRankedBigOverage, smallerOverage], [], true);
    expect(result?.candidate.productId).toBe("2");
    expect(result?.compromise?.offered).toBe("450€");
  });

  it("among candidates that all fit budget, prefers one that ALSO already covers the requested date over one that would additionally need a date compromise (more sophisticated selection: minimize compromises across dimensions, not just budget)", () => {
    const slots: Slots = { ...baseSlots, budget: 400, dateFrom: "2026-09-25" };
    const topRankedButWrongDates = product({ productId: 1, price: 350, minDate: "2026-11-01", maxDate: "2026-12-01" });
    const rankedLowerButCoversDate = product({ productId: 2, price: 350, minDate: "2026-09-01", maxDate: "2026-12-01" });
    const result = classify(slots, [topRankedButWrongDates, rankedLowerButCoversDate], [], true);
    expect(result?.candidate.productId).toBe("2");
    expect(result?.category).toBe("exact");
  });

  it("does nothing (no-op) when only one real candidate exists — the date tiebreaker never fabricates a comparison out of a single result", () => {
    const slots: Slots = { ...baseSlots, budget: 400, dateFrom: "2026-09-25" };
    const onlyOption = product({ productId: 1, price: 350, minDate: "2026-11-01", maxDate: "2026-12-01" });
    const result = classify(slots, [onlyOption], [], true);
    expect(result?.candidate.productId).toBe("1");
    expect(result?.category).toBe("compromise");
    expect(result?.compromise?.kind).toBe("date");
  });

  it("classifies as compromise when the requested date is outside the product window but close", () => {
    const slots: Slots = { ...baseSlots, budget: 400, dateFrom: "2026-08-20" }; // 12 days before minDate
    const result = classify(slots, [product({ minDate: "2026-09-01", maxDate: "2026-12-01" })], [], true);
    expect(result?.category).toBe("compromise");
    expect(result?.compromise?.kind).toBe("date");
    expect(result?.compromise?.offered).toBe("2026-09-01");
  });

  it("returns null when the nearest available date is too far from what was requested", () => {
    const slots: Slots = { ...baseSlots, budget: 400, dateFrom: "2026-01-01" }; // months before minDate
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

  it("reasons over a per-city shortlist when the city isn't pinned, so a city's own best offer isn't crowded out by its own pricier duplicates (Giuseppe, 2026-09-14: 'valuta più candidati città prima di scegliere quale proporre')", () => {
    const slots: Slots = { ...baseSlots, city: null, dateFrom: "2026-09-25", budget: 1000 };
    const milanoExpensiveFirst = product({ productId: 1, price: 900, primaryDestination: "milano" });
    const torinoOnlyOption = product({ productId: 2, price: 300, primaryDestination: "torino" });
    const milanoCheaperLater = product({ productId: 3, price: 400, primaryDestination: "milano" });
    const result = classify(slots, [milanoExpensiveFirst, torinoOnlyOption, milanoCheaperLater], [], false);
    // Milano is still the first city encountered in the raw ranking, so it
    // stays the proposed city — but via its own honest cheapest listing
    // (400, id 3), not whichever specific SKU happened to rank first (900,
    // id 1). Torino's single listing was a fair shortlist candidate too,
    // just not the one selected here.
    expect(result?.candidate.productId).toBe("3");
  });

  it("still results in exactly one final proposal across a multi-city shortlist, never a list — a distinct city's cheapest listing wins outright when it's the genuinely cheapest", () => {
    const slots: Slots = { ...baseSlots, city: null }; // no budget, no dateFrom: wantsCheapest path
    const milano = product({ productId: 1, price: 500, primaryDestination: "milano" });
    const torinoCheapest = product({ productId: 2, price: 120, primaryDestination: "torino" });
    const result = classify(slots, [milano, torinoCheapest], [], false);
    expect(result?.candidate.productId).toBe("2");
    expect(result?.category).toBe("compromise"); // location_unspecified + date_unspecified both apply
  });

  it("proposes the cheapest relevant candidate and flags budget_unspecified when budget was never mentioned at all (regression: budget used to block forever if never given)", () => {
    const slots: Slots = { ...baseSlots, dateFrom: "2026-09-25" }; // no budget, no budgetTier
    const cheap = product({ productId: 1, price: 150 });
    const pricier = product({ productId: 2, price: 400 });
    // API ranking (relevance) puts the pricier one first — cheapest
    // selection must override that ranking, not just filter it.
    const result = classify(slots, [pricier, cheap], [], true);
    expect(result?.category).toBe("compromise");
    expect(result?.candidate.productId).toBe("1");
    expect(result?.compromise).toEqual({ kind: "budget_unspecified", requested: "", offered: "150€" });
  });

  it("budgetTier 'low' selects the cheapest candidate too, but as an exact match — the traveller did answer, just qualitatively", () => {
    const slots: Slots = { ...baseSlots, dateFrom: "2026-09-25", budgetTier: "low" as const };
    const cheap = product({ productId: 1, price: 150 });
    const pricier = product({ productId: 2, price: 400 });
    const result = classify(slots, [pricier, cheap], [], true);
    expect(result?.candidate.productId).toBe("1");
    expect(result?.category).toBe("exact");
    expect(result?.compromise).toBeNull();
  });

  it("budgetTier 'mid' selects the median-priced candidate, distinct from 'low's cheapest pick (regression: 'nice, but not crazy expensive' was misread as 'cheapest')", () => {
    const slots: Slots = { ...baseSlots, dateFrom: "2026-09-25", budgetTier: "mid" as const };
    const cheap = product({ productId: 1, price: 100 });
    const pricey = product({ productId: 2, price: 900 });
    const mid = product({ productId: 3, price: 300 });
    const result = classify(slots, [pricey, cheap, mid], [], true);
    expect(result?.candidate.productId).toBe("3");
    expect(result?.category).toBe("exact");
    expect(result?.compromise).toBeNull();
  });

  it("budgetTier 'high' keeps the default (top-ranked) selection and is never flagged as a budget compromise", () => {
    const slots: Slots = { ...baseSlots, dateFrom: "2026-09-25", budgetTier: "high" as const };
    const topRanked = product({ productId: 1, price: 900 });
    const cheaper = product({ productId: 2, price: 150 });
    const result = classify(slots, [topRanked, cheaper], [], true);
    expect(result?.candidate.productId).toBe("1"); // stays top-ranked, not forced cheapest
    expect(result?.category).toBe("exact");
    expect(result?.compromise).toBeNull();
  });

  it("offers a date within the preferred month for date_unspecified, not the range's own start (regression: 'three days off in June' was offered a December date)", () => {
    const slots: Slots = { ...baseSlots, budgetTier: "low" as const, preferredMonth: 6 }; // no dateFrom
    const result = classify(slots, [product({ price: 200, minDate: "2026-01-01", maxDate: "2026-12-31" })], [], true);
    expect(result?.category).toBe("compromise");
    expect(result?.compromise).toEqual({ kind: "date_unspecified", requested: "", offered: "2026-06-01" });
  });

  it("reorders candidates so one with availability in the preferred month outranks a top-ranked one without it", () => {
    const slots: Slots = { ...baseSlots, budget: 1000, preferredMonth: 6 }; // no dateFrom, generous budget
    const noJune = product({ productId: 1, price: 300, minDate: "2026-01-01", maxDate: "2026-03-01" });
    const hasJune = product({ productId: 2, price: 300, minDate: "2026-05-01", maxDate: "2026-07-01" });
    const result = classify(slots, [noJune, hasJune], [], true);
    expect(result?.candidate.productId).toBe("2");
  });

  it("a real numeric budget always overrides budgetTier-driven cheapest-selection", () => {
    const slots: Slots = { ...baseSlots, dateFrom: "2026-09-25", budget: 1000 };
    const topRanked = product({ productId: 1, price: 900 });
    const cheaper = product({ productId: 2, price: 150 });
    const result = classify(slots, [topRanked, cheaper], [], true);
    expect(result?.candidate.productId).toBe("1");
    expect(result?.category).toBe("exact");
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
      "staging.weebora.com": [padelInWeebora], // matches FALLBACK_BRAND, matcher.ts
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
    const hofj = fakeHofjClient({ "terrarossa.com": [], "staging.weebora.com": [product({ productId: 9 })] });
    const { candidates } = await searchCandidates(hofj, { ...baseSlots, sport: "tennis" });
    expect(candidates).toHaveLength(0);
  });
});
