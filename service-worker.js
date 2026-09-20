// Service worker di Kartei: mette in cache tutto il necessario al primo avvio
// così l'app funziona completamente offline da quel momento in poi.
//
// IMPORTANTE PER GLI AGGIORNAMENTI FUTURI: ogni volta che pubblichi una nuova
// versione dei file (app.js, styles.css, ecc.), incrementa il numero qui sotto
// (v2 -> v3 -> v4...). È l'UNICO modo per far sì che Safari/iOS si accorga che
// c'è qualcosa di nuovo da scaricare: se questo file resta identico, il telefono
// continua a usare per sempre i file vecchi già salvati in cache, anche se sul
// sito pubblicato i file sono già stati aggiornati.

const CACHE_NAME = 'kartei-cache-v4';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './data/seed-data.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Strategia: cache-first per tutto ciò che è nell'app (offline-first).
// Se una risorsa non è in cache, prova la rete e, se disponibile, la salva per la prossima volta.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request)
        .then(response => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
