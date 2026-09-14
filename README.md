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

Cloudflare Worker (TypeScript) + una Durable Object per conversazione,
Workers AI (Llama 3.3 70B) come motore di comprensione/fraseggio con
fallback Anthropic Haiku, HOFJ come unica fonte di verità per
inventario/prezzi/prenotazioni.

## Sviluppo locale

```bash
npm install
npm run dev        # wrangler dev, richiede .dev.vars con HOFJ_API_KEY
npm test           # vitest
npm run typecheck
npx wrangler deploy
```

## Struttura

```
src/
  index.ts           Worker entrypoint (route HTTP + asset statici)
  conversation.ts     Durable Object: la macchina a stati della conversazione
  hofj/client.ts       client tipizzato per la House of Journeys API
  engine/matcher.ts     classificazione exact/compromise/none, deterministica
  engine/ai.ts           NLU/NLG via Workers AI (fallback Anthropic Haiku)
  engine/dates.ts         risoluzione date in italiano, deterministica
public/index.html    frontend minimale, microfono-first (Web Speech API)
loadtest/             scenario k6
agent-log/            trascrizione grezza della sessione di esecuzione
```
