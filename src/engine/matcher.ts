import type { HofjClient, SearchProduct } from "../hofj/client";
import type { Candidate, ConfidenceCategory, ProposalContext, Slots } from "../types";

/** Budget beyond which we stop calling it a "compromise" and ask a
 * clarifying question instead of proposing an unreasonably priced trip. */
const BUDGET_COMPROMISE_CEILING = 2.0;
const DATE_COMPROMISE_WINDOW_DAYS = 45;

/** The HOFJ search response itself doesn't say which brand a product came
 * from (you query one brand at a time) — tagged on locally right after
 * each search call (see rawSearchOneBrand) so it survives all the way
 * into the final Candidate and the booking pipeline needs it (see
 * Candidate.brand's doc, types.ts, for why this matters). */
type BrandedProduct = SearchProduct & { brand: string };

function toCandidate(p: BrandedProduct): Candidate {
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
    brand: p.brand,
  };
}

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** First date within [minDate, maxDate] that falls in the given month
 * (1-12), checking every year the range spans — a product's availability
 * window can cross a year boundary. Null if the month never overlaps the
 * range at all. Used so a preferred month actually influences which date
 * gets offered, instead of always defaulting to the range's own start
 * (regression: live "three days off in June" got offered a December date
 * because nothing looked at the month at all). */
function firstDateInMonth(minDate: string, maxDate: string, month: number): string | null {
  const start = new Date(`${minDate}T00:00:00Z`);
  const end = new Date(`${maxDate}T00:00:00Z`);
  for (let year = start.getUTCFullYear(); year <= end.getUTCFullYear(); year++) {
    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd = new Date(Date.UTC(year, month, 0)); // last day of that month
    const overlapStart = monthStart > start ? monthStart : start;
    const overlapEnd = monthEnd < end ? monthEnd : end;
    if (overlapStart <= overlapEnd) {
      return `${overlapStart.getUTCFullYear()}-${pad2(overlapStart.getUTCMonth() + 1)}-${pad2(overlapStart.getUTCDate())}`;
    }
  }
  return null;
}

function cityKeyOf(p: SearchProduct): string {
  return (p.primaryDestination || p.title).trim().toLowerCase();
}

/** When the traveller's city isn't pinned (`locationMatched` false — no
 * city given, or one given that matched nothing), the raw ranked pool can
 * mix many cities together with wildly uneven representation: a city with
 * more inventory can flood the pool with several listings while a
 * genuinely good alternative city has just one. Letting the selection
 * below run over that raw mix would let inventory volume, not an honest
 * per-city comparison, decide which city gets proposed — the opposite of
 * "reasoning over a shortlist of cities with real availability" (Giuseppe,
 * 2026-09-14). Reduce to one representative per city first — its own
 * cheapest listing, same "pick honestly, don't invent a score" logic used
 * everywhere else in this file — so the selection logic further down
 * genuinely compares cities against each other, each via its own best
 * offer, not whichever single product happened to rank first. Still
 * always resolves to exactly ONE final proposal — this never becomes a
 * list shown to the traveller, only an internal shortlist reasoned over
 * before picking. Order is preserved from `pool`'s own ranking (first
 * time each city is seen), so a real numeric budget/top-ranked selection
 * downstream still respects the API's relevance ranking at the city
 * level, just not at the level of possibly-inferior duplicate listings. */
function shortlistByCity<T extends SearchProduct>(pool: T[]): T[] {
  const byCity = new Map<string, T>();
  for (const p of pool) {
    const key = cityKeyOf(p);
    const current = byCity.get(key);
    if (!current || p.price < current.price) byCity.set(key, p);
  }
  return [...byCity.values()];
}

/** Deterministic, auditable match classification — no invented numeric
 * scores. Business logic lives here so it can be unit-tested without the
 * AI binding; the AI's job is only to phrase the result (see engine/ai.ts).
 * `locationMatched` (from searchCandidates) is false when the proposal is
 * in a city the traveller didn't specifically ask for — either because
 * they never gave one, or gave one nothing matched — which always gets
 * flagged as a compromise, same policy as an unspecified date: the agent
 * may decide, but never silently. */
export function classify(
  slots: Slots,
  candidates: BrandedProduct[],
  rejectedProductIds: string[],
  locationMatched: boolean,
): ProposalContext | null {
  let pool = candidates.filter((c) => !rejectedProductIds.includes(String(c.productId)));
  if (pool.length === 0) return null;

  // City not pinned: reason over a per-city shortlist (see
  // shortlistByCity's doc) instead of the raw, unevenly-distributed pool.
  if (!locationMatched) {
    pool = shortlistByCity(pool);
  }

  // A preferred month (from a vague date like "in June" that didn't
  // resolve to an exact day) doesn't hard-filter — a near-miss candidate
  // is still worth a compromise, same reasoning as an exact date mismatch
  // below — but it should outrank candidates with no relation to that
  // month at all, so classify() doesn't pick something available only in
  // a completely different season.
  if (slots.dateFrom === null && slots.preferredMonth !== null) {
    const month = slots.preferredMonth;
    const matching = pool.filter((c) => firstDateInMonth(c.minDate, c.maxDate, month) !== null);
    if (matching.length > 0) pool = [...matching, ...pool.filter((c) => !matching.includes(c))];
  }

  // Which candidate to propose: normally the API's own top-ranked
  // (relevance/combinedScore) result. When the traveller wants cheap —
  // either because they never gave a budget at all, or said so
  // qualitatively ("economico") — relevance ranking isn't the right
  // tiebreaker for something being chosen FOR them; pick the cheapest in
  // the pool instead, so any disclosed compromise is honest about what
  // "cheapest" actually means rather than an arbitrary ranking artifact.
  // "mid" ("carino ma non troppo caro") isn't the cheapest OR an
  // unconstrained pick either — the median price in the pool is a
  // defensible reading of "reasonable, not the bargain bin, not the
  // splurge", better than either extreme.
  const wantsCheapest = slots.budget === null && (slots.budgetTier === null || slots.budgetTier === "low");
  const wantsMid = slots.budget === null && slots.budgetTier === "mid";
  const best = wantsCheapest
    ? pool.reduce((min, c) => (c.price < min.price ? c : min), pool[0]!)
    : wantsMid
      ? [...pool].sort((a, b) => a.price - b.price)[Math.floor(pool.length / 2)]!
      : pool[0]!;
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
  } else if (slots.budgetTier === null) {
    // Never mentioned budget at all, not even qualitatively — same
    // discipline as date_unspecified: propose the cheapest relevant
    // option, but always as a disclosed compromise, never silently.
    category = "compromise";
    compromise = {
      kind: "budget_unspecified",
      requested: "",
      offered: `${candidate.price}${candidate.currency === "EUR" ? "€" : " " + candidate.currency}`,
    };
    // budgetTier "low"/"mid"/"high" with no numeric budget: an explicit
    // qualitative answer was given and is satisfied by construction
    // (selection above already picked cheapest/median/default
    // accordingly) — no compromise needed for the budget dimension itself.
  }

  if (!locationMatched && category !== "compromise") {
    category = "compromise";
    compromise = { kind: "location_unspecified", requested: slots.city ?? "", offered: candidate.city };
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
    // of ever suggesting something). Offer a concrete date, framed as a
    // compromise so it still gets an explicit confirmation rather than
    // being booked silently. If a month was hinted at ("in June") and the
    // candidate has any availability that month, offer a date within it
    // instead of blindly defaulting to the range's own start — verified
    // live this mattered: "three days off in June" was getting offered a
    // December date with nothing to say it wasn't what was asked for.
    const inPreferredMonth =
      slots.preferredMonth !== null ? firstDateInMonth(candidate.minDate, candidate.maxDate, slots.preferredMonth) : null;
    if (category !== "compromise") {
      category = "compromise";
      compromise = { kind: "date_unspecified", requested: "", offered: inPreferredMonth ?? candidate.minDate };
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
function filterToMatchingCity<T extends SearchProduct>(slots: Slots, candidates: T[]): T[] {
  if (!slots.city) return candidates;
  const matching = candidates.filter((c) => cityMatches(slots.city!, c));
  return matching;
}

const FALLBACK_BRAND = "weebora.com";

/** Raw search for one brand: tries a preferences-enriched keyword first,
 * falls back to city+sport alone if that returns nothing. No city
 * filtering here — that decision belongs to the caller, which needs to
 * know whether filtering actually found something or not. Every result is
 * tagged with the brand it was actually searched under — required
 * downstream by the booking pipeline (see Candidate.brand's doc,
 * types.ts) — `brand` is always explicit here, never left to the
 * client's own default, precisely so this tag is always right. */
async function rawSearchOneBrand(hofj: HofjClient, slots: Slots, brand: string): Promise<BrandedProduct[]> {
  const tag = (products: SearchProduct[]): BrandedProduct[] => products.map((p) => ({ ...p, brand }));
  if (slots.preferences) {
    const withPrefs = await hofj.search({ keyword: buildKeyword(slots, true), topN: 15, brand });
    if (withPrefs.data.products.length > 0) return tag(withPrefs.data.products);
  }
  const plain = await hofj.search({ keyword: buildKeyword(slots, false) || undefined, topN: 15, brand });
  return tag(plain.data.products);
}

export interface SearchResult {
  candidates: BrandedProduct[];
  /** False whenever the proposal is going to be in a city the traveller
   * didn't specifically confirm — no city given at all, or one given that
   * matched nothing. classify() turns this into an explicit compromise
   * rather than a silent substitution. */
  locationMatched: boolean;
}

/** Resolves slots to a ranked candidate list. Terrarossa is the tennis/padel
 * brand of record; when the traveller asked for padel specifically and
 * Terrarossa comes up empty, we also check Weebora, which carries its own
 * padel inventory (verified 2026-09-14, see ARCHITECTURE.md).
 *
 * City, like date, can be genuinely vague ("Nord Europa", or never given —
 * verified live with a real user request for "il miglior insegnante...
 * in Nord Europa" with no specific city at all). A city that's given but
 * matches nothing is treated the same as no city: rather than returning
 * empty and forcing classify() into "no match, ask a clarifying question"
 * — which is what a *literal* wrong-city venue outranking the right one
 * warranted (see the Forte dei Marmi case, still filtered out above) — we
 * fall back to the best unfiltered results and let classify() flag it as
 * a disclosed compromise, consistent with the policy that location may be
 * decided by the agent but never silently. */
export async function searchCandidates(hofj: HofjClient, slots: Slots): Promise<SearchResult> {
  // Date is deliberately NOT passed as a hard filter: a near-miss product
  // (available in a different week) is exactly the "compromise" case the
  // dialogue should be able to offer, not silently drop. classify() does
  // the date comparison itself once we have the ranked candidates.
  const primaryRaw = await rawSearchOneBrand(hofj, slots, hofj.brand);
  if (slots.city) {
    const filtered = filterToMatchingCity(slots, primaryRaw);
    if (filtered.length > 0) return { candidates: filtered, locationMatched: true };
  }

  if (slots.sport === "padel") {
    const fallbackRaw = await rawSearchOneBrand(hofj, slots, FALLBACK_BRAND);
    if (slots.city) {
      const filtered = filterToMatchingCity(slots, fallbackRaw);
      if (filtered.length > 0) return { candidates: filtered, locationMatched: true };
    }
    const best = fallbackRaw.length > 0 ? fallbackRaw : primaryRaw;
    return { candidates: best, locationMatched: false };
  }

  return { candidates: primaryRaw, locationMatched: false };
}
