# Key hunt — note tecniche (bonus, non un deliverable richiesto)

Traccia di come sono state trovate le chiavi della catena. Non fa parte dei
deliverable ufficiali (repo/ARCHITECTURE.md/agent-log/load-test/video) — è
solo una nota a margine per documentare il percorso, nel caso valga la pena
citarlo.

## Chiave 1 — "The wire" (+30m)

Indizio mostrato in app: *"Something about this page announces itself to
anyone who looks at the response rather than the render. Your browser has
already been told where to go."*

Passaggi:
1. Un watermark visivo nascosto nell'immagine di sfondo `assets/haze.png`
   (testo "ORIZZONTE" impresso a bassa opacità nei pixel) sembrava una pista,
   ma sottomesso come chiave dava errore — era solo un elemento di design/
   depistaggio, non la chiave.
2. Controllo dei metadati del PNG (chunk `tEXt`/`iTXt`) e scansione di tutti
   gli asset statici (CSS/JS/SVG) per caratteri unicode invisibili (zero-width):
   tutto pulito, nessun secondo livello nascosto lì.
3. L'indizio parlava esplicitamente di "response" vs "render" — quindi non il
   contenuto della pagina, ma gli **header HTTP** della risposta.
   `curl -sD - https://vela-dev-challenge.web.app/` mostra:
   ```
   link: </.well-known/vela/ledger>; rel="vela-ledger"; type="application/problem+json"
   ```
   un header `Link` che il browser riceve ma non rende mai visivamente.
4. `GET /.well-known/vela/ledger` risponde `402 Payment Required` (problem+json)
   chiedendo lo stesso token Bearer usato dall'app verso il backend.
5. Dalla console del browser, nella sessione autenticata:
   ```js
   fetch("/.well-known/vela/ledger", {
     headers: { Authorization: "Bearer " + localStorage.getItem("vela.dev.session.v1") }
   }).then(r => r.json()).then(console.log)
   ```
   risposta: `{ "data": { "ledger": "vela-1", "issuedTo": "...", "entry": "VELA-T8AG-2FVB" } }`
6. Chiave: `VELA-T8AG-2FVB` — accettata.

## Chiave 2 — "The cart" (+45m)

Consegna: aprire un cart HOFJ per il prodotto 118 (Premier Padel Finals
Barcelona 2026, brand indicato come "staging.weebora.com"), 2 adulti 1
camera, su una data valida. Chiave = id dell'hotel più economico offerto.

Passaggi (con due inciampi reali, non solo il percorso pulito):
1. `brand=staging.weebora.com` dà 400 Bad Request — il brand indicato nel
   testo dello stage non è quello valido. `GET /v1/distribution-channels`
   restituisce i brand veri: il dominio corretto è **`weebora.com`** (senza
   "staging.").
2. `GET /v1/products/118?brand=weebora.com` conferma le date valide:
   `minDate`/`maxDate` 2026-12-08 → 2026-12-13.
3. `POST /v1/itineraries?brand=weebora.com&locale=en` con
   `{"productId":118,"startDate":"2026-12-08","adults":2,"rooms":1}` — primo
   tentativo ha dato 502 "upstream timeout" (l'inventario reale, come
   avvisato nel brief). Al retry è andato a buon fine, `itineraryId` ottenuto.
4. `GET /v1/itineraries/{id}/accommodations?brand=weebora.com&locale=en&startDate=2026-12-08&sortByValue=priceAsc`
   — richiede `startDate` anche qui (non basta averlo dato alla creazione
   dell'itinerario). Ordinando per prezzo crescente, il primo elemento è il
   più economico.
5. Chiave: **`p_g_np3dww01`** (SB Plaza Europa, 184€) — accettata.

## Chiave 3 — "The seal" (+60m)

Consegna: un artefatto WASM servito a `/api/seal.wasm`, esporta `seal(ptr,
len)` e `memory`. Input: la chiave precedente, due punti, l'email
dell'account, in UTF-8. Output: il valore ritornato, come 8 cifre esadecimali
minuscole.

Passaggi:
1. `curl -o seal.wasm https://vela-dev-challenge.web.app/api/seal.wasm` (143
   byte, nessun import richiesto — solo `memory` e `seal` esportati, verificato
   con `WebAssembly.Module.exports/imports` prima di istanziare).
2. Con Node: istanziato il modulo, scritto `"p_g_np3dww01:gleonardi87@gmail.com"`
   (UTF-8) in un punto qualsiasi della memoria lineare, chiamato
   `seal(ptr, len)`. Risultato stabile su offset diversi (0, 64, 2048) — è un
   hash puro, non legge byte residui.
3. Risultato `-666079054` interpretato come uint32 → hex a 8 cifre:
   `d84c70b2`.
4. Chiave: **`d84c70b2`** — accettata.

## Chiave 4

(da trovare)
