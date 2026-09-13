# Agent log

Log grezzo delle sessioni di Claude Code usate per costruire questa challenge.

## Meccanismo (verificato prima di Start)

Ogni sessione di Claude Code viene salvata automaticamente in locale come file
`.jsonl`, uno per sessione, sotto:

```
~/.claude/projects/-Volumes-SAMSUNG-SO-Claude-VelaChallenge/<session-id>.jsonl
```

Contiene la trascrizione raw (prompt, tool call, risposte). Non c'è bisogno di
copiare/incollare a mano: basta prendere questi file a fine sessione e metterli
qui dentro.

## Prima di pubblicare — checklist redazione

- [ ] Rimuovere/oscurare l'API key di Vela da qualunque punto del log in cui compare in chiaro
- [ ] Controllare che non ci siano altri segreti incollati per errore nei prompt
- [ ] Verificare che i .jsonl non superino limiti dimensione del repo (eventualmente comprimere)
