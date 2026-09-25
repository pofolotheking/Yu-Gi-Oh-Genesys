// Worker Cloudflare per le notifiche push della lega Yu-Gi-Oh! Genesys.
//
// L'app gli passa i dispositivi da avvisare e il testo delle notifiche; il
// Worker cifra ogni messaggio (RFC 8291) e lo firma con le chiavi VAPID
// (RFC 8292), poi lo consegna ai server push di Apple, Google e Mozilla.
// Non memorizza niente: le iscrizioni dei dispositivi stanno su Firestore.
//
// Variabili da impostare su Cloudflare (Settings -> Variables and Secrets):
//   VAPID_PUBLIC_KEY   testo    chiave pubblica generata da /genera-chiavi
//   VAPID_PRIVATE_KEY  secret   chiave privata generata da /genera-chiavi
// Facoltative:
//   ALLOWED_ORIGIN     origini ammesse separate da virgola (predefinita sotto)
//   VAPID_SUBJECT      contatto VAPID, un URL https o un indirizzo mailto:

const ORIGINE_APP = 'https://pofolotheking.github.io';
const SOGGETTO_VAPID = 'https://pofolotheking.github.io/Yu-Gi-Oh-Genesys/';
const MAX_DISPOSITIVI = 25;
const MAX_NOTIFICHE = 5;
const MAX_CARATTERI = 1500;

// si consegna solo ai server push noti, mai a indirizzi arbitrari
const HOST_PUSH = ['push.apple.com', 'fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];

export default {
  async fetch(request, env) {
    const ammesse = (env.ALLOWED_ORIGIN || ORIGINE_APP).split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin');
    const cors = {
      'Access-Control-Allow-Origin': origin && ammesse.includes(origin) ? origin : ammesse[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    try {
      if (url.pathname === '/genera-chiavi' && request.method === 'GET') return generaChiavi(env, url);

      if (url.pathname === '/chiave-pubblica' && request.method === 'GET') {
        if (!env.VAPID_PUBLIC_KEY) return json({ errore: 'Chiavi VAPID non ancora configurate' }, 503, cors);
        return json({ chiave: env.VAPID_PUBLIC_KEY }, 200, cors);
      }

      if (url.pathname === '/invia' && request.method === 'POST') {
        if (origin && !ammesse.includes(origin)) return json({ errore: 'Origine non ammessa' }, 403, cors);
        if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY)
          return json({ errore: 'Chiavi VAPID non ancora configurate' }, 503, cors);
        return json(await invia(await request.json(), env), 200, cors);
      }

      if (url.pathname === '/' && request.method === 'GET') {
        return json({ servizio: 'notifiche Genesys', configurato: !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) }, 200, cors);
      }
      return json({ errore: 'Percorso non trovato' }, 404, cors);
    } catch (e) {
      return json({ errore: String((e && e.message) || e) }, 400, cors);
    }
  },
};

// ── invio ────────────────────────────────────────────────────────────────

async function invia(richiesta, env) {
  const iscrizioni = Array.isArray(richiesta && richiesta.iscrizioni) ? richiesta.iscrizioni : [];
  const notifiche = Array.isArray(richiesta && richiesta.notifiche) ? richiesta.notifiche : [];
  if (!iscrizioni.length || !notifiche.length) throw new Error('Servono iscrizioni e notifiche');
  if (iscrizioni.length > MAX_DISPOSITIVI) throw new Error('Troppi dispositivi');
  if (notifiche.length > MAX_NOTIFICHE) throw new Error('Troppe notifiche');

  const testi = notifiche.map(n => {
    const t = JSON.stringify({
      title: String(n.title || '').slice(0, 120),
      body: String(n.body || '').slice(0, 600),
      url: typeof n.url === 'string' ? n.url.slice(0, 300) : './',
      tag: typeof n.tag === 'string' ? n.tag.slice(0, 60) : undefined,
    });
    if (t.length > MAX_CARATTERI) throw new Error('Notifica troppo lunga');
    return t;
  });

  const esito = { inviate: 0, scadute: [], errori: [] };
  const jwtPerServer = new Map();   // un token firmato per ogni server push

  for (const isc of iscrizioni) {
    let host;
    try {
      const ep = new URL(isc.endpoint);
      if (ep.protocol !== 'https:') throw new Error();
      host = ep.hostname;
      if (!HOST_PUSH.some(h => host === h || host.endsWith('.' + h))) throw new Error();
      if (!isc.keys || !isc.keys.p256dh || !isc.keys.auth) throw new Error();
    } catch {
      esito.errori.push({ id: isc.id, stato: 0, dettaglio: 'iscrizione non valida' });
      continue;
    }
    const aud = new URL(isc.endpoint).origin;
    if (!jwtPerServer.has(aud)) jwtPerServer.set(aud, await jwtVapid(aud, env));

    for (const testo of testi) {
      const corpo = await cifra(testo, isc.keys.p256dh, isc.keys.auth);
      const r = await fetch(isc.endpoint, {
        method: 'POST',
        headers: {
          'TTL': '86400',
          'Urgency': 'high',
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          'Authorization': `vapid t=${jwtPerServer.get(aud)}, k=${env.VAPID_PUBLIC_KEY}`,
        },
        body: corpo,
      });
      if (r.status === 404 || r.status === 410) {
        // il dispositivo ha revocato l'iscrizione: l'app la cancellera'
        if (!esito.scadute.includes(isc.id)) esito.scadute.push(isc.id);
        break;
      }
      if (r.ok) esito.inviate++;
      else esito.errori.push({ id: isc.id, stato: r.status, dettaglio: (await r.text()).slice(0, 200) });
    }
  }
  return esito;
}

// ── cifratura del messaggio (RFC 8291, aes128gcm) ────────────────────────

async function cifra(testo, p256dhB64, authB64) {
  const uaPublic = b64uDecode(p256dhB64);     // chiave pubblica del dispositivo, 65 byte
  const authSecret = b64uDecode(authB64);     // segreto del dispositivo, 16 byte
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const coppia = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', coppia.publicKey));
  const condiviso = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, coppia.privateKey, 256));

  const ikm = await hkdf(authSecret, condiviso, concat(enc('WebPush: info\x00'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc('Content-Encoding: aes128gcm\x00'), 16);
  const nonce = await hkdf(salt, ikm, enc('Content-Encoding: nonce\x00'), 12);

  const chiaro = concat(enc(testo), new Uint8Array([2]));   // 0x02 = ultimo record
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cifrato = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, chiaro));

  const testa = new Uint8Array(21 + asPublic.length);
  testa.set(salt, 0);
  new DataView(testa.buffer).setUint32(16, 4096);             // dimensione record
  testa[20] = asPublic.length;
  testa.set(asPublic, 21);
  return concat(testa, cifrato);
}

async function hkdf(salt, ikm, info, lunghezza) {
  const chiave = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, chiave, lunghezza * 8));
}

// ── firma VAPID (RFC 8292) ───────────────────────────────────────────────

async function jwtVapid(aud, env) {
  const pub = b64uDecode(env.VAPID_PUBLIC_KEY);
  const chiave = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE_KEY,
    x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)),
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const testa = b64uEncode(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const dati = b64uEncode(enc(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || SOGGETTO_VAPID,
  })));
  const firma = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, chiave, enc(`${testa}.${dati}`));
  return `${testa}.${dati}.${b64uEncode(new Uint8Array(firma))}`;
}

// ── generazione chiavi (solo finche' non sono configurate) ───────────────

async function generaChiavi(env, url) {
  if (env.VAPID_PRIVATE_KEY) {
    return new Response('Le chiavi sono già configurate: questa pagina è disattivata.', {
      status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  const coppia = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privata = (await crypto.subtle.exportKey('jwk', coppia.privateKey)).d;
  const pubblica = b64uEncode(new Uint8Array(await crypto.subtle.exportKey('raw', coppia.publicKey)));
  if (url.searchParams.get('json') === '1') return json({ pubblica, privata }, 200, {});

  const pagina = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chiavi notifiche</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:680px;margin:32px auto;padding:0 16px}
code{display:block;word-break:break-all;background:#f2f2f7;padding:12px;border-radius:8px;margin:6px 0 18px;font-size:14px}
b{color:#c00}</style>
<h2>Chiavi per le notifiche</h2>
<p>Crea queste due variabili nel Worker (<i>Settings &rarr; Variables and Secrets</i>), poi premi <i>Deploy</i>.</p>
<p><b>VAPID_PUBLIC_KEY</b> &mdash; tipo <i>Text</i></p><code>${pubblica}</code>
<p><b>VAPID_PRIVATE_KEY</b> &mdash; tipo <i>Secret</i></p><code>${privata}</code>
<p>Ricaricando la pagina escono chiavi nuove: copia entrambe <b>dalla stessa pagina</b>. Una volta salvate, questa pagina si disattiva da sola.</p>`;
  return new Response(pagina, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ── utilita' ─────────────────────────────────────────────────────────────

function json(dati, stato, headers) {
  return new Response(JSON.stringify(dati), { status: stato, headers: { ...headers, 'Content-Type': 'application/json' } });
}
function enc(s) { return new TextEncoder().encode(s); }
function concat(...parti) {
  const out = new Uint8Array(parti.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parti) { out.set(p, i); i += p.length; }
  return out;
}
function b64uEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(s) {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
