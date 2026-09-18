# Kartei — le tue parole

Un'app web offline per imparare vocabolario con la ripetizione dilazionata,
costruita a partire dai tuoi corsi Excel (2.327 parole già importate, in 5
corsi tedeschi con i loro livelli). Nessun account, nessun server, nessuna
dipendenza da Memrise: tutti i dati restano sul tuo iPhone.

## Come funziona

- **Corsi e livelli**: come nel tuo Excel, ogni corso ha più livelli di parole.
- **Tedesco e inglese insieme**: ogni parola ha traduzioni sia in tedesco sia
  in inglese (le 2.327 parole del tuo Excel sono già state tradotte in
  inglese). Ogni parola ha **un'unica "scatola" Leitner**, ma per farla
  avanzare devi rispondere correttamente **sia in tedesco sia in inglese**
  nella stessa sessione: se sbagli anche solo una delle due, la scatola
  retrocede, così impari davvero entrambe in parallelo.
- **Ripetizione dilazionata**: ogni parola ha una scatola (1-8, ispirata al
  metodo Leitner). Avanza → la rivedi più in là nel tempo (ore → giorni →
  settimane → mesi). Retrocede → la rivedi presto.
- **Esercizi misti**: scelta multipla (riconoscere il significato) e
  scrittura (digitare la parola nella lingua richiesta), alternati come su
  Memrise. Un'etichetta "DE"/"EN" ti dice sempre quale lingua stai esercitando
  in quel momento.
- **Tutto offline**: una volta installata, l'app non fa più alcuna richiesta
  di rete. I dati vivono nel tuo telefono.
- **Cerca**: l'icona della lente sulla Home cerca una parola in tedesco,
  italiano o inglese tra tutti i corsi, e porta dritto alla sua scheda di
  modifica.
- **Serie giornaliera e obiettivo**: la Home mostra da quanti giorni di fila
  ti eserciti e quante risposte hai dato oggi rispetto al tuo obiettivo
  (personalizzabile in **Impostazioni → Obiettivo giornaliero**).
- **Gestione corsi e livelli**: in **Impostazioni → Gestisci corsi** puoi
  riordinare o eliminare interi corsi; dentro un corso, le frecce e il
  cestino accanto a ogni livello fanno lo stesso per i singoli livelli.

Le traduzioni inglesi sono state generate automaticamente: dato che buona
parte del vocabolario è tecnico/specialistico, vale la pena ricontrollarle
con calma (puoi correggerle direttamente nell'app, in **Modifica parola**).

## 1. Provarla subito sul computer

Per testarla in locale (senza ancora installarla come app):

```bash
cd kartei
python3 -m http.server 8000
```

Poi apri `http://localhost:8000` nel browser. Va bene per dare un'occhiata,
ma **da qui il salvataggio offline non funziona ancora** — serve il passo 2.

## 2. Installarla davvero sull'iPhone (offline, come un'app)

Il "Service Worker" che rende l'app utilizzabile offline funziona solo se i
file sono serviti via `https://`, non se apri il file direttamente sul
telefono. La soluzione più semplice, gratuita e senza server da mantenere è
**GitHub Pages**:

1. Crea un account gratuito su [github.com](https://github.com) se non lo hai già.
2. Crea un nuovo repository (puoi chiamarlo `kartei`), **pubblico** (o privato,
   se hai un piano che lo consente con Pages).
3. Carica dentro tutti i file di questa cartella `kartei/` (trascinali dalla
   pagina web del repository, "Add file → Upload files").
4. Vai in **Settings → Pages** del repository, e in "Branch" seleziona
   `main` e cartella `/ (root)`, poi Salva.
5. Dopo 1-2 minuti, GitHub ti darà un indirizzo tipo
   `https://tuonome.github.io/kartei/`.
6. Apri quell'indirizzo **con Safari sull'iPhone**, poi tocca l'icona
   Condividi (il quadrato con la freccia) → **"Aggiungi a Home"**.
7. Da quel momento l'icona sulla home funziona come un'app a schermo intero,
   e — dopo la prima apertura online — **continua a funzionare anche in
   modalità aereo**.

Se preferisci non usare GitHub, qualunque hosting statico gratuito va bene
allo stesso modo (Netlify, Vercel, Cloudflare Pages...): basta caricare la
cartella così com'è, senza build.

> Nota: se in futuro modifichi i file e li ricarichi sull'hosting, il Service
> Worker aggiorna la cache automaticamente al successivo avvio dell'app
> (potrebbe richiedere due aperture per notare l'aggiornamento).

## 3. Backup dei progressi

Dato che tutto vive nel telefono, conviene fare un backup ogni tanto:
**Impostazioni → Esporta backup** salva un file `.json` con tutti i corsi,
le parole e i progressi. **Impostazioni → Importa backup** lo ripristina
(anche su un altro dispositivo, se apri lì la stessa app).

Fallo prima di reinstallare l'app o cambiare telefono, perché i dati non si
sincronizzano automaticamente tra dispositivi.

## 4. Aggiungere altre parole in futuro

Due modi, entrambi dentro l'app (tab **Aggiungi**):
- una parola alla volta, dentro un livello;
- **Importa in blocco**: incolli righe nel formato `tedesco;italiano` (o
  `tedesco;italiano;inglese`), una parola per riga, e scegli in quale corso e
  livello finiscono. Comodo se aggiungi altri blocchi dal tuo foglio Excel.

## 5. Struttura dei file

```
kartei/
├── index.html          punto d'ingresso
├── styles.css           aspetto grafico
├── app.js                logica dell'app (dati, algoritmo, schermate)
├── manifest.json          configurazione PWA (nome, icone, colori)
├── service-worker.js       cache offline
├── data/seed-data.js        le tue 2.327 parole originali, importate dall'Excel
└── icons/                    icone dell'app
```

Se un giorno vuoi ripartire da zero con i dati originali del tuo Excel (corsi,
livelli e parole, senza i progressi), c'è un pulsante apposito in
**Impostazioni → Ripristina i dati originali**.
