# Open point — tracciati durante la sessione

> File di lavoro, non un deliverable ufficiale — serve a non perdere il filo
> tra un giro di test e l'altro. Aggiornato via via, non a fine sessione.

## Bloccanti storici, ENTRAMBI risolti lato HOFJ (2026-09-14 ~21:35) — vedi sotto per lo stato attuale

- ~~**`POST /v1/bookings` rifiuta sempre con `paymentType` invalid_value**~~
  — **FIXATO da Vela**, confermato dal vivo 2026-09-14 ~21:35: lo stesso
  identico body che dava 400/502 tutto il giorno ora risponde 200 reale,
  qualunque valore di `paymentType`. Cronologia mantenuta per onestà:
  provato anche `"plan"` alle ~17:35 dopo il tip di Carlo, stesso identico
  errore di `"full"` — chiudeva l'ipotesi "valore sbagliato" a favore di
  "il gateway scarta il campo a prescindere". Quella diagnosi era corretta
  per allora; il bug ora non c'è più.
- ~~**`GET .../itineraries/{id}/payment` risponde sempre 502`**~~ —
  **FIXATO da Vela**, confermato dal vivo 2026-09-14 ~21:35: restituisce
  un `client_secret` Stripe reale. Bypassato con successo per tutta la
  sessione creando il PaymentIntent direttamente (vedi sotto) — resta
  comunque necessario anche ora, per un motivo diverso: vedi sotto.

## Stato attuale del booking end-to-end, dopo i due fix sopra (2026-09-14 ~21:45)

Con entrambi i bug storici chiusi, ho rifatto un giro completo dal vivo.
Non tutto è risolto — quello che segue è preciso, non ottimistico:

- **Il `client_secret` restituito da `GET .../payment` appartiene a un
  account Stripe che la nostra chiave `rk_test_...` non può leggere**
  (verificato: sia `GET` che `confirm` su quel PaymentIntent danno
  `resource_missing` 404). Non è un bug — è quasi certamente corretto per
  design: in un vero deployment sarebbe il browser del viaggiatore a
  confermarlo con la chiave pubblicabile del brand, mai noi lato server.
  Ma significa che il flusso "nativo" resta comunque non completabile da
  qui, anche ora che non 502 più — non abbiamo un frontend Stripe.js reale
  per consumarlo. **Corretto lato nostro**: `attemptPayment()` non si
  blocca più in stato "paying" in attesa di una conferma che non arriverà
  mai (prima un vero dead-end, ora scoperto perché il native endpoint può
  avere successo); prova comunque il flusso nativo per essere
  spec-corretti e per log, ma passa sempre al bypass diretto Stripe (che
  sappiamo funzionare per davvero) per completare qualcosa.
- **Scoperto nello spec completo (`GET /v1/openapi.json`, non consultato
  prima in questo dettaglio) due campi opzionali mai usati finora**:
  `paymentIntentId` e `paymentStatus` su `POST /v1/bookings` — "forwarded
  to the brand site when present". Senza di loro il campo `data` della
  risposta 200 si limitava a ripetere l'itineraryId invece di un vero
  codice prenotazione, e `checkout.status` restava `"BookingInitiated"`.
  **Corretto**: ora forwardati sempre (`hofj/client.ts`, `conversation.ts`
  — persistiti in `state.paymentIntentId`/`paymentStatus` così anche un
  "riprova" successivo li re-invia senza dover ripagare).
- ~~**Con questi due campi forwardati, un giro completo reale dell'app ha
  raggiunto `stage: "booked"` per la prima volta**~~ — **SMENTITO
  (2026-09-14 ~22:10)**, vedi sotto. Non cancellato, corretto: fa parte
  della cronologia reale, incluso l'errore.

### CORREZIONE: quel "booking riuscito" non era reale (2026-09-14 ~22:10)

Giuseppe ha fatto riprodurre il test indipendentemente da un
collaboratore, fedele al nostro scenario (prodotto 118, Weebora, 258€,
Stripe reale `succeeded`, `metadata.checkoutRefId`, `paymentType`
incluso): risultato **sempre e solo** l'eco dell'itineraryId in `data`,
mai un codice distinto, `checkout.status` sempre fermo su
`"BookingInitiated"`. Ha notato due cose giuste che io non avevo
controllato: lo spec descrive `data` come "Reservation code (es.
`R-12345`)", un formato ben diverso da un itineraryId; e nei suoi
tentativi `data` non era "simile" all'itineraryId, era identico byte per
byte — un pattern da eco, non da codice generato.

Verificato di conseguenza il test che mi mancava: **idempotenza**. Lo
stesso `POST /v1/bookings` (stesso itineraryId, stesso PaymentIntent già
confermato) richiamato altre 3 volte di seguito ha restituito **sempre**
l'eco dell'itineraryId — mai più il valore "diverso" della prima volta.
Un endpoint dichiarato dallo spec come "Upsert the reservation" avrebbe
dovuto restituire lo stesso codice reale ad ogni richiamata, se fosse
stato vero. Non è successo nemmeno una volta: quel valore era quasi
certamente un artefatto isolato, non una prenotazione salvata.

**Criterio affidabile per una ri-verifica futura** — un `POST
/v1/bookings` riuscito per davvero richiede ENTRAMBI questi segnali, non
uno solo: (1) `checkout.status` che transita via da "BookingInitiated";
(2) chiamate ripetute sullo stesso itinerary che restituiscono lo
STESSO identico `data` ogni volta (idempotenza reale). Nessuno dei due è
mai stato osservato, né da me né dal collaboratore di Giuseppe.

**Conclusione onesta**: anche con i due bug storici chiusi, non abbiamo
raggiunto una prenotazione realmente confermata e verificabile in questo
ambiente. È un terzo problema — più subdolo, perché ora fallisce con un
200 plausibile invece di un 400/502 rumoroso — non risolvibile da qui
(niente accesso a `GET /v1/bookings/{id}`, richiede un token end-user che
una chiave B2B non ha, 401 verificato). Domanda precisa per Carlo: la
risposta 200 di `/v1/bookings` non è più un segnale di successo
affidabile da sola — serve un modo per un client B2B di verificare lo
stato reale di una prenotazione appena creata.

## Risolto in questa sessione (per riferimento, non più aperto)

- **Conflitto di campo "città"** (destinazione viaggio vs residenza
  viaggiatore) che poteva sovrascrivere silenziosamente la destinazione
  già confermata — corretto con guardia lato codice + contesto esplicito
  a `interpret()`. Verificato dal vivo.
- **Tono meccanico** nelle domande sui dati del viaggiatore (stessa
  spiegazione ripetuta 5 volte) — corretto, spiegazione solo alla prima
  domanda. Verificato dal vivo.
- **Prodotto "non prenotabile" scoperto in fase di booking** (es.
  Lanzarote id 186, `NOT_FOUND_ERROR` su un prodotto uscito come
  risultato di ricerca valido) — prima produceva un loop di "sistema
  lento" inutile; ora viene scartato e si propone il prossimo candidato
  con riconoscimento onesto in una battuta. Verificato dal vivo (per
  caso, su un secondo prodotto). **CORREZIONE (2026-09-14 ~19:00, vedi la
  sezione dedicata più sotto): questa diagnosi era sbagliata.** Non era un
  prodotto non prenotabile lato HOFJ — era un bug nostro di brand
  mismatch. Il meccanismo di fallback (scarta e riprova) resta comunque
  un fix legittimo e utile come rete di sicurezza generale.
- **`PUT /pax` con un solo passeggero su un'itinerary a N adulti dava
  sempre 502** (dettaglio upstream:
  `changePaxDetails.paxNumberChanged`, HTTP reale 400 dietro il 502
  generico del gateway). Causa: HOFJ pre-crea uno slot pax per ogni
  adulto già alla creazione dell'itinerary (`pax-1`, `pax-2`, ... —
  verificato dal vivo leggendo lo snapshot prima della PUT); mandarne
  uno solo veniva letto come "cambio del numero di passeggeri", non
  "compilazione nomi". **Bug vero e nostro**, non un limite HOFJ — corretto
  mandando un record pax per ogni adulto (`pax-1` con nome/cognome del
  viaggiatore demo, `pax-2..N` con solo `refId`, come lo stub vuoto che
  HOFJ stesso già crea per loro). Verificato dal vivo il 2026-09-14
  ~17:35: prima bloccava ogni prenotazione a 2+ adulti con un loop di
  "sistema lento" indistinguibile da un vero rate-limit; dopo il fix la
  pipeline arriva regolarmente fino al pagamento Stripe reale.
- **Pagamento diretto via Stripe (bypass del `GET .../payment` rotto),
  sanzionato da Carlo — wireato e verificato dal vivo**: creazione +
  conferma reale di un PaymentIntent Stripe test-mode (`succeeded`,
  agganciato all'itinerario via `metadata.checkoutRefId`, stesso pattern
  usato dal backend HOFJ) dentro `attemptPayment()`. Porta il prototipo
  fino al pagamento riuscito per davvero; il bloccante `/v1/bookings`
  sopra resta comunque l'ultimo passo, non risolvibile da qui.
- **Mirroring della lingua**: l'agente ora risponde nella lingua del
  viaggiatore (rilevata da `interpret()`, persistita per conversazione),
  non più sempre in italiano. Verificato dal vivo con una conversazione
  interamente in inglese.
- **Budget qualitativo "medio" (`budgetTier: "mid"`)**: "nice, but not
  crazy expensive" / "carino ma non troppo caro" ora seleziona il
  prodotto di prezzo mediano nel pool, distinto da "low" (il più
  economico). Prima veniva confuso con "low". Verificato dal vivo.
- **Consapevolezza del mese richiesto (`preferredMonth`)** — fondamentale
  per Giuseppe, corrisponde a un attrito reale vissuto in prima persona:
  "three days off in June" senza un giorno preciso ora fa preferire, tra
  i candidati, quelli con disponibilità reale in quel mese, e offre una
  data dentro quel mese invece del semplice inizio del range del
  prodotto. Verificato dal vivo (il candidato specifico trovato per
  Barcellona non aveva affatto disponibilità a giugno — un solo giorno
  fisso a dicembre — quindi l'agente è correttamente caduto sul fallback
  dichiarato, non un bug).
- **Profilo viaggiatore demo (`DEMO_TRAVELLER`)**: sostituisce la
  raccolta a voce dei dati anagrafici/fatturazione per questa demo,
  come base concettuale per una futura profilazione utente reale (login
  per utente). Verificato dal vivo: una prenotazione con questi dati
  salta interamente lo step "collecting_traveller" fino all'apertura del
  carrello reale.

## Bug trovato da Giuseppe testando dal vivo, sessione `81992bfd-...` (2026-09-14 ~18:20)

Giuseppe ha ritestato la vecchia sessione `81992bfd-...` e ha segnalato
"ancora non ci siamo". Ricostruendo la conversazione: aveva confermato
DUE VOLTE un pacchetto Lanzarote (una prima conferma è finita in una
rinegoziazione data onesta — "non riesco al 15, riesco al 17" — e lui ha
confermato di nuovo), ma alla seconda conferma il prodotto è risultato
comunque non prenotabile (stesso tipo di caso "prodotto non prenotabile"
già documentato, non nuovo) *anche* sulla propria data di fallback, ed
essendo l'ultimo candidato Lanzarote rimasto (l'altro era già stato
scartato ore prima), la ricerca successiva è tornata a vuoto. **Bug reale
trovato**: quando questo succede, `searchAndPropose()` rispondeva con un
messaggio "no_match" completamente generico ("non ho trovato niente,
dammi flessibilità"), senza alcun accenno al fatto che il pacchetto appena
confermato due volte non fosse più prenotabile — un vero e proprio
non-sequitur dal punto di vista del viaggiatore, che aveva appena detto
"sì, procediamo" e si è visto rispondere come se stesse ripartendo da
zero. La causa: il parametro `precededBy` (che già esisteva e alimentava
l'acknowledgment "quel pacchetto non è più disponibile, però ho
trovato...") veniva passato SOLO al ramo "ho trovato un'alternativa", mai
al ramo "no_match" quando la ricerca di alternative falliva del tutto.
**Corretto**: `precededBy` ora arriva anche al caso `no_match`, con un
riconoscimento onesto ("il pacchetto che avevi appena confermato non è
risultato prenotabile per davvero, e non ho nulla di equivalente da
proporre al suo posto") prima della domanda di chiarimento. Deployato;
verifica dal vivo end-to-end non facile da forzare in modo deterministico
(dipende dallo stesso prodotto che fallisce due volte sull'inventario
reale), ma il cambiamento è meccanico e a basso rischio — passa un
parametro già esistente a un ramo che prima lo ignorava, nessuna nuova
logica di business.

## CORREZIONE MAGGIORE: il "prodotto non prenotabile" era un bug nostro di brand mismatch (2026-09-14 ~19:00)

Giuseppe ha chiesto perché non fosse riuscito a prenotare
[lanzarote-padel-getaway-week](https://weebora.com/en/destinations/lanzarote/tocahub-lanzarote/lanzarote-padel-getaway-week)
(lo vedeva coi suoi occhi sul sito) e ha proposto una diagnosi precisa
sulla regex data ("dal 15 al 21 settembre" → la regex non ancorata
aggancia "21 settembre" invece di "15"). **La sua analisi della regex era
corretta al 100%** (verificato isolatamente: `match()` restituisce
davvero day=21) — ma NON era la causa di questo fallimento specifico:
ritestato dal vivo, `dateFrom` risultava sempre la data giusta (l'LLM
spezza correttamente il range prima che la regex la veda).

**La causa reale**, trovata confrontando chiamate dirette all'API HOFJ
con `brand=weebora.com` (200 OK) contro `brand=terrarossa.com` (404
NOT_FOUND_ERROR, lo stesso identico errore già documentato come "prodotto
non prenotabile"): quando la ricerca padel ripiega su Weebora, il
`Candidate` risultante non portava QUALE brand l'avesse prodotto, e
l'intera pipeline di prenotazione chiamava sempre il brand primario di
default (`terrarossa.com`), mai quello reale. **Ogni singolo prodotto
padel da Weebora era destinato a fallire in prenotazione, sempre** — non
un capriccio del catalogo HOFJ, un bug nostro di field-forwarding.

**Corretto**: `brand` propagato esplicitamente in `Candidate`,
`ConversationState`, ogni metodo di `HofjClient` che tocca un itinerary, e
ogni risultato di ricerca taggato col brand reale con cui è stato trovato
(mai più affidato al default implicito del client). La regex del range
data è stata comunque corretta (bug reale e latente, anche se non la
causa di questo caso — vedi `dates.ts`, nuovo pattern "dal X al Y mese").

**Verificato dal vivo, end-to-end, per davvero**: lo stesso prodotto 186
che ha fallito OGNI volta tutto il giorno ora crea un vero itinerary
(`itineraryId: "tnwhugsh4uzr"`), ri-verifica il prezzo reale (1092€ →
2184€), scrive customer/pax reali, e ottiene un vero PaymentIntent Stripe
**`succeeded`** (`pi_3UFcurRpam3eRRKb1Zyctjle`, 2184€) — fallendo solo
all'ultimissimo passo (`POST /v1/bookings`, il bloccante `paymentType`
già documentato e non risolvibile da qui). Prima di oggi questo prodotto
non aveva mai superato nemmeno il primo passo.

Sul "come mai stanno uscendo tutti questi bug": escono perché li stiamo
cercando attivamente con test dal vivo reali (e verificando ogni ipotesi
contro l'API diretta, non fidandosi di un messaggio d'errore plausibile
ma generico) — non perché il codice stia peggiorando. Erano già lì,
mascherati da errori che sembravano problemi di terzi.

## Bug trovato da Giuseppe, sessionId `9f9a7bc8-...` (2026-09-14 ~23:55) — email non valida uccideva la conversazione

Un'email chiaramente sbagliata (`"Peo Blues@it"`) estratta da
`interpret()` non veniva mai controllata prima di arrivare a
`PUT .../customer`, che l'ha respinta con un 400 reale. Peggio: quella
chiamata non aveva NESSUN `try/catch` (a differenza di `createItinerary`
che ce l'ha), quindi l'errore si è propagato fino al catch-all generico,
terminando l'intera conversazione (città/date/prezzo già negoziati,
persi) senza alcuna possibilità di "riprova" — il meccanismo di retry
riconosce solo `failureReason` con prefisso `payment:`/`bookings:`,
questo non ne aveva nessuno. **Corretto**: un controllo di formato email
prima di accettarla in `state.traveller` (permissivo ma sufficiente a
scartare quel caso), più un `try/catch` attorno a `putCustomer`/`putPax`
come rete di sicurezza generale — su un 400 si torna a raccogliere i
dati del viaggiatore con un riconoscimento onesto, invece di terminare
tutto. Vedi `ARCHITECTURE.md` per i dettagli.

## "Cosa include il pacchetto?" — non ancora implementato, dati già disponibili

Stessa sessione: una domanda informativa legittima sulla proposta
("cosa include il pacchetto?") è stata ignorata — la macchina a stati
oggi interpreta ogni messaggio in stage "proposing" solo come
`yes`/`no`/`unclear`, non c'è alcun concetto di "rispondi a una domanda
ad hoc". Verificato dal vivo che HOFJ restituisce già tutto il necessario
per rispondere (`travelDetail.description`, `includedList`/
`excludedList`, `accommodation`, `travelProgram` giorno per giorno,
`cancellationPolicy`) — semplicemente non lo leggiamo mai, il nostro
`ItinerarySnapshot` cattura solo prezzo/date/checkout. **Non implementato
in questa sessione** — richiederebbe un nuovo tipo di intento riconosciuto
durante "proposing" (oltre a yes/no/unclear) e il parsing di questi campi
nel client HOFJ. In attesa di decisione di Giuseppe su se e quando
costruirlo.

## Decisioni di Giuseppe sull'elenco del 2026-09-14 ~18:00

- ~~**"Shortlist" di città reali prima della scelta finale**~~ (punto 1):
  **IMPLEMENTATO e verificato dal vivo** (commit `3b7cbe4`, 2026-09-14
  ~18:05, vedi anche `ARCHITECTURE.md`): quando la città non è
  vincolante/singola, `classify()` riduce il pool grezzo a un
  rappresentante per città (la sua offerta più economica) prima di
  applicare la selezione prezzo/data — una vera comparazione tra città
  invece di lasciare che quella con più inventario schiacci alternative
  valide con meno listing. Resta sempre UNA proposta finale, mai una
  lista. Verificato dal vivo: richiesta senza città né data ha prodotto
  una singola proposta onesta (Parigi, 659€) con il compromesso
  dichiarato. 2 test dedicati in `test/matcher.test.ts`.
- **Apertura carrello prima della proposta (invece che dopo la conferma)**
  (punto 2): **deciso di NON implementarla.** Resta l'architettura attuale
  (proponi → conferma → verifica reale in silenzio → chiudi). Motivazione
  di Giuseppe: aprire un itinerary HOFJ vero per ogni proposta — comprese
  quelle rifiutate, che sono la norma nel flusso attuale — moltiplica le
  chiamate su un'API rate-limited condivisa e rischia di far emergere
  prodotti non prenotabili durante quella che dovrebbe restare una
  proposta leggera. Documentato nella sezione scope-cut di
  `ARCHITECTURE.md` (sezione 1).
- ~~**Profilazione utente reale, persistente tra conversazioni** (punto
  3): deciso di NON implementarla in questa sessione.~~ **RIVISTA
  2026-09-14 ~23:35**: Giuseppe ha chiesto esplicitamente di eliminare
  `DEMO_TRAVELLER` a favore di "qualcosa di duraturo", accettando che
  resti "solo dentro Durable Objects per ora" — non vera identità
  cross-dispositivo (quello resta fuori scope), solo persistenza locale
  al browser. **Implementato**: `UserProfileDO` (nuovo Durable Object,
  uno per persona non per conversazione, indirizzato da un `userId` in
  localStorage), onboarding conversazionale one-time (nome, email, città,
  sport preferito, nucleo familiare, profilo economico Smart/Pro/Luxury),
  e un meccanismo di "hint suggerito ma sempre confermato" per
  adults/budget/sport che non rompe la policy che quei due campi non si
  decidono mai in silenzio. Bug reale trovato e corretto nel farlo (vedi
  `ARCHITECTURE.md`): una conferma secca a una domanda con hint veniva
  attribuita allo slot sbagliato per un problema di timing nel contatore
  dei tentativi — invisibile prima d'ora perché le risposte esplicite si
  classificano da sole, senza bisogno di quel contesto. Verificato dal
  vivo end-to-end dopo il fix.

## Deliverable ancora aperti

- **Video 3-5 minuti** dell'acquisto reale end-to-end — non ancora
  registrato.
- ~~Key hunt oltre alla chiave 1~~ — **fatto da Giuseppe fuori da questa
  sessione**, tutte trovate.
- **Export finale di `/agent-log/`** — aggiornato periodicamente durante
  la sessione, va rifatto un'ultima volta a ridosso della consegna vera
  (redazione chiave HOFJ + chiave Stripe, entrambe già verificate assenti
  nelle versioni committate finora).

## Near-miss di sicurezza, risolto (2026-09-15 ~17:00)

Un export di `/agent-log/` ha inizialmente lasciato un frammento della
chiave Stripe (troncato dalla formattazione del transcript, non la
stringa esatta cercata dalla mia prima redazione a match esatto) — **il
push a GitHub è stato bloccato dalla loro secret scanning protection
prima di raggiungere il repository pubblico**, il commit non è mai
uscito dalla macchina locale. Corretto con redazione a pattern (regex su
`rk_/sk_/pk_test_...`, non più solo stringa esatta) invece che
riprovare lo stesso approccio fragile, poi commit locale corretto via
`amend` (sicuro: il commit incriminato non era mai stato pubblicato) e
ripush verificato pulito. Nessuna chiave reale è mai stata esposta
pubblicamente. Lezione applicata: le redazioni future usano pattern,
non solo match esatti.

## Limiti di scope accettati consapevolmente (documentati in ARCHITECTURE.md, non bug)

- Nessun test diretto su `conversation.ts` (la Durable Object) — solo
  validazione dal vivo, documentata come scelta esplicita.
- Nessuno step conversazionale per scegliere hotel/camera alternativi
  (violerebbe comunque il vincolo "mai una lista").
- Indirizzo di fatturazione ridotto al minimo (street1/postalCode
  placeholder), non chiesto a voce.
- `rooms = ceil(adults/2)` è una stima, non uno step dedicato di
  configurazione stanze.
- Nessuna ripresa automatica di una conversazione "failed" (l'itineraryId
  resta in stato, ma non c'è retry asincrono/notifica).

## Da tenere d'occhio

- **Budget Anthropic** ($5, deve durare tutto il ciclo di vita della
  challenge incluso il carico dei valutatori): Workers AI ha esaurito la
  soglia gratuita giornaliera durante questa sessione, quindi ogni
  chiamata passa dal fallback Haiku finché Cloudflare non resetta il
  contatore. Da ricontrollare se il consumo sembra anomalo.
- **HOFJ è inventario condiviso**: due bloccanti storici sono già spariti
  senza preavviso durante questa stessa sessione (paymentType, `GET
  .../payment`) — il terzo, più sottile (booking non verificabile, vedi
  sopra), potrebbe fare lo stesso. Vale la pena un ricontrollo periodico
  con il criterio ora stabilito (checkout.status + idempotenza), non
  fidarsi di un 200 da solo.
