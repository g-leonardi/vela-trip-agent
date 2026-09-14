export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  CONVERSATION: DurableObjectNamespace<import("./conversation").ConversationDO>;
  USER_PROFILE: DurableObjectNamespace<import("./userProfile").UserProfileDO>;
  FOLLOWUP: DurableObjectNamespace<import("./followUp").FollowUpDO>;
  HOFJ_BASE_URL: string;
  HOFJ_BRAND: string;
  HOFJ_LOCALE: string;
  HOFJ_API_KEY: string;
  ANTHROPIC_API_KEY?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  /** Restricted Stripe secret key (test mode), confirmed by Vela
   * (2026-09-15) as the sanctioned way to create real PaymentIntents
   * directly against HOFJ's own Stripe account — see attemptPayment() in
   * conversation.ts and ARCHITECTURE.md. Server-side only, never sent to
   * the frontend. */
  STRIPE_SECRET_KEY?: string;
}

/** What we've gathered from the traveller so far. Only sport/city are hard
 * requirements to run a search; the rest sharpen the match. */
export interface Slots {
  sport: "tennis" | "padel" | null;
  city: string | null;
  dateFrom: string | null; // YYYY-MM-DD, requested start
  dateTo: string | null; // YYYY-MM-DD, requested end (optional, inferred from product duration if absent)
  /** A date phrase heard but not yet resolved to a specific day (e.g. "nei
   * prossimi tre mesi") — persisted across turns so the signal survives
   * even when dateFrom isn't the slot being asked about *this* turn (e.g.
   * the traveller volunteers a vague date while city is still missing).
   * Checked whenever dateFrom next becomes the missing slot, not only in
   * the turn it was said. Cleared once a real dateFrom is resolved. */
  dateFromVague: string | null;
  /** A month the traveller hinted at ("in June", "a giugno") without a
   * specific day — extracted deterministically (see engine/dates.ts,
   * same reasoning as dateFromVague: don't trust the model with calendar
   * logic). Used to bias candidate selection and the date_unspecified
   * compromise toward that month instead of blindly offering the
   * earliest availability regardless of when the traveller actually
   * wanted to go (regression: live test offered December for a "three
   * days off in June" request). 1-12, or null. */
  preferredMonth: number | null;
  budget: number | null; // EUR, total for the trip
  /** A qualitative budget answer ("economico"/"il top"/"carino ma non
   * troppo caro") that doesn't map to a number — a real answer, not a
   * missing one, so it must not be treated as budget_unspecified. "low"
   * biases selection toward the cheapest relevant candidate; "mid" picks
   * something reasonably priced (neither cheapest nor priciest in the
   * pool); "high" means no ceiling, keep the default (most relevant)
   * selection. Mutually exclusive with `budget` in practice: interpret()
   * sets one or the other. */
  budgetTier: "low" | "mid" | "high" | null;
  /** Party size. Unlike city/date/budget, this is never inferred or
   * defaulted — the traveller must state it explicitly. See
   * ARCHITECTURE.md: precision policy decided 2026-09-15. */
  adults: number | null;
  preferences: string | null; // free text: "maestro", "principiante", "vista mare", ...
}

export const EMPTY_SLOTS: Slots = {
  sport: null,
  city: null,
  dateFrom: null,
  dateTo: null,
  dateFromVague: null,
  preferredMonth: null,
  budget: null,
  budgetTier: null,
  adults: null,
  preferences: null,
};

/** Traveller identity, collected only once we're about to open a real cart. */
export interface TravellerInfo {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  postalCode: string | null;
  countryCode: string | null;
}

export const EMPTY_TRAVELLER: TravellerInfo = {
  firstName: null,
  lastName: null,
  email: null,
  phone: null,
  city: null,
  postalCode: null,
  countryCode: null,
};

/** A real, persistent per-user profile — replaces the earlier
 * DEMO_TRAVELLER stand-in (2026-09-14 ~23:30, Giuseppe: "il mio obiettivo
 * è semplicemente eliminare il DEMO_TRAVELLER a favore di qualcosa di
 * duraturo"). Durable, but deliberately not real auth: kept in its own
 * Durable Object (see userProfile.ts), addressed by a client-generated id
 * persisted in the browser's localStorage — the same pattern already used
 * for a conversation's own sessionId, just one level up. This does NOT
 * solve "recognize the same person on a different device" (that's the
 * real identity/login problem, still explicitly out of scope — see
 * ARCHITECTURE.md), it only avoids re-asking the same questions every
 * time in the same browser.
 *
 * `householdSize` and `economicTier` are DEFAULTS, never a silent
 * decision: conversation.ts surfaces them as a suggestion the agent still
 * asks the traveller to confirm for that specific trip ("di solito siete
 * in tre, ancora così?") — the same precision policy that already governs
 * `adults`/`budget` in Slots stays intact, a saved profile doesn't get to
 * quietly override it. */
export interface UserProfile {
  firstName: string | null;
  email: string | null;
  /** Città di residenza, non la destinazione del viaggio. */
  city: string | null;
  preferredSport: "tennis" | "padel" | null;
  /** Numero di persone del nucleo familiare — usato come ipotesi di
   * default per `adults` in un nuovo viaggio, sempre da confermare. */
  householdSize: number | null;
  /** Profilo economico dichiarato dall'utente una volta, con nomi
   * volutamente accattivanti invece dei semplici "low/mid/high" interni:
   * "smart" (fino a 500€ a viaggio), "pro" (600-1500€), "luxury" (oltre
   * 1500€). Mappato a `Slots.budgetTier` come default suggerito, non
   * vincolante, per un nuovo viaggio. */
  economicTier: "smart" | "pro" | "luxury" | null;
}

export const EMPTY_USER_PROFILE: UserProfile = {
  firstName: null,
  email: null,
  city: null,
  preferredSport: null,
  householdSize: null,
  economicTier: null,
};

export const REQUIRED_PROFILE_FIELDS: (keyof UserProfile)[] = [
  "firstName",
  "email",
  "city",
  "preferredSport",
  "householdSize",
  "economicTier",
];

export function isProfileComplete(profile: UserProfile): boolean {
  return REQUIRED_PROFILE_FIELDS.every((f) => profile[f] !== null);
}

export type Stage =
  | "collecting" // slot-filling the trip intent
  | "proposing" // we have a candidate, waiting for yes/no
  | "collecting_traveller" // slot-filling name/email/phone before opening the cart
  | "confirming" // silent re-verification + real cart just before payment
  | "paying" // waiting on Stripe payment confirmation from the frontend
  | "booked" // done, reservation code in hand
  | "failed"; // dead end (non-retryable API error), explained to the traveller

export type ConfidenceCategory = "exact" | "compromise" | "none";

/** A candidate trip, already resolved from the HOFJ catalog to the fields
 * the dialogue and the checkout pipeline both need. */
export interface Candidate {
  productId: string;
  title: string;
  venue: string;
  city: string;
  country: string;
  price: number;
  currency: string;
  minDate: string;
  maxDate: string;
  durationDays: number;
  /** Which HOFJ brand this product was actually found under (e.g.
   * "terrarossa.com" or "weebora.com" — see engine/matcher.ts's padel
   * fallback). Every downstream call that references this itinerary
   * (createItinerary, getItinerary, putCustomer, putPax, payment,
   * confirmBooking) MUST use this same brand — the API scopes products
   * and itineraries per brand, and a mismatch 404s. Regression found live
   * 2026-09-14: every Weebora-sourced padel candidate failed at booking
   * time with a generic 502/NOT_FOUND_ERROR because the booking pipeline
   * silently defaulted to the client's own primary brand instead of the
   * brand the product was actually searched under — previously
   * misdiagnosed as "product not bookable, an upstream data problem". */
  brand: string;
}

export interface ProposalContext {
  candidate: Candidate;
  category: ConfidenceCategory;
  /** Set when category === "compromise": what exactly doesn't match.
   * "date_unspecified"/"budget_unspecified" are distinct from "date"/
   * "price": the traveller never gave one at all (e.g. "un weekend a
   * novembre", or nothing about budget ever) rather than giving one that
   * didn't fit — different enough to phrase differently ("ti propongo il
   * primo slot libero"/"ti propongo il più economico" vs "non riesco a X,
   * riesco a Y"). `requested` is empty for the "_unspecified" cases. */
  compromise:
    | {
        kind: "price" | "date" | "date_unspecified" | "location_unspecified" | "budget_unspecified";
        requested: string;
        offered: string;
      }
    | null;
}

export interface ChatMessage {
  role: "traveller" | "agent";
  text: string;
  at: number;
}

export interface ConversationState {
  stage: Stage;
  /** Detected once the traveller's language is clear (a human name like
   * "italiano"/"English"/"español", not necessarily an ISO code — easier
   * for the model to both produce and consume) and sticky after that, so
   * every reply — not just the first — matches the language the
   * traveller is actually using. Null until detected; defaults to
   * Italian in engine/ai.ts until then. */
  language: string | null;
  slots: Slots;
  traveller: TravellerInfo;
  messages: ChatMessage[];
  proposal: ProposalContext | null;
  rejectedProductIds: string[];
  itineraryId: string | null;
  /** The HOFJ brand the current/last real itinerary was opened under (see
   * Candidate.brand) — persisted separately from `proposal` so a retry on
   * a later turn (attemptPayment, confirmBookingNow) still targets the
   * right brand even if `proposal` itself has since changed or cleared. */
  brand: string | null;
  /** The Stripe PaymentIntent id/status from our own sanctioned-bypass
   * payment (see stripe/client.ts), forwarded to POST /v1/bookings as
   * `paymentIntentId`/`paymentStatus` — documented, optional fields the
   * brand site needs to attach a real payment to the booking (see
   * confirmBooking's doc, hofj/client.ts). Persisted so a "riprova" on a
   * later turn re-sends the SAME already-confirmed payment instead of
   * charging again. */
  paymentIntentId: string | null;
  paymentStatus: string | null;
  totalPrice: { amount: string; currency: string } | null;
  reservationCode: string | null;
  failureReason: string | null;
  /** How many times each has been asked about without resolving it.
   * Tracked per-slot (not a single shared counter) so that, e.g., asking
   * twice about sport doesn't count toward city's own patience budget.
   * Only city and budget ever get bypassed this way (see conversation.ts)
   * — party size is never silently skipped, that line stays hard. */
  cityAskAttempts: number;
  budgetAskAttempts: number;
  /** Seeded once, from the traveller's saved UserProfile, the moment this
   * conversation's very first message is handled (see conversation.ts) —
   * never touched again after that, and never written straight into
   * `slots.adults`/`slots.budgetTier` themselves. Only used to phrase the
   * ask_slot question for those two fields as a confirmable suggestion
   * ("di solito siete in 3, ancora così?") instead of a blind one — the
   * precision policy that adults/budget are never silently decided stays
   * intact even with a saved profile on file. Null when there was no
   * profile yet, or the profile never gave that field. */
  householdSizeHint: number | null;
  economicTierHint: "smart" | "pro" | "luxury" | null;
  /** Same idea as the two above, for the one slot that isn't under the
   * hard adults/budget precision policy — still never silently applied,
   * just makes the "che sport preferisci?" question a confirmable
   * suggestion instead of a blind one. */
  preferredSportHint: "tennis" | "padel" | null;
  /** The current proposal's product-level marketing description (see
   * HofjClient.getProduct), fetched lazily and cached the first time the
   * traveller asks an ad-hoc question about it ("cosa include il
   * pacchetto?") — not fetched up front for every proposal, since most
   * proposals never get a follow-up question and a product-detail call
   * for each one would be pure waste. Reset to null whenever a NEW
   * proposal replaces the current one, so a later question never answers
   * from a stale, different candidate's description. */
  productDescription: string | null;
  /** How many times "riprova" has been tried specifically for a booking
   * confirmation that already had a real, successful payment behind it —
   * capped (see BOOKING_RETRY_LIMIT, conversation.ts) so the traveller
   * isn't strung along indefinitely on an upstream fault that has
   * already proven not to be transient (verified live 2026-09-15: the
   * same itinerary's checkout.status was still "BookingInitiated" long
   * after the original attempt, not an eventual-consistency delay). */
  bookingRetryCount: number;
  /** Whether this conversation's stuck-booking details (real payment
   * succeeded, booking never confirmed) have already been written to
   * FollowUpDO — set once so repeated retries don't log duplicate
   * entries for the same conversation. */
  followUpLogged: boolean;
}

/** A durably logged real payment whose booking never got a confirmed
 * status from HOFJ — see FollowUpDO (followUp.ts). This is what actually
 * backs the "lascia i tuoi dati, ti ricontatto" promise in
 * booking_unverified's message: without it, that line was just words,
 * nothing captured the traveller's details anywhere a human could act
 * on them once the conversation was abandoned. */
export interface FollowUpEntry {
  itineraryId: string;
  brand: string;
  paymentIntentId: string;
  amount: string;
  currency: string;
  traveller: { firstName: string | null; lastName: string | null; email: string | null; phone: string | null };
  failureReason: string;
  recordedAt: number;
}
