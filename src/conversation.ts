import { DurableObject } from "cloudflare:workers";
import { HofjApiError, HofjClient, type PaxPayload } from "./hofj/client";
import { AiUnavailableError, interpret, say, type SayDirective } from "./engine/ai";
import { extractMonthHint, resolveDate } from "./engine/dates";
import { classify, searchCandidates } from "./engine/matcher";
import { confirmPaymentIntent, createPaymentIntent } from "./stripe/client";
import {
  DEMO_TRAVELLER,
  EMPTY_SLOTS,
  type ConversationState,
  type Env,
  type Slots,
  type TravellerInfo,
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

function initialState(): ConversationState {
  return {
    stage: "collecting",
    language: null,
    slots: { ...EMPTY_SLOTS },
    // Stand-in for a real per-user profile (no login exists yet) — see
    // the doc on DEMO_TRAVELLER in types.ts. Every field here can still
    // be overridden by the traveller stating it explicitly at any point;
    // this is a default, not a lock.
    traveller: { ...DEMO_TRAVELLER },
    messages: [],
    proposal: null,
    rejectedProductIds: [],
    itineraryId: null,
    totalPrice: null,
    reservationCode: null,
    failureReason: null,
    cityAskAttempts: 0,
    budgetAskAttempts: 0,
  };
}

function mergeDefined<T extends object>(target: T, updates: Partial<T>): T {
  const out = { ...target };
  for (const [k, v] of Object.entries(updates)) {
    if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
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
  async handleMessage(text: string): Promise<HandleMessageResult> {
    let state = await this.loadState();
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
      const paymentRetryable = state.failureReason?.startsWith("payment:") && state.itineraryId;
      const bookingRetryable = state.failureReason?.startsWith("bookings:") && state.itineraryId;
      if (wantsRetry && paymentRetryable) {
        const reply = await this.attemptPayment(state);
        state.messages.push({ role: "agent", text: reply, at: Date.now() });
        await this.saveState(state);
        return { reply, state };
      }
      if (wantsRetry && bookingRetryable) {
        const reply = await this.confirmBookingNow(state, "plan");
        state.messages.push({ role: "agent", text: reply, at: Date.now() });
        await this.saveState(state);
        return { reply, state };
      }
      const reply = paymentRetryable
        ? `Il pagamento non è ancora disponibile. Dimmi "riprova" quando vuoi che ci riprovi, oppure apri una nuova conversazione.`
        : bookingRetryable
          ? `Il pagamento è andato a buon fine, ma non riesco ancora a confermare la prenotazione. Dimmi "riprova" per ritentare solo quella parte.`
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
      state.traveller = mergeDefined(state.traveller, interpretation.travellerUpdates);

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
          reply = await this.runProposing(state, interpretation.decision);
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
        if (!this.isGatingSatisfied(state, key)) return labels[key] ?? key;
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
      return this.say(state, { kind: "ask_slot", missing: key });
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
    return this.say(state, { kind: "propose", ctx, precededBy });
  }

  private async runProposing(state: ConversationState, decision: "yes" | "no" | "unclear"): Promise<string> {
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
        return this.say(state, { kind: "propose", ctx: state.proposal });
      }
      // Already on the candidate's own known-good minDate and it *still*
      // failed: this isn't a date problem, and retrying (the generic
      // "sistema lento, riprova" path) can never succeed — verified live,
      // this exact product/date/party-size combo 404ed upstream with
      // NOT_FOUND_ERROR even though it came back as a normal, well-formed
      // search result. Exactly the "prodotto non prenotabile" case the
      // brief warns about, just discovered at booking time instead of
      // search time. Reject this specific product and look for the next
      // best candidate instead of asking the traveller to retry something
      // that will never work.
      if (err instanceof HofjApiError) {
        state.rejectedProductIds.push(candidate.productId);
        state.proposal = null;
        state.stage = "collecting";
        return this.searchAndPropose(state, "unavailable");
      }
      throw err;
    }
    state.itineraryId = created.data.itineraryId;

    const snapshot = await this.hofj.getItinerary(state.itineraryId);
    const livePrice = Number(snapshot.data.totalPrice.amount);
    const proposedPrice = candidate.price;
    if (Math.abs(livePrice - proposedPrice) / proposedPrice > PRICE_CHANGE_TOLERANCE) {
      state.proposal = {
        ...proposal,
        candidate: { ...candidate, price: livePrice },
        category: "compromise",
        compromise: { kind: "price", requested: `${proposedPrice}€`, offered: `${livePrice}€` },
      };
      state.stage = "proposing";
      return this.say(state, {
        kind: "price_changed",
        oldPrice: `${proposedPrice}€`,
        newPrice: `${livePrice}€`,
      });
    }
    state.totalPrice = snapshot.data.totalPrice;

    const traveller = state.traveller;
    await this.hofj.putCustomer(state.itineraryId, {
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
    });
    // HOFJ auto-provisions one pax slot per adult on the itinerary the
    // moment it's created (verified live: a 2-adult itinerary already has
    // "pax-1"/"pax-2" in its snapshot before this call). Sending fewer pax
    // records than that reads upstream as *changing* paxNumber, not just
    // filling in names, and 400s (surfaced through the gateway as a
    // generic 502) with detail
    // "changePaxDetails.paxNumberChanged" — verified live with 2 adults
    // and a single pax-1 entry. We only collect one real traveller's name
    // in this demo scope, so companions beyond the first get a bare refId,
    // matching the empty stub HOFJ itself already creates for them.
    const pax: PaxPayload[] = Array.from({ length: state.slots.adults! }, (_, i) =>
      i === 0 ? { refId: "pax-1", firstName: traveller.firstName!, lastName: traveller.lastName! } : { refId: `pax-${i + 1}` },
    );
    await this.hofj.putPax(state.itineraryId, pax);

    return this.attemptPayment(state);
  }

  private async attemptPayment(state: ConversationState): Promise<string> {
    try {
      await this.hofj.getPaymentIntent(state.itineraryId!);
      // Would hand the client_secret to the frontend for Stripe.js here;
      // left for confirmPaymentAndBook() to be invoked once Stripe confirms
      // client-side. See ARCHITECTURE.md — untestable while the upstream
      // payment endpoint 502s, kept spec-correct for when it recovers.
      state.stage = "paying";
      return this.say(state, { kind: "payment_unavailable", retrying: true });
    } catch (err) {
      if (err instanceof HofjApiError) {
        console.error("getPaymentIntent failed:", err.status, err.detail.slice(0, 200));
      }
      // HOFJ's own payment-intent refresh is broken (502, upstream 405).
      // Vela confirmed (Carlo, 2026-09-15) that creating the PaymentIntent
      // directly against their Stripe account is the *sanctioned* bypass
      // for this, not a workaround we invented unilaterally — see
      // stripe/client.ts and ARCHITECTURE.md.
      if (this.env.STRIPE_SECRET_KEY) {
        return this.attemptDirectStripePayment(state);
      }
      state.stage = "failed";
      state.failureReason = err instanceof HofjApiError ? `payment: ${err.message}` : String(err);
      return this.say(state, { kind: "payment_unavailable", retrying: false });
    }
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
      await confirmPaymentIntent(this.env, intent.id);
      // Real payment succeeded. Now try the actual booking confirmation —
      // verified live (2026-09-15) that HOFJ's gateway drops the required
      // paymentType field regardless of value ("full" and "plan" both
      // 400 identically), so this is very likely to fail too, but it's
      // their bug, worth attempting for real every time in case it's
      // fixed mid-session (shared backend, can change without notice).
      // "plan" first per Carlo's tip: the one real production product he
      // pointed at uses a deposit/plan model, not full payment.
      return this.confirmBookingNow(state, "plan");
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
   * specific step should never re-charge anything. */
  private async confirmBookingNow(state: ConversationState, paymentType: "full" | "plan"): Promise<string> {
    try {
      const booking = await this.hofj.confirmBooking(state.itineraryId!, paymentType);
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
        return this.say(state, { kind: "booking_forbidden" });
      }
      state.failureReason = `bookings: ${err instanceof Error ? err.message : String(err)}`;
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
