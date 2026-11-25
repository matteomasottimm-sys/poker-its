import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import type { Request, Response } from "express";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const STATE_SNAPSHOT_FILE = "/tmp/circolo_holdem_rtdb_state.json";

type JsonRecord = Record<string, unknown>;

function splitPath(rawPath: string): string[] {
  return String(rawPath || "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normPath(rawPath: string): string {
  return splitPath(rawPath).join("/");
}

function deepClone<T>(val: T): T {
  if (val === undefined || val === null) return null as T;
  return JSON.parse(JSON.stringify(val));
}

function getAtPath(root: JsonRecord, rawPath: string): unknown {
  const parts = splitPath(rawPath);
  let curr: unknown = root;
  for (const part of parts) {
    if (curr == null || typeof curr !== "object") return null;
    curr = (curr as JsonRecord)[part];
  }
  return curr === undefined ? null : deepClone(curr);
}

function setAtPath(root: JsonRecord, rawPath: string, value: unknown): JsonRecord {
  const parts = splitPath(rawPath);
  if (parts.length === 0) {
    return value === null || value === undefined || typeof value !== "object"
      ? {}
      : deepClone(value as JsonRecord);
  }
  const next: JsonRecord = root && typeof root === "object" ? deepClone(root) : {};
  let curr: JsonRecord = next;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!curr[p] || typeof curr[p] !== "object") {
      curr[p] = {};
    }
    curr = curr[p] as JsonRecord;
  }
  const leaf = parts[parts.length - 1];
  if (value === null || value === undefined) {
    delete curr[leaf];
  } else {
    curr[leaf] = deepClone(value);
  }
  return next;
}

// Stato condiviso in memoria (con salvataggio leggero su /tmp)
let dbRoot: JsonRecord = {};
let mutationCounter = 1;
const pathRevs = new Map<string, number>();

try {
  if (fs.existsSync(STATE_SNAPSHOT_FILE)) {
    const raw = fs.readFileSync(STATE_SNAPSHOT_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      dbRoot = parsed;
    }
  }
} catch {
  dbRoot = {};
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      fs.writeFileSync(STATE_SNAPSHOT_FILE, JSON.stringify(dbRoot), "utf8");
    } catch {
      // Ignora errori su filesystem non scrivibile
    }
  }, 500);
}

function getPathRev(rawPath: string): number {
  const target = normPath(rawPath);
  let maxRev = 0;
  for (const [k, rev] of pathRevs.entries()) {
    if (
      k === "" ||
      target === "" ||
      k === target ||
      target.startsWith(`${k}/`) ||
      k.startsWith(`${target}/`)
    ) {
      if (rev > maxRev) maxRev = rev;
    }
  }
  return maxRev;
}

function markPathMutated(rawPath: string): number {
  const norm = normPath(rawPath);
  const rev = ++mutationCounter;
  pathRevs.set(norm, rev);
  schedulePersist();
  return rev;
}

// Client SSE connessi per aggiornamenti istantanei
const sseClients = new Set<Response>();

function broadcastChange(changedPath: string, rev: number): void {
  const payload = `data: ${JSON.stringify({ type: "DB_CHANGED", path: normPath(changedPath), rev })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // Disabilita caching sulle API realtime
  app.use("/api/rtdb", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    next();
  });

  app.get("/api/rtdb/health", (_req: Request, res: Response) => {
    res.json({ ok: true, mode: "server", rev: mutationCounter });
  });

  app.get("/api/rtdb/get", (req: Request, res: Response) => {
    const reqPath = String(req.query.path || "");
    const value = getAtPath(dbRoot, reqPath);
    const rev = getPathRev(reqPath);
    res.json({ ok: true, value, rev });
  });

  app.post("/api/rtdb/set", (req: Request, res: Response) => {
    const reqPath = String(req.body?.path || "");
    const value = req.body?.value;
    dbRoot = setAtPath(dbRoot, reqPath, value);
    const rev = markPathMutated(reqPath);
    broadcastChange(reqPath, rev);
    res.json({ ok: true, rev });
  });

  app.post("/api/rtdb/update", (req: Request, res: Response) => {
    const reqPath = String(req.body?.path || "");
    const partialObj = req.body?.partialObj;
    if (!partialObj || typeof partialObj !== "object") {
      res.status(400).json({ ok: false, error: "partialObj non valido" });
      return;
    }
    const existing = getAtPath(dbRoot, reqPath);
    const merged: JsonRecord =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? { ...(existing as JsonRecord) }
        : {};
    for (const [k, v] of Object.entries(partialObj as JsonRecord)) {
      if (v === null || v === undefined) {
        delete merged[k];
      } else {
        merged[k] = deepClone(v);
      }
    }
    dbRoot = setAtPath(dbRoot, reqPath, merged);
    const rev = markPathMutated(reqPath);
    broadcastChange(reqPath, rev);
    res.json({ ok: true, rev });
  });

  app.post("/api/rtdb/cas", (req: Request, res: Response) => {
    const reqPath = String(req.body?.path || "");
    const expectedRev = Number(req.body?.expectedRev);
    const nextVal = req.body?.value;

    const actualRev = getPathRev(reqPath);
    if (!Number.isFinite(expectedRev) || actualRev !== expectedRev) {
      res.json({
        ok: true,
        committed: false,
        conflict: true,
        value: getAtPath(dbRoot, reqPath),
        rev: actualRev
      });
      return;
    }

    dbRoot = setAtPath(dbRoot, reqPath, nextVal);
    const newRev = markPathMutated(reqPath);
    broadcastChange(reqPath, newRev);
    res.json({
      ok: true,
      committed: true,
      value: deepClone(nextVal),
      rev: newRev
    });
  });

  app.get("/api/rtdb/stream", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: "READY", rev: mutationCounter })}\n\n`);

    const keepAlive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(keepAlive);
        sseClients.delete(res);
      }
    }, 20000);

    req.on("close", () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
  });

  // Frontend Vite in sviluppo oppure bundle statico in produzione
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Circolo Hold'em server attivo su http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Errore avvio server:", err);
  process.exit(1);
});
