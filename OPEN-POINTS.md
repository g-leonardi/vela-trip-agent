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

## Trovato ma non ancora deciso

- **Wireare la creazione diretta del PaymentIntent Stripe (bypass del GET
  rotto) dentro `attemptPayment()` nel codice del Worker?** Verificato dal
  vivo che funziona (pagamento reale test-mode riuscito, agganciato
  all'itinerario reale via `metadata.checkoutRefId`, stesso pattern usato
  dal backend HOFJ — 38 PaymentIntent riusciti trovati nello stesso
  account). Non chiuderebbe comunque la prenotazione finale (bloccante
  sopra resta), ma porterebbe il prototipo fino al pagamento riuscito
  invece di fermarsi prima. **In attesa di decisione di Giuseppe.**

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
