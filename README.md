# Vela — agente di prenotazione padel/tennis + hotel

Prototipo di prenotazione viaggi headless e conversazionale contro la House
of Journeys API reale. Non una chat al posto di una lista di risultati: un
agente vocale a cui dici cosa vuoi in una frase, che negozia e propone
un'opzione alla volta, e chiude un carrello reale.

**Live**: https://vela-trip-agent.gleonardi87.workers.dev

Decisioni, trade-off, bug reali trovati nell'API e numeri veri del load
test sono in [`ARCHITECTURE.md`](./ARCHITECTURE.md) — è il documento che
racconta il "perché", aggiornato durante il lavoro, non a posteriori.

## Stack

Cloudflare Worker (TypeScript) + quattro Durable Object (verificate in
`wrangler.jsonc`): `CONVERSATION` (una per conversazione, la macchina a
stati), `USER_PROFILE` (una per viaggiatore, profilo persistente tra
conversazioni), `FOLLOWUP` (una sola, log dei pagamenti riusciti con
booking non confermato), `HOFJ_QUOTA_GATE` (una sola, rate limiter verso
HOFJ). Workers AI (Llama 3.3 70B) come motore di comprensione/fraseggio
con fallback Anthropic Haiku, HOFJ come unica fonte di verità per
inventario/prezzi/prenotazioni, Stripe (test mode) per il pagamento
reale.

## Sviluppo locale

```bash
npm install
npm run dev        # wrangler dev, richiede .dev.vars con HOFJ_API_KEY e STRIPE_SECRET_KEY
npm test           # vitest
npm run typecheck
npx wrangler deploy
```

## Struttura

```
src/
  index.ts                Worker entrypoint (route HTTP + asset statici)
  types.ts                 tipi condivisi (ConversationState, Slots, Env, ...)
  conversation.ts           Durable Object: la macchina a stati della conversazione
  userProfile.ts            Durable Object: profilo viaggiatore persistente + onboarding
  followUp.ts               Durable Object: log pagamenti riusciti con booking non confermato
  hofj/client.ts            client tipizzato per la House of Journeys API (+ STUB_MODE)
  hofj/quotaGate.ts         Durable Object: rate limiter verso la quota HOFJ (120/min)
  hofj/tokenBucket.ts       matematica pura del token bucket, unit-testabile a parte
  hofj/discoveryCache.ts    cache + coalescing per le sole chiamate di discovery
  stripe/client.ts          client tipizzato per Stripe (PaymentIntent, test mode)
  engine/matcher.ts         classificazione exact/compromise/none, deterministica
  engine/ai.ts              NLU/NLG via Workers AI (fallback Anthropic Haiku)
  engine/dates.ts           risoluzione date in italiano, deterministica
public/index.html        frontend minimale, microfono-first (Web Speech API)
test/                    vitest — unit test su engine/hofj + integrazione su conversation.ts via STUB_MODE
scripts/prompt-suite.mjs suite di prompt reali contro il Worker live, per l'estrazione NLU (costa denaro reale, vedi header del file)
loadtest/                scenari k6 (comandi in ARCHITECTURE.md, sezione 2)
  booking-flow.js         concorrenza reale contro Worker + HOFJ (staging)
  scale-50k.js            50k conversazioni/10min sotto STUB_MODE, per l'architettura di scalabilità
agent-log/               trascrizione grezza della sessione di esecuzione, redatta
```
