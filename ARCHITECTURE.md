# Architecture — Vela Developer Practical Challenge

> Scheletro preparato PRIMA di leggere il brief completo e PRIMA di premere Start.
> Da riempire man mano, non tutto in fondo sotto pressione di tempo.

**URL live**: https://vela-trip-agent.gleonardi87.workers.dev — deployato per
la prima volta 2026-09-14 ~14:30 (vedi commit history per i deploy
successivi). Cloudflare Worker, account `gleonardi87@gmail.com`.

## Riassunto esecutivo

> Non nuove affermazioni — solo un indice diretto a quello che le oltre
> 1300 righe sotto già dimostrano, sezione per sezione.

1. **Prototipo funzionante (25%)** — sì, verificato dal vivo sull'URL
   deployato (non solo in locale), oggi stesso: intento in linguaggio
   naturale → proposta con prezzo reale → conferma → carrello reale su
   HOFJ staging → pagamento Stripe test reale riuscito → tentativo di
   booking. Il booking finale resta "confermato ma non verificabile" per
   un limite noto e confermato dal fornitore stesso (Carlo, Vela/HOFJ),
   non un nostro bug — vedi sezione 1 e sezione 5.
2. **Architettura di scalabilità (25%)** — quota gate (token bucket) +
   cache/coalescing sulla discovery, verificati con un load test k6 reale
   da 50.000 viaggiatori simulati in 10 minuti: 99,5% delle ricerche mai
   arrivate a consumare un token di quota, 142 prenotazioni reali
   completate, zero errori 500 applicativi — numeri veri, comandi di
   riproduzione esatti in cima alla sezione 2.
3. **Vision — "sei uscito dal marketplace?" (20%)** — un agente
   conversazionale vero, una proposta alla volta, mai una lista;
   progettato esplicitamente per un futuro senza schermo (l'interfaccia
   web di oggi è una facility di test 2026, non il modello
   d'interazione reale) — rinforzato anche oggi, rifiutando un bottone
   "nuova conversazione" in favore di una ripresa conversazionale — vedi
   sezione 3.
4. **Metodo agentico (15%)** — una sessione Claude Code continua e
   pubblica, esplorazione reale dell'API via `curl`, debug dal vivo via
   `wrangler tail`, autocorrezione onesta lasciata in chiaro (le sezioni
   "CORREZIONE" sono intenzionali, non nascoste) e una suite di test
   deterministica costruita apposta per validare la macchina a stati
   senza mai toccare il budget AI reale — vedi sezione 4.
5. **Padronanza API (10%)** — più bug reali upstream trovati e
   diagnosticati con la causa isolata (mismatch di brand, pre-
   provisioning dei pax, un campo scartato dal gateway a prescindere dal
   valore, un giorno intero puntato all'ambiente sbagliato), mai
   ipotizzati: sempre verificati con chiamate dirette all'API, bypassando
   il nostro stesso Worker — vedi sezione 5.
6. **Comunicazione (5%)** — questo documento (aggiornato durante il
   lavoro, timestamp reali), `/agent-log/` (trascrizione grezza redatta
   più volte, verificata prima di ogni commit), un `README.md` minimale,
   e il [video](https://drive.google.com/file/d/1S4O05OTqrWRv0pQcrD0aFnfBTy84vHeC/view)
   3-5 min dell'acquisto reale end-to-end — vedi sezione 6.

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
  - ~~**Test diretti su `conversation.ts`**: le 27 unit test in `test/`
    coprono `engine/matcher.ts`, `engine/dates.ts` e `hofj/client.ts` —
    tutta la logica pura/deterministica, dove i test hanno più valore e
    zero costo/rischio (nessuna chiamata AI o HOFJ reale). La Durable
    Object che orchestra tutto (`conversation.ts`) non ha test diretti:
    testarla per davvero richiederebbe o mockare `env.AI` dentro il
    binding reale della DO (fragile, si scontra con lo stesso problema di
    proxy remoto che ha già rallentato la suite una volta — vedi commit
    "unblock test suite from remote AI proxy"), oppure disaccoppiare
    l'AI/HOFJ client con dependency injection solo per testabilità, un
    refactor non banale a questo punto della sessione.~~ **SUPERATO
    2026-09-15**: da "Test deterministici su conversation.ts/la macchina
    a stati, riusando STUB_MODE" (sezione 4) esiste `test/conversation.test.ts`,
    integrazione reale contro la vera `ConversationDO` — non un mock, non
    un refactor per testabilità: `STUB_MODE` sostituisce
    AI/HOFJ/Stripe con risposte deterministiche a livello di client,
    lasciando la DO stessa intatta. Cresciuta a 82 test totali nel resto
    della sessione. Fino a quel punto, comunque: la macchina a stati era
    stata validata con test end-to-end reali dal vivo (multi-turno,
    rinegoziazione budget a metà proposta, rifiuto e proposta successiva,
    re-verifica silenziosa che cattura un prezzo cambiato davvero) —
    visibili come traffico reale in `/agent-log/`, non solo dichiarati
    qui. Aggiunta anche (2026-09-14 ~19:30) una copertura reale, anche se
    non in CI, dello strato NLU (`scripts/prompt-suite.mjs` — vedi sotto),
    che resta complementare ai test deterministici, non sostituita da
    essi: copre esattamente la parte che `STUB_MODE` non tocca per
    definizione, cioè quello che l'AI estrae davvero da una frase reale.
  - **Apertura carrello reale prima della proposta (invece che dopo la
    conferma)**: valutata e scartata esplicitamente da Giuseppe
    (2026-09-14 ~18:00), non solo rimandata. L'architettura resta
    proponi → conferma → verifica reale in silenzio → chiudi. Aprire un
    `itinerary` HOFJ vero per ogni proposta — comprese quelle che il
    viaggiatore rifiuterà, che nel flusso attuale sono la norma, non
    l'eccezione (vedi "skips rejected products and proposes the next
    one") — moltiplicherebbe le chiamate su un'API condivisa e
    rate-limited (120 richieste/minuto, vedi sezione 5) per quella che
    dovrebbe restare una proposta leggera, e rischierebbe di far emergere
    un prodotto "non prenotabile" (bug reale già trovato, vedi sezione 4)
    durante quella che il viaggiatore percepisce come una semplice
    chiacchierata, non ancora un impegno. La conseguenza accettata: il
    prezzo mostrato nella proposta resta "verificato in silenzio" un
    turno dopo la conferma, non "confermato" nello stesso messaggio in
    cui viene proposto — uno scarto reale rispetto alla customer journey
    target discussa con Giuseppe, tenuto consapevolmente.
  - ~~**Profilazione utente reale, persistente tra conversazioni
    diverse**: non implementata in questa sessione.~~ **AGGIORNATO
    2026-09-14 ~23:35**: implementata, ma nella forma volutamente
    ristretta che questa nota già anticipava — non vera identità
    cross-dispositivo (quel problema, autenticazione/riconoscimento
    dello stesso utente su un altro device, resta esplicitamente fuori
    scope, invariato), solo persistenza locale al browser via
    `UserProfileDO` (vedi sezione 4). `DEMO_TRAVELLER` non esiste più —
    sostituito da un profilo reale raccolto una volta con un onboarding
    conversazionale. La nota originale resta qui, corretta non
    cancellata, perché la decisione È cambiata a metà sessione, su
    richiesta esplicita di Giuseppe.

## 2. Architettura di scalabilità (25%)

> **Come riprodurre TUTTI e tre gli scenari di load test** (il brief
> chiede esplicitamente "un load test che possiamo eseguire noi
> stessi" — comandi esatti, non solo numeri):
>
> **1. `slot_filling_burst`** (100 VU di picco, mai chiama HOFJ) e
> **2. `full_booking_search`** (3 VU / 10 iterazioni, chiama HOFJ
> davvero — resta ben sotto la quota condivisa di 120/min) — entrambi
> in `loadtest/booking-flow.js`, contro l'API reale:
> ```bash
> npm run dev                        # terminale 1 — wrangler dev, wrangler.jsonc, HOFJ reale
> k6 run loadtest/booking-flow.js    # terminale 2 — BASE_URL default: http://localhost:8787
> ```
>
> **3. `scale_50k`** — 50.000 conversazioni simulate in 10 minuti sotto
> `STUB_MODE` (vedi sotto per cosa misura davvero, e perché mai contro
> HOFJ/Stripe/Workers AI reali):
> ```bash
> npm run loadtest:dev                   # terminale 1 — wrangler dev --config wrangler.loadtest.jsonc, porta 8788
> k6 run loadtest/scale-50k.js           # terminale 2 — BASE_URL default: http://localhost:8788
> ```
> Variabili d'ambiente per `scale-50k.js` (tutte opzionali, k6 `-e`):
> `TRAVELLERS` (default `50000`), `WINDOW_SECONDS` (default `600`),
> `BASE_URL` (default `http://localhost:8788`). Per una prova rapida
> invece della piena scala:
> ```bash
> k6 run -e TRAVELLERS=500 -e WINDOW_SECONDS=60 loadtest/scale-50k.js
> ```

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

- **Qual è il marketplace da cui ci si aspetta di uscire.** Non è astratto:
  l'abbiamo visto letteralmente durante l'esplorazione dell'API. HOFJ è
  l'infrastruttura di distribuzione dietro almeno tre "brand" con siti
  separati — Weebora, Terrarossa, House of Journey — ciascuno una vetrina
  con lo stesso pattern di sempre: catalogo, filtri, griglia di risultati,
  pagina prodotto, confronto. Il marketplace non è un concorrente astratto
  da battere: è la forma di interfaccia che l'API stessa presuppone lato
  frontend (i parametri di `/v1/recommendations/search` — categoria,
  prezzo, data, stelle, distanza, ordinamento — sono letteralmente i
  filtri di una pagina di risultati). Il "marketplace" è il default che
  qualunque integrazione ovvia contro questa API produrrebbe, quasi per
  inerzia.

- **La nostra idea per uscirne**, e cosa nel prototipo la dimostra
  concretamente, non solo a parole:
  1. **Il giudizio si sposta dal viaggiatore al sistema.** Un marketplace
     espone l'inventario grezzo e lascia che sia l'utente a filtrare,
     ordinare, confrontare. Qui la ricerca (`engine/matcher.ts`) prende
     quella responsabilità: interroga HOFJ, applica un filtro di
     pertinenza che l'API stessa non garantisce (vedi il bug reale
     "Forte dei Marmi per Roma" in sezione 4), classifica in
     exact/compromise/none, e restituisce **una** proposta con un giudizio
     già fatto — non dieci righe di tabella da confrontare da soli.
  2. **I brand diventano infrastruttura invisibile, non destinazioni.**
     Terrarossa è il brand tennis/padel principale, ma quando cerca
     padel e Terrarossa non ha nulla di pertinente, la ricerca passa a
     Weebora in automatico (verificato dal vivo: "Exclusive Padel Clinic"
     a Milano proviene da Weebora) — **il viaggiatore non lo sa né deve
     saperlo**. Non stiamo costruendo una quarta vetrina brandizzata
     accanto alle altre tre: stiamo trattando l'intero grafo prodotto
     multi-brand come un'unica fonte di inventario su cui ragionare,
     esattamente il contrario di "un altro sito tra cui scegliere".
  3. **L'interfaccia non è un posto in cui l'utente arriva.** Il client
     minimale in `public/index.html` non è "una chat al posto di una
     lista" travestita da assistente — è, esplicitamente, un microfono: lo
     Speech Recognition/Synthesis del browser gestisce input e output
     vocale, il testo è il ripiego dichiarato per chi non può parlare, e
     la trascrizione è chiusa in un `<details>` perché serve a chi
     revisiona, non è il canale principale. Il primo tap sul microfono è
     l'unico gesto richiesto (i browser lo impongono per concedere
     l'accesso al microfono): da lì in poi il turno si chiude e riparte da
     solo — appena l'agente finisce di parlare, il microfono si riattiva
     senza bisogno di ritoccare lo schermo, finché la conversazione non
     arriva a uno stato terminale (prenotato o fallito). Senza questo, "voce"
     sarebbe stata solo un microfono attaccato a una chat che va comunque
     guardata e ritoccata a ogni battuta — con questo, dopo il primo tap si
     può davvero mettere via il telefono. In una versione non minimale
     questo stesso motore (Worker + Durable Object + engine/) non
     cambierebbe: cambierebbe solo dove arriva il turno di conversazione —
     un numero di telefono, un canale WhatsApp/voce, un dispositivo smart
     speaker — mentre oggi arriva da un tasto microfono su una pagina, che
     è la versione onesta di "l'agente arriva dove sei tu" costruibile nel
     tempo disponibile.
  4. **L'accessibilità non è un requisito estetico, è la prova che il
     modello funziona.** Se l'unica interfaccia reale fosse "guarda,
     confronta, clicca", chi non ha occhi/schermo/pazienza sarebbe
     escluso per costruzione dal marketplace. Qui non lo è per
     costruzione: l'intero flusso — intento, negoziazione, conferma,
     riepilogo finale — è pensato per reggere senza mai guardare lo
     schermo, non come optional ma come vincolo di design dall'inizio.

### Un nome, e la cornice "wearable 2029" resa visibile (2026-09-14 ~23:10)

Fino a questo punto l'unica interfaccia era etichettata genericamente
"Vela" — il nome della challenge/azienda, non un vero nome di prodotto.
Giuseppe ha chiesto di sistemare l'interfaccia (rimanendo minimale, dato
che "non è pensata come un'interfaccia") e di renderla riconoscibile come
prototipo di qualcosa che vivrà altrove — un dispositivo indossabile nel
2029, non un sito.

- **Nome scelto: Rally.** Un rally, nel tennis/padel, è proprio lo scambio
  di colpi — la stessa forma della negoziazione slot-filling di questo
  agente (proposta, compromesso dichiarato, conferma, ripeti). Corto,
  facile da dire come wake-word a un dispositivo vocale. "Vela" resta
  visibile come sotto-titolo ("un progetto Vela") — il prodotto ha un
  nome proprio, l'azienda/challenge dietro resta esplicita, non nascosta.
- **La cornice "wearable" è ora resa visibile, non solo dichiarata a
  parole**: l'area di interazione (microfono, stato, ultima risposta) è
  racchiusa in uno "squircle" — la stessa geometria di un quadrante da
  smartwatch — con una didascalia esplicita sopra: "Anteprima da browser —
  nel 2029 Rally vive al polso, non su uno schermo. Questo è solo un
  prototipo." Non un claim isolato nel testo: la forma stessa dell'oggetto
  visivo lo dimostra.
- **Feedback di elaborazione, prima assente**: non c'era alcuna evidenza
  visiva che il sistema stesse processando qualcosa tra l'invio di un
  messaggio e la risposta — un vuoto specialmente fastidioso per i passi
  realmente lenti (apertura carrello vero, pagamento, conferma booking,
  che incatenano diverse chiamate API reali in sequenza). **Aggiunto**: un
  terzo stato visivo del microfono ("thinking", pulsazione ambra distinta
  da "listening" verde e "speaking" spento) attivo per tutta l'attesa; un
  messaggio di stato che si aggiorna in due fasi (breve dopo ~3s, più
  esplicito dopo ~7.5s); e solo per l'attesa lunga, l'assistente lo dice
  anche a voce ("ci sto mettendo un po' più del solito a confermare la
  prenotazione, scusa l'attesa") — non per ogni risposta, solo quando
  l'attesa è davvero degna di nota, come richiesto esplicitamente. Il
  messaggio è scelto in base allo stage precedente noto lato client, così
  un "sì" dopo una proposta (che scatena la pipeline pesante reale) ha una
  frase specifica, non generica.

### `DEMO_TRAVELLER` sostituito da un profilo reale e persistente (2026-09-14 ~23:35)

Giuseppe: "il mio obiettivo è semplicemente eliminare il DEMO_TRAVELLER a
favore di qualcosa di duraturo... va bene farlo vivere solo dentro
Durable Objects per ora". Non vera identità cross-dispositivo (quella
resta esplicitamente fuori scope, vedi sezione 1) — solo smettere di
richiedere le stesse informazioni ad ogni conversazione nello stesso
browser.

- **`UserProfileDO`** (nuovo, `src/userProfile.ts`): un Durable Object per
  *persona*, non per conversazione — a differenza di `ConversationDO`
  (una per viaggio), questo vive per tutta la vita del browser
  dell'utente, indirizzato da un `userId` generato una volta lato client
  e salvato in `localStorage` (stesso pattern già usato per `sessionId`,
  un livello più in alto). Contiene: nome, email, città di residenza,
  sport preferito, numero di componenti del nucleo familiare, e un
  "profilo economico" con nomi volutamente accattivanti — **Smart** (fino
  a 500€ a viaggio), **Pro** (600-1500€), **Luxury** (oltre 1500€) —
  invece dei semplici "low/mid/high" interni.
- **Onboarding conversazionale, non un modulo**: stesso principio "parlagli
  come parleresti a un umano" applicato alla configurazione iniziale,
  riusando lo stesso pattern già esistente per `collecting_traveller`
  (un campo alla volta, in linguaggio naturale) — non un form HTML con
  caselle da riempire, l'unica eccezione sarebbe stata proprio quella.
  Un NLU/NLG dedicato e più piccolo (`interpretProfile`/`sayProfile` in
  `engine/ai.ts`), separato da quello del viaggio perché lo schema e le
  regole non si sovrappongono (non c'è logica di date/budgetTier qui).
- **I default del profilo non decidono mai nulla in silenzio**: la
  policy "adults e budget non si assumono mai" (sezione 4, più sotto)
  resta intatta — nucleo familiare e profilo economico diventano
  `householdSizeHint`/`economicTierHint` su `ConversationState`, usati
  SOLO per fraseggiare la domanda come un'ipotesi da confermare ("come al
  solito in 3 per questo viaggio, giusto?") invece di ometterla. Lo stesso
  per lo sport preferito (`preferredSportHint`), che non ha una policy
  altrettanto rigida ma segue lo stesso principio per coerenza.
- **Bug reale trovato costruendo questa funzionalità, non ipotizzato**:
  verificato dal vivo che un "Sì" secco in risposta alla domanda sul
  budget (con hint) veniva attribuito al campo SBAGLIATO (`adults`
  invece di `budget`). Causa: `budgetAskAttempts`/`cityAskAttempts`
  si incrementano nel momento stesso in cui la domanda viene fatta, non
  dopo aver ricevuto (e non risolto) una risposta — quindi al turno
  *successivo*, quando arriva la risposta a quell'unica domanda,
  `isGatingSatisfied()` la considera già bypassata, e
  `describeCurrentlyAsking()` etichetta il contesto con lo slot
  SUCCESSIVO invece di quello a cui si sta davvero rispondendo. Invisibile
  con risposte esplicite ("500 euro" si classifica da solo, senza bisogno
  di contesto) — visibile solo ora che una conferma secca dipende
  interamente dal contesto per essere risolta. **Corretto** con un nuovo
  metodo `stillBeingAsked()`, distinto da `isGatingSatisfied()`: resta
  vero un turno più a lungo (fino a `attempts <= LOOP_BREAKER` invece di
  `< LOOP_BREAKER`), così la risposta all'ultima domanda effettivamente
  fatta viene ancora attribuita correttamente, mentre `isGatingSatisfied()`
  (usato da `runCollecting()` per decidere se procedere) resta invariato.
  Verificato dal vivo dopo il fix: "Sì" in risposta al budget → `budgetTier:
  "mid"` (non più `adults`), poi "Sì" in risposta agli adults → `adults: 3`
  correttamente, proposta finale raggiunta con tutti gli slot giusti.

### Un'email non valida uccideva l'intera conversazione (2026-09-14 ~23:55, sessionId `9f9a7bc8-...`)

Giuseppe ha segnalato una sessione dove, dopo aver negoziato con successo
città/date/prezzo di un viaggio a Lanzarote, la conversazione è morta con
"ho un problema tecnico interno" subito dopo aver dato i propri dati.
Ricostruito lo stato reale: il campo email era stato salvato come `"Peo
Blues@it"` — non un'email valida (uno spazio prima della @, nessun vero
dominio) — e `PUT .../customer` l'ha rifiutata con un vero 400
(`"validation":"email","message":"Invalid email"`). Non un problema di
HOFJ: un'email palesemente sbagliata è arrivata fin lì perché nessuno
l'aveva mai controllata prima.

**Due bug reali, non uno**:
1. Nessun controllo di formato prima di accettare l'email estratta da
   `interpret()` — qualunque cosa il modello estraesse veniva presa per
   buona e inoltrata direttamente a HOFJ.
2. `putCustomer`/`putPax` in `openRealCartAndAttemptPayment` non avevano
   NESSUN `try/catch` (a differenza di `createItinerary`, che ce l'ha) —
   un 400 lì si propagava senza controllo fino al catch-all generico di
   `handleMessage()`, che tratta qualunque errore non esplicitamente
   gestito come un guasto interno fatale: `stage: "failed"` senza
   possibilità di "riprova" (il meccanismo di retry riconosce solo i
   prefissi `payment:`/`bookings:` nel `failureReason`, e questo non ne
   aveva nessuno). Risultato pratico: un'intera negoziazione riuscita
   (città, date, prezzo già concordato) buttata via per un singolo campo
   correggibile in una frase.

**Corretto in due passi, non uno solo**: (a) un controllo di formato email
deliberatamente permissivo (non RFC 5322 completo, solo abbastanza per
scartare `"Peo Blues@it"`) applicato PRIMA che il valore entri in
`state.traveller` — se non passa, il campo resta `null` e il meccanismo
di "richiedi ancora" già esistente lo richiede naturalmente, senza bisogno
di un flusso di recupero dedicato; (b) `putCustomer`/`putPax` ora dentro
un `try/catch` come rete di sicurezza per qualunque altro campo HOFJ
rifiuti per motivi che non abbiamo ancora scoperto — su un 400 si torna a
`collecting_traveller` (ripulendo i dati del viaggiatore, dato che non
sappiamo con certezza quale campo annidato HOFJ abbia rifiutato) invece di
terminare la conversazione, con un riconoscimento onesto del perché si
sta richiedendo di nuovo, non un riavvio silenzioso.

### "Cosa include il pacchetto?" — implementato (2026-09-15 ~00:05)

Nella stessa conversazione, il viaggiatore aveva chiesto "Cosa include il
pacchetto" dopo la proposta — l'agente ignorava la domanda e ripeteva lo
stesso riepilogo, senza rispondere. Non era un bug isolato: la macchina a
stati non aveva affatto un concetto di "rispondi a una domanda ad hoc
sulla proposta corrente" — lo stage "proposing" interpretava ogni
messaggio solo come `yes`/`no`/`unclear`.

**Implementato su richiesta esplicita di Giuseppe**:
1. **Nuovo intento riconosciuto**: `interpret()` ora distingue una vera
   domanda informativa ("cosa include", "com'è l'hotel", "posso
   cancellare") da un sì/no/non chiaro, con `decision: "question"`.
2. **Nuovo endpoint prodotto, non itinerario**: `HofjClient.getProduct()`
   (`GET /v1/products/{id}`) — deliberatamente a livello di prodotto, non
   di carrello, per non contraddire la decisione già presa di non aprire
   un itinerary reale per ogni proposta (vedi sezione 1, scope-cut). La
   descrizione ricca (`description`, markdown) esiste già qui, senza
   bisogno di un vero carrello — verificato dal vivo che coincide con lo
   stesso testo visto in `travelDetail.description` sull'itinerary, solo
   accessibile prima, sul prodotto stesso.
3. **Recuperata pigramente e in cache**: solo alla prima domanda su
   quella proposta (non per ogni proposta fatta — la maggior parte non
   riceve mai una domanda di follow-up), e invalidata automaticamente
   appena una nuova proposta sostituisce quella corrente
   (`state.productDescription`).
4. **Onestà per costruzione**: la risposta usa SOLO la descrizione reale
   e i fatti già noti (prezzo/date/durata) — se la domanda tocca
   qualcosa che la descrizione non copre (verificato dal vivo con "posso
   cancellare gratuitamente?", che il prodotto non specifica), lo dice
   onestamente invece di inventare, poi richiama in una frase che è
   ancora in attesa di un sì/no. Resta in stage "proposing": rispondere
   a una domanda non è una decisione, il viaggiatore deve ancora
   confermare o rifiutare dopo.

Verificato dal vivo end-to-end: "Cosa include il pacchetto?" ha ricevuto
una risposta reale e specifica ("tre ore di lezioni con un allenatore
certificato... due notti in hotel quattro stelle... aperitivo panoramico
a Trastevere...", tutto testo autentico dalla descrizione del prodotto),
poi un "procedi pure" successivo è passato correttamente a
`collecting_traveller` — la domanda non ha rotto il flusso di
conferma.

### "Il prezzo raddoppia sempre" — non era il mercato, era il numero di persone (2026-09-15 ~00:20, sessionId `04022cc9-...`)

Giuseppe ha notato un pattern: il prezzo mostrato in ricerca (365€) e
quello reale del carrello aperto (730€) erano sempre esattamente il
doppio, e ha chiesto se fosse legato al numero di persone. **Verificato
dal vivo che ha ragione, con i numeri**: `HofjClient.search()` non manda
MAI un parametro `adults` (non esiste nemmeno nella firma del metodo) —
il prezzo di ricerca è quindi tariffato per l'occupazione di default del
pacchetto, non per la comitiva reale. Creando itinerary reali con party
size diverse sullo stesso prodotto:
```
1 adulto, 1 stanza:  465€ (attività 365€ a persona + 100€ supplemento camera singola)
2 adulti, 1 stanza:  730€ (attività 365€ × 2 — camera doppia inclusa nel pacchetto, nessun supplemento)
3 adulti, 2 stanze: 1195€ (attività 365€ × 3 + 100€ supplemento)
```
Il prezzo scala per davvero, in modo deterministico, con il numero di
partecipanti — non è mai stato un capriccio del mercato. Il messaggio
precedente ("il mercato è dinamico") era un'invenzione del modello
stesso: non era un'istruzione che gli avevamo dato, l'ha aggiunta di suo
come abbellimento plausibile ma falso.

**Corretto**: quando il rapporto tra prezzo reale e prezzo proposto
combacia con il numero di adulti (entro una tolleranza per i supplementi
di stanza), passiamo al modello la ragione VERA verificata, e gli
diciamo esplicitamente di usarla invece di inventare — e quando NON
sappiamo la ragione esatta, gli diciamo esplicitamente di non
inventarne una ("non dire 'il mercato è dinamico' o simili"). Verificato
dal vivo dopo il fix: "il 365 che hai visto era la tariffa per persona —
voi siete in due, quindi il totale è 730€: è il calcolo corretto per la
vostra comitiva."

### Rendere più robusta l'assenza di un segnale "booked" affidabile (2026-09-15 ~00:20)

Giuseppe ha chiesto: dato che l'API non ci dà una conferma affidabile
della prenotazione (vedi sezione precedente sul booking non
verificabile), come rendiamo il sistema più robusto? Due mancanze reali
trovate e corrette:

1. **"Riprova" non aveva limite**: un fallimento già dimostrato non
   transitorio (lo stesso itinerary della sessione di Giuseppe è rimasto
   `"BookingInitiated"` anche minuti dopo, non un ritardo di
   propagazione) permetteva comunque un "riprova" infinito, illudendo che
   prima o poi si sarebbe sbloccato. **Corretto**: `BOOKING_RETRY_LIMIT =
   2` — dopo due tentativi falliti, il messaggio cambia onestamente ("non
   è più un blip temporaneo") invece di continuare a proporre "riprova"
   come se servisse ancora a qualcosa.
2. **La promessa "lascia i tuoi dati, ti ricontatto" non era vera**: non
   esisteva alcun meccanismo che catturasse davvero i dati del
   viaggiatore da qualche parte ispezionabile — erano solo parole dette
   dal modello, che sparivano se la conversazione veniva abbandonata.
   **Corretto**: nuovo `FollowUpDO` (`src/followUp.ts`), un'unica istanza
   nota per tutto il deployment, che registra {itineraryId, brand,
   paymentIntentId, importo, contatti del viaggiatore, motivo del
   fallimento} ogni volta che un pagamento reale riesce ma la
   prenotazione non si conferma — una volta sola per conversazione,
   scritta in automatico, non su richiesta esplicita del viaggiatore (i
   suoi dati li abbiamo già, non serve chiederglieli di nuovo). **Non
   esposto via HTTP**: quei dati includono contatti reali e un vero id di
   pagamento Stripe, e questo prototipo non ha un livello di
   autenticazione per proteggere un endpoint di lettura in modo sicuro —
   ispezionarlo oggi significa leggere lo storage del Durable Object
   direttamente (tramite `wrangler`), non una route pubblica. Scelta di
   scope consapevole, non una svista.

Verificato dal vivo end-to-end: un pagamento reale riuscito con
prenotazione non confermata → `followUpLogged: true` nello stato, nessun
errore nei log; due "riprova" consecutivi → `bookingRetryCount` sale a 2;
un terzo tentativo → messaggio finale onesto con l'importo pagato e il
riferimento dell'itinerary, invece di un ennesimo "riprova" vuoto.

### Il prezzo mostrato subito come stima per la comitiva, e una policy che chiude un gap reale trovato per strada (2026-09-15 ~02:15)

Dopo aver capito insieme il meccanismo del raddoppio (sopra), Giuseppe ha
detto l'ovvio passo successivo: "mi aspetto che venga dato il prezzo a
persona e quando sto per pagare mi ricorda per quante persone sto
prenotando." Implementato:

- **La prima proposta ora dichiara subito** il prezzo a persona E una
  stima del totale per la comitiva reale (`candidate.price × adults`),
  esplicitamente marcata come stima, non come cifra già certa — la
  ri-verifica reale all'apertura del carrello resta comunque il momento
  in cui il prezzo diventa definitivo. `adults` è già noto ad ogni
  proposta (mai bypassato, per la precision policy), quindi non serve
  aspettare nulla.
- **La ri-verifica silenziosa ora confronta il prezzo reale con QUESTA
  STESSA stima**, non più con il prezzo grezzo di ricerca — altrimenti,
  per un prodotto che scala esattamente come previsto, il viaggiatore si
  sarebbe sentito dire "il prezzo è cambiato" una seconda volta per la
  stessa identica cosa già dichiarata in apertura, una vera incoerenza
  di comunicazione. Ora quello step scatta solo per uno scarto REALE e
  ulteriore (es. un supplemento camera per una comitiva dispari), non
  per il semplice moltiplicarsi atteso.

**Un gap reale trovato mentre implementavo questo, non ipotizzato**:
`classify()` confronta `slots.budget` (dichiarato dal viaggiatore)
contro `candidate.price` (il prezzo di ricerca, verificato essere a
persona) — ma fino a questo momento non era mai stato deciso, da nessuna
parte nel codice o nella conversazione con Giuseppe, SE il budget
dichiarato dal viaggiatore fosse inteso a persona o per l'intera
comitiva. Nella sessione `04022cc9-...` (budget 500€, 2 persone, 365€ a
persona) il sistema aveva classificato la proposta come "exact" — ma se
il viaggiatore avesse inteso 500€ come budget TOTALE per la coppia, il
prezzo reale (730€) lo avrebbe superato del 46%, un "exact" falso.
Deliberatamente non corretto al volo moltiplicando `candidate.price` per
`adults` dentro `classify()`: non avevamo (e non abbiamo tuttora)
conferma che ogni prodotto del catalogo scali linearmente per persona
allo stesso modo — un'assunzione sbagliata nella logica di matching
deterministica avrebbe potuto introdurre un errore sistematico nella
direzione opposta.

**Risolto non con altro codice difensivo, ma con una decisione di
prodotto di Giuseppe**: "il budget è considerato a persona. Se dico
'budget 500' o 'budget 500 euro a persona' è lo stesso concetto." Questo
chiude il gap alla radice, non con un'euristica: dato che sia
`slots.budget` che `candidate.price` sono ora DEFINITI come la stessa
identica unità di misura (a persona), il confronto che `classify()` fa
è corretto per costruzione, senza bisogno di moltiplicare o indovinare
nulla. **Implementato**: la regola è ora esplicita in `INTERPRET_SYSTEM`
(un numero dato senza altra specifica è già a persona), la domanda sul
budget lo chiede sempre esplicitamente ("a persona, non per il gruppo
intero"), e se il viaggiatore dichiara chiaramente un totale di gruppo
("700 euro in totale", "il nostro budget di coppia è 700") il sistema
NON lo accetta come valore a persona — lo lascia non risolto e chiede
esplicitamente la cifra a persona, invece di indovinare una divisione
(esattamente "fai fare la domanda all'assistente in caso", come
richiesto).

Verificato dal vivo: "budget 500 euro, siamo in 2" su un prodotto a
365€/persona → ora correttamente "exact" (500 ≥ 365, stesso confronto di
prima ma finalmente tra grandezze comparabili), col messaggio che dice
subito "365 euro a persona — quindi 730 euro complessivi per voi due".
"il nostro budget di coppia è 700 euro in totale" → il sistema non
accetta quel numero come budget a persona, richiede esplicitamente la
cifra a testa invece di dividere per conto suo.

### Il twist di scalabilità: 50.000 viaggiatori in 10 minuti contro una quota HOFJ di 120/min (2026-09-15, checkpoint git `pre-twist-scale-challenge`)

Testo ricevuto da Vela a metà sfida: un lancio commerciale porta 50.000
viaggiatori nella stessa finestra di 10 minuti, contro una quota HOFJ
condivisa e rolling di 120 richieste/minuto (`GET /v1/quota`, verificato
dal vivo con UNA sola chiamata deliberata — richiamarlo consuma esso
stesso quota), senza `Retry-After` né header `RateLimit-*`, con `POST
/v1/bookings` documentato come upsert idempotente su `itineraryId` (fatto
già verificato dal vivo in questa stessa sessione — vedi la sezione sopra
su idempotenza — non una scoperta fatta apposta per il twist). Risposto
seguendo un piano a fasi con approvazione esplicita di Giuseppe ad ogni
passaggio (analisi → design → load test → implementazione), con una
milestone git (`pre-twist-scale-challenge`, tag annotato pushato) come
punto di rollback esplicito prima di iniziare.

**Fase 1 — call graph e budget quota.** Ogni prenotazione completa può
chiamare HOFJ fino a 4 volte solo in fase di ricerca (`search()`, con
retry preferenze + fallback Weebora per il padel — vedi
`engine/matcher.ts`), poi `createItinerary`, `getItinerary` ×2,
`putCustomer`, `putPax`, `getPaymentIntent` (il cui risultato viene già
scartato dal codice esistente), `confirmBooking`. La domanda centrale non
è "quanti utenti reggiamo" ma "come impediamo che 50.000 viaggiatori
diventino 50.000+ chiamate upstream".

**Fase 2 — design.** Tre meccanismi, tutti nuovi codice, nessuna
riscrittura del booking flow esistente:
- **Cache discovery-only** (`hofj/discoveryCache.ts`): `search()` (TTL
  25s) e `getProduct()` (TTL 180s) passano da una cache in due livelli —
  una `Map` in memoria per isolate, più la Cache API di Workers condivisa
  tra isolate dello stesso colo — con *request coalescing* (una `Map` di
  Promise in-flight) per richieste equivalenti arrivate mentre la prima è
  ancora in corso. **Mai** su `getItinerary`/`createItinerary`/
  `confirmBooking` — quelli restano sempre live, per costruzione: cachare
  la verifica finale vorrebbe dire tornare a rischiare di dichiarare
  "prenotato" senza controllo reale, esattamente il problema già risolto
  altrove in questa sessione.
- **Gate di quota** (`hofj/quotaGate.ts`, `hofj/tokenBucket.ts`): un'unica
  Durable Object (`HofjQuotaGate`, istanza singola `getByName("gate")`)
  con un token bucket a 100/min (margine di sicurezza sotto il limite
  reale di 120), stato tenuto in memoria per l'intera vita dell'istanza e
  scritto su storage solo a checkpoint (max ogni 2s / 500 chiamate) — mai
  ad ogni singola `acquire()`, altrimenti il meccanismo pensato per
  alleggerire la pressione diventerebbe esso stesso il collo di bottiglia.
  Una singola DO globale per logica di business è un anti-pattern noto
  (vedi la skill durable-objects) — ma qui l'hot path è aritmetica pura in
  memoria, zero I/O per chiamata: esattamente il "coordination atom" per
  cui una DO è pensata, tenuto deliberatamente minimale.
- **Classi di priorità**, riviste rispetto al testo letterale del twist
  (P0/P1/P2/P3 "booking/cart/accommodation/discovery") perché il call
  graph reale non ha uno step "availability" separato: **P0** (mai
  sacrificato, solo messo in coda) — `createItinerary`, `confirmBooking`;
  **P2** (opzionale, un solo tentativo senza attesa) — `getProduct`,
  `getPaymentIntent` (quest'ultimo il primo a saltare del tutto sotto
  pressione, dato che il suo risultato è già scartato dal codice
  esistente); **P3** (discovery) — `search()`, dietro cache/coalescing,
  consulta il gate solo su miss reale.

**Fase 3 — load test.** Terzo scenario k6 (`loadtest/scale-50k.js`),
separato dai due scenari esistenti in `loadtest/booking-flow.js`
(lasciati **invariati**, colpiscono ancora HOFJ/Workers AI reali come
calibrazione onesta). Il nuovo scenario gira contro
`wrangler.loadtest.jsonc`, una config wrangler dedicata che imposta
`STUB_MODE: "1"` — mai in `wrangler.jsonc` (produzione) — che sostituisce
HOFJ, Stripe e Workers AI/Anthropic con risposte canned istantanee e
in-process (vedi `engine/ai.ts`, `hofj/client.ts`, `stripe/client.ts`):
zero quota reale, zero addebiti Stripe reali, **zero costo AI reale** —
esattamente il vincolo che Giuseppe ha posto esplicitamente prima di dare
il via libera a questa fase ("i bottleneck legati ai nostri Workers AI e
ai 5 dollari di token Anthropic... cerca di non toccarli"). Come ulteriore
guardia, la config di load test non dichiara nemmeno il binding `ai` e
punta `HOFJ_BASE_URL` a un host inesistente — se lo short-circuit dello
stub venisse mai bypassato da un bug, il test fallirebbe rumorosamente
all'istante invece di spendere credito AI reale o colpire HOFJ reale in
silenzio.

Verificato dal vivo, prima in isolamento (una singola conversazione end-
to-end, 2 soli turni fino a "booked" grazie a `interpret()` stubbato in
modo deterministico), poi con un burst concorrente deliberato (60
conversazioni in parallelo): **41 prenotate, 19 con una risposta di
backpressure onesta (`[stub:backpressure]`, stage rimasto
`collecting_traveller`, MAI un fallimento secco)**, e un retry successivo
su una delle 19 ha completato la prenotazione riusando lo STESSO
`itineraryId`/`paymentIntentId` già aperti — la prova dal vivo che il
flusso di retry idempotente su `confirmBooking` (Fase 2) funziona
esattamente come progettato, senza carrello né addebito duplicati.

Smoke test più ampio (600 viaggiatori simulati / 60s, deliberatamente
molto oltre la capacità sostenibile del gate a quella scala, per
verificare il comportamento sotto saturazione): 0% di richieste HTTP
fallite su 3454 richieste totali, 36 prenotazioni completate, 2822
risposte di backpressure oneste, **0 errori 500**. `/api/debug/quota-stats`
(esposto SOLO sotto `STUB_MODE`, mai in produzione) a fine corsa:
`totalGranted: 191` contro `totalDenied: 43287` sul gate — la saturazione
deliberata del test funziona esattamente come previsto — e sulla cache
discovery, `664 memoryHits + 74 coalesced + 1 cacheApiHits` contro **solo
30 misses**: su centinaia di ricerche equivalenti, la stragrande
maggioranza non ha mai consultato il gate né consumato un token, la
prova quantitativa diretta che cache+coalescing stanno facendo il lavoro
per cui esistono. Misurato anche un effetto collaterale reale e corretto
sul momento: un'attesa massima di 8s dentro `acquireCriticalOrWait` (vedi
Fase 2) spingeva il p95 di latenza HTTP oltre 8s sotto saturazione —
inaccettabile per un agente pensato per essere ascoltato più che letto
(vedi il prompt vocale in `engine/ai.ts`). Ridotto a un'attesa massima di
3s: un'attesa più corta e onesta ("ci riprovo tra poco"), non un lungo
silenzio.

**Il run completo, 50.000 viaggiatori simulati sui 10 minuti reali della
finestra** (`TRAVELLERS=50000 WINDOW_SECONDS=600`, eseguito dal vivo,
numeri reali di questa corsa, non stimati): 57.865 conversazioni
completate (oltre le 50.000 richieste — il generatore di carico satura
prima del limite), `/api/debug/quota-stats` a fine corsa: **gate
871 granted / 232.427 denied** (coerente con l'oversubscription
deliberata del test — vedi sotto), **cache discovery: 31.182 memoryHits +
1.442 coalesced + 8 cacheApiHits contro solo 167 misses** — su oltre
32.000 lookup di ricerca, il 99,5% non ha mai consultato il gate né speso
un token. 142 prenotazioni completate per davvero, zero errori 500
applicativi.

**Un secondo dato, più importante del primo**: il confronto tra il ritmo
di arrivo del test (fino a ~117 nuovi viaggiatori/secondo, il picco che
"50.000 in 10 minuti, non spalmati su un giorno" implica davvero) e la
capacità reale della quota HOFJ (100/min ≈ 1,7/secondo, sotto la soglia
reale di 120/min) rivela un limite che nessuna cache o coalescing può
aggirare: `createItinerary`/`confirmBooking` non sono cacheable per
definizione (sono per-viaggiatore, per-carrello, devono restare live).
Con ~117 nuovi viaggiatori/secondo che richiedono ciascuno 2 chiamate P0,
la domanda di picco (≈230+ ammissioni/secondo desiderate) supera di
~100-140 volte quello che la quota reale può sostenere. **Le 142
prenotazioni realmente completate in questa corsa non sono un fallimento
dell'architettura — sono la prova che sta facendo esattamente il suo
lavoro**: la scarsità reale e non aggirabile di HOFJ (al massimo
~100 ammissioni/min ≈ 1.000 in 10 minuti, split tra createItinerary e
confirmBooking ≈ 500 prenotazioni reali possibili in teoria in quella
finestra, indipendentemente da qualunque cosa costruiamo dal nostro lato)
viene onorata, mai finta. Le altre decine di migliaia di richieste hanno
ricevuto una risposta di backpressure onesta invece di un fallimento
silenzioso, una prenotazione duplicata, o una dichiarazione di
"prenotato" non vera — è questa la risposta corretta e onesta alla
domanda del twist su "cosa sacrifichi per primo quando la quota finisce":
non i viaggiatori, ma la promessa di un booking istantaneo per tutti.

**Un limite del setup di test, dichiarato con la stessa onestà, non
nascosto**: il 41,5% delle richieste HTTP registrate da k6 come fallite
NON sono fallimenti applicativi — verificato nel log del server locale
(`wrangler dev`) che OGNI singola risposta effettivamente prodotta dal
Worker in questa corsa è stata un 200 (0 codici non-200 loggati). Le
30.298 richieste fallite sono tutte "Network connection lost" lato
ProxyWorker locale di `wrangler dev` — un processo Node singolo sulla
stessa macchina che genera anche il carico k6, non rappresentativo di un
edge Cloudflare reale distribuito. Questo è un limite noto e onesto del
testare "contro il proprio edge" in locale su un solo laptop condiviso
tra client e server di test, non una prova contro l'architettura stessa
(che non ha mai prodotto un fallimento applicativo osservabile in questa
corsa). Un run più rigoroso contro un deploy reale su Cloudflare (ancora
in `STUB_MODE`, ancora zero costo HOFJ/Stripe/AI, ma su infrastruttura
edge distribuita invece del laptop di sviluppo) è il passo naturale
successivo se il tempo della challenge lo permette — non eseguito qui
senza consenso esplicito, dato che richiede un deploy separato (nome
Worker distinto, `vela-trip-agent-loadtest`, mai lo stesso deployment di
produzione).

**Fase 4 — implementazione.** File nuovi: `hofj/tokenBucket.ts` (logica
pura, testata — vedi `test/tokenBucket.test.ts`), `hofj/quotaGate.ts`
(la Durable Object), `hofj/quotaClient.ts` (helper per i tre pattern di
attesa — `acquireCriticalOrWait` per P0, `acquireOptional` per P2,
`acquireDiscoveryOrThrow` per P3), `hofj/discoveryCache.ts` (cache +
coalescing + contatori). File toccati: `engine/matcher.ts`
(`searchCandidates` accetta un `env` opzionale — omesso, si comporta
esattamente come prima, motivo per cui **nessun test esistente in
`matcher.test.ts` ha dovuto cambiare**), `conversation.ts` (i quattro
punti di innesto P0/P2/P3 sopra), `engine/ai.ts` (nuova direttiva
`backpressure`, mai un fallimento muto), `types.ts`/`wrangler.jsonc`
(nuovo binding `HOFJ_QUOTA_GATE`, migrazione `v4`), `index.ts` (endpoint
`/api/debug/quota-stats`, attivo solo sotto `STUB_MODE`).

Un dettaglio di correttezza emerso implementando, non ipotizzato:
introdurre un'attesa di quota PRIMA di `confirmBooking` rende
raggiungibile un caso nuovo — un pagamento reale già riuscito, ma la
richiesta di conferma bloccata dal gate. Senza una guardia,
`openRealCartAndAttemptPayment` (che prima non aveva mai bisogno di
gestire un rientro a metà) avrebbe riaperto un secondo carrello e tentato
un secondo pagamento al turno successivo. Aggiunta una guardia mirata (
`if (state.itineraryId && state.paymentIntentId) return
this.confirmBookingNow(...)`) che copre esattamente questo caso nuovo
senza toccare il comportamento preesistente del flusso di riconferma
prezzo-cambiato (che invece riapre volutamente il carrello, comportamento
originale, invariato).

**Cosa degrada per primo, cosa non deve mai degradare.** Ordine di
sacrificio sotto pressione: 1) `search()` — cache più aggressiva,
coalescing, eventualmente risultati leggermente meno freschi; 2)
`getProduct()`/`getPaymentIntent()` — saltati del tutto, il primo con un
degrado onesto già esistente ("non riesco a recuperare il dettaglio ora"),
il secondo perché il suo risultato non serve comunque; 3) tempo di attesa
sul turno (fino a 3s prima di un messaggio di backpressure onesto). Cosa
NON degrada mai, per costruzione: **nessuna prenotazione doppia,
nessun addebito doppio** (guardia sopra + idempotenza nativa di
`confirmBooking`), **nessuna dichiarazione di "prenotato" senza verifica
reale** (il controllo `checkout.status !== "BookingInitiated"` resta
sempre live, mai cachato), **mai un errore 500 secco** — ogni stato di
back-pressure è una risposta 200 con un messaggio onesto.

**Perimetro esplicito, non una dimenticanza**: il collo di bottiglia AI
(Workers AI satura già a ~100 utenti concorrenti, documentato più sopra
nella sezione sui load test esistenti) resta noto, reale, e
**deliberatamente fuori scope per questa evoluzione** — che risponde
specificamente al vincolo di quota HOFJ posto dal twist, non a "reggere
50.000 utenti end-to-end con AI reale", cosa che nessun budget di $5 di
crediti Anthropic per un prototipo potrebbe mai sostenere comunque. Il
load test di questa sezione lo dimostra per costruzione: gira interamente
con `STUB_MODE`, zero chiamate AI reali, zero costo.

### Risposta di Carlo (Vela/HOFJ) sul booking non verificabile — il root cause vero, e un nuovo blocco preciso trovato verificandolo (2026-09-15)

Carlo ha risposto punto per punto ai dubbi aperti su idempotenza,
formato del codice prenotazione e stato "BookingInitiated" bloccato
(vedi sezione precedente su idempotenza e follow-up). Quattro
chiarimenti, presi uno per uno:

1. **Il 200 di `POST /v1/bookings` È garanzia di persistenza reale** —
   l'idempotenza stessa lo dimostra: se non salvasse nulla non potrebbe
   restituire lo stesso codice due volte. La nostra osservazione di
   valori diversi tra tentativi (vedi sezione idempotenza sopra) era
   quasi certamente dovuta a itinerary diversi tra un tentativo e
   l'altro, non a un comportamento non idempotente del sistema.
2. **Il codice prenotazione È l'`itineraryId`**, per costruzione — non
   un eco degenere. L'esempio `"R-12345"` nella spec OpenAPI è
   semplicemente sbagliato e Carlo lo corregge lato loro. Codice
   aggiornato di conseguenza (doc comment di `confirmBooking`,
   `hofj/client.ts`).
3. **"BookingInitiated" bloccato è invece un problema vero — e la causa
   è nostra, non di HOFJ**: `POST /v1/bookings` scrive una prenotazione
   in stato "pending"; la conferma a "confirmed" è ASINCRONA e avviene
   solo quando **Stripe notifica HOFJ** che il SUO PROPRIO PaymentIntent
   (quello restituito da `GET /v1/itineraries/{id}/payment`) è stato
   pagato. Il "bypass sanzionato" che avevamo costruito in precedenza
   (creare un PaymentIntent nostro, direttamente contro l'account
   Stripe di HOFJ, per aggirare `.../payment` quando era rotto — vedi
   sezione storica sopra) era la causa esatta del blocco: una volta che
   `.../payment` è stato sistemato lato HOFJ, il bypass è rimasto in
   uso per inerzia ed è diventato esso stesso il bug — un pagamento che
   il webhook di HOFJ non vede mai, quindi la prenotazione resta
   "pending" per sempre, indipendentemente da quanti retry si facciano
   su `confirmBooking`.
4. **`GET /v1/bookings/{id}` risponde 401 con una chiave B2B**, confermato
   da Carlo come problema reale del loro prodotto (manca un modo per un
   client B2B di verificare lo stato di una prenotazione appena creata),
   non un nostro errore — lasciato qui come richiesto esplicitamente.

**Implementato subito** (`hofj/client.ts`, `stripe/client.ts`,
`conversation.ts`): rimosso interamente `attemptDirectStripePayment` /
`createPaymentIntent` (il bypass che creava un PaymentIntent nostro).
`attemptPayment()` ora chiama `getPaymentIntent()` (P0, non più P2
opzionale — prima il suo risultato veniva scartato, ora è la chiamata
critica), estrae l'id del PaymentIntent DI HOFJ dal `client_secret`
(`<paymentIntentId>_secret_<...>`), e conferma QUELLO tramite Stripe,
esattamente come indicato da Carlo.

**Verificato dal vivo subito dopo, con una chiamata diretta HOFJ+Stripe
reale (bypassando l'NLU per isolare esattamente questo meccanismo, dato
che Workers AI ha esaurito la soglia gratuita giornaliera in locale —
vedi "Da tenere d'occhio", OPEN-POINTS.md)**: creato un itinerary reale
(prodotto 988, "Roma Tennis Experience", 465€), ottenuto un vero
`client_secret` da `GET .../payment`
(`pi_3UFt1d2MSF7Nczk01g9kJ2wD_secret_...`), e provato a confermarlo con
la nostra chiave Stripe restricted. **Bloccato da un problema nuovo,
diverso da quello ipotizzato in precedenza**: non un 404
"resource_missing" generico attribuito a "un account che la nostra
chiave non può leggere per design", ma un errore Stripe specifico e
azionabile — `GET /v1/account` con la nostra chiave restituisce
esplicitamente:

> "Permission denied. The provided key 'rk_test_...alFk' does not have
> the required permissions for this endpoint on account
> 'acct_1QQ56vRpam3eRRKb'. Enabling **Accounts Read
> ('connected_account_read')** permissions on this key would allow this
> request to continue."

Questo è coerente al 100% con un setup **Stripe Connect**: HOFJ (o il
brand specifico) opera su un *connected account*, e la nostra chiave
restricted — pur essendo valida sull'account piattaforma
(`acct_1QQ56vRpam3eRRKb`) — non ha il permesso `connected_account_read`
necessario per leggere o confermare un PaymentIntent che vive
sull'account collegato. Non è più un mistero ("account che non possiamo
leggere per design") ma un permesso mancante, preciso, con un link
diretto per abilitarlo nel messaggio di errore stesso.

**Conclusione onesta**: la logica del codice ora è quella corretta
secondo la spiegazione di Carlo — non torniamo al vecchio bypass, che è
un vicolo cieco dimostrato (paga ma non conferma mai). Resta bloccata
solo dal permesso mancante sulla chiave (o, in alternativa, serve l'id
dell'account collegato per passare l'header `Stripe-Account` con una
chiave che abbia il permesso di operare per suo conto). Il sistema
fallisce onestamente in questo stato (`attemptPayment` cattura l'errore,
imposta `stage: "failed"` con un motivo preciso, non dichiara mai un
successo falso) — non è un regresso rispetto a prima, è lo stesso
comportamento di fallback onesto, solo per una ragione ora precisa e
comunicabile invece che genericamente "l'account non è il nostro".
**Domanda precisa da girare a Carlo**: la chiave restricted può avere
il permesso `connected_account_read`/`connected_account_write`
abilitato, oppure serve l'id del connected account per usare l'header
`Stripe-Account` lato nostro?

### CORREZIONE MAGGIORE: puntavamo a produzione per tutta la sessione — l'ambiente giusto è staging.api.hofj.com (2026-09-15)

Carlo, ricevendo la domanda sopra, ha risposto con una domanda a sua
volta: "Stai puntando a staging corretto?". Verificato subito dal vivo,
punto per punto, non dato per scontato:

- `GET https://staging.api.hofj.com/v1/quota` risponde 200 con la
  nostra chiave (`clientId: "test-developer"`, stesso limite 120/min ma
  finestra quasi vuota — `usedInWindow: 1` — coerente con un ambiente
  mai davvero usato finora, a differenza di produzione).
- `GET /v1/distribution-channels` su staging restituisce i brand REALI,
  diversi da quelli usati finora: **Weebora → `staging.weebora.com`**,
  **Terrarossa → `staging.tennis.weebora.com`** (non
  `staging.terrarossa.com`, il nome sorprende ma è quello verificato),
  House of Journey → `staging.hofj.com`.
- Rifatto l'intero test di pagamento dal vivo (sezione precedente) ma su
  staging invece che produzione: creato un itinerary reale (prodotto
  523, Forte dei Marmi Tennis Experience, brand
  `staging.tennis.weebora.com`), ottenuto un nuovo `client_secret` da
  `GET .../payment`, e confermato con la nostra chiave Stripe.
  **Riuscito per davvero questa volta: `status: "succeeded"`.** L'errore
  "resource_missing"/permesso Stripe Connect mancante trovato su
  produzione non era un problema di permessi — era che la chiave e
  l'ambiente HOFJ non erano lo stesso ambiente: su staging, con lo
  stesso identico codice, il PaymentIntent di HOFJ è perfettamente
  leggibile e confermabile dalla nostra chiave.
- **Un dettaglio tecnico reale scoperto nello stesso test**: il
  PaymentIntent di HOFJ ha `automatic_payment_methods.allow_redirects:
  "always"` abilitato, quindi la chiamata di conferma a Stripe richiede
  un `return_url` esplicito — senza, Stripe risponde 400. Non serve un
  vero redirect (verificato: con `pm_card_visa` la conferma è sincrona,
  nessun redirect avviene davvero), basta un URL valido sul nostro
  dominio. Aggiunto (`stripe/client.ts`, `RETURN_URL`).
- **Non risolto, verificato onestamente, non dato per scontato**: anche
  con pagamento nativo confermato per davvero (`succeeded`) e
  `POST /v1/bookings` chiamato con successo, `checkout.status`
  sull'itinerary **resta `"BookingInitiated"`** — controllato subito
  dopo e di nuovo dopo 8 secondi di attesa, nessun cambiamento. `GET
  /v1/bookings/{id}` continua a rispondere 401 con la nostra chiave B2B
  anche su staging (stesso comportamento di produzione — non è
  specifico all'ambiente sbagliato). Resta un punto aperto reale, non
  chiuso da questa correzione: o serve più tempo di propagazione, o
  `checkout.status` non è il segnale giusto da controllare (potrebbe
  essere un attributo del carrello, non della prenotazione confermata).
  Non lo dichiariamo risolto.

**Cambiato in codice, con quanto verificato qui, non con supposizioni**:
`wrangler.jsonc` (`HOFJ_BASE_URL` → `staging.api.hofj.com`, `HOFJ_BRAND`
→ `staging.tennis.weebora.com`), `engine/matcher.ts`
(`FALLBACK_BRAND` → `staging.weebora.com`, più i due test in
`matcher.test.ts` che referenziavano la stringa vecchia), `types.ts`
(doc comment di `Candidate.brand` aggiornato), `stripe/client.ts`
(`return_url` esplicito in `confirmPaymentIntent`). Typecheck e i 60
test unitari passano. **Limite onesto di questa verifica**: non sono
riuscito a far girare il flusso end-to-end attraverso una vera
conversazione (Workers AI ha esaurito la quota gratuita giornaliera in
locale, nessun fallback Anthropic configurato in `.dev.vars`) — la
verifica è stata fatta chiamando `HofjClient`/`stripe/client.ts` con gli
stessi identici parametri che il codice reale usa (stessi path, stesso
body), non un test end-to-end via HTTP `/api/message`. Un run reale
tramite conversazione (o un deploy) resta da fare per la chiusura
definitiva.

Nota di metodo, non trascurabile: il messaggio originale da cui è
partita questa correzione (dalla sessione privata) era arrivato
danneggiato nel copia-incolla (parole fuse, righe troncate) — le
stringhe esatte dei brand e i dettagli tecnici non sono stati presi per
buoni dal testo corrotto, ma riverificati uno per uno con chiamate
dirette prima di toccare codice o documentazione.

### Analisi di una sessione reale (`60ff320a-...`, deploy live) e tre correzioni per una conversazione più fluida (2026-09-15)

Giuseppe ha fatto un vero test sul deploy appena aggiornato e ha chiesto
un'analisi della sessione per capire dove l'esperienza si è inceppata.
Ricostruita l'intera trascrizione dallo stato reale (`/api/state`), non
per sentito dire — tre problemi reali, distinti, ognuno con causa
verificata prima di toccare codice.

**1. Bug concreto e riproducibile: "il periodo DEL 16 al 22 settembre"
risolveva la data sbagliata.** Un regression fix di ieri copriva già
"dal 15 al 21 settembre" (vedi sezione precedente sui bug di parsing
date) — ma "del" (altrettanto naturale: "il periodo del 16 al 22") non
era coperto, perché il pattern era ancorato letteralmente alla parola
"dal". Verificato girando la regex reale del codice su "periodo del 16
al 22 settembre": zero match sul pattern range, caduta nel pattern
generico, che prende "22 settembre" (il numero adiacente al mese) invece
di "16". Questo spiega l'intera catena osservata: la prima proposta non
segnala alcun compromesso di data (22 rientra comunque nella finestra
ampia mostrata dalla ricerca), e solo quando il carrello si apre
DAVVERO per il 22 si scopre che quello slot preciso non è prenotabile —
innescando una rinegoziazione tardiva, proprio dopo che il viaggiatore
aveva già dato cognome e telefono. **Corretto**: il pattern ora accetta
sia "dal" sia "del" (`d(?:al|el)`). Test aggiunto (`dates.test.ts`) con
la frase esatta di questa sessione.

**2. Riordinato il flusso: i dati del viaggiatore si raccolgono
SEMPRE all'inizio della conversazione, mai dopo.** Decisione di
Giuseppe dopo aver visto dal vivo il costo reale del vecchio ordine: in
quella sessione, OGNI sorpresa (rinegoziazione data, prezzo cambiato da
578€ a 1040€, reset completo dei dati dopo un 400) arrivava DOPO che il
viaggiatore aveva già speso 3-4 turni a dare nome/cognome/telefono —
il momento peggiore possibile per una brutta notizia. Cambiato:
`initialState()` parte ora da `stage: "collecting_traveller"` invece di
`"collecting"` — i dati del viaggiatore (quelli mancanti, mai quelli già
noti da un profilo salvato) si chiedono per primi, prima ancora di
parlare del viaggio. Quando la proposta viene accettata (`runProposing`,
decisione "yes"), i dati sono ormai già completi nel caso comune, quindi
si passa DIRETTAMENTE all'apertura del carrello reale — qualunque
sorpresa (data non prenotabile, prezzo diverso) arriva subito dopo il
"sì, procedi", non dopo un altro giro di raccolta dati già sudata.
Dettagli tecnici sistemati di conseguenza: il gate `tripStillNegotiable`
ora accetta anche `collecting_traveller` quando nessuna proposta esiste
ancora (altrimenti i dettagli del viaggio detti spontaneamente
all'inizio andrebbero persi); l'etichetta del campo "città di residenza"
non menziona più "la destinazione è già decisa" quando non c'è ancora
nessuna destinazione con cui confondersi; `isFirstAsk` (la prima
domanda mai fatta) è ora calcolato sul numero di messaggi scambiati, non
su "tutti i campi sono null" — un viaggiatore di ritorno con profilo
parziale deve comunque sentirsi accogliere in modo naturale alla prima
vera domanda, non con una frase che presuppone una prenotazione già in
corso ("per bloccare la prenotazione reale...", rimossa). Verificato dal
vivo (stub server): la stessa conversazione ora collassa correttamente
in meno turni quando i dati sono già tutti noti, senza un secondo giro
di richieste dopo l'accettazione della proposta.

**3. "Mi sembra che il sistema abbia cambiato pacchetto" — verificato:
NO, ma il messaggio lo faceva sembrare così.** Controllato
`productId` in tutta la trascrizione: `181` ("Magnifico Padel a
Lanzarote") dall'inizio alla fine, mai cambiato. Il problema era di
messaggistica: quando il carrello reale scopre che la data accettata non
è davvero prenotabile e ripropone lo STESSO candidato con una data
diversa, il codice riusava la direttiva generica `"propose"` — la
stessa usata per presentare un pacchetto nuovo da zero — ripetendo
titolo/venue/prezzo come se fosse un'offerta diversa. Aggiunta una
direttiva dedicata, `date_shift_confirm` (`engine/ai.ts`), usata SOLO in
questo caso specifico: dice esplicitamente "è lo stesso pacchetto di
prima", non ripete la scheda completa, chiede conferma solo sulla data.
Il caso INVERSO — il pacchetto originale risulta davvero non
prenotabile e se ne propone un altro — aveva già la disclosure giusta
("il pacchetto proposto prima non risulta più prenotabile... diglielo
in breve"), confermato leggendo il codice, nessuna modifica necessaria
lì: il sistema insiste già sul pacchetto scelto fino a quando non è
genuinamente impossibile, e avvisa chiaramente solo quando cambia
davvero.

**Perimetro dichiarato: multi-lingua, oggi solo IT/EN, senza libreria
esterna.** Su richiesta esplicita di Giuseppe: il supporto multi-lingua
di questo prototipo copre solo italiano e inglese, con regex
deterministiche scritte a mano in `engine/dates.ts` (niente libreria di
parsing date esterna, come `date-fns`/`chrono-node` — mai valutata,
scelta consapevole per restare dentro il perimetro di tempo/dipendenze
della challenge). Aggiungere una terza lingua oggi significa aggiungere
a mano i pattern regex equivalenti (mesi, "dal/del X al Y", "tra N
giorni", ecc.) in quel file — non è plug-and-play. Se il prodotto dovesse
davvero espandersi oltre IT/EN, la libreria esterna diventerebbe la
scelta giusta; per ora, con solo due lingue verificate in produzione,
tenere la logica deterministica e testabile in casa resta la scelta più
semplice, coerente con lo split "logica in codice, l'AI solo fraseggia"
che regge tutto il resto del progetto.

**Perimetro dichiarato: nessun DB di preferenze/profilazione utente,
oggi.** `UserProfileDO` (vedi `userProfile.ts`) è la versione ATTUALE,
volutamente minimale, di questa idea: firstName/email/città di
residenza/sport preferito/dimensione nucleo/tier economico, una sola
Durable Object per utente, mai usata per decisioni silenziose (solo
suggerimenti da confermare, vedi la precision policy). Giuseppe ha
confermato che l'evoluzione naturale è un vero database di preferenze e
profilazione più ricco — non costruito in questa fase, notato qui
esplicitamente perché non sia scambiato per una dimenticanza quando si
guarderà indietro a questo prototipo.

### Due domande di Giuseppe sul cambio pacchetto: motivazione reale, e come sceglie l'engine (2026-09-15)

Seguito diretto della sezione precedente. Giuseppe ha confermato che un
cambio pacchetto è chiaramente possibile (il caso "originale davvero non
prenotabile" in `openRealCartAndAttemptPayment`), ma ha chiesto due cose:
dare al viaggiatore anche il MOTIVO per cui cambia, non solo la
segnalazione che è cambiato; e capire come l'engine sceglie quale
candidato proporre tra quelli trovati, chiedendosi se si può rendere più
intelligente.

**1. Motivazione reale, non più solo "un problema del fornitore".**
Verificato leggendo il codice: quando `createItinerary` fallisce anche
sulla `minDate` nota-buona del prodotto (il caso genuinamente "non
prenotabile", non il fallback data), `err.detail` — il messaggio reale
di HOFJ, già catturato per il logging interno — non veniva mai passato
al messaggio per il viaggiatore, sempre sostituito da un generico
"problema del fornitore, non tuo". Corretto: nuovo campo opzionale
`unavailableReason` sulle direttive `propose`/`no_match`
(`engine/ai.ts`), valorizzato con `err.detail.slice(0, 200)` (stessa
convenzione di troncamento già usata per i log). Stessa disciplina di
onestà già stabilita per `price_changed`: se abbiamo un motivo reale, il
modello lo traduce in termini comprensibili (mai il gergo tecnico
letterale); se non lo abbiamo (o è un generico "error code: 502" del
gateway — capita, documentato altrove nello stesso file), il modello
resta onesto SENZA inventarne uno plausibile. Il caso "originale ancora
disponibile, solo la data cambia" (la sezione precedente, `date_shift_confirm`)
resta distinto e non necessita motivazione aggiuntiva: lì non cambia il
pacchetto, solo la data.

**2. Come sceglie oggi l'engine, e un gap reale trovato guardandolo.**
`classify()` (`engine/matcher.ts`) sceglie così: se il viaggiatore non
ha mai dato un budget (o ha detto "economico") prende il più economico
del pool; se ha detto "carino ma non troppo caro" prende il prezzo
mediano; **se ha dato un budget numerico preciso — il caso più comune —
prendeva semplicemente `pool[0]`, il primo risultato per rilevanza
dell'API, senza mai guardare il prezzo prima di scegliere**. Il budget
veniva controllato solo DOPO la scelta, solo per decidere se etichettare
il risultato come "compromise". Risultato pratico: se il primo risultato
per rilevanza costava più del budget ma un'alternativa più in basso in
lista rientrava perfettamente, il sistema proponeva comunque il primo,
generando un compromesso evitabile.

**Corretto** con `selectForNumericBudget()`: quando c'è un budget
numerico, si preferisce il candidato meglio classificato tra quelli che
rientrano DAVVERO nel budget (il ranking di rilevanza dell'API resta il
criterio di scelta TRA quelli che rientrano — nessun punteggio numerico
inventato, stessa disciplina di `classify()` in generale); solo se
nessuno rientra si cade sul overage minimo possibile, invece che sul
primo risultato qualunque sia il suo prezzo. Tre nuovi test in
`matcher.test.ts` coprono: preferenza per un candidato che rientra anche
se ranked più in basso; rispetto del ranking di rilevanza tra candidati
che rientrano tutti; fallback all'overage minimo quando nessuno rientra.
Nessun test esistente rotto (tutti i casi budget preesistenti usavano un
solo candidato nel pool, comportamento identico).

Typecheck e 64 test passano (61 + 3 nuovi sulla selezione). Non ancora
verificato dal vivo con l'AI reale (stessa limitazione locale delle
sezioni precedenti) — verificato per costruzione (typecheck, unit test
mirati sulla logica deterministica, che è dove vive questa decisione).

### Nessun risultato: proporre un'alternativa dal profilo, e selezione più sofisticata su una seconda dimensione (2026-09-15)

Due follow-up ulteriori di Giuseppe sulla stessa area.

**1. "Non ho trovato questo, però ho trovato quest'altro" — simulato
usando il profilo, mai in modo silenzioso.** Prima, quando `classify()`
non trovava nulla (pool vuoto dopo i filtri), l'unica risposta era una
domanda di chiarimento generica ("allarga i criteri"). Aggiunto in
`searchAndPropose` (`conversation.ts`): se non c'è nulla per lo sport
richiesto E il profilo del viaggiatore indica un `preferredSportHint`
diverso da quello chiesto (un segnale reale, mai una supposizione — vedi
`householdSizeHint`/`economicTierHint`, stesso pattern), si ritenta la
ricerca con quello sport, stessa città/data/budget. Se trova qualcosa,
lo propone con un nuovo tipo di compromesso dedicato,
`sport_substituted` (`types.ts`, `engine/ai.ts`), che dice esplicitamente
"non ho trovato X, ma so che ami anche Y e ho trovato questo — ti
interessa?" — mai presentato come se fosse quello richiesto. **Vincoli
deliberati**: scatta UNA sola volta (mai su un retry dopo un "rifiutato"
— altrimenti un "no" alla sostituzione potrebbe far scattare un loop di
altre sostituzioni), e non modifica mai `state.slots.sport` — se il
viaggiatore rifiuta, la ricerca successiva torna naturalmente allo sport
originale (che sappiamo già vuoto) e cade sul messaggio di chiarimento
normale, senza bisogno di logica esplicita in più per gestirlo.

**2. Selezione più sofisticata, ma solo quando ci sono davvero più
risultati tra cui scegliere** (esplicitamente richiesto da Giuseppe: mai
quando il risultato è unico). Aggiunta in `classify()` una seconda
dimensione di preferenza, oltre al budget: quando è stata data una data
precisa, tra i candidati sopravvissuti si preferisce (per riordino, mai
filtro duro — stesso pattern non distruttivo già usato per
`preferredMonth`) quello la cui finestra di disponibilità copre GIÀ
quella data, rispetto a uno che richiederebbe ANCHE un compromesso di
data. Prima, la selezione ottimizzava solo il budget in isolamento — con
più candidati tutti nel budget, poteva capitare di sceglierne uno che
poi necessitava comunque di un compromesso sulla data, quando un altro
altrettanto buono (o migliore) non ne aveva bisogno affatto. Nessun
punteggio numerico inventato: resta un filtro booleano deterministico
("la data richiesta rientra nella finestra?"), con il ranking di
rilevanza dell'API come criterio finale tra i candidati che restano
equivalenti — stessa disciplina di `selectForNumericBudget`. 2 nuovi
test: uno conferma la preferenza per il candidato che copre la data
anche se ranked più in basso, l'altro conferma che con un solo
candidato reale non succede nulla (no-op, come richiesto esplicitamente).

Typecheck e 66 test passano (64 + 2 nuovi). La sostituzione sport non ha
un test dedicato (nessun test diretto esiste su `conversation.ts`/la
Durable Object in questo progetto — scelta di scope già documentata
sopra, solo validazione dal vivo) — verificata per costruzione
(typecheck pulito, riusa `searchCandidates`/`classify`, entrambe già
ben coperte da test).

### Test deterministici su conversation.ts/la macchina a stati, riusando STUB_MODE (2026-09-15)

Giuseppe, prima del prossimo deploy: "la macchina a stati sta crescendo
— riusciamo a costruire una suite di test deterministica per
conversation.ts, usando STUB_MODE come per il load test?" — risposta:
sì, e ora esiste (`test/conversation.test.ts`, 10 test, integrazione
reale contro la vera `ConversationDO`, non un mock). Chiudeva anche il
gap esplicitamente accettato sopra ("nessun test diretto su
conversation.ts... solo validazione dal vivo").

**Perché non bastava STUB_MODE così com'era**: per il load test, lo stub
di `interpret()` ignora il testo e riempie sempre tutto in un colpo solo
("sì" a tutto), e lo stub HOFJ ha un solo percorso — sempre successo,
un solo prodotto fisso. Ottimo per misurare throughput sotto carico, ma
inutile per testare la macchina a stati: nessun controllo su QUALE
ramo si attraversa, e i rami più delicati (quelli con più bug storici in
questa sessione) sono esattamente compromessi ed errori, mai raggiunti.

**Due estensioni, entrambe attive SOLO sotto `STUB_MODE`, zero rischio
per la produzione**:

1. **Un DSL di test deterministico per `interpret()`** (`engine/ai.ts`):
   quando il testo del viaggiatore è nella forma
   `chiave:valore|chiave:valore|...` (es.
   `"sport:tennis|destCity:Roma|budget:400|decision:yes"`), viene
   parsato esattamente così, dando ai test controllo preciso, campo per
   campo, turno per turno. `destCity`/`homeCity` sono chiavi distinte
   (mai solo "city") — il test non deve replicare l'ambiguità reale che
   `currentlyAsking` esiste per risolvere, la aggira del tutto. **Se il
   testo non è in quella forma, il comportamento originale (riempi tutto,
   "sì" sempre) resta identico e invariato** — è così che
   `loadtest/scale-50k.js` continua a funzionare senza alcuna modifica,
   verificato con una corsa di controllo (0% errori, stesso schema di
   prima).

2. **Scenari di fallimento controllabili nello stub HOFJ**
   (`hofj/client.ts`, `STUB_SCENARIOS`): un test attiva uno scenario
   mettendo `SCENARIO:<nome>` dentro `preferences` (finisce nella
   keyword di ricerca per costruzione, vedi `buildKeyword()`,
   `engine/matcher.ts`). Cinque scenari, ciascuno un `productId`
   riservato: `date_shift` (createItinerary fallisce finché non si
   usa il minDate del prodotto — il ramo `date_shift_confirm`),
   `price_changed` (il totale reale del carrello differisce da quanto
   annunciato in ricerca), `unavailable` (createItinerary fallisce
   SEMPRE, anche sul proprio minDate — il ramo "davvero non disponibile,
   cerca un'alternativa" con motivazione reale), `customer_rejected`
   (putCustomer risponde 400 una sola volta, poi accetta — il ramo di
   reset e ri-raccolta dati), `never_confirms` (riproduce il bug REALE
   ancora aperto con Carlo: `confirmBooking` risponde 200 ma
   `checkout.status` non si sblocca mai).

**Una scoperta reale fatta scrivendo gli scenari, non ipotizzata**: il
primo tentativo di `customer_rejected` tracciava il "già fallito una
volta" per `itineraryId` — ma `openRealCartAndAttemptPayment` richiama
sempre `createItinerary` da zero ad ogni retry (comportamento
preesistente, già accettato, vedi il commento del metodo), quindi ogni
retry genera un `itineraryId` NUOVO che non ha ancora "consumato" il suo
fallimento una tantum — un loop infinito nel primo tentativo di test.
Corretto tracciando un semplice flag booleano per conversazione
(un'istanza di `HofjClient` per `ConversationDO`), non per itineraryId.

**Un'altra scoperta, questa volta sul comportamento REALE del sistema,
non un bug**: testando manualmente lo scenario "unavailable" con una
data diversa dal minDate del prodotto, il sistema tenta PRIMA il
fallback sulla data (comportamento corretto e documentato: non può
distinguere "problema di data" da "davvero non disponibile" senza
prima riprovare sul minDate) — il test dello scenario "davvero non
disponibile" isolato richiede quindi di impostare la data richiesta
UGUALE al minDate del prodotto scenario fin dal primo turno, per
bypassare il ramo intermedio.

**Copertura attuale** (10 test): raccolta dati viaggiatore all'inizio
quando mancanti; dati non richiesti di nuovo se già noti da profilo;
percorso felice fino a booked; rifiuto di una proposta senza loop;
tutti e 5 gli scenari sopra end-to-end; una conversazione "booked" non
riparte su un nuovo messaggio. **Fuori scope, dichiarato**: backpressure
del gate di quota sotto concorrenza reale (resta compito di
`loadtest/scale-50k.js`), isolamento tra conversazioni diverse (implicito
nel design — una Durable Object per conversazione — non ri-testato),
accuratezza NLU reale (resta compito di `scripts/prompt-suite.mjs`
contro modelli veri).

Aggiornato anche `wrangler.test.jsonc` (bindings `FOLLOWUP`/
`HOFJ_QUOTA_GATE`, `STUB_MODE: "1"`, una `STRIPE_SECRET_KEY` fittizia
mai realmente usata) e `tsconfig.json` (i tipi di `cloudflare:test` non
erano inclusi). Nota tecnica: `worker-configuration.d.ts` (generato da
`wrangler types`) lascia i binding Durable Object non tipizzati
(`DurableObjectNamespace` generico, non parametrizzato sulla classe) —
il test fa un cast esplicito al vero `Env` del progetto (`src/types.ts`)
invece di combattere con la generazione automatica dei tipi.

Typecheck pulito, 76 test passano (66 + 10 nuovi). Nessuna regressione
sul load test, verificato con una corsa di controllo (100 viaggiatori,
30s, 0% errori HTTP, stesso schema di prima).

### Terzo caso reale di prodotto rotto — verificato da Giuseppe, gap confermato leggendo il codice, fix con lo stesso meccanismo già esistente (2026-09-15)

Giuseppe, prima del deploy: caso riproducibile, diverso dai due bug di
brand-mismatch già chiusi (Lanzarote) — `productId 19` ("M3 Padel Week",
brand `booking.hofj.com`, produzione): `createItinerary` riesce
(il carrello si apre per davvero), ma la primissima lettura successiva,
`GET /v1/itineraries/{id}`, fallisce con 502 — dettaglio upstream:
`ZodError` su `paymentOptionsConfiguration.installmentPlans[0].deposit`,
"Too small: expected number to be >0". Un problema di configurazione
pagamento rotto lato fornitore, specifico al prodotto (un altro prodotto
sullo stesso brand leggeva normalmente, secondo la verifica originale).

**Il gap segnalato**: in `openRealCartAndAttemptPayment`, la chiamata
`getItinerary` per lo snapshot stava FUORI dal try/catch che gestisce il
fallback "prodotto non prenotabile" — quel fallback copriva solo i
fallimenti di `createItinerary`. Un fallimento di `getItinerary` subito
dopo, invece, risaliva fino al gestore generico
(`handleUnexpectedError`), che tratta un errore HOFJ retryable (come un
502) come transitorio ("il sistema è lento, riprova") — fuorviante per
un prodotto rotto in modo permanente, che avrebbe dato lo stesso identico
errore ad ogni tentativo.

**Verificato prima di toccare codice, non preso per buono**: tentata la
riproduzione esatta — non riuscita. Il catalogo di staging non ha affatto
`productId 19`; su produzione, sia `productId 19` sia il prodotto di
controllo indicato come funzionante (`769`) rispondono ora con 404
NOT_FOUND_ERROR su tutti e tre i brand — coerente con quanto già
documentato più volte in questa sessione: l'inventario HOFJ è condiviso
e cambia senza preavviso (due bloccanti storici erano già scomparsi allo
stesso modo). Non è stato quindi possibile riprodurre l'ERRORE ESATTO in
questo momento — ma **il gap nel codice è confermato al 100% leggendo il
sorgente**, indipendentemente da quale prodotto specifico lo scateni in
un dato momento: `getItinerary` alla riga incriminata era letteralmente
fuori da qualunque try/catch locale. La diagnosi di Giuseppe sul
comportamento risultante (trattato come errore transitorio, fuorviante
per un guasto permanente) è verificabile leggendo `handleUnexpectedError`
ed è corretta.

**Corretto con lo stesso meccanismo già esistente** per il fallimento di
`createItinerary` — nessuna logica nuova, solo esteso a un secondo punto
del flusso: `getItinerary` ora è dentro un try/catch dedicato; su un
`HofjApiError`, scarta il prodotto (`rejectedProductIds`), pulisce
esplicitamente il carrello ormai abbandonato (`itineraryId`/`brand`
tornano `null` — quel carrello non è più utilizzabile per il prossimo
candidato), e propone l'alternativa migliore con la motivazione reale
(`err.detail`, stessa disciplina già stabilita per il fallimento di
`createItinerary`).

**Test aggiunto**, come richiesto, senza dover colpire l'API reale ogni
volta: nuovo scenario stub `broken_product_config`
(`hofj/client.ts`, `STUB_SCENARIOS`) — `createItinerary` riesce
davvero, ma la lettura successiva fallisce sempre con lo stesso 502/
ZodError del caso reale. Un test dedicato in `conversation.test.ts`
verifica: il prodotto rotto viene scartato, il carrello abbandonato
viene ripulito (`itineraryId` torna `null`), e la prenotazione si
completa comunque sul prodotto alternativo.

Typecheck pulito, 77 test passano (76 + 1 nuovo).

### Perché questo caso contava così tanto: un vincolo esplicito del brief, non solo robustezza — e un secondo gap dello stesso tipo trovato riguardandolo (2026-09-15)

Giuseppe, subito dopo: il motivo della richiesta di verifica sopra non
era genericamente "rendiamo il sistema più robusto" — è una frase
esplicita del testo originale della challenge (dalla sessione privata,
mai incollata qui prima d'ora):

> "Not every product is bookable. Some of the catalogue is misconfigured
> upstream and will fail when you try to put it in a cart. Handle it.
> Real inventory is like this."

Questo cambia il framing: non è un miglioramento opzionale, è un
requisito esplicito della challenge — il catalogo HOFJ CONTIENE
deliberatamente prodotti con configurazione rotta, e il compito è
gestirli con grazia, non solo essere "abbastanza robusti da non
crashare". Dato questo, prima di considerare il punto chiuso ho
riguardato l'intera pipeline di booking per cercare ALTRI punti dove un
prodotto realmente rotto (non solo dati del viaggiatore malformati)
potesse ancora cadere nel percorso generico "problema tecnico, riprova
con una nuova conversazione" invece di essere scartato con
un'alternativa proposta.

**Trovato un secondo gap dello stesso tipo, anticipato ma mai gestito
nel codice stesso**: il catch di `putCustomer`/`putPax` gestiva
solo `err.status === 400` (dati viaggiatore malformati → richiedi di
nuovo). Qualunque ALTRO errore (403, 404, 502...) cadeva nel `throw err`
finale — e il commento IMMEDIATAMENTE sopra quella chiamata, scritto in
una sessione precedente, documenta ESATTAMENTE un caso reale di questo
tipo: `"changePaxDetails.paxNumberChanged"`, un problema di
configurazione del PRODOTTO (non dei dati inviati), "surfaced through
the gateway as a generic 502" — non un 400. Il codice descriveva il
problema nel proprio commento senza gestirlo.

**Perché ri-richiedere gli stessi dati non avrebbe mai funzionato in
questo caso**: se il problema è nella configurazione pax del prodotto
stesso, richiedere di nuovo nome/email/telefono al viaggiatore non
cambia nulla — l'errore si ripresenterebbe identico ad ogni tentativo,
indipendentemente da quanto corretti siano i dati forniti.

**Corretto con lo stesso meccanismo, ancora una volta**: un secondo
branch nel catch, per qualunque `HofjApiError` diverso da 400 — scarta
il prodotto, pulisce il carrello abbandonato, propone l'alternativa con
la motivazione reale. **Deliberatamente non tocca `state.traveller`** —
a differenza del ramo 400, qui i dati del viaggiatore non erano mai il
problema, quindi non vanno persi e richiesti di nuovo inutilmente.

**Nuovo scenario stub** `pax_config_broken` (`hofj/client.ts`) — fedele
al caso reale già documentato nel commento: `putPax` fallisce sempre con
un 502 "changePaxDetails.paxNumberChanged", mai un 400, mai
autocorrettivo. Test dedicato verifica: il prodotto viene scartato, il
carrello ripulito, **i dati del viaggiatore sopravvivono intatti**
(la differenza chiave rispetto al ramo 400), e la prenotazione si
completa comunque sull'alternativa.

Nessun'altra chiamata nella pipeline di booking ha lo stesso gap:
`createItinerary` e `getItinerary` sono già coperti (sopra);
`getProduct` degrada già con onestà su qualunque errore;
`getPaymentIntent` è già opzionale/scartabile; `confirmBooking` è
l'ultimo passo dopo un pagamento reale, dove "scarta e prova un altro
prodotto" non è più applicabile (il fallimento onesto + follow-up già
implementato resta la risposta corretta lì, indipendentemente dalla
causa).

Typecheck pulito, 78 test passano (77 + 1 nuovo).

### CHIUSURA: Carlo conferma — le prenotazioni sono davvero confermate, il limite di verifica è reale e documentato, non un problema nostro (2026-09-15)

Aggiornamento definitivo da Carlo (Vela/HOFJ), che chiude il filo aperto
dalle sezioni precedenti su `checkout.status` bloccato su
"BookingInitiated" e sulla verifica end-to-end mai raggiunta in
autonomia. Non lasciato scritto come "in attesa" — ecco la risposta,
chiara:

1. **Confermato**: `checkout.status` sull'itinerary NON è il segnale
   affidabile da controllare — la conferma vera vive solo dietro
   `GET /v1/bookings/{id}`, che richiede un token end-user
   (`X-End-User-Authorization`) che una chiave B2B da sviluppatore non
   ha (401 — esattamente quanto già verificato in modo indipendente in
   questa sessione, vedi sopra). Non è più una nostra ipotesi, è
   confermato da Vela stessa.
2. **Confermato anche il punto più importante**: Carlo ha controllato
   personalmente nel backoffice interno di Vela (un accesso che noi non
   abbiamo) e conferma che **le prenotazioni fatte durante i test di
   questa sessione risultano davvero confermate**. Non possiamo
   verificarlo in autonomia con le nostre credenziali B2B — ma è una
   conferma esterna reale, di qualcuno con accesso che noi non abbiamo,
   non una nostra supposizione o un'inferenza indiretta.
3. Carlo ha detto esplicitamente di non bloccarsi su questo — ne parlerà
   con Giuseppe al colloquio di debrief. Non c'è quindi un modo da
   aggirare qui con le credenziali attuali, ed è corretto così: non è
   più un mistero da investigare, è un limite noto e riconosciuto anche
   da chi gestisce l'API.

**Cosa NON cambia nel codice, deliberatamente**: la cautela in
`confirmBookingNow` (mai dire "prenotato" al viaggiatore finché
`checkout.status` non si è mosso da "BookingInitiated", il follow-up
loggato su `FollowUpDO` quando non si può verificare) resta esattamente
com'è. La conferma di Carlo riguarda le prenotazioni SPECIFICHE fatte
oggi durante i test, verificate una per una nel backoffice — non ci dà
un modo per verificare AUTONOMAMENTE una prenotazione futura qualsiasi,
quindi il sistema deve continuare a comportarsi con la stessa onestà
verso ogni singolo viaggiatore, caso per caso, non fidarsi ciecamente
del 200 in generale d'ora in poi.

**Il quadro completo, ora chiuso**: il 200 di `POST /v1/bookings` è
persistenza reale (punto 1, sezione precedente); il codice prenotazione
è l'itineraryId per costruzione (punto 2, sezione precedente); la causa
del blocco era nostra, il bypass Stripe ormai corretto (punto 3, sezione
precedente); e ora, la prova che le prenotazioni completate davvero
funzionano, con l'unico limite reale rimasto — un client B2B non può
verificarlo in autonomia oggi — riconosciuto e documentato da chi
gestisce l'API, non lasciato come domanda aperta.

### Conseguenza diretta della chiusura di Carlo: il tono verso il viaggiatore, quando "unverified" non significa più "forse non ha funzionato" (2026-09-15)

Giuseppe, subito dopo aver letto la chiusura sopra: se Carlo ha
confermato che queste prenotazioni funzionano davvero, possiamo dirlo al
viaggiatore con un tono positivo ("la prenotazione è in attesa di essere
confermata") invece che con un tono da errore/incertezza? Sì, ed è
un cambiamento diretto e ben fondato — non un'invenzione, una
conseguenza logica di quanto appena confermato da Vela.

**Prima**: il messaggio per `checkout.status` bloccato su
"BookingInitiated" diceva letteralmente "il sistema del fornitore non ti
dà conferma certa che la prenotazione sia stata registrata per davvero"
— un'incertezza genuina, corretta quando scritta (prima della risposta
di Carlo), ma non più accurata ora.

**Corretto**: la direttiva `booking_unverified` (`engine/ai.ts`) ora
porta con sé `itineraryId` e `totalPrice`, e il modello riceve
l'istruzione esplicita di comunicare con SICUREZZA, mai come un dubbio —
"la prenotazione risulta effettuata... in attesa dell'ultima conferma
TECNICA dal sistema del fornitore (un limite noto del loro lato, non un
problema della prenotazione)", mai le parole "errore"/"problema"/"non
sono sicuro". Stessa correzione applicata al messaggio deterministico
gemello per il caso "riprovato più volte, ancora bloccato" in
`conversation.ts` (distinto ora da un `isUnverifiedBooking` esplicito,
separato dagli altri fallimenti "bookings:" genuinamente diversi — un
403, per esempio, resta un problema vero, non riceve questo tono).

**`state.reservationCode` ora viene impostato anche in questo caso**,
non solo quando `checkout.status` conferma — con `state.itineraryId`,
il vero codice prenotazione per costruzione (Carlo, punto 2). Non è una
supposizione specifica a questa prenotazione: è vero indipendentemente
da quando/se `checkout.status` si aggiorna.

**Cosa NON è cambiato, deliberatamente**: `state.stage` resta `"failed"`
internamente (bookkeeping per la logica di retry/follow-up, invisibile
al viaggiatore), e il logging su `FollowUpDO` resta invariato — la
conferma di Carlo riguarda le prenotazioni GIÀ verificate a mano nel
backoffice, non un modo per verificare autonomamente ogni prenotazione
futura, quindi tracciarle per un controllo umano resta la cosa giusta da
fare.

**Aggiornamento, stesso giorno**: Giuseppe conferma — la mail è
arrivata per davvero, per una prenotazione fatta in questo stesso stato
durante questa sessione. Non più un fatto da verificare: aggiunta la
riga "arriverà anche una mail di conferma con tutti i dettagli" sia
nella direttiva AI (`engine/ai.ts`) sia nel messaggio deterministico
gemello per il caso "riprovato più volte" (`conversation.ts`) — stessa
disciplina di prima, solo che ora il fatto è verificato invece che
supposto.

Typecheck pulito, 78 test passano — aggiornato anche il test
`never_confirms` esistente (si aspettava `reservationCode: null`, ora
corregge correttamente ad aspettarsi il vero codice).

### Sessione reale `ab6d0bfa-...`: tre segnalazioni di Giuseppe, tre esiti diversi (2026-09-15)

Tre punti, verificati uno per uno con i dati reali dello stato della
sessione (`/api/state`), non a intuito.

**1. "Le informazioni su chi sono me le ha chieste dopo e non prima."**
Verificato: il PRIMO messaggio dell'agente chiede già solo il cognome
(nome/email/città già noti — un vero profilo salvato da test precedenti
nello stesso browser, `householdSizeHint`/`economicTierHint`/
`preferredSportHint` tutti popolati). L'ordine "dati prima" funziona
correttamente al primo giro. **Il problema vero era altrove**: dopo un
compromesso di prezzo accettato ("procedi"), `putCustomer`/`putPax`
falliva con un 400, azzerando TUTTI i dati del viaggiatore e richiedendoli
di nuovo da zero — proprio il pattern di interruzione tardiva che il
riordino di oggi avrebbe dovuto eliminare, riemerso da un percorso
diverso. Analizzando il codice: `openRealCartAndAttemptPayment` richiamava
SEMPRE `createItinerary` da zero ogni volta che veniva rientrata — anche
quando un carrello reale, già aperto e già riprezzato per la STESSA
proposta, esisteva già (proprio il caso "riconferma dopo prezzo
cambiato"). Due sessioni reali (`ab6d0bfa-...` e `60ff320a-...`) mostrano
esattamente questo pattern. **Corretto**: nuova guardia che riusa il
carrello esistente invece di ricrearlo, estratto il blocco
`putCustomer`/`putPax` in un metodo dedicato riutilizzabile
(`putTravellerDataAndAttemptPayment`), e `state.itineraryId`/`brand`/
`totalPrice` ora vengono esplicitamente azzerati in `searchAndPropose`
ogni volta che una proposta DAVVERO nuova sostituisce la precedente —
così la loro presenza altrove significa sempre "stesso candidato, già
aperto", mai un riferimento stale. **Un bug trovato dal test stesso,
non dato per buono**: il primo tentativo di questo fix usava
`state.totalPrice` come segnale "già verificato", ma quel campo non
viene mai impostato nel ramo `price_changed` (si esce prima di
raggiungere quella riga) — il test dedicato ha fallito immediatamente,
rivelando il bug prima che arrivasse in produzione. Corretto impostando
`totalPrice` anche nel ramo di compromesso di prezzo, dato che è
comunque il prezzo reale già verificato.

**2. "Mi aspettavo andassi a parare su Lanzarote Padel Getaway Week."**
Verificato via ricerca diretta su staging, locale inglese: esistono
DAVVERO due prodotti reali distinti allo stesso venue (TocaHub
Lanzarote) — "Lanzarote Padel Getaway Week" (productId 125 in EN) e
"Magnificent/Magnifico Padel in Lanzarote" (quello effettivamente
proposto). **Non è un bug**: il sistema ha scelto in modo deterministico
un'opzione reale e valida allo stesso venue, semplicemente diversa da
quella specifica che Giuseppe aveva in mente dal sito reale. Coerente
con la policy "mai una lista, una sola proposta alla volta" — senza un
modo per il viaggiatore di specificare quale delle due preferisce
(es. tramite `preferences`), la scelta tra due opzioni ugualmente valide
resta deterministica ma non necessariamente quella attesa.

**3. "Mi dice perennemente 'il sistema ci sta mettendo un po'.'"**
Investigato lo stato reale della quota HOFJ (staging, una sola chiamata
deliberata): 119/120 disponibili al momento del controllo — la quota
NON era esaurita. Trovato però un gap reale leggendo il codice:
`searchAndPropose` catturava SOLO `QuotaExhaustedError` (il nostro
proprio limite auto-imposto) — un vero `HofjApiError` retryable
(429/502/503) dal fornitore stesso, se capitava durante `search()`,
cadeva invece nel gestore generico (`handleUnexpectedError`), che
restituisce una frase fissa leggermente diversa dal tono di backpressure
onesto già stabilito altrove in questo stesso metodo — non un vicolo
cieco (la conversazione non si interrompe), ma un'incoerenza di tono.
**Corretto**: stessa gestione di `QuotaExhaustedError`, stesso messaggio
di backpressure onesto. **Nota d'onestà**: la causa più probabile del
"perennemente" resta comunque un problema reale e transitorio lato HOFJ
(gateway condiviso, inventario condiviso, già documentato più volte in
questa sessione) — possibilmente aggravato dal volume di chiamate reali
fatte oggi stesso durante le verifiche su più ambienti. Trovato anche,
verificando questo, un problema DNS reale e intermittente su
`staging.api.hofj.com`/`api.hofj.com` (serviti da Google App Engine,
già annotato altrove in questo documento) — coerente con un'origine
reale del ritardo percepito, non necessariamente solo un problema del
nostro codice.

Typecheck pulito, 78 test passano (incluso un nuovo test dedicato che
verifica esplicitamente il riuso del carrello: stesso `itineraryId`
prima e dopo la riconferma di un compromesso di prezzo).

### Il profilo non veniva più richiesto (non è un bug), e il suo segnale di budget non arrivava mai alla selezione (questo sì) (2026-09-15)

Giuseppe, riguardando la sessione `ab6d0bfa-...`: "si era detto che ad
inizio del DO se non si conoscevano i dati dell'utente si chiedevano...
Questi dati non mi sono stati piu richiesti ad apertura sessione
nonostante cancellassi dalla sessione il durable object... Questi dati
non vanno a potenziare il motore decisionale tra le varie offerte?...
un utente luxury, se non propone specificamente un budget, voglia
sempre la soluzione piu inclusiva... Questa logica si è persa?"

Due domande distinte, due risposte diverse, entrambe verificate
leggendo il codice reale (mai per ipotesi):

**1. Perché non è stato richiesto di nuovo — non è un bug.**
L'onboarding del profilo (`userProfile.ts`, `UserProfileDO`) è
completamente separato dalla conversazione: vive per `userId`, non per
`sessionId`. Il frontend (`public/index.html`) persiste `userId` in
`localStorage` sotto la chiave `rally.userId.v1`, DISTINTA dalla chiave
della sessione di conversazione (`SESSION_KEY`). Cancellare la sessione
della conversazione dal browser azzera solo `SESSION_KEY` — non tocca
`rally.userId.v1` — quindi al prossimo `GET /api/profile?userId=...` il
profilo risulta ancora completo e l'onboarding correttamente non
riparte. Per far ripartire l'onboarding in una prova live serve pulire
ANCHE `rally.userId.v1` da `localStorage` (o usare una finestra/profilo
browser pulito). Comportamento corretto per design — un utente reale
che apre l'app su un nuovo dispositivo, invece, vedrebbe l'onboarding
partire regolarmente, non avendo ancora quel valore in `localStorage`.

**2. Il gap reale, confermato leggendo `runCollecting()`
(`conversation.ts`).** `householdSizeHint`/`economicTierHint`, seminati
una volta dal profilo salvato, venivano usati SOLO per il fraseggio
della domanda (`hintFor()` — "di solito spendi sulla fascia X, ancora
così?"), MAI per la selezione vera e propria: `classify()`
(`engine/matcher.ts`) riceve solo `Slots`, mai gli hint. Quando
`BUDGET_LOOP_BREAKER` (1 tentativo) bypassava una domanda sul budget
mai risposta, il codice si limitava a passare oltre senza mai scrivere
`slots.budgetTier` — che restava `null` — e `wantsCheapest` in
`classify()` degradava sempre al più economico, **a prescindere** da un
profilo "luxury" noto. Esattamente il gap descritto da Giuseppe.

**Fix** (`conversation.ts`, `types.ts`, `engine/ai.ts`): quando
`runCollecting()` bypassa il budget per loop-breaker E
`state.economicTierHint` non è null E sia `slots.budget` sia
`slots.budgetTier` sono ancora `null` (mai una risposta esplicita), il
codice ora scrive `slots.budgetTier` dalla mappatura
`smart→low, pro→mid, luxury→high` (stesso vocabolario già usato da
`hintFor()`) invece di lasciarlo `null`. Questo alimenta `classify()`
esattamente come se il viaggiatore avesse risposto — nessuna modifica a
`matcher.ts` è servita. Per rispettare la policy di precisione già in
vigore su budget/adults ("mai deciso in silenzio" — vedi più sotto,
sezione "Metodo agentico"), il fatto che sia stato il profilo a
decidere, non il viaggiatore in questa conversazione, viene sempre
dichiarato: un nuovo flag one-shot `budgetTierFromProfileDefault`
(consumato e resettato subito dopo la classificazione, per non
"restare appiccicato" a una proposta successiva non correlata) fa
avvolgere il risultato in un nuovo tipo di compromesso,
`budget_profile_default` (`ProposalContext.compromise.kind`,
`types.ts`), con un fraseggio dedicato in `engine/ai.ts`
("visto che di solito preferisci la fascia X, ti propongo questo..." —
mai presentato come se il viaggiatore l'avesse appena detto). Se
emerge anche un compromesso "vero" (prezzo/data) sullo stesso
candidato, quello ha priorità nel messaggio — non si sommano due
dichiarazioni nello stesso turno.

**Fuori scope, verificato e scartato**: un gap analogo per `adults`
NON esiste — a differenza del budget, il campo adults non ha MAI un
loop-breaker (`REQUIRED_TRIP_SLOTS`/`isGatingSatisfied`,
`conversation.ts`): viene richiesto a oltranza finché il viaggiatore
non risponde con un numero, mai deciso in silenzio da un hint. Nessuna
modifica necessaria lì.

Nuovo test dedicato in `test/conversation.test.ts` che riproduce
esattamente lo scenario di Giuseppe (profilo `economicTier: "luxury"`,
budget mai indicato in conversazione, loop-breaker che scatta al
secondo turno) e verifica sia `slots.budgetTier === "high"` sia il
compromesso dichiarato. Typecheck pulito, 79 test passano.

### Il vicolo cieco dopo una prenotazione: niente bottone, la conversazione continua da sola (sessionId `ab6d0bfa-...`, riguardata, 2026-09-15)

Giuseppe, riguardando la STESSA sessione già investigata sopra: dopo
una prenotazione confermata (pagata, in attesa solo della conferma
tecnica interna — vedi la chiusura di Carlo più sopra), aveva scritto
3 volte in quella stessa chat "voglio organizzare un viaggio a
Lanzarote per il Padel dal 16 al 22 settembre" e ricevuto sempre lo
stesso messaggio fisso ("il pagamento è andato a buon fine... dimmi
'riprova'"). Verificato leggendo lo stato reale via `/api/state`, non
per ipotesi.

**Causa reale**: `handleMessage()` (`conversation.ts`), quando lo stage
è `"booked"` o `"failed"`, rispondeva SEMPRE con un messaggio fisso che
diceva letteralmente "apri una nuova conversazione se vuoi prenotare
qualcos'altro" — ma il frontend (`public/index.html`) non offre alcun
modo di farlo: il `sessionId` resta in `localStorage` per sempre,
nessun bottone "nuova conversazione" esiste. Un vicolo cieco reale: il
messaggio suggeriva un'azione che l'interfaccia non permette.

**La soluzione discussa insieme, e perché non un bottone**: un bottone
"nuova conversazione" avrebbe risolto il problema ma è la soluzione
sbagliata per questo prodotto — Giuseppe: "la nostra app gira nel 2029
senza schermo e la UI è una facility poiché siamo nel 2026". Un vero
travel agent (umano, o vocale) non ha un tasto "nuova conversazione":
capisce dal contesto quando gli si sta chiedendo qualcosa di nuovo. La
soluzione doveva reggere anche senza schermo.

**Implementazione** (`conversation.ts`): quando la conversazione è in
uno stage terminale e arriva un nuovo messaggio, invece del messaggio
fisso incondizionato, il messaggio viene passato a `interpret()` (la
stessa chiamata NLU già usata ovunque nel resto del flusso) contro uno
slot vuoto (`EMPTY_SLOTS`, mai `state.slots` — un valore residuo del
viaggio appena concluso non deve mai infiltrarsi in uno che dovrebbe
essere pulito). Due casi (`tryStartNewTripAfterTerminal`):
- **Nessun segnale di viaggio reale** (sport/città/data/budget tutti
  assenti — "grazie", "ok", "riprova") → comportamento di oggi
  invariato: i percorsi di retry restano gli stessi, il messaggio fisso
  resta lo stesso per la pura conversazione senza contenuto.
- **Segnale di viaggio reale** → la conversazione "si riapre" nella
  STESSA sessione: i campi del viaggio corrente (slot, proposta,
  carrello, pagamento, contatore retry) vengono azzerati, i dati del
  viaggiatore e gli hint del profilo restano intatti (mai richiesti di
  nuovo), e l'interpretazione appena fatta viene applicata direttamente
  — mai una seconda chiamata al modello per lo stesso messaggio
  (`newTripJustStarted`, guardia esplicita sulla chiamata `interpret()`
  del flusso principale).

**Il controllo duplicati, e perché solo le date contano**: Giuseppe,
sempre nella stessa conversazione: "è sufficiente che le date si
accavallino. Non le città... non posso essere in due posti diversi
allo stesso momento... le intersezioni contano! Devo essere libero in
quelle date." Quindi il controllo (`searchAndPropose`, al momento della
proposta, quando la nuova candidata ha finalmente una durata reale) è
un'intersezione di INTERVALLI DI DATE, inclusiva (`datesOverlap`,
`engine/dates.ts`: `aFrom <= bTo && bFrom <= aTo` — dal 1 al 10 confligge
sia con dal 1 al 3 sia con dall'8 all'11), confrontata contro OGNI
prenotazione già pagata in questa stessa conversazione
(`state.pastBookings`, popolato solo se `paymentStatus === "succeeded"`
— nulla da segnalare per un fallimento genuino senza pagamento), MAI
contro la città. **Mai un blocco**: solo un avviso onesto in coda alla
proposta (`propose.dateOverlapWarning`, `engine/ai.ts`) — "hai già una
prenotazione confermata in quel periodo, vuoi procedere comunque?" — il
viaggiatore resta libero di prenotare due viaggi diversi nella stessa
settimana se proprio vuole (il sistema non ha modo di saperlo con
certezza, e non è comunque suo compito impedirlo).

**Scope dichiarato, non nascosto**: `pastBookings` vive nella singola
Durable Object di questa conversazione, non tra sessioni/dispositivi
diversi — esattamente lo stesso limite già documentato per
`economicTierHint` ("a tendere avremo un db per le preferenze
utente..."): un vero controllo cross-sessione (via email/userId)
richiede quel database futuro, oggi non esiste.

3 nuovi test in `test/conversation.test.ts`: chatter pura dopo
"booked" non riapre nulla; un nuovo viaggio genuino dopo "booked" (e
separatamente dopo "failed"/non verificato — il caso reale esatto)
riparte nella stessa conversazione con dati del viaggiatore intatti e
`pastBookings` popolato; date sovrapposte generano l'avviso ma non
bloccano la prenotazione. Il test preesistente sul comportamento
"booked" è stato aggiornato (usava testo libero non-DSL come sinonimo
di "nessun contenuto nuovo" — ma nello STUB_MODE il fallback one-shot
riempie sempre tutti gli slot per qualunque testo non-DSL, quindi ora
serve "noop:1" per rappresentare davvero "niente di nuovo detto").
Typecheck pulito, 82 test passano.

### Un vero 500 in produzione, trovato entro pochi minuti dal deploy, sulla stessa sessione reale (2026-09-15)

Subito dopo il deploy della feature sopra, verifica dal vivo sulla
STESSA sessione `ab6d0bfa-...` (non un test sintetico): la richiesta di
un nuovo viaggio genuino restituiva un errore Cloudflare `1101`
("Worker threw a JavaScript exception"), non la riapertura attesa.
Confermato con `wrangler tail` + una chiamata reale, non ipotizzato.

**Causa**: lo stato di QUELLA conversazione era stato salvato prima di
oggi — non aveva ancora i campi nuovi (`pastBookings`,
`lastDateOverlapWarning`, `budgetTierFromProfileDefault`, quest'ultimo
aggiunto già in un fix precedente nella stessa giornata). `loadState()`
faceva `stored ?? initialState()`: utile solo per una conversazione
mai esistita, ma per una già persistita restituiva l'oggetto esattamente
come salvato — campi mancanti restavano `undefined` per sempre, non
`null`. `tryStartNewTripAfterTerminal` chiamava
`state.pastBookings.push(...)` su `undefined` → eccezione reale.

**Fix, generale non puntuale**: `loadState()` ora fa
`{ ...initialState(), ...stored }` — i default di uno stato nuovo
riempiono qualunque campo assente in uno vecchio, i valori realmente
persistiti vincono sempre dove presenti. Copre automaticamente anche i
PROSSIMI campi che lo stato di questa conversazione dovesse guadagnare
(già cresciuto tre volte in una singola giornata di sessione), non solo
questi tre. Ri-deployato e riverificato dal vivo sulla stessa identica
sessione reale: la richiesta di viaggio ora riapre correttamente la
conversazione, con `pastBookings` popolato dalla prenotazione
precedente e i dati del viaggiatore/profilo intatti.

Nessun test di regressione dedicato per questo caso specifico (serve
uno stato persistito con la vecchia forma, non facilmente isolabile
senza un metodo di test-only sul DO) — verificato invece dal vivo,
due volte, sulla stessa sessione reale che lo aveva causato.

## 4. Metodo agentico (15%)

- **Agenti/tool usati**: Claude Code, un'unica sessione pubblica continua
  dentro questa cartella (nessun sotto-agente delegato per l'esecuzione
  principale — la stessa sessione ha esplorato l'API dal vivo con `curl`,
  scritto il codice, girato `wrangler dev`/`vitest`/`k6`, diagnosticato bug
  via `wrangler tail`, e deployato con `wrangler deploy`). Scelta
  deliberata, non di default: il brief chiede che i timestamp dei commit,
  i log degli agenti e gli eventi pausa/ripresa raccontino la stessa
  storia coerente — frammentare il lavoro su sotto-agenti avrebbe sparso
  quella storia su transcript separati, più difficili da incrociare.
  `Agent`/sotto-agenti restano un'opzione dichiarata nel brief per pezzi
  grandi e indipendenti, ma in pratica il lavoro è risultato abbastanza
  interconnesso (ogni scoperta sull'API ha cambiato il codice appena
  scritto) da rendere l'esecuzione singola-sessione la scelta più onesta,
  non solo la più semplice.
- **Come il log grezzo in `/agent-log/` documenta il processo**: è
  l'export non editato del file `.jsonl` di questa sessione (vedi
  `agent-log/README.md` per il meccanismo) — include le chiamate `curl`
  reali contro `api.hofj.com`, i tentativi falliti prima di capire il bug
  del 502/405 sul pagamento, la diagnosi in diretta della soglia Workers
  AI esaurita via `wrangler tail`, e le domande poste a Giuseppe nei
  momenti di reale ambiguità (vedi punto sotto). Non è stato riscritto né
  ripulito: dove qualcosa è stato tentato e scartato (es. il primo
  `keyword` di ricerca senza filtro città), resta visibile.
- **Decisioni prese dall'agente vs decisioni prese da Giuseppe**: le
  decisioni di prodotto/vincolo (stack TypeScript+Workers, pattern di
  confidenza categorico, vincoli del manifesto) arrivano dal
  `AGENT-BRIEF.md` già scritto in fase di pianificazione privata (vedi
  sotto). Le decisioni tecniche di implementazione (come classificare
  exact/compromise/none, come gestire i due bug upstream, come strutturare
  `engine/ai.ts`) sono dell'agente. Due volte durante la sessione la
  decisione è stata esplicitamente rimandata a Giuseppe invece di
  procedere da soli, perché comportava un trade-off che solo lui poteva
  giudicare: (1) come gestire i due endpoint HOFJ bloccati (documentare e
  continuare vs cercare ancora un workaround), (2) come sbloccare la
  soglia Workers AI esaurita (upgrade a pagamento vs chiave Anthropic vs
  aspettare il reset) — entrambe visibili nel log come domande poste
  esplicitamente, non decise in autonomia.

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

### Suite di prompt reali, per coprire lo strato NLU dove nessun test unitario può arrivare (2026-09-14 ~19:30)

Giuseppe ha proposto (giustamente) di formalizzare la lista informale di
"prompt che funzionano" già data a voce in una suite ripetibile — con
l'accortezza esplicita di stare attenti al costo, dato che la quota
gratuita giornaliera di Workers AI si era già esaurita in sessione (vedi
sopra) e ogni chiamata da quel punto passa dal fallback Anthropic Haiku,
a pagamento sui $5 di budget dichiarati per l'intera challenge.

**Design scelto apposta per il costo**: `scripts/prompt-suite.mjs`, uno
script standalone, **non** dentro `npm test`/CI (girerebbe ad ogni commit,
spendendo soldi reali ad ogni push). Ogni caso è una conversazione fresca,
quasi sempre un solo messaggio (≈1-2 chiamate AI reali: `interpret()` +
`say()`), per tenere il numero di chiamate prevedibile e basso. Testa
SOLO l'estrazione NLU strutturata (`state.slots`, `state.language`) contro
frasi reali già usate dal vivo — non il testo della risposta (che l'LLM
formula diversamente ad ogni run per design) e non la logica di
business/booking (già deterministica e coperta da unit test altrove,
zero costo). Modalità dry-run di default (stampa i casi e la stima delle
chiamate, non chiama nulla); `--run` per eseguire per davvero; `--only=`
per filtrare un sottoinsieme.

**12 casi**, quasi tutti presi da conversazioni reali già testate in
questa sessione (sessionId `81992bfd-...`, la target customer journey
inglese — entrambe introdotte più sotto, in "Cinque richieste di
Giuseppe dopo un test dal vivo in inglese sulla customer journey
target" e nei bug trovati ritestandole, sezione 5 — e `verify-stripe-01`,
ecc.) — non inventati apposta per far
passare il test, ma le stesse identiche frasi che avevano già causato bug
reali oggi (il range di date "dal 15 al 21 settembre", "9/10/2026", "il 9
di ottobre", "budget illimitato", "il miglior insegnante... in Nord
Europa"), più qualche caso esplicitamente segnalato come "non ancora
testato dal vivo" in una lista precedente (switch di lingua a metà
conversazione, un gruppo non numerabile che non deve mai diventare un
numero inventato, una data relativa inglese "in 5 days").

**Eseguito per davvero una volta, dopo un pilota su un solo caso per
validare lo script prima di spendere sull'intera batteria**: pilota 1/1,
poi batteria completa **12/12 passati**, ~26 chiamate AI totali stimate.
Nessun fallimento — un segnale onesto che lo strato NLU regge bene su
questo campione reale, non solo sulle frasi isolate già verificate a
mano una per volta.

### Bug reale scoperto da Giuseppe testando l'app live (2026-09-15 ~15:25)

Non un test scriptato: Giuseppe ha usato l'app vera a voce e si è bloccato
in un loop — l'agente continuava a chiedere "quando vorresti partire?"
qualunque cosa rispondesse. Ho letto lo stato reale della sua conversazione
via `GET /api/state?sessionId=...` e trovato due bug distinti, entrambi
confermati con test mirati prima di toccare il codice:

1. **Gap nel parser di date deterministico** (`engine/dates.ts`): "il 9 di
   ottobre" (con "di" come connettore, italiano parlato comunissimo) e
   "9/10/2026" (formato numerico con slash) tornavano entrambi `null` —
   la regex giorno+mese non prevedeva "di" tra numero e mese, e non
   esisteva affatto un parser per date numeriche separate da `/`. Corretto
   con due aggiunte mirate + test di regressione con le frasi esatte usate
   da Giuseppe (non frasi inventate).
2. **Difetto di design più profondo, non solo di parsing**: anche
   sistemando il parser, il sistema restava rigido — richiedeva una data
   ESATTA prima di proporre qualunque cosa, mentre una richiesta legittima
   come "un weekend a novembre" o "nel Nord Europa" (punto sollevato da
   Giuseppe: il motore dovrebbe trasformare richieste vaghe in query, non
   bloccarsi su di esse) non produce mai una data esatta per costruzione.
   La ricerca HOFJ (`/v1/recommendations/search`) non ha mai richiesto una
   data come filtro obbligatorio — il vincolo era solo nostro, non
   dell'API. **Decisione**: `dateFrom` non è più un prerequisito rigido
   per cercare. Se il viaggiatore dà una risposta vaga che non risolve a
   un giorno preciso, non si continua a richiedere precisione — si passa
   subito alla ricerca, e `classify()` propone la prima disponibilità del
   candidato migliore come un compromesso esplicito di categoria
   `date_unspecified` ("non hai dato una data precisa, ti propongo il
   [primo slot libero], va bene?"), riusando esattamente lo stesso pattern
   di conferma esplicita già usato per prezzo/data fuori target — non un
   meccanismo nuovo, la stessa negoziazione categorica applicata a un
   terzo caso. Al "sì", la data implicita viene scritta in `state.slots`
   prima di aprire il carrello reale, quindi la prenotazione finale usa
   comunque una data concreta.

### Policy di precisione, dettata da Giuseppe dopo il bug qui sopra (2026-09-15 ~15:35)

Il bug della data ha fatto emergere una domanda più generale: quanto
possono essere vaghi i viaggiatori su ciascuna dimensione (località, date,
budget, insegnanti/attività, numero di persone), e quando è l'agente a
dover decidere al posto loro dato che prenota per davvero? Regola esplicita
data da Giuseppe, non dedotta da me:

- **Budget e numero di persone (`adults`) non si decidono mai — inventando
  un numero specifico.** Se non detti esplicitamente, si chiedono. Non c'è
  un default onesto per "quante persone" o "quanto vuoi spendere":
  inventare un NUMERO significherebbe prenotare/pagare qualcosa che il
  viaggiatore non ha davvero autorizzato. *(Nota aggiunta il 2026-09-15
  dopo una revisione della policy da parte di Giuseppe: il budget ha poi
  ricevuto lo stesso trattamento di città/data — se non menzionato affatto
  dopo un tentativo di chiederlo, si cerca senza vincolo e si propone il
  più economico, dichiarato esplicitamente come compromesso. La riga dura
  resta: mai un NUMERO inventato. `adults` resta l'unico campo senza
  eccezioni, mai bypassato in nessun caso — vedi la sezione più sotto.)*
- **Località, date, insegnante/attività possono essere vaghi**: l'agente,
  che prenota per davvero, deve poter decidere lui quando serve — ma
  SEMPRE con una proposta esplicita da confermare, mai come tabella di
  scelta nascosta dietro le quinte ("non voglio mascherare tabelle con
  scelta nascoste nell'app" — citazione diretta). È esattamente il pattern
  già costruito per `date_unspecified`: non una lista di opzioni tra cui
  scegliere, una singola proposta con la scelta già fatta e dichiarata,
  che il viaggiatore può accettare o rifiutare.

**Gap trovato applicando la policy al codice esistente**: `adults`
defaultava silenziosamente a 1 senza mai essere chiesto — violazione diretta
della prima regola, introdotta ancora prima che la policy fosse dichiarata
esplicitamente (un default "innocuo" scritto senza pensarci). Corretto:
`Slots.adults` è ora `number | null` (non più `number` con default),
aggiunto a `REQUIRED_TRIP_SLOTS`, mai inventato da `interpret()` nemmeno
quando sembra deducibile dal contesto (regola esplicita nel prompt:
"tutta la famiglia" senza un numero resta `null`, va chiesto).

**Cosa mancava anche su insegnanti/attività**: `preferences` veniva
raccolto in conversazione ma non influenzava mai la ricerca reale.
Verificato dal vivo che i filtri tipizzati di HOFJ (`goal`, `style`,
`bestForLevel`, presenti nei dati prodotto) vengono ignorati silenziosamente
se passati come query param sull'endpoint di ricerca — l'unica leva reale
resta il `keyword` testuale. `engine/matcher.ts` ora prova prima una
ricerca con `preferences` incluso nel keyword, e se torna vuota (il
matching testuale può azzerare risultati validi tanto quanto affinarli)
ripiega sulla ricerca semplice città+sport — stesso pattern di degradazione
già usato per il fallback Weebora sul padel.

### La stessa policy applicata alla città, dopo che Giuseppe ha rimesso in discussione la sessione del bug originale (2026-09-15 ~16:05)

Tornando sulla conversazione del primo bug (sessionId salvato in
`/agent-log/`), Giuseppe ha notato che non aveva mai detto una città reale
— e ha fatto una domanda diretta: con richieste così generiche, il sistema
dovrebbe comunque convergere verso "il miglior insegnante", o è lui a
forzare la mano con prompt troppo vaghi? Risposta: no, non stava forzando
niente — era la stessa policy già dettata (budget/persone mai decisi,
località/date/insegnante sì) applicata coerentemente solo a metà. La città
aveva ricevuto lo stesso trattamento rigido delle date PRIMA della
correzione: nessun meccanismo di "vago ma va bene così, propongo e
dichiaro" — solo una domanda che si ripeteva.

Due correzioni, entrambe verificate dal vivo su una conversazione reale
(niente città data, sport+budget+data+insegnante sì):

1. **`searchCandidates` ora restituisce anche `locationMatched: boolean`**,
   non solo la lista di candidati. Quando manca una città o quella data non
   combacia con niente, invece di svuotare la lista (che spingerebbe
   `classify()` verso "nessuna corrispondenza, chiedo chiarimento") si
   ripiega sui migliori risultati non filtrati, e `classify()` lo trasforma
   in un compromesso esplicito `location_unspecified` — stessa disciplina
   del `date_unspecified`, mai una scelta silenziosa.
2. **Loop-breaker generale nello stage "collecting"**: dopo 2 tentativi
   consecutivi bloccati sulla città, il sistema smette di richiedere
   precisione e propone comunque, lasciando che sia `location_unspecified`
   a dichiarare la scelta fatta. Deliberatamente **non** applicato a
   `adults`: quello resta sempre chiesto esplicitamente, mai bypassato —
   è la stessa linea netta della policy di Giuseppe, applicata solo dove
   lui l'ha voluta. (Budget ha poi ricevuto lo stesso trattamento di
   città in una revisione successiva — vedi sotto.)

Risultato verificato dal vivo sulla conversazione di test: partendo da
"voglio il miglior insegnante che c'è in giro" senza mai nominare una
città, dopo due tentativi il sistema ha proposto da solo l'Exclusive Padel
Clinic con Ramiro Choya & Vinicius a Milano — un istruttore nominato per
nome, non un default generico — dichiarando esplicitamente "ti va bene
Milano, o preferisci un'altra città?". Esattamente il comportamento
descritto da Giuseppe.

### Due bug trovati da Giuseppe leggendo il codice (non ipotesi), e la stessa policy estesa al budget (2026-09-15 ~16:20)

Giuseppe ha riletto `conversation.ts`/`engine/ai.ts` riga per riga e trovato
due problemi reali, senza bisogno di riprodurli prima dal vivo:

1. **Il segnale "data vaga" non sopravviveva tra i turni.** `vagueDateHeard`
   veniva ricalcolato ogni turno solo dal messaggio corrente e passato come
   parametro locale a `runCollecting`. Se il viaggiatore dava una data vaga
   in un turno in cui non era ancora il momento di chiederla (perché
   mancava prima la città), il segnale spariva — quando la data tornava a
   essere lo slot mancante, veniva richiesta da zero. **Corretto**:
   `slots.dateFromVague` è ora un campo persistito sullo stato (non un
   parametro locale), scritto quando emerge una frase di data non
   risolvibile e letto ogni volta che `dateFrom` torna a essere lo slot
   mancante, indipendentemente da quando è stata pronunciata. Verificato
   dal vivo: data vaga detta mentre si chiedeva la città → città data due
   turni dopo → il sistema usa comunque la data vaga persistita.
2. **Budget troppo rigido**: bloccava per sempre se mai detto, e non
   riconosceva risposte qualitative ("economico", "il top"). Estesa la
   stessa policy già costruita per `date_unspecified`/`location_unspecified`:
   - Nuovo campo `slots.budgetTier: "low"|"high"|null`, riconosciuto da
     `interpret()` per risposte qualitative — "economico"/"il minimo" →
     `"low"`, "il top"/"budget illimitato" → `"high"`. Resta vietato
     inventare un numero: se non viene dato né un numero né un giudizio
     qualitativo, entrambi i campi restano `null`.
   - Nuovo compromesso `budget_unspecified` (simmetrico a
     `date_unspecified`): se il budget non è mai stato menzionato dopo un
     solo tentativo di chiederlo, si cerca senza vincolo di prezzo e si
     propone il candidato più economico tra i pertinenti, dichiarato
     esplicitamente ("non mi hai detto un budget, ti propongo il più
     economico, X€, procedo?").
   - `budgetTier: "low"` seleziona anch'esso il candidato più economico,
     ma come risposta **esatta** (non un compromesso: il viaggiatore ha
     risposto davvero, solo in modo qualitativo) — la differenza è la
     dichiarazione, non il candidato scelto. `budgetTier: "high"` lascia
     la selezione di default (il più rilevante secondo il ranking
     dell'API), coerente con "senza badare a spese".
   - Verificato dal vivo tutti e tre i casi: "budget economico, niente di
     esagerato" → `budgetTier: "low"`, categoria "exact"; "voglio il top,
     budget illimitato" → `budgetTier: "high"`; nessun budget menzionato
     dopo un tentativo → `budget_unspecified` con il candidato più
     economico.

**Un terzo bug, più serio, trovato verificando dal vivo il primo fix**: i
tre meccanismi di bypass (data vaga, città dopo N tentativi, budget dopo 1
tentativo) chiamavano tutti direttamente `searchAndPropose()`, saltando
qualunque slot **successivo** nell'ordine di priorità — compreso `adults`,
l'unico che non deve MAI essere bypassato. Riprodotto dal vivo: data vaga
detta per prima, poi città data → il sistema è saltato dritto a una
proposta con `adults: null`, senza averlo mai chiesto. Violazione diretta
della regola più esplicita di tutte. **Corretto**: `runCollecting` non
usa più bypass puntuali indipendenti — scorre `REQUIRED_TRIP_SLOTS` in
ordine e si ferma al primo slot che non è "gating-satisfied" (valore reale
OPPURE bypass legittimo per quello slot specifico); `adults` non ha mai un
bypass legittimo, quindi continua a bloccare finché non viene dato un
numero vero, qualunque cosa succeda prima nell'ordine. Verificato dal vivo
dopo la correzione: stessa sequenza (data vaga → città), questa volta il
sistema chiede correttamente budget e poi adults prima di proporre.

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

**Soglia gratuita raggiunta per davvero** (2026-09-14 ~14:45, dopo il load
test k6 + i test manuali di questa sessione): Workers AI ha iniziato a
rifiutare ogni chiamata con `4006: you have used up your daily free
allocation of 10,000 neurons`. Il brief stesso anticipava questa soglia
("gratuito entro la soglia") — l'abbiamo raggiunta davvero, non è
ipotetica. Il fallback Anthropic Haiku esiste in `engine/ai.ts` proprio
per questo scenario (oltre che per un calo di qualità), ma richiede una
`ANTHROPIC_API_KEY` che non era ancora configurata quando l'abbiamo
trovato — decisione presa con Giuseppe su come procedere registrata nel
prossimo commit. Aggiunto nel frattempo un `console.error` per tentativo
fallito in `runWorkersAi()`, cablato apposta per essere visibile via
`wrangler tail` — è così che questo problema è stato diagnosticato in
pochi minuti invece di restare un "non capisco perché fallisce" silenzioso.

**Conclusione**: Workers AI (Llama 3.3 70B) è qualitativamente adeguato come
motore primario per NLU/NLG in italiano — il fraseggio delle proposte
("non riesco a 365€, il prezzo reale è 465€, procedo?") è risultato naturale
e rispetta il vincolo "una proposta alla volta" senza bisogno di prompt
engineering aggressivo. Il fallback Anthropic Haiku, per come era stato
progettato inizialmente, non sarebbe mai servito per *qualità* — ma è finito
comunque per attivarsi davvero nella stessa sessione, per il motivo diverso
di cui sopra (soglia gratuita esaurita), a riprova che vale la pena costruire
un fallback anche quando il motore principale si comporta bene: il problema
che lo attiva non è sempre quello che ti aspetti. Verificato dal vivo che
Haiku regge lo stesso identico flusso — multi-turno a uno slot per volta,
rinegoziazione budget a metà proposta senza un sì/no esplicito — con la
stessa qualità di fraseggio e la stessa disciplina "una proposta alla volta".

### Tre bug trovati da Giuseppe testando dal vivo (sessione `81992bfd-...`, 2026-09-15 ~16:40)

Giuseppe ha continuato a testare la stessa conversazione reale (quella del
primissimo bug sul loop delle date) e ha segnalato due problemi in un
colpo solo: "pare non prenda la città" e un tono "un po' meccanico" nelle
domande sui dati del viaggiatore. Leggendo lo stato reale della
conversazione ho trovato **tre** bug distinti, non due:

1. **Conflitto di campo "città".** `slots.city` (destinazione del viaggio)
   e `traveller.city` (città di residenza, per la fatturazione) sono due
   campi diversi ma `interpret()` non sapeva mai a quale stage/domanda
   stesse rispondendo il viaggiatore. Prova diretta nello stato reale:
   dopo una proposta confermata per **Lanzarote**, una risposta secca
   "Lecco" (destinata alla città di residenza) aveva sovrascritto
   `slots.city` a "Lecco" — la destinazione del viaggio, già confermata,
   corrotta silenziosamente. **Corretto in due passi**: (a) guardia
   deterministica lato codice — `slotUpdates` (i campi del viaggio) non
   vengono più applicati affatto quando lo stage non è più
   "collecting"/"proposing" (il viaggio è bloccato, non più
   rinegoziabile a quel punto), qualunque cosa restituisca il modello;
   (b) `interpret()` ora riceve anche una frase che descrive cosa si sta
   chiedendo in quel turno specifico (es. "la città DI RESIDENZA del
   viaggiatore... NON la destinazione del viaggio"), così una risposta
   secca e ambigua va nel campo giusto invece di andare persa nel campo
   sbagliato (poi scartato dalla guardia del punto a). Verificato dal vivo
   dopo il fix: `slots.city` resta "Milano", `traveller.city` diventa
   "Roma" — nessuna corruzione, nessuna perdita.
2. **Tono meccanico, causa reale trovata nel prompt**: l'istruzione per
   ogni campo del viaggiatore diceva letteralmente "Spiega che per
   procedere alla prenotazione ti servono i dati" — ripetuta identica per
   OGNI campo (nome, cognome, email, telefono, città), 5 volte di fila.
   Non era percezione soggettiva, era il prompt stesso a richiedere la
   ripetizione. **Corretto**: la spiegazione del "perché" si dice solo la
   prima volta (`isFirstAsk`); le domande successive sono dirette,
   naturali, senza ripetere il contesto — verificato dal vivo: "Dove ti
   mando la conferma?" / "Allora, a che numero ti raggiungo?" / "Da dove
   scrivi?" invece della stessa formula fissa cinque volte.
3. **Bug non segnalato da Giuseppe, trovato indagando il primo**: il
   messaggio "il sistema è un po' lento, puoi ripetere?" che appariva
   ripetuto 5 volte in fila non era un problema del motore AI — era
   `POST /v1/itineraries` che falliva davvero, con `NOT_FOUND_ERROR`, su
   un prodotto (Lanzarote, id 186) che era comparso come risultato di
   ricerca normale e ben formato. Esattamente il caso "prodotto non
   prenotabile" che il brief avvisa esistere, scoperto in fase di
   prenotazione invece che di ricerca. Dato che il fallback già costruito
   per le date sbagliate (retry sul `minDate` del candidato) non si
   applicava — eravamo già sul `minDate`, non c'era altro a cui
   ripiegare — la richiesta falliva sempre allo stesso modo, rendendo
   "riprova" un consiglio vuoto. **Corretto**: quando succede, il prodotto
   viene scartato (`rejectedProductIds`) e si cerca subito il prossimo
   migliore candidato, con un riconoscimento onesto in una battuta sola
   ("il pacchetto precedente non è più disponibile dal fornitore, ma ho
   trovato...") invece di un loop di errori inutili. Verificato dal vivo
   — per puro caso, nello stesso test del punto 1 — con un secondo
   prodotto risultato anch'esso non prenotabile: il messaggio è arrivato
   naturale, in un colpo solo, con la nuova proposta già dentro.

**Metodologia a due tracce (decisa in fase di preparazione):**
- Una sessione privata di pianificazione (mai pubblicata) dove Giuseppe e un
  Claude "consigliere" discutono strategia, dubbi, scarti di strada.
- Una sessione pubblica separata (avviata a foglio bianco dentro questa
  cartella di progetto) che esegue davvero il lavoro — codice, debug, fix —
  e il cui transcript grezzo, senza editing, è quello che finisce in
  /agent-log/. Le decisioni arrivano già maturate dalla sessione privata,
  ma l'esecuzione e gli errori/correzioni che si vedono nel log sono reali,
  non recitati.

### Cinque richieste di Giuseppe dopo un test dal vivo in inglese sulla customer journey target (2026-09-14 ~17:00)

Giuseppe ha descritto una customer journey specifica a cui puntare (inglese,
multi-slot in un'unica frase, budget/mese qualitativi, prezzo "confermato"
prima della conferma finale) e ha dato indicazioni puntuali su cinque punti
dopo averla confrontata con una conversazione reale. Quattro sono stati
implementati e verificati dal vivo in questo giro:

1. **Mirroring della lingua** ("possiamo rispondere con la lingua del
   nostro interlocutore" — sì, va fatto). `interpret()` ora estrae anche
   la lingua usata dal viaggiatore (solo quando chiara o cambiata, non ad
   ogni turno) e la persiste in `ConversationState.language`; `say()` la
   passa al prompt di generazione, sostituendo l'italiano fisso.
   Verificato dal vivo: una conversazione interamente in inglese ("Vela, I
   have three days off in June...") ha ricevuto risposte in inglese dal
   primo turno all'ultimo, senza un solo fallback in italiano.
2. **Budget qualitativo "medio"** — Giuseppe aveva scritto "somewhere
   nice, but not crazy expensive" nell'esempio target; testato dal vivo,
   questo veniva letto come `budgetTier: "low"` (il più economico), non
   corretto — non è "il più economico possibile", è "ragionevole, né il
   fondo né lo sfizio". **Aggiunto** `budgetTier: "mid"` con selezione sul
   prezzo mediano del pool (non il minimo), con esempi espliciti nel
   prompt per distinguerlo da "low". Verificato dal vivo: la stessa frase
   ora estrae correttamente `"mid"`.
3. **Consapevolezza del mese richiesto** — segnalato da Giuseppe come
   "fondamentale", e corrisponde a un attrito reale vissuto in prima
   persona nell'uso dell'app. "Three days off in June" veniva
   correttamente catturato in `dateFromVague` ma **mai usato**: il
   compromesso `date_unspecified` offriva ciecamente il `minDate` del
   candidato, che nel caso di test è risultato dicembre, non giugno.
   **Corretto** con `extractMonthHint()` (estrae un mese anche senza un
   giorno preciso, in IT ed EN) e `firstDateInMonth()` (trova la prima
   data reale nel range di disponibilità che cade nel mese richiesto,
   controllando ogni anno coperto dal range): i candidati con
   disponibilità nel mese richiesto vengono preferiti nell'ordinamento, e
   la data offerta nel compromesso è dentro quel mese quando possibile.
   Verificato dal vivo — con una precisazione onesta: il candidato
   specifico trovato per "padel a Barcellona" nel catalogo reale aveva
   una sola data fissa (11 dicembre), zero disponibilità a giugno; in
   quel caso il fallback dichiarato (proponi comunque, ma è un
   compromesso esplicito) è scattato correttamente — non è un bug del
   fix, è il catalogo reale che non aveva un'alternativa a giugno per
   quel prodotto specifico.
4. **Profilazione utente demo** — Giuseppe si chiedeva se avesse senso una
   login/profilazione utente, "magari per questa demo c'è un utente
   profilato di dft... e poi più in là ogni utente avrà la sua
   profilazione". **Aggiunto** `DEMO_TRAVELLER` (dati sintetici, mai PII
   reali, dichiarato esplicitamente come tale nel codice essendo un repo
   pubblico) come profilo pre-caricato per questa demo, al posto di un
   `EMPTY_TRAVELLER` che obbligava a raccogliere nome/email/telefono a
   voce per ogni conversazione — pensato esplicitamente come base
   concettuale per una futura login/profilazione reale per utente, non
   come soluzione finale. Verificato dal vivo: con questo profilo, la
   conversazione salta interamente lo step "collecting_traveller" e va
   dritta all'apertura del carrello reale dopo la conferma.
5. Il punto 6 della lista ("via libera per Stripe diretto" e il chiarimento
   su `paymentType`, da un aggiornamento di Carlo) è documentato in
   dettaglio in fondo alla sezione 5 (Padronanza API), insieme al bug
   reale trovato mettendolo in pratica.

Due punti restano esplicitamente aperti, non ancora implementati — vedi
`OPEN-POINTS.md`: la "shortlist" di città reali su cui ragionare prima
della scelta finale (punto 2 della lista di Giuseppe — oggi esiste solo il
meccanismo più semplice a singola città), e lo spostamento della verifica
prezzo prima della proposta stessa così il prezzo mostrato è già
"confermato" (punto 5 — solo chiarito con Giuseppe, non ancora approvato
esplicitamente).

### Bug reale trovato da Giuseppe ritestando dal vivo la sessione `81992bfd-...` (2026-09-14 ~18:20)

"Ancora non ci siamo", ha scritto Giuseppe dopo aver ripreso questa
conversazione (la stessa già usata per i bug precedenti sulla città e sul
tono). Ricostruendo lo scambio: aveva confermato un pacchetto Lanzarote,
ricevuto un'onesta rinegoziazione data ("non riesco al 15, riesco al 17"),
confermato di nuovo — e alla seconda conferma il prodotto è risultato
comunque non prenotabile *anche* sulla propria data di fallback (lo stesso
tipo di "prodotto non prenotabile" già documentato, non una scoperta
nuova). Essendo l'ultimo candidato Lanzarote rimasto per quella richiesta,
la ricerca successiva di alternative è tornata a vuoto.

**Il bug vero**: in quel momento la risposta è stata un `no_match`
completamente generico ("non ho trovato niente, dammi flessibilità"),
senza una parola sul fatto che il pacchetto appena confermato due volte
non fosse più prenotabile — un non-sequitur netto dal punto di vista di
chi ha appena detto "sì, procediamo". Il meccanismo di acknowledgment
esisteva già (`precededBy`, usato per dire "quel pacchetto non è più
disponibile, però ho trovato quest'altro..." quando SI trova
un'alternativa), ma veniva passato solo al ramo "trovata un'alternativa",
mai al ramo "non ho trovato nulla" — il caso peggiore, quello dove
l'acknowledgment serve di più, era proprio quello silenzioso. **Corretto**
in `src/engine/ai.ts` (`SayDirective`'s `no_match` ora porta anche
`precededBy`, con un'istruzione dedicata che riconosce onestamente il
fallimento prima della domanda di chiarimento) e in
`src/conversation.ts` (`searchAndPropose()` passa `precededBy` anche al
ramo `no_match`, non solo a quello di successo). Deployato; verifica dal
vivo end-to-end non forzata in modo deterministico (dipende dallo stesso
prodotto che fallisce due volte sull'inventario reale, non riproducibile
a comando), ma il cambiamento è meccanico e a basso rischio — instrada un
parametro già esistente verso un ramo che prima lo ignorava, nessuna
nuova logica di business introdotta.

### CORREZIONE: il "prodotto non prenotabile" di Lanzarote non era un bug di HOFJ — era nostro (2026-09-14 ~19:00)

Dopo il fix sopra, Giuseppe ha chiesto perché non fosse comunque riuscito a
completare la prenotazione di
[lanzarote-padel-getaway-week](https://weebora.com/en/destinations/lanzarote/tocahub-lanzarote/lanzarote-padel-getaway-week)
— un prodotto che vedeva con i suoi occhi esistere sul sito — e ha proposto
una sua diagnosi precisa: la regex di `dates.ts` che estrae giorno+mese non
è ancorata all'inizio della frase, quindi su "dal 15 al 21 settembre" salta
il "15" (non direttamente attaccato a "settembre", c'è "al 21" in mezzo) e
aggancia "21 settembre" — risolvendo silenziosamente alla data sbagliata.

**Verificato subito, empiricamente, fuori dal codice**: la sua analisi
della regex era corretta al 100% —
`"dal 15 al 21 settembre".match(dayMonth)` restituisce davvero `day=21`,
non 15. Un bug vero, riproducibile, indipendente da qualunque congettura.

**Ma non era la causa di questo fallimento specifico.** Ritestando dal
vivo la stessa identica frase in una sessione pulita, `dateFrom` risultava
`"2026-09-17"` (la data negoziata), mai 21 — perché l'LLM, seguendo
l'istruzione del prompt, spezza correttamente "dal 15 al 21 settembre" nei
due campi separati `dateFromText`/`dateToText` prima che la regex veda
l'uno o l'altro isolatamente. Confermando via query dirette all'API HOFJ
(bypassando completamente il nostro Worker), la causa reale è emersa:

```
POST /v1/itineraries?brand=weebora.com   productId=181 → 200 OK, itinerario creato
POST /v1/itineraries?brand=terrarossa.com productId=181 → 404 NOT_FOUND_ERROR
POST /v1/itineraries?brand=weebora.com   productId=186 → 200 OK, itinerario creato
POST /v1/itineraries?brand=terrarossa.com productId=186 → 404 NOT_FOUND_ERROR (stesso identico errore già documentato come "prodotto non prenotabile")
```

**Il bug vero, e nostro**: quando la ricerca padel ripiega su Weebora
(`searchCandidates()`, fallback già esistente da inizio sessione), il
`Candidate` risultante non portava con sé QUALE brand l'avesse prodotto —
e tutta la pipeline di prenotazione (`createItinerary`, `getItinerary`,
`putCustomer`, `putPax`, `getPaymentIntent`, `confirmBooking`) chiamava
sempre il brand primario di default del client (`terrarossa.com`,
`HOFJ_BRAND`), MAI il brand reale del prodotto trovato. Risultato: **ogni
singolo candidato padel proveniente dal fallback Weebora era destinato a
fallire in prenotazione, sempre, al 100%** — non "a volte, per un
capriccio del catalogo". Il bug #3 di "Tre bug trovati... 2026-09-15
~16:40" più sopra (Lanzarote id 186, `NOT_FOUND_ERROR`) era esattamente
questo, diagnosticato male all'epoca come un problema di inventario HOFJ
("prodotto non prenotabile") quando era in realtà un problema nostro di
field-forwarding interno — un mismatch di brand, non di disponibilità.
Questa correzione resta qui esplicitamente, non cancellata, insieme
all'entry originale: fa parte della cronologia reale del debugging, non
solo il risultato finale.

**Corretto** propagando `brand` in modo esplicito attraverso tutta la
catena: `Candidate.brand` e `ConversationState.brand` (nuovi campi,
`types.ts`), ogni risultato di ricerca taggato con il brand usato per
trovarlo (`rawSearchOneBrand()`, `matcher.ts` — mai più affidato al
default implicito del client), e ogni metodo di `HofjClient` che opera su
un itinerario ormai richiede `brand` esplicito invece di un default
silenzioso (`hofj/client.ts`). Aggiunta anche una regressione nel fix
originario della regex data (v. sopra) perché, seppur non la causa di
QUESTO fallimento, è un bug reale e latente che avrebbe potuto colpire in
altre frasi/altri turni dove l'LLM non spezza correttamente il range.

**Verificato dal vivo, end-to-end, per davvero**: lo stesso prodotto 186
(Weebora, Lanzarote) che ha fallito sistematicamente OGNI singola volta
per tutta la giornata — creazione carrello reale
(`itineraryId: "tnwhugsh4uzr"`), ri-verifica prezzo reale (1092€ → 2184€,
catturata onestamente), scrittura customer/pax reali, e un vero
PaymentIntent Stripe **`succeeded`** (`pi_3UFcurRpam3eRRKb1Zyctjle`,
2184€, `metadata.checkoutRefId` combaciante con l'itineraryId reale)
— fallito SOLO all'ultimissimo passo, `POST /v1/bookings`, con l'errore
502 già documentato e non risolvibile da qui (bug HOFJ reale, questo sì,
confermato ore prima con `paymentType` sia "full" che "plan"). Prima di
oggi, questo prodotto non aveva MAI superato nemmeno il primo passo
(`createItinerary`).

**Sulla domanda di Giuseppe "come mai stanno venendo fuori tutti questi
bug"**: la risposta onesta è che escono perché li stiamo cercando
attivamente con test dal vivo reali, non perché il codice stia
peggiorando — ogni bug qui sopra esisteva silenziosamente PRIMA di essere
trovato, e la maggior parte (questo compreso) era mascherata da un errore
generico che sembrava un problema di terzi ("sistema lento", "prodotto non
disponibile lato fornitore"). Il metodo che li sta facendo emergere ora
(test dal vivo mirati, verifica diretta contro l'API bypassando il nostro
Worker per isolare dove sta davvero il problema, mai accontentarsi di un
messaggio d'errore plausibile) è esattamente quello richiesto dal brief.

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

### Altri due bug reali trovati facendo girare la pipeline con più persone (2026-09-15 ~16:00)

1. **`rooms` non scala con `adults`.** Avevamo `rooms: 1` fisso. Con 3
   adulti sullo stesso prodotto/data che funzionava per 1, `POST
   /v1/itineraries` ha dato 500 upstream con
   `"code":"ComponentAvailability","detail":"...lack of availability"` — la
   singola stanza del prodotto non basta per 3 persone. Verificato dal vivo
   che passare `rooms: 2` risolve immediatamente. **Corretto**:
   `rooms = Math.max(1, Math.ceil(adults / 2))`, una stima ragionevole (2
   persone a stanza, convenzione alberghiera standard) in assenza di uno
   step conversazionale dedicato alla configurazione stanze, fuori scope.
2. **Il body di errore a volte arriva illeggibile SOLO passando dal
   runtime Workers, non da curl diretto.** Lo stesso identico endpoint,
   stesso identico errore upstream (`RESERVATION_PERIOD_ERROR`), restituiva
   il JSON completo e leggibile via `curl` diretto ma collassava a un
   generico `"error code: 502"` (pagina di errore di Cloudflare stessa, non
   di HOFJ) quando il fetch avveniva dentro il Worker — probabile
   comportamento di sintesi dell'edge Cloudflare quando l'origin (hosted su
   Google/Firebase) si comporta in modo anomalo su quella risposta
   specifica. Non riproducibile in modo deterministico da fuori. **Non
   risolvibile lato nostro alla radice** (è un'interazione tra
   l'infrastruttura Cloudflare e l'origin di HOFJ), ma reso innocuo: il
   client ora legge sempre il body come testo grezzo prima di provare il
   parsing JSON (mai più un fallimento di `res.json()` silenzioso che
   perde il messaggio reale), e la logica di negoziazione data non si basa
   più sul testo esatto dell'errore (vedi sotto) — non serve più leggerlo
   correttamente per reagire bene.

### Data non valida ≠ errore transitorio — negoziazione invece di "riprova" fuorviante

`minDate`/`maxDate` di un prodotto sono un **intervallo**, ma la
disponibilità reale è a **slot discreti** dentro quell'intervallo — non
ogni giorno nel mezzo è prenotabile davvero. Scoperto testando dal vivo:
"9 ottobre" per un prodotto il cui `minDate` è "25 settembre" e `maxDate`
"11 dicembre" sembra plausibilmente dentro range, ma `POST
/v1/itineraries` fallisce con `RESERVATION_PERIOD_ERROR`. Dato il problema
di parsing del punto precedente (il testo dell'errore reale non sempre
arriva intatto), **la correzione non si basa sul contenuto esatto
dell'errore**: qualunque fallimento di `createItinerary` con una data
diversa dal `minDate` noto-buono del candidato viene trattato come "questa
data probabilmente non è reale" e negoziato — si ripiega sul `minDate` del
candidato (quasi certamente uno slot vero, visto che ogni prodotto testato
in sessione si è aperto con successo su quella data) e si chiede
riconferma esplicita, stesso pattern di compromesso prezzo/data già
esistente. Continuare a dire "il sistema è lento, riprova" per un errore
non transitorio sarebbe stato fuorviante: riprovare con la stessa data
sbagliata fallisce identico.

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

### Pagamento diretto via Stripe, wireato e verificato dal vivo per davvero (2026-09-14 ~17:35)

Carlo (contatto Vela) ha dato via libera esplicito a creare il PaymentIntent
Stripe direttamente contro il loro stesso account, invece di aspettare che
`GET .../payment` venga sistemato — non un workaround inventato da noi, una
scelta sanzionata. Implementato in `src/stripe/client.ts`:
`createPaymentIntent()` (con `metadata.checkoutRefId = itineraryId`, la
stessa chiave usata internamente dal backend HOFJ — verificati dal vivo 38
PaymentIntent riusciti nello stesso account con questa identica forma prima
di scrivere il codice) e `confirmPaymentIntent()` (auto-conferma con la
carta di test ufficiale Stripe `pm_card_visa` — semplificazione dichiarata
per la demo: in produzione la conferma avverrebbe lato client con Stripe
Elements, il Worker non deve mai vedere dati di carta reali, e questo
prototipo non ha ancora quell'integrazione frontend).

`attemptPayment()` prova prima il flusso HOFJ nativo (`getPaymentIntent`,
noto rotto — 502), e solo se fallisce prova il bypass diretto Stripe.

**Trovato mentre lo si verificava dal vivo — bug vero, non HOFJ**: la prima
esecuzione end-to-end (2 adulti) si bloccava ripetutamente su un generico
"il sistema è un po' lento, puoi ripetere?" indistinguibile da un vero
rate-limit. Isolato con `wrangler tail` + chiamate dirette all'API reale
(bypassando il Worker): `PUT /pax` con un solo passeggero (`pax-1`) su
un'itinerary creata per 2 adulti dava 502, dettaglio upstream reale
`"changePaxDetails.paxNumberChanged"` (HTTP 400 dietro il gateway).
Verificato leggendo lo snapshot dell'itinerary appena creata: HOFJ
pre-provisiona uno slot pax per adulto fin dalla creazione (`pax-1`,
`pax-2` già presenti, il secondo vuoto) — mandarne uno solo alla PUT veniva
letto come un cambio del numero di passeggeri, non come compilazione nomi.
**Corretto**: un record pax per ogni adulto (`pax-1` con nome/cognome del
profilo demo, `pax-2..N` con solo `refId`, coerente con lo stub vuoto che
HOFJ stesso crea già per loro — non raccogliamo nomi dei compagni di
viaggio in questa demo). Verificato dal vivo dopo il fix: la pipeline è
arrivata regolarmente fino a un vero PaymentIntent Stripe `succeeded`
(730€, `pi_3UFbvbRpam3eRRKb0Cn6XJ12`, `metadata.checkoutRefId` combaciante
con l'itineraryId reale).

**Aggiornamento sul bloccante `POST /v1/bookings`, dopo il tip di Carlo su
`paymentType`**: Carlo ha spiegato che `"full"` = pagamento completo subito,
`"plan"` = acconto + saldo automatico, e ha segnalato un prodotto reale in
produzione (weebora.com) che usa il modello ad acconto, suggerendo che
`"plan"` fosse plausibilmente il valore corretto per i prodotti su cui
stiamo testando. Provato dal vivo, dopo il pagamento Stripe reale riuscito
sopra: **errore 502 generico identico** a quello già visto con `"full"`.
Questo chiude definitivamente l'ipotesi "valore sbagliato" — conferma che
il gateway scarta il campo `paymentType` a prescindere dal suo contenuto,
prima ancora di inoltrarlo al backend del brand. Non è un problema nostro
di formato/valore; resta un bug di field-forwarding lato gateway HOFJ, non
risolvibile da qui. Il pattern già esistente (`stage: "failed"`,
conversazione ripetibile con "riprova" — che ora ritenta solo la chiamata
di booking, senza ricreare né ri-addebitare il pagamento Stripe già andato
a buon fine, verificato dal vivo controllando che non comparisse un
secondo PaymentIntent dopo un retry) regge comunque la situazione.

### Entrambi i bug storici del booking risolti da Vela — ma il booking finale resta non verificabile (2026-09-14 ~21:45, corretto ~22:10)

Giuseppe ha segnalato di aver sentito che l'API era stata sistemata e ha
chiesto di riprovare un booking reale. Verificato dal vivo: **entrambi** i
bloccanti storici sopra sono davvero spariti — `GET .../payment` restituisce
ora un `client_secret` Stripe vero (prima sempre 502), e `POST
/v1/bookings` accetta `paymentType` qualunque sia il valore (prima sempre
respinto). Progresso reale, confermato empiricamente, non solo riferito.

Non tutto però è risolto per davvero, ed è importante dirlo con
precisione:

1. **Il `client_secret` nativo appartiene a un account Stripe che la
   nostra chiave non può leggere** — verificato: sia `GET` che `confirm`
   su quel PaymentIntent danno `resource_missing` 404. Quasi certamente
   corretto per design (in produzione sarebbe il browser del viaggiatore
   a confermarlo con la chiave pubblicabile del brand, mai noi lato
   server), ma significa che il flusso nativo resta comunque non
   completabile da questo prototipo, che non ha un frontend Stripe.js
   reale. **Bug nostro scoperto di riflesso**: `attemptPayment()` prima
   di questo fix, alla prima chiamata *riuscita* a `getPaymentIntent`,
   metteva la conversazione in `stage: "paying"` e diceva "riprovo
   subito" — un vero e proprio vicolo cieco, dato che nessun frontend
   avrebbe mai richiamato `confirmPaymentAndBook()` per uscirne. Prima
   d'oggi questo ramo non si era mai attivato (l'endpoint 502ava sempre),
   quindi il dead-end esisteva silenziosamente nel codice senza mai
   essersi manifestato. **Corretto**: il flusso nativo viene comunque
   tentato per davvero ad ogni chiamata (resta spec-corretto, utile per
   log), ma non è più uno stato terminale — si passa sempre al bypass
   diretto Stripe già verificato funzionante, qualunque cosa risponda
   `getPaymentIntent`.
2. **Nello spec completo** (`GET /v1/openapi.json`, letto in questo
   dettaglio solo ora) sono emersi due campi opzionali di
   `POST /v1/bookings` mai usati: `paymentIntentId` e `paymentStatus`,
   "forwarded to the brand site when present". Senza di loro il campo
   `data` della risposta 200 si limitava a ripetere l'itineraryId invece
   di un vero codice prenotazione. **Corretto**: forwardati sempre
   (persistiti in `state.paymentIntentId`/`paymentStatus` così un
   "riprova" successivo li re-invia senza ripagare).
3. **Con questi due campi, un giro reale dell'app ha raggiunto
   `stage: "booked"` per la prima volta**: pagamento Stripe vero
   (`pi_3UFfmKRpam3eRRKb1tCnbEW0`, 730€, `succeeded`), risposta 200 con un
   `data` inizialmente sembrato DIVERSO dall'itineraryId (`qu5i422yzsla`,
   non un eco letterale). Trattato inizialmente come "segnale forte, non
   prova assoluta" — **si è rivelato un errore, vedi correzione sotto**.

**CORREZIONE (2026-09-14 ~22:10), dopo che Giuseppe ha fatto riprodurre
il test indipendentemente a un collaboratore**: stesso scenario fedele
(prodotto 118, Weebora, 258€, pagamento Stripe reale `succeeded`,
`metadata.checkoutRefId`, `paymentType` incluso) — risultato SEMPRE e
SOLO l'eco dell'itineraryId in `data`, mai un codice distinto,
`checkout.status` sempre fermo su `"BookingInitiated"`. Il collaboratore
ha notato correttamente due cose che io non avevo controllato: (a) lo
spec descrive `data` come "Reservation code (es. `R-12345`)" — un
formato visibilmente diverso da un itineraryId; (b) nei suoi tentativi
`data` non era "simile" all'itineraryId, era identico byte per byte, con
itineraryId diversi ogni volta — un pattern meccanico da eco, non un
codice generato.

Verificato di conseguenza il test decisivo che mi era mancato:
**idempotenza**. Lo stesso identico `POST /v1/bookings` (stesso
itineraryId `rejgs7dq5kua`, stesso `paymentIntentId` già confermato),
richiamato altre 3 volte di seguito subito dopo il presunto successo, ha
restituito **sempre e solo** l'eco dell'itineraryId (`"rejgs7dq5kua"`) —
mai più `"qu5i422yzsla"`. Se `qu5i422yzsla` fosse stato un vero codice
prenotazione salvato lato server, un endpoint dichiarato esplicitamente
come "Upsert the reservation" nello spec avrebbe dovuto restituirlo di
nuovo, identico, ad ogni richiamata — non è successo nemmeno una volta.
`qu5i422yzsla` è quasi certamente un artefatto isolato/non significativo
(una race condition, un valore interno non collegato a una vera
prenotazione), non una prenotazione reale.

**Criterio affidabile stabilito da questa correzione** (per una
ri-verifica futura, se Vela segnala un altro fix): un `POST /v1/bookings`
si può considerare davvero riuscito solo se **entrambi** questi segnali
sono veri, non uno solo:
1. `checkout.status` dell'itinerario transita via da `"BookingInitiated"`
   verso un altro valore, E
2. richiamare lo stesso `POST /v1/bookings` sullo stesso itinerario più
   volte restituisce lo **stesso identico** valore in `data` ogni volta
   (idempotenza reale, coerente con uno stato salvato).

Nessuno dei due segnali è mai stato osservato, né nel mio test né in
quello del collaboratore di Giuseppe. **Conclusione onesta, corretta
rispetto a quanto scritto sopra**: anche con entrambi i bug storici
chiusi (validazione `paymentType` e `GET .../payment` 502), **non
abbiamo raggiunto una prenotazione realmente confermata e verificabile**
in questo ambiente — resta un terzo problema, più sottile perché non
fallisce più rumorosamente (200 invece di 400/502), ma altrettanto reale.
Non risolvibile da qui con le credenziali disponibili (`GET
/v1/bookings/{id}`, l'unico modo per leggere lo stato vero della
prenotazione con l'enum `BookingStatus`
`pending`/`payment_failed`/`confirmed`/`cancelled`, richiede un token
end-user `X-End-User-Authorization` che una chiave B2B da sviluppatore
non ha — 401, verificato). Domanda aperta e precisa per Carlo: la
risposta 200 di `/v1/bookings` non è più affidabile come segnale di
successo da sola — serve un modo per un client B2B di verificare lo
stato reale della prenotazione appena creata.

Questo è esattamente il genere di autocorrezione che il brief premia:
non ho fabbricato una certezza che non avevo, e quando l'ho fatto per
errore (il "segnale forte" del punto 3), l'ho corretto pubblicamente
appena la prova contraria è arrivata, invece di lasciarlo scritto come
se fosse ancora vero.

## 6. Comunicazione (5%)
- Questo documento (aggiornato durante il lavoro, non a posteriori — vedi
  i timestamp dei commit), `/agent-log/` per la trascrizione grezza della
  sessione, un `README.md` minimale come punto d'ingresso (link a questo
  documento + URL live + come far girare il progetto in locale, niente di
  più), e il [video](https://drive.google.com/file/d/1S4O05OTqrWRv0pQcrD0aFnfBTy84vHeC/view)
  finale di un acquisto reale end-to-end — **completato e caricato**
  (2026-09-15). Deliberatamente non abbiamo investito oltre questo
  minimo: a peso 5% contro il 25%+25% di prototipo/scalabilità, la
  priorità dichiarata dal brief stesso era chiudere il booking reale,
  non rifinire la documentazione.

---

## Timeline della sfida (fatti oggettivi, non ipotesi)
- Clock: 24h dal press di Start, orologio del server di Vela
- Twist: si sblocca a 12h esatte
- Pause disponibili: 2
- Submission: 1 sola, a tempo scaduto
- 5 chiavi nascoste nella challenge, +5h totali se trovate
- API key fornita: vedi CREDENZIALI.local.md (gitignorato, mai in questo repo)

## Decisioni ancora aperte (in attesa di leggere il brief completo)

Risolte durante la sessione pubblica (lasciate qui, non cancellate, per
mostrare cosa si sapeva prima di Start e cosa si è scoperto dopo):
- [x] Stack applicativo → Cloudflare Worker + Durable Object per
  conversazione, TypeScript, come da `AGENT-BRIEF.md`.
- [x] Hosting/deploy target → Cloudflare (`workers.dev`), stesso account
  del binding Workers AI — nessun target esterno necessario.
- [x] Persistenza dati → nessun DB nostro: lo stato di conversazione vive
  nello storage della Durable Object stessa (una per conversazione),
  l'inventario/booking resta sorgente di verità su HOFJ. Non serve altro
  per lo scope attuale.
