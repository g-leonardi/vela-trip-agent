export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  CONVERSATION: DurableObjectNamespace<import("./conversation").ConversationDO>;
  HOFJ_BASE_URL: string;
  HOFJ_BRAND: string;
  HOFJ_LOCALE: string;
  HOFJ_API_KEY: string;
  ANTHROPIC_API_KEY?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
}

/** What we've gathered from the traveller so far. Only sport/city are hard
 * requirements to run a search; the rest sharpen the match. */
export interface Slots {
  sport: "tennis" | "padel" | null;
  city: string | null;
  dateFrom: string | null; // YYYY-MM-DD, requested start
  dateTo: string | null; // YYYY-MM-DD, requested end (optional, inferred from product duration if absent)
  budget: number | null; // EUR, total for the trip
  /** Party size. Unlike city/date, this is never inferred or defaulted —
   * the traveller must state it explicitly, same as budget. See
   * ARCHITECTURE.md: precision policy decided 2026-09-15. */
  adults: number | null;
  preferences: string | null; // free text: "maestro", "principiante", "vista mare", ...
}

export const EMPTY_SLOTS: Slots = {
  sport: null,
  city: null,
  dateFrom: null,
  dateTo: null,
  budget: null,
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
}

export interface ProposalContext {
  candidate: Candidate;
  category: ConfidenceCategory;
  /** Set when category === "compromise": what exactly doesn't match.
   * "date_unspecified" is distinct from "date": the traveller never gave a
   * specific day at all (e.g. "un weekend a novembre") rather than giving
   * one that didn't fit the candidate's window — different enough to
   * phrase differently ("ti propongo il primo slot libero" vs "non riesco
   * al giorno X, riesco al Y"). `requested` is empty for that case. */
  compromise:
    | { kind: "price" | "date" | "date_unspecified" | "location_unspecified"; requested: string; offered: string }
    | null;
}

export interface ChatMessage {
  role: "traveller" | "agent";
  text: string;
  at: number;
}

export interface ConversationState {
  stage: Stage;
  slots: Slots;
  traveller: TravellerInfo;
  messages: ChatMessage[];
  proposal: ProposalContext | null;
  rejectedProductIds: string[];
  itineraryId: string | null;
  totalPrice: { amount: string; currency: string } | null;
  reservationCode: string | null;
  failureReason: string | null;
  /** Consecutive turns spent stuck in "collecting" without resolving every
   * required slot. Only city ever gets bypassed once this crosses a
   * threshold (see conversation.ts) — budget and party size are never
   * silently skipped, that line was drawn explicitly and stays hard. */
  collectingAttempts: number;
}
