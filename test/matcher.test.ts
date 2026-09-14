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
    expect(classify(baseSlots, [], [])).toBeNull();
  });

  it("classifies as exact when price and date both satisfy the request", () => {
    const slots: Slots = { ...baseSlots, budget: 400, dateFrom: "2026-09-25" };
    const result = classify(slots, [product({ price: 365 })], []);
    expect(result?.category).toBe("exact");
    expect(result?.compromise).toBeNull();
  });

  it("classifies as compromise when price exceeds budget but within tolerance", () => {
    const slots: Slots = { ...baseSlots, budget: 300 };
    const result = classify(slots, [product({ price: 465 })], []);
    expect(result?.category).toBe("compromise");
    expect(result?.compromise?.kind).toBe("price");
    expect(result?.compromise?.requested).toBe("300€");
    expect(result?.compromise?.offered).toBe("465€");
  });

  it("returns null (ask a clarifying question) when price is unreasonably far over budget", () => {
    const slots: Slots = { ...baseSlots, budget: 100 };
    const result = classify(slots, [product({ price: 465 })], []);
    expect(result).toBeNull();
  });

  it("classifies as compromise when the requested date is outside the product window but close", () => {
    const slots: Slots = { ...baseSlots, dateFrom: "2026-08-20" }; // 12 days before minDate
    const result = classify(slots, [product({ minDate: "2026-09-01", maxDate: "2026-12-01" })], []);
    expect(result?.category).toBe("compromise");
    expect(result?.compromise?.kind).toBe("date");
    expect(result?.compromise?.offered).toBe("2026-09-01");
  });

  it("returns null when the nearest available date is too far from what was requested", () => {
    const slots: Slots = { ...baseSlots, dateFrom: "2026-01-01" }; // months before minDate
    const result = classify(slots, [product({ minDate: "2026-09-01", maxDate: "2026-12-01" })], []);
    expect(result).toBeNull();
  });

  it("skips rejected products and proposes the next one", () => {
    const a = product({ productId: 1, price: 300 });
    const b = product({ productId: 2, price: 320 });
    const result = classify(baseSlots, [a, b], ["1"]);
    expect(result?.candidate.productId).toBe("2");
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
  it("filters out results whose city doesn't match what was requested", () => {
    const wrongCity = product({ primaryDestination: "forte-dei-marmi", primaryVenue: "tennis-roma-fdm" });
    const rightCity = product({ productId: 2, primaryDestination: "rome-copy", title: "Roma Tennis Experience" });
    const hofj = fakeHofjClient({ "terrarossa.com": [wrongCity, rightCity] });

    return searchCandidates(hofj, { ...baseSlots, city: "Roma" }).then((results) => {
      expect(results).toHaveLength(1);
      expect(results[0]!.productId).toBe(2);
    });
  });

  it("understands the roma/rome IT-EN synonym", () => {
    const rome = product({ primaryDestination: "rome", title: "Rome Tennis Getaway" });
    const hofj = fakeHofjClient({ "terrarossa.com": [rome] });
    return searchCandidates(hofj, { ...baseSlots, city: "Roma" }).then((results) => {
      expect(results).toHaveLength(1);
    });
  });

  it("falls back to Weebora for padel when Terrarossa has nothing matching", async () => {
    const padelInWeebora = product({ productId: 9, primaryDestination: "valencia", title: "Padel Clinic Valencia" });
    const hofj = fakeHofjClient({
      "terrarossa.com": [],
      "weebora.com": [padelInWeebora],
    });
    const results = await searchCandidates(hofj, { ...baseSlots, sport: "padel", city: "Valencia" });
    expect(results).toHaveLength(1);
    expect(results[0]!.productId).toBe(9);
  });

  it("does not fall back to Weebora for tennis", async () => {
    const hofj = fakeHofjClient({ "terrarossa.com": [], "weebora.com": [product({ productId: 9 })] });
    const results = await searchCandidates(hofj, { ...baseSlots, sport: "tennis" });
    expect(results).toHaveLength(0);
  });
});
