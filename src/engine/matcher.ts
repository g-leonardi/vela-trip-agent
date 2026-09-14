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
  }

  return { candidate, category, compromise };
}

/** Builds the HOFJ search keyword from the slots we have. Free-text
 * `keyword` matches across title/category/destination/venue server-side —
 * more forgiving than requiring an exact destination slug from the
 * traveller's own words. */
function buildKeyword(slots: Slots): string {
  return [slots.city, slots.sport].filter(Boolean).join(" ");
}

const FALLBACK_BRAND = "weebora.com";

/** Resolves slots to a ranked candidate list. Terrarossa is the tennis/padel
 * brand of record; when the traveller asked for padel specifically and
 * Terrarossa comes up empty, we also check Weebora, which carries its own
 * padel inventory (verified 2026-09-14, see ARCHITECTURE.md). */
export async function searchCandidates(hofj: HofjClient, slots: Slots): Promise<SearchProduct[]> {
  // Date is deliberately NOT passed as a hard filter: a near-miss product
  // (available in a different week) is exactly the "compromise" case the
  // dialogue should be able to offer, not silently drop. classify() does
  // the date comparison itself once we have the ranked candidates.
  const keyword = buildKeyword(slots);
  const primary = await hofj.search({ keyword: keyword || undefined, topN: 5 });
  if (primary.data.products.length > 0) return primary.data.products;

  if (slots.sport === "padel") {
    const fallback = await hofj.search({ keyword: keyword || undefined, topN: 5, brand: FALLBACK_BRAND });
    return fallback.data.products;
  }

  return [];
}
