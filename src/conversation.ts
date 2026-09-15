import { DurableObject } from "cloudflare:workers";
import { HofjApiError, HofjClient, type PaxPayload } from "./hofj/client";
import { AiUnavailableError, interpret, say, type SayDirective } from "./engine/ai";
import { extractMonthHint, resolveDate } from "./engine/dates";
import { classify, searchCandidates } from "./engine/matcher";
import { confirmPaymentIntent, createPaymentIntent } from "./stripe/client";
import {
  EMPTY_SLOTS,
  EMPTY_TRAVELLER,
  type ConversationState,
  type Env,
  type Slots,
  type TravellerInfo,
  type UserProfile,
} from "./types";

const REQUIRED_TRIP_SLOTS: (keyof Pick<Slots, "sport" | "city" | "dateFrom" | "budget" | "adults">)[] = [
  "sport",
  "city",
  "dateFrom",
  "budget",
  "adults",
];

const REQUIRED_TRAVELLER_FIELDS: (keyof TravellerInfo)[] = ["firstName", "lastName", "email", "phone", "city"];

const PRICE_CHANGE_TOLERANCE = 0.01; // 1% — floating point / rounding noise only
const CITY_LOOP_BREAKER = 2; // consecutive stuck turns before city gets bypassed
const BUDGET_LOOP_BREAKER = 1; // ask once; if still unanswered next time, decide (cheapest) and disclose it
// Verified live 2026-09-15: the same stuck itinerary's checkout.status was
// still "BookingInitiated" long after the original attempt — not an
// eventual-consistency delay that a few more retries would fix. Capping
// this means "riprova" stops being a false promise once it's clearly a
// standing fault, not a blip.
const BOOKING_RETRY_LIMIT = 2;

function initialState(): ConversationState {
  return {
    stage: "collecting",
    language: null,
    slots: { ...EMPTY_SLOTS },
    // Starts empty — a real, persistent UserProfile (see types.ts,
    // userProfile.ts) is merged in by handleMessage() on this
    // conversation's very first turn, if one was passed in. Every field
    // here can still be overridden by the traveller stating it explicitly
    // at any point; a seeded profile is a default, never a lock.
    traveller: { ...EMPTY_TRAVELLER },
    messages: [],
    proposal: null,
    rejectedProductIds: [],
    itineraryId: null,
    brand: null,
    paymentIntentId: null,
    paymentStatus: null,
    totalPrice: null,
    reservationCode: null,
    failureReason: null,
    cityAskAttempts: 0,
    budgetAskAttempts: 0,
    householdSizeHint: null,
    economicTierHint: null,
    preferredSportHint: null,
    productDescription: null,
    bookingRetryCount: 0,
    followUpLogged: false,
  };
}

function mergeDefined<T extends object>(target: T, updates: Partial<T>): T {
  const out = { ...target };
  for (const [k, v] of Object.entries(updates)) {
    if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// Deliberately loose (not a full RFC 5322 check) — just enough to catch
// what actually broke a real booking live 2026-09-14: an email like
// "Peo Blues@it" (a space before the @, no real TLD) sailed straight
// through interpret() and only got rejected by HOFJ itself, deep inside
// openRealCartAndAttemptPayment, with no path back to fixing it (see
// that function's putCustomer call — a validation error there wasn't
// even catchable as a normal "collecting_traveller" retry). Catching it
// HERE instead — before it's ever accepted into state.traveller at all —
// means the existing "ask again" loop for a still-missing field just
// re-asks naturally, no special-case recovery flow needed.
const LOOSE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitizeTravellerUpdates(updates: Partial<TravellerInfo>): Partial<TravellerInfo> {
  if (updates.email && !LOOSE_EMAIL_RE.test(updates.email)) {
    return { ...updates, email: null };
  }
  return updates;
}

export interface HandleMessageResult {
  reply: string;
  state: ConversationState;
}

export class ConversationDO extends DurableObject<Env> {
  private hofj: HofjClient;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.hofj = new HofjClient(env);
  }

  private async loadState(): Promise<ConversationState> {
    const stored = await this.ctx.storage.get<ConversationState>("state");
    return stored ?? initialState();
  }

  private async saveState(state: ConversationState): Promise<void> {
    await this.ctx.storage.put("state", state);
  }

  /** Thin wrapper so every reply picks up the conversation's detected
   * language without threading state.language through every single call
   * site by hand — see language mirroring, ARCHITECTURE.md 2026-09-15. */
  private say(state: ConversationState, directive: SayDirective): Promise<string> {
    return say(this.env, directive, state.language);
  }

  async getState(): Promise<ConversationState> {
    return this.loadState();
  }

  /** Single entry point for every traveller turn. Runs entirely inside this
   * DO instance, which naturally serializes concurrent messages for the
   * same conversation — that's also what stops a double /v1/bookings call
   * if the traveller (or a flaky client) sends "sì" twice in a row. */
  async handleMessage(text: string, profile?: UserProfile | null): Promise<HandleMessageResult> {
    let state = await this.loadState();
    // Seed from the traveller's real, persistent profile (see
    // userProfile.ts) on this conversation's very first turn only — never
    // touched again after that. firstName/email/city fill exactly the
    // role DEMO_TRAVELLER's hardcoded values used to (skip re-asking what
    // we already know), while household size / economic tier are kept
    // ONLY as hints (see householdSizeHint/economicTierHint's doc,
    // types.ts) — a saved profile still never silently decides
    // adults/budget for a specific trip.
    if (state.messages.length === 0 && profile) {
      state.traveller = mergeDefined(state.traveller, {
        firstName: profile.firstName,
        email: profile.email,
        city: profile.city,
      });
      state.householdSizeHint = profile.householdSize;
      state.economicTierHint = profile.economicTier;
      state.preferredSportHint = profile.preferredSport;
    }
    state.messages.push({ role: "traveller", text, at: Date.now() });

    if (state.stage === "booked") {
      const reply = `La tua prenotazione è già confermata, codice ${state.reservationCode}. Per un nuovo viaggio apri una nuova conversazione.`;
      state.messages.push({ role: "agent", text: reply, at: Date.now() });
      await this.saveState(state);
      return { reply, state };
    }

    // The HOFJ inventory/backend/gateway is shared and can genuinely change
    // mid-session — not hypothetical, we watched the bookings 403 disappear
    // and turn into a different error later in this same session. So both
    // a payment failure and a bookings failure are worth letting the
    // traveller retry without starting a whole new conversation/cart, just
    // via different recovery paths: a payment failure retries the payment
    // itself, while a bookings failure (which only happens *after* a real
    // payment already succeeded) only retries the booking confirmation —
    // never re-pay for something already paid.
    if (state.stage === "failed") {
      const wantsRetry = /riprova|di nuovo|ritenta|prova ancora|retry/i.test(text);
      const isBookingFailure = state.failureReason?.startsWith("bookings:") ?? false;
      const paymentRetryable = state.failureReason?.startsWith("payment:") && state.itineraryId;
      const bookingRetryable = isBookingFailure && state.itineraryId && state.bookingRetryCount < BOOKING_RETRY_LIMIT;
      if (wantsRetry && paymentRetryable) {
        const reply = await this.attemptPayment(state);
        state.messages.push({ role: "agent", text: reply, at: Date.now() });
        await this.saveState(state);
        return { reply, state };
      }
      if (wantsRetry && bookingRetryable) {
        state.bookingRetryCount += 1;
        const reply = await this.confirmBookingNow(state, "full");
        state.messages.push({ role: "agent", text: reply, at: Date.now() });
        await this.saveState(state);
        return { reply, state };
      }
      const reply = paymentRetryable
        ? `Il pagamento non è ancora disponibile. Dimmi "riprova" quando vuoi che ci riprovi, oppure apri una nuova conversazione.`
        : bookingRetryable
          ? `Il pagamento è andato a buon fine, ma non riesco ancora a confermare la prenotazione. Dimmi "riprova" per ritentare solo quella parte.`
          : isBookingFailure
            ? `Ho riprovato più volte a confermare la prenotazione, ma il sistema del fornitore continua a non darmi il via libera — non è più un blip temporaneo. Il pagamento di ${state.totalPrice ? `${state.totalPrice.amount}${state.totalPrice.currency === "EUR" ? "€" : " " + state.totalPrice.currency}` : "quanto concordato"} è comunque andato a buon fine, e ho già registrato i tuoi dati per un follow-up manuale (riferimento: ${state.itineraryId}) — ti ricontatteremo appena si sblocca. Apri una nuova conversazione se intanto vuoi provare a prenotare qualcos'altro.`
            : `Questa conversazione si è fermata per un problema tecnico (${state.failureReason ?? "errore"}). Apri una nuova conversazione per riprovare.`;
      state.messages.push({ role: "agent", text: reply, at: Date.now() });
      await this.saveState(state);
      return { reply, state };
    }

    let reply: string;
    try {
      const interpretation = await interpret(this.env, state.slots, state.traveller, text, this.describeCurrentlyAsking(state));
      const { dateFromText, dateToText, ...slotUpdates } = interpretation.slotUpdates as Record<string, unknown>;

      // Trip slots (sport/city/dates/budget/...) and traveller fields both
      // have a "city", and interpret() isn't told which stage we're in —
      // it has to guess from context alone. Verified live: once the trip
      // was already confirmed and the dialogue was asking for the
      // traveller's own city (billing address), a bare answer like
      // "Milano" got written into BOTH state.traveller.city AND
      // state.slots.city, silently corrupting the already-confirmed
      // destination (a real proposal for Lanzarote ended up with
      // slots.city == "Lecco"). Prompt instructions alone aren't a
      // reliable enough guard for something this consequential — the trip
      // is only ever open for renegotiation during "collecting"/
      // "proposing"; past that point it's locked, so slotUpdates (except
      // dateFromVague bookkeeping) simply isn't applied at all, regardless
      // of what the model returned.
      const tripStillNegotiable = state.stage === "collecting" || state.stage === "proposing";
      if (tripStillNegotiable) {
        const resolvedDates: Partial<Slots> = {};
        if (typeof dateFromText === "string") resolvedDates.dateFrom = resolveDate(dateFromText);
        if (typeof dateToText === "string") resolvedDates.dateTo = resolveDate(dateToText);
        state.slots = mergeDefined(state.slots, { ...slotUpdates, ...resolvedDates } as Partial<Slots>);

        // The traveller said *something* about a date, but it wasn't
        // specific enough to resolve to one calendar day (e.g. "un weekend
        // di novembre") — worth telling them that, instead of silently
        // re-asking the same generic question, which reads as "didn't hear
        // you" when it actually did (regression: live user hit exactly this
        // with vague month-only answers, repeated 3+ times). Persisted on
        // the slots themselves (not a local variable) so it survives to a
        // *later* turn when dateFrom next becomes the missing slot — a
        // second regression found reading this code: the traveller can
        // volunteer a vague date on a turn where city, not date, is what's
        // being asked about, and that signal was being silently dropped.
        if (typeof dateFromText === "string") {
          state.slots.dateFromVague = resolvedDates.dateFrom ? null : dateFromText;
          // A month hint ("in June") is worth keeping even once a vague
          // phrase resolves to nothing else useful — matcher.ts uses it to
          // bias which candidate gets picked and which date within it gets
          // offered, instead of blindly defaulting to the earliest slot
          // regardless of season (regression: "three days off in June" got
          // offered a December date). Cleared once a real day resolves,
          // same as dateFromVague.
          state.slots.preferredMonth = resolvedDates.dateFrom ? null : extractMonthHint(dateFromText);
        }
      }
      state.traveller = mergeDefined(state.traveller, sanitizeTravellerUpdates(interpretation.travellerUpdates));

      // Sticky once detected: respond in whatever language the traveller
      // is actually using, not always Italian (regression: a fully
      // English conversation kept getting Italian replies — see
      // ARCHITECTURE.md, 2026-09-15).
      if (interpretation.language) {
        state.language = interpretation.language;
      }

      switch (state.stage) {
        case "collecting":
          reply = await this.runCollecting(state);
          break;
        case "proposing":
          reply = await this.runProposing(state, interpretation.decision, text);
          break;
        case "collecting_traveller":
          reply = await this.runCollectingTraveller(state);
          break;
        default:
          reply = await this.say(state, { kind: "no_match" });
      }
    } catch (err) {
      reply = await this.handleUnexpectedError(state, err);
    }

    state.messages.push({ role: "agent", text: reply, at: Date.now() });
    await this.saveState(state);
    return { reply, state };
  }

  /** Not every thrown error should end the conversation:
   * - AI-layer hiccups (transient Workers AI errors, exhausted) aren't
   *   business failures at all — stay exactly where we were.
   * - A *retryable* HOFJ error (429/502/503) hit during search/discovery,
   *   before any real cart exists, is also worth surviving — the
   *   traveller hasn't committed to anything yet, so failing the whole
   *   conversation over a rate limit blip is worse than just asking them
   *   to try again. Only a genuinely fatal failure inside the real
   *   booking pipeline (handled explicitly in attemptPayment /
   *   confirmPaymentAndBook, which set stage="failed" themselves with a
   *   specific reason) should be terminal. */
  private async handleUnexpectedError(state: ConversationState, err: unknown): Promise<string> {
    if (err instanceof AiUnavailableError) {
      return "Scusa, non ho capito bene — puoi ripetere?";
    }
    if (err instanceof HofjApiError && err.retryable) {
      return "Il sistema è un po' lento in questo momento, puoi ripetere?";
    }
    state.stage = "failed";
    state.failureReason = err instanceof Error ? err.message : String(err);
    return "Mi dispiace, ho un problema tecnico interno e non posso continuare questa conversazione. Riprova più tardi aprendone una nuova.";
  }

  /** Human-readable description of what the *previous* agent turn was
   * actually asking about, fed to interpret() so it can disambiguate a
   * short, context-free answer (e.g. "Milano" alone) — see the
   * "city" collision doc in engine/ai.ts. Based on state as it stands
   * before this turn's own updates, i.e. what was truly just asked. */
  private describeCurrentlyAsking(state: ConversationState): string | null {
    if (state.stage === "collecting") {
      const labels: Partial<Record<(typeof REQUIRED_TRIP_SLOTS)[number], string>> = {
        sport: "che sport vuole praticare",
        city: "in che città o zona vuole andare in vacanza (la destinazione del viaggio)",
        dateFrom: "quando vuole partire",
        budget: "il budget",
        adults: "in quante persone viaggia",
      };
      for (const key of REQUIRED_TRIP_SLOTS) {
        if (!this.stillBeingAsked(state, key)) continue;
        const label = labels[key] ?? key;
        // Regression found live 2026-09-14: the question itself said "come
        // al solito padel, giusto?" (a profile hint), but a bare "sì" back
        // didn't resolve to anything — interpret() was never told what
        // "come al solito" actually referred to, only the generic label.
        // Folding the hint's real value into the context here (not just
        // into the question's phrasing) is what lets a short confirmation
        // actually land in the slot.
        const hint = this.hintFor(state, key);
        return hint ? `${label} (gli è stato appena suggerito "${hint}" come ipotesi dal suo profilo — se risponde con un sì/conferma/ok secco senza specificare altro, intende confermare esattamente quel valore)` : label;
      }
      return null;
    }
    if (state.stage === "proposing") {
      return "se conferma o rifiuta la proposta di viaggio appena fatta";
    }
    if (state.stage === "collecting_traveller") {
      const labels: Partial<Record<keyof TravellerInfo, string>> = {
        firstName: "il nome del viaggiatore",
        lastName: "il cognome del viaggiatore",
        email: "l'email del viaggiatore",
        phone: "il telefono del viaggiatore",
        city: "la città DI RESIDENZA del viaggiatore, per l'indirizzo di fatturazione — NON la destinazione del viaggio, quella è già decisa",
      };
      const missing = REQUIRED_TRAVELLER_FIELDS.find((f) => state.traveller[f] === null);
      return missing ? (labels[missing] ?? missing) : null;
    }
    return null;
  }

  /** Whether `key` is still the slot a reply arriving RIGHT NOW should be
   * read as answering — distinct from isGatingSatisfied() below, and
   * deliberately not the same check. `cityAskAttempts`/`budgetAskAttempts`
   * are incremented the moment a question is ASKED, not once a reply to
   * it has come back unresolved — so by the time the traveller's reply to
   * that very question arrives on the *next* turn, isGatingSatisfied()
   * already reports the slot as bypassed (attempts already at the
   * threshold), and describeCurrentlyAsking() would silently describe the
   * WRONG (next) slot as "currently being asked" instead. Invisible with
   * plain-value answers ("500 euro" is unambiguous regardless of context)
   * but a real, reproducible bug the moment the question is a profile
   * hint confirmed with a bare "sì" — verified live 2026-09-14: a
   * confirmation meant for the budget hint landed in `adults` instead,
   * because attempts had already ticked past the loop-breaker threshold
   * one reply too early. Fix: this check stays true through the reply to
   * the LAST ask (attempts <= the loop-breaker), one turn longer than
   * isGatingSatisfied() does, so that specific reply still gets
   * attributed to the right slot; isGatingSatisfied() is untouched and
   * still decides, correctly, whether runCollecting() should move on. */
  private stillBeingAsked(state: ConversationState, key: (typeof REQUIRED_TRIP_SLOTS)[number]): boolean {
    switch (key) {
      case "city":
        return state.slots.city === null && state.cityAskAttempts <= CITY_LOOP_BREAKER;
      case "budget":
        return state.slots.budget === null && state.slots.budgetTier === null && state.budgetAskAttempts <= BUDGET_LOOP_BREAKER;
      default:
        return !this.isGatingSatisfied(state, key);
    }
  }

  /** Is this required slot resolved enough to stop gating the search?
   * "Resolved" isn't only "has a literal value" — city and dateFrom can
   * also be satisfied by giving up on precision (a persisted vague date,
   * or enough failed city asks), and budget the same way once it's had
   * its one ask. adults is the deliberate exception: only a real value
   * counts, ever — see ARCHITECTURE.md, Giuseppe's explicit line that
   * budget and party size are the two that are never decided for the
   * traveller. (Budget itself moved off that hard line in a later
   * revision — adults is now the only one still on it.) */
  private isGatingSatisfied(state: ConversationState, key: (typeof REQUIRED_TRIP_SLOTS)[number]): boolean {
    switch (key) {
      case "dateFrom":
        return state.slots.dateFrom !== null || state.slots.dateFromVague !== null;
      case "city":
        return state.slots.city !== null || state.cityAskAttempts >= CITY_LOOP_BREAKER;
      case "budget":
        return state.slots.budget !== null || state.slots.budgetTier !== null || state.budgetAskAttempts >= BUDGET_LOOP_BREAKER;
      default:
        return state.slots[key] !== null;
    }
  }

  /** A profile-derived suggestion for the slot about to be asked, if any —
   * folded into the question as something to confirm, never applied
   * silently (see the *Hint fields' doc, types.ts). Returns undefined
   * when there's no relevant hint, or the slot isn't one of the three the
   * profile can suggest anything for. */
  private hintFor(state: ConversationState, key: (typeof REQUIRED_TRIP_SLOTS)[number]): string | undefined {
    switch (key) {
      case "adults":
        return state.householdSizeHint === null
          ? undefined
          : state.householdSizeHint === 1
            ? "da solo"
            : `in ${state.householdSizeHint}`;
      case "budget": {
        // The profile's economicTier (smart/pro/luxury) and Slots.budgetTier
        // (low/mid/high) are two different vocabularies for the same
        // three-way idea — phrased here using the exact idioms
        // interpret()'s own budgetTier rules already recognize (see
        // INTERPRET_SYSTEM, engine/ai.ts), so a bare "sì" confirming this
        // hint lands in budgetTier via the SAME extraction path as if the
        // traveller had said it themselves, not a parallel one that would
        // need its own mapping logic downstream.
        const labels = { smart: "economico", pro: "carino ma non troppo caro, una via di mezzo", luxury: "il top, senza badare troppo a spese" } as const;
        return state.economicTierHint === null ? undefined : labels[state.economicTierHint];
      }
      case "sport":
        return state.preferredSportHint ?? undefined;
      default:
        return undefined;
    }
  }

  private async runCollecting(state: ConversationState): Promise<string> {
    // Walk the required slots in order and ask about the first one that
    // isn't gating-satisfied yet. Critically, a bypass on one slot (e.g. a
    // vague date accepted) does NOT jump straight to search — it only
    // clears that one slot's gate, so a still-missing, never-bypassable
    // slot further down the list (adults) still gets asked. An earlier
    // version of this function short-circuited straight to
    // searchAndPropose() on any bypass, which silently skipped asking
    // about adults whenever it happened to come after a bypassed slot —
    // found reading the code, not guessed: verified live that a
    // conversation reached "proposing" with adults still null.
    for (const key of REQUIRED_TRIP_SLOTS) {
      if (this.isGatingSatisfied(state, key)) continue;
      if (key === "city") state.cityAskAttempts += 1;
      if (key === "budget") state.budgetAskAttempts += 1;
      return this.say(state, { kind: "ask_slot", missing: key, hint: this.hintFor(state, key) });
    }
    return this.searchAndPropose(state);
  }

  /** `precededBy` folds a one-line acknowledgment of why we're searching
   * again into the SAME message ("quel pacchetto non risulta più
   * disponibile, però ho trovato quest'altro...") instead of a separate
   * filler turn — and still applies even when the search comes up
   * completely empty (regression found live, sessionId 81992bfd-...: a
   * twice-confirmed proposal turned out unbookable, the fallback search
   * found nothing else either, and the reply silently dropped the
   * acknowledgment, reading as a non-sequitur "tell me your flexibility"
   * with no mention of what had just failed). */
  private async searchAndPropose(
    state: ConversationState,
    precededBy?: "rejected" | "unavailable",
  ): Promise<string> {
    const { candidates, locationMatched } = await searchCandidates(this.hofj, state.slots);
    const ctx = classify(state.slots, candidates, state.rejectedProductIds, locationMatched);
    if (!ctx) {
      state.stage = "collecting";
      return this.say(state, { kind: "no_match", precededBy });
    }
    state.cityAskAttempts = 0;
    state.budgetAskAttempts = 0;
    state.proposal = ctx;
    state.stage = "proposing";
    // A new candidate means any cached description belongs to a different
    // product now — never answer a question about THIS proposal using
    // stale detail fetched for a previous, possibly rejected one.
    state.productDescription = null;
    return this.say(state, { kind: "propose", ctx, precededBy, adults: state.slots.adults! });
  }

  /** Ad-hoc informational question about the current proposal ("cosa
   * include il pacchetto?") — fetched lazily (only when actually asked,
   * not for every proposal) via HofjClient.getProduct(), product-level so
   * it never needs a real itinerary/cart (see Giuseppe's explicit
   * decision against opening one before confirmation, ARCHITECTURE.md).
   * Cached on state.productDescription for the rest of this same
   * proposal so a second question doesn't re-fetch. Stays in "proposing"
   * — answering a question is not a decision either way, the traveller
   * still owes a real yes/no afterward. */
  private async answerProposalQuestion(state: ConversationState, question: string): Promise<string> {
    const ctx = state.proposal!;
    if (state.productDescription === null) {
      try {
        const detail = await this.hofj.getProduct(ctx.candidate.productId, ctx.candidate.brand);
        state.productDescription = detail.data.description ?? detail.data.shortDescription ?? "";
      } catch (err) {
        if (err instanceof HofjApiError) {
          console.error("getProduct failed:", err.status, err.detail.slice(0, 200));
        }
        state.productDescription = ""; // don't retry every question this turn; answer_proposal_question degrades gracefully on ""
      }
    }
    return this.say(state, { kind: "answer_proposal_question", question, ctx, description: state.productDescription || null });
  }

  private async runProposing(state: ConversationState, decision: "yes" | "no" | "unclear" | "question", text: string): Promise<string> {
    if (decision === "question" && state.proposal) {
      return this.answerProposalQuestion(state, text);
    }
    if (decision === "yes" && state.proposal) {
      // The traveller never gave a specific date (date_unspecified
      // compromise) — commit to the candidate's own earliest availability
      // now that they've confirmed it, so the real booking call further
      // down the pipeline has a startDate to send. Only fires when
      // dateFrom is still null, so it never overwrites a date the
      // traveller actually gave.
      if (state.slots.dateFrom === null) {
        state.slots.dateFrom = state.proposal.candidate.minDate;
        state.slots.dateFromVague = null;
      }
      state.stage = "collecting_traveller";
      // Traveller info may already be filled from an earlier attempt (e.g.
      // a price-changed re-confirmation loop) — don't re-ask what we
      // already have, go straight to opening the cart if it's complete.
      return this.runCollectingTraveller(state);
    }
    if (decision === "no" && state.proposal) {
      state.rejectedProductIds.push(state.proposal.candidate.productId);
      state.proposal = null;
      return this.searchAndPropose(state, "rejected");
    }
    // "unclear" -> re-evaluate in case the traveller changed a slot
    // (budget/date/city) without an explicit yes/no.
    return this.searchAndPropose(state);
  }

  private async runCollectingTraveller(state: ConversationState): Promise<string> {
    const missing = REQUIRED_TRAVELLER_FIELDS.find((f) => state.traveller[f] === null);
    if (missing) {
      const isFirstAsk = REQUIRED_TRAVELLER_FIELDS.every((f) => state.traveller[f] === null);
      return this.say(state, { kind: "ask_traveller_field", field: missing, isFirstAsk });
    }
    return this.openRealCartAndAttemptPayment(state);
  }

  /** The real, money-real part of the pipeline: opens an actual HOFJ cart,
   * silently re-verifies price against the live snapshot, writes real
   * traveller data, then tries to get a Stripe payment intent. */
  private async openRealCartAndAttemptPayment(state: ConversationState): Promise<string> {
    const proposal = state.proposal!;
    const { candidate } = proposal;
    const brand = candidate.brand;
    const requestedDate = state.slots.dateFrom!;
    // A single room only fits so many people — verified live: 3 adults
    // with rooms:1 on a real product 400ed upstream with
    // ComponentAvailability ("lack of availability"), and passing rooms:2
    // fixed it immediately. Two people per room is a standard hotel
    // convention and a reasonable default absent a way to ask the
    // traveller directly without adding a whole new slot-filling step for
    // room configuration, which is out of scope here.
    const rooms = Math.max(1, Math.ceil(state.slots.adults! / 2));

    let created;
    try {
      created = await this.hofj.createItinerary({
        productId: candidate.productId,
        startDate: requestedDate,
        adults: state.slots.adults!,
        rooms,
        brand,
      });
    } catch (err) {
      if (err instanceof HofjApiError) {
        console.error("createItinerary failed:", err.status, err.detail.slice(0, 200));
      }
      // minDate/maxDate from search is a *range*, but real availability is
      // discrete slots inside it — verified live: a date well within that
      // range still fails upstream with RESERVATION_PERIOD_ERROR. Treating
      // this as a generic transient error would tell the traveller "the
      // system is slow, try again" — misleading, since retrying the exact
      // same date is guaranteed to fail identically. We can't reliably
      // string-match the specific upstream reason: verified live that the
      // real detail sometimes arrives intact via HofjApiError, but other
      // times arrives collapsed to a generic "error code: 502" — Cloudflare
      // itself appears to synthesize that when HOFJ's origin misbehaves on
      // this response, before our own JSON-parsing fallback ever sees the
      // real body. So instead of gating on the exact error text, treat ANY
      // createItinerary failure as "this date probably isn't real" and
      // negotiate: fall back to the candidate's own minDate (near-certain
      // to be a real slot, since every product tested this session opened
      // successfully on it) and ask for reconfirmation, same pattern as a
      // price/date compromise. Only skip this when we're already on
      // minDate (nothing left to fall back to — a genuinely different,
      // fatal problem at that point).
      if (err instanceof HofjApiError && requestedDate !== candidate.minDate) {
        state.slots.dateFrom = candidate.minDate;
        state.stage = "proposing";
        state.proposal = {
          ...proposal,
          category: "compromise",
          compromise: { kind: "date", requested: requestedDate, offered: candidate.minDate },
        };
        return this.say(state, { kind: "propose", ctx: state.proposal, adults: state.slots.adults! });
      }
      // Already on the candidate's own known-good minDate and it *still*
      // failed: this isn't a date problem, and retrying (the generic
      // "sistema lento, riprova" path) can never succeed. Originally
      // logged here as an upstream "prodotto non prenotabile" case
      // (NOT_FOUND_ERROR on a product that came back as a normal search
      // result) — but that diagnosis turned out to be WRONG for the two
      // real cases hit this session (Lanzarote padel, ids 186/181):
      // verified live 2026-09-14 that both actually create fine when
      // called with `brand` set correctly, and 404 with the exact same
      // error only when called under the wrong brand — which is precisely
      // what `createItinerary` used to do before `brand` was threaded
      // through end to end (see Candidate.brand's doc, types.ts). So a
      // genuinely unbookable product may still exist somewhere in this
      // catalog, but neither confirmed instance of this branch firing was
      // actually one — both were this same brand bug. Kept as a fallback
      // safety net regardless: reject this specific product and look for
      // the next best candidate instead of asking the traveller to retry
      // something that (for whatever the real reason) isn't working.
      if (err instanceof HofjApiError) {
        state.rejectedProductIds.push(candidate.productId);
        state.proposal = null;
        state.stage = "collecting";
        return this.searchAndPropose(state, "unavailable");
      }
      throw err;
    }
    state.itineraryId = created.data.itineraryId;
    state.brand = brand;

    const snapshot = await this.hofj.getItinerary(state.itineraryId, brand);
    const livePrice = Number(snapshot.data.totalPrice.amount);
    // Verified live 2026-09-15 (sessionId 04022cc9-..., then confirmed
    // again when Giuseppe asked "quindi mi aspetto che il prezzo a
    // persona venga ricordato quando sto per pagare"): search() never
    // sends an adults param, so candidate.price is priced for the
    // package's own default occupancy — the real total genuinely scales
    // with the actual party size. The proposal message itself already
    // discloses this estimated total upfront (see "propose", engine/ai.ts)
    // — comparing against that SAME estimate here, not the raw
    // per-person price, means this step only ever flags a GENUINE new
    // surprise (e.g. an odd-party-size room supplement) instead of
    // re-announcing the party-size scaling a second time as if it were
    // news, right after already telling the traveller to expect it.
    const adults = state.slots.adults ?? 1;
    const estimatedTotal = candidate.price * adults;
    if (Math.abs(livePrice - estimatedTotal) / estimatedTotal > PRICE_CHANGE_TOLERANCE) {
      state.proposal = {
        ...proposal,
        candidate: { ...candidate, price: livePrice },
        category: "compromise",
        compromise: { kind: "price", requested: `${estimatedTotal}€`, offered: `${livePrice}€` },
      };
      state.stage = "proposing";
      return this.say(state, {
        kind: "price_changed",
        oldPrice: `${estimatedTotal}€`,
        newPrice: `${livePrice}€`,
      });
    }
    state.totalPrice = snapshot.data.totalPrice;

    const traveller = state.traveller;
    try {
      await this.hofj.putCustomer(
        state.itineraryId,
        {
          firstName: traveller.firstName!,
          lastName: traveller.lastName!,
          email: traveller.email!,
          phone: traveller.phone!,
          address: {
            street1: "N/A",
            postalCode: traveller.postalCode ?? "00000",
            city: traveller.city!,
            region: "",
            countryCode: traveller.countryCode ?? candidate.country,
          },
        },
        brand,
      );
      // HOFJ auto-provisions one pax slot per adult on the itinerary the
      // moment it's created (verified live: a 2-adult itinerary already
      // has "pax-1"/"pax-2" in its snapshot before this call). Sending
      // fewer pax records than that reads upstream as *changing*
      // paxNumber, not just filling in names, and 400s (surfaced through
      // the gateway as a generic 502) with detail
      // "changePaxDetails.paxNumberChanged" — verified live with 2 adults
      // and a single pax-1 entry. We only collect one real traveller's
      // name in this demo scope, so companions beyond the first get a
      // bare refId, matching the empty stub HOFJ itself already creates
      // for them.
      const pax: PaxPayload[] = Array.from({ length: state.slots.adults! }, (_, i) =>
        i === 0 ? { refId: "pax-1", firstName: traveller.firstName!, lastName: traveller.lastName! } : { refId: `pax-${i + 1}` },
      );
      await this.hofj.putPax(state.itineraryId, pax, brand);
    } catch (err) {
      // Second line of defense behind sanitizeTravellerUpdates() above —
      // that check catches the one real case found live (a malformed
      // email), this catches anything else HOFJ's own validation rejects
      // that we haven't anticipated (a phone format, an address field,
      // etc.). Regression found live 2026-09-14: this call had NO
      // try/catch at all, so a 400 here propagated all the way up to the
      // generic "internal error, start a new conversation" dead end —
      // losing the whole trip negotiation (city, dates, price already
      // agreed) over a single bad field that the traveller could have
      // just corrected. Re-collect the traveller's data instead of
      // killing the conversation — we don't reliably know which nested
      // field HOFJ's error refers to, so clearing all of it and asking
      // again is the safe, simple recovery, not a silent guess.
      if (err instanceof HofjApiError && err.status === 400) {
        console.error("putCustomer/putPax rejected traveller data:", err.detail.slice(0, 300));
        state.traveller = { ...EMPTY_TRAVELLER };
        state.stage = "collecting_traveller";
        return this.say(state, { kind: "ask_traveller_field", field: "firstName", isFirstAsk: false, correction: true });
      }
      throw err;
    }

    return this.attemptPayment(state);
  }

  private async attemptPayment(state: ConversationState): Promise<string> {
    // HOFJ's own payment-intent refresh used to 502 unconditionally — now
    // fixed (verified live 2026-09-14 ~21:35, real client_secret comes
    // back) — but there's still nowhere for that client_secret to go:
    // this prototype has no Stripe Elements frontend to confirm it
    // client-side, and verified live it belongs to a Stripe account our
    // own key can't read at all (by design, most likely — see
    // hofj/client.ts's doc on getPaymentIntent). So regardless of whether
    // this call succeeds or fails, the only path actually completable
    // from here is the sanctioned direct-Stripe bypass below. Still
    // called for real every time — not skipped — so it stays a live,
    // accurate check of upstream status instead of a stale assumption.
    try {
      await this.hofj.getPaymentIntent(state.itineraryId!, state.brand!);
    } catch (err) {
      if (err instanceof HofjApiError) {
        console.error("getPaymentIntent failed:", err.status, err.detail.slice(0, 200));
      }
    }
    if (this.env.STRIPE_SECRET_KEY) {
      return this.attemptDirectStripePayment(state);
    }
    state.stage = "failed";
    state.failureReason = "payment: no payment path available (no Stripe key configured)";
    return this.say(state, { kind: "payment_unavailable", retrying: false });
  }

  /** Real Stripe test-mode payment, created and confirmed directly against
   * HOFJ's own account (see stripe/client.ts for why this is sanctioned,
   * not a hack). Auto-confirms with Stripe's own test card token — a
   * deliberate demo simplification (documented in ARCHITECTURE.md): a real
   * production flow would hand the client_secret to the frontend for the
   * actual cardholder to confirm via Stripe Elements, never touch card
   * details server-side. There is no such frontend integration yet in
   * this prototype. */
  private async attemptDirectStripePayment(state: ConversationState): Promise<string> {
    try {
      const amountMinorUnits = Math.round(Number(state.totalPrice!.amount) * 100);
      const intent = await createPaymentIntent(this.env, {
        amountMinorUnits,
        currency: state.totalPrice!.currency,
        itineraryId: state.itineraryId!,
      });
      const confirmed = await confirmPaymentIntent(this.env, intent.id);
      state.paymentIntentId = intent.id;
      state.paymentStatus = confirmed.status;
      // Real payment succeeded. "full" because that's what we actually
      // just did — charged the entire total in one PaymentIntent, not a
      // deposit — not a guess at what the gateway wants (verified live
      // 2026-09-14 ~21:35 that the paymentType field itself is no longer
      // rejected either way). paymentIntentId/paymentStatus (persisted
      // above, forwarded inside confirmBookingNow) per the full OpenAPI
      // spec (GET /v1/openapi.json) — without them the brand site has
      // nothing to attach the payment to at all. Still not sufficient for
      // a genuinely completed booking as of that same verification (see
      // confirmBooking's doc, hofj/client.ts) — sent anyway, spec-correct,
      // since that gap may close without notice on a shared backend.
      return this.confirmBookingNow(state, "full");
    } catch (err) {
      state.stage = "failed";
      state.failureReason = `payment: ${err instanceof Error ? err.message : String(err)}`;
      return this.say(state, { kind: "payment_unavailable", retrying: false });
    }
  }

  /** Confirms the real booking with HOFJ. Only ever called after a real
   * payment has already succeeded (either via a future Stripe.js frontend
   * confirming client-side — confirmPaymentAndBook() below — or via the
   * direct-Stripe fallback above), so every failure path here uses the
   * "bookings:" failureReason prefix, never "payment:" — retrying this
   * specific step should never re-charge anything.
   *
   * A 200 from POST /v1/bookings is NOT sufficient proof of a real
   * booking — verified live 2026-09-14 ~22:10 with a decisive idempotency
   * check (see ARCHITECTURE.md): the exact same request, repeated on the
   * same itinerary, returned a completely different `data` value each of
   * the first two times and then stabilized into echoing the itineraryId
   * back — never the same value twice, which rules out it being a real
   * stored reservation code (the endpoint is documented as an idempotent
   * upsert; a genuine one would come back identical every time). So this
   * always re-fetches the itinerary afterward and requires
   * `checkout.status` to have actually moved away from
   * "BookingInitiated" before ever telling the traveller "booked" — the
   * one signal that can't be faked by a plausible-looking response. */
  /** Writes a durable record of a real charge whose booking couldn't be
   * confirmed, so the "lascia i tuoi dati, ti ricontatto" promise
   * (booking_unverified/payment_unavailable's wording) is actually backed
   * by something — see FollowUpDO's doc, followUp.ts. Only when a real
   * payment actually succeeded (nothing to reconcile otherwise), and only
   * once per conversation regardless of how many times "riprova" runs. */
  private async logFollowUpIfNeeded(state: ConversationState): Promise<void> {
    if (state.followUpLogged || !state.paymentIntentId || !state.itineraryId || !state.brand || !state.totalPrice) return;
    state.followUpLogged = true;
    try {
      await this.env.FOLLOWUP.getByName("registry").record({
        itineraryId: state.itineraryId,
        brand: state.brand,
        paymentIntentId: state.paymentIntentId,
        amount: state.totalPrice.amount,
        currency: state.totalPrice.currency,
        traveller: {
          firstName: state.traveller.firstName,
          lastName: state.traveller.lastName,
          email: state.traveller.email,
          phone: state.traveller.phone,
        },
        failureReason: state.failureReason ?? "",
        recordedAt: Date.now(),
      });
    } catch (err) {
      // Logging the follow-up itself is a best-effort safety net, not the
      // primary flow — a failure here shouldn't make the traveller-facing
      // reply fail too. state.followUpLogged stays true regardless (no
      // retry loop over this specific write); the conversation's own
      // durable state still has everything needed if this is ever
      // revisited by hand.
      console.error("logFollowUpIfNeeded failed:", err instanceof Error ? err.message : err);
    }
  }

  private async confirmBookingNow(state: ConversationState, paymentType: "full" | "plan"): Promise<string> {
    try {
      const payment = state.paymentIntentId
        ? { paymentIntentId: state.paymentIntentId, paymentStatus: state.paymentStatus ?? "succeeded" }
        : undefined;
      const booking = await this.hofj.confirmBooking(state.itineraryId!, state.brand!, paymentType, payment);
      const snapshot = await this.hofj.getItinerary(state.itineraryId!, state.brand!);
      if (snapshot.data.checkout.status === "BookingInitiated") {
        state.stage = "failed";
        state.failureReason = `bookings: unverified — checkout.status still "BookingInitiated" after a 200 response`;
        await this.logFollowUpIfNeeded(state);
        return this.say(state, { kind: "booking_unverified" });
      }
      state.stage = "booked";
      state.reservationCode = booking.data;
      return this.say(state, {
        kind: "booked",
        reservationCode: booking.data,
        title: state.proposal!.candidate.title,
        totalPrice: `${state.totalPrice!.amount}${state.totalPrice!.currency === "EUR" ? "€" : " " + state.totalPrice!.currency}`,
        startDate: state.slots.dateFrom!,
      });
    } catch (err) {
      state.stage = "failed";
      if (err instanceof HofjApiError && err.status === 403) {
        state.failureReason = "bookings: 403 forbidden-entity";
        await this.logFollowUpIfNeeded(state);
        return this.say(state, { kind: "booking_forbidden" });
      }
      state.failureReason = `bookings: ${err instanceof Error ? err.message : String(err)}`;
      await this.logFollowUpIfNeeded(state);
      return this.say(state, { kind: "payment_unavailable", retrying: false });
    }
  }

  /** Invoked by the frontend once Stripe.js confirms the card payment
   * client-side. Currently unreachable in practice — attemptPayment() falls
   * back to the direct-Stripe path instead of ever reaching "paying" while
   * GET .../payment 502s — but implemented to spec so the last mile just
   * works the moment that upstream bug is fixed and a real Elements
   * integration exists in the frontend. */
  async confirmPaymentAndBook(): Promise<HandleMessageResult> {
    const state = await this.loadState();
    if (state.stage !== "paying" || !state.itineraryId) {
      const reply = "Non c'è un pagamento in corso da confermare per questa conversazione.";
      return { reply, state };
    }
    const reply = await this.confirmBookingNow(state, "full");
    state.messages.push({ role: "agent", text: reply, at: Date.now() });
    await this.saveState(state);
    return { reply, state };
  }
}
