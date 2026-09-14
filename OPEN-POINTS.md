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
