# Open point — tracciati durante la sessione

> File di lavoro, non un deliverable ufficiale — serve a non perdere il filo
> tra un giro di test e l'altro. Aggiornato via via, non a fine sessione.

## Bloccanti reali (non risolvibili lato nostro)

- **`POST /v1/bookings` rifiuta sempre con `paymentType` invalid_value
  (expected "full"|"plan")**, indipendentemente da cosa mandiamo (provato
  nel body, come query param, dopo un pagamento Stripe vero e riuscito).
  Il gateway `api.hofj.com` scarta quel campo prima di inoltrarlo al
  backend del brand — è un bug del loro gateway, non qualcosa aggirabile
  con credenziali diverse. **Stato: isolato e provato definitivamente
  2026-09-14 ~17:00, non risolvibile da qui.**
  - **Aggiornamento 2026-09-14 ~17:35, dopo il tip di Carlo**: provato
    `paymentType: "plan"` invece di `"full"` su un booking reale, dopo un
    pagamento Stripe diretto vero e riuscito (PaymentIntent
    `pi_3UFbvbRpam3eRRKb0Cn6XJ12`, 730€, `succeeded`). Risultato:
    **identico errore generico 502** dell'altro valore. Questo chiude
    definitivamente l'ipotesi "valore sbagliato" — è un bug di
    field-forwarding nel gateway (il campo viene scartato comunque prima
    di arrivare al backend del brand), non una questione di quale valore
    scegliere. Nessun valore di `paymentType` sblocca `/v1/bookings` allo
    stato attuale. Riportato a Giuseppe per il relay a Carlo.
- **`GET .../itineraries/{id}/payment` risponde sempre 502** (upstream
  405). Bypassato con successo creando il PaymentIntent direttamente via
  Stripe (vedi sotto) — ma questo non sblocca il bloccante sopra.

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
  caso, su un secondo prodotto).
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

## Decisioni di Giuseppe sull'elenco del 2026-09-14 ~18:00

- **"Shortlist" di città reali prima della scelta finale** (punto 1):
  **approvato, da implementare** — non urgente, dopo il resto. Quando la
  città non è vincolante/singola, l'agente deve valutare internamente più
  candidati città con disponibilità reale prima di scegliere quale
  proporre; resta comunque UNA sola proposta finale, mai una lista
  mostrata al viaggiatore.
- **Apertura carrello prima della proposta (invece che dopo la conferma)**
  (punto 2): **deciso di NON implementarla.** Resta l'architettura attuale
  (proponi → conferma → verifica reale in silenzio → chiudi). Motivazione
  di Giuseppe: aprire un itinerary HOFJ vero per ogni proposta — comprese
  quelle rifiutate, che sono la norma nel flusso attuale — moltiplica le
  chiamate su un'API rate-limited condivisa e rischia di far emergere
  prodotti non prenotabili durante quella che dovrebbe restare una
  proposta leggera. Documentato nella sezione scope-cut di
  `ARCHITECTURE.md` (sezione 1).
- **Profilazione utente reale, persistente tra conversazioni** (punto 3):
  **deciso di NON implementarla** in questa sessione. Richiederebbe anche
  risolvere "come riconosco lo stesso utente la prossima volta" — un
  problema di design a sé (identità/autenticazione). `DEMO_TRAVELLER`
  resta esplicitamente un profilo demo/test. Documentato nella sezione
  scope-cut di `ARCHITECTURE.md` (sezione 1).

## Deliverable ancora aperti

- **Video 3-5 minuti** dell'acquisto reale end-to-end — non ancora
  registrato.
- **Key hunt oltre alla chiave 1** — mai ripreso in questa sessione
  (bonus, non richiesto).
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
- **HOFJ è inventario condiviso**: i due bloccanti sopra potrebbero
  sbloccarsi o cambiare comportamento senza preavviso durante le 24h —
  vale la pena un ricontrollo periodico, non solo a fine sessione.
