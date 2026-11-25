/**
 * poker-engine.js
 * -----------------------------------------------------------------------------
 * Motore completo di Texas Hold'em No-Limit:
 * - Mazzo da 52 carte & mescolamento Fisher-Yates crittografico
 * - Valutatore preciso delle mani (5, 6 o 7 carte) con tutte le 10 categorie
 * - Gestione Main Pot, Side Pots multipli e Split Pot con resto dispari al bottone
 * - State machine completa: Preflop, Flop, Turn, River, Showdown
 * - Regole Heads-Up vs Multi-way per Dealer / Small Blind / Big Blind
 * - Strutture bui per Spin & Go (Hyper-Turbo) e Tornei (Lenta / Normale / Turbo)
 * -----------------------------------------------------------------------------
 */

export const SUITS = ["s", "h", "d", "c"]; // Picche, Cuori, Quadri, Fiori
export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];

export const RANK_VALUES = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8,
  "9": 9, T: 10, J: 11, Q: 12, K: 13, A: 14
};

export const RANK_NAMES_IT = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8",
  9: "9", 10: "10", 11: "J", 12: "Q", 13: "K", 14: "Asso"
};

export const SUIT_SYMBOLS = {
  s: "♠\uFE0E",
  h: "♥\uFE0E",
  d: "♦\uFE0E",
  c: "♣\uFE0E"
};

export const HAND_CATEGORY_NAMES = [
  "Carta Alta",
  "Coppia",
  "Doppia Coppia",
  "Tris",
  "Scala",
  "Colore",
  "Full House",
  "Poker",
  "Scala Colore",
  "Scala Reale"
];

/**
 * Strutture bui ufficiali per modalità
 */
export const BLIND_SCHEDULES = {
  spin: {
    label: "Hyper-Turbo (2 min)",
    intervalMs: 120_000,
    levels: [
      { sb: 10, bb: 20, ante: 0 },
      { sb: 15, bb: 30, ante: 0 },
      { sb: 25, bb: 50, ante: 5 },
      { sb: 40, bb: 80, ante: 10 },
      { sb: 60, bb: 120, ante: 15 },
      { sb: 100, bb: 200, ante: 25 },
      { sb: 150, bb: 300, ante: 40 },
      { sb: 250, bb: 500, ante: 50 }
    ]
  },
  turbo: {
    label: "Turbo (1 min)",
    intervalMs: 60_000,
    levels: [
      { sb: 10, bb: 20, ante: 0 },
      { sb: 20, bb: 40, ante: 0 },
      { sb: 30, bb: 60, ante: 5 },
      { sb: 50, bb: 100, ante: 10 },
      { sb: 75, bb: 150, ante: 15 },
      { sb: 100, bb: 200, ante: 25 },
      { sb: 150, bb: 300, ante: 30 },
      { sb: 250, bb: 500, ante: 50 },
      { sb: 400, bb: 800, ante: 100 },
      { sb: 600, bb: 1200, ante: 150 }
    ]
  },
  normal: {
    label: "Normale (3 min)",
    intervalMs: 180_000,
    levels: [
      { sb: 10, bb: 20, ante: 0 },
      { sb: 15, bb: 30, ante: 0 },
      { sb: 25, bb: 50, ante: 0 },
      { sb: 50, bb: 100, ante: 10 },
      { sb: 75, bb: 150, ante: 15 },
      { sb: 100, bb: 200, ante: 20 },
      { sb: 150, bb: 300, ante: 30 },
      { sb: 200, bb: 400, ante: 40 },
      { sb: 300, bb: 600, ante: 75 },
      { sb: 500, bb: 1000, ante: 100 }
    ]
  },
  slow: {
    label: "Lenta (5 min)",
    intervalMs: 300_000,
    levels: [
      { sb: 10, bb: 20, ante: 0 },
      { sb: 15, bb: 30, ante: 0 },
      { sb: 25, bb: 50, ante: 0 },
      { sb: 40, bb: 80, ante: 0 },
      { sb: 50, bb: 100, ante: 10 },
      { sb: 75, bb: 150, ante: 15 },
      { sb: 100, bb: 200, ante: 25 },
      { sb: 150, bb: 300, ante: 30 },
      { sb: 250, bb: 500, ante: 50 },
      { sb: 400, bb: 800, ante: 100 }
    ]
  }
};

/**
 * Tabella moltiplicatori realistici per Spin & Go (somma = 10.000)
 */
export const SPIN_MULTIPLIERS = [
  { multiplier: 2, weight: 7250, color: "#2d6a4f", label: "2x" },
  { multiplier: 3, weight: 1800, color: "#1d4ed8", label: "3x" },
  { multiplier: 5, weight: 700, color: "#7c3aed", label: "5x" },
  { multiplier: 10, weight: 200, color: "#c2410c", label: "10x" },
  { multiplier: 25, weight: 45, color: "#b91c1c", label: "25x" },
  { multiplier: 100, weight: 5, color: "#d4af37", label: "100x" }
];

export function rollSpinMultiplier() {
  const totalWeight = SPIN_MULTIPLIERS.reduce((acc, m) => acc + m.weight, 0);
  const rand = randomInt(totalWeight);
  let cumulative = 0;
  for (const item of SPIN_MULTIPLIERS) {
    cumulative += item.weight;
    if (rand < cumulative) {
      return item.multiplier;
    }
  }
  return 2;
}

/**
 * Numero intero casuale uniforme in [0, maxExclusive)
 */
export function randomInt(maxExclusive) {
  if (maxExclusive <= 1) return 0;
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const limit = Math.floor(0xffffffff / maxExclusive) * maxExclusive;
    const arr = new Uint32Array(1);
    while (true) {
      crypto.getRandomValues(arr);
      if (arr[0] < limit) {
        return arr[0] % maxExclusive;
      }
    }
  }
  return Math.floor(Math.random() * maxExclusive);
}

/**
 * Crea un mazzo standard da 52 carte (es. "As", "Th", "7d", "2c")
 */
export function createDeck() {
  const deck = [];
  for (const r of RANKS) {
    for (const s of SUITS) {
      deck.push(`${r}${s}`);
    }
  }
  return deck;
}

/**
 * Mescolamento Fisher-Yates in-place su una copia del mazzo (52 carte uniche)
 */
export function shuffleDeck(deck) {
  const copy = [...new Set(deck)];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Restituisce l'insieme di tutte le carte già usate nella mano corrente
 */
function getUsedCardsSet(table) {
  const used = new Set();
  for (const p of table.players || []) {
    for (const c of p.cards || []) {
      if (c) used.add(c);
    }
  }
  for (const c of table.communityCards || []) {
    if (c) used.add(c);
  }
  for (const c of table.burnedCards || []) {
    if (c) used.add(c);
  }
  return used;
}

/**
 * Estrae una carta garantendo che appartenga all'unico mazzo da 52 carte e non sia mai duplicata.
 */
function drawUniqueCard(table) {
  const used = getUsedCardsSet(table);
  if (!Array.isArray(table.deck)) table.deck = [];

  while (table.deck.length > 0) {
    const candidate = table.deck.pop();
    if (candidate && !used.has(candidate)) {
      return candidate;
    }
  }

  // Paracadute di sicurezza: ricostruisce le sole carte rimanenti del mazzo da 52
  const remaining = shuffleDeck(createDeck().filter((c) => !used.has(c)));
  table.deck = remaining;
  return table.deck.pop();
}

function burnUniqueCard(table) {
  const card = drawUniqueCard(table);
  if (!Array.isArray(table.burnedCards)) table.burnedCards = [];
  if (card) table.burnedCards.push(card);
}

export function parseCard(cardStr) {
  const rank = cardStr[0];
  const suit = cardStr[1];
  return {
    raw: cardStr,
    rank,
    suit,
    value: RANK_VALUES[rank],
    displayRank: rank === "T" ? "10" : rank,
    symbol: SUIT_SYMBOLS[suit]
  };
}

/**
 * Valuta esattamente una mano da 5 carte.
 * Restituisce { score, category, nameIt, tiebreakers }
 */
export function evaluate5Cards(cards5) {
  const parsed = cards5.map((c) => (typeof c === "string" ? parseCard(c) : c));
  const values = parsed.map((c) => c.value).sort((a, b) => b - a);
  const suits = parsed.map((c) => c.suit);

  const isFlush = suits.every((s) => s === suits[0]);

  // Controllo scala (inclusa ruota A-2-3-4-5)
  const uniqueVals = [...new Set(values)];
  let isStraight = false;
  let straightHigh = 0;

  if (uniqueVals.length === 5) {
    if (uniqueVals[0] - uniqueVals[4] === 4) {
      isStraight = true;
      straightHigh = uniqueVals[0];
    } else if (
      uniqueVals[0] === 14 &&
      uniqueVals[1] === 5 &&
      uniqueVals[2] === 4 &&
      uniqueVals[3] === 3 &&
      uniqueVals[4] === 2
    ) {
      isStraight = true;
      straightHigh = 5;
    }
  }

  // Conteggio frequenze ranghi
  const counts = new Map();
  for (const v of values) {
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  // Ordina per frequenza decrescente, poi valore decrescente
  const groups = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0] - a[0];
  });

  let category = 0;
  let tiebreakers = [];

  if (isFlush && isStraight) {
    category = straightHigh === 14 ? 9 : 8;
    tiebreakers = [straightHigh, 0, 0, 0, 0];
  } else if (groups[0][1] === 4) {
    category = 7;
    tiebreakers = [groups[0][0], groups[1][0], 0, 0, 0];
  } else if (groups[0][1] === 3 && groups[1][1] === 2) {
    category = 6;
    tiebreakers = [groups[0][0], groups[1][0], 0, 0, 0];
  } else if (isFlush) {
    category = 5;
    tiebreakers = values;
  } else if (isStraight) {
    category = 4;
    tiebreakers = [straightHigh, 0, 0, 0, 0];
  } else if (groups[0][1] === 3) {
    category = 3;
    tiebreakers = [groups[0][0], groups[1][0], groups[2][0], 0, 0];
  } else if (groups[0][1] === 2 && groups[1][1] === 2) {
    category = 2;
    tiebreakers = [groups[0][0], groups[1][0], groups[2][0], 0, 0];
  } else if (groups[0][1] === 2) {
    category = 1;
    tiebreakers = [groups[0][0], groups[1][0], groups[2][0], groups[3][0], 0];
  } else {
    category = 0;
    tiebreakers = values;
  }

  // Score base-15 deterministico: max ~ 9 * 15^5 = 6.8M (ampiamente sicuro in Number)
  let score = category;
  for (let i = 0; i < 5; i++) {
    score = score * 15 + (tiebreakers[i] || 0);
  }

  return {
    score,
    category,
    nameIt: formatHandNameIt(category, tiebreakers),
    tiebreakers
  };
}

function formatHandNameIt(category, tb) {
  const r = (v) => RANK_NAMES_IT[v] || String(v);
  switch (category) {
    case 9:
      return "Scala Reale";
    case 8:
      return `Scala Colore al ${r(tb[0])}`;
    case 7:
      return `Poker di ${r(tb[0])}`;
    case 6:
      return `Full di ${r(tb[0])} e ${r(tb[1])}`;
    case 5:
      return `Colore al ${r(tb[0])}`;
    case 4:
      return `Scala al ${r(tb[0])}`;
    case 3:
      return `Tris di ${r(tb[0])}`;
    case 2:
      return `Doppia Coppia (${r(tb[0])} e ${r(tb[1])})`;
    case 1:
      return `Coppia di ${r(tb[0])}`;
    default:
      return `Carta Alta ${r(tb[0])}`;
  }
}

/**
 * Valuta la migliore mano a 5 carte tra 5, 6 o 7 carte disponibili.
 */
export function evaluateBestHand(cards) {
  if (!cards || cards.length < 5) return null;
  if (cards.length === 5) {
    const res = evaluate5Cards(cards);
    return { ...res, bestFive: [...cards] };
  }

  let best = null;
  const n = cards.length;
  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) {
            const combo = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const evalRes = evaluate5Cards(combo);
            if (!best || evalRes.score > best.score) {
              best = { ...evalRes, bestFive: combo };
            }
          }
        }
      }
    }
  }
  return best;
}

/**
 * Calcola il Main Pot e gli eventuali Side Pots in base a totalBetInHand di tutti i giocatori.
 * Gestisce correttamente anche le fiches morte di giocatori che hanno foldato.
 */
export function calculatePots(players) {
  const contributors = players.filter((p) => (p.totalBetInHand || 0) > 0);
  if (contributors.length === 0) return [];

  // Livelli di puntata di giocatori NON foldati (o unico max se tutti foldati tranne uno)
  const levels = [
    ...new Set(
      contributors
        .filter((p) => !p.folded)
        .map((p) => p.totalBetInHand)
    )
  ].sort((a, b) => a - b);

  // Se c'è puntata residua oltre il max livello non-foldato (raro, es. player folda dopo bet), aggiungiamo il max
  const maxAnyBet = Math.max(...contributors.map((p) => p.totalBetInHand));
  if (levels.length === 0 || maxAnyBet > levels[levels.length - 1]) {
    levels.push(maxAnyBet);
  }

  const rawPots = [];
  let prevLevel = 0;

  for (const level of levels) {
    const delta = level - prevLevel;
    if (delta <= 0) continue;

    let amount = 0;
    const eligibleIds = [];

    for (const p of contributors) {
      const contributed = Math.max(0, Math.min(p.totalBetInHand, level) - prevLevel);
      amount += contributed;
      if (!p.folded && p.totalBetInHand >= level) {
        eligibleIds.push(p.id);
      }
    }

    if (amount > 0) {
      // Unisci pot consecutivi con gli stessi aventi diritto
      const prevPot = rawPots[rawPots.length - 1];
      if (
        prevPot &&
        prevPot.eligibleIds.length === eligibleIds.length &&
        prevPot.eligibleIds.every((id, idx) => id === eligibleIds[idx])
      ) {
        prevPot.amount += amount;
      } else {
        rawPots.push({
          name: rawPots.length === 0 ? "Piatto Principale" : `Side Pot ${rawPots.length}`,
          amount,
          eligibleIds
        });
      }
    }
    prevLevel = level;
  }

  // Se l'ultimo pot ha 0 eligibleIds (dead money sopra tutti), uniscilo al precedente
  if (rawPots.length > 1 && rawPots[rawPots.length - 1].eligibleIds.length === 0) {
    const dead = rawPots.pop();
    rawPots[rawPots.length - 1].amount += dead.amount;
  }

  return rawPots;
}

/**
 * Restituisce il livello bui corrente in base al tempo trascorso dall'inizio partita.
 */
export function getCurrentBlindLevel(speedKey, startedAt, now = Date.now()) {
  const schedule = BLIND_SCHEDULES[speedKey] || BLIND_SCHEDULES.normal;
  const elapsed = Math.max(0, now - (startedAt || now));
  const levelIndex = Math.min(
    schedule.levels.length - 1,
    Math.floor(elapsed / schedule.intervalMs)
  );
  const current = schedule.levels[levelIndex];
  const nextLevelAt = (startedAt || now) + (levelIndex + 1) * schedule.intervalMs;
  return {
    levelIndex,
    levelNumber: levelIndex + 1,
    sb: current.sb,
    bb: current.bb,
    ante: current.ante || 0,
    intervalMs: schedule.intervalMs,
    nextLevelAt,
    isMaxLevel: levelIndex === schedule.levels.length - 1
  };
}

/**
 * Trova il prossimo indice occupato che soddisfa un predicato, in senso orario.
 */
function findNextIndex(players, fromIndex, predicate) {
  const n = players.length;
  for (let offset = 1; offset <= n; offset++) {
    const idx = (fromIndex + offset) % n;
    if (predicate(players[idx], idx)) {
      return idx;
    }
  }
  return -1;
}

/**
 * Inizializza una nuova mano su un oggetto tavolo esistente.
 * Rimuove i giocatori eliminati (stack <= 0) marcandoli `eliminated: true`.
 */
export function startNewHand(tableState, now = Date.now()) {
  const table = JSON.parse(JSON.stringify(tableState));

  // Segna eliminati i giocatori con 0 fiches
  table.players.forEach((p) => {
    if (p.stack <= 0) {
      p.eliminated = true;
      p.folded = true;
    }
  });

  const aliveIndices = table.players
    .map((p, i) => (!p.eliminated && p.stack > 0 ? i : -1))
    .filter((i) => i !== -1);

  if (aliveIndices.length < 2) {
    table.phase = "TOURNAMENT_OVER";
    table.winnerId = aliveIndices.length === 1 ? table.players[aliveIndices[0]].id : null;
    table.turnIndex = -1;
    return table;
  }

  // Aggiorna livello bui
  const blindInfo = getCurrentBlindLevel(table.blindSpeed, table.startedAt, now);
  table.blindLevel = blindInfo.levelNumber;
  table.smallBlind = blindInfo.sb;
  table.bigBlind = blindInfo.bb;
  table.ante = blindInfo.ante;

  table.handNumber = (table.handNumber || 0) + 1;
  table.actionSeq = (table.actionSeq || 0) + 1;
  table.phase = "PREFLOP";
  table.communityCards = [];
  table.burnedCards = [];
  table.pendingStep = null;
  table.showdownResults = null;
  table.lastActionText = `Mano #${table.handNumber} · Bui ${blindInfo.sb}/${blindInfo.bb}`;

  // Unico mazzo standard da 52 carte mescolato per la mano
  table.deck = shuffleDeck(createDeck());

  // Reset stato giocatori per la nuova mano
  table.players.forEach((p) => {
    p.cards = [];
    p.bet = 0;
    p.totalBetInHand = 0;
    p.folded = Boolean(p.eliminated || p.stack <= 0);
    p.allIn = false;
    p.hasActedThisRound = false;
    p.lastAction = p.eliminated ? "Eliminato" : "";
    p.handEval = null;
  });

  // Ruota Bottone Dealer
  if (table.dealerIndex === undefined || table.dealerIndex < 0) {
    table.dealerIndex = aliveIndices[0];
  } else {
    table.dealerIndex = findNextIndex(
      table.players,
      table.dealerIndex,
      (p) => !p.eliminated && p.stack > 0
    );
  }

  const isHeadsUp = aliveIndices.length === 2;
  let sbIndex, bbIndex;

  if (isHeadsUp) {
    // Regola ufficiale Heads-Up: il Dealer mette lo Small Blind
    sbIndex = table.dealerIndex;
    bbIndex = findNextIndex(table.players, sbIndex, (p) => !p.eliminated);
  } else {
    sbIndex = findNextIndex(table.players, table.dealerIndex, (p) => !p.eliminated);
    bbIndex = findNextIndex(table.players, sbIndex, (p) => !p.eliminated);
  }

  table.sbIndex = sbIndex;
  table.bbIndex = bbIndex;

  // Ante (se prevista dal livello)
  if (blindInfo.ante > 0) {
    for (const idx of aliveIndices) {
      const p = table.players[idx];
      const antePaid = Math.min(p.stack, blindInfo.ante);
      p.stack -= antePaid;
      p.totalBetInHand += antePaid;
      if (p.stack === 0) p.allIn = true;
    }
  }

  // Post Small Blind
  const sbPlayer = table.players[sbIndex];
  const sbPaid = Math.min(sbPlayer.stack, blindInfo.sb);
  sbPlayer.stack -= sbPaid;
  sbPlayer.bet = sbPaid;
  sbPlayer.totalBetInHand += sbPaid;
  sbPlayer.lastAction = `SB ${sbPaid}`;
  if (sbPlayer.stack === 0) sbPlayer.allIn = true;

  // Post Big Blind
  const bbPlayer = table.players[bbIndex];
  const bbPaid = Math.min(bbPlayer.stack, blindInfo.bb);
  bbPlayer.stack -= bbPaid;
  bbPlayer.bet = bbPaid;
  bbPlayer.totalBetInHand += bbPaid;
  bbPlayer.lastAction = `BB ${bbPaid}`;
  if (bbPlayer.stack === 0) bbPlayer.allIn = true;

  // Distribuisci 2 carte coperte a ogni giocatore attivo dall'unico mazzo da 52
  for (let round = 0; round < 2; round++) {
    for (const idx of aliveIndices) {
      table.players[idx].cards.push(drawUniqueCard(table));
    }
  }

  table.currentBet = Math.max(sbPaid, bbPaid, blindInfo.bb);
  table.minRaiseIncrement = blindInfo.bb;
  table.pot = table.players.reduce((sum, p) => sum + p.totalBetInHand, 0);
  table.pots = calculatePots(table.players);

  // Primo a parlare preflop: in Heads-Up parla lo SB (Dealer), altrimenti UTG (a sinistra del BB)
  const firstTurnStart = isHeadsUp ? sbIndex : bbIndex;
  const firstCanAct = findNextIndex(
    table.players,
    isHeadsUp ? bbIndex : firstTurnStart,
    (p) => !p.folded && !p.allIn
  );

  // Controlla se tutti (o tutti tranne 1) sono già all-in per i bui -> runout progressivo
  const canActCount = table.players.filter((p) => !p.folded && !p.allIn).length;
  if (canActCount <= 1) {
    table.turnIndex = -1;
    table.turnDeadline = 0;
    table.pendingStep = { type: "ADVANCE_STREET", executeAt: now + 1500 };
    return table;
  }

  table.turnIndex = firstCanAct;
  table.turnDeadline = now + (table.turnDurationMs || 30_000);
  return table;
}

/**
 * Calcola le opzioni di puntata legali per il giocatore di turno.
 */
export function getLegalActions(table, playerId) {
  if (!table || table.turnIndex < 0) return null;
  const activePlayer = table.players[table.turnIndex];
  if (!activePlayer || activePlayer.id !== playerId || activePlayer.folded || activePlayer.allIn) {
    return null;
  }

  const toCall = Math.max(0, (table.currentBet || 0) - (activePlayer.bet || 0));
  const canCheck = toCall === 0;
  const callAmount = Math.min(activePlayer.stack, toCall);
  const maxBetTotal = activePlayer.bet + activePlayer.stack;
  const minRaiseTotal = Math.min(
    maxBetTotal,
    (table.currentBet || 0) + Math.max(table.minRaiseIncrement || table.bigBlind, table.bigBlind)
  );
  const canRaise = activePlayer.stack > toCall;

  return {
    canFold: !canCheck,
    canCheck,
    callAmount,
    isCallAllIn: callAmount > 0 && callAmount >= activePlayer.stack,
    canRaise,
    isRaiseAllInOnly: canRaise && maxBetTotal <= minRaiseTotal,
    minRaiseTotal,
    maxBetTotal,
    pot: table.pot || 0,
    playerBet: activePlayer.bet || 0,
    playerStack: activePlayer.stack
  };
}

/**
 * Applica l'azione di un giocatore e fa avanzare il giro o la street.
 * @param {object} tableState
 * @param {string} playerId
 * @param {string} actionType - 'fold' | 'check' | 'call' | 'raise' | 'allin'
 * @param {number} raiseToAmount - puntata totale desiderata nel giro corrente (per 'raise')
 * @param {number} now
 */
export function applyPlayerAction(tableState, playerId, actionType, raiseToAmount = 0, now = Date.now()) {
  const table = JSON.parse(JSON.stringify(tableState));
  if (
    table.phase !== "PREFLOP" &&
    table.phase !== "FLOP" &&
    table.phase !== "TURN" &&
    table.phase !== "RIVER"
  ) {
    return table;
  }

  const idx = table.turnIndex;
  const player = table.players[idx];
  if (!player || player.id !== playerId) {
    return tableState; // Non è il turno di questo giocatore
  }

  const legal = getLegalActions(table, playerId);
  if (!legal) return tableState;

  table.pendingStep = null;
  table.actionSeq = (table.actionSeq || 0) + 1;

  if (actionType === "fold") {
    player.folded = true;
    player.hasActedThisRound = true;
    player.lastAction = "Fold";
    table.lastActionText = `${player.name} passa (Fold)`;
  } else if (actionType === "check") {
    if (!legal.canCheck) {
      // Fallback sicuro se tenta check quando deve chiamare
      return applyPlayerAction(tableState, playerId, "fold", 0, now);
    }
    player.hasActedThisRound = true;
    player.lastAction = "Check";
    table.lastActionText = `${player.name} fa Check`;
  } else if (actionType === "call") {
    const pay = legal.callAmount;
    player.stack -= pay;
    player.bet += pay;
    player.totalBetInHand += pay;
    player.hasActedThisRound = true;
    if (player.stack === 0) {
      player.allIn = true;
      player.lastAction = `All-In ${player.bet}`;
      table.lastActionText = `${player.name} va All-In per Call (${player.bet})`;
    } else {
      player.lastAction = `Call ${pay}`;
      table.lastActionText = `${player.name} vede (${pay})`;
    }
  } else if (actionType === "raise" || actionType === "allin") {
    let targetBet =
      actionType === "allin"
        ? legal.maxBetTotal
        : Math.max(legal.minRaiseTotal, Math.min(legal.maxBetTotal, Math.floor(raiseToAmount)));

    if (targetBet <= table.currentBet && targetBet < legal.maxBetTotal) {
      targetBet = legal.minRaiseTotal;
    }

    const added = Math.max(0, targetBet - player.bet);
    const actualAdded = Math.min(player.stack, added);
    const finalBet = player.bet + actualAdded;
    const isOpeningBet = table.currentBet === 0;
    const raiseDelta = finalBet - table.currentBet;

    player.stack -= actualAdded;
    player.bet = finalBet;
    player.totalBetInHand += actualAdded;
    player.hasActedThisRound = true;

    if (finalBet > table.currentBet) {
      // Se è un rilancio completo (o apertura), riapre il giro agli altri
      if (raiseDelta >= table.minRaiseIncrement || isOpeningBet) {
        table.minRaiseIncrement = Math.max(table.minRaiseIncrement, raiseDelta);
        table.players.forEach((p, i) => {
          if (i !== idx && !p.folded && !p.allIn) {
            p.hasActedThisRound = false;
          }
        });
      }
      table.currentBet = finalBet;
    }

    if (player.stack === 0) {
      player.allIn = true;
      player.lastAction = `All-In ${finalBet}`;
      table.lastActionText = `${player.name} va All-In (${finalBet})`;
    } else if (isOpeningBet) {
      player.lastAction = `Bet ${finalBet}`;
      table.lastActionText = `${player.name} punta ${finalBet}`;
    } else {
      player.lastAction = `Raise ${finalBet}`;
      table.lastActionText = `${player.name} rilancia a ${finalBet}`;
    }
  }

  table.pot = table.players.reduce((sum, p) => sum + p.totalBetInHand, 0);
  table.pots = calculatePots(table.players);

  // 1. Controlla se è rimasto un solo giocatore non foldato -> vittoria immediata
  const remaining = table.players.filter((p) => !p.folded);
  if (remaining.length === 1) {
    return resolveFoldWin(table, remaining[0], now);
  }

  // 2. Controlla se il giro di puntate corrente è concluso
  const pendingToAct = table.players.filter(
    (p) => !p.folded && !p.allIn && (!p.hasActedThisRound || p.bet < table.currentBet)
  );

  if (pendingToAct.length > 0) {
    const nextIdx = findNextIndex(
      table.players,
      idx,
      (p) => !p.folded && !p.allIn && (!p.hasActedThisRound || p.bet < table.currentBet)
    );
    table.turnIndex = nextIdx;
    table.turnDeadline = now + (table.turnDurationMs || 30_000);
    return table;
  }

  // 3. Giro di puntate concluso -> pausa breve per mostrare l'ultima azione prima di servire la street successiva
  table.turnIndex = -1;
  table.turnDeadline = 0;
  table.pendingStep = {
    type: table.phase === "RIVER" ? "RESOLVE_SHOWDOWN" : "ADVANCE_STREET",
    executeAt: now + 1050
  };
  return table;
}

/**
 * Esegue il passaggio di fase pianificato (nuova street, runout progressivo All-In o Showdown).
 */
export function applyPendingStep(tableState, now = Date.now()) {
  if (!tableState || !tableState.pendingStep) return tableState;
  const table = JSON.parse(JSON.stringify(tableState));
  const step = table.pendingStep;
  table.pendingStep = null;
  table.actionSeq = (table.actionSeq || 0) + 1;

  if (step.type === "RESOLVE_SHOWDOWN") {
    table.players.forEach((p) => {
      p.bet = 0;
    });
    return resolveShowdown(table, now);
  }

  if (step.type === "ADVANCE_STREET") {
    const canStillBet = table.players.filter((p) => !p.folded && !p.allIn);
    if (canStillBet.length <= 1) {
      return advanceSingleRunoutStreet(table, now);
    }
    return advanceStreet(table, now);
  }

  return table;
}

function advanceSingleRunoutStreet(table, now) {
  table.players.forEach((p) => {
    p.bet = 0;
    p.hasActedThisRound = false;
  });
  table.currentBet = 0;

  if (table.phase === "PREFLOP") {
    table.phase = "FLOP";
    burnUniqueCard(table);
    table.communityCards.push(drawUniqueCard(table), drawUniqueCard(table), drawUniqueCard(table));
    table.lastActionText = "Flop servito";
    table.turnIndex = -1;
    table.pendingStep = { type: "ADVANCE_STREET", executeAt: now + 1500 };
    return table;
  }
  if (table.phase === "FLOP") {
    table.phase = "TURN";
    burnUniqueCard(table);
    table.communityCards.push(drawUniqueCard(table));
    table.lastActionText = "Turn servito";
    table.turnIndex = -1;
    table.pendingStep = { type: "ADVANCE_STREET", executeAt: now + 1350 };
    return table;
  }
  if (table.phase === "TURN") {
    table.phase = "RIVER";
    burnUniqueCard(table);
    table.communityCards.push(drawUniqueCard(table));
    table.lastActionText = "River servito";
    table.turnIndex = -1;
    table.pendingStep = { type: "RESOLVE_SHOWDOWN", executeAt: now + 1350 };
    return table;
  }

  return resolveShowdown(table, now);
}

function advanceStreet(table, now) {
  // Reset puntate del giro precedente
  table.players.forEach((p) => {
    p.bet = 0;
    p.hasActedThisRound = false;
    if (!p.folded && !p.allIn) {
      p.lastAction = "";
    }
  });
  table.currentBet = 0;
  table.minRaiseIncrement = table.bigBlind;

  if (table.phase === "PREFLOP") {
    table.phase = "FLOP";
    burnUniqueCard(table);
    table.communityCards.push(drawUniqueCard(table), drawUniqueCard(table), drawUniqueCard(table));
    table.lastActionText = "Flop servito";
  } else if (table.phase === "FLOP") {
    table.phase = "TURN";
    burnUniqueCard(table);
    table.communityCards.push(drawUniqueCard(table));
    table.lastActionText = "Turn servito";
  } else if (table.phase === "TURN") {
    table.phase = "RIVER";
    burnUniqueCard(table);
    table.communityCards.push(drawUniqueCard(table));
    table.lastActionText = "River servito";
  } else if (table.phase === "RIVER") {
    return resolveShowdown(table, now);
  }

  // Postflop parla per primo il giocatore attivo subito a sinistra del Dealer
  const nextIdx = findNextIndex(
    table.players,
    table.dealerIndex,
    (p) => !p.folded && !p.allIn
  );
  table.turnIndex = nextIdx;
  table.turnDeadline = now + (table.turnDurationMs || 30_000);
  return table;
}

function resolveFoldWin(table, winner, now) {
  const totalPot = table.players.reduce((sum, p) => sum + p.totalBetInHand, 0);
  table.players.forEach((p) => {
    p.bet = 0;
  });
  winner.stack += totalPot;
  table.phase = "SHOWDOWN";
  table.turnIndex = -1;
  table.pendingStep = null;
  table.nextHandAt = now + 2600;
  table.showdownResults = {
    isFoldWin: true,
    pots: [
      {
        name: "Piatto Principale",
        amount: totalPot,
        winners: [{ id: winner.id, name: winner.name, share: totalPot, handName: "Avversari ritirati" }]
      }
    ]
  };
  table.lastActionText = `${winner.name} vince ${totalPot} fiches`;
  return checkEliminationsAndFinish(table, now);
}

function resolveShowdown(table, now) {
  table.players.forEach((p) => {
    p.bet = 0;
  });
  table.phase = "SHOWDOWN";
  table.turnIndex = -1;
  table.pendingStep = null;
  table.nextHandAt = now + 5200;

  // Valuta le mani dei giocatori ancora in gioco
  for (const p of table.players) {
    if (!p.folded && p.cards && p.cards.length === 2) {
      p.handEval = evaluateBestHand([...p.cards, ...table.communityCards]);
    }
  }

  const pots = calculatePots(table.players);
  const potResults = [];

  for (const pot of pots) {
    const contenders = pot.eligibleIds
      .map((id) => table.players.find((p) => p.id === id))
      .filter((p) => p && !p.folded && p.handEval);

    if (contenders.length === 0) continue;

    const maxScore = Math.max(...contenders.map((c) => c.handEval.score));
    const tiedWinners = contenders.filter((c) => c.handEval.score === maxScore);

    // Ordina i vincitori in senso orario partendo da sinistra del Dealer per l'eventuale chip dispari
    const n = table.players.length;
    tiedWinners.sort((a, b) => {
      const idxA = table.players.findIndex((p) => p.id === a.id);
      const idxB = table.players.findIndex((p) => p.id === b.id);
      const distA = (idxA - table.dealerIndex - 1 + n) % n;
      const distB = (idxB - table.dealerIndex - 1 + n) % n;
      return distA - distB;
    });

    const baseShare = Math.floor(pot.amount / tiedWinners.length);
    let remainder = pot.amount % tiedWinners.length;

    const winnerEntries = [];
    for (const w of tiedWinners) {
      const extra = remainder > 0 ? 1 : 0;
      if (remainder > 0) remainder--;
      const won = baseShare + extra;
      w.stack += won;
      winnerEntries.push({
        id: w.id,
        name: w.name,
        share: won,
        handName: w.handEval.nameIt,
        bestFive: w.handEval.bestFive
      });
    }

    potResults.push({
      name: pot.name,
      amount: pot.amount,
      winners: winnerEntries
    });
  }

  table.showdownResults = {
    isFoldWin: false,
    pots: potResults
  };

  if (potResults.length > 0 && potResults[0].winners.length > 0) {
    const mainW = potResults[0].winners.map((w) => `${w.name} (${w.handName})`).join(" & ");
    table.lastActionText = `Showdown: ${mainW}`;
  }

  return checkEliminationsAndFinish(table, now);
}

function checkEliminationsAndFinish(table, now) {
  let bustedCount = 0;
  table.players.forEach((p) => {
    if (p.stack <= 0 && !p.eliminated) {
      p.eliminated = true;
      p.eliminatedAt = now;
      bustedCount++;
    }
  });

  const survivors = table.players.filter((p) => !p.eliminated && p.stack > 0);
  if (survivors.length === 1 && !table.isMultiTablePart) {
    table.phase = "TOURNAMENT_OVER";
    table.winnerId = survivors[0].id;
    table.finishedAt = now;
  } else if (bustedCount > 0 && survivors.length <= 1 && table.isMultiTablePart) {
    // Segna che questo tavolo MTT ha un unico superstite pronto per consolidamento
    table.tableComplete = true;
  }

  return table;
}

/**
 * Motore decisionale AI per i Bot al tavolo singolo.
 * Valuta forza preflop/postflop, pot odds, progetti di colore/scala e stile del bot.
 * Restituisce { actionType: 'fold'|'check'|'call'|'raise', raiseToAmount: number }
 */
export function decideBotAction(table, botPlayer) {
  const legal = getLegalActions(table, botPlayer.id);
  if (!legal) return { actionType: "check", raiseToAmount: 0 };

  const style = botPlayer.botStyle || "balanced"; // "tight" | "balanced" | "aggressive"
  const aggFactor = style === "aggressive" ? 1.18 : style === "tight" ? 0.84 : 1.0;
  const roll = Math.random();

  // Calcola forza mano normalizzata [0..1]
  let strength = 0.25;
  const hole = (botPlayer.cards || []).map(parseCard);
  const board = (table.communityCards || []).map(parseCard);

  if (hole.length === 2 && board.length === 0) {
    // Valutazione Preflop (Chen-inspired normalizzata)
    const high = Math.max(hole[0].value, hole[1].value);
    const low = Math.min(hole[0].value, hole[1].value);
    const isPair = high === low;
    const suited = hole[0].suit === hole[1].suit;
    const gap = high - low;

    let score = 0;
    if (isPair) {
      score = 0.52 + (high / 14) * 0.46; // 22 -> ~0.58, AA -> ~0.98
    } else {
      score = (high + low) / 28 * 0.55;
      if (suited) score += 0.08;
      if (gap <= 2) score += 0.06;
      if (high >= 12 && low >= 10) score += 0.12;
      if (high === 14 && low >= 9) score += 0.08;
    }
    strength = Math.min(0.99, Math.max(0.12, score));
  } else if (hole.length === 2 && board.length >= 3) {
    // Valutazione Postflop
    const evalRes = evaluateBestHand([...botPlayer.cards, ...table.communityCards]);
    const cat = evalRes ? evalRes.category : 0;
    const baseByCat = [0.22, 0.48, 0.66, 0.78, 0.84, 0.88, 0.94, 0.98, 0.99, 1.0];
    strength = baseByCat[cat] || 0.22;

    // Affinamento per Top Pair / Overpair
    if (cat === 1) {
      const topBoard = Math.max(...board.map((c) => c.value));
      const pairedRank = evalRes.tiebreakers[0];
      if (pairedRank >= topBoard) strength += 0.1;
    }

    // Bonus progetto colore / scala al flop o turn
    if (board.length < 5 && cat < 4) {
      const all = [...hole, ...board];
      const suitCounts = {};
      all.forEach((c) => {
        suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1;
      });
      if (Object.values(suitCounts).some((cnt) => cnt === 4)) {
        strength += 0.16; // Flush draw
      }
      const vals = [...new Set(all.map((c) => c.value))].sort((a, b) => a - b);
      for (let i = 0; i <= vals.length - 4; i++) {
        if (vals[i + 3] - vals[i] <= 4) {
          strength += 0.11; // Straight draw
          break;
        }
      }
    }
    strength = Math.min(0.99, strength);
  }

  const adjusted = Math.min(0.99, strength * aggFactor);
  const toCall = legal.callAmount;
  const potOdds = toCall > 0 ? toCall / Math.max(1, legal.pot + toCall) : 0;
  const bb = table.bigBlind || 20;

  // Caso 1: Può fare Check gratuitamente
  if (legal.canCheck) {
    if (legal.canRaise && (adjusted > 0.64 || (adjusted > 0.45 && roll < 0.24 * aggFactor) || roll < 0.08 * aggFactor)) {
      const sizingMult = adjusted > 0.82 ? 0.75 : 0.5;
      let target = Math.floor(Math.max(legal.minRaiseTotal, legal.pot * sizingMult));
      target = Math.min(legal.maxBetTotal, Math.max(legal.minRaiseTotal, target));
      return { actionType: "raise", raiseToAmount: target };
    }
    return { actionType: "check", raiseToAmount: 0 };
  }

  // Caso 2: Deve chiamare una puntata
  // Pressioni all-in alte rispetto allo stack
  const stackRatio = toCall / Math.max(1, botPlayer.stack);
  const callThreshold = Math.max(0.24, potOdds * 1.15 + stackRatio * 0.25);

  if (adjusted < callThreshold && roll > 0.09 * aggFactor) {
    // Poca equity rispetto al prezzo -> Fold (salvo call economico preflop con BB)
    if (toCall <= bb * 0.5 && adjusted > 0.26) {
      return { actionType: "call", raiseToAmount: 0 };
    }
    return { actionType: "fold", raiseToAmount: 0 };
  }

  // Rilancio con mani molto forti o semi-bluff occasionale
  if (
    legal.canRaise &&
    ((adjusted > 0.76 && roll < 0.65 * aggFactor) || (adjusted > 0.58 && roll < 0.16 * aggFactor))
  ) {
    const raiseSize =
      adjusted > 0.88 && stackRatio > 0.45
        ? legal.maxBetTotal
        : Math.floor((table.currentBet || bb) + Math.max(table.minRaiseIncrement || bb, legal.pot * 0.55));
    const clamped = Math.min(legal.maxBetTotal, Math.max(legal.minRaiseTotal, raiseSize));
    return { actionType: "raise", raiseToAmount: clamped };
  }

  return { actionType: "call", raiseToAmount: 0 };
}

