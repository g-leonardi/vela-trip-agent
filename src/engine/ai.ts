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
  decision: "yes" | "no" | "unclear";
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
  "decision": "yes"|"no"|"unclear",
  "language": string|null
}
Regole:
- Includi in slotUpdates/travellerUpdates SOLO i campi che il messaggio cambia davvero; i campi non menzionati restano null.
- "dateFromText"/"dateToText": copia LETTERALMENTE la frase di data così come l'ha detta il viaggiatore, NELLA LINGUA in cui l'ha detta (es. "il 25 settembre", "next weekend", "in three days") — NON tradurla, NON calcolare tu la data, non convertirla in formato ISO, non inventare l'anno: quello lo fa un altro modulo deterministico che riconosce sia italiano sia inglese.
- "budget" e "adults" NON vanno MAI inventati o stimati, nemmeno quando sembra ovvio dal contesto — sono gli UNICI due campi che il viaggiatore deve dire esplicitamente (con un numero, o con "budgetTier" per il budget — vedi sotto), altrimenti vanno richiesti. Per "adults" conta le persone se il viaggiatore le nomina o implica chiaramente il numero ("io e mia moglie" = 2, "siamo in quattro" = 4, "da solo" = 1, "I'm going with Francesca" = 2) — ma se dice qualcosa di non numerabile ("tutta la famiglia", "un gruppo di amici" senza numero), lascia "adults" a null: verrà chiesto un numero preciso, non va indovinato.
- "budgetTier": il viaggiatore può rispondere alla domanda sul budget in modo qualitativo invece che con un numero — è una risposta vera, non un budget mancante. Espressioni come "economico", "il minimo", "niente di esagerato", "spendere poco", "cheap" → "low". Espressioni come "carino ma non troppo caro", "nella media", "niente di esagerato ma neanche il più economico", "nice, but not crazy expensive", "reasonable" → "mid" (NON "low": non sta chiedendo il più economico, sta chiedendo qualcosa di ragionevole). Espressioni come "il top", "il meglio", "senza badare a spese", "budget illimitato", "money is no object" → "high". Se il viaggiatore dà un numero, usa "budget" e lascia "budgetTier" a null (sono alternativi, non vanno riempiti entrambi). Se non dice né un numero né un giudizio qualitativo, lascia entrambi a null — NON inventare mai un numero specifico da un giudizio qualitativo.
- "decision" riflette se il messaggio è un assenso (sì, va bene, procedi, perfetto, ok..., yes, sure, sounds good) o un rifiuto/richiesta di alternativa (no, troppo caro, un'altra città..., that's too expensive) rispetto a una proposta o domanda che potrebbe essere stata fatta. Se il messaggio non è né l'uno né l'altro (es. sta solo dando un'informazione), usa "unclear".
- Se ricevi "Stai chiedendo in questo momento: ...", usalo per capire a quale campo appartiene una risposta breve e ambigua (es. "Milano" da solo). "città" compare sia nel viaggio (slotUpdates.city, la destinazione) sia nei dati del viaggiatore (travellerUpdates.city, dove abita) — sono DUE campi diversi, non confonderli: se stai chiedendo la città di residenza del viaggiatore, la risposta va SOLO in travellerUpdates.city, MAI in slotUpdates.city (la destinazione del viaggio è già decisa a quel punto e non va toccata).
- "language": il nome della lingua in cui il viaggiatore sta scrivendo ADESSO, in italiano (es. "italiano", "inglese", "spagnolo", "francese", "tedesco"...). Valorizzalo solo se il messaggio è abbastanza lungo/chiaro da capirlo con sicurezza, o se sembra diverso dalla lingua usata nei messaggi precedenti (cambio di lingua a metà conversazione) — altrimenti lascialo null, non serve ripeterlo ogni turno.`;

export async function interpret(
  env: Env,
  currentSlots: Slots,
  currentTraveller: TravellerInfo,
  latestUserText: string,
  currentlyAsking: string | null = null,
): Promise<RawInterpretation> {
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
  | { kind: "ask_slot"; missing: "sport" | "city" | "dateFrom" | "budget" | "adults" }
  | { kind: "propose"; ctx: ProposalContext; precededBy?: "rejected" | "unavailable" }
  | { kind: "ask_traveller_field"; field: keyof TravellerInfo; isFirstAsk: boolean }
  | { kind: "reverifying" }
  | { kind: "price_changed"; oldPrice: string; newPrice: string }
  | { kind: "payment_unavailable"; retrying: boolean }
  | { kind: "booking_forbidden" }
  | { kind: "booked"; reservationCode: string; title: string; totalPrice: string; startDate: string }
  | { kind: "no_match" };

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
        budget: "qual è il budget indicativo",
        adults: "in quante persone viaggia",
      };
      return `Chiedi al viaggiatore, in una frase breve, ${labels[d.missing]}. Non chiedere altro insieme.`;
    }
    case "propose": {
      const { candidate, category, compromise } = d.ctx;
      const lead =
        d.precededBy === "rejected"
          ? "Il viaggiatore ha rifiutato la proposta precedente. Riconoscilo con una parola o due (non una frase intera a sé) e poi, nello stesso messaggio, "
          : d.precededBy === "unavailable"
            ? "Il pacchetto proposto prima non risulta più prenotabile per davvero (un problema del fornitore, non tuo). Diglielo in breve e poi, nello stesso messaggio, "
            : "";
      const base = `${lead}Proponi ESATTAMENTE questo pacchetto, uno solo: "${candidate.title}" a ${candidate.venue}, ${candidate.city}, prezzo ${candidate.price}${candidate.currency === "EUR" ? "€" : " " + candidate.currency}, ${candidate.durationDays} giorni, disponibile tra ${candidate.minDate} e ${candidate.maxDate}.`;
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
      return `${base} ATTENZIONE: c'è uno scostamento su ${c.kind === "price" ? "prezzo" : "data"} — il viaggiatore voleva ${c.requested}, tu puoi offrire ${c.offered}. Dillo chiaramente nello stile "non riesco a ${c.requested}, riesco a ${c.offered}, procedo?" e chiedi conferma esplicita.`;
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
      if (d.isFirstAsk) {
        return `Spiega in una frase breve che per bloccare la prenotazione reale ti servono un paio di dati, poi chiedi ${labels[d.field] ?? d.field}. Questa è la prima volta che lo dici in questa conversazione.`;
      }
      return `Chiedi ${labels[d.field] ?? d.field} in modo naturale e diretto, come continueresti una conversazione già avviata — NON ripetere che ti servono i dati per la prenotazione, l'hai già detto poco fa. Una frase breve, formulata diversamente dalle domande precedenti.`;
    }
    case "reverifying":
      return `Di' in una frase breve che stai ricontrollando prezzo e disponibilità reali prima di chiudere, perché l'inventario è condiviso e potrebbe essere cambiato nel frattempo. Tono rassicurante.`;
    case "price_changed":
      return `Il prezzo è cambiato nel frattempo: era ${d.oldPrice}, ora è ${d.newPrice}. Comunicalo con onestà e chiedi se vuole procedere comunque al nuovo prezzo.`;
    case "payment_unavailable":
      return d.retrying
        ? `Il sistema di pagamento non risponde in questo momento. Di' che ci stai riprovando subito, tono rassicurante, una frase.`
        : `Il sistema di pagamento del fornitore non è disponibile in questo momento (problema tecnico loro, non del viaggiatore). Scusati brevemente e chiedi se preferisce che ci riprovi tra poco o che lasci i suoi dati per essere ricontattato appena torna disponibile.`;
    case "booking_forbidden":
      return `C'è un problema di autorizzazione lato nostro sistema che impedisce di confermare la prenotazione in questo momento (non è colpa del viaggiatore né un problema di disponibilità). Scusati, sii onesto e diretto, di' che verrà segnalato internamente.`;
    case "booked":
      return `La prenotazione è confermata per davvero. Codice di conferma: ${d.reservationCode}. Pacchetto: "${d.title}", totale pagato ${d.totalPrice}, si parte il ${d.startDate}. Dai un riepilogo operativo breve e caloroso, con il codice ben chiaro.`;
    case "no_match":
      return `Non hai trovato nulla che corrisponda in modo ragionevole a quanto chiesto finora (troppo lontano da budget o date disponibili). Non proporre nulla di debole: fai una domanda di chiarimento per allargare la ricerca (es. altra città, budget più alto, date più flessibili).`;
  }
}

export async function say(env: Env, directive: SayDirective, language: string | null = null): Promise<string> {
  const instruction = directiveToInstruction(directive);
  return chat(env, buildSaySystem(language), instruction);
}
