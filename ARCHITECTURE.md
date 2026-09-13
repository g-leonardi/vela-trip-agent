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
