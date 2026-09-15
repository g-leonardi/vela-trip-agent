import { DurableObject } from "cloudflare:workers";
import { HofjApiError, HofjClient, type PaxPayload } from "./hofj/client";
import { AiUnavailableError, interpret, say, type SayDirective } from "./engine/ai";
import { addDaysIso, datesOverlap, extractMonthHint, resolveDate } from "./engine/dates";
import { classify, searchCandidates } from "./engine/matcher";
import { cachedDiscoveryCall, DISCOVERY_TTL_MS } from "./hofj/discoveryCache";
import { acquireCriticalOrWait, acquireOptional, QuotaExhaustedError } from "./hofj/quotaClient";
import { confirmPaymentIntent } from "./stripe/client";
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

// Same three-way idea, two vocabularies (see hintFor()'s "budget" case for
// the traveller-facing phrasing of each). Used ONLY as the fallback when
// BUDGET_LOOP_BREAKER bypasses a genuinely unanswered budget question —
// never overrides an explicit slots.budget/budgetTier the traveller gave.
const ECONOMIC_TIER_TO_BUDGET_TIER: Record<"smart" | "pro" | "luxury", Slots["budgetTier"]> = {
  smart: "low",
  pro: "mid",
  luxury: "high",
};

function initialState(): ConversationState {
  return {
    // Traveller data is collected FIRST, before any trip talk — decision
    // by Giuseppe, 2026-09-15, after watching a live session where every
    // "surprise" (date not really available, price changed) only
    // surfaced AFTER the traveller had already spent several turns
    // giving their name/email/phone, right after already accepting a
    // proposal. Collecting known-in-advance data up front, once, means
    // by the time a proposal is accepted there's nothing left to ask —
    // openRealCartAndAttemptPayment runs immediately (see runProposing's
    // "yes" branch), so any real-cart surprise now lands right after the
    // "sì, procedi", not several turns of sunk-cost effort later. Still
    // skips whatever a saved profile already knows (see
    // REQUIRED_TRAVELLER_FIELDS / runCollectingTraveller) — never
    // re-asks what's already on file.
    stage: "collecting_traveller",
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
    budgetTierFromProfileDefault: false,
    preferredSportHint: null,
    productDescription: null,
    bookingRetryCount: 0,
    followUpLogged: false,
    pastBookings: [],
    lastDateOverlapWarning: null,
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
    if (!stored) return initialState();
    // ConversationState's shape has grown more than once this session
    // (budgetTierFromProfileDefault, pastBookings, lastDateOverlapWarning —
    // all added 2026-09-15) — a DO whose state was persisted BEFORE a field
    // existed keeps that old, narrower shape forever; `stored` alone is
    // missing it entirely, not just null. Verified live: a real session
    // from earlier today hit exactly this, `state.pastBookings.push(...)`
    // on `undefined` — a genuine 500 (Cloudflare error 1101), not a
    // hypothetical. initialState()'s own defaults fill every gap; real
    // persisted values always win over them.
    return { ...initialState(), ...stored };
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

    // Neither "booked" nor "failed" is a true dead end. There is no "new
    // conversation" button to send the traveller to — see
    // tryStartNewTripAfterTerminal's own doc for why (Giuseppe,
    // 2026-09-15: this app is meant to run screen-free; the UI here is a
    // 2026 testing facility, not the real interaction model) — so a
    // genuinely new trip request, typed straight into this same
    // conversation, has to be recognized and picked up right here instead
    // of bouncing the traveller to an affordance that doesn't exist.
    // Set once tryStartNewTripAfterTerminal has already run interpret()
    // and applied its result to state — skips the main flow's OWN
    // interpret() call below so a terminal-stage new-trip message never
    // costs a second, redundant model call for the exact same text.
    let newTripJustStarted = false;

    if (state.stage === "booked") {
      if (await this.tryStartNewTripAfterTerminal(state, text)) {
        newTripJustStarted = true;
      } else {
        const reply = `La tua prenotazione è già confermata, codice ${state.reservationCode}.`;
        state.messages.push({ role: "agent", text: reply, at: Date.now() });
        await this.saveState(state);
        return { reply, state };
      }
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
      // Distinct from a genuine failure (403, or anything else) — this
      // specific reason means "confirmed but unverifiable", not "might
      // not have worked" (Carlo, Vela/HOFJ, email 2026-09-15 — see
      // booking_unverified's own doc, engine/ai.ts). Deserves its own,
      // reassuring tone here too, not the generic "still stuck" one.
      const isUnverifiedBooking = state.failureReason?.startsWith("bookings: unverified") ?? false;
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
      // "riprova" was already ruled out above — anything else is either
      // pure chatter (keep the fixed reply) or a genuinely new trip (pick
      // it up in place). Only tried when there's still something at stake
      // (paymentRetryable/bookingRetryable false but a real payment/cart
      // may still exist) — always safe either way, tryStartNewTripAfterTerminal
      // only returns true on an unambiguous new-trip signal.
      if (!wantsRetry && (await this.tryStartNewTripAfterTerminal(state, text))) {
        newTripJustStarted = true;
      } else {
        const reply = paymentRetryable
          ? `Il pagamento non è ancora disponibile. Dimmi "riprova" quando vuoi che ci riprovi.`
          : bookingRetryable
            ? `Il pagamento è andato a buon fine, ma non riesco ancora a confermare la prenotazione. Dimmi "riprova" per ritentare solo quella parte.`
            : isUnverifiedBooking
              ? `La tua prenotazione risulta effettuata: il pagamento di ${state.totalPrice ? `${state.totalPrice.amount}${state.totalPrice.currency === "EUR" ? "€" : " " + state.totalPrice.currency}` : "quanto concordato"} è andato a buon fine, il codice di riferimento è ${state.itineraryId}, e arriverà anche una mail di conferma con tutti i dettagli. È in attesa solo dell'ultima conferma tecnica interna dal sistema del fornitore (un limite noto del loro lato, non un problema della tua prenotazione).`
              : isBookingFailure
                ? `Ho riprovato più volte a confermare la prenotazione, ma il sistema del fornitore continua a non darmi il via libera — non è più un blip temporaneo. Il pagamento di ${state.totalPrice ? `${state.totalPrice.amount}${state.totalPrice.currency === "EUR" ? "€" : " " + state.totalPrice.currency}` : "quanto concordato"} è comunque andato a buon fine, e ho già registrato i tuoi dati per un follow-up manuale (riferimento: ${state.itineraryId}) — ti ricontatteremo appena si sblocca.`
                : `Questa conversazione si è fermata per un problema tecnico (${state.failureReason ?? "errore"}). Dimmi pure di cosa hai bisogno e ci riprovo.`;
        state.messages.push({ role: "agent", text: reply, at: Date.now() });
        await this.saveState(state);
        return { reply, state };
      }
    }

    let reply: string;
    let decisionFromInterpretation: "yes" | "no" | "unclear" | "question" = "unclear";
    try {
      if (!newTripJustStarted) {
        const interpretation = await interpret(this.env, state.slots, state.traveller, text, this.describeCurrentlyAsking(state));
        decisionFromInterpretation = interpretation.decision;
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
        // "proposing", OR during "collecting_traveller" when nothing has
        // been proposed yet (the new conversation-opening phase, see
        // initialState()'s doc — a traveller who volunteers trip details
        // while still being asked their name should have them captured,
        // not dropped only to be asked again a few turns later). Once a
        // proposal exists it's locked, so slotUpdates (except
        // dateFromVague bookkeeping) simply isn't applied at all, regardless
        // of what the model returned — this is what still protects a
        // decided trip during the OTHER time collecting_traveller can
        // happen: re-collecting data reset by a putCustomer/putPax
        // validation error mid-booking (see the `correction` branch below).
        const tripStillNegotiable =
          state.stage === "collecting" ||
          state.stage === "proposing" ||
          (state.stage === "collecting_traveller" && state.proposal === null);
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
      }

      switch (state.stage) {
        case "collecting":
          reply = await this.runCollecting(state);
          break;
        case "proposing":
          reply = await this.runProposing(state, decisionFromInterpretation, text);
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
      // The "NON la destinazione, quella è già decisa" caveat only makes
      // sense once a trip is actually decided (state.proposal set) or at
      // least discussed (slots.city given) — collecting_traveller now
      // also runs at the very START of a conversation (see
      // initialState()'s doc), before any destination exists to confuse
      // this with, so stating the caveat there would be actively
      // confusing (there's nothing "already decided" yet).
      const destinationDecided = state.proposal !== null || state.slots.city !== null;
      const labels: Partial<Record<keyof TravellerInfo, string>> = {
        firstName: "il nome del viaggiatore",
        lastName: "il cognome del viaggiatore",
        email: "l'email del viaggiatore",
        phone: "il telefono del viaggiatore",
        city: destinationDecided
          ? "la città DI RESIDENZA del viaggiatore, per l'indirizzo di fatturazione — NON la destinazione del viaggio, quella è già decisa"
          : "la città DI RESIDENZA del viaggiatore, per l'indirizzo di fatturazione (il viaggio non è stato ancora discusso, quindi qui non c'è nessuna destinazione con cui confonderla)",
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

  /** Called only from a terminal stage ("booked", or "failed" once its own
   * "riprova" paths have already been ruled out) — decides whether this
   * new message is genuinely about a DIFFERENT trip, not just chatter
   * ("grazie", "ok") or something unrelated. There's no "new conversation"
   * button to send the traveller to instead (Giuseppe, 2026-09-15: this
   * app is meant to run screen-free eventually — the web UI here is a
   * 2026 testing facility, not the real interaction model — so a genuine
   * human travel agent wouldn't have one either; the judgment call has to
   * be made from the words alone, the same way it is here).
   *
   * Runs the SAME interpret() the main flow uses, but against a BLANK
   * trip (EMPTY_SLOTS, not state.slots) so a stray leftover value from the
   * trip that just finished can never leak into what's supposedly a fresh
   * one. A real signal only: sport/city/a date phrase/budget — anything
   * softer ("mah", "ciao") stays a false negative, correctly, since
   * there's nothing concrete to resume it as.
   *
   * On a genuine signal: logs the just-finished trip into pastBookings
   * (only when a real payment actually went through for it — nothing to
   * log otherwise), resets every trip-only field, and returns true so
   * handleMessage() falls through into the ordinary collecting flow below
   * with THIS SAME interpretation already applied — never a second
   * interpret() call for the one message. */
  private async tryStartNewTripAfterTerminal(state: ConversationState, text: string): Promise<boolean> {
    const interpretation = await interpret(this.env, EMPTY_SLOTS, state.traveller, text, null);
    const { dateFromText, dateToText, ...slotUpdates } = interpretation.slotUpdates as Record<string, unknown>;
    const hasNewTripSignal =
      slotUpdates.sport != null || slotUpdates.city != null || typeof dateFromText === "string" || slotUpdates.budget != null || slotUpdates.budgetTier != null;
    if (!hasNewTripSignal) return false;

    // A real payment is a real physical commitment for those dates —
    // worth remembering even though the DO's own trip fields are about to
    // be wiped, so a LATER new-trip check in this same conversation can
    // still warn about it (see pastBookings' own doc, types.ts). Skipped
    // when nothing was ever actually paid for (a genuine unrecoverable
    // failure) — there's no real-world conflict to warn about there.
    if (state.paymentStatus === "succeeded" && state.slots.dateFrom) {
      const dateFrom = state.slots.dateFrom;
      const dateTo = state.slots.dateTo ?? addDaysIso(dateFrom, state.proposal?.candidate.durationDays ?? 1);
      state.pastBookings.push({ reservationCode: state.reservationCode ?? state.itineraryId ?? "sconosciuto", dateFrom, dateTo });
    }

    state.slots = { ...EMPTY_SLOTS };
    state.proposal = null;
    state.rejectedProductIds = [];
    state.itineraryId = null;
    state.brand = null;
    state.paymentIntentId = null;
    state.paymentStatus = null;
    state.totalPrice = null;
    state.reservationCode = null;
    state.failureReason = null;
    state.cityAskAttempts = 0;
    state.budgetAskAttempts = 0;
    state.productDescription = null;
    state.bookingRetryCount = 0;
    state.followUpLogged = false;
    state.lastDateOverlapWarning = null;
    // Traveller data is already known (never re-asked) — go straight to
    // the trip slots, same as a returning traveller with a saved profile.
    state.stage = "collecting";

    const resolvedDates: Partial<Slots> = {};
    if (typeof dateFromText === "string") resolvedDates.dateFrom = resolveDate(dateFromText);
    if (typeof dateToText === "string") resolvedDates.dateTo = resolveDate(dateToText);
    state.slots = mergeDefined(state.slots, { ...slotUpdates, ...resolvedDates } as Partial<Slots>);
    if (typeof dateFromText === "string") {
      state.slots.dateFromVague = resolvedDates.dateFrom ? null : dateFromText;
      state.slots.preferredMonth = resolvedDates.dateFrom ? null : extractMonthHint(dateFromText);
    }
    state.traveller = mergeDefined(state.traveller, sanitizeTravellerUpdates(interpretation.travellerUpdates));
    if (interpretation.language) state.language = interpretation.language;
    return true;
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
      if (this.isGatingSatisfied(state, key)) {
        // The ONLY way this is true for "budget" with both
        // slots.budget/budgetTier still null is the loop-breaker itself
        // (see isGatingSatisfied) — i.e. the traveller genuinely never
        // answered. Silently defaulting to "cheapest" from there regardless
        // of a known "luxury" profile was the exact gap Giuseppe found live
        // 2026-09-15 ("un luxury... voglia sempre la soluzione più
        // inclusiva. Questa logica si è persa?"). Fill it from the profile
        // hint instead when there is one — still just a suggestion, always
        // disclosed as a compromise in searchAndPropose() below, never
        // treated as if the traveller had said it themselves.
        if (key === "budget" && state.slots.budget === null && state.slots.budgetTier === null && state.economicTierHint !== null) {
          state.slots.budgetTier = ECONOMIC_TIER_TO_BUDGET_TIER[state.economicTierHint];
          state.budgetTierFromProfileDefault = true;
        }
        continue;
      }
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
    /** Real, verified upstream detail behind `precededBy === "unavailable"`
     * (see HofjApiError.detail, openRealCartAndAttemptPayment) — never
     * fabricated when absent, see SayDirective's own doc, engine/ai.ts. */
    unavailableReason?: string,
  ): Promise<string> {
    // search() is priority P3 (discovery) — cached/coalesced first (see
    // engine/matcher.ts, hofj/discoveryCache.ts), consulting the quota
    // gate only on a genuine miss. A denial here means nothing has
    // happened upstream (no cart, no charge) — degrade honestly and
    // leave state exactly as it was, so the traveller's next message
    // retries this same step cleanly (see ARCHITECTURE.md twist Phase 2).
    let candidates, locationMatched;
    try {
      ({ candidates, locationMatched } = await searchCandidates(this.hofj, state.slots, this.env));
    } catch (err) {
      if (err instanceof QuotaExhaustedError) {
        return this.say(state, { kind: "backpressure", state: "queued" });
      }
      // A real, retryable HOFJ error (429/502/503) — HofjClient already
      // retried once internally and still failed. Regression found live
      // 2026-09-15 (session `ab6d0bfa-...`, Giuseppe: "mi dice
      // perennemente 'il sistema ci sta mettendo un po''"): this used to
      // fall through uncaught to handleMessage's generic
      // handleUnexpectedError, which DOES stay retry-friendly (doesn't
      // fail the conversation) but with different, inconsistent wording
      // from every other honest-backpressure case in this same method.
      // Same framing here too — nothing committed yet, safe to just ask
      // again.
      if (err instanceof HofjApiError && err.retryable) {
        console.error("search failed (retryable):", err.status, err.detail.slice(0, 200));
        return this.say(state, { kind: "backpressure", state: "queued" });
      }
      throw err;
    }
    let ctx = classify(state.slots, candidates, state.rejectedProductIds, locationMatched);

    // Consumed exactly once — see runCollecting()'s doc for how it got
    // set. Only surfaced when it actually decided something (ctx.compromise
    // already null, i.e. otherwise an "exact" match): a genuine price/date
    // compromise on top takes priority in the reply rather than stacking
    // two disclosures into one message.
    if (ctx && ctx.compromise === null && state.budgetTierFromProfileDefault) {
      const labels = { smart: "economico", pro: "una via di mezzo", luxury: "il top di gamma" } as const;
      ctx = {
        ...ctx,
        category: "compromise",
        compromise: { kind: "budget_profile_default", requested: "", offered: labels[state.economicTierHint!] },
      };
    }
    state.budgetTierFromProfileDefault = false;

    // Nothing at all matched what was asked. Before giving up, try the
    // traveller's own historically-preferred sport (a real profile
    // signal — see householdSizeHint's doc, types.ts, for the same
    // pattern applied elsewhere — never a guess), same city/date/budget
    // otherwise. Bounded to fire only on this FIRST attempt (never when
    // `precededBy` is already set, i.e. never on a "rejected"/
    // "unavailable" retry) so a declined substitution doesn't loop into
    // offering another one — a second "no" here falls through to the
    // ordinary no_match path below, asking for more flexibility instead.
    // Giuseppe, 2026-09-15: simulate "non ho trovato questo, però ho
    // trovato quest'altro" using what we actually know about the
    // traveller — always disclosed as a compromise, never applied
    // silently, same precision policy as every other compromise here.
    if (!ctx && !precededBy && state.preferredSportHint && state.preferredSportHint !== state.slots.sport) {
      const altSlots: Slots = { ...state.slots, sport: state.preferredSportHint };
      try {
        const alt = await searchCandidates(this.hofj, altSlots, this.env);
        const altCtx = classify(altSlots, alt.candidates, state.rejectedProductIds, alt.locationMatched);
        if (altCtx) {
          ctx = {
            ...altCtx,
            category: "compromise",
            compromise: { kind: "sport_substituted", requested: state.slots.sport ?? "", offered: state.preferredSportHint },
          };
        }
      } catch (err) {
        if (!(err instanceof QuotaExhaustedError)) throw err;
        // Quota denial on this best-effort fallback attempt isn't fatal —
        // fall through to the ordinary no_match path below.
      }
    }

    if (!ctx) {
      state.stage = "collecting";
      return this.say(state, { kind: "no_match", precededBy, unavailableReason });
    }
    state.cityAskAttempts = 0;
    state.budgetAskAttempts = 0;
    state.proposal = ctx;
    state.stage = "proposing";
    // A new candidate means any cached description belongs to a different
    // product now — never answer a question about THIS proposal using
    // stale detail fetched for a previous, possibly rejected one.
    state.productDescription = null;
    // Same reasoning, for the real cart: any itineraryId/totalPrice on
    // state belongs to whatever candidate was open BEFORE this new one —
    // clearing them here is what makes openRealCartAndAttemptPayment's
    // reuse-on-reconfirm guard safe (their presence there always means
    // "this exact candidate", never a stale one from a rejected/
    // superseded proposal).
    state.itineraryId = null;
    state.brand = null;
    state.totalPrice = null;

    // A physical constraint, not a package mismatch — checked against
    // EVERY trip this same traveller already paid for earlier in this
    // conversation (see pastBookings' own doc, types.ts), not just the
    // most recent one. Best-available estimate of THIS candidate's own
    // dates at propose time, same fallback runProposing's "yes" branch
    // commits to for real once confirmed (candidate.minDate when the
    // traveller never gave an exact date).
    const newDateFrom = state.slots.dateFrom ?? ctx.candidate.minDate;
    const newDateTo = state.slots.dateTo ?? addDaysIso(newDateFrom, ctx.candidate.durationDays);
    const overlapping = state.pastBookings.find((b) => datesOverlap(newDateFrom, newDateTo, b.dateFrom, b.dateTo));
    state.lastDateOverlapWarning = overlapping ?? null;

    return this.say(state, {
      kind: "propose",
      ctx,
      precededBy,
      unavailableReason,
      adults: state.slots.adults!,
      dateOverlapWarning: overlapping,
    });
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
        // getProduct is priority P2 (optional, see ARCHITECTURE.md twist
        // Phase 2): cached with a long TTL (marketing text barely
        // changes), and a single non-blocking quota check with no retry —
        // under pressure this is worth skipping outright, same graceful
        // "" degrade already used for a real HOFJ error below, not worth
        // making the traveller wait for.
        const key = `product:${ctx.candidate.brand}:${ctx.candidate.productId}`;
        const detail = await cachedDiscoveryCall(key, DISCOVERY_TTL_MS.product, async () => {
          if (!(await acquireOptional(this.env))) throw new QuotaExhaustedError(0);
          return this.hofj.getProduct(ctx.candidate.productId, ctx.candidate.brand);
        });
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
      // Traveller data is collected up front now (see initialState()'s
      // doc) — by the time a proposal is accepted it's already complete
      // in the common case, so go straight to opening the real cart
      // instead of a separate post-proposal data-collection stage. Any
      // real surprise (date not really bookable, price different) now
      // lands right here, immediately after "sì, procedi" — not several
      // turns of already-sunk personal-data effort later (regression,
      // live session `60ff320a-...`: exactly that late-surprise pattern
      // is what prompted this reorder). Defensive fallback for the rare
      // case traveller data somehow still isn't complete.
      const missingTraveller = REQUIRED_TRAVELLER_FIELDS.find((f) => state.traveller[f] === null);
      if (missingTraveller) {
        state.stage = "collecting_traveller";
        return this.runCollectingTraveller(state);
      }
      return this.openRealCartAndAttemptPayment(state);
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
      // Whether this is literally the first thing said in the whole
      // conversation — computed from message count, not "are all
      // traveller fields still null", because a returning traveller's
      // profile can pre-fill some of them (see handleMessage's profile
      // seeding) and still have this be the very first question asked.
      // Only the traveller's own opening message exists at this point
      // (the agent's reply to it hasn't been pushed yet), hence <= 1.
      const isFirstAsk = state.messages.length <= 1;
      return this.say(state, { kind: "ask_traveller_field", field: missing, isFirstAsk });
    }
    // Traveller data just became complete. Two reasons this method can
    // be reached: (1) the very start of a fresh conversation (see
    // initialState()'s doc) — nothing decided yet, move on to the trip
    // itself; (2) resuming after a putCustomer/putPax validation error
    // wiped it mid-booking (see the `correction` branch below) — a
    // proposal is already accepted, so resume opening the real cart
    // instead of restarting trip negotiation from scratch.
    if (state.proposal) {
      return this.openRealCartAndAttemptPayment(state);
    }
    state.stage = "collecting";
    return this.runCollecting(state);
  }

  /** The real, money-real part of the pipeline: opens an actual HOFJ cart,
   * silently re-verifies price against the live snapshot, writes real
   * traveller data, then tries to get a Stripe payment intent. */
  private async openRealCartAndAttemptPayment(state: ConversationState): Promise<string> {
    // A quota-driven backpressure pause inside confirmBookingNow (below)
    // can re-enter this function on a LATER turn with the real cart and
    // real payment already done — re-running createItinerary from
    // scratch here would open a second cart and charge a second time.
    // Only this specific case (payment already succeeded) needs the
    // guard: a denial on createItinerary's OWN gate check below returns
    // before itineraryId is ever set, so that path always starts clean.
    if (state.itineraryId && state.paymentIntentId) {
      return this.confirmBookingNow(state, "full");
    }
    // A real cart for THIS SAME proposal already exists and was already
    // priced — e.g. reconfirming after a price_changed/date_shift_confirm
    // compromise, which both return here to re-run this method on the
    // traveller's next "yes". Reuse it instead of blindly recreating:
    // recreating wastes a call and, per two real live sessions
    // (`ab6d0bfa-...`, `60ff320a-...`), correlates with a putCustomer/
    // putPax 400 on the fresh duplicate cart — forcing a full
    // traveller-data reset right after the traveller already
    // reconfirmed, reproducing the exact late-interruption pattern
    // already fixed once this session (see the "collect traveller data
    // up front" reorder, above). `state.itineraryId`/`totalPrice` are
    // cleared in searchAndPropose whenever a genuinely NEW proposal
    // replaces the old one, so their presence here reliably means "same
    // candidate, already open" — never a stale reference to a rejected
    // or superseded one.
    if (state.itineraryId && state.totalPrice) {
      return this.putTravellerDataAndAttemptPayment(state);
    }

    const proposal = state.proposal!;
    const { candidate } = proposal;
    const brand = candidate.brand;
    const requestedDate = state.slots.dateFrom!;

    // createItinerary is priority P0 (booking-critical, see
    // ARCHITECTURE.md twist Phase 2) — worth a short bounded wait for
    // quota rather than failing outright, since nothing has been
    // committed yet if we give up (see acquireCriticalOrWait's doc).
    if (!(await acquireCriticalOrWait(this.env))) {
      return this.say(state, { kind: "backpressure", state: "queued" });
    }
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
        // Same candidate/productId, only the date shifts — a dedicated
        // directive (not the generic "propose") so this reads as an
        // adjustment to the already-chosen package, never as a fresh
        // pitch that could be mistaken for a different one (regression,
        // live 2026-09-15, session `60ff320a-...` — see ARCHITECTURE.md).
        return this.say(state, {
          kind: "date_shift_confirm",
          ctx: state.proposal,
          requestedDate,
          offeredDate: candidate.minDate,
        });
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
        // The real upstream detail, when we have one — same truncation
        // convention as the console.error calls elsewhere in this
        // function — so the traveller-facing message can state an
        // actual verified reason instead of always the generic
        // "problema del fornitore" (Giuseppe, 2026-09-15: a real package
        // switch needs a real reason, not just evidence that it
        // happened). Sometimes this IS a generic gateway string
        // ("error code: 502" — see this branch's own doc above); passing
        // it through anyway stays honest either way, never invented.
        return this.searchAndPropose(state, "unavailable", err.detail.slice(0, 200));
      }
      throw err;
    }
    state.itineraryId = created.data.itineraryId;
    state.brand = brand;

    // Gap found by Giuseppe, verified 2026-09-15, real and distinct from
    // the two earlier "product not bookable" false alarms (both turned
    // out to be the brand-mismatch bug, see createItinerary's own doc
    // above): a product whose OWN payment configuration is broken
    // server-side — createItinerary succeeds (a real cart genuinely
    // opens), but the very next read, this getItinerary, 502s with a
    // ZodError on paymentOptionsConfiguration.installmentPlans[0].deposit
    // ("Too small: expected number to be >0") — a permanent, per-product
    // data problem, not a transient one, and a DIFFERENT product on the
    // same brand read back fine, confirming it's not brand-wide. Without
    // this try/catch, that HofjApiError fell all the way through to
    // handleUnexpectedError, which treats a retryable HOFJ error as "the
    // system is slow, try again" — actively misleading here, since
    // retrying gets the exact same 502 every time. Same fallback
    // discipline already applied to createItinerary's own failure above:
    // reject this specific product, clear the cart we can no longer use,
    // and propose the next best candidate with the real reason.
    let snapshot;
    try {
      snapshot = await this.hofj.getItinerary(state.itineraryId, brand);
    } catch (err) {
      if (err instanceof HofjApiError) {
        console.error("getItinerary (post-create) failed:", err.status, err.detail.slice(0, 200));
        state.rejectedProductIds.push(candidate.productId);
        state.proposal = null;
        state.itineraryId = null;
        state.brand = null;
        state.stage = "collecting";
        return this.searchAndPropose(state, "unavailable", err.detail.slice(0, 200));
      }
      throw err;
    }
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
      // Set even though we're about to ask for reconfirmation, not
      // book yet: this IS the real, live-verified price for the cart
      // that's already open — recording it now (rather than only after
      // the check passes) is what lets openRealCartAndAttemptPayment's
      // reuse-on-reconfirm guard recognize this cart as already priced
      // on the traveller's next "yes", instead of recreating it.
      state.totalPrice = snapshot.data.totalPrice;
      return this.say(state, {
        kind: "price_changed",
        oldPrice: `${estimatedTotal}€`,
        newPrice: `${livePrice}€`,
      });
    }
    state.totalPrice = snapshot.data.totalPrice;

    return this.putTravellerDataAndAttemptPayment(state);
  }

  /** Submits the traveller's own data to an ALREADY-open, already-priced
   * cart and attempts payment — split out from openRealCartAndAttemptPayment
   * so it can be called both on the first pass (right after
   * createItinerary/getItinerary succeed) and when re-entering with an
   * existing cart already open (a price_changed/date_shift_confirm
   * reconfirmation — see that method's own reuse guard). `state.proposal`/
   * `state.itineraryId`/`state.brand`/`state.totalPrice` must already be
   * set and consistent with each other before calling this. */
  private async putTravellerDataAndAttemptPayment(state: ConversationState): Promise<string> {
    const candidate = state.proposal!.candidate;
    const brand = state.brand!;
    const traveller = state.traveller;
    try {
      await this.hofj.putCustomer(
        state.itineraryId!,
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
      await this.hofj.putPax(state.itineraryId!, pax, brand);
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
      // Any OTHER HofjApiError here (the exact "changePaxDetails.
      // paxNumberChanged" case flagged in the comment above arrived as a
      // generic 502, not 400) isn't about the traveller's data at all —
      // it's the product's own configuration. Re-asking for the same
      // name/email/phone would never fix that, it would just loop.
      // "Not every product is bookable... handle it" (the brief's own
      // words, per Giuseppe, 2026-09-15) — same fallback discipline
      // already applied to createItinerary's and getItinerary's own
      // failures: reject this specific product, clear the now-abandoned
      // cart, and propose the next best alternative with the real reason.
      if (err instanceof HofjApiError) {
        console.error("putCustomer/putPax failed (non-400, likely a product config problem):", err.status, err.detail.slice(0, 300));
        state.rejectedProductIds.push(candidate.productId);
        state.proposal = null;
        state.itineraryId = null;
        state.brand = null;
        state.stage = "collecting";
        return this.searchAndPropose(state, "unavailable", err.detail.slice(0, 200));
      }
      throw err;
    }

    return this.attemptPayment(state);
  }

  /** Gets HOFJ's OWN Stripe PaymentIntent for this itinerary and confirms
   * IT — not a PaymentIntent we mint ourselves. This is the corrected
   * flow per Carlo (Vela/HOFJ, email 2026-09-15): HOFJ's booking
   * confirmation is asynchronous, triggered when Stripe notifies HOFJ
   * that its own PaymentIntent was paid. An earlier version of this
   * method created a separate PaymentIntent directly under HOFJ's
   * Stripe account (the "sanctioned bypass", now removed from
   * stripe/client.ts) to work around GET .../payment being broken —
   * once that endpoint got fixed, the bypass silently became the actual
   * bug: a payment HOFJ's own webhook never sees, so `checkout.status`
   * stayed on "BookingInitiated" forever no matter how many times
   * confirmBooking was retried. Priority P0 (booking-critical, see
   * ARCHITECTURE.md twist Phase 2) — this is now on the critical path,
   * not an optional/discardable call. */
  private async attemptPayment(state: ConversationState): Promise<string> {
    if (!(await acquireCriticalOrWait(this.env))) {
      return this.say(state, { kind: "backpressure", state: "queued" });
    }
    if (!this.env.STRIPE_SECRET_KEY) {
      state.stage = "failed";
      state.failureReason = "payment: no payment path available (no Stripe key configured)";
      return this.say(state, { kind: "payment_unavailable", retrying: false });
    }
    let clientSecret: string;
    try {
      const intent = await this.hofj.getPaymentIntent(state.itineraryId!, state.brand!);
      clientSecret = intent.data;
    } catch (err) {
      state.stage = "failed";
      state.failureReason = `payment: getPaymentIntent — ${err instanceof HofjApiError ? `${err.status} ${err.detail.slice(0, 200)}` : err instanceof Error ? err.message : String(err)}`;
      return this.say(state, { kind: "payment_unavailable", retrying: false });
    }
    // Stripe client_secrets are "<paymentIntentId>_secret_<...>" — the id
    // is HOFJ's own PaymentIntent, the one its webhook is subscribed to.
    const paymentIntentId = clientSecret.split("_secret_")[0];
    if (!paymentIntentId) {
      state.stage = "failed";
      state.failureReason = `payment: unexpected client_secret shape: "${clientSecret.slice(0, 40)}"`;
      return this.say(state, { kind: "payment_unavailable", retrying: false });
    }
    try {
      // Confirms with Stripe's own official test card token — a
      // deliberate demo simplification (see stripe/client.ts's doc on
      // confirmPaymentIntent): a real production flow would hand this
      // same client_secret to the frontend for the actual cardholder to
      // confirm via Stripe Elements, never touch card details
      // server-side. There is no such frontend integration yet here.
      const confirmed = await confirmPaymentIntent(this.env, paymentIntentId);
      state.paymentIntentId = confirmed.id;
      state.paymentStatus = confirmed.status;
      // "full" because that's what we actually just did — charged the
      // entire total in one PaymentIntent, not a deposit.
      return this.confirmBookingNow(state, "full");
    } catch (err) {
      state.stage = "failed";
      state.failureReason = `payment: ${err instanceof Error ? err.message : String(err)}`;
      return this.say(state, { kind: "payment_unavailable", retrying: false });
    }
  }

  /** Confirms the real booking with HOFJ. Only ever called after a real
   * payment has already succeeded (either via a future Stripe.js frontend
   * confirming client-side — confirmPaymentAndBook() below — or via
   * attemptPayment() above), so every failure path here uses the
   * "bookings:" failureReason prefix, never "payment:" — retrying this
   * specific step should never re-charge anything.
   *
   * A 200 from POST /v1/bookings alone was read live 2026-09-14 ~22:10
   * as NOT sufficient proof of a real booking (an idempotency check on
   * the same itinerary that seemed to return different `data` values
   * across attempts — see ARCHITECTURE.md). Carlo (Vela/HOFJ, email
   * 2026-09-15) corrected the underlying model: `data` genuinely is the
   * saved reservation code (= itineraryId) by construction, and a 200
   * IS real persistence proof; the earlier different-values observation
   * most likely came from retries that weren't actually hitting the
   * same itinerary. `checkout.status` staying on "BookingInitiated",
   * though, was real — not because the 200 lies, but because HOFJ's
   * confirmation is asynchronous, gated on Stripe notifying HOFJ about
   * ITS OWN PaymentIntent (see getPaymentIntent's doc, hofj/client.ts,
   * for the fix). The check below stays regardless — it costs nothing
   * and stays honest either way, whether the remaining gap is a fixed
   * root cause finally converging or a genuinely slower webhook landing
   * a moment later — and requires `checkout.status` to have actually
   * moved away from "BookingInitiated" before ever telling the
   * traveller "booked" — the one signal that can't be faked by a
   * plausible-looking response. */
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
    // confirmBooking is priority P0 (booking-critical) same as
    // createItinerary — but this call is ALSO the idempotent upsert
    // itself (verified live, see this method's own doc above), so unlike
    // createItinerary a denial here is safe to just wait out and retry:
    // nothing new gets committed by waiting, and the eventual real call
    // converges correctly however many times it's ultimately retried.
    if (!(await acquireCriticalOrWait(this.env))) {
      return this.say(state, { kind: "backpressure", state: "retrying" });
    }
    try {
      const payment = state.paymentIntentId
        ? { paymentIntentId: state.paymentIntentId, paymentStatus: state.paymentStatus ?? "succeeded" }
        : undefined;
      const booking = await this.hofj.confirmBooking(state.itineraryId!, state.brand!, paymentType, payment);
      const snapshot = await this.hofj.getItinerary(state.itineraryId!, state.brand!);
      if (snapshot.data.checkout.status === "BookingInitiated") {
        state.stage = "failed";
        state.failureReason = `bookings: unverified — checkout.status still "BookingInitiated" after a 200 response`;
        // The real reservation code, by construction (Carlo, Vela/HOFJ,
        // email 2026-09-15) — set even though checkout.status can't
        // confirm it, since that confirmation is known-unreachable for a
        // B2B key, not a real unknown (see booking_unverified's own doc,
        // engine/ai.ts).
        state.reservationCode = state.itineraryId;
        await this.logFollowUpIfNeeded(state);
        return this.say(state, {
          kind: "booking_unverified",
          itineraryId: state.itineraryId!,
          totalPrice: `${state.totalPrice!.amount}${state.totalPrice!.currency === "EUR" ? "€" : " " + state.totalPrice!.currency}`,
        });
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
   * client-side. Currently unreachable in practice — attemptPayment()
   * confirms HOFJ's own PaymentIntent server-side itself (Stripe's
   * official test card token, see stripe/client.ts), never setting
   * stage="paying" — but implemented to spec so the last mile just works
   * the moment a real Stripe Elements integration exists in the
   * frontend and card confirmation genuinely needs to happen
   * client-side instead of server-side. */
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
