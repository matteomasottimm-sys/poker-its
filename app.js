/**
 * app.js
 * -----------------------------------------------------------------------------
 * Controller principale dell'applicazione Circolo Hold'em:
 * - Autenticazione rapida con nickname & portafoglio virtuale (Play Money)
 * - Lobby in tempo reale: Spin & Go (3-handed Hyper-Turbo) & Tornei (Pubblici/Privati)
 * - Matchmaking reale senza bot tramite Firebase RTDB o Local Multi-Tab Mock
 * - Animazione ruota moltiplicatore Spin & Go (2x - 100x)
 * - Tavolo ovale interattivo, controlli puntata, chat comprimibile e Web Audio FX
 * -----------------------------------------------------------------------------
 */

import {
  auth,
  hashInviteCode,
  isFirebaseConfigured,
  loadOrCreateUserProfile,
  rtdb,
  signInWithGoogle,
  signOutGoogle,
  subscribeAuthState,
  syncUserProfileToCloud
} from "./firebase-config.js";
import {
  BLIND_SCHEDULES,
  SPIN_MULTIPLIERS,
  applyPendingStep,
  applyPlayerAction,
  decideBotAction,
  evaluateBestHand,
  getCurrentBlindLevel,
  getLegalActions,
  parseCard,
  rollSpinMultiplier,
  startNewHand
} from "./poker-engine.js";

// ============================================================================
// COSTANTI & STATO GLOBALE
// ============================================================================
const INITIAL_BALANCE = 10000;
const TOPUP_THRESHOLD = 2000;
const TOPUP_AMOUNT = 5000;
const SPIN_TIERS = [100, 500, 1000, 2500, 5000];

const SESSION_PLAYER_KEY = "circolo_session_player_v1";
const PROFILES_STORE_KEY = "circolo_profiles_v1";
const AWARDED_TABLES_KEY = "circolo_awarded_tables_v1";
const CREATED_CODES_KEY = "circolo_created_codes_v1";

const state = {
  player: null, // { id, name, color, balance }
  lobbyTab: "spin",
  tournFilter: "all",
  fourColorDeck: false,
  audioMuted: false,

  // Sottoscrizioni Lobby
  unsubSpinQueues: null,
  unsubSpinMatches: null,
  unsubTournaments: null,
  spinQueues: {},
  tournaments: {},

  // Stato Tavolo Attivo
  activeTableId: null,
  activeTable: null,
  unsubTable: null,
  unsubChat: null,
  chatMessages: [],
  chatOpen: false,
  unreadChatCount: 0,
  lastSeenChatCount: 0,

  // Animazioni / Tracking locale
  lastPhase: null,
  lastHandNumber: 0,
  lastActionSeq: 0,
  renderedHandNumber: 0,
  renderedCommunityCount: 0,
  renderedShowdownRevealHand: 0,
  renderedPot: 0,
  renderedBets: {},
  preAction: null, // null | "checkfold" | "checkcall"
  preActionArmedBet: 0,
  spinWheelAnimatedForTable: null,
  uiTickTimer: null,
  lobbyTickTimer: null,
  actionBannerTimer: null,
  actionBannerFadeTimer: null,
  pendingStepInFlight: null,
  lastMttCheckAt: 0,

  // Gestione Bot
  botTurnTimer: null,
  botTurnKey: null,
  lastBotConfig: null
};

const BOT_PROFILES = [
  { name: "Giulia [Bot]", color: "#be123c" },
  { name: "Lorenzo [Bot]", color: "#1d4ed8" },
  { name: "Valeria [Bot]", color: "#7c3aed" },
  { name: "Matteo [Bot]", color: "#0f766e" },
  { name: "Elena [Bot]", color: "#b45309" },
  { name: "Davide [Bot]", color: "#4338ca" },
  { name: "Chiara [Bot]", color: "#0369a1" },
  { name: "Federico [Bot]", color: "#334155" }
];

// ============================================================================
// WEB AUDIO API SYNTHESIZER (Nessun file audio esterno richiesto)
// ============================================================================
class SoundFX {
  constructor() {
    this.ctx = null;
  }

  _ensureCtx() {
    if (state.audioMuted) return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  playTone(freq, duration = 0.08, type = "sine", gainVal = 0.08, delay = 0) {
    const ctx = this._ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.01);
  }

  deal(volume = 0.04) {
    this.playTone(540, 0.045, "triangle", volume);
  }

  chip() {
    this.playTone(1320, 0.055, "sine", 0.06);
    this.playTone(1760, 0.05, "sine", 0.04, 0.035);
  }

  check() {
    this.playTone(220, 0.06, "triangle", 0.07);
  }

  fold() {
    this.playTone(180, 0.09, "sine", 0.04);
  }

  turnAlert() {
    this.playTone(660, 0.09, "sine", 0.07);
    this.playTone(880, 0.12, "sine", 0.07, 0.09);
  }

  win() {
    this.playTone(523.25, 0.12, "triangle", 0.08, 0);
    this.playTone(659.25, 0.12, "triangle", 0.08, 0.1);
    this.playTone(783.99, 0.22, "triangle", 0.09, 0.2);
  }

  spinTick() {
    this.playTone(980, 0.03, "square", 0.025);
  }
}

const sfx = new SoundFX();

// ============================================================================
// UTILITY DI FORMATTAZIONE & DOM
// ============================================================================
const $ = (id) => document.getElementById(id);

function formatChips(num) {
  return new Intl.NumberFormat("it-IT").format(Math.max(0, Math.floor(num || 0)));
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showToast(message, isError = false) {
  const container = $("toast-container");
  const el = document.createElement("div");
  el.className = `toast ${isError ? "error" : ""}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 3600);
}

function openModal(id) {
  $(id)?.classList.remove("hidden");
}

function closeModal(id) {
  $(id)?.classList.add("hidden");
}

function formatCountdown(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function getAwardedTablesSet() {
  try {
    const raw = localStorage.getItem(AWARDED_TABLES_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function markTableAwarded(key) {
  const set = getAwardedTablesSet();
  set.add(key);
  localStorage.setItem(AWARDED_TABLES_KEY, JSON.stringify([...set]));
}

// ============================================================================
// GESTIONE PROFILO & PORTAFOGLIO VIRTUALE
// ============================================================================
function loadProfilesMap() {
  try {
    const raw = localStorage.getItem(PROFILES_STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveCreatedInviteCode(tournId, code) {
  try {
    const raw = localStorage.getItem(CREATED_CODES_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[tournId] = code;
    localStorage.setItem(CREATED_CODES_KEY, JSON.stringify(map));
  } catch {
    // ignore storage errors
  }
}

function getSavedCreatedCode(tournId) {
  try {
    const raw = localStorage.getItem(CREATED_CODES_KEY);
    const map = raw ? JSON.parse(raw) : {};
    return map[tournId] || "";
  } catch {
    return "";
  }
}

function savePlayerState() {
  if (!state.player) return;
  sessionStorage.setItem(SESSION_PLAYER_KEY, JSON.stringify(state.player));
  const profiles = loadProfilesMap();
  profiles[state.player.name.toLowerCase()] = {
    name: state.player.name,
    color: state.player.color,
    balance: state.player.balance
  };
  localStorage.setItem(PROFILES_STORE_KEY, JSON.stringify(profiles));
  updateWalletUI();
  syncUserProfileToCloud(state.player).catch((err) => {
    console.warn("Sincronizzazione saldo cloud non riuscita:", err);
  });
}

function adjustBalance(delta) {
  if (!state.player) return;
  state.player.balance = Math.max(0, Math.floor(state.player.balance + delta));
  savePlayerState();
}

function updateWalletUI() {
  if (!state.player) return;
  $("lobby-player-name").textContent = state.player.name;
  $("lobby-balance").textContent = formatChips(state.player.balance);
  const topupBtn = $("btn-topup");
  if (state.player.balance < TOPUP_THRESHOLD) {
    topupBtn.classList.remove("hidden");
  } else {
    topupBtn.classList.add("hidden");
  }
}

// ============================================================================
// NAVIGAZIONE SCHERMATE
// ============================================================================
function showScreen(screenId) {
  ["login-screen", "lobby-screen", "table-screen"].forEach((id) => {
    $(id).classList.toggle("hidden", id !== screenId);
  });
}

// ============================================================================
// LOGICA LOBBY & SYNC REALTIME
// ============================================================================
async function enterLobby() {
  if (!state.player || !auth.currentUser) return;
  await rtdb.init();
  $("sync-mode-title").textContent = "Multiplayer Online Cloud attivo (Firebase)";
  $("sync-mode-desc").textContent =
    "I tavoli, i tornei, i codici invito e la chat sono sincronizzati in tempo reale tra tutti i dispositivi e gli utenti online.";

  updateWalletUI();
  showScreen("lobby-screen");
  startLobbySubscriptions();
}

function startLobbySubscriptions() {
  stopLobbySubscriptions();
  if (!auth.currentUser || !state.player) return;

  // 1. Code Spin & Go
  state.unsubSpinQueues = rtdb.subscribe("spinQueues", (data) => {
    state.spinQueues = data || {};
    renderSpinTiers();
  });

  // 2. Notifica di abbinamento Spin & Go per il giocatore corrente
  state.unsubSpinMatches = rtdb.subscribe(`spinMatches/${state.player.id}`, (match) => {
    if (match && match.tableId && state.activeTableId !== match.tableId) {
      // Consuma la notifica e entra al tavolo
      rtdb.remove(`spinMatches/${state.player.id}`);
      enterTable(match.tableId);
    }
  });

  // 3. Lista Tornei
  state.unsubTournaments = rtdb.subscribe("tournaments", (data) => {
    state.tournaments = data || {};
    renderTournaments();
    checkScheduledTournaments();
    checkPlayerTournamentRedirects();
  });

  // 4. Ticker countdown tornei programmati (ogni secondo)
  state.lobbyTickTimer = setInterval(() => {
    renderTournaments();
    checkScheduledTournaments();
  }, 1000);
}

function stopLobbySubscriptions() {
  if (state.unsubSpinQueues) state.unsubSpinQueues();
  if (state.unsubSpinMatches) state.unsubSpinMatches();
  if (state.unsubTournaments) state.unsubTournaments();
  if (state.lobbyTickTimer) clearInterval(state.lobbyTickTimer);
  state.unsubSpinQueues = null;
  state.unsubSpinMatches = null;
  state.unsubTournaments = null;
  state.lobbyTickTimer = null;
}

// ============================================================================
// MODALITÀ A: SPIN & GO (3-HANDED HYPER-TURBO)
// ============================================================================
function renderSpinTiers() {
  const container = $("spin-tiers-grid");
  if (!container) return;

  container.innerHTML = SPIN_TIERS.map((buyIn) => {
    const queue = Array.isArray(state.spinQueues[String(buyIn)])
      ? state.spinQueues[String(buyIn)]
      : [];
    const isQueuedHere = queue.some((p) => p.id === state.player.id);
    const maxPrize = buyIn * 3 * 100;
    const pips = [0, 1, 2]
      .map((i) => `<span class="seat-pip ${i < queue.length ? "filled" : ""}"></span>`)
      .join("");
    const names = queue.length > 0 ? queue.map((p) => escapeHtml(p.name)).join(", ") : "Nessun giocatore in attesa";

    return `
      <article class="spin-card">
        <div class="spin-card-top">
          <span class="spin-buyin">${formatChips(buyIn)} fiches</span>
          <span class="spin-max-win">Fino a ${formatChips(maxPrize)}</span>
        </div>
        <div class="spin-meta-line">
          <span>3 Giocatori</span>
          <span aria-hidden="true">·</span>
          <span>500 fiches</span>
          <span aria-hidden="true">·</span>
          <span>Bui 2 min</span>
        </div>
        <div class="spin-seats-preview">
          <div class="seat-pips" aria-hidden="true">${pips}</div>
          <span>${queue.length}/3 al tavolo · ${names}</span>
        </div>
        ${
          isQueuedHere
            ? `<button type="button" class="btn btn-danger-ghost w-full" data-leave-spin="${buyIn}">
                 Annulla Iscrizione (${queue.length}/3)
               </button>`
            : `<button type="button" class="btn btn-gold w-full" data-join-spin="${buyIn}">
                 Iscriviti (${formatChips(buyIn)})
               </button>`
        }
      </article>
    `;
  }).join("");
}

async function joinSpinQueue(buyIn) {
  if (state.player.balance < buyIn) {
    showToast("Fiches insufficienti. Usa Ricarica Gratis o scegli un buy-in minore.", true);
    return;
  }

  // Controlla se è già in un'altra coda Spin
  for (const tier of SPIN_TIERS) {
    const q = state.spinQueues[String(tier)];
    if (Array.isArray(q) && q.some((p) => p.id === state.player.id)) {
      showToast("Sei già in attesa in una coda Spin & Go.", true);
      return;
    }
  }

  adjustBalance(-buyIn);
  let createdTableId = null;
  let matchedPlayers = null;

  const tx = await rtdb.runTransaction(`spinQueues/${buyIn}`, (current) => {
    matchedPlayers = null;
    const queue = Array.isArray(current) ? [...current] : [];
    if (queue.some((p) => p.id === state.player.id)) {
      return undefined;
    }
    queue.push({
      id: state.player.id,
      name: state.player.name,
      color: state.player.color,
      joinedAt: Date.now()
    });

    if (queue.length >= 3) {
      matchedPlayers = queue.slice(0, 3);
      return queue.slice(3); // Svuota i 3 giocatori abbinati dalla coda
    }
    return queue;
  });

  if (!tx.committed) {
    adjustBalance(buyIn);
    showToast("Impossibile accedere alla coda, riprova.", true);
    return;
  }

  if (matchedPlayers && matchedPlayers.length === 3) {
    createdTableId = `spin_${buyIn}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const multiplier = rollSpinMultiplier();
    const prizePool = buyIn * 3 * multiplier;
    const payouts =
      multiplier >= 25
        ? [
            { rank: 1, pct: 80 },
            { rank: 2, pct: 12 },
            { rank: 3, pct: 8 }
          ]
        : [{ rank: 1, pct: 100 }];

    const now = Date.now();
    const tableObj = {
      id: createdTableId,
      mode: "spin",
      title: `Spin & Go ${formatChips(buyIn)} (${multiplier}x)`,
      buyIn,
      multiplier,
      prizePool,
      payouts,
      blindSpeed: "spin",
      turnDurationMs: 25000,
      phase: "SPINNING",
      spinStartedAt: now,
      spinDurationMs: 3600,
      startedAt: now + 3600,
      handNumber: 0,
      actionSeq: 0,
      dealerIndex: -1,
      turnIndex: -1,
      pot: 0,
      communityCards: [],
      players: matchedPlayers.map((p, idx) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        seatIndex: idx,
        stack: 500,
        cards: [],
        bet: 0,
        totalBetInHand: 0,
        folded: false,
        allIn: false,
        eliminated: false,
        lastAction: ""
      }))
    };

    await rtdb.set(`tables/${createdTableId}`, tableObj);
    // Notifica tutti e 3 i giocatori
    await Promise.all(
      matchedPlayers.map((p) =>
        rtdb.set(`spinMatches/${p.id}`, { tableId: createdTableId, createdAt: now })
      )
    );
  } else {
    showToast(`In attesa di altri giocatori per Spin & Go ${formatChips(buyIn)}...`);
  }
}

async function leaveSpinQueue(buyIn) {
  let removed = false;
  await rtdb.runTransaction(`spinQueues/${buyIn}`, (current) => {
    const queue = Array.isArray(current) ? [...current] : [];
    const next = queue.filter((p) => p.id !== state.player.id);
    if (next.length !== queue.length) {
      removed = true;
      return next;
    }
    return undefined;
  });

  if (removed) {
    adjustBalance(buyIn);
    showToast("Iscrizione annullata, buy-in rimborsato.");
  }
}

// ============================================================================
// MODALITÀ B: TORNEI SIT & GO E MULTI-TAVOLO (PUBBLICI & PRIVATI)
// ============================================================================
function renderTournaments() {
  const container = $("tournaments-list");
  if (!container) return;

  const all = Object.values(state.tournaments || {}).sort(
    (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
  );

  const filtered = all.filter((t) => {
    if (t.status === "cancelled") return false;
    if (state.tournFilter === "public") return t.visibility === "public";
    if (state.tournFilter === "private") return t.visibility === "private";
    if (state.tournFilter === "mine") {
      return (t.players || []).some((p) => p.id === state.player.id) || t.creatorId === state.player.id;
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state-box">
        Nessun torneo attivo in questa categoria. Clicca "+ Crea Torneo" per avviarne uno nuovo.
      </div>
    `;
    return;
  }

  const now = Date.now();
  container.innerHTML = filtered
    .map((t) => {
      const players = t.players || [];
      const isRegistered = players.some((p) => p.id === state.player.id);
      const speedLabel =
        t.blindSpeed === "turbo"
          ? "Turbo (1m)"
          : t.blindSpeed === "slow"
          ? "Lenta (5m)"
          : "Normale (3m)";
      const isPrivate = t.visibility === "private";
      const prizePool = (t.buyIn || 0) * Math.max(players.length, t.maxPlayers);

      let statusText = `${players.length}/${t.maxPlayers} iscritti`;
      if (t.status === "registering" && t.startMode === "scheduled") {
        const rem = Math.max(0, (t.scheduledStartAt || now) - now);
        statusText = `Parte tra ${formatCountdown(rem)} · ${players.length}/${t.maxPlayers}`;
      } else if (t.status === "running") {
        statusText = `In corso · ${players.length} giocatori`;
      } else if (t.status === "finished") {
        statusText = `Concluso · Vincitore: ${escapeHtml(t.winnerName || "—")}`;
      }

      let actionHtml = "";
      if (t.status === "registering") {
        if (isRegistered) {
          actionHtml = `
            <button type="button" class="btn btn-danger-ghost btn-sm" data-unregister-tourn="${t.id}">
              Disiscriviti
            </button>
          `;
        } else if (players.length < t.maxPlayers) {
          actionHtml = `
            <button type="button" class="btn btn-gold btn-sm" data-register-tourn="${t.id}">
              ${isPrivate ? "Inserisci Codice" : `Iscriviti (${t.buyIn > 0 ? formatChips(t.buyIn) : "Gratis"})`}
            </button>
          `;
        } else {
          actionHtml = `<span class="tourn-stat-val">Completo</span>`;
        }
      } else if (t.status === "running" && isRegistered) {
        actionHtml = `
          <button type="button" class="btn btn-gold btn-sm" data-enter-tourn="${t.id}">
            Entra al Tavolo
          </button>
        `;
      }

      const visibleCode =
        t.inviteCode || (t.creatorId === state.player.id ? getSavedCreatedCode(t.id) : "");
      const canSeeCode = Boolean(visibleCode) && (!isPrivate || t.creatorId === state.player.id);
      const codeHint = canSeeCode
        ? `<span>Codice: <strong class="tabular-nums">${escapeHtml(visibleCode)}</strong> <button type="button" class="btn-copy-inline" data-copy-code="${escapeHtml(visibleCode)}">Copia</button></span>`
        : "";

      return `
        <article class="tourn-card">
          <div class="tourn-card-header">
            <div>
              <h3 class="tourn-title">${escapeHtml(t.name)}</h3>
              <div class="tourn-meta-row">
                <span>${isPrivate ? "Privato" : "Pubblico"}</span>
                <span aria-hidden="true">·</span>
                <span>${t.maxPlayers > 9 ? "Multi-Tavolo" : "Sit & Go"}</span>
                <span aria-hidden="true">·</span>
                <span>${speedLabel}</span>
                ${codeHint ? `<span aria-hidden="true">·</span>${codeHint}` : ""}
              </div>
            </div>
          </div>

          <div class="tourn-stats-grid">
            <div class="tourn-stat">
              <span class="tourn-stat-label">Buy-in</span>
              <span class="tourn-stat-val tabular-nums">${t.buyIn > 0 ? formatChips(t.buyIn) : "Freeroll"}</span>
            </div>
            <div class="tourn-stat">
              <span class="tourn-stat-label">Stack Iniziale</span>
              <span class="tourn-stat-val tabular-nums">${formatChips(t.startingStack)}</span>
            </div>
            <div class="tourn-stat">
              <span class="tourn-stat-label">Montepremi</span>
              <span class="tourn-stat-val tabular-nums gold-text">${formatChips(prizePool)}</span>
            </div>
          </div>

          <div class="tourn-card-footer">
            <span class="tourn-meta-row tabular-nums">${statusText}</span>
            <div>${actionHtml}</div>
          </div>
        </article>
      `;
    })
    .join("");
}

function generateInviteCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

async function copyTextWithFeedback(text, label = "Codice") {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copiato negli appunti: ${text}`);
    return true;
  } catch {
    showToast(`${label}: ${text}`);
    return false;
  }
}

async function createTournament(formValues) {
  if (state.player.balance < formValues.buyIn) {
    showToast("Fiches insufficienti per il buy-in di questo torneo.", true);
    return;
  }

  const cleanManualCode = (formValues.inviteCode || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();

  if (cleanManualCode) {
    if (cleanManualCode.length < 2 || cleanManualCode.length > 16 || !/^[A-Z0-9_-]+$/.test(cleanManualCode)) {
      showToast("Il codice invito deve avere 2-16 caratteri alfanumerici (lettere, numeri, _ o -).", true);
      return;
    }
    const taken = await rtdb.isInviteCodeTaken(cleanManualCode);
    if (taken) {
      showToast("Questo codice invito è già in uso, scegline un altro.", true);
      return;
    }
  }

  let inviteCode = cleanManualCode || generateInviteCode(6);
  if (!cleanManualCode) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const taken = await rtdb.isInviteCodeTaken(inviteCode);
      if (!taken) break;
      inviteCode = generateInviteCode(6);
    }
  }

  const now = Date.now();
  const id = `trn_${now}_${Math.random().toString(36).slice(2, 7)}`;
  const inviteCodeHash = await hashInviteCode(id, inviteCode);

  const scheduledStartAt =
    formValues.startMode === "scheduled"
      ? now + formValues.delayMinutes * 60 * 1000
      : null;

  const isPrivate = formValues.visibility === "private";
  const tournament = {
    id,
    name: formValues.name,
    visibility: formValues.visibility,
    inviteCode: isPrivate ? "" : inviteCode,
    inviteCodeHash,
    maxPlayers: formValues.maxPlayers,
    buyIn: formValues.buyIn,
    startingStack: formValues.startingStack,
    blindSpeed: formValues.blindSpeed,
    startMode: formValues.startMode,
    scheduledStartAt,
    startedAt: null,
    cancelledAt: null,
    status: "registering",
    creatorId: state.player.id,
    createdAtMs: now,
    createdAt: now,
    players: [
      {
        id: state.player.id,
        name: state.player.name,
        color: state.player.color
      }
    ],
    playerIds: [state.player.id],
    tableIds: [],
    finalTableId: "",
    winnerName: ""
  };

  adjustBalance(-formValues.buyIn);
  try {
    await rtdb.set(`tournaments/${id}`, tournament);
    await rtdb.registerInviteCode(inviteCode, id, formValues.visibility);
  } catch (err) {
    adjustBalance(formValues.buyIn);
    showToast("Errore durante la creazione del torneo. Riprova.", true);
    throw err;
  }

  saveCreatedInviteCode(id, inviteCode);
  closeModal("create-tournament-modal");

  $("tourn-name").value = "";
  $("tourn-invite-code").value = "";

  // Mostra modale di conferma con il codice pronto da copiare
  $("tourn-created-subtitle").textContent = `"${tournament.name}" (${isPrivate ? "Privato" : "Pubblico"} · ${tournament.maxPlayers} giocatori)`;
  $("tourn-created-code").textContent = inviteCode;
  $("tourn-created-hint").textContent = isPrivate
    ? 'Torneo privato protetto: gli altri giocatori dovranno inserire questo codice dal pulsante "Unisciti con Codice".'
    : 'Puoi condividere questo codice con i tuoi amici per farli entrare rapidamente tramite "Unisciti con Codice".';
  $("btn-copy-created-code").textContent = "Copia Codice";
  openModal("tournament-created-modal");

  showToast(`Torneo creato! Codice: ${inviteCode}`);
}

async function registerForTournament(tournId, providedCode = null) {
  let t = state.tournaments[tournId];
  if (!t) {
    t = await rtdb.get(`tournaments/${tournId}`);
    if (t) state.tournaments[tournId] = t;
  }
  if (!t) {
    showToast("Torneo non trovato o non più disponibile.", true);
    return;
  }

  if (t.status === "running") {
    if ((t.players || []).some((p) => p.id === state.player.id)) {
      closeModal("join-code-modal");
      await openTournamentTableForPlayer(t);
    } else {
      showToast("Questo torneo è già iniziato.", true);
    }
    return;
  }

  if (t.status !== "registering") {
    showToast("Questo torneo non accetta più iscrizioni.", true);
    return;
  }

  if ((t.players || []).some((p) => p.id === state.player.id)) {
    closeModal("join-code-modal");
    showToast(`Sei già iscritto a "${t.name}".`);
    return;
  }

  const normalizedProvided = (providedCode || "").trim().replace(/\s+/g, "").toUpperCase();

  if (t.visibility === "private" && !normalizedProvided) {
    openModal("join-code-modal");
    $("join-code-form").dataset.targetTournId = tournId;
    $("private-code-input").value = "";
    $("private-code-input").focus();
    return;
  }

  if (t.visibility === "private") {
    const providedHash = await hashInviteCode(t.id, normalizedProvided);
    const legacyMatch =
      t.inviteCode &&
      String(t.inviteCode).trim().replace(/\s+/g, "").toUpperCase() === normalizedProvided;
    if (!legacyMatch && providedHash !== t.inviteCodeHash) {
      showToast("Codice invito non valido.", true);
      return;
    }
    try {
      await rtdb.ensureTournamentEntryPass(t.id, normalizedProvided);
    } catch {
      showToast("Codice invito non valido o non verificato.", true);
      return;
    }
  }

  if (state.player.balance < t.buyIn) {
    showToast("Fiches insufficienti per iscriverti a questo torneo.", true);
    return;
  }

  adjustBalance(-t.buyIn);
  let shouldStartNow = false;
  let alreadyIn = false;

  const tx = await rtdb.runTransaction(`tournaments/${tournId}`, (curr) => {
    shouldStartNow = false;
    alreadyIn = false;
    if (!curr || curr.status !== "registering") return undefined;
    const list = curr.players || [];
    if (list.some((p) => p.id === state.player.id)) {
      alreadyIn = true;
      return undefined;
    }
    if (list.length >= curr.maxPlayers) return undefined;

    list.push({
      id: state.player.id,
      name: state.player.name,
      color: state.player.color
    });
    curr.players = list;
    curr.playerIds = list.map((p) => p.id);

    if (curr.startMode === "full" && list.length >= curr.maxPlayers) {
      shouldStartNow = true;
    }
    return curr;
  });

  if (!tx.committed) {
    adjustBalance(t.buyIn);
    if (alreadyIn) {
      closeModal("join-code-modal");
      showToast(`Sei già iscritto a "${t.name}".`);
    } else {
      showToast("Iscrizione non riuscita (torneo pieno o già avviato).", true);
    }
    return;
  }

  closeModal("join-code-modal");
  showToast(`Iscritto a "${t.name}".`);

  if (shouldStartNow) {
    await tryStartTournament(tournId);
  }
}

async function unregisterFromTournament(tournId) {
  const t = state.tournaments[tournId];
  if (!t || t.status !== "registering") return;

  let removed = false;
  await rtdb.runTransaction(`tournaments/${tournId}`, (curr) => {
    if (!curr || curr.status !== "registering") return undefined;
    const prevLen = (curr.players || []).length;
    curr.players = (curr.players || []).filter((p) => p.id !== state.player.id);
    if (curr.players.length < prevLen) {
      removed = true;
      return curr;
    }
    return undefined;
  });

  if (removed) {
    adjustBalance(t.buyIn);
    showToast("Disiscrizione completata, buy-in rimborsato.");
  }
}

async function checkScheduledTournaments() {
  const now = Date.now();
  for (const t of Object.values(state.tournaments || {})) {
    if (
      t.status === "registering" &&
      t.startMode === "scheduled" &&
      t.scheduledStartAt &&
      now >= t.scheduledStartAt
    ) {
      await tryStartTournament(t.id);
    }
  }
}

async function tryStartTournament(tournId) {
  const now = Date.now();
  let startedTourn = null;

  const tx = await rtdb.runTransaction(`tournaments/${tournId}`, (curr) => {
    if (!curr || curr.status !== "registering") return undefined;
    const players = curr.players || [];

    if (players.length < 2) {
      curr.status = "cancelled";
      curr.cancelledAt = now;
      return curr;
    }

    curr.status = "running";
    curr.startedAt = now;

    // Suddivide in 1 tavolo (<= 9) o 2 tavoli (> 9)
    const tableCount = players.length > 9 ? 2 : 1;
    const tableIds = [];
    for (let i = 1; i <= tableCount; i++) {
      tableIds.push(`${tournId}_t${i}`);
    }
    curr.tableIds = tableIds;
    startedTourn = JSON.parse(JSON.stringify(curr));
    return curr;
  });

  if (!tx.committed) return;

  if (tx.value.status === "cancelled") {
    // Rimborsa eventuali giocatori se cancellato per mancanza iscritti
    const me = (tx.value.players || []).find((p) => p.id === state.player.id);
    if (me && !getAwardedTablesSet().has(`refund_${tournId}`)) {
      markTableAwarded(`refund_${tournId}`);
      adjustBalance(tx.value.buyIn);
      showToast(`Torneo "${tx.value.name}" annullato (< 2 giocatori). Buy-in rimborsato.`);
    }
    return;
  }

  if (startedTourn) {
    const players = startedTourn.players;
    const tableCount = startedTourn.tableIds.length;
    const buckets = Array.from({ length: tableCount }, () => []);
    players.forEach((p, idx) => {
      buckets[idx % tableCount].push(p);
    });

    const totalPrizePool = startedTourn.buyIn * players.length;
    const payouts =
      players.length >= 9
        ? [
            { rank: 1, pct: 50 },
            { rank: 2, pct: 30 },
            { rank: 3, pct: 20 }
          ]
        : players.length >= 5
        ? [
            { rank: 1, pct: 70 },
            { rank: 2, pct: 30 }
          ]
        : [{ rank: 1, pct: 100 }];

    for (let ti = 0; ti < tableCount; ti++) {
      const tid = startedTourn.tableIds[ti];
      const baseTable = {
        id: tid,
        tournamentId: tournId,
        mode: "tournament",
        isMultiTablePart: tableCount > 1,
        title:
          tableCount > 1
            ? `${startedTourn.name} · Tavolo ${ti + 1}`
            : startedTourn.name,
        buyIn: startedTourn.buyIn,
        prizePool: totalPrizePool,
        payouts,
        blindSpeed: startedTourn.blindSpeed,
        turnDurationMs: 30000,
        startedAt: now,
        handNumber: 0,
        actionSeq: 0,
        dealerIndex: -1,
        players: buckets[ti].map((p, seatIdx) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          seatIndex: seatIdx,
          stack: startedTourn.startingStack,
          cards: [],
          bet: 0,
          totalBetInHand: 0,
          folded: false,
          allIn: false,
          eliminated: false,
          lastAction: ""
        }))
      };
      const dealt = startNewHand(baseTable, now);
      await rtdb.set(`tables/${tid}`, dealt);
    }
  }
}

async function checkPlayerTournamentRedirects() {
  if (state.activeTableId) return;
  for (const t of Object.values(state.tournaments || {})) {
    if (t.status === "cancelled") {
      const me = (t.players || []).find((p) => p.id === state.player.id);
      if (me && !getAwardedTablesSet().has(`refund_${t.id}`)) {
        markTableAwarded(`refund_${t.id}`);
        adjustBalance(t.buyIn);
        showToast(`Torneo "${t.name}" annullato (< 2 giocatori). Buy-in rimborsato.`);
      }
    }
    if (
      t.status === "running" &&
      (t.players || []).some((p) => p.id === state.player.id) &&
      !getAwardedTablesSet().has(`autoentered_${t.id}`)
    ) {
      await openTournamentTableForPlayer(t);
      break;
    }
  }
}

async function openTournamentTableForPlayer(tourn) {
  const tableIds = tourn.finalTableId ? [tourn.finalTableId] : tourn.tableIds || [];
  for (const tid of tableIds) {
    const tbl = await rtdb.get(`tables/${tid}`);
    if (tbl && (tbl.players || []).some((p) => p.id === state.player.id && !p.eliminated)) {
      markTableAwarded(`autoentered_${tourn.id}`);
      enterTable(tid);
      return;
    }
  }
  // Se eliminato, apri comunque il primo tavolo per seguire o vedere il risultato
  if (tableIds.length > 0) {
    markTableAwarded(`autoentered_${tourn.id}`);
    enterTable(tableIds[0]);
  }
}

// ============================================================================
// MODALITÀ C: TAVOLO CONTRO BOT
// ============================================================================
async function startBotTable(config) {
  const buyIn = Math.max(0, Number(config.buyIn) || 0);
  if (buyIn > 0 && state.player.balance < buyIn) {
    showToast("Fiches insufficienti per questo buy-in. Usa Ricarica Gratis o gioca gratis.", true);
    return;
  }

  state.lastBotConfig = { ...config };
  if (buyIn > 0) {
    adjustBalance(-buyIn);
  }

  const botCount = Math.max(1, Math.min(8, Number(config.botCount) || 5));
  const totalPlayers = botCount + 1;
  const startingStack = Number(config.startingStack) || 3000;
  const blindSpeed = config.blindSpeed || "normal";
  const styleChoice = config.style || "mixed";
  const stylesPool = ["tight", "balanced", "aggressive"];

  const shuffledBots = [...BOT_PROFILES].sort(() => Math.random() - 0.5).slice(0, botCount);
  const players = [
    {
      id: state.player.id,
      name: state.player.name,
      color: state.player.color,
      isBot: false,
      seatIndex: 0,
      stack: startingStack,
      cards: [],
      bet: 0,
      totalBetInHand: 0,
      folded: false,
      allIn: false,
      eliminated: false,
      lastAction: ""
    },
    ...shuffledBots.map((b, i) => ({
      id: `bot_${i + 1}_${Math.random().toString(36).slice(2, 6)}`,
      name: b.name,
      color: b.color,
      isBot: true,
      botStyle: styleChoice === "mixed" ? stylesPool[i % stylesPool.length] : styleChoice,
      seatIndex: i + 1,
      stack: startingStack,
      cards: [],
      bet: 0,
      totalBetInHand: 0,
      folded: false,
      allIn: false,
      eliminated: false,
      lastAction: ""
    }))
  ];

  const prizePool = buyIn * totalPlayers;
  const payouts =
    totalPlayers >= 9
      ? [
          { rank: 1, pct: 50 },
          { rank: 2, pct: 30 },
          { rank: 3, pct: 20 }
        ]
      : totalPlayers >= 5
      ? [
          { rank: 1, pct: 70 },
          { rank: 2, pct: 30 }
        ]
      : [{ rank: 1, pct: 100 }];

  const now = Date.now();
  const tableId = `bots_${now}_${Math.random().toString(36).slice(2, 6)}`;
  const baseTable = {
    id: tableId,
    mode: "bots",
    ownerId: state.player.id,
    title: config.title || `Tavolo vs ${botCount} Bot`,
    buyIn,
    prizePool,
    payouts,
    blindSpeed,
    turnDurationMs: 30000,
    startedAt: now,
    handNumber: 0,
    actionSeq: 0,
    dealerIndex: -1,
    players
  };

  const dealt = startNewHand(baseTable, now);
  await rtdb.set(`tables/${tableId}`, dealt);
  enterTable(tableId);
}

function scheduleBotTurnIfNeeded(table) {
  if (!table || table.mode !== "bots" || table.ownerId !== state.player.id) return;
  if (!["PREFLOP", "FLOP", "TURN", "RIVER"].includes(table.phase)) return;
  if (table.turnIndex < 0) return;

  const activePlayer = table.players[table.turnIndex];
  if (!activePlayer || !activePlayer.isBot) return;

  const turnKey = `${table.id}_${table.handNumber}_${table.actionSeq}_${table.turnIndex}`;
  if (state.botTurnKey === turnKey) return;
  state.botTurnKey = turnKey;

  if (state.botTurnTimer) {
    clearTimeout(state.botTurnTimer);
  }

  // Ritmo naturale e leggibile: attesa extra quando il dealer sta ancora distribuendo carte
  let extraDealMs = 0;
  if ((table.actionSeq || 0) <= 1 && table.phase === "PREFLOP") {
    const activePlayers = (table.players || []).filter((p) => !p.eliminated && p.cards?.length === 2).length;
    extraDealMs = activePlayers * 150 + 400;
  } else if (table.lastActionText === "Flop servito") {
    extraDealMs = 700;
  } else if (table.lastActionText === "Turn servito" || table.lastActionText === "River servito") {
    extraDealMs = 480;
  }

  const thinkMs = 1150 + Math.floor(Math.random() * 700) + extraDealMs;
  state.botTurnTimer = setTimeout(async () => {
    state.botTurnTimer = null;
    const latest = state.activeTable;
    if (!latest || latest.id !== table.id || latest.actionSeq !== table.actionSeq) return;
    const bot = latest.players[latest.turnIndex];
    if (!bot || !bot.isBot) return;

    const decision = decideBotAction(latest, bot);
    await rtdb.runTransaction(`tables/${latest.id}`, (curr) => {
      if (!curr || curr.actionSeq !== latest.actionSeq) return undefined;
      const p = curr.players[curr.turnIndex];
      if (!p || p.id !== bot.id) return undefined;
      return applyPlayerAction(curr, bot.id, decision.actionType, decision.raiseToAmount, Date.now());
    });
  }, thinkMs);
}

function schedulePreActionIfNeeded(table) {
  if (!state.preAction || !table || table.turnIndex < 0) return;
  const active = table.players[table.turnIndex];
  if (!active || active.id !== state.player.id) return;

  const legal = getLegalActions(table, state.player.id);
  if (!legal) return;

  const chosen = state.preAction;
  const armedBet = state.preActionArmedBet || 0;
  state.preAction = null;
  state.preActionArmedBet = 0;

  if (chosen === "checkfold") {
    const act = legal.canCheck ? "check" : "fold";
    setTimeout(() => submitAction(act), 550);
  } else if (chosen === "checkcall") {
    if (legal.canCheck) {
      setTimeout(() => submitAction("check"), 550);
    } else if ((table.currentBet || 0) <= armedBet) {
      setTimeout(() => submitAction("call"), 550);
    }
    // Se qualcuno ha rilanciato sopra l'importo previsto, annulla la pre-azione per sicurezza
  }
}

// ============================================================================
// GESTIONE TAVOLO DA GIOCO & MULTI-TAVOLO CONSOLIDAMENTO
// ============================================================================
function enterTable(tableId) {
  stopLobbySubscriptions();
  leaveTableSubscriptionsOnly();

  closeModal("create-tournament-modal");
  closeModal("tournament-created-modal");
  closeModal("join-code-modal");
  closeModal("hands-guide-modal");

  state.activeTableId = tableId;
  state.lastPhase = null;
  state.lastHandNumber = 0;
  state.lastActionSeq = 0;
  state.renderedHandNumber = 0;
  state.renderedCommunityCount = 0;
  state.renderedShowdownRevealHand = 0;
  state.renderedPot = 0;
  state.renderedBets = {};
  state.pendingStepInFlight = null;
  state.lastMttCheckAt = 0;
  state.preAction = null;
  state.preActionArmedBet = 0;
  state.spinWheelAnimatedForTable = null;
  state.botTurnKey = null;
  state.chatMessages = [];
  state.unreadChatCount = 0;
  state.lastSeenChatCount = 0;
  $("chat-unread-count").classList.add("hidden");
  $("tournament-over-overlay").classList.add("hidden");
  $("spin-wheel-overlay").classList.add("hidden");
  $("action-flash-banner").classList.add("hidden");

  showScreen("table-screen");

  state.unsubTable = rtdb.subscribe(`tables/${tableId}`, (table) => {
    if (!table) return;
    handleTableSnapshot(table);
  });

  state.unsubChat = rtdb.subscribe(`chats/${tableId}`, (chatObj) => {
    const msgs = chatObj
      ? Object.values(chatObj).sort((a, b) => (a.ts || 0) - (b.ts || 0))
      : [];
    state.chatMessages = msgs;
    renderChat();
  });

  state.uiTickTimer = setInterval(onTableTick, 150);
}

function leaveTableSubscriptionsOnly() {
  if (state.unsubTable) state.unsubTable();
  if (state.unsubChat) state.unsubChat();
  if (state.uiTickTimer) clearInterval(state.uiTickTimer);
  if (state.botTurnTimer) clearTimeout(state.botTurnTimer);
  if (state.actionBannerTimer) clearTimeout(state.actionBannerTimer);
  if (state.actionBannerFadeTimer) clearTimeout(state.actionBannerFadeTimer);
  state.unsubTable = null;
  state.unsubChat = null;
  state.uiTickTimer = null;
  state.botTurnTimer = null;
  state.actionBannerTimer = null;
  state.actionBannerFadeTimer = null;
  state.botTurnKey = null;
  state.pendingStepInFlight = null;
}

function leaveTableToLobby() {
  leaveTableSubscriptionsOnly();
  state.activeTableId = null;
  state.activeTable = null;
  enterLobby();
}

function showActionFlashBanner(text, table) {
  const banner = $("action-flash-banner");
  if (!banner || !text) return;

  const lower = text.toLowerCase();
  let kind = "call";
  if (table?.phase === "SHOWDOWN" || lower.includes("vince") || lower.includes("showdown")) {
    kind = "win";
  } else if (lower.includes("all-in")) {
    kind = "allin";
  } else if (lower.includes("rilancia") || lower.includes("punta")) {
    kind = "raise";
  } else if (lower.includes("passa") || lower.includes("fold")) {
    kind = "fold";
  } else if (lower.includes("check")) {
    kind = "check";
  }

  if (state.actionBannerTimer) {
    clearTimeout(state.actionBannerTimer);
    state.actionBannerTimer = null;
  }
  if (state.actionBannerFadeTimer) {
    clearTimeout(state.actionBannerFadeTimer);
    state.actionBannerFadeTimer = null;
  }

  banner.className = `action-flash-banner kind-${kind}`;
  banner.textContent = text;
  // Riavvia animazione pop-in in modo pulito
  void banner.offsetWidth;

  state.actionBannerTimer = setTimeout(() => {
    banner.classList.add("is-fading");
    state.actionBannerTimer = null;
    state.actionBannerFadeTimer = setTimeout(() => {
      banner.classList.add("hidden");
      banner.classList.remove("is-fading");
      state.actionBannerFadeTimer = null;
    }, 280);
  }, 2200);
}

function handleTableSnapshot(table) {
  const prev = state.activeTable;
  state.activeTable = table;

  // Controllo effetti sonori & banner momentaneo su cambio stato
  if (prev) {
    if (table.handNumber !== prev.handNumber && table.phase === "PREFLOP") {
      // I suoni di distribuzione scaglionati partono da animateDealtCardsAndChips()
    } else if (table.phase !== prev.phase && ["FLOP", "TURN", "RIVER"].includes(table.phase)) {
      if (table.lastActionText) {
        showActionFlashBanner(table.lastActionText, table);
      }
    } else if (table.actionSeq !== prev.actionSeq && table.lastActionText) {
      if (table.lastActionText.includes("Check")) sfx.check();
      else if (table.lastActionText.includes("passa")) sfx.fold();
      else if (table.phase === "SHOWDOWN") sfx.win();
      else sfx.chip();

      showActionFlashBanner(table.lastActionText, table);
    }
  }

  // Avviso sonoro quando tocca a noi
  const activePlayer = table.turnIndex >= 0 ? table.players[table.turnIndex] : null;
  const prevActive = prev && prev.turnIndex >= 0 ? prev.players[prev.turnIndex] : null;
  if (
    activePlayer &&
    activePlayer.id === state.player.id &&
    (!prevActive || prevActive.id !== state.player.id || table.actionSeq !== prev.actionSeq)
  ) {
    sfx.turnAlert();
  }

  // Animazione Ruota Spin & Go
  if (table.phase === "SPINNING" && state.spinWheelAnimatedForTable !== table.id) {
    state.spinWheelAnimatedForTable = table.id;
    runSpinWheelAnimation(table);
  } else if (table.phase !== "SPINNING") {
    $("spin-wheel-overlay").classList.add("hidden");
  }

  // Consolidamento Multi-Tavolo se tavolo MTT completo
  if (table.isMultiTablePart && table.tableComplete && table.tournamentId) {
    tryConsolidateMultiTable(table.tournamentId);
  }

  // Reset pre-azioni a cambio mano o se si chiude la mano
  if (prev && (table.handNumber !== prev.handNumber || !["PREFLOP", "FLOP", "TURN", "RIVER"].includes(table.phase))) {
    state.preAction = null;
    state.preActionArmedBet = 0;
  }

  // Fine Torneo / Spin & Go / Bot Table -> accredita premi o mostra esito se umano eliminato
  const humanMe = (table.players || []).find((p) => p.id === state.player.id);
  if (table.phase === "TOURNAMENT_OVER" || (table.mode === "bots" && humanMe?.eliminated && table.phase === "SHOWDOWN")) {
    handleTournamentOver(table, table.phase !== "TOURNAMENT_OVER");
  } else {
    scheduleBotTurnIfNeeded(table);
    schedulePreActionIfNeeded(table);
  }

  renderTable();
}

async function tryConsolidateMultiTable(tournamentId) {
  const tourn = await rtdb.get(`tournaments/${tournamentId}`);
  if (!tourn || tourn.finalTableId) return;

  const tables = await Promise.all((tourn.tableIds || []).map((id) => rtdb.get(`tables/${id}`)));
  const validTables = tables.filter(Boolean);
  const allSurvivors = [];
  for (const tbl of validTables) {
    for (const p of tbl.players || []) {
      if (!p.eliminated && p.stack > 0) {
        allSurvivors.push(p);
      }
    }
  }

  // Consolida quando tutti i superstiti entrano in un singolo tavolo (<= 9) e almeno un tavolo è concluso
  const anyTableDone = validTables.some((t) => t.tableComplete);
  if (!anyTableDone || allSurvivors.length > 9 || allSurvivors.length < 2) return;

  const finalId = `${tournamentId}_final`;
  const tx = await rtdb.runTransaction(`tournaments/${tournamentId}`, (curr) => {
    if (!curr || curr.finalTableId) return undefined;
    curr.finalTableId = finalId;
    return curr;
  });

  if (!tx.committed) return;

  const now = Date.now();
  const baseFinal = {
    id: finalId,
    tournamentId,
    mode: "tournament",
    isMultiTablePart: false,
    title: `${tourn.name} · Tavolo Finale`,
    buyIn: tourn.buyIn,
    prizePool: tourn.buyIn * (tourn.players || []).length,
    payouts: validTables[0].payouts,
    blindSpeed: tourn.blindSpeed,
    turnDurationMs: 30000,
    startedAt: tourn.startedAt || now,
    handNumber: 0,
    actionSeq: 0,
    dealerIndex: -1,
    players: allSurvivors.map((p, idx) => ({
      ...p,
      seatIndex: idx,
      cards: [],
      bet: 0,
      totalBetInHand: 0,
      folded: false,
      allIn: false,
      lastAction: ""
    }))
  };

  await rtdb.set(`tables/${finalId}`, startNewHand(baseFinal, now));

  // Redirect per chi sta ancora guardando un tavolo secondario
  if (state.activeTable && state.activeTable.tournamentId === tournamentId) {
    enterTable(finalId);
  }
}

async function onTableTick() {
  const table = state.activeTable;
  if (!table) return;
  const now = Date.now();

  // 1. Aggiorna barra timer turno in DOM
  if (table.turnIndex >= 0 && table.turnDeadline) {
    const duration = table.turnDurationMs || 30000;
    const pct = Math.max(0, Math.min(100, ((table.turnDeadline - now) / duration) * 100));
    const fill = document.querySelector(".seat-node.is-turn .seat-timer-fill");
    if (fill) {
      fill.style.width = `${pct}%`;
    }
  }

  // 2. Aggiorna timer bui nell'HUD
  if (table.startedAt) {
    const blindInfo = getCurrentBlindLevel(table.blindSpeed, table.startedAt, now);
    $("hud-blinds").textContent = `${blindInfo.sb} / ${blindInfo.bb}`;
    $("hud-blind-timer").textContent = blindInfo.isMaxLevel
      ? "MAX"
      : formatCountdown(blindInfo.nextLevelAt - now);
  }

  // 3. Controlla redirect verso Final Table MTT se creata (throttled a 1s)
  if (table.isMultiTablePart && table.tournamentId && now - (state.lastMttCheckAt || 0) > 1000) {
    state.lastMttCheckAt = now;
    const tourn = await rtdb.get(`tournaments/${table.tournamentId}`);
    if (tourn && tourn.finalTableId && state.activeTableId !== tourn.finalTableId) {
      enterTable(tourn.finalTableId);
      return;
    }
  }

  // 4. Transizione pianificata tra street, runout All-In o Showdown
  if (
    table.pendingStep &&
    now >= table.pendingStep.executeAt &&
    state.pendingStepInFlight !== table.actionSeq
  ) {
    const seqSnapshot = table.actionSeq;
    state.pendingStepInFlight = seqSnapshot;
    try {
      await rtdb.runTransaction(`tables/${table.id}`, (curr) => {
        if (!curr || curr.actionSeq !== seqSnapshot || !curr.pendingStep) return undefined;
        if (Date.now() < curr.pendingStep.executeAt) return undefined;
        return applyPendingStep(curr, Date.now());
      });
    } finally {
      if (state.pendingStepInFlight === seqSnapshot) {
        state.pendingStepInFlight = null;
      }
    }
    return;
  }

  // 5. Transizione automatica da SPINNING -> PREFLOP (Mano #1)
  if (table.phase === "SPINNING" && now >= table.spinStartedAt + table.spinDurationMs) {
    await rtdb.runTransaction(`tables/${table.id}`, (curr) => {
      if (!curr || curr.phase !== "SPINNING") return undefined;
      return startNewHand(curr, Date.now());
    });
    return;
  }

  // 6. Transizione automatica da SHOWDOWN -> Mano successiva
  if (table.phase === "SHOWDOWN" && table.nextHandAt && now >= table.nextHandAt) {
    const humanMe = (table.players || []).find((p) => p.id === state.player.id);
    if (table.mode === "bots" && humanMe?.eliminated) {
      return;
    }
    await rtdb.runTransaction(`tables/${table.id}`, (curr) => {
      if (!curr || curr.phase !== "SHOWDOWN") return undefined;
      if (Date.now() < (curr.nextHandAt || 0)) return undefined;
      return startNewHand(curr, Date.now());
    });
    return;
  }

  // 6. Timeout turno automatico (check se possibile, altrimenti fold)
  if (
    ["PREFLOP", "FLOP", "TURN", "RIVER"].includes(table.phase) &&
    table.turnIndex >= 0 &&
    table.turnDeadline &&
    now > table.turnDeadline + 700
  ) {
    const timedOutPlayer = table.players[table.turnIndex];
    if (!timedOutPlayer) return;
    const seqSnapshot = table.actionSeq;

    await rtdb.runTransaction(`tables/${table.id}`, (curr) => {
      if (!curr || curr.actionSeq !== seqSnapshot || curr.turnIndex < 0) return undefined;
      if (Date.now() <= (curr.turnDeadline || 0)) return undefined;
      const p = curr.players[curr.turnIndex];
      if (!p) return undefined;
      const legal = getLegalActions(curr, p.id);
      const autoAction = legal && legal.canCheck ? "check" : "fold";
      return applyPlayerAction(curr, p.id, autoAction, 0, Date.now());
    });
  }
}

// ============================================================================
// ANIMAZIONE MOLTIPLICATORE SPIN & GO
// ============================================================================
function runSpinWheelAnimation(table) {
  const overlay = $("spin-wheel-overlay");
  const strip = $("spin-reel-strip");
  const summary = $("spin-result-summary");
  overlay.classList.remove("hidden");
  summary.classList.add("hidden");

  // Genera una striscia di 36 celle con il moltiplicatore estratto al centro della cella #30
  const cells = [];
  const targetSlot = 30;
  for (let i = 0; i < 36; i++) {
    const item =
      i === targetSlot
        ? SPIN_MULTIPLIERS.find((m) => m.multiplier === table.multiplier) || SPIN_MULTIPLIERS[0]
        : SPIN_MULTIPLIERS[Math.floor(Math.random() * SPIN_MULTIPLIERS.length)];
    cells.push(
      `<div class="wheel-cell" style="background:${item.color}">${item.label}</div>`
    );
  }
  strip.innerHTML = cells.join("");
  strip.style.transition = "none";
  strip.style.transform = "translateX(0px)";

  // Calcola offset per allineare esattamente la cella #30 al centro della finestra
  requestAnimationFrame(() => {
    const windowWidth = $("spin-reel-track").clientWidth || 376;
    const cellWidth = 100;
    const targetOffset = targetSlot * cellWidth - windowWidth / 2 + cellWidth / 2;

    requestAnimationFrame(() => {
      strip.style.transition = "transform 2400ms cubic-bezier(0.12, 0.85, 0.18, 1)";
      strip.style.transform = `translateX(-${targetOffset}px)`;
    });
  });

  // Piccoli tick sonori durante la rotazione
  [150, 350, 600, 900, 1250, 1650, 2050].forEach((ms) => {
    setTimeout(() => {
      if (state.activeTable?.phase === "SPINNING") sfx.spinTick();
    }, ms);
  });

  setTimeout(() => {
    sfx.win();
    $("spin-result-multiplier").textContent = `${table.multiplier}x`;
    $("spin-result-prize").textContent = `Montepremi: ${formatChips(table.prizePool)} fiches`;
    $("spin-result-payout").textContent =
      table.multiplier >= 25
        ? "Premio Speciale: 80% 1° · 12% 2° · 8% 3°"
        : "Winner-Takes-All · 100% al 1° classificato";
    summary.classList.remove("hidden");
  }, 2450);
}

// ============================================================================
// RENDERING DEL TAVOLO, CARTE, POSTAZIONI & CONTROLLI
// ============================================================================
function renderCardHtml(
  cardStr,
  { faceDown = false, small = false, highlight = false, dealOrder = -1, commDealOrder = -1, revealFlip = false } = {}
) {
  const dealAttr = dealOrder >= 0 ? `data-deal-order="${dealOrder}"` : "";
  const commAttr = commDealOrder >= 0 ? `data-comm-deal-order="${commDealOrder}"` : "";
  const flipCls = revealFlip ? "card-reveal-flip" : "";

  if (faceDown) {
    return `<div class="playing-card card-back ${small ? "sm" : ""}" ${dealAttr} aria-label="Carta coperta"></div>`;
  }
  const c = parseCard(cardStr);
  return `
    <div class="playing-card suit-${c.suit} ${small ? "sm" : ""} ${highlight ? "winner-highlight" : ""} ${flipCls}" ${dealAttr} ${commAttr} aria-label="${c.displayRank} ${c.symbol}">
      <div class="card-corner">
        <span class="card-rank">${c.displayRank}</span>
        <span class="card-suit-mini">${c.symbol}</span>
      </div>
      <span class="card-center-suit">${c.symbol}</span>
    </div>
  `;
}

function renderTable() {
  const table = state.activeTable;
  if (!table) return;

  const isNewHand = (table.handNumber || 0) !== state.renderedHandNumber;
  if (isNewHand) {
    state.renderedCommunityCount = 0;
    state.renderedBets = {};
  }

  // HUD
  $("table-title-label").textContent = table.title || "Tavolo Poker";
  $("table-subtitle-label").textContent = `Mano #${table.handNumber || 0} · Bui ${table.smallBlind || 10}/${table.bigBlind || 20}`;
  $("hud-prizepool").textContent = `${formatChips(table.prizePool || 0)} fiches`;
  $("total-pot-value").textContent = formatChips(table.pot || 0);
  $("table-status-banner").textContent = table.lastActionText || "In attesa...";

  // Impulso piatto quando entrano nuove fiches
  if ((table.pot || 0) > (state.renderedPot || 0) && !isNewHand) {
    const potDisplay = document.querySelector(".main-pot-display");
    if (potDisplay) {
      potDisplay.classList.remove("pot-bump");
      void potDisplay.offsetWidth;
      potDisplay.classList.add("pot-bump");
    }
  }
  state.renderedPot = table.pot || 0;

  // Side Pots
  const sidePotsEl = $("side-pots-list");
  const pots = table.pots || [];
  if (pots.length > 1) {
    sidePotsEl.innerHTML = pots
      .map((p) => `<span class="side-pot-tag">${escapeHtml(p.name)}: ${formatChips(p.amount)}</span>`)
      .join("");
  } else {
    sidePotsEl.innerHTML = "";
  }

  const winningCardsSet = new Set();
  if (table.phase === "SHOWDOWN" && table.showdownResults && !table.showdownResults.isFoldWin) {
    for (const pot of table.showdownResults.pots || []) {
      for (const w of pot.winners || []) {
        (w.bestFive || []).forEach((c) => winningCardsSet.add(c));
      }
    }
  }

  // Carte Comuni (5 slot) - anima solo le carte appena distribuite dal mazzo
  const commEl = $("community-cards");
  const commCards = table.communityCards || [];
  let commHtml = "";
  for (let i = 0; i < 5; i++) {
    if (i < commCards.length) {
      const isNewComm = i >= state.renderedCommunityCount;
      commHtml += renderCardHtml(commCards[i], {
        highlight: winningCardsSet.has(commCards[i]),
        commDealOrder: isNewComm ? i - state.renderedCommunityCount : -1
      });
    } else {
      commHtml += `<div class="card-placeholder" aria-hidden="true"></div>`;
    }
  }
  commEl.innerHTML = commHtml;

  // Postazioni Giocatori attorno all'ovale
  renderSeats(table, winningCardsSet, isNewHand);

  // Calcola traiettorie reali dal Mazzo del Dealer e dalle postazioni giocatore
  animateDealtCardsAndChips(table);

  state.renderedHandNumber = table.handNumber || 0;
  state.renderedCommunityCount = commCards.length;

  // Controlli di puntata del giocatore locale
  renderActionControls(table);
}

function renderSeats(table, winningCardsSet, animateHoleCards = false) {
  const layer = $("seats-layer");
  const players = table.players || [];
  const totalSeats = players.length;
  const localIdx = Math.max(
    0,
    players.findIndex((p) => p.id === state.player.id)
  );

  // Ordine orario di distribuzione dal primo giocatore a sinistra del Dealer
  const dealSlotByIdx = new Map();
  if (animateHoleCards && totalSeats > 0) {
    const startIdx = typeof table.dealerIndex === "number" && table.dealerIndex >= 0 ? table.dealerIndex : 0;
    let slot = 0;
    for (let offset = 1; offset <= totalSeats; offset++) {
      const idx = (startIdx + offset) % totalSeats;
      const pl = players[idx];
      if (pl && pl.cards && pl.cards.length === 2 && !pl.eliminated) {
        dealSlotByIdx.set(idx, slot++);
      }
    }
  }
  const dealtPlayerCount = dealSlotByIdx.size;

  const isFirstShowdownReveal =
    table.phase === "SHOWDOWN" &&
    table.showdownResults &&
    !table.showdownResults.isFoldWin &&
    state.renderedShowdownRevealHand !== table.handNumber;

  // Set di vincitori allo showdown per highlight
  const winnerIds = new Set();
  if (table.showdownResults) {
    for (const pot of table.showdownResults.pots || []) {
      for (const w of pot.winners || []) winnerIds.add(w.id);
    }
  }

  const nextRenderedBets = {};
  let html = "";
  players.forEach((p, idx) => {
    const visualSlot = (idx - localIdx + totalSeats) % totalSeats;
    const angle = Math.PI / 2 + (visualSlot / totalSeats) * Math.PI * 2;
    const seatX = 50 + 44 * Math.cos(angle);
    const seatY = 50 + 42 * Math.sin(angle);

    const isTurn = table.turnIndex === idx;
    const isMe = p.id === state.player.id;
    const isShowdownReveal =
      table.phase === "SHOWDOWN" &&
      table.showdownResults &&
      !table.showdownResults.isFoldWin &&
      !p.folded;

    // Carte del giocatore
    let cardsHtml = "";
    if (p.cards && p.cards.length === 2 && !p.eliminated) {
      const reveal = isMe || isShowdownReveal;
      const dealSlot = dealSlotByIdx.has(idx) ? dealSlotByIdx.get(idx) : -1;
      cardsHtml = `
        <div class="seat-cards">
          ${p.cards
            .map((c, cardIdx) =>
              renderCardHtml(c, {
                faceDown: !reveal,
                small: !isMe,
                highlight: reveal && winningCardsSet.has(c),
                dealOrder: dealSlot >= 0 ? cardIdx * dealtPlayerCount + dealSlot : -1,
                revealFlip: !isMe && isShowdownReveal && isFirstShowdownReveal
              })
            )
            .join("")}
        </div>
      `;
    }

    // Tag azione
    let actClass = "";
    const act = (p.lastAction || "").toLowerCase();
    if (act.includes("fold")) actClass = "act-fold";
    else if (act.includes("all-in")) actClass = "act-allin";
    else if (act.includes("raise") || act.includes("bet")) actClass = "act-raise";
    else if (act.includes("call") || act.includes("check")) actClass = "act-call";

    const actionBadge = p.lastAction
      ? `<span class="seat-action-tag ${actClass}">${escapeHtml(p.lastAction)}</span>`
      : "";

    const timerBar = isTurn
      ? `<div class="seat-timer-bar"><div class="seat-timer-fill"></div></div>`
      : "";

    const dealerBtn = table.dealerIndex === idx
      ? `<div class="dealer-btn" title="Dealer">D</div>`
      : "";

    const initial = escapeHtml((p.name || "?").slice(0, 2).toUpperCase());

    html += `
      <div class="seat-node ${p.folded ? "folded" : ""} ${p.eliminated ? "eliminated" : ""} ${isTurn ? "is-turn" : ""} ${winnerIds.has(p.id) ? "is-winner" : ""}"
           style="left:${seatX.toFixed(2)}%; top:${seatY.toFixed(2)}%;">
        ${cardsHtml}
        <div class="seat-pod">
          <div class="seat-avatar" style="background:${p.color || "#1d4ed8"}">${initial}</div>
          <div class="seat-info">
            <span class="seat-name">${escapeHtml(p.name)}${isMe ? " (Tu)" : ""}</span>
            <span class="seat-stack tabular-nums">${formatChips(p.stack)}</span>
          </div>
          ${actionBadge}
          ${dealerBtn}
          ${timerBar}
        </div>
      </div>
    `;

    // Fiches puntate nel giro corrente davanti al giocatore
    const currBet = p.bet || 0;
    nextRenderedBets[p.id] = currBet;
    if (currBet > 0) {
      const bx = 50 + 25 * Math.cos(angle);
      const by = 50 + 24 * Math.sin(angle);
      const prevBet = state.renderedBets[p.id] || 0;
      const chipAttrs =
        currBet > prevBet
          ? `data-chip-from-x="${seatX.toFixed(2)}" data-chip-from-y="${seatY.toFixed(2)}" data-chip-to-x="${bx.toFixed(2)}" data-chip-to-y="${by.toFixed(2)}"`
          : "";
      html += `
        <div class="player-bet-chip tabular-nums" ${chipAttrs} style="left:${bx.toFixed(2)}%; top:${by.toFixed(2)}%">
          <span class="chip-icon" aria-hidden="true"></span>
          <span>${formatChips(currBet)}</span>
        </div>
      `;
    }
  });

  layer.innerHTML = html;
  state.renderedBets = nextRenderedBets;
  if (isFirstShowdownReveal) {
    state.renderedShowdownRevealHand = table.handNumber || 0;
  }
}

function animateDealtCardsAndChips(table) {
  const deckEl = $("dealer-deck-shoe");
  const stageEl = $("poker-table-stage");
  if (!stageEl) return;

  let anyCardsDealt = false;
  const tableIdSnapshot = table.id;

  if (deckEl) {
    const deckRect = deckEl.getBoundingClientRect();
    if (deckRect.width > 0) {
      const deckCx = deckRect.left + deckRect.width / 2;
      const deckCy = deckRect.top + deckRect.height / 2;

      // 1. Carte personali distribuite in senso orario dal mazzo del dealer
      const holeCards = document.querySelectorAll("#seats-layer .playing-card[data-deal-order]");
      holeCards.forEach((card) => {
        anyCardsDealt = true;
        const r = card.getBoundingClientRect();
        const dx = deckCx - (r.left + r.width / 2);
        const dy = deckCy - (r.top + r.height / 2);
        const rot = Math.max(-20, Math.min(20, -dx * 0.045));
        const order = Number(card.dataset.dealOrder) || 0;
        const delayMs = order * 75;

        card.style.setProperty("--deal-dx", `${dx.toFixed(1)}px`);
        card.style.setProperty("--deal-dy", `${dy.toFixed(1)}px`);
        card.style.setProperty("--deal-rot", `${rot.toFixed(1)}deg`);
        card.style.animationDelay = `${delayMs}ms`;
        card.classList.add("deal-from-deck");

        setTimeout(() => {
          if (state.activeTableId === tableIdSnapshot) {
            sfx.deal(0.028);
          }
        }, delayMs);
      });

      // 2. Carte comuni (Flop, Turn, River) dal mazzo al centro del tavolo
      const commCards = document.querySelectorAll("#community-cards .playing-card[data-comm-deal-order]");
      commCards.forEach((card) => {
        anyCardsDealt = true;
        const r = card.getBoundingClientRect();
        const dx = deckCx - (r.left + r.width / 2);
        const dy = deckCy - (r.top + r.height / 2);
        const order = Number(card.dataset.commDealOrder) || 0;
        const delayMs = order * 150;

        card.style.setProperty("--deal-dx", `${dx.toFixed(1)}px`);
        card.style.setProperty("--deal-dy", `${dy.toFixed(1)}px`);
        card.style.animationDelay = `${delayMs}ms`;
        card.classList.add("deal-comm-from-deck");

        setTimeout(() => {
          if (state.activeTableId === tableIdSnapshot) {
            sfx.deal(0.045);
          }
        }, delayMs);
      });

      if (anyCardsDealt) {
        deckEl.classList.remove("is-dealing");
        void deckEl.offsetWidth;
        deckEl.classList.add("is-dealing");
      }
    }
  }

  // 3. Fiches che scivolano dalla postazione del giocatore verso il piatto
  const stageRect = stageEl.getBoundingClientRect();
  if (stageRect.width > 0) {
    document.querySelectorAll("#seats-layer .player-bet-chip[data-chip-from-x]").forEach((chip) => {
      const fromX = Number(chip.dataset.chipFromX);
      const fromY = Number(chip.dataset.chipFromY);
      const toX = Number(chip.dataset.chipToX);
      const toY = Number(chip.dataset.chipToY);
      const dx = ((fromX - toX) / 100) * stageRect.width;
      const dy = ((fromY - toY) / 100) * stageRect.height;
      chip.style.setProperty("--chip-dx", `${dx.toFixed(1)}px`);
      chip.style.setProperty("--chip-dy", `${dy.toFixed(1)}px`);
      chip.classList.add("chip-animate");
    });
  }
}

function renderActionControls(table) {
  const strengthEl = $("my-hand-strength");
  const nextHandBtn = $("btn-next-hand-now");
  const preActionsBar = $("pre-actions-bar");
  const raiseRow = $("raise-controls-row");
  const primaryRow = $("primary-actions-row");
  const me = (table.players || []).find((p) => p.id === state.player.id);

  // Bottone "Mano Successiva →" allo showdown su tavoli vs Bot (se umano ancora in vita)
  const canSkipShowdown =
    table.mode === "bots" && table.phase === "SHOWDOWN" && me && !me.eliminated;
  nextHandBtn.classList.toggle("hidden", !canSkipShowdown);

  // Mostra la valutazione live del punto attuale per il giocatore locale
  if (me && me.cards && me.cards.length === 2 && !me.folded && !me.eliminated) {
    const allCards = [...me.cards, ...(table.communityCards || [])];
    if (allCards.length >= 5) {
      const evalRes = evaluateBestHand(allCards);
      strengthEl.textContent = evalRes ? `Punto attuale: ${evalRes.nameIt}` : "";
    } else {
      const r1 = parseCard(me.cards[0]).displayRank;
      const r2 = parseCard(me.cards[1]).displayRank;
      strengthEl.textContent = r1 === r2 ? `Coppia servita di ${r1}` : `Mano iniziale: ${r1} - ${r2}`;
    }
  } else {
    strengthEl.textContent = "";
  }

  const legal = getLegalActions(table, state.player.id);
  const isPlayingPhase = ["PREFLOP", "FLOP", "TURN", "RIVER"].includes(table.phase);

  if (!legal) {
    // Non è il nostro turno: mostra Pre-Azioni se siamo ancora attivi nella mano
    const canPreAct = isPlayingPhase && me && !me.folded && !me.allIn && !me.eliminated;
    preActionsBar.classList.toggle("hidden", !canPreAct);
    raiseRow.classList.add("hidden");
    primaryRow.classList.add("hidden");

    if (canPreAct) {
      const toCall = Math.max(0, (table.currentBet || 0) - (me.bet || 0));
      document.querySelectorAll("[data-pre-action]").forEach((btn) => {
        const type = btn.dataset.preAction;
        btn.classList.toggle("active", state.preAction === type);
        if (type === "checkfold") {
          btn.textContent = toCall === 0 ? "Check automatico" : "Check / Fold automatico";
        } else if (type === "checkcall") {
          btn.textContent =
            toCall === 0
              ? "Check automatico"
              : `Call ${formatChips(Math.min(me.stack, toCall))} automatico`;
        }
      });
    }
    return;
  }

  // È il nostro turno: mostra i controlli principali
  preActionsBar.classList.add("hidden");
  primaryRow.classList.remove("hidden");

  const btnFold = $("btn-fold");
  const btnCheckCall = $("btn-check-call");
  const btnRaise = $("btn-raise");
  const slider = $("raise-slider");
  const numInput = $("raise-number-input");

  btnFold.disabled = false;

  if (legal.canCheck) {
    btnCheckCall.innerHTML = `Check <kbd>C</kbd>`;
  } else if (legal.isCallAllIn) {
    btnCheckCall.innerHTML = `Call All-In (${formatChips(legal.callAmount)}) <kbd>C</kbd>`;
  } else {
    btnCheckCall.innerHTML = `Call ${formatChips(legal.callAmount)} <kbd>C</kbd>`;
  }

  if (!legal.canRaise) {
    btnRaise.disabled = true;
    raiseRow.classList.add("hidden");
    btnRaise.innerHTML = `Raise <kbd>R</kbd>`;
  } else {
    btnRaise.disabled = false;
    raiseRow.classList.remove("hidden");

    slider.min = legal.minRaiseTotal;
    slider.max = legal.maxBetTotal;
    slider.step = Math.max(1, Math.min(table.smallBlind || 10, legal.maxBetTotal - legal.minRaiseTotal || 1));

    const currentVal = Number(numInput.value);
    const clamped =
      Number.isFinite(currentVal) &&
      currentVal >= legal.minRaiseTotal &&
      currentVal <= legal.maxBetTotal
        ? currentVal
        : legal.minRaiseTotal;

    slider.value = clamped;
    numInput.min = legal.minRaiseTotal;
    numInput.max = legal.maxBetTotal;
    numInput.value = clamped;

    updateRaiseButtonLabel(clamped, legal.maxBetTotal, table.currentBet === 0);
  }
}

function updateRaiseButtonLabel(amount, maxBetTotal, isOpenBet) {
  const btnRaise = $("btn-raise");
  if (amount >= maxBetTotal) {
    btnRaise.innerHTML = `All-In ${formatChips(amount)} <kbd>R</kbd>`;
  } else if (isOpenBet) {
    btnRaise.innerHTML = `Bet ${formatChips(amount)} <kbd>R</kbd>`;
  } else {
    btnRaise.innerHTML = `Raise a ${formatChips(amount)} <kbd>R</kbd>`;
  }
}

async function submitAction(actionType) {
  const table = state.activeTable;
  if (!table) return;
  const raiseVal = Number($("raise-number-input").value) || 0;
  const seqSnapshot = table.actionSeq;

  await rtdb.runTransaction(`tables/${table.id}`, (curr) => {
    if (!curr || curr.actionSeq !== seqSnapshot) return undefined;
    const active = curr.players[curr.turnIndex];
    if (!active || active.id !== state.player.id) return undefined;
    return applyPlayerAction(curr, state.player.id, actionType, raiseVal, Date.now());
  });
}

// ============================================================================
// FINE TORNEO & ACCREDITO PREMI
// ============================================================================
function handleTournamentOver(table, humanEliminatedEarly = false) {
  const overlay = $("tournament-over-overlay");
  overlay.classList.remove("hidden");

  const replayBtn = $("btn-finish-replay-bots");
  replayBtn.classList.toggle("hidden", table.mode !== "bots");

  const players = [...(table.players || [])];
  // Ordina classifica: giocatori ancora in gioco per stack decrescente, poi eliminati in ordine inverso
  players.sort((a, b) => {
    const aAlive = !a.eliminated && a.stack > 0;
    const bAlive = !b.eliminated && b.stack > 0;
    if (aAlive && !bAlive) return -1;
    if (!aAlive && bAlive) return 1;
    if (aAlive && bAlive) return b.stack - a.stack;
    return (b.eliminatedAt || 0) - (a.eliminatedAt || 0);
  });

  const payouts = table.payouts || [{ rank: 1, pct: 100 }];
  const prizePool = table.prizePool || 0;

  const standingsHtml = players
    .map((p, i) => {
      const rank = i + 1;
      const payoutEntry = payouts.find((x) => x.rank === rank);
      const prize = payoutEntry ? Math.floor((prizePool * payoutEntry.pct) / 100) : 0;

      // Accredita vincita al giocatore locale una sola volta (se il giocatore stesso è a premio)
      if (
        p.id === state.player.id &&
        prize > 0 &&
        (table.phase === "TOURNAMENT_OVER" || p.eliminated) &&
        !getAwardedTablesSet().has(table.id)
      ) {
        markTableAwarded(table.id);
        adjustBalance(prize);
        sfx.win();
        showToast(`Complimenti! Hai vinto ${formatChips(prize)} fiches!`);
      }

      return `
        <div class="standing-row">
          <span><strong>${rank}°</strong> ${escapeHtml(p.name)}${p.eliminated ? " (Eliminato)" : ""}</span>
          <span class="tabular-nums gold-text">${prize > 0 ? `+${formatChips(prize)} fiches` : formatChips(p.stack)}</span>
        </div>
      `;
    })
    .join("");

  const winner = players[0];
  if (humanEliminatedEarly) {
    const myRank = players.findIndex((p) => p.id === state.player.id) + 1;
    $("tourn-over-title").textContent = `Sei stato eliminato (${myRank}° posto)`;
  } else {
    $("tourn-over-title").textContent = winner
      ? `${winner.name} vince la partita!`
      : "Partita conclusa";
  }
  $("tourn-over-subtitle").textContent =
    prizePool > 0
      ? `Montepremi totale: ${formatChips(prizePool)} fiches`
      : "Partita di allenamento gratuita contro Bot";
  $("tourn-over-standings").innerHTML = standingsHtml;

  // Aggiorna stato torneo in lobby una sola volta tramite transazione
  if (table.tournamentId && winner && table.phase === "TOURNAMENT_OVER") {
    const existingTourn = state.tournaments[table.tournamentId];
    if (!existingTourn || (existingTourn.status !== "finished" && existingTourn.status !== "cancelled")) {
      rtdb
        .runTransaction(`tournaments/${table.tournamentId}`, (curr) => {
          if (!curr || curr.status !== "running") return undefined;
          return {
            ...curr,
            status: "finished",
            winnerName: winner.name
          };
        })
        .catch(() => {});
    }
  }
}

// ============================================================================
// CHAT AL TAVOLO
// ============================================================================
function renderChat() {
  const list = $("chat-messages");
  const msgs = state.chatMessages || [];
  list.innerHTML = msgs
    .map((m) =>
      m.system
        ? `<div class="chat-msg system">${escapeHtml(m.text)}</div>`
        : `<div class="chat-msg"><strong>${escapeHtml(m.sender)}:</strong>${escapeHtml(m.text)}</div>`
    )
    .join("");
  list.scrollTop = list.scrollHeight;

  if (!state.chatOpen) {
    const unread = Math.max(0, msgs.length - state.lastSeenChatCount);
    state.unreadChatCount = unread;
    const badge = $("chat-unread-count");
    if (unread > 0) {
      badge.textContent = String(unread);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  } else {
    state.lastSeenChatCount = msgs.length;
    $("chat-unread-count").classList.add("hidden");
  }
}

async function sendChatMessage(text) {
  if (!state.activeTableId || !text.trim()) return;
  const tablePlayerIds =
    state.activeTable?.playerIds && state.activeTable.playerIds.length > 0
      ? state.activeTable.playerIds
      : [state.player.id];
  await rtdb.push(`chats/${state.activeTableId}`, {
    sender: state.player.name,
    text: text.trim().slice(0, 160),
    system: false,
    ts: Date.now(),
    tablePlayerIds
  });
}

// ============================================================================
// COLLEGAMENTO EVENTI DOM & AVVIO APP
// ============================================================================
function bindEvents() {
  // Login: selezione colore stemma
  $("avatar-color-picker").addEventListener("click", (e) => {
    const btn = e.target.closest(".swatch");
    if (!btn) return;
    document.querySelectorAll("#avatar-color-picker .swatch").forEach((s) => s.classList.remove("active"));
    btn.classList.add("active");
  });

  // Login con Google Sign-In
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const rawName = $("nickname-input").value.trim();
    if (rawName.length > 0 && rawName.length < 2) {
      showToast("Il nickname opzionale deve avere almeno 2 caratteri.", true);
      return;
    }

    const btn = $("btn-google-login");
    const prevLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Connessione a Google...";
    try {
      await signInWithGoogle();
    } catch (err) {
      console.error("Google Sign-In fallito:", err);
      showToast("Accesso con Google annullato o bloccato dal browser.", true);
    } finally {
      btn.disabled = false;
      btn.textContent = prevLabel;
    }
  });

  // Logout / Cambia utente
  $("btn-logout").addEventListener("click", async () => {
    stopLobbySubscriptions();
    leaveTableSubscriptionsOnly();
    sessionStorage.removeItem(SESSION_PLAYER_KEY);
    state.player = null;
    await signOutGoogle();
    showScreen("login-screen");
  });

  // Ricarica Gratis
  $("btn-topup").addEventListener("click", () => {
    adjustBalance(TOPUP_AMOUNT);
    showToast(`Ricarica completata: +${formatChips(TOPUP_AMOUNT)} fiches accreditate!`);
  });

  // Copia Link Invito
  $("btn-copy-invite-url").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      showToast("Link copiato negli appunti! Aprilo in un'altra scheda o invialo agli amici.");
    } catch {
      showToast("Copia l'URL dalla barra degli indirizzi del browser.");
    }
  });

  // Navigazione Tab Lobby
  document.querySelectorAll("[data-lobby-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.lobbyTab = btn.dataset.lobbyTab;
      document.querySelectorAll("[data-lobby-tab]").forEach((b) =>
        b.classList.toggle("active", b === btn)
      );
      $("tab-spin").classList.toggle("hidden", state.lobbyTab !== "spin");
      $("tab-tournaments").classList.toggle("hidden", state.lobbyTab !== "tournaments");
      $("tab-bots").classList.toggle("hidden", state.lobbyTab !== "bots");
    });
  });

  // Preset Tavoli vs Bot
  document.querySelectorAll("[data-bot-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = btn.dataset.botPreset;
      if (preset === "headsup") {
        startBotTable({
          title: "Sfida 1 vs 1 contro Bot",
          botCount: 1,
          style: "balanced",
          buyIn: 0,
          startingStack: 1500,
          blindSpeed: "turbo"
        });
      } else if (preset === "sixmax") {
        startBotTable({
          title: "Tavolo 6-Max vs Bot",
          botCount: 5,
          style: "mixed",
          buyIn: 500,
          startingStack: 3000,
          blindSpeed: "normal"
        });
      } else if (preset === "fullring") {
        startBotTable({
          title: "Full Ring Casinò vs Bot",
          botCount: 8,
          style: "mixed",
          buyIn: 1000,
          startingStack: 3000,
          blindSpeed: "normal"
        });
      }
    });
  });

  // Form Tavolo Personalizzato vs Bot
  $("bot-custom-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const botCount = Number($("bot-count-select").value);
    startBotTable({
      title: `Tavolo vs ${botCount} Bot`,
      botCount,
      style: $("bot-style-select").value,
      buyIn: Number($("bot-buyin-select").value),
      startingStack: Number($("bot-stack-select").value),
      blindSpeed: $("bot-speed-select").value
    });
  });

  // Filtro Tornei
  document.querySelectorAll("[data-tourn-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tournFilter = btn.dataset.tournFilter;
      document.querySelectorAll("[data-tourn-filter]").forEach((b) =>
        b.classList.toggle("active", b === btn)
      );
      renderTournaments();
    });
  });

  // Delegazione click Spin & Go
  $("spin-tiers-grid").addEventListener("click", (e) => {
    const joinBtn = e.target.closest("[data-join-spin]");
    if (joinBtn) {
      joinSpinQueue(Number(joinBtn.dataset.joinSpin));
      return;
    }
    const leaveBtn = e.target.closest("[data-leave-spin]");
    if (leaveBtn) {
      leaveSpinQueue(Number(leaveBtn.dataset.leaveSpin));
    }
  });

  // Delegazione click Tornei
  $("tournaments-list").addEventListener("click", (e) => {
    const copyBtn = e.target.closest("[data-copy-code]");
    if (copyBtn) {
      copyTextWithFeedback(copyBtn.dataset.copyCode, "Codice torneo");
      return;
    }
    const regBtn = e.target.closest("[data-register-tourn]");
    if (regBtn) {
      registerForTournament(regBtn.dataset.registerTourn);
      return;
    }
    const unregBtn = e.target.closest("[data-unregister-tourn]");
    if (unregBtn) {
      unregisterFromTournament(unregBtn.dataset.unregisterTourn);
      return;
    }
    const enterBtn = e.target.closest("[data-enter-tourn]");
    if (enterBtn) {
      const tourn = state.tournaments[enterBtn.dataset.enterTourn];
      if (tourn) openTournamentTableForPlayer(tourn);
    }
  });

  // Modali & Chiusure
  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
  });

  $("btn-open-hands-guide").addEventListener("click", () => openModal("hands-guide-modal"));
  $("btn-open-create-tournament").addEventListener("click", () => openModal("create-tournament-modal"));
  $("btn-copy-created-code").addEventListener("click", async () => {
    const code = $("tourn-created-code").textContent.trim();
    if (!code) return;
    await copyTextWithFeedback(code, "Codice torneo");
    $("btn-copy-created-code").textContent = "Copiato ✓";
  });
  $("btn-join-by-code").addEventListener("click", () => {
    delete $("join-code-form").dataset.targetTournId;
    $("private-code-input").value = "";
    openModal("join-code-modal");
    $("private-code-input").focus();
  });

  $("tourn-start-mode").addEventListener("change", (e) => {
    $("tourn-schedule-group").classList.toggle("hidden", e.target.value !== "scheduled");
  });

  $("create-tournament-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("tourn-name").value.trim();
    if (!name) return;
    createTournament({
      name,
      visibility: $("tourn-visibility").value,
      inviteCode: $("tourn-invite-code").value.trim(),
      maxPlayers: Number($("tourn-max-players").value),
      blindSpeed: $("tourn-blind-speed").value,
      buyIn: Number($("tourn-buyin").value),
      startingStack: Number($("tourn-stack").value),
      startMode: $("tourn-start-mode").value,
      delayMinutes: Number($("tourn-delay-minutes").value)
    });
  });

  $("join-code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = $("private-code-input").value.trim().replace(/\s+/g, "").toUpperCase();
    if (!code) return;

    const targetId = $("join-code-form").dataset.targetTournId;
    if (targetId) {
      await registerForTournament(targetId, code);
      return;
    }

    const foundTourn = await rtdb.getTournamentByCode(code);
    if (!foundTourn) {
      showToast("Nessun torneo trovato con questo codice.", true);
      return;
    }

    state.tournaments[foundTourn.id] = foundTourn;

    if (foundTourn.status === "registering") {
      await registerForTournament(foundTourn.id, code);
      return;
    }

    if (foundTourn.status === "running") {
      if ((foundTourn.players || []).some((p) => p.id === state.player.id)) {
        closeModal("join-code-modal");
        await openTournamentTableForPlayer(foundTourn);
      } else {
        showToast("Questo torneo è già iniziato.", true);
      }
      return;
    }

    showToast("Questo torneo è già concluso o annullato.", true);
  });

  // Toggle Mazzo 4 Colori (Lobby + Tavolo)
  const toggleFourColors = () => {
    state.fourColorDeck = !state.fourColorDeck;
    document.body.classList.toggle("four-color-deck", state.fourColorDeck);
    $("btn-open-deck-prefs").textContent = state.fourColorDeck ? "Mazzo 2 Colori" : "Mazzo 4 Colori";
    $("btn-table-deck-toggle").textContent = state.fourColorDeck ? "2 Colori" : "4 Colori";
    showToast(state.fourColorDeck ? "Mazzo a 4 colori attivato" : "Mazzo classico a 2 colori attivato");
  };
  $("btn-open-deck-prefs").addEventListener("click", toggleFourColors);
  $("btn-table-deck-toggle").addEventListener("click", toggleFourColors);

  // Audio Mute Toggle
  $("btn-mute-audio").addEventListener("click", () => {
    state.audioMuted = !state.audioMuted;
    $("btn-mute-audio").textContent = state.audioMuted ? "Audio Off" : "Audio On";
    $("btn-mute-audio").setAttribute("aria-pressed", String(state.audioMuted));
  });

  // Torna in lobby dal tavolo / Gioca ancora vs Bot
  $("btn-leave-table").addEventListener("click", leaveTableToLobby);
  $("btn-finish-back-lobby").addEventListener("click", leaveTableToLobby);
  $("btn-finish-replay-bots").addEventListener("click", () => {
    if (state.lastBotConfig) {
      startBotTable(state.lastBotConfig);
    } else {
      leaveTableToLobby();
    }
  });

  // Controlli puntate al tavolo
  $("btn-fold").addEventListener("click", () => submitAction("fold"));
  $("btn-check-call").addEventListener("click", () => {
    const legal = getLegalActions(state.activeTable, state.player.id);
    if (!legal) return;
    submitAction(legal.canCheck ? "check" : "call");
  });
  $("btn-raise").addEventListener("click", () => submitAction("raise"));

  // Pre-azioni automatiche in attesa del proprio turno
  document.querySelectorAll("[data-pre-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.preAction;
      if (state.preAction === action) {
        state.preAction = null;
        state.preActionArmedBet = 0;
      } else {
        state.preAction = action;
        state.preActionArmedBet = state.activeTable?.currentBet || 0;
      }
      if (state.activeTable) renderActionControls(state.activeTable);
    });
  });

  // Salta pausa Showdown su tavolo Bot
  $("btn-next-hand-now").addEventListener("click", async () => {
    const table = state.activeTable;
    if (!table || table.phase !== "SHOWDOWN") return;
    await rtdb.runTransaction(`tables/${table.id}`, (curr) => {
      if (!curr || curr.phase !== "SHOWDOWN") return undefined;
      return startNewHand(curr, Date.now());
    });
  });

  // Slider & input numerico sincronizzati
  $("raise-slider").addEventListener("input", (e) => {
    const val = Number(e.target.value);
    $("raise-number-input").value = val;
    updateRaiseButtonLabel(val, Number(e.target.max), (state.activeTable?.currentBet || 0) === 0);
  });
  $("raise-number-input").addEventListener("input", (e) => {
    const val = Number(e.target.value);
    $("raise-slider").value = val;
    updateRaiseButtonLabel(val, Number($("raise-slider").max), (state.activeTable?.currentBet || 0) === 0);
  });

  // Scorciatoie puntate rapide (Min, 1/2 Pot, Pot, All-In)
  document.querySelectorAll("[data-bet-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const table = state.activeTable;
      const legal = getLegalActions(table, state.player.id);
      if (!legal || !legal.canRaise) return;

      const preset = btn.dataset.betPreset;
      let target = legal.minRaiseTotal;
      if (preset === "half") {
        target = Math.floor((table.currentBet || 0) + legal.callAmount + legal.pot * 0.5);
      } else if (preset === "pot") {
        target = Math.floor((table.currentBet || 0) + legal.callAmount + legal.pot);
      } else if (preset === "allin") {
        target = legal.maxBetTotal;
      }

      target = Math.max(legal.minRaiseTotal, Math.min(legal.maxBetTotal, target));
      $("raise-slider").value = target;
      $("raise-number-input").value = target;
      updateRaiseButtonLabel(target, legal.maxBetTotal, (table.currentBet || 0) === 0);
    });
  });

  // Chat comprimibile
  $("btn-toggle-chat").addEventListener("click", () => {
    state.chatOpen = !state.chatOpen;
    $("table-chat-box").classList.toggle("collapsed", !state.chatOpen);
    $("btn-toggle-chat").setAttribute("aria-expanded", String(state.chatOpen));
    if (state.chatOpen) {
      state.lastSeenChatCount = state.chatMessages.length;
      $("chat-unread-count").classList.add("hidden");
      $("chat-input").focus();
    }
  });

  $("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("chat-input");
    sendChatMessage(input.value);
    input.value = "";
  });

  // Scorciatoie da tastiera al tavolo (F, C, R)
  window.addEventListener("keydown", (e) => {
    if (!state.activeTableId || !state.player) return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    const legal = getLegalActions(state.activeTable, state.player.id);
    if (!legal) return;

    const k = e.key.toLowerCase();
    if (k === "f") {
      submitAction("fold");
    } else if (k === "c") {
      submitAction(legal.canCheck ? "check" : "call");
    } else if (k === "r" && legal.canRaise) {
      submitAction("raise");
    }
  });
}

// ============================================================================
// BOOTSTRAP INIZIALE
// ============================================================================
async function bootstrap() {
  bindEvents();
  await rtdb.init();
  $("login-sync-mode").textContent = isFirebaseConfigured()
    ? "Multiplayer Online Cloud (Firebase)"
    : "Configurazione Firebase mancante";

  subscribeAuthState(async (user) => {
    if (user && user.emailVerified) {
      if (state.player && state.player.id === user.uid) {
        return;
      }

      const typedName = $("nickname-input")?.value?.trim() || "";
      const fallbackGoogleName = (
        user.displayName ||
        (user.email ? user.email.split("@")[0] : "") ||
        "Giocatore"
      )
        .trim()
        .slice(0, 18);
      const preferredName = typedName.length >= 2 ? typedName : fallbackGoogleName;
      const activeSwatch = document.querySelector("#avatar-color-picker .swatch.active");
      const preferredColor = activeSwatch?.dataset.color || "#b91c1c";

      try {
        const profile = await loadOrCreateUserProfile(
          user.uid,
          preferredName,
          preferredColor
        );
        state.player = profile;
        sessionStorage.setItem(SESSION_PLAYER_KEY, JSON.stringify(profile));
        await enterLobby();
      } catch (err) {
        console.error("Errore caricamento profilo Firestore:", err);
        showToast("Errore durante la sincronizzazione del profilo online.", true);
      }
    } else {
      stopLobbySubscriptions();
      leaveTableSubscriptionsOnly();
      state.player = null;
      state.activeTableId = null;
      state.activeTable = null;
      showScreen("login-screen");
    }
  });
}

bootstrap();
