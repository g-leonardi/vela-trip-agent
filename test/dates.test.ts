import { describe, expect, it } from "vitest";
import { resolveDate } from "../src/engine/dates";

// Fixed "now" so tests don't depend on the day they're run.
const NOW = new Date("2026-09-14T10:00:00.000Z");

describe("resolveDate", () => {
  it("returns null for no input", () => {
    expect(resolveDate(null, NOW)).toBeNull();
  });

  it("passes through an already-ISO date", () => {
    expect(resolveDate("2026-12-25", NOW)).toBe("2026-12-25");
  });

  it("resolves 'oggi' / 'domani' / 'dopodomani'", () => {
    expect(resolveDate("oggi", NOW)).toBe("2026-09-14");
    expect(resolveDate("domani", NOW)).toBe("2026-09-15");
    expect(resolveDate("dopodomani", NOW)).toBe("2026-09-16");
  });

  it("resolves a day+month phrase to the current year when still in the future", () => {
    expect(resolveDate("il 25 settembre", NOW)).toBe("2026-09-25");
  });

  it("rolls over to next year when the day+month has already passed this year", () => {
    // "now" is 2026-09-14, so March 1st this year is in the past.
    expect(resolveDate("1 marzo", NOW)).toBe("2027-03-01");
  });

  it("never falls back to an epoch/placeholder year (regression: live Workers AI returned 1970)", () => {
    const resolved = resolveDate("il 25 settembre", NOW);
    expect(resolved).not.toMatch(/^19/);
  });

  it("resolves an explicit year when given", () => {
    expect(resolveDate("25 settembre 2028", NOW)).toBe("2028-09-25");
  });

  it("resolves 'tra N giorni' / 'tra N settimane'", () => {
    expect(resolveDate("tra 10 giorni", NOW)).toBe("2026-09-24");
    expect(resolveDate("tra 2 settimane", NOW)).toBe("2026-09-28");
  });

  it("resolves 'il prossimo weekend' to the next Saturday", () => {
    // NOW is 2026-09-14, a Monday.
    expect(resolveDate("il prossimo weekend", NOW)).toBe("2026-09-19");
  });

  it("returns null for unparseable free text rather than guessing", () => {
    expect(resolveDate("appena possibile", NOW)).toBeNull();
  });

  it("handles 'di' as a connector between day and month (regression: live user said \"il 9 di ottobre\" twice, both silently dropped)", () => {
    expect(resolveDate("il 9 di ottobre", NOW)).toBe("2026-10-09");
    expect(resolveDate("9 di ottobre", NOW)).toBe("2026-10-09");
  });

  it("resolves a slash-separated DD/MM/YYYY date, Italian convention not US (regression: live user typed \"9/10/2026\", silently dropped)", () => {
    expect(resolveDate("9/10/2026", NOW)).toBe("2026-10-09");
    expect(resolveDate("09-10-2026", NOW)).toBe("2026-10-09");
  });
});
