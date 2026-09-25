// sw.js — Service Worker essenziale, network-first
const CACHE_NAME = 'genesys-cache-v36';
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

  // NON intercettare: Firebase, Google APIs, YGOProDeck
  if (
    url.includes('firestore.googleapis.com') ||
    url.includes('firebase') ||
    url.includes('googleapis.com') ||
    url.includes('gstatic.com') ||
    url.includes('ygoprodeck.com') ||
    url.includes('workers.dev') ||
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

// Notifiche push: il messaggio arriva cifrato dal Worker e va SEMPRE mostrato,
// altrimenti Safari su iPhone revoca l'iscrizione del dispositivo.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Yu-Gi-Oh! Genesys', {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: d.tag || undefined,
    data: { url: d.url || './' },
  }));
});

// toccando la notifica si porta in primo piano l'app, o la si apre
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const dest = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const finestre = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const f of finestre) {
      if ('focus' in f) return f.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(dest);
  })());
});
