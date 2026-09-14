import type { HofjClient, SearchProduct } from "../hofj/client";
import type { Candidate, ConfidenceCategory, ProposalContext, Slots } from "../types";

/** Budget beyond which we stop calling it a "compromise" and ask a
 * clarifying question instead of proposing an unreasonably priced trip. */
const BUDGET_COMPROMISE_CEILING = 2.0;
const DATE_COMPROMISE_WINDOW_DAYS = 45;

function toCandidate(p: SearchProduct): Candidate {
  return {
    productId: String(p.productId),
    title: p.title,
    venue: p.primaryVenue ?? p.primaryDestination,
    city: p.primaryDestination,
    country: p.country,
    price: p.price,
    currency: p.currency,
    minDate: p.minDate,
    maxDate: p.maxDate,
    durationDays: p.defaultDurationInDays,
  };
}

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

/** Deterministic, auditable match classification — no invented numeric
 * scores. Business logic lives here so it can be unit-tested without the
 * AI binding; the AI's job is only to phrase the result (see engine/ai.ts). */
export function classify(slots: Slots, candidates: SearchProduct[], rejectedProductIds: string[]): ProposalContext | null {
  const pool = candidates.filter((c) => !rejectedProductIds.includes(String(c.productId)));
  if (pool.length === 0) return null;

  const best = pool[0]!;
  const candidate = toCandidate(best);

  let category: ConfidenceCategory = "exact";
  let compromise: ProposalContext["compromise"] = null;

  if (slots.budget !== null) {
    if (candidate.price > slots.budget * BUDGET_COMPROMISE_CEILING) {
      return null; // too far off to call it a reasonable proposal
    }
    if (candidate.price > slots.budget) {
      category = "compromise";
      compromise = {
        kind: "price",
        requested: `${slots.budget}€`,
        offered: `${candidate.price}${candidate.currency === "EUR" ? "€" : " " + candidate.currency}`,
      };
    }
  }

  if (slots.dateFrom !== null) {
    const inWindow = slots.dateFrom >= candidate.minDate && slots.dateFrom <= candidate.maxDate;
    if (!inWindow) {
      const nearest = slots.dateFrom < candidate.minDate ? candidate.minDate : candidate.maxDate;
      if (daysBetween(slots.dateFrom, nearest) > DATE_COMPROMISE_WINDOW_DAYS) {
        return null; // nearest availability too far from what was asked
      }
      // Price compromise (if any) stays the more salient one to mention;
      // otherwise lead with the date compromise.
      if (category !== "compromise") {
        category = "compromise";
        compromise = { kind: "date", requested: slots.dateFrom, offered: nearest };
      }
    }
  } else {
    // No date at all is not the same as a wrong date: a vague ask ("un
    // weekend a novembre", or simply nothing yet) shouldn't block a
    // proposal the way "collecting" used to (see ARCHITECTURE.md — live
    // regression where the dialogue just re-asked "when?" forever instead
    // of ever suggesting something). Offer the candidate's own earliest
    // availability as the concrete date, framed as a compromise so it
    // still gets an explicit confirmation rather than being booked
    // silently on the traveller's behalf.
    if (category !== "compromise") {
      category = "compromise";
      compromise = { kind: "date_unspecified", requested: "", offered: candidate.minDate };
    }
  }

  return { candidate, category, compromise };
}

/** Builds the HOFJ search keyword from the slots we have. Free-text
 * `keyword` matches across title/category/destination/venue server-side —
 * more forgiving than requiring an exact destination slug from the
 * traveller's own words. `withPreferences` folds in free-text asks like
 * "bravo insegnante" or "principianti" — verified live that HOFJ's typed
 * filters (goal/style/bestForLevel, present on product records) are
 * silently ignored as query params on this endpoint, so keyword is the
 * only real lever. That's also exactly why it's optional: extra terms
 * can just as easily zero out real matches as sharpen them (free-text
 * matching, not semantic), so callers try with it first and fall back
 * without. */
function buildKeyword(slots: Slots, withPreferences: boolean): string {
  const parts = [slots.city, slots.sport, withPreferences ? slots.preferences : null];
  return parts.filter(Boolean).join(" ");
}

// A handful of IT/EN city-name pairs, since the catalog is in one locale
// (see HOFJ_LOCALE) but travellers say city names in their own language.
const CITY_SYNONYMS: Record<string, string[]> = {
  roma: ["rome"],
  milano: ["milan"],
  venezia: ["venice"],
  firenze: ["florence"],
  napoli: ["naples"],
  torino: ["turin"],
};

function cityMatches(requested: string, product: SearchProduct): boolean {
  const req = requested.trim().toLowerCase();
  const synonyms = [req, ...(CITY_SYNONYMS[req] ?? [])];
  const haystack = `${product.primaryDestination} ${product.title}`.toLowerCase();
  return synonyms.some((s) => haystack.includes(s));
}

/** The API's own ranking is popularity/relevance-weighted and can surface a
 * venue whose *slug* happens to contain the city name (verified live: a
 * "tennis-roma-fdm" venue in Forte dei Marmi outranked actual Rome products
 * for keyword "Roma tennis"). Unlike price/date, a wrong city isn't a
 * "compromise" we should silently propose — it's not what was asked at
 * all — so we drop non-matching candidates rather than just re-sort them;
 * if that empties the list, classify() correctly falls through to a
 * clarifying question instead of a plausible-looking wrong-city proposal. */
function filterToMatchingCity(slots: Slots, candidates: SearchProduct[]): SearchProduct[] {
  if (!slots.city) return candidates;
  const matching = candidates.filter((c) => cityMatches(slots.city!, c));
  return matching;
}

const FALLBACK_BRAND = "weebora.com";

/** Searches one brand, preferring a preferences-enriched keyword but
 * falling back to city+sport alone if that returns nothing after city
 * filtering — same "try the sharper query, degrade gracefully" shape as
 * the cross-brand padel fallback below. */
async function searchOneBrand(hofj: HofjClient, slots: Slots, brand?: string): Promise<SearchProduct[]> {
  if (slots.preferences) {
    const withPrefs = await hofj.search({ keyword: buildKeyword(slots, true), topN: 15, brand });
    const matched = filterToMatchingCity(slots, withPrefs.data.products);
    if (matched.length > 0) return matched;
  }
  const plain = await hofj.search({ keyword: buildKeyword(slots, false) || undefined, topN: 15, brand });
  return filterToMatchingCity(slots, plain.data.products);
}

/** Resolves slots to a ranked candidate list. Terrarossa is the tennis/padel
 * brand of record; when the traveller asked for padel specifically and
 * Terrarossa comes up empty, we also check Weebora, which carries its own
 * padel inventory (verified 2026-09-14, see ARCHITECTURE.md). */
export async function searchCandidates(hofj: HofjClient, slots: Slots): Promise<SearchProduct[]> {
  // Date is deliberately NOT passed as a hard filter: a near-miss product
  // (available in a different week) is exactly the "compromise" case the
  // dialogue should be able to offer, not silently drop. classify() does
  // the date comparison itself once we have the ranked candidates.
  const primaryMatched = await searchOneBrand(hofj, slots);
  if (primaryMatched.length > 0) return primaryMatched;

  if (slots.sport === "padel") {
    const fallbackMatched = await searchOneBrand(hofj, slots, FALLBACK_BRAND);
    if (fallbackMatched.length > 0) return fallbackMatched;
  }

  return [];
}
