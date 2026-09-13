# Brief per la sessione pubblica di esecuzione

Questo è il primo messaggio da incollare nella sessione Claude Code aperta a
foglio bianco dentro questa cartella. Non è un elenco di task — è direzione e
vincoli. La scomposizione in sotto-agenti è compito tuo, adattala a quello che
scopri mano a mano (specifiche reali dell'API, qualità di Workers AI, ecc.),
non seguire uno script rigido.

## Missione

Costruire un prototipo funzionante di prenotazione viaggi padel/tennis +
hotel, headless, conversazionale, contro la House of Journeys API reale
(HOFJ — docs.api.hofj.com, spec su api.hofj.com/v1/openapi.json). Non un sito
di prenotazione — quello che lo sostituisce. Deve arrivare a una prenotazione
vera con codice di conferma reale, pagamento Stripe in test mode.

## Vincoli non negoziabili (rompere uno di questi azzera il punteggio)

- Nessuna pagina di risultati, nessun filtro, nessuna griglia prodotti,
  nessuna tabella comparativa.
- Il viaggiatore non riceve mai una lista tra cui scegliere. Una proposta
  alla volta, mai due opzioni nella stessa battuta. Solo se l'utente rifiuta
  esplicitamente la prima, si passa alla successiva.
- L'intero acquisto parte da un singolo intento espresso in linguaggio
  naturale, con parole proprie del viaggiatore.
- **L'attenzione del viaggiatore non è su uno schermo per la maggior parte
  dell'interazione** — è il vero motivo per cui l'interfaccia è vocale/
  conversazionale, non "una chat invece di una lista". Non ripiegare su una
  semplice chat testuale come se fosse equivalente: resta il north star,
  anche nella versione minimale che il tempo reale ci permette di costruire.
- **Non tutti gli acquirenti hanno occhi, uno schermo, o pazienza** —
  vincolo di accessibilità reale, non un modo di dire.
- Vela non è una destinazione: il viaggiatore non viene da voi, è l'agente
  che arriva dove il viaggiatore già è (nella versione minimale: un client
  che simula questo, non un sito da visitare attivamente).
- Scope: solo padel/tennis + hotel. Niente voli/transfer/auto.

## Pattern di interazione

Slot-filling (chiede solo ciò che manca: sport, città, date, budget,
maestro/preferenze) → negoziazione se qualcosa non torna (data non
disponibile, budget insufficiente: "non riesco a 300, riesco a 500, procedo?")
→ proposta singola con prezzo → conferma esplicita → **ri-verifica silenziosa
di prezzo/disponibilità prima di chiudere** (l'inventario è vero e condiviso,
può essere cambiato nel frattempo) → prenotazione reale + pagamento →
riepilogo operativo finale ("hai speso X, ecco il programma").

## Linguaggio e toolchain (deciso, non lasciato all'agente)

TypeScript su tutta la linea — è il linguaggio nativo di Cloudflare Workers,
con binding tipizzati per Durable Objects e Workers AI, ed è quello con cui
è più veloce rivedere il codice. `wrangler` per dev/deploy, `npm` come
package manager, `vitest` per i test (è lo standard consigliato per i
Workers). Decisione fissata qui apposta: se ogni sotto-agente scegliesse da
sé, il rischio concreto è incoerenza tra i pezzi (un agente in Python, uno in
JS) in un singolo Worker deployabile — non è un dettaglio da lasciare
all'improvvisazione.

## Stack deciso

- Frontend: pagina minimale, campo di testo (+ eventuale Speech-to-Text
  browser), trascrizione della conversazione. Niente altro.
- Backend: Cloudflare Worker, un Durable Object per conversazione attiva
  (stato + serve anche a bloccare l'inventario scelto durante la conferma,
  evitando doppie prenotazioni in conversazioni parallele).
- Motore di ragionamento: **Workers AI** (modello open-weight, gratuito
  entro la soglia) come prima scelta — verificarne per prima cosa la qualità
  su un caso reale prima di costruirci sopra tutto. Fallback: API Anthropic
  metered (Haiku, costo minimo) se la qualità non regge il negoziato
  "unhappy path". Mai `claude -p`/CLI in produzione — è legato all'account
  personale, non deployabile per un utente terzo.
- Le credenziali HOFJ (baseUrl, apiKey) sono in `CREDENZIALI.local.md`
  (gitignorato) — leggerle da lì o da variabili d'ambiente, mai incollarle
  in chiaro in nessun prompt o commit.

## Pipeline dati HOFJ (come si aggregano le informazioni)

Non esiste un endpoint unico "trova tutto". Sequenza tipica: risolvi
destinazione/categoria (`/v1/destinations`, `/v1/categories`, `/v1/venues`,
o direttamente `/v1/recommendations/search` se si rivela già un buon motore
di ricerca ordinata — verificarlo per primo) → prodotto candidato → apri il
carrello (`POST /v1/itineraries`) → leggi opzioni dentro il carrello
(`GET .../accommodations`, `GET .../activities`) → seleziona
(`PATCH`/equivalenti) → dati viaggiatore (`.../pax`, `.../customer`) →
pagamento (`.../payment`, Stripe test mode) → `POST /v1/bookings` per
chiudere davvero.

**Rate limit — verificato prima di Start**: la API key nel `CREDENZIALI.local.md`
funziona già come `Authorization: Bearer <key>` diretto su `api.hofj.com`
(non serve passare da `/v1/oauth/token`). `GET /v1/quota` risponde con
`limitPerMinute: 120`, finestra scorrevole di 60s, `clientId: "test-developer"`
(stringa generica — non è chiaro se il bucket è condiviso con altri
candidati, quindi restare comunque parsimoniosi). 120/min sembra tanto ma
una singola conversazione può facilmente costare 5-6 chiamate in sequenza
(destinazione → categoria/prodotto → itinerario → accommodations →
activities) — il motore deve essere economico: usare le chiamate di ricerca
ampie prima di quelle di dettaglio costose, mettere in cache ciò che cambia
poco (categorie, destinazioni, venue), controllare `/v1/quota` prima di
raffiche di chiamate.

## Cosa leggono davvero i valutatori, e con che peso

Questo non è un esercizio a scatola chiusa: sanno esattamente cosa cercano,
e conviene lavorare sapendolo anche noi, non solo io.

- **Pesi dello scoring**: prototipo che completa un booking reale 25%,
  architettura di scalabilità 25%, vision "sei uscito dal marketplace?" 20%,
  metodo agentico dimostrato 15%, padronanza API 10%, comunicazione 5%.
  Tradotto: prototipo funzionante + scalabilità valgono da soli metà del
  voto — non passare ore a rifinire dettagli di comunicazione (5%) se il
  booking reale non chiude ancora.
- **Leggono `ARCHITECTURE.md` per davvero**: decisioni, trade-off, cosa
  faresti dopo. Non è un file da riempire a fine sessione — va aggiornato
  mentre si lavora, con le scelte vere fatte nel momento in cui sono state
  fatte (incluso il perché di eventuali ripensamenti).
- **Leggono `/agent-log/` come trascrizioni raw**, non un riassunto scritto
  a posteriori. Citazione testuale dal brief: *"Raw exports, not a write-up
  about them."*
- **Incrociano tre timeline**: i timestamp nei log degli agenti, la
  cronologia dei commit, e gli eventi di pausa/ripresa registrati dal loro
  server. Devono raccontare la stessa storia coerente.
- Citazione testuale che vale come criterio guida per ogni scelta di
  processo: *"A tidy repository with no evidence of how it got there scores
  badly. A messy one with a clear, well-directed agent trail scores well."*
  Meglio un repo con qualche tentativo fallito visibile e ben diretto, che
  uno linderato ma senza traccia di come ci si è arrivati.

## Disciplina di processo (non opzionale, viene verificata)

- **Commit incrementali con messaggi veri**, non un commit finale gigante —
  i timestamp dei commit vengono incrociati con i log degli agenti e con gli
  eventi pausa/ripresa registrati dal loro server.
- **Deploy presto e spesso**: l'URL live deve esistere ben prima della
  scadenza, non comparire all'ultimo minuto.
- Test insieme al codice che testano, non rimandati alla fine.
- Niente astrazioni premature, niente feature non richieste: scope stretto,
  fedele al manifesto.
- Multi-agente dove ha senso (pezzi grandi e indipendenti: scaffold
  Worker+DO, client HOFJ, load test, review pre-commit) — non un agente per
  ogni file.
- Gestire esplicitamente il caso "prodotto non prenotabile" / inventario
  misconfigurato (il brief avverte che esiste davvero).

## Deliverable da tenere a mente per tutta la sessione, non solo alla fine

URL live raggiungibile, repo pubblica con history intatta, `ARCHITECTURE.md`
aggiornato via via, `/agent-log/` (questi transcript, esportati a fine
sessione), load test k6 (`loadtest/booking-flow.js`, già scaffoldato) con
numeri veri, video 3-5 min di un acquisto reale end-to-end.
