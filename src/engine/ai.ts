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

async function chat(env: Env, system: string, user: string): Promise<string> {
  try {
    const res = await env.AI.run(WORKERS_AI_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
    });
    const text = (res as { response?: string }).response;
    if (text && text.trim().length > 0) return text;
    throw new Error("empty Workers AI response");
  } catch (err) {
    if (!env.ANTHROPIC_API_KEY) throw err;
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
    if (!res.ok) throw new Error(`Anthropic fallback failed: ${res.status}`);
    const body = await res.json<{ content: { text: string }[] }>();
    return body.content.map((b) => b.text).join("");
  }
}

export interface Interpretation {
  slotUpdates: Partial<Slots>;
  travellerUpdates: Partial<TravellerInfo>;
  /** Only meaningful right after the agent asked a yes/no question. */
  decision: "yes" | "no" | "unclear";
}

const INTERPRET_SYSTEM = `Sei il modulo di comprensione di un agente di prenotazione viaggi sportivi (padel/tennis + hotel).
Ricevi l'ultimo messaggio del viaggiatore e lo stato attuale noto. Estrai SOLO ciò che è esplicitamente detto o chiaramente implicito, senza inventare.
Rispondi ESCLUSIVAMENTE con un oggetto JSON, nessun testo prima o dopo, con questa forma esatta:
{
  "slotUpdates": { "sport": "tennis"|"padel"|null, "city": string|null, "dateFrom": "YYYY-MM-DD"|null, "dateTo": "YYYY-MM-DD"|null, "budget": number|null, "adults": number|null, "preferences": string|null },
  "travellerUpdates": { "firstName": string|null, "lastName": string|null, "email": string|null, "phone": string|null, "city": string|null, "postalCode": string|null, "countryCode": string|null },
  "decision": "yes"|"no"|"unclear"
}
Regole:
- Includi in slotUpdates/travellerUpdates SOLO i campi che il messaggio cambia davvero; ometti (non mettere null a caso) i campi non menzionati — ma se un campo è null nell'oggetto che restituisci, significa "non menzionato ora".
- Interpreta le date relative (es. "il weekend prossimo", "a ottobre") rispetto a oggi: ${new Date().toISOString().slice(0, 10)}.
- "decision" riflette se il messaggio è un assenso (sì, va bene, procedi, perfetto, ok...) o un rifiuto/richiesta di alternativa (no, troppo caro, un'altra città...) rispetto a una proposta o domanda che potrebbe essere stata fatta. Se il messaggio non è né l'uno né l'altro (es. sta solo dando un'informazione), usa "unclear".`;

export async function interpret(
  env: Env,
  currentSlots: Slots,
  currentTraveller: TravellerInfo,
  latestUserText: string,
): Promise<Interpretation> {
  const user = `Stato attuale: ${JSON.stringify({ slots: currentSlots, traveller: currentTraveller })}\nMessaggio del viaggiatore: "${latestUserText}"`;
  const raw = await chat(env, INTERPRET_SYSTEM, user);
  const parsed = extractJson<Interpretation>(raw);
  return (
    parsed ?? {
      slotUpdates: {},
      travellerUpdates: {},
      decision: "unclear",
    }
  );
}

export type SayDirective =
  | { kind: "ask_slot"; missing: "sport" | "city" | "dateFrom" | "budget" }
  | { kind: "propose"; ctx: ProposalContext }
  | { kind: "ask_traveller_field"; field: keyof TravellerInfo }
  | { kind: "reverifying" }
  | { kind: "price_changed"; oldPrice: string; newPrice: string }
  | { kind: "payment_unavailable"; retrying: boolean }
  | { kind: "booking_forbidden" }
  | { kind: "booked"; reservationCode: string; title: string; totalPrice: string; startDate: string }
  | { kind: "no_match" }
  | { kind: "rejected_next" };

const SAY_SYSTEM = `Sei la voce di un agente di prenotazione viaggi sportivi (padel/tennis + hotel), pensato per essere ascoltato più che letto: l'interazione è vocale, il viaggiatore potrebbe non guardare uno schermo. Parla in modo naturale, caldo, diretto, come faresti al telefono.
Regole ferree:
- UN SOLO messaggio breve (1-3 frasi), MAI un elenco, MAI più di una proposta/opzione alla volta.
- Usa SOLO i fatti forniti nell'istruzione — non inventare prezzi, date o dettagli.
- Se c'è un compromesso (prezzo o data diversi da quanto chiesto), dillo esplicitamente e chiedi conferma, sul modello: "non riesco a X, riesco a Y, procedo?".
- Rispondi in italiano, tono colloquiale ma professionale.
- Se la proposta è "exact" (nessun compromesso), presenta la proposta con entusiasmo misurato e chiedi conferma.`;

function directiveToInstruction(d: SayDirective): string {
  switch (d.kind) {
    case "ask_slot": {
      const labels: Record<typeof d.missing, string> = {
        sport: "che sport vuole praticare (tennis o padel)",
        city: "in che città o zona vuole andare",
        dateFrom: "quando vuole partire",
        budget: "qual è il budget indicativo",
      };
      return `Chiedi al viaggiatore, in una frase breve, ${labels[d.missing]}. Non chiedere altro insieme.`;
    }
    case "propose": {
      const { candidate, category, compromise } = d.ctx;
      const base = `Proponi ESATTAMENTE questo pacchetto, uno solo: "${candidate.title}" a ${candidate.venue}, ${candidate.city}, prezzo ${candidate.price}${candidate.currency === "EUR" ? "€" : " " + candidate.currency}, ${candidate.durationDays} giorni, disponibile tra ${candidate.minDate} e ${candidate.maxDate}.`;
      if (category === "exact") return `${base} Corrisponde esattamente a quanto chiesto. Chiedi conferma per procedere.`;
      const c = compromise!;
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
      return `Spiega in una frase che per procedere alla prenotazione reale ti servono i dati del viaggiatore, e chiedi ${labels[d.field] ?? d.field}.`;
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
    case "rejected_next":
      return `Il viaggiatore ha rifiutato la proposta precedente. Di' in una frase breve che cerchi un'altra opzione, poi fermati (la prossima proposta arriverà in un messaggio successivo).`;
  }
}

export async function say(env: Env, directive: SayDirective): Promise<string> {
  const instruction = directiveToInstruction(directive);
  return chat(env, SAY_SYSTEM, instruction);
}
