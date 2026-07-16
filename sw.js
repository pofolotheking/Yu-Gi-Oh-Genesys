// sw.js — Service Worker essenziale, network-first
const CACHE_NAME = 'genesys-cache-v15';
const CORE_ASSETS = ['./', './index.html', './manifest.json'];

// Installazione: pre-cache dei file base
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

// Attivazione: pulisce le cache vecchie
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: ignora Firebase e API esterne, network-first per il resto
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // NON intercettare: Firebase, Google APIs, YGOProDeck, proxy RSS, immagini carte
  if (
    url.includes('firestore.googleapis.com') ||
    url.includes('firebase') ||
    url.includes('googleapis.com') ||
    url.includes('gstatic.com') ||
    url.includes('ygoprodeck.com') ||
    url.includes('allorigins.win') ||
    url.includes('corsproxy.io') ||
    url.includes('ygorganization.com') ||
    e.request.method !== 'GET'
  ) {
    return; // lascia gestire al browser, niente cache
  }

  // Network-first: prova la rete, fallback alla cache se offline
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
