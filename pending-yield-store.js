"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function normalizedSessionKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed !== "main" ? trimmed : null;
}

function normalizedEntry(value) {
  if (typeof value === "string" && value) {
    return { runId: value, sessionKey: null };
  }
  if (!value || typeof value !== "object" || !value.runId) return null;
  return {
    runId: String(value.runId),
    sessionKey: normalizedSessionKey(value.sessionKey),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : undefined,
  };
}

function entryName(runId) {
  return crypto.createHash("sha256").update(String(runId)).digest("hex") + ".json";
}

function createPendingYieldStore({ dir, legacyFile }) {
  if (!dir) throw new Error("pending-yield store requires dir");

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  function entryPath(runId) {
    return path.join(dir, entryName(runId));
  }

  function readEntry(filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > 64 * 1024) return null;
      return normalizedEntry(JSON.parse(fs.readFileSync(filePath, "utf8")));
    } catch (_) {
      return null;
    }
  }

  function readLegacy() {
    if (!legacyFile) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizedEntry).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function read(sessionKey) {
    const wanted = normalizedSessionKey(sessionKey);
    const entries = new Map();
    try {
      ensureDir();
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        const entry = readEntry(path.join(dir, name));
        if (entry && entry.sessionKey === wanted) entries.set(entry.runId, entry);
      }
    } catch (_) {}
    for (const entry of readLegacy()) {
      if (entry.sessionKey === wanted && !entries.has(entry.runId)) {
        entries.set(entry.runId, entry);
      }
    }
    return [...entries.values()];
  }

  function write(runId, sessionKey) {
    if (!runId) return;
    ensureDir();
    const entry = {
      runId: String(runId),
      sessionKey: normalizedSessionKey(sessionKey),
      createdAt: new Date().toISOString(),
    };
    const destination = entryPath(entry.runId);
    const temporary = path.join(
      dir,
      `.tmp-${process.pid}-${crypto.randomUUID()}`
    );
    try {
      fs.writeFileSync(temporary, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, destination);
    } finally {
      try { fs.unlinkSync(temporary); } catch (_) {}
    }
  }

  function remove(runId) {
    if (!runId) return;
    try { fs.unlinkSync(entryPath(runId)); } catch (_) {}
  }

  return { read, remove, write };
}

module.exports = { createPendingYieldStore };
