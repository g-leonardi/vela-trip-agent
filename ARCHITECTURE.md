# Architecture — Vela Developer Practical Challenge

> Scheletro preparato PRIMA di leggere il brief completo e PRIMA di premere Start.
> Da riempire man mano, non tutto in fondo sotto pressione di tempo.

## 1. Prototipo funzionante (25%)
- Flusso di booking reale che vogliamo far completare end-to-end:
- Decisioni prese e perché:
- Cosa NON abbiamo implementato e perché (scope cut consapevoli):

## 2. Architettura di scalabilità (25%)
- Bottleneck previsti e come li abbiamo affrontati:
- Load test: strumento usato (k6), scenario simulato, numeri ottenuti:
- Cosa faremmo per scalare 10x / 100x oltre quanto implementato:

## 3. Vision — "sei uscito dal marketplace?" (20%)
- Qual è il marketplace da cui ci si aspetta di uscire:
- La nostra idea per uscirne:

## 4. Metodo agentico (15%)
- Agenti/tool usati (Claude Code, sessioni, ruoli):
- Come il log grezzo in /agent-log/ documenta il processo:
- Decisioni prese dall'agente vs decisioni prese da Giuseppe:

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
