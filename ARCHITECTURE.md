# Architecture — Vela Developer Practical Challenge

> Scheletro preparato PRIMA di leggere il brief completo e PRIMA di premere Start.
> Da riempire man mano, non tutto in fondo sotto pressione di tempo.

**URL live**: https://vela-trip-agent.gleonardi87.workers.dev — deployato per
la prima volta 2026-09-14 ~14:30 (vedi commit history per i deploy
successivi). Cloudflare Worker, account `gleonardi87@gmail.com`.

## 1. Prototipo funzionante (25%)
- Flusso di booking reale che vogliamo far completare end-to-end:
  Intento in linguaggio naturale → slot-filling (sport, città, data,
  budget) → ricerca su HOFJ (`/v1/recommendations/search`, Terrarossa con
  fallback Weebora per il padel) → classificazione deterministica
  exact/compromise/none → **una** proposta con prezzo reale → conferma →
  raccolta dati viaggiatore → apertura carrello reale
  (`POST /v1/itineraries`) → ri-verifica silenziosa prezzo/disponibilità
  sullo snapshot reale del carrello → scrittura customer/pax reali
  (`PUT .../customer`, `PUT .../pax`) → tentativo pagamento Stripe
  (`GET .../payment`) → `POST /v1/bookings`. Verificato dal vivo fino
  all'apertura del carrello reale con dati reali compresi; gli ultimi due
  step sono bloccati da due bug upstream documentati sotto (non nostri),
  non da limiti del nostro codice — vedi sezione 5.
- Decisioni prese e perché: vedi il resto di questo documento, in
  particolare le sezioni 4 (metodo agentico → verifica qualità AI dal vivo)
  e 5 (padronanza API → note di esplorazione ed eccezioni upstream trovate).
- Cosa NON abbiamo implementato e perché (scope cut consapevoli):
  - **Indirizzo di fatturazione completo**: `CustomerData.address` richiede
    street1/postalCode/city/region/countryCode, ma chiedere tutti questi
    campi a voce sarebbe innaturale e fuori scope rispetto al pattern
    conversazionale richiesto (sport/città/date/budget/preferenze). Si
    chiedono a voce solo nome, cognome, email, telefono, città; street1 e
    postalCode vengono compilati con placeholder onesti ("N/A"/"00000"), il
    countryCode è dedotto dal paese del prodotto scelto. Documentato qui
    esplicitamente perché è un compromesso reale sui dati inviati all'API,
    non nascosto.
  - **Ripresa di una conversazione "failed"**: se il pagamento/booking
    fallisce, la conversazione termina (nessun meccanismo di retry
    asincrono/notifica). In produzione servirebbe una coda + notifica al
    viaggiatore quando l'inventario/pagamento torna disponibile — fuori
    scope per il tempo disponibile, ma l'itineraryId resta salvato nello
    stato della DO, quindi il carrello reale non è perso, solo non
    ripreso automaticamente.
  - **Selezione alternativa di hotel/camera**: per i prodotti "pacchetto"
    (hotelSelection:true, allowAccommodationList:false — il caso comune
    osservato su Terrarossa) l'accommodation è già pre-assegnata dal
    prodotto stesso; non abbiamo costruito uno step conversazionale per
    scegliere tra hotel alternativi (violerebbe comunque il vincolo "mai
    una lista tra cui scegliere" — coerente con lo scope, non solo un
    taglio per il tempo).

## 2. Architettura di scalabilità (25%)

- **Load test: strumento e scenario** (`loadtest/booking-flow.js`, k6,
  eseguito dal vivo contro l'URL live 2026-09-14 ~14:35). Deliberatamente
  **non** un singolo scenario che martella `/api/message` a piena
  concorrenza: la API key HOFJ ha un rate limit di 120 richieste/minuto
  condiviso (vedi sezione 5), quindi uno scenario ad alta concorrenza usa
  messaggi che forniscono un solo slot ("vorrei giocare a tennis") — questo
  path non chiama mai HOFJ (la ricerca parte solo a slot completi), quindi
  stressa solo Worker + Durable Object + Workers AI, senza rischiare la
  quota condivisa. Uno scenario separato, deliberatamente piccolo (3 VU,
  10 iterazioni totali), esercita il path di ricerca reale contro HOFJ per
  avere un campione di latenza onesto sulla parte esterna della pipeline,
  senza abusare della quota. Vedi il commento in testa al file per il
  dettaglio del perché.

- **Numeri reali ottenuti** (100 VU di picco, rampa 20s→30s→20s,
  `slot_filling_burst`; 3 VU / 10 iterazioni, `full_booking_search`):
  ```
  http_req_duration: avg=4.87s  p50=2.79s  p90=14.99s  p95=15s  max=15s
  http_req_failed:   11.95% (79/661) — quasi tutti timeout client (15s)
  full-search (path che chiama HOFJ davvero): 9/10 riuscite, ~90%
  ```
  Soglie dichiarate nel file (`p95<4000ms`, `error rate<2%`) **fallite
  entrambe** a 100 VU concorrenti — numero vero, non aggiustato a
  posteriori per far tornare i conti.

- **Bottleneck reale identificato**: non è HOFJ (rimasto sotto quota, solo
  10 chiamate reali nel test), non è la Durable Object (ogni conversazione
  ha la sua, zero contesa cross-conversazione per costruzione), non è la
  route statica. È **Workers AI**: ogni turno fa fino a 2 chiamate
  sequenziali (`interpret()` per la comprensione + `say()` per il
  fraseggio, entrambe su Llama 3.3 70B, ciascuna con fino a 3 tentativi in
  caso di errore transiente — vedi sezione 4). A bassa concorrenza questo
  costa 2-4s percepiti; a 100 richieste simultanee la capacità di
  inferenza condivisa del piano Workers AI si satura e la coda spinge
  la latenza fino al timeout client di 15s per circa il 12% delle
  richieste. È il collo di bottiglia onesto di un'architettura che fa 2
  chiamate LLM sequenziali per turno su un motore multi-tenant — non un
  bug nel nostro codice, ma un limite architetturale reale da affrontare
  prima di scalare.

- **Cosa faremmo per scalare 10x / 100x**:
  1. **Eliminare la seconda chiamata AI dove possibile.** `interpret()` e
     `say()` non si possono semplicemente fondere in una chiamata sola:
     tra i due c'è la logica di business (ricerca HOFJ, classificazione
     exact/compromise/none) che decide COSA dire, e dipende da dati
     esterni recuperati DOPO `interpret()` — fonderle vorrebbe dire far
     indovinare al modello anche l'esito della ricerca, esattamente il
     tipo di invenzione che il pattern di confidenza categorico vuole
     evitare. La correzione reale è diversa: la maggior parte dei
     `SayDirective` (sezione `engine/ai.ts`) espone già tutti i fatti in
     forma strutturata — si presta a un fraseggio a **template
     deterministico** invece che a una chiamata LLM, riservando il
     modello linguistico al solo `interpret()` (dove serve comprensione
     reale, non solo compilazione di fatti noti). Non implementato in
     questa sessione perché comprometterebbe la naturalezza/calore del
     tono richiesto dal manifesto ("parla come faresti al telefono") — un
     compromesso deliberatamente rimandato, non dimenticato: la via di
     mezzo più promettente è un piccolo set di varianti template per
     directive scelte a rotazione/casualmente, non frasi fisse.
  2. **Modello a due livelli**: un modello piccolo/veloce (es. Llama 3.2
     3B) per l'estrazione slot (compito semplice, strutturato), riservando
     il modello 70B solo al fraseggio finale, dove la qualità linguistica
     conta davvero.
  3. **AI Gateway di Cloudflare** davanti a Workers AI per caching delle
     risposte ripetute, code/backpressure gestite invece di un timeout
     secco, e osservabilità sulla saturazione reale del modello.
  4. **UX che assorbe la latenza invece di nasconderla**: un "sto
     pensando…" streaming/percepito lato frontend invece di un'attesa
     muta fino al timeout — coerente con il vincolo "vocale, attenzione
     non sullo schermo": l'utente può aspettare una risposta parlata un
     paio di secondi più a lungo se sa che il sistema sta ancora
     lavorando, molto meno se lo schermo sembra bloccato.
  5. **Rate limiter esplicito verso HOFJ** (un semplice token bucket in
     una DO singleton o KV) per non affidarsi solo al fatto che il nostro
     traffico reale resti sotto 120/min per costruzione — a 10x/100x
     traffico reale non è più garantito, va imposto lato nostro prima che
     lo imponga HOFJ con dei 429.
  6. Le Durable Object stesse non sono il collo di bottiglia e scalano
     già correttamente per costruzione (una per conversazione, distribuite
     automaticamente da Cloudflare) — non richiedono cambi architetturali
     per 10x/100x, solo il layer AI e il layer HOFJ ne richiedono.

## 3. Vision — "sei uscito dal marketplace?" (20%)
- Qual è il marketplace da cui ci si aspetta di uscire:
- La nostra idea per uscirne:

## 4. Metodo agentico (15%)
- Agenti/tool usati (Claude Code, sessioni, ruoli):
- Come il log grezzo in /agent-log/ documenta il processo:
- Decisioni prese dall'agente vs decisioni prese da Giuseppe:

### Verifica qualità Workers AI, dal vivo (2026-09-14 ~14:00)

Come richiesto dal brief ("verificarne per prima cosa la qualità su un caso
reale prima di costruirci sopra tutto"), prima di considerare Workers AI
definitivo ho fatto girare l'intero flusso conversazionale reale contro
`wrangler dev` (AI binding in modalità `remote: true` — necessario, senza
quel flag il binding va in errore locale silenzioso, vedi bug qui sotto) e
osservato 3 problemi concreti, tutti risolti tenendo il modello lontano dal
compito che gli riesce peggio (matematica/lookup esatti) e lasciandogli solo
comprensione e fraseggio in linguaggio naturale:

1. **Il modello non sa fare aritmetica di calendario in modo affidabile.**
   Con istruzioni esplicite ("oggi è 2026-09-14, non usare mai 1970") il
   modello (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) ha comunque
   restituito `1970-09-25` e poi `1971-09-25` per "il 25 settembre" — due
   tentativi diversi, stesso errore di categoria. **Decisione**: il modulo
   di interpretazione (`engine/ai.ts`) non chiede più al modello una data
   ISO calcolata — gli si chiede di *estrarre la frase letterale* ("il 25
   settembre", "il prossimo weekend"...), e un resolver deterministico in
   codice (`engine/dates.ts`, con test unitari) fa il calcolo vero. Lezione
   generale applicata: matematica e lookup esatti restano in codice
   testabile, il modello fa solo NLU/NLG — non è un compromesso, è la
   scelta architetturale corretta a prescindere dal modello.
2. **Il ranking di ricerca dell'API può proporre la città sbagliata.** Per
   `keyword="Roma tennis"` su Terrarossa, il risultato più in alto per
   `combinedScore` era un venue "tennis-roma-fdm" a **Forte dei Marmi**, non
   Roma — il nome del campo conteneva "roma" ma la destinazione no.
   L'API non distingue "prezzo/data leggermente diversi" (un compromesso
   accettabile da proporre) da "città completamente diversa" (non lo è).
   **Decisione**: `engine/matcher.ts` filtra i candidati per corrispondenza
   città (con un piccolo dizionario di sinonimi IT/EN: roma/rome,
   milano/milan, ecc.) PRIMA di passarli alla classificazione
   exact/compromise/none, scartando chi non corrisponde invece di
   riordinarlo soltanto — se lo scarto svuota la lista, si passa
   correttamente a "nessuna corrispondenza, chiedo chiarimento" invece di
   proporre la città sbagliata con sicurezza.
3. **`POST /v1/itineraries` vuole `productId` come number, non string**,
   nonostante lo schema OpenAPI dichiari `oneOf(integer, string)` — verificato
   dal vivo: un productId stringa dà 400 `ZodError` dall'upstream del brand
   site. Corretto lato client (`HofjClient.createItinerary` forza
   `Number(productId)`), con commento che documenta il perché.

**Verifica dal vivo della ri-verifica silenziosa** (proprio il meccanismo
richiesto dal brief): nel primo test end-to-end, il prezzo mostrato in fase
di ricerca (365€, solo l'attività tennis) differiva dal totale reale del
carrello aperto (465€, include l'hotel) — il sistema l'ha rilevato da solo
dopo `POST /v1/itineraries` + `GET` sullo snapshot, è tornato in stato
"proposing" con la nuova cifra, e ha ottenuto una nuova conferma esplicita
prima di proseguire — senza intervento manuale. Log completo del turno in
`/agent-log/`.

**Affidabilità del binding stesso**: Workers AI (anche non in errore di
prompt) ha lanciato un `InferenceUpstreamError: internal error` transitorio
un paio di volte durante i test, indipendentemente dal modello provato.
Non è un problema di prompt: è retry-abile. `engine/ai.ts` ora ritenta la
chiamata fino a 3 volte con backoff prima di arrendersi, e solo allora la
conversazione riceve un "scusa, puoi ripetere?" — **senza** terminare la
sessione (a differenza di un vero errore HOFJ in fase di prenotazione, quello
sì terminale). Questa distinzione (hiccup del motore di linguaggio = non
fatale, errore della pipeline di booking reale = fatale) è una decisione
architetturale esplicita in `conversation.ts`.

**Conclusione**: Workers AI (Llama 3.3 70B) è qualitativamente adeguato come
motore primario per NLU/NLG in italiano — il fraseggio delle proposte
("non riesco a 365€, il prezzo reale è 465€, procedo?") è risultato naturale
e rispetta il vincolo "una proposta alla volta" senza bisogno di prompt
engineering aggressivo. Il fallback Anthropic Haiku resta cablato in
`engine/ai.ts` ma non è mai stato attivato: non è risultato necessario.

**Metodologia a due tracce (decisa in fase di preparazione):**
- Una sessione privata di pianificazione (mai pubblicata) dove Giuseppe e un
  Claude "consigliere" discutono strategia, dubbi, scarti di strada.
- Una sessione pubblica separata (avviata a foglio bianco dentro questa
  cartella di progetto) che esegue davvero il lavoro — codice, debug, fix —
  e il cui transcript grezzo, senza editing, è quello che finisce in
  /agent-log/. Le decisioni arrivano già maturate dalla sessione privata,
  ma l'esecuzione e gli errori/correzioni che si vedono nel log sono reali,
  non recitati.

## 5. Padronanza API (10%)
- API fornita da Vela: endpoint chiave usati, autenticazione, limiti osservati:
- Come l'abbiamo integrata / eventuali workaround:

### Note di esplorazione — sessione pubblica, 2026-09-14 ~12:00

**Auth e topologia reale (diversa dalle assunzioni pre-flight):**
- `api.hofj.com` è servito da Google (ghs.googlehosted.com / App Engine). La
  risoluzione DNS in questo ambiente è intermittente (a volte "could not
  resolve host"): workaround usato, `nslookup` + `curl --resolve
  api.hofj.com:443:<ip>` per bypassare il resolver instabile quando serve.
  Non è un problema dell'API stessa, solo della rete locale della sandbox
  agente — nel Worker deployato su Cloudflare non c'è motivo che si ripresenti.
- Bearer token = API key diretta confermato (nessun bisogno di
  `/v1/oauth/token`, coerente con quanto già annotato nel brief).
- `GET /v1/quota`: `limitPerMinute: 120`, `clientId: "test-developer"`.

**Pipeline reale verificata end-to-end, fino al pagamento:**
1. `GET /v1/distribution-channels` → 3 brand: `Weebora` (weebora.com),
   `Terrarossa` (terrarossa.com), `House of Journey` (booking.hofj.com).
   **Terrarossa è il brand tennis/padel** (categorie: academies, holidays,
   tournaments, group-tour). Weebora ha *anche* prodotti padel (es.
   "Exclusive Padel Clinic", "TAO Padel Academy Weekend") — verificarli come
   fallback/ampliamento inventario se Terrarossa è scarso su una città.
2. `GET /v1/recommendations/search?brand=terrarossa.com&locale=en&...` è
   davvero un buon motore di ricerca ordinata (score, ranking, filtri
   `style`/`bestForLevel`/`goal` oltre a categoria/destinazione/prezzo/date)
   — confermato: usarlo come endpoint di risoluzione primario, evita
   la sequenza destinations→categories→venues più costosa in chiamate.
   Prodotto di riferimento usato nei test: **id 987, "Serve & Relax in
   Rome"** (tennis + padel club, hotel incluso, 465€, 2026-09-25→27).
3. `POST /v1/itineraries` (productId, startDate, adults, rooms, currency)
   → funziona, apre il carrello. Per pacchetti "holiday" con
   `hotelSelection:true` + `allowAccommodationList:false`, l'accommodation e
   l'activity vengono **pre-assegnate automaticamente** dal prodotto (niente
   step di scelta lato nostro per questo tipo di prodotto — semplifica il
   dialogo: non tutti i prodotti richiedono la fase "scegli hotel/attività").
4. `PUT .../customer`, `PUT .../pax` → funzionano, scrivono i dati
   viaggiatore sul carrello reale.
5. `PATCH .../accommodations/{id}` (re-conferma le stesse room) → funziona,
   ritorna lo snapshot esteso del carrello (prezzo, cancellation policy,
   moduli, ecc.) — utile per la ri-verifica silenziosa prezzo/disponibilità
   prima di chiudere, richiesta dal brief.

**Due blocchi reali trovati sull'ultimo miglio (bug scoperti, non nostri):**
- `GET .../payment` (refresh Stripe payment intent) → **sempre 502**, con
  dettaglio `"Brand \"terrarossa.com\" GET /itinerary/.../payment returned
  405"`. Il gateway HOFJ chiama l'upstream del brand in GET ma l'upstream si
  aspetta un altro metodo: bug lato loro, non nostro — verificato su 2
  prodotti Terrarossa diversi *e* su Weebora (stesso 405), quindi non è
  specifico del prodotto/brand: è sistemico sull'endpoint payment.
- `POST /v1/bookings` → **sempre 403** `forbidden-entity`: `"This client is
  not allowed to access resource: bookings"`. Verificato che non dipende
  dallo stato del carrello (riprovato dopo aver popolato customer/pax e
  ri-confermato l'accommodation: stesso errore) — è un permesso statico
  mancante sulla API key fornita (`allowedEntities` lato server non include
  `bookings`, mentre include `itineraries`). Non esiste un secondo set di
  credenziali disponibile per questa sessione.
- **Decisione presa (confermata con Giuseppe)**: non aggirare né fabbricare
  un finto successo. Questo è esattamente il caso "prodotto/inventario non
  prenotabile" che il brief avvisa esistere — solo che si manifesta
  sull'intero step finale, non su un prodotto isolato. Si costruisce la
  pipeline reale fino a qui (carrello vero, dati vero cliente, prezzo vero,
  ri-verifica vera), il client Stripe.js/payment è scritto a spec pronto per
  quando/se l'endpoint si sblocca (l'inventario è condiviso e può cambiare
  durante le 24h), e il dialogo gestisce esplicitamente il fallimento con lo
  stesso pattern categorico usato per le negoziazioni di business
  ("il pagamento non è disponibile in questo momento, riprovo / lascio i
  tuoi dati" invece di inventare una prenotazione che non è successa).

## 6. Comunicazione (5%)
- Questo documento + README + video (opzionale)

---

## Timeline della sfida (fatti oggettivi, non ipotesi)
- Clock: 24h dal press di Start, orologio del server di Vela
- Twist: si sblocca a 12h esatte
- Pause disponibili: 2
- Submission: 1 sola, a tempo scaduto
- 5 chiavi nascoste nella challenge, +5h totali se trovate
- API key fornita: vedi CREDENZIALI.local.md (gitignorato, mai in questo repo)

## Decisioni ancora aperte (in attesa di leggere il brief completo)
- [ ] Stack applicativo (dipende da cosa fornisce l'API di Vela)
- [ ] Hosting/deploy target
- [ ] Persistenza dati (se serve un DB nostro oltre l'API di Vela)
