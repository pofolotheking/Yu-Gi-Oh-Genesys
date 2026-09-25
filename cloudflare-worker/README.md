# Worker delle notifiche

`worker.js` cifra e firma le notifiche push dell'app e le consegna ai server
di Apple, Google e Mozilla. Non salva dati: le iscrizioni dei dispositivi
stanno su Firestore, nel documento `lega/notifiche`.

## Messa online (una volta sola)

1. Su [dash.cloudflare.com](https://dash.cloudflare.com) apri **Workers & Pages → Create → Create Worker**,
   chiamalo `genesys-notifiche` e premi **Deploy**.
2. Premi **Edit code**, cancella tutto, incolla il contenuto di `worker.js` e premi **Deploy**.
3. Apri nel browser `https://genesys-notifiche.<tuo-nome>.workers.dev/genera-chiavi`.
4. Nel Worker vai su **Settings → Variables and Secrets** e crea:
   - `VAPID_PUBLIC_KEY`, tipo **Text**, con la chiave pubblica della pagina;
   - `VAPID_PRIVATE_KEY`, tipo **Secret**, con la chiave privata.

   Premi **Deploy**. Da quel momento la pagina `/genera-chiavi` si disattiva.
5. Nell'app apri **Impostazioni → Notifiche**, incolla l'indirizzo del Worker e premi **Collega**.

Ognuno poi attiva le notifiche dal proprio telefono, nella stessa schermata.
Su iPhone l'app va aperta dall'icona sulla schermata Home.

## Se le chiavi vanno rifatte

Cancella le due variabili, riapri `/genera-chiavi` e ripeti il punto 4.
Tutti dovranno poi ripremere **Attiva notifiche**.
