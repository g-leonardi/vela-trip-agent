import type { Env, ProposalContext, Slots, TravellerInfo } from "../types";

const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

function extractJson<T>(raw: string): T | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export class AiUnavailableError extends Error {}

// Workers AI occasionally throws a transient "internal error" (observed
// live, not model-specific — happens across models). Not worth failing an
// entire conversation over, so retry a couple of times before falling back
// / giving up — same spirit as the HOFJ client's retry-once-on-transient.
//
// Error 4006 is different: it means the daily free neuron allocation is
// exhausted (hit for real on 2026-09-14 after the k6 load test — see
// ARCHITECTURE.md). That's not transient within the day, so retrying is
// pure wasted latency — fail straight to the Anthropic fallback instead.
function isQuotaExhausted(err: unknown): boolean {
  return err instanceof Error && err.message.includes("4006");
}

async function runWorkersAi(env: Env, system: string, user: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await env.AI.run(WORKERS_AI_MODEL, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.3,
      });
      const shaped = res as { response?: unknown; choices?: { message?: { content?: string } }[] };
      const text =
        typeof shaped.response === "string" ? shaped.response : shaped.choices?.[0]?.message?.content;
      if (typeof text === "string" && text.trim().length > 0) return text;
      throw new Error("empty Workers AI response: " + JSON.stringify(res).slice(0, 300));
    } catch (err) {
      lastErr = err;
      console.error(`Workers AI attempt ${attempt + 1}/3 failed:`, err instanceof Error ? err.message : err);
      if (isQuotaExhausted(err)) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function chat(env: Env, system: string, user: string): Promise<string> {
  try {
    return await runWorkersAi(env, system, user);
  } catch (err) {
    if (!env.ANTHROPIC_API_KEY) throw new AiUnavailableError(err instanceof Error ? err.message : String(err));
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 512,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new AiUnavailableError(`Anthropic fallback failed: ${res.status}`);
    const body = await res.json<{ content: { text: string }[] }>();
    return body.content.map((b) => b.text).join("");
  }
}

interface RawInterpretation {
  slotUpdates: Partial<Omit<Slots, "dateFrom" | "dateTo" | "dateFromVague" | "preferredMonth">> & {
    dateFromText?: string | null;
    dateToText?: string | null;
  };
  travellerUpdates: Partial<TravellerInfo>;
  decision: "yes" | "no" | "unclear" | "question";
  /** A human-readable language name ("italiano", "English", "español"...)
   * — only set when it's clear or has changed, so it doesn't get
   * re-detected (and re-spent) every single turn. Null keeps whatever
   * language the conversation already settled into. */
  language: string | null;
}

const INTERPRET_SYSTEM = `Sei il modulo di comprensione di un agente di prenotazione viaggi sportivi (padel/tennis + hotel).
Ricevi l'ultimo messaggio del viaggiatore e lo stato attuale noto. Estrai SOLO ciò che è esplicitamente detto o chiaramente implicito, senza inventare.
Rispondi ESCLUSIVAMENTE con un oggetto JSON, nessun testo prima o dopo, con questa forma esatta:
{
  "slotUpdates": { "sport": "tennis"|"padel"|null, "city": string|null, "dateFromText": string|null, "dateToText": string|null, "budget": number|null, "budgetTier": "low"|"mid"|"high"|null, "adults": number|null, "preferences": string|null },
  "travellerUpdates": { "firstName": string|null, "lastName": string|null, "email": string|null, "phone": string|null, "city": string|null, "postalCode": string|null, "countryCode": string|null },
  "decision": "yes"|"no"|"unclear"|"question",
  "language": string|null
}
Regole:
- Includi in slotUpdates/travellerUpdates SOLO i campi che il messaggio cambia davvero; i campi non menzionati restano null.
- "dateFromText"/"dateToText": copia LETTERALMENTE la frase di data così come l'ha detta il viaggiatore, NELLA LINGUA in cui l'ha detta (es. "il 25 settembre", "next weekend", "in three days") — NON tradurla, NON calcolare tu la data, non convertirla in formato ISO, non inventare l'anno: quello lo fa un altro modulo deterministico che riconosce sia italiano sia inglese.
- "budget" e "adults" NON vanno MAI inventati o stimati, nemmeno quando sembra ovvio dal contesto — sono gli UNICI due campi che il viaggiatore deve dire esplicitamente (con un numero, o con "budgetTier" per il budget — vedi sotto), altrimenti vanno richiesti. Per "adults" conta le persone se il viaggiatore le nomina o implica chiaramente il numero ("io e mia moglie" = 2, "siamo in quattro" = 4, "da solo" = 1, "I'm going with Francesca" = 2) — ma se dice qualcosa di non numerabile ("tutta la famiglia", "un gruppo di amici" senza numero), lascia "adults" a null: verrà chiesto un numero preciso, non va indovinato.
- "budget" è SEMPRE da intendersi A PERSONA (decisione esplicita di Giuseppe, 2026-09-15). Un numero dato senza altra specifica ("budget 500", "500 euro") ha ESATTAMENTE lo stesso significato di "500 euro a persona"/"500 a testa" — nessuna differenza, non chiedere conferma in questo caso. Se invece il viaggiatore specifica chiaramente che è un totale per TUTTO il gruppo insieme (es. "1000 in totale", "1000 per tutti e due", "il nostro budget di coppia è 1000", "1000 for the both of us") — un concetto diverso, non convertibile con sicurezza senza sapere già quante persone — lascia "budget" a null: verrà chiesta esplicitamente la cifra a persona invece di indovinare una divisione.
- "budgetTier": il viaggiatore può rispondere alla domanda sul budget in modo qualitativo invece che con un numero — è una risposta vera, non un budget mancante. Espressioni come "economico", "il minimo", "niente di esagerato", "spendere poco", "cheap" → "low". Espressioni come "carino ma non troppo caro", "nella media", "niente di esagerato ma neanche il più economico", "nice, but not crazy expensive", "reasonable" → "mid" (NON "low": non sta chiedendo il più economico, sta chiedendo qualcosa di ragionevole). Espressioni come "il top", "il meglio", "senza badare a spese", "budget illimitato", "money is no object" → "high". Se il viaggiatore dà un numero, usa "budget" e lascia "budgetTier" a null (sono alternativi, non vanno riempiti entrambi). Se non dice né un numero né un giudizio qualitativo, lascia entrambi a null — NON inventare mai un numero specifico da un giudizio qualitativo.
- "decision" riflette se il messaggio è un assenso (sì, va bene, procedi, perfetto, ok..., yes, sure, sounds good) o un rifiuto/richiesta di alternativa (no, troppo caro, un'altra città..., that's too expensive) rispetto a una proposta o domanda che potrebbe essere stata fatta. Se invece il viaggiatore sta facendo una DOMANDA informativa sulla proposta appena fatta (es. "cosa include il pacchetto?", "com'è l'hotel?", "posso cancellare?", "what's included?") — non un sì/no, una vera richiesta di sapere di più — usa "question". Se il messaggio non è nessuno di questi (es. sta solo dando un'informazione su un altro aspetto del viaggio), usa "unclear".
- Se ricevi "Stai chiedendo in questo momento: ...", usalo per capire a quale campo appartiene una risposta breve e ambigua (es. "Milano" da solo). "città" compare sia nel viaggio (slotUpdates.city, la destinazione) sia nei dati del viaggiatore (travellerUpdates.city, dove abita) — sono DUE campi diversi, non confonderli: se stai chiedendo la città di residenza del viaggiatore, la risposta va SOLO in travellerUpdates.city, MAI in slotUpdates.city (la destinazione del viaggio è già decisa a quel punto e non va toccata).
- "language": il nome della lingua in cui il viaggiatore sta scrivendo ADESSO, in italiano (es. "italiano", "inglese", "spagnolo", "francese", "tedesco"...). Valorizzalo solo se il messaggio è abbastanza lungo/chiaro da capirlo con sicurezza, o se sembra diverso dalla lingua usata nei messaggi precedenti (cambio di lingua a metà conversazione) — altrimenti lascialo null, non serve ripeterlo ogni turno.`;

/** See Env.STUB_MODE's doc, types.ts. Deterministic and text-independent
 * on purpose: the load test this feeds (loadtest/scale-50k.js) exists to
 * stress THIS Worker's own architecture (DO fan-out, the quota gate,
 * caching/coalescing) under 50k concurrent travellers, not to re-test NLU
 * — so the canned values are fixed and chosen to be internally consistent
 * with hofj/client.ts's own stub responses (same 250€/person price, same
 * 2 adults → 500€ total) precisely so the stubbed conversation reaches
 * "booked" in the minimum number of turns, without ever tripping the
 * (real, correct) price-changed/compromise logic that has nothing to do
 * with what this load test measures. Fills every still-missing field in
 * ONE response — both trip slots and traveller fields — rather than
 * one-per-turn, since a realistic per-turn UX pace isn't what's being
 * tested here either. */
function stubInterpret(currentSlots: Slots, currentTraveller: TravellerInfo): RawInterpretation {
  return {
    slotUpdates: {
      sport: currentSlots.sport ?? "tennis",
      city: currentSlots.city ?? "Roma",
      dateFromText: currentSlots.dateFrom ? undefined : "25 settembre 2026",
      budget: currentSlots.budget ?? 300,
      adults: currentSlots.adults ?? 2,
    },
    travellerUpdates: {
      firstName: currentTraveller.firstName ?? "Load",
      lastName: currentTraveller.lastName ?? "Test",
      email: currentTraveller.email ?? "loadtest@example.com",
      phone: currentTraveller.phone ?? "0000000000",
      city: currentTraveller.city ?? "Milano",
    },
    decision: "yes",
    language: null,
  };
}

export async function interpret(
  env: Env,
  currentSlots: Slots,
  currentTraveller: TravellerInfo,
  latestUserText: string,
  currentlyAsking: string | null = null,
): Promise<RawInterpretation> {
  if (env.STUB_MODE === "1") return stubInterpret(currentSlots, currentTraveller);
  // "city" exists on both slots (trip destination) and traveller (billing
  // address) — without knowing which question was just asked, a bare
  // answer like "Milano" is genuinely ambiguous. Verified live: this
  // caused the traveller's real destination to get silently overwritten
  // by their billing city on one turn, and on a later turn (after slots
  // become locked once the trip is confirmed — see conversation.ts) the
  // answer was dropped entirely because the model put it in the now-
  // discarded slotUpdates.city instead of travellerUpdates.city. Passing
  // what's actually being asked resolves the ambiguity at the source
  // instead of only guarding against its worst consequence.
  const askContext = currentlyAsking ? `\nStai chiedendo in questo momento: ${currentlyAsking}` : "";
  const user = `Stato attuale: ${JSON.stringify({ slots: currentSlots, traveller: currentTraveller })}${askContext}\nMessaggio del viaggiatore: "${latestUserText}"`;
  const raw = await chat(env, INTERPRET_SYSTEM, user);
  const parsed = extractJson<RawInterpretation>(raw);
  return (
    parsed ?? {
      slotUpdates: {},
      travellerUpdates: {},
      decision: "unclear",
      language: null,
    }
  );
}

export type SayDirective =
  | {
      kind: "ask_slot";
      missing: "sport" | "city" | "dateFrom" | "budget" | "adults";
      /** A profile-derived default for THIS specific slot (household size
       * for "adults", the economic tier's own label for "budget") — never
       * silently applied, only folded into the question as something to
       * confirm or correct ("di solito siete in 3, ancora così?"). See
       * ConversationState.householdSizeHint/economicTierHint, types.ts. */
      hint?: string;
    }
  | {
      kind: "propose";
      ctx: ProposalContext;
      precededBy?: "rejected" | "unavailable";
      /** The real, verified upstream detail when `precededBy ===
       * "unavailable"` and we actually have one (see HofjApiError.detail,
       * openRealCartAndAttemptPayment in conversation.ts) — never a
       * fabricated cause. Same honesty discipline as `price_changed`'s
       * own `reason` field: state it, translated into plain terms, when
       * we truly have it; explicitly told not to invent one when we
       * don't (Giuseppe, 2026-09-15: switching to a different package
       * must come with real evidence AND a real reason, not a vague
       * "problema del fornitore" every time). */
      unavailableReason?: string;
      /** Real party size, already known before any proposal is ever made
       * (adults is never asked-then-bypassed — see the precision policy,
       * ARCHITECTURE.md). Used to surface an upfront estimated total for
       * the traveller's actual group size, not just candidate.price alone
       * — verified live 2026-09-15 that candidate.price comes from
       * search(), which never sends adults at all, so it reflects the
       * package's own default occupancy, not necessarily the real total.
       * Framed as an ESTIMATE, never a confirmed number — the real cart,
       * opened only after confirmation, still re-verifies for real. */
      adults: number;
    }
  | {
      kind: "answer_proposal_question";
      question: string;
      ctx: ProposalContext;
      /** The proposed product's own marketing description (see
       * HofjClient.getProduct) — the only source of truth for anything
       * beyond price/dates/duration, which are already in `ctx`. Null
       * when the lookup failed or the product has none; the answer must
       * still be honest about that, never invent detail to fill the
       * gap. */
      description: string | null;
    }
  | {
      kind: "ask_traveller_field";
      field: keyof TravellerInfo;
      isFirstAsk: boolean;
      /** Set when re-collecting from scratch because the fornitore
       * rejected one of the previous answers (regression found live
       * 2026-09-14: a malformed email killed the whole booking with no
       * explanation) — the traveller deserves to know why they're being
       * asked the same things again, not experience a silent restart. */
      correction?: boolean;
    }
  | { kind: "reverifying" }
  | {
      /** The candidate's originally-requested date turned out not to be a
       * real bookable slot when the cart actually opened — same product,
       * only the date shifts. A DIFFERENT directive from "propose"
       * (which is also used when a genuinely different product is being
       * pitched fresh) specifically so the traveller is never left
       * wondering "wait, is this a different package now?" — verified
       * live 2026-09-15 (Giuseppe, session `60ff320a-...`): re-using the
       * full "propose" pitch for this case read exactly like a new
       * package being offered, even though candidate.productId never
       * changed. See ARCHITECTURE.md. */
      kind: "date_shift_confirm";
      ctx: ProposalContext;
      requestedDate: string;
      offeredDate: string;
    }
  | {
      kind: "price_changed";
      oldPrice: string;
      newPrice: string;
      /** The REAL, verified cause when we know it (see
       * openRealCartAndAttemptPayment, conversation.ts) — e.g. the price
       * scaling with party size. Only ever set from something actually
       * checked, never a guess. */
      reason?: string;
    }
  | { kind: "payment_unavailable"; retrying: boolean }
  | {
      /** HOFJ's shared quota (120 req/min, verified live 2026-09-15) is
       * momentarily exhausted — see hofj/quotaGate.ts and
       * ARCHITECTURE.md's scalability twist section. Never a bare
       * failure: "queued" means nothing has happened yet and is safe to
       * retry (e.g. the traveller's own message again in a few seconds);
       * "retrying" means the system itself is already waiting and will
       * try again automatically without the traveller needing to do
       * anything. */
      kind: "backpressure";
      state: "queued" | "retrying";
    }
  | { kind: "booking_forbidden" }
  | { kind: "booking_unverified" }
  | { kind: "booked"; reservationCode: string; title: string; totalPrice: string; startDate: string }
  | { kind: "no_match"; precededBy?: "rejected" | "unavailable"; unavailableReason?: string };

function buildSaySystem(language: string | null): string {
  return `Sei la voce di un agente di prenotazione viaggi sportivi (padel/tennis + hotel), pensato per essere ascoltato più che letto: l'interazione è vocale, il viaggiatore potrebbe non guardare uno schermo. Parla in modo naturale, caldo, diretto, come faresti al telefono.
Regole ferree:
- UN SOLO messaggio breve (1-3 frasi), MAI un elenco, MAI più di una proposta/opzione alla volta.
- Usa SOLO i fatti forniti nell'istruzione — non inventare prezzi, date o dettagli.
- Se c'è un compromesso (prezzo o data diversi da quanto chiesto), dillo esplicitamente e chiedi conferma, sul modello: "non riesco a X, riesco a Y, procedo?".
- Rispondi in ${language ?? "italiano"}, tono colloquiale ma professionale — indipendentemente dalla lingua in cui è scritta questa istruzione (l'istruzione è sempre in italiano, la tua risposta al viaggiatore no).
- Se la proposta è "exact" (nessun compromesso), presenta la proposta con entusiasmo misurato e chiedi conferma.
- MAI aprire il messaggio con una formula fissa tipo "Per completare la prenotazione mi servono i tuoi dati" o "Per procedere ho bisogno di..." — varia sempre l'attacco della frase, come faresti davvero parlando con una persona invece di leggere un modulo. Non spiegare il perché di una domanda se l'hai già spiegato poco prima nella stessa conversazione.`;
}

function directiveToInstruction(d: SayDirective): string {
  switch (d.kind) {
    case "ask_slot": {
      const labels: Record<typeof d.missing, string> = {
        sport: "che sport vuole praticare (tennis o padel)",
        city: "in che città o zona vuole andare",
        dateFrom: "quando vuole partire",
        budget: "qual è il budget indicativo A PERSONA (specifica che è a testa, non per il gruppo intero)",
        adults: "in quante persone viaggia",
      };
      if (d.hint) {
        return `Chiedi al viaggiatore, in una frase breve, ${labels[d.missing]} — ma sai già, dal suo profilo, che di solito è "${d.hint}": proponilo come ipotesi da confermare o correggere per QUESTO viaggio specifico (es. "come al solito ${d.hint}, giusto?"), non darlo per scontato senza chiedere.`;
      }
      return `Chiedi al viaggiatore, in una frase breve, ${labels[d.missing]}. Non chiedere altro insieme.`;
    }
    case "propose": {
      const { candidate, category, compromise } = d.ctx;
      const currencySuffix = candidate.currency === "EUR" ? "€" : " " + candidate.currency;
      const lead =
        d.precededBy === "rejected"
          ? "Il viaggiatore ha rifiutato la proposta precedente. Riconoscilo con una parola o due (non una frase intera a sé) e poi, nello stesso messaggio, "
          : d.precededBy === "unavailable"
            ? d.unavailableReason
              ? `Il pacchetto proposto prima non risulta più prenotabile per davvero. Il fornitore segnala questo motivo tecnico, verificato: "${d.unavailableReason}" — traducilo in termini comprensibili per un viaggiatore (mai il gergo tecnico letterale), poi, nello stesso messaggio, `
              : "Il pacchetto proposto prima non risulta più prenotabile per davvero (un problema del fornitore — il motivo esatto non è disponibile, quindi NON inventarne uno plausibile). Diglielo con onestà in breve e poi, nello stesso messaggio, "
            : "";
      // Verified live 2026-09-15 (Giuseppe, dopo aver notato il prezzo
      // che raddoppiava): search() non manda mai `adults`, quindi
      // candidate.price riflette l'occupazione di default del pacchetto,
      // non necessariamente il totale reale per la comitiva. Dirlo già
      // nella prima proposta — non solo dopo, quando il carrello si apre
      // — così non c'è più un "il prezzo è raddoppiato" a sorpresa in un
      // secondo momento: il viaggiatore sa già, da subito, per quante
      // persone sta prenotando e quanto ci si aspetta di pagare in
      // totale. Framed come STIMA, mai come cifra già certa — la
      // ri-verifica reale all'apertura del carrello resta comunque.
      const priceNote =
        d.adults > 1
          ? ` Il prezzo indicato (${candidate.price}${currencySuffix}) è a persona/per l'occupazione base del pacchetto — per la vostra comitiva di ${d.adults} persone il totale STIMATO è ${candidate.price * d.adults}${currencySuffix} (te lo confermo per certo solo quando apro davvero la prenotazione). Menziona ENTRAMBI i numeri con naturalezza, non solo il prezzo a persona.`
          : "";
      const base = `${lead}Proponi ESATTAMENTE questo pacchetto, uno solo: "${candidate.title}" a ${candidate.venue}, ${candidate.city}, prezzo ${candidate.price}${currencySuffix}, ${candidate.durationDays} giorni, disponibile tra ${candidate.minDate} e ${candidate.maxDate}.${priceNote}`;
      if (category === "exact") return `${base} Corrisponde esattamente a quanto chiesto. Chiedi conferma per procedere.`;
      const c = compromise!;
      if (c.kind === "date_unspecified") {
        return `${base} Il viaggiatore non ha dato una data precisa (ha detto qualcosa di vago tipo un periodo o un mese). Diglielo con naturalezza — non è un problema, hai semplicemente scelto per lui la prima disponibilità utile, il ${c.offered} — e chiedi conferma o se preferisce specificare un'altra data.`;
      }
      if (c.kind === "location_unspecified") {
        const askedFor = c.requested ? `aveva detto "${c.requested}" (non abbastanza preciso per trovare qualcosa lì)` : "non ha specificato una città o zona precisa";
        return `${base} Il viaggiatore ${askedFor}. Hai scelto tu ${candidate.city} come destinazione — diglielo con naturalezza, non è un problema, e chiedi conferma o se preferisce indicare un'altra città.`;
      }
      if (c.kind === "budget_unspecified") {
        return `${base} Il viaggiatore non ti ha mai detto un budget. Diglielo con naturalezza — non è un problema, hai scelto tu il pacchetto più economico tra quelli pertinenti, a ${c.offered} — e chiedi conferma o se preferisce dirti un budget preciso.`;
      }
      return `${base} ATTENZIONE: c'è uno scostamento su ${c.kind === "price" ? "prezzo" : "data"} — il viaggiatore voleva ${c.requested}, tu puoi offrire ${c.offered}${c.kind === "price" ? " (entrambe le cifre sono A PERSONA, come il suo budget dichiarato)" : ""}. Dillo chiaramente nello stile "non riesco a ${c.requested}, riesco a ${c.offered}, procedo?" e chiedi conferma esplicita.`;
    }
    case "answer_proposal_question": {
      const { candidate } = d.ctx;
      const facts = `Titolo: "${candidate.title}", venue ${candidate.venue}, città ${candidate.city}, prezzo ${candidate.price}${candidate.currency === "EUR" ? "€" : " " + candidate.currency}, ${candidate.durationDays} giorni, date disponibili tra ${candidate.minDate} e ${candidate.maxDate}.`;
      const descriptionBlock = d.description
        ? `Descrizione ufficiale del pacchetto (unica fonte per qualunque dettaglio oltre ai fatti sopra): """${d.description}"""`
        : `Nessuna descrizione dettagliata disponibile per questo pacchetto oltre ai fatti sopra.`;
      return `Il viaggiatore ha fatto questa domanda sulla proposta appena fatta: "${d.question}"
Fatti noti: ${facts}
${descriptionBlock}
Rispondi alla domanda usando SOLO queste informazioni — se la descrizione non copre esattamente quello che chiede, dillo onestamente ("non ho il dettaglio esatto su questo, ma posso dirti che...") invece di inventare o generalizzare. NON ripetere l'intera proposta da capo, rispondi solo alla domanda in modo naturale, poi chiudi ricordando in una frase che sei ancora in attesa di sapere se vuole procedere con la prenotazione.`;
    }
    case "ask_traveller_field": {
      const labels: Record<string, string> = {
        firstName: "il nome",
        lastName: "il cognome",
        email: "l'indirizzo email",
        phone: "il numero di telefono",
        city: "la città di residenza",
        postalCode: "il CAP",
        countryCode: "il paese",
      };
      if (d.correction) {
        return `Uno dei dati che il viaggiatore ha dato prima non è stato accettato dal sistema del fornitore (probabilmente un formato non valido). Scusati in breve, spiega che devi ricontrollare i suoi dati da capo, poi chiedi ${labels[d.field] ?? d.field}. Una frase, tono comprensivo, non colpevolizzante.`;
      }
      if (d.isFirstAsk) {
        // This is now genuinely the OPENING line of the conversation
        // (traveller data is collected before any trip talk — see
        // initialState()'s doc, conversation.ts) — never frame it as
        // "per bloccare la prenotazione", nessuna prenotazione è stata
        // ancora discussa a questo punto.
        return `Questo è il primissimo messaggio di questa conversazione. Apri in modo naturale e breve, come un agente che risponde al telefono e chiede subito con chi sta parlando — NON menzionare ancora viaggi, sport, destinazioni o prenotazioni, arriveranno dopo. Chiedi solo ${labels[d.field] ?? d.field}.`;
      }
      return `Chiedi ${labels[d.field] ?? d.field} in modo naturale e diretto, come continueresti una conversazione già avviata — NON ripetere che ti servono i dati per la prenotazione, l'hai già detto poco fa. Una frase breve, formulata diversamente dalle domande precedenti.`;
    }
    case "reverifying":
      return `Di' in una frase breve che stai ricontrollando prezzo e disponibilità reali prima di chiudere, perché l'inventario è condiviso e potrebbe essere cambiato nel frattempo. Tono rassicurante.`;
    case "date_shift_confirm":
      return `È LO STESSO identico pacchetto già scelto poco fa ("${d.ctx.candidate.title}") — NON ripresentarlo da zero, NON ripetere prezzo/venue/durata come se fosse un'offerta nuova, il viaggiatore lo riconoscerebbe come un pacchetto diverso e si confonderebbe. Di' solo, in una frase breve, che quella data specifica (${d.requestedDate}) non è realmente disponibile per QUEL pacchetto, ma la prima data vera è ${d.offeredDate} — chiedi conferma per procedere con quella data, sullo stesso pacchetto di prima.`;
    case "price_changed":
      return d.reason
        ? `Il prezzo reale è diverso da quello mostrato prima: era ${d.oldPrice}, ora è ${d.newPrice}. Il motivo vero, verificato: ${d.reason}. Spiegalo con questa esatta ragione, in una frase naturale — non è un rincaro a sorpresa né "il mercato è dinamico", è il calcolo giusto per la richiesta fatta. Poi chiedi se vuole procedere al prezzo reale.`
        : `Il prezzo è cambiato nel frattempo: era ${d.oldPrice}, ora è ${d.newPrice}. Comunicalo con onestà SENZA inventare una causa (non sappiamo il motivo esatto, quindi non dire "il mercato è dinamico" o simili) — limitati al fatto, poi chiedi se vuole procedere comunque al nuovo prezzo.`;
    case "payment_unavailable":
      return d.retrying
        ? `Il sistema di pagamento non risponde in questo momento. Di' che ci stai riprovando subito, tono rassicurante, una frase.`
        : `Il sistema di pagamento del fornitore non è disponibile in questo momento (problema tecnico loro, non del viaggiatore). Scusati brevemente e chiedi se preferisce che ci riprovi tra poco o che lasci i suoi dati per essere ricontattato appena torna disponibile.`;
    case "backpressure":
      return d.state === "retrying"
        ? `Il sistema è sotto forte carico in questo momento (molte richieste insieme). Di' in una frase breve e rassicurante che ci stai riprovando tu stesso tra pochi secondi, senza che il viaggiatore debba fare nulla — non è un errore, solo tanta richiesta insieme.`
        : `Il sistema è sotto forte carico in questo momento (molte richieste insieme) e la sua richiesta è in coda — nulla è andato perso, nessun addebito è stato fatto. Chiedi di scrivere di nuovo tra pochi secondi per riprovare, tono rassicurante, una frase breve.`;
    case "booking_forbidden":
      return `C'è un problema di autorizzazione lato nostro sistema che impedisce di confermare la prenotazione in questo momento (non è colpa del viaggiatore né un problema di disponibilità). Scusati, sii onesto e diretto, di' che verrà segnalato internamente.`;
    case "booking_unverified":
      // Regression found live 2026-09-14: the fornitore's booking
      // confirmation can return a plausible-looking 200 without actually
      // registering the reservation (verified via a decisive idempotency
      // check — see ARCHITECTURE.md). Never tell the traveller "booked"
      // on a signal we've proven unreliable — this is the honest
      // alternative when that happens, not a generic error.
      return `Hai provato a confermare la prenotazione (il pagamento è già andato a buon fine, quello è sicuro), ma il sistema del fornitore non ti dà conferma certa che la prenotazione sia stata registrata per davvero — non vuoi dire "prenotato" se non ne sei sicuro. Spiegalo con onestà in una frase. I suoi dati sono GIÀ stati registrati per un follow-up (non serve chiederglieli di nuovo, li hai già), quindi rassicuralo che verrà ricontattato non appena il fornitore conferma, e chiedi solo se nel frattempo preferisce che ci riprovi subito.`;
    case "booked":
      return `La prenotazione è confermata per davvero. Codice di conferma: ${d.reservationCode}. Pacchetto: "${d.title}", totale pagato ${d.totalPrice}, si parte il ${d.startDate}. Dai un riepilogo operativo breve e caloroso, con il codice ben chiaro.`;
    case "no_match": {
      // Same "acknowledge what just happened, in the same breath" pattern
      // used by "propose"'s precededBy — regression found live
      // (sessionId 81992bfd-...): the traveller confirmed a compromise
      // proposal twice, it turned out not to be bookable even on its own
      // negotiated date, and once every known candidate for that request
      // was exhausted the reply reverted to a generic "tell me your
      // flexibility" question with zero mention of the package they'd
      // just said yes to — a jarring non-sequitur from their side, not
      // just a missed nicety.
      const lead =
        d.precededBy === "rejected"
          ? "Il viaggiatore ha appena rifiutato la proposta precedente. Riconoscilo in una parola o due, poi, nello stesso messaggio, "
          : d.precededBy === "unavailable"
            ? d.unavailableReason
              ? `Il pacchetto che il viaggiatore aveva appena confermato non è risultato prenotabile per davvero, e non c'è più nulla di equivalente da proporre al suo posto. Il fornitore segnala questo motivo tecnico, verificato: "${d.unavailableReason}" — traducilo in termini comprensibili (mai il gergo tecnico letterale). Poi, nello stesso messaggio, `
              : "Il pacchetto che il viaggiatore aveva appena confermato non è risultato prenotabile per davvero (un problema del fornitore — il motivo esatto non è disponibile, quindi NON inventarne uno), e non c'è più nulla di equivalente da proporre al suo posto. Diglielo con onestà in breve, poi, nello stesso messaggio, "
            : "";
      return `${lead}Non hai trovato nulla che corrisponda in modo ragionevole a quanto chiesto finora (troppo lontano da budget o date disponibili). Non proporre nulla di debole: fai una domanda di chiarimento per allargare la ricerca (es. altra città, budget più alto, date più flessibili).`;
    }
  }
}

export async function say(env: Env, directive: SayDirective, language: string | null = null): Promise<string> {
  // See Env.STUB_MODE's doc, types.ts — the load test only asserts on
  // state.stage/HTTP status (loadtest/scale-50k.js), never on reply text,
  // so a fixed placeholder is enough and skips the AI call entirely.
  if (env.STUB_MODE === "1") return `[stub:${directive.kind}]`;
  const instruction = directiveToInstruction(directive);
  return chat(env, buildSaySystem(language), instruction);
}

// --- Profile onboarding (2026-09-14): a separate, smaller NLU/NLG pair for
// the one-time "who are you" setup (see userProfile.ts), reusing the same
// chat()/Workers-AI-then-Haiku plumbing above instead of duplicating it.
// Deliberately its own thing, not folded into interpret()/say(): the trip
// engine's schema and rules (dates, budgetTier, adults precision policy)
// don't apply here at all, and keeping them apart means neither prompt
// has to carry the other's irrelevant rules.

export interface ProfileExtraction {
  firstName?: string | null;
  email?: string | null;
  city?: string | null;
  preferredSport?: "tennis" | "padel" | null;
  householdSize?: number | null;
  economicTier?: "smart" | "pro" | "luxury" | null;
}

const PROFILE_INTERPRET_SYSTEM = `Sei il modulo di comprensione della configurazione iniziale di un agente di prenotazione viaggi sportivi (padel/tennis + hotel). Stai raccogliendo il profilo permanente del viaggiatore (non un viaggio specifico), una volta sola.
Estrai SOLO ciò che il messaggio dice esplicitamente o implica chiaramente, senza inventare. Rispondi ESCLUSIVAMENTE con un oggetto JSON, nessun testo prima o dopo:
{ "firstName": string|null, "email": string|null, "city": string|null, "preferredSport": "tennis"|"padel"|null, "householdSize": number|null, "economicTier": "smart"|"pro"|"luxury"|null }
Regole:
- Includi SOLO i campi che il messaggio cambia davvero; i non menzionati restano null.
- "city" qui è la città di RESIDENZA del viaggiatore, non una destinazione di viaggio.
- "householdSize": numero di persone del nucleo familiare — conta se il viaggiatore lo nomina o lo implica chiaramente ("siamo in 4", "io e mia moglie" = 2, "vivo da solo" = 1). Se dice qualcosa di non numerabile, lascia null.
- "economicTier": il viaggiatore può rispondere col nome del profilo ("smart"/"pro"/"luxury", anche in italiano tipo "il base"/"il medio"/"il lusso") o con un'indicazione qualitativa/numerica che ci fai corrispondere tu: fino a 500€ a viaggio → "smart"; 600-1500€ o "via di mezzo"/"niente di esagerato" → "pro"; oltre 1500€ o "il top"/"senza badare a spese" → "luxury". Se non è chiaro, lascia null, non indovinare.
- Se il messaggio non tocca affatto un campo, non includerlo o mettilo a null.`;

export async function interpretProfile(
  env: Env,
  latestUserText: string,
  currentlyAsking: string | null,
): Promise<ProfileExtraction> {
  const askContext = currentlyAsking ? `\nStai chiedendo in questo momento: ${currentlyAsking}` : "";
  const user = `Messaggio del viaggiatore: "${latestUserText}"${askContext}`;
  const raw = await chat(env, PROFILE_INTERPRET_SYSTEM, user);
  return extractJson<ProfileExtraction>(raw) ?? {};
}

export type ProfileSayDirective =
  | { kind: "ask_profile_field"; field: "firstName" | "email" | "city" | "preferredSport" | "householdSize" | "economicTier"; isFirstAsk: boolean }
  | { kind: "profile_complete"; firstName: string };

function profileDirectiveToInstruction(d: ProfileSayDirective): string {
  switch (d.kind) {
    case "ask_profile_field": {
      const fieldQuestion: Record<
        "firstName" | "email" | "city" | "preferredSport" | "householdSize" | "economicTier",
        string
      > = {
        firstName: "chiedi il suo nome",
        email: "chiedi la sua email, senza ripetere spiegazioni già date",
        city: "chiedi in che città vive",
        preferredSport: "chiedi se preferisce il padel o il tennis",
        householdSize:
          "chiedi in quante persone è di solito il suo nucleo familiare o con chi viaggia più spesso — servirà solo come ipotesi di partenza per i prossimi viaggi, non un vincolo",
        economicTier:
          "chiedi qual è il suo profilo di spesa preferito per i viaggi, spiegando in una frase naturale (non un elenco puntato) le tre opzioni: Smart (fino a 500€ a viaggio), Pro (tra 600€ e 1500€), Luxury (oltre 1500€)",
      };
      const greeting = d.isFirstAsk
        ? "Questa è la primissima battuta di una configurazione iniziale, una tantum: dai un saluto breve e caloroso, spiega in una frase che vuoi conoscerlo un attimo così poi non dovrai richiedergli le stesse cose ad ogni viaggio, poi "
        : "";
      return `${greeting}${fieldQuestion[d.field]}, in una frase breve e naturale. Non chiedere altro insieme.`;
    }
    case "profile_complete":
      return `Il profilo è completo. Ringrazia ${d.firstName} con calore in una frase breve, di' che da ora in poi non gli richiederai più queste cose, e che può iniziare a chiederti un viaggio quando vuole.`;
  }
}

export async function sayProfile(env: Env, directive: ProfileSayDirective): Promise<string> {
  const instruction = profileDirectiveToInstruction(directive);
  return chat(env, buildSaySystem(null), instruction);
}
