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

## Chiave 2

(da trovare)
