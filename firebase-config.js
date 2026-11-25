/**
 * firebase-config.js
 * -----------------------------------------------------------------------------
 * Integrazione reale con Firebase Firestore & Firebase Authentication (Google Sign-In).
 * Usa la configurazione generata in `./firebase-applet-config.json` e gestisce
 * il database Enterprise tramite `getFirestore(app, firebaseConfig.firestoreDatabaseId)`.
 *
 * Include anche la validazione iniziale `testConnection()`, gestione errori
 * strutturata `handleFirestoreError` e fallback locale multi-scheda solo se la
 * configurazione Firebase mancasse.
 * -----------------------------------------------------------------------------
 */

import { initializeApp } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "firebase/firestore";
import firebaseConfig from "./firebase-applet-config.json";

export const FIREBASE_CONFIG = firebaseConfig;

export const OperationType = Object.freeze({
  CREATE: "create",
  UPDATE: "update",
  DELETE: "delete",
  LIST: "list",
  GET: "get",
  WRITE: "write"
});

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export function isFirebaseConfigured() {
  return Boolean(
    firebaseConfig &&
      firebaseConfig.apiKey &&
      firebaseConfig.projectId &&
      firebaseConfig.firestoreDatabaseId &&
      !String(firebaseConfig.projectId).includes("remixed-project-id")
  );
}

export function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid || null,
      email: auth.currentUser?.email || null,
      emailVerified: auth.currentUser?.emailVerified ?? null,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      tenantId: auth.currentUser?.tenantId || null,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email
        })) || []
    },
    operationType,
    path
  };
  console.error("Firestore Error: ", JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, "test", "connection"));
  } catch (error) {
    if (error instanceof Error && error.message.includes("the client is offline")) {
      console.error("Please check your Firebase configuration.");
    }
  }
}

if (isFirebaseConfigured()) {
  testConnection();
}

// ============================================================================
// UTILITY DI SANITIZZAZIONE & HASHING PER FIRESTORE
// ============================================================================
function stripUndefined(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function splitPath(path) {
  return String(path || "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function hashInviteCode(tournId, code) {
  const normalized = String(code || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
  const text = `${tournId}:${normalized}`;
  const encoded = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeTablePayload(rawTable, existingCreatedAt = null) {
  const clean = stripUndefined(rawTable) || {};
  const players = Array.isArray(clean.players) ? clean.players.slice(0, 9) : [];
  const playerIds = [...new Set(players.filter((p) => p && !p.isBot && p.id).map((p) => String(p.id)))];

  return {
    id: String(clean.id || ""),
    mode: clean.mode || "bots",
    tournamentId: String(clean.tournamentId || ""),
    ownerId: String(clean.ownerId || ""),
    isMultiTablePart: Boolean(clean.isMultiTablePart),
    title: String(clean.title || "Tavolo Poker").slice(0, 80),
    buyIn: Number(clean.buyIn || 0),
    multiplier: clean.multiplier !== undefined && clean.multiplier !== null ? Number(clean.multiplier) : null,
    prizePool: Number(clean.prizePool || 0),
    payouts: Array.isArray(clean.payouts) ? clean.payouts.slice(0, 5) : [{ rank: 1, pct: 100 }],
    blindSpeed: clean.blindSpeed || "normal",
    turnDurationMs: Number(clean.turnDurationMs || 30000),
    spinStartedAt: clean.spinStartedAt !== undefined && clean.spinStartedAt !== null ? Number(clean.spinStartedAt) : null,
    spinDurationMs: clean.spinDurationMs !== undefined && clean.spinDurationMs !== null ? Number(clean.spinDurationMs) : null,
    startedAt: Number(clean.startedAt || Date.now()),
    phase: clean.phase || "PREFLOP",
    handNumber: Number(clean.handNumber || 0),
    actionSeq: Number(clean.actionSeq || 0),
    dealerIndex: Number(clean.dealerIndex ?? -1),
    turnIndex: Number(clean.turnIndex ?? -1),
    turnDeadline: clean.turnDeadline !== undefined && clean.turnDeadline !== null ? Number(clean.turnDeadline) : null,
    pot: Number(clean.pot || 0),
    pots: Array.isArray(clean.pots) ? clean.pots.slice(0, 9) : [],
    currentBet: Number(clean.currentBet || 0),
    minRaiseIncrement: Number(clean.minRaiseIncrement || 0),
    smallBlind: Number(clean.smallBlind || 10),
    bigBlind: Number(clean.bigBlind || 20),
    deck: Array.isArray(clean.deck) ? clean.deck.slice(0, 52) : [],
    communityCards: Array.isArray(clean.communityCards) ? clean.communityCards.slice(0, 5) : [],
    players,
    playerIds,
    lastActionText: String(clean.lastActionText || "").slice(0, 180),
    pendingStep: clean.pendingStep ?? null,
    showdownResults: clean.showdownResults ?? null,
    nextHandAt: clean.nextHandAt !== undefined && clean.nextHandAt !== null ? Number(clean.nextHandAt) : null,
    tableComplete: Boolean(clean.tableComplete),
    winnerName: String(clean.winnerName || "").slice(0, 40),
    createdAt: existingCreatedAt || serverTimestamp(),
    updatedAt: serverTimestamp()
  };
}

function buildTableUpdateFields(normalizedTable) {
  return {
    phase: normalizedTable.phase,
    handNumber: normalizedTable.handNumber,
    actionSeq: normalizedTable.actionSeq,
    dealerIndex: normalizedTable.dealerIndex,
    turnIndex: normalizedTable.turnIndex,
    turnDeadline: normalizedTable.turnDeadline,
    pot: normalizedTable.pot,
    pots: normalizedTable.pots,
    currentBet: normalizedTable.currentBet,
    minRaiseIncrement: normalizedTable.minRaiseIncrement,
    smallBlind: normalizedTable.smallBlind,
    bigBlind: normalizedTable.bigBlind,
    deck: normalizedTable.deck,
    communityCards: normalizedTable.communityCards,
    players: normalizedTable.players,
    lastActionText: normalizedTable.lastActionText,
    pendingStep: normalizedTable.pendingStep,
    showdownResults: normalizedTable.showdownResults,
    nextHandAt: normalizedTable.nextHandAt,
    tableComplete: normalizedTable.tableComplete,
    winnerName: normalizedTable.winnerName,
    updatedAt: serverTimestamp()
  };
}

function normalizeTournamentForCreate(raw) {
  const clean = stripUndefined(raw) || {};
  const players = Array.isArray(clean.players) ? clean.players.slice(0, 18) : [];
  const playerIds = players.map((p) => String(p.id));
  return {
    id: String(clean.id || ""),
    name: String(clean.name || "Torneo").slice(0, 60),
    visibility: clean.visibility === "private" ? "private" : "public",
    inviteCode: clean.visibility === "private" ? "" : String(clean.inviteCode || "").slice(0, 16),
    inviteCodeHash: String(clean.inviteCodeHash || "").slice(0, 128),
    maxPlayers: Number(clean.maxPlayers || 6),
    buyIn: Number(clean.buyIn || 0),
    startingStack: Number(clean.startingStack || 3000),
    blindSpeed: clean.blindSpeed || "normal",
    startMode: clean.startMode || "full",
    scheduledStartAt:
      clean.scheduledStartAt !== undefined && clean.scheduledStartAt !== null
        ? Number(clean.scheduledStartAt)
        : null,
    startedAt: clean.startedAt !== undefined && clean.startedAt !== null ? Number(clean.startedAt) : null,
    cancelledAt: clean.cancelledAt !== undefined && clean.cancelledAt !== null ? Number(clean.cancelledAt) : null,
    status: clean.status || "registering",
    creatorId: String(clean.creatorId || ""),
    createdAtMs: Number(clean.createdAtMs || clean.createdAt || Date.now()),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    players,
    playerIds,
    tableIds: Array.isArray(clean.tableIds) ? clean.tableIds.slice(0, 4) : [],
    finalTableId: String(clean.finalTableId || "").slice(0, 128),
    winnerName: String(clean.winnerName || "").slice(0, 40)
  };
}

function fromFirestoreTournament(data) {
  if (!data) return null;
  const copy = { ...data };
  // Ripristina createdAt numerico per compatibilità ordinamento UI
  if (typeof copy.createdAtMs === "number") {
    copy.createdAt = copy.createdAtMs;
  }
  return copy;
}

// ============================================================================
// AUTENTICAZIONE GOOGLE & PROFILO GIOCATORE
// ============================================================================
export function subscribeAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const cred = await signInWithPopup(auth, provider);
  return cred.user;
}

export async function signOutGoogle() {
  await signOut(auth);
}

export async function loadOrCreateUserProfile(uid, preferredName = "", preferredColor = "#b91c1c") {
  const path = `users/${uid}`;
  const ref = doc(db, "users", uid);
  let snap;
  try {
    snap = await getDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  const sanitizedName = String(preferredName || "")
    .trim()
    .slice(0, 18);

  if (!snap.exists()) {
    const finalName = sanitizedName.length >= 2 ? sanitizedName : "Giocatore";
    const profilePayload = {
      id: uid,
      name: finalName,
      color: String(preferredColor || "#b91c1c").slice(0, 16),
      balance: 10000,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };
    try {
      await setDoc(ref, profilePayload);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
    return {
      id: uid,
      name: profilePayload.name,
      color: profilePayload.color,
      balance: 10000
    };
  }

  const existing = snap.data();
  const nextName = sanitizedName.length >= 2 ? sanitizedName : existing.name;
  const nextColor = preferredColor ? String(preferredColor).slice(0, 16) : existing.color;

  if (nextName !== existing.name || nextColor !== existing.color) {
    try {
      await updateDoc(ref, {
        name: nextName,
        color: nextColor,
        updatedAt: serverTimestamp()
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
  }

  return {
    id: uid,
    name: nextName,
    color: nextColor,
    balance: Number(existing.balance ?? 10000)
  };
}

export async function syncUserProfileToCloud(player) {
  if (!auth.currentUser || !player || player.id !== auth.currentUser.uid) return;
  const path = `users/${player.id}`;
  const ref = doc(db, "users", player.id);
  try {
    await updateDoc(ref, {
      name: String(player.name || "Giocatore").slice(0, 18),
      color: String(player.color || "#b91c1c").slice(0, 16),
      balance: Math.max(0, Math.min(100000000, Math.floor(player.balance || 0))),
      updatedAt: serverTimestamp()
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

// ============================================================================
// CLIENT REALTIME BASATO SU FIRESTORE
// ============================================================================
class FirestoreRealtimeClient {
  constructor() {
    this.mode = "firebase";
    this.initialized = false;
  }

  async init() {
    this.initialized = true;
    return this.mode;
  }

  getMode() {
    return this.mode;
  }

  async ensureTournamentEntryPass(tournId, code) {
    if (!auth.currentUser) throw new Error("Utente non autenticato.");
    const uid = auth.currentUser.uid;
    const cleanCode = String(code || "")
      .trim()
      .replace(/\s+/g, "")
      .toUpperCase();
    const passPath = `tournaments/${tournId}/entryPasses/${uid}`;
    const passRef = doc(db, "tournaments", tournId, "entryPasses", uid);

    let existingSnap;
    try {
      existingSnap = await getDoc(passRef);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, passPath);
    }

    if (existingSnap.exists()) return;

    try {
      await setDoc(passRef, {
        code: cleanCode,
        uid,
        createdAt: serverTimestamp()
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, passPath);
    }
  }

  async isInviteCodeTaken(code) {
    const cleanCode = String(code || "")
      .trim()
      .replace(/\s+/g, "")
      .toUpperCase();
    const path = `tournamentCodes/${cleanCode}`;
    try {
      const snap = await getDoc(doc(db, "tournamentCodes", cleanCode));
      return snap.exists();
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, path);
    }
  }

  async registerInviteCode(code, tournId, visibility) {
    if (!auth.currentUser) return;
    const cleanCode = String(code || "")
      .trim()
      .replace(/\s+/g, "")
      .toUpperCase();
    const path = `tournamentCodes/${cleanCode}`;
    try {
      await setDoc(doc(db, "tournamentCodes", cleanCode), {
        code: cleanCode,
        tournId,
        visibility: visibility === "private" ? "private" : "public",
        creatorId: auth.currentUser.uid,
        createdAt: serverTimestamp()
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  }

  async getTournamentByCode(code) {
    const cleanCode = String(code || "")
      .trim()
      .replace(/\s+/g, "")
      .toUpperCase();
    if (!cleanCode || cleanCode.length < 2) return null;

    const codePath = `tournamentCodes/${cleanCode}`;
    let codeSnap;
    try {
      codeSnap = await getDoc(doc(db, "tournamentCodes", cleanCode));
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, codePath);
    }
    if (!codeSnap.exists()) return null;

    const { tournId } = codeSnap.data();
    if (!tournId) return null;
    return this.get(`tournaments/${tournId}`);
  }

  async get(path) {
    const parts = splitPath(path);
    const root = parts[0];
    const docId = parts[1];

    if (root === "tournaments" && docId) {
      try {
        const snap = await getDoc(doc(db, "tournaments", docId));
        return snap.exists() ? fromFirestoreTournament(snap.data()) : null;
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, path);
      }
    }

    if (root === "tables" && docId) {
      try {
        const snap = await getDoc(doc(db, "tables", docId));
        return snap.exists() ? snap.data() : null;
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, path);
      }
    }

    if (root === "spinMatches" && docId) {
      try {
        const snap = await getDoc(doc(db, "spinMatches", docId));
        return snap.exists() ? snap.data() : null;
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, path);
      }
    }

    if (root === "spinQueues" && docId) {
      try {
        const snap = await getDoc(doc(db, "spinQueues", docId));
        return snap.exists() ? snap.data().players || [] : [];
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, path);
      }
    }

    return null;
  }

  async set(path, value) {
    const parts = splitPath(path);
    const root = parts[0];
    const docId = parts[1];

    if (value === null || value === undefined) {
      return this.remove(path);
    }

    if (root === "tournaments" && docId) {
      const payload = normalizeTournamentForCreate(value);
      try {
        await setDoc(doc(db, "tournaments", docId), payload);
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, path);
      }
      return value;
    }

    if (root === "tables" && docId) {
      const payload = normalizeTablePayload(value);
      try {
        await setDoc(doc(db, "tables", docId), payload);
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, path);
      }
      return value;
    }

    if (root === "spinMatches" && docId) {
      const payload = {
        userId: docId,
        tableId: String(value.tableId || ""),
        createdBy: auth.currentUser?.uid || "",
        createdAtMs: Number(value.createdAt || Date.now()),
        createdAt: serverTimestamp()
      };
      try {
        await setDoc(doc(db, "spinMatches", docId), payload);
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, path);
      }
      return value;
    }

    return value;
  }

  async remove(path) {
    const parts = splitPath(path);
    const root = parts[0];
    const docId = parts[1];
    if (root === "spinMatches" && docId) {
      try {
        await deleteDoc(doc(db, "spinMatches", docId));
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, path);
      }
    }
  }

  async push(path, value) {
    const parts = splitPath(path);
    const root = parts[0];
    const docId = parts[1];
    if (root === "chats" && docId) {
      const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const msgPath = `tables/${docId}/chats/${msgId}`;
      const payload = {
        senderId: auth.currentUser?.uid || "",
        sender: String(value.sender || "Giocatore").slice(0, 30),
        text: String(value.text || "").slice(0, 160),
        system: Boolean(value.system),
        ts: Number(value.ts || Date.now()),
        tablePlayerIds: Array.isArray(value.tablePlayerIds) ? value.tablePlayerIds : [],
        createdAt: serverTimestamp()
      };
      try {
        await setDoc(doc(db, "tables", docId, "chats", msgId), payload);
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, msgPath);
      }
      return msgId;
    }
    return null;
  }

  async runTransaction(path, updateFn) {
    const parts = splitPath(path);
    const root = parts[0];
    const docId = parts[1];

    if (root === "spinQueues" && docId) {
      const ref = doc(db, "spinQueues", docId);
      const tierNum = Number(docId);
      let finalResult = { committed: false, value: null };
      try {
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(ref);
          const currentPlayers = snap.exists() ? snap.data().players || [] : [];
          const nextPlayers = updateFn(stripUndefined(currentPlayers));
          if (nextPlayers === undefined) {
            finalResult = { committed: false, value: currentPlayers };
            return;
          }
          const cleanPlayers = (Array.isArray(nextPlayers) ? nextPlayers : []).slice(0, 30);
          const payload = {
            tier: tierNum,
            players: cleanPlayers,
            playerIds: cleanPlayers.map((p) => String(p.id)),
            updatedAt: serverTimestamp()
          };
          if (!snap.exists()) {
            tx.set(ref, payload);
          } else {
            tx.update(ref, {
              players: payload.players,
              playerIds: payload.playerIds,
              updatedAt: payload.updatedAt
            });
          }
          finalResult = { committed: true, value: cleanPlayers };
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, path);
      }
      return finalResult;
    }

    if (root === "tournaments" && docId) {
      const ref = doc(db, "tournaments", docId);
      let finalResult = { committed: false, value: null };
      try {
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists()) {
            finalResult = { committed: false, value: null };
            return;
          }
          const rawExisting = snap.data();
          const currentObj = fromFirestoreTournament(rawExisting);
          const nextObj = updateFn(stripUndefined(currentObj));
          if (nextObj === undefined) {
            finalResult = { committed: false, value: currentObj };
            return;
          }

          let updatePatch = { updatedAt: serverTimestamp() };
          if (
            nextObj.status === "registering" &&
            rawExisting.status === "registering"
          ) {
            const nextPlayers = (nextObj.players || []).slice(0, 18);
            updatePatch = {
              players: nextPlayers,
              playerIds: nextPlayers.map((p) => String(p.id)),
              updatedAt: serverTimestamp()
            };
          } else if (
            rawExisting.status === "registering" &&
            (nextObj.status === "running" || nextObj.status === "cancelled")
          ) {
            updatePatch = {
              status: nextObj.status,
              startedAt: nextObj.startedAt ?? null,
              cancelledAt: nextObj.cancelledAt ?? null,
              tableIds: Array.isArray(nextObj.tableIds) ? nextObj.tableIds.slice(0, 4) : [],
              updatedAt: serverTimestamp()
            };
          } else if (
            rawExisting.status === "running" &&
            !rawExisting.finalTableId &&
            nextObj.finalTableId
          ) {
            updatePatch = {
              finalTableId: String(nextObj.finalTableId).slice(0, 128),
              updatedAt: serverTimestamp()
            };
          } else if (
            rawExisting.status === "running" &&
            nextObj.status === "finished"
          ) {
            updatePatch = {
              status: "finished",
              winnerName: String(nextObj.winnerName || "").slice(0, 40),
              updatedAt: serverTimestamp()
            };
          }

          tx.update(ref, updatePatch);
          finalResult = {
            committed: true,
            value: fromFirestoreTournament({ ...rawExisting, ...updatePatch })
          };
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, path);
      }
      return finalResult;
    }

    if (root === "tables" && docId) {
      const ref = doc(db, "tables", docId);
      let finalResult = { committed: false, value: null };
      try {
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists()) {
            finalResult = { committed: false, value: null };
            return;
          }
          const rawExisting = snap.data();
          const nextObj = updateFn(stripUndefined(rawExisting));
          if (nextObj === undefined) {
            finalResult = { committed: false, value: rawExisting };
            return;
          }
          const normalized = normalizeTablePayload(nextObj, rawExisting.createdAt);
          const updateFields = buildTableUpdateFields(normalized);
          tx.update(ref, updateFields);
          finalResult = { committed: true, value: normalized };
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, path);
      }
      return finalResult;
    }

    return { committed: false, value: null };
  }

  subscribe(path, callback) {
    if (!auth.currentUser) {
      return () => {};
    }

    const parts = splitPath(path);
    const root = parts[0];
    const docId = parts[1];

    if (root === "spinQueues" && !docId) {
      const q = query(
        collection(db, "spinQueues"),
        where("tier", "in", [100, 500, 1000, 2500, 5000])
      );
      return onSnapshot(
        q,
        (snapshot) => {
          const out = {};
          snapshot.forEach((docSnap) => {
            out[docSnap.id] = docSnap.data().players || [];
          });
          callback(out);
        },
        (error) => {
          handleFirestoreError(error, OperationType.LIST, path);
        }
      );
    }

    if (root === "spinMatches" && docId) {
      return onSnapshot(
        doc(db, "spinMatches", docId),
        (docSnap) => {
          callback(docSnap.exists() ? docSnap.data() : null);
        },
        (error) => {
          handleFirestoreError(error, OperationType.GET, path);
        }
      );
    }

    if (root === "tournaments" && !docId) {
      const q = query(
        collection(db, "tournaments"),
        where("visibility", "in", ["public", "private"])
      );
      return onSnapshot(
        q,
        (snapshot) => {
          const out = {};
          snapshot.forEach((docSnap) => {
            out[docSnap.id] = fromFirestoreTournament(docSnap.data());
          });
          callback(out);
        },
        (error) => {
          handleFirestoreError(error, OperationType.LIST, path);
        }
      );
    }

    if (root === "tables" && docId) {
      return onSnapshot(
        doc(db, "tables", docId),
        (docSnap) => {
          callback(docSnap.exists() ? docSnap.data() : null);
        },
        (error) => {
          handleFirestoreError(error, OperationType.GET, path);
        }
      );
    }

    if (root === "chats" && docId) {
      const chatPath = `tables/${docId}/chats`;
      const q = query(
        collection(db, "tables", docId, "chats"),
        where("tablePlayerIds", "array-contains", auth.currentUser.uid)
      );
      return onSnapshot(
        q,
        (snapshot) => {
          const out = {};
          snapshot.forEach((docSnap) => {
            out[docSnap.id] = docSnap.data();
          });
          callback(out);
        },
        (error) => {
          handleFirestoreError(error, OperationType.LIST, chatPath);
        }
      );
    }

    return () => {};
  }
}

export const rtdb = new FirestoreRealtimeClient();
