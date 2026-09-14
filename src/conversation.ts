import { DurableObject } from "cloudflare:workers";
import { HofjApiError, HofjClient } from "./hofj/client";
import { AiUnavailableError, interpret, say } from "./engine/ai";
import { resolveDate } from "./engine/dates";
import { classify, searchCandidates } from "./engine/matcher";
import {
  EMPTY_SLOTS,
  EMPTY_TRAVELLER,
  type ConversationState,
  type Env,
  type Slots,
  type TravellerInfo,
} from "./types";

const REQUIRED_TRIP_SLOTS: (keyof Pick<Slots, "sport" | "city" | "dateFrom" | "budget">)[] = [
  "sport",
  "city",
  "dateFrom",
  "budget",
];

const REQUIRED_TRAVELLER_FIELDS: (keyof TravellerInfo)[] = ["firstName", "lastName", "email", "phone", "city"];

const PRICE_CHANGE_TOLERANCE = 0.01; // 1% — floating point / rounding noise only

function initialState(): ConversationState {
  return {
    stage: "collecting",
    slots: { ...EMPTY_SLOTS },
    traveller: { ...EMPTY_TRAVELLER },
    messages: [],
    proposal: null,
    rejectedProductIds: [],
    itineraryId: null,
    totalPrice: null,
    reservationCode: null,
    failureReason: null,
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

    // The HOFJ inventory/backend is shared and can change mid-session (the
    // brief flags this explicitly) — a payment failure specifically is
    // exactly the transient-looking case worth letting the traveller
    // retry, without starting a whole new conversation/cart. A bookings
    // permission failure (403) is not: retrying won't fix a missing
    // entitlement, so that one stays terminal.
    if (state.stage === "failed") {
      const retryable = state.failureReason?.startsWith("payment:") && state.itineraryId;
      const wantsRetry = /riprova|di nuovo|ritenta|prova ancora|retry/i.test(text);
      if (retryable && wantsRetry) {
        const reply = await this.attemptPayment(state);
        state.messages.push({ role: "agent", text: reply, at: Date.now() });
        await this.saveState(state);
        return { reply, state };
      }
      const reply = retryable
        ? `Il pagamento non è ancora disponibile. Dimmi "riprova" quando vuoi che ci riprovi, oppure apri una nuova conversazione.`
        : `Questa conversazione si è fermata per un problema tecnico (${state.failureReason ?? "errore"}). Apri una nuova conversazione per riprovare.`;
      state.messages.push({ role: "agent", text: reply, at: Date.now() });
      await this.saveState(state);
      return { reply, state };
    }

    let reply: string;
    try {
      const interpretation = await interpret(this.env, state.slots, state.traveller, text);
      const { dateFromText, dateToText, ...slotUpdates } = interpretation.slotUpdates as Record<string, unknown>;
      const resolvedDates: Partial<Slots> = {};
      if (typeof dateFromText === "string") resolvedDates.dateFrom = resolveDate(dateFromText);
      if (typeof dateToText === "string") resolvedDates.dateTo = resolveDate(dateToText);
      state.slots = mergeDefined(state.slots, { ...slotUpdates, ...resolvedDates } as Partial<Slots>);
      state.traveller = mergeDefined(state.traveller, interpretation.travellerUpdates);

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
          reply = await say(this.env, { kind: "no_match" });
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

  private firstMissingTripSlot(slots: Slots): (typeof REQUIRED_TRIP_SLOTS)[number] | null {
    for (const key of REQUIRED_TRIP_SLOTS) {
      if (slots[key] === null) return key;
    }
    return null;
  }

  private async runCollecting(state: ConversationState): Promise<string> {
    const missing = this.firstMissingTripSlot(state.slots);
    if (missing) {
      return say(this.env, { kind: "ask_slot", missing });
    }
    return this.searchAndPropose(state);
  }

  private async searchAndPropose(state: ConversationState): Promise<string> {
    const candidates = await searchCandidates(this.hofj, state.slots);
    const ctx = classify(state.slots, candidates, state.rejectedProductIds);
    if (!ctx) {
      state.stage = "collecting";
      return say(this.env, { kind: "no_match" });
    }
    state.proposal = ctx;
    state.stage = "proposing";
    return say(this.env, { kind: "propose", ctx });
  }

  private async runProposing(state: ConversationState, decision: "yes" | "no" | "unclear"): Promise<string> {
    if (decision === "yes" && state.proposal) {
      state.stage = "collecting_traveller";
      // Traveller info may already be filled from an earlier attempt (e.g.
      // a price-changed re-confirmation loop) — don't re-ask what we
      // already have, go straight to opening the cart if it's complete.
      return this.runCollectingTraveller(state);
    }
    if (decision === "no" && state.proposal) {
      state.rejectedProductIds.push(state.proposal.candidate.productId);
      state.proposal = null;
    }
    // "no" -> try the next best candidate; "unclear" -> re-evaluate in case
    // the traveller changed a slot (budget/date/city) without an explicit yes/no.
    return this.searchAndPropose(state);
  }

  private async runCollectingTraveller(state: ConversationState): Promise<string> {
    const missing = REQUIRED_TRAVELLER_FIELDS.find((f) => state.traveller[f] === null);
    if (missing) {
      return say(this.env, { kind: "ask_traveller_field", field: missing });
    }
    return this.openRealCartAndAttemptPayment(state);
  }

  /** The real, money-real part of the pipeline: opens an actual HOFJ cart,
   * silently re-verifies price against the live snapshot, writes real
   * traveller data, then tries to get a Stripe payment intent. */
  private async openRealCartAndAttemptPayment(state: ConversationState): Promise<string> {
    const proposal = state.proposal!;
    const { candidate } = proposal;

    const created = await this.hofj.createItinerary({
      productId: candidate.productId,
      startDate: state.slots.dateFrom!,
      adults: state.slots.adults,
      rooms: 1,
    });
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
      return say(this.env, {
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
    await this.hofj.putPax(state.itineraryId, [
      { refId: "pax-1", firstName: traveller.firstName!, lastName: traveller.lastName! },
    ]);

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
      return say(this.env, { kind: "payment_unavailable", retrying: true });
    } catch (err) {
      state.stage = "failed";
      state.failureReason = err instanceof HofjApiError ? `payment: ${err.message}` : String(err);
      return say(this.env, { kind: "payment_unavailable", retrying: false });
    }
  }

  /** Invoked by the frontend once Stripe.js confirms the card payment
   * client-side. Currently unreachable in practice — attemptPayment() never
   * reaches "paying" while GET .../payment 502s — but implemented to spec
   * so the last mile just works the moment that upstream bug is fixed. */
  async confirmPaymentAndBook(): Promise<HandleMessageResult> {
    const state = await this.loadState();
    if (state.stage !== "paying" || !state.itineraryId) {
      const reply = "Non c'è un pagamento in corso da confermare per questa conversazione.";
      return { reply, state };
    }
    let reply: string;
    try {
      const booking = await this.hofj.confirmBooking(state.itineraryId);
      state.stage = "booked";
      state.reservationCode = booking.data;
      reply = await say(this.env, {
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
        reply = await say(this.env, { kind: "booking_forbidden" });
      } else {
        state.failureReason = err instanceof Error ? err.message : String(err);
        reply = await say(this.env, { kind: "payment_unavailable", retrying: false });
      }
    }
    state.messages.push({ role: "agent", text: reply, at: Date.now() });
    await this.saveState(state);
    return { reply, state };
  }
}
