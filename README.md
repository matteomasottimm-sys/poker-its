# Circolo Hold'em — Poker Texas Hold'em Multiplayer

Applicazione web di **Poker Texas Hold'em No-Limit Multiplayer** in tempo reale, costruita in **HTML5, CSS3 e Vanilla JavaScript ES6+ modulare** con valuta virtuale gratuita (*Play Money / Fiches*), zero bot e sincronizzazione tramite **Firebase Realtime Database** o modalità **Locale Multi-Scheda**.

## Funzionalità Principali

- **Spin & Go (3-Handed Hyper-Turbo):** tavoli da 3 giocatori reali con estrazione animata del moltiplicatore (2x, 3x, 5x, 10x, 25x, 100x), stack iniziale 500 fiches e bui ogni 2 minuti.
- **Tornei Sit & Go e Multi-Tavolo (MTT):** creazione personalizzata di tornei **Pubblici** o **Privati** (protetti da codice invito), scelta tra 2–18 giocatori (con consolidamento automatico al Tavolo Finale), buy-in, stack iniziale, velocità bui (Lenta/Normale/Turbo) e avvio al raggiungimento iscritti o ad orario programmato con countdown.
- **Motore Poker Completo:** mazzo da 52 carte con mescolamento Fisher-Yates crittografico, valutatore preciso a 5/7 carte (dalla Carta Alta alla Scala Reale), gestione completa di Main Pot, Side Pots su All-in multipli e Split Pot.
- **Tavolo da Casinò:** panno verde ovale, mazzo a 2 o 4 colori, timer turno, slider puntate con scorciatoie (`Min`, `1/2 Pot`, `Pot`, `All-In`), scorciatoie da tastiera (`F`, `C`, `R`), audio sintetizzato Web Audio API e chat al tavolo comprimibile.

## Avvio Rapido in Locale (Test Multi-Scheda senza Firebase)

1. Avvia un server locale nella cartella del progetto:
   ```bash
   npm run dev
   ```
   *(Oppure con qualsiasi server statico compatibile con moduli ES6, es. `npx serve .` o `python3 -m http.server 3000`)*.
2. Apri `http://localhost:3000` nel browser ed entra con un nickname (es. `Marco`).
3. Apri **una o due altre schede del browser** allo stesso indirizzo ed entra con nickname diversi (es. `Luca`, `Sofia`).
4. Grazie al fallback automatico `BroadcastChannel + localStorage + Web Locks`, tutte le schede comunicano in tempo reale come giocatori distinti!

## Collegare Firebase Realtime Database (Gioco Online con gli Amici)

1. Vai su [Firebase Console](https://console.firebase.google.com/) e crea un nuovo progetto gratuito.
2. Nel menu laterale, apri **Build → Realtime Database** e clicca **Crea database** (in *Modalità test* per sviluppo rapido).
3. Vai in **Impostazioni progetto → Le tue app → Aggiungi app Web (`</>`)** e copia l'oggetto `firebaseConfig`.
4. Apri il file `firebase-config.js` e incolla i tuoi valori dentro `FIREBASE_CONFIG` (assicurandoti che `apiKey` e `databaseURL` siano compilati).
5. Ricarica l'app: il banner in lobby mostrerà **"Firebase Realtime Database connesso"** e potrai giocare online da dispositivi diversi.
