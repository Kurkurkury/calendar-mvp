// server/server.js
// Kalender MVP – Backend API (Events + Tasks) + Google OAuth + Google Quick-Add
// ✅ liefert www/ oder public/ statisch aus (kein "Cannot GET /")
// ✅ behält bestehende Endpoints bei
// ✅ Quick-Add: robust (Text -> parse -> events.insert) statt Google events.quickAdd
// ✅ kann den richtigen Google-Account erzwingen via GOOGLE_ALLOWED_EMAIL (z.B. noahsp@gmx.ch)
// ✅ Phase 2 Sync: Google -> App (Read) via GET /api/google/events?daysPast=365&daysFuture=365

import "dotenv/config"; // .env laden (muss ganz oben stehen)

import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

import {
  getGoogleStatus,
  getAuthUrl,
  exchangeCodeForTokens,
  createGoogleEvent,
  listGoogleEvents, // ✅ Phase 2 Sync (Read)
  deleteGoogleEvent,
  getGoogleConfig,
  loadTokens,
  clearTokens,
  saveTokens,
  getTokenStorageInfo,
} from "./google-calendar.js";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IS_PROD = process.env.NODE_ENV === "production";
const logDebug = (...args) => {
  if (!IS_PROD) {
    console.log(...args);
  }
};
const ASSISTANT_MODEL = process.env.ASSISTANT_MODEL || "gpt-4.1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const AI_EXTRACT_MODEL = process.env.AI_EXTRACT_MODEL || "gpt-4o-mini";
const MAX_FILE_MB = 10;
const MAX_UPLOAD_BYTES = MAX_FILE_MB * 1024 * 1024;
const MAX_FORM_BYTES = MAX_UPLOAD_BYTES + 512 * 1024;
const MAX_EXTRACTED_TEXT_CHARS = toPositiveInt(process.env.MAX_EXTRACTED_TEXT_CHARS, 30000);
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

// ---- Paths ----
const DB_PATH = path.join(__dirname, "db.json");
const TOKENS_PATH = path.join(__dirname, "google-tokens.json"); // legacy disconnect fallback


// ---- Phase 3 Push-Sync (Google Watch API) ----
const WATCH_PATH = path.join(__dirname, "google-watch.json");

function getOpenAiRequestId(headers) {
  if (!headers) return null;
  return headers.get("x-request-id") || headers.get("openai-request-id") || null;
}

function toSnippet(text, maxLen = 500) {
  if (!text) return "";
  const str = String(text);
  return str.length > maxLen ? `${str.slice(0, maxLen)}...` : str;
}

function logOpenAiError({ status, requestId, errorType, errorCode, errorMessage, bodySnippet }) {
  console.error(
    [
      "[ai-extract][openai-error]",
      `status=${status ?? "n/a"}`,
      `request_id=${requestId ?? "n/a"}`,
      `type=${errorType ?? "n/a"}`,
      `code=${errorCode ?? "n/a"}`,
      `message=${errorMessage ?? "n/a"}`,
      bodySnippet ? `body_snippet=${bodySnippet}` : null,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function loadWatchState() {
  try {
    if (!fs.existsSync(WATCH_PATH)) {
      return {
        ok: true,
        channelId: null,
        resourceId: null,
        expiration: null,
        token: null,
        dirty: true, // beim ersten Start einmal refetchen
        lastChangeAt: Date.now(),
        lastPushAt: null,
        lastResourceState: null,
        lastAckAt: null,
        lastError: null,
      };
    }
    const raw = fs.readFileSync(WATCH_PATH, "utf-8");
    const parsed = JSON.parse(raw || "{}");
    return {
      ok: true,
      channelId: parsed.channelId || null,
      resourceId: parsed.resourceId || null,
      expiration: parsed.expiration || null,
      token: parsed.token || null,
      dirty: parsed.dirty !== false, // default true
      lastChangeAt: parsed.lastChangeAt || Date.now(),
      lastPushAt: parsed.lastPushAt || null,
      lastResourceState: parsed.lastResourceState || null,
      lastAckAt: parsed.lastAckAt || null,
      lastError: parsed.lastError || null,
    };
  } catch (e) {
    return {
      ok: false,
      channelId: null,
      resourceId: null,
      expiration: null,
      token: null,
      dirty: true,
      lastChangeAt: Date.now(),
      lastPushAt: null,
      lastResourceState: null,
      lastAckAt: null,
      lastError: e?.message || String(e),
    };
  }
}

function saveWatchState(next) {
  const safe = {
    channelId: next.channelId || null,
    resourceId: next.resourceId || null,
    expiration: next.expiration || null,
    token: next.token || null,
    dirty: next.dirty !== false,
    lastChangeAt: next.lastChangeAt || Date.now(),
    lastPushAt: next.lastPushAt || null,
    lastResourceState: next.lastResourceState || null,
    lastAckAt: next.lastAckAt || null,
    lastError: next.lastError || null,
  };
  fs.writeFileSync(WATCH_PATH, JSON.stringify(safe, null, 2), "utf-8");
  return safe;
}

function markDirty(resourceState) {
  const st = loadWatchState();
  saveWatchState({
    ...st,
    dirty: true,
    lastChangeAt: Date.now(),
    lastPushAt: Date.now(),
    lastResourceState: resourceState || st.lastResourceState || null,
    lastError: null,
  });
}

function clearDirty() {
  const st = loadWatchState();
  saveWatchState({
    ...st,
    dirty: false,
    lastAckAt: Date.now(),
    lastError: null,
  });
}

function getWebhookUrl() {
  const explicit = (process.env.GOOGLE_WATCH_WEBHOOK_URL || "").trim();
  if (explicit) return explicit;

  // Render setzt oft RENDER_EXTERNAL_URL oder aehnliches. Wenn vorhanden, nutzen wir das.
  const base = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").trim();
  if (!base) return "";
  return String(base).replace(/\/+$/, "") + "/api/google/watch/notify";
}

function isHttpsUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "https:";
  } catch {
    return false;
  }
}

function newChannelId() {
  try {
    return crypto.randomUUID();
  } catch {
    return "ch_" + crypto.randomBytes(16).toString("hex");
  }
}

function newToken() {
  return crypto.randomBytes(24).toString("hex");
}

async function stopWatchChannel(calendar, channelId, resourceId) {
  if (!channelId || !resourceId) return;
  try {
    await calendar.channels.stop({ requestBody: { id: String(channelId), resourceId: String(resourceId) } });
  } catch {
    // ignore
  }
}

async function ensureGoogleWatch({ reason = "ensure" } = {}) {
  const cfg = getGoogleConfig();

  if (!cfg?.GOOGLE_CLIENT_ID || !cfg?.GOOGLE_CLIENT_SECRET || !cfg?.GOOGLE_REDIRECT_URI) {
    return { ok: false, message: "Google OAuth nicht konfiguriert" };
  }

  const tokens = (await loadTokens?.()) || null;
  if (!tokens?.refresh_token) {
    return { ok: false, message: "Google nicht verbunden (kein Refresh Token)" };
  }

  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) {
    return { ok: false, message: "Webhook URL fehlt (setze GOOGLE_WATCH_WEBHOOK_URL oder PUBLIC_BASE_URL)" };
  }
  if (!isHttpsUrl(webhookUrl)) {
    return { ok: false, message: "Webhook URL muss https sein" };
  }

  const oauth2 = await buildAuthedOAuthClient();
  const calendar = google.calendar({ version: "v3", auth: oauth2 });

  const st = loadWatchState();
  const now = Date.now();
  const exp = st?.expiration ? int(st.expiration) : 0;
  const stillValid = st?.channelId && st?.resourceId && exp > now + 60 * 60 * 1000; // >= 1h Puffer

  if (stillValid && reason === "ensure") {
    return { ok: true, reused: true, channelId: st.channelId, expiration: exp, webhookUrl };
  }

  // stop old (best effort)
  await stopWatchChannel(calendar, st?.channelId, st?.resourceId);

  const channelId = newChannelId();
  const token = st?.token || newToken();

  try {
    const res = await calendar.events.watch({
      calendarId: cfg.GOOGLE_CALENDAR_ID || "primary",
      requestBody: {
        id: channelId,
        type: "web_hook",
        address: webhookUrl,
        token,
        params: {
          ttl: "604800", // 7 Tage in Sekunden (Google capped)
        },
      },
    });

    const resourceId = res?.data?.resourceId ? String(res.data.resourceId) : null;
    const expiration = res?.data?.expiration ? int(res.data.expiration) : null;

    saveWatchState({
      ...st,
      channelId,
      resourceId,
      expiration,
      token,
      // bei neuem Watch immer dirty, damit App einmal sauber refetcht
      dirty: true,
      lastChangeAt: Date.now(),
      lastError: null,
    });

    return { ok: true, created: true, channelId, resourceId, expiration, webhookUrl };
  } catch (e) {
    const msg = e?.response?.data || e?.message || String(e);
    saveWatchState({ ...st, lastError: String(msg) });
    return { ok: false, message: "watch create failed", details: msg };
  }
}

function int(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  return fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function dateKeyLocal(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function startOfWeekLocal(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const jsDay = d.getDay();
  const isoDay = jsDay === 0 ? 7 : jsDay;
  d.setDate(d.getDate() - (isoDay - 1));
  return d;
}

function overlapMinutes(start, end, rangeStart, rangeEnd) {
  const s = start > rangeStart ? start : rangeStart;
  const e = end < rangeEnd ? end : rangeEnd;
  const diff = e.getTime() - s.getTime();
  return diff > 0 ? diff / 60000 : 0;
}

function findBestBreakSlot(events, dayStart, windowStart = "08:00", windowEnd = "18:00") {
  const workStart = atTime(dayStart, windowStart);
  const workEnd = atTime(dayStart, windowEnd);
  if (!workStart || !workEnd || workEnd <= workStart) return null;

  const occupied = buildOccupiedIntervals(events, workStart, workEnd).sort(
    (a, b) => a.start - b.start
  );
  const merged = [];
  for (const interval of occupied) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }

  const MIN_BREAK_MINUTES = 15;
  const DEFAULT_BREAK_MINUTES = 30;
  let best = null;

  const considerGap = (gapStart, gapEnd) => {
    const gapMinutes = (gapEnd.getTime() - gapStart.getTime()) / 60000;
    if (gapMinutes < MIN_BREAK_MINUTES) return;
    const duration = Math.min(DEFAULT_BREAK_MINUTES, gapMinutes);
    const offset = Math.max(0, Math.round((gapMinutes - duration) / 2));
    const start = addMinutes(gapStart, offset);
    const end = addMinutes(start, duration);
    if (!best || gapMinutes > best.gapMinutes) {
      best = { start, end, minutes: duration, gapMinutes };
    }
  };

  let cursor = workStart;
  for (const interval of merged) {
    if (interval.start > cursor) {
      considerGap(cursor, interval.start);
    }
    if (interval.end > cursor) cursor = interval.end;
  }
  if (workEnd > cursor) {
    considerGap(cursor, workEnd);
  }

  if (!best && merged.length === 0) {
    const mid = atTime(dayStart, "12:00");
    if (mid && addMinutes(mid, DEFAULT_BREAK_MINUTES) <= workEnd) {
      return { start: mid, end: addMinutes(mid, DEFAULT_BREAK_MINUTES), minutes: DEFAULT_BREAK_MINUTES };
    }
  }

  if (!best) return null;
  return { start: best.start, end: best.end, minutes: best.minutes };
}

// ---- Config ----
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";

// Setze z.B. GOOGLE_ALLOWED_EMAIL=noahsp@gmx.ch
const GOOGLE_ALLOWED_EMAIL = (process.env.GOOGLE_ALLOWED_EMAIL || "").trim().toLowerCase();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

// ---- Monitoring ----
const MONITORING_SAMPLE_LIMIT = 120;
const MONITORING_ERROR_LIMIT = 8;
const MONITORING_SLOW_LIMIT = 8;
const MONITORING_SLOW_MS = 1200;
const monitoringState = {
  startedAt: Date.now(),
  requestCount: 0,
  errorCount: 0,
  slowRequestCount: 0,
  totalResponseMs: 0,
  responseSamples: [],
  lastErrors: [],
  lastSlow: [],
};

function recordMonitoringSample({ durationMs, statusCode, method, path: reqPath }) {
  monitoringState.requestCount += 1;
  monitoringState.totalResponseMs += durationMs;
  monitoringState.responseSamples.push(durationMs);
  if (monitoringState.responseSamples.length > MONITORING_SAMPLE_LIMIT) {
    monitoringState.responseSamples.shift();
  }

  if (statusCode >= 500) {
    monitoringState.errorCount += 1;
    monitoringState.lastErrors.unshift({
      at: Date.now(),
      method,
      path: reqPath,
      status: statusCode,
      durationMs: Math.round(durationMs),
    });
    monitoringState.lastErrors = monitoringState.lastErrors.slice(0, MONITORING_ERROR_LIMIT);
  }

  if (durationMs >= MONITORING_SLOW_MS) {
    monitoringState.slowRequestCount += 1;
    monitoringState.lastSlow.unshift({
      at: Date.now(),
      method,
      path: reqPath,
      durationMs: Math.round(durationMs),
    });
    monitoringState.lastSlow = monitoringState.lastSlow.slice(0, MONITORING_SLOW_LIMIT);
  }
}

function getMonitoringSnapshot() {
  const samples = monitoringState.responseSamples.slice().sort((a, b) => a - b);
  const avg = samples.length ? samples.reduce((acc, v) => acc + v, 0) / samples.length : 0;
  const p95Index = samples.length ? Math.floor(samples.length * 0.95) - 1 : -1;
  const p95 = p95Index >= 0 ? samples[Math.max(0, p95Index)] : 0;
  return {
    startedAt: monitoringState.startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    requestCount: monitoringState.requestCount,
    errorCount: monitoringState.errorCount,
    slowRequestCount: monitoringState.slowRequestCount,
    avgResponseMs: Math.round(avg),
    p95ResponseMs: Math.round(p95),
    lastErrors: monitoringState.lastErrors,
    lastSlow: monitoringState.lastSlow,
    memory: process.memoryUsage(),
    nodeVersion: process.version,
  };
}

app.use((req, res, next) => {
  const start = process.hrtime.bigint ? process.hrtime.bigint() : null;
  res.on("finish", () => {
    const end = process.hrtime.bigint ? process.hrtime.bigint() : null;
    const durationMs = start && end ? Number(end - start) / 1e6 : 0;
    recordMonitoringSample({
      durationMs,
      statusCode: res.statusCode || 0,
      method: req.method,
      path: req.originalUrl || req.url || "",
    });
  });
  next();
});

// ---- Mini-DB (JSON Datei) ----
const DEFAULT_PREFERENCES = {
  timeOfDayWeights: { morning: 0, afternoon: 0, evening: 0 },
  bufferMinutes: 15,
  windowStart: "08:00",
  windowEnd: "18:00",
  lastUpdated: null,
};

const DEFAULT_LEARNING = {
  acceptedSuggestions: 0,
  timeOfDayCounts: { morning: 0, afternoon: 0, evening: 0 },
  lastInteractionAt: null,
  recentInteractions: [],
};

function buildDefaultDb() {
  return {
    events: [],
    tasks: [],
    preferences: { ...DEFAULT_PREFERENCES },
    learning: { ...DEFAULT_LEARNING },
  };
}

function normalizePreferences(pref) {
  return {
    timeOfDayWeights: {
      morning: Number(pref?.timeOfDayWeights?.morning || 0),
      afternoon: Number(pref?.timeOfDayWeights?.afternoon || 0),
      evening: Number(pref?.timeOfDayWeights?.evening || 0),
    },
    bufferMinutes: Number.isFinite(Number(pref?.bufferMinutes)) ? Number(pref.bufferMinutes) : DEFAULT_PREFERENCES.bufferMinutes,
    windowStart: String(pref?.windowStart || DEFAULT_PREFERENCES.windowStart),
    windowEnd: String(pref?.windowEnd || DEFAULT_PREFERENCES.windowEnd),
    lastUpdated: pref?.lastUpdated || null,
  };
}

function normalizeLearning(learning) {
  const recent = Array.isArray(learning?.recentInteractions) ? learning.recentInteractions : [];
  return {
    acceptedSuggestions: Number(learning?.acceptedSuggestions || 0),
    timeOfDayCounts: {
      morning: Number(learning?.timeOfDayCounts?.morning || 0),
      afternoon: Number(learning?.timeOfDayCounts?.afternoon || 0),
      evening: Number(learning?.timeOfDayCounts?.evening || 0),
    },
    lastInteractionAt: learning?.lastInteractionAt || null,
    recentInteractions: recent.slice(-25),
  };
}

function ensureDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(buildDefaultDb(), null, 2), "utf-8");
  }
}

function readDb() {
  ensureDb();
  try {
    const raw = fs.readFileSync(DB_PATH, "utf-8");
    const parsed = JSON.parse(raw || "{}");
    if (!Array.isArray(parsed.events)) parsed.events = [];
    if (!Array.isArray(parsed.tasks)) parsed.tasks = [];
    parsed.preferences = normalizePreferences(parsed.preferences || {});
    parsed.learning = normalizeLearning(parsed.learning || {});
    return parsed;
  } catch {
    const safe = buildDefaultDb();
    fs.writeFileSync(DB_PATH, JSON.stringify(safe, null, 2), "utf-8");
    return safe;
  }
}
function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}
function uid(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

// ---- Event suggestions (Phase 2) ----
const SUGGESTION_TTL_MS = 30 * 60 * 1000;
const suggestionStore = new Map();

// ---- Free slot suggestions (Phase 3) ----
const FREE_SLOT_TTL_MS = 30 * 60 * 1000;
const freeSlotStore = new Map();
const approvedFreeSlotStore = new Map();

function pruneSuggestions() {
  const now = Date.now();
  for (const [id, entry] of suggestionStore.entries()) {
    if (!entry?.createdAt || now - entry.createdAt > SUGGESTION_TTL_MS) {
      suggestionStore.delete(id);
    }
  }
}

function pruneFreeSlots() {
  const now = Date.now();
  for (const [id, entry] of freeSlotStore.entries()) {
    if (!entry?.createdAt || now - entry.createdAt > FREE_SLOT_TTL_MS) {
      freeSlotStore.delete(id);
    }
  }
  for (const [id, entry] of approvedFreeSlotStore.entries()) {
    if (!entry?.createdAt || now - entry.createdAt > FREE_SLOT_TTL_MS) {
      approvedFreeSlotStore.delete(id);
    }
  }
}

function toLocalIsoWithOffset(date) {
  const d = new Date(date);
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const offH = String(Math.floor(abs / 60)).padStart(2, "0");
  const offM = String(abs % 60).padStart(2, "0");
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${offH}:${offM}`;
}

function parseDateInput(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = String(dateStr).split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function parseTimeInput(timeStr) {
  if (!timeStr) return null;
  const [h, m] = String(timeStr).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return { h, m };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function getDateISOInTimeZone(timeZone, date = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(date);
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // fall through
  }
  return date.toISOString().slice(0, 10);
}

function parseMultipartFormData(req) {
  const contentType = String(req.headers["content-type"] || "");
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) {
    return { ok: false, status: 400, message: "missing multipart boundary" };
  }
  if (!Buffer.isBuffer(req.body)) {
    return { ok: false, status: 400, message: "missing multipart body" };
  }

  const boundary = match[1] || match[2];
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const parts = [];
  let offset = 0;

  while (offset < req.body.length) {
    const start = req.body.indexOf(boundaryBuffer, offset);
    if (start === -1) break;
    const partStart = start + boundaryBuffer.length;
    if (req.body[partStart] === 45 && req.body[partStart + 1] === 45) {
      break;
    }
    const headerStart = req.body[partStart] === 13 && req.body[partStart + 1] === 10
      ? partStart + 2
      : partStart;
    const headerEnd = req.body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd === -1) break;
    const headersText = req.body.slice(headerStart, headerEnd).toString("utf8");
    const contentStart = headerEnd + 4;
    const nextBoundary = req.body.indexOf(boundaryBuffer, contentStart);
    if (nextBoundary === -1) break;
    const contentEnd = nextBoundary - 2;
    const content = req.body.slice(contentStart, contentEnd);
    parts.push({ headersText, content });
    offset = nextBoundary;
  }

  const fields = {};
  let file = null;

  for (const part of parts) {
    const headers = part.headersText.split("\r\n");
    const disposition = headers.find((line) => line.toLowerCase().startsWith("content-disposition"));
    if (!disposition) continue;
    const nameMatch = disposition.match(/name="([^"]+)"/i);
    const filenameMatch = disposition.match(/filename="([^"]*)"/i);
    const fieldName = nameMatch?.[1] || "";
    const filename = filenameMatch?.[1] || "";
    const contentTypeHeader = headers.find((line) => line.toLowerCase().startsWith("content-type"));
    const mimeType = contentTypeHeader?.split(":")[1]?.trim() || "";

    if (filename) {
      file = {
        originalName: filename,
        mimeType,
        buffer: part.content,
      };
    } else if (fieldName) {
      fields[fieldName] = part.content.toString("utf8");
    }
  }

  if (!file) {
    return { ok: false, status: 400, message: "file missing" };
  }
  if (!ALLOWED_UPLOAD_MIME_TYPES.has(file.mimeType)) {
    return { ok: false, status: 400, message: "invalid file type" };
  }
  if (file.buffer.length > MAX_UPLOAD_BYTES) {
    return { ok: false, status: 413, message: "file too large" };
  }

  return { ok: true, fields, file };
}

function parseAIJson(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (!Array.isArray(parsed.items)) return null;

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  const timeRegex = /^\d{2}:\d{2}$/;

  for (const item of parsed.items) {
    if (!item || typeof item !== "object") return null;
    if (!["event", "task"].includes(item.type)) return null;
    if (typeof item.title !== "string") return null;
    if (typeof item.date !== "string" || !dateRegex.test(item.date)) return null;
    if (item.start !== null && (typeof item.start !== "string" || !timeRegex.test(item.start))) return null;
    if (item.end !== null && (typeof item.end !== "string" || !timeRegex.test(item.end))) return null;
    if (item.durationMin !== null && !Number.isFinite(item.durationMin)) return null;
    if (typeof item.description !== "string") return null;
    if (typeof item.location !== "string") return null;
    if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) return null;
    if (typeof item.sourceSnippet !== "string") return null;
  }

  return parsed;
}

function safeJsonParse(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
}

function parseDocExtractJson(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.ok !== "boolean") return null;
  if (!parsed.source || typeof parsed.source !== "object") return null;
  if (typeof parsed.source.mime !== "string") return null;
  if (!parsed.proposals || typeof parsed.proposals !== "object") return null;
  if (!Array.isArray(parsed.proposals.events) || !Array.isArray(parsed.proposals.tasks)) return null;
  if (!Array.isArray(parsed.warnings)) return null;

  for (const event of parsed.proposals.events) {
    if (!event || typeof event !== "object") return null;
    if (typeof event.title !== "string") return null;
    if ("date" in event && event.date !== null && typeof event.date !== "string") return null;
    if ("start" in event && event.start !== null && typeof event.start !== "string") return null;
    if ("end" in event && event.end !== null && typeof event.end !== "string") return null;
    if (
      "durationMin" in event &&
      event.durationMin !== null &&
      !Number.isFinite(event.durationMin)
    )
      return null;
    if ("description" in event && event.description !== null && typeof event.description !== "string")
      return null;
    if ("location" in event && event.location !== null && typeof event.location !== "string")
      return null;
    if (!Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1) return null;
    if (!Array.isArray(event.evidence)) return null;
  }

  for (const task of parsed.proposals.tasks) {
    if (!task || typeof task !== "object") return null;
    if (typeof task.title !== "string") return null;
    if ("dueDate" in task && task.dueDate !== null && typeof task.dueDate !== "string") return null;
    if ("description" in task && task.description !== null && typeof task.description !== "string")
      return null;
    if ("location" in task && task.location !== null && typeof task.location !== "string") return null;
    if (!Number.isFinite(task.confidence) || task.confidence < 0 || task.confidence > 1) return null;
    if (!Array.isArray(task.evidence)) return null;
  }

  return parsed;
}

function normalizeExtractItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const normalized = {
      type: item.type,
      title: String(item.title || "").trim(),
      date: item.date,
      start: item.start ? String(item.start).trim() : null,
      end: item.end ? String(item.end).trim() : null,
      durationMin: Number.isFinite(item.durationMin) ? Number(item.durationMin) : null,
      description: String(item.description || "").trim(),
      location: String(item.location || "").trim(),
      confidence: clamp(Number(item.confidence) || 0, 0, 1),
      sourceSnippet: String(item.sourceSnippet || "").trim(),
    };
    if (!normalized.start) normalized.start = null;
    if (!normalized.end) normalized.end = null;
    return normalized;
  });
}

async function extractPdfText(buffer) {
  const result = await pdfParse(buffer);
  return {
    text: result.text || "",
    totalPages: Number.isFinite(result.numpages) ? result.numpages : null,
  };
}

async function extractDocxText(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return { text: result.value || "" };
}

function normalizeAssistantProposal(raw) {
  const safe = raw && typeof raw === "object" ? raw : {};
  const event = safe.event && typeof safe.event === "object" ? safe.event : {};
  return {
    intent: typeof safe.intent === "string" ? safe.intent : "none",
    confidence: Number.isFinite(safe.confidence) ? Number(safe.confidence) : 0,
    event: {
      title: event.title ?? null,
      dateISO: event.dateISO ?? null,
      startTime: event.startTime ?? null,
      endTime: event.endTime ?? null,
      durationMin: Number.isFinite(event.durationMin) ? Number(event.durationMin) : null,
      allDay: !!event.allDay,
      location: event.location ?? null,
      description: event.description ?? null,
    },
    questions: Array.isArray(safe.questions) ? safe.questions.filter(Boolean).map(String) : [],
  };
}

function hasRequiredAssistantFields(proposal) {
  const event = proposal?.event || {};
  const hasTitle = !!event.title;
  const hasDate = !!event.dateISO;
  const hasStart = !!event.startTime;
  const hasAllDay = !!event.allDay;
  const hasEndOrDuration = !!event.endTime || Number.isFinite(event.durationMin);
  return hasTitle && hasDate && (hasStart || hasAllDay) && (hasEndOrDuration || hasAllDay);
}

function buildLocalDateTime(dateISO, timeStr) {
  const baseDate = parseDateInput(dateISO);
  const time = parseTimeInput(timeStr);
  if (!baseDate || !time) return null;
  const dt = new Date(baseDate);
  dt.setHours(time.h, time.m, 0, 0);
  return dt;
}

function atTime(date, timeStr) {
  const t = parseTimeInput(timeStr);
  if (!t) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), t.h, t.m, 0, 0);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function getTimeOfDayBucket(date) {
  const hour = date.getHours();
  if (hour >= 6 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return null;
}

function normalizeWeights(weights) {
  const sum = Object.values(weights).reduce((acc, value) => acc + value, 0);
  if (!sum) return { ...weights };
  return Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, value / sum]));
}

function updateLearningFromInteraction(db, { start, source = "unknown", title = "" } = {}) {
  if (!db) return db;
  const startDate = start ? new Date(start) : null;
  if (!startDate || Number.isNaN(startDate.getTime())) return db;

  const bucket = getTimeOfDayBucket(startDate);
  const learning = normalizeLearning(db.learning || {});
  const preferences = normalizePreferences(db.preferences || {});

  learning.acceptedSuggestions += 1;
  learning.lastInteractionAt = Date.now();

  if (bucket) {
    learning.timeOfDayCounts[bucket] += 1;

    const decay = 0.85;
    const weights = { ...preferences.timeOfDayWeights };
    for (const key of Object.keys(weights)) {
      weights[key] = weights[key] * decay;
    }
    weights[bucket] = (weights[bucket] || 0) + (1 - decay);
    preferences.timeOfDayWeights = normalizeWeights(weights);
    preferences.lastUpdated = Date.now();
  }

  const recent = Array.isArray(learning.recentInteractions) ? learning.recentInteractions : [];
  recent.push({
    at: Date.now(),
    start: toLocalIsoWithOffset(startDate),
    bucket: bucket || "unclassified",
    source,
    title: String(title || ""),
  });
  learning.recentInteractions = recent.slice(-25);

  db.learning = learning;
  db.preferences = preferences;
  return db;
}

function derivePreferredTimeOfDay(preferences) {
  const weights = preferences?.timeOfDayWeights || {};
  const entries = Object.entries(weights).filter(([, value]) => Number.isFinite(value));
  if (!entries.length) return null;
  const total = entries.reduce((acc, [, value]) => acc + value, 0);
  if (total < 0.2) return null;
  const [topKey, topValue] = entries.sort((a, b) => b[1] - a[1])[0] || [];
  if (!topKey || !topValue || topValue < 0.35) return null;
  return topKey;
}

function summarizeRecurringPattern(events, title) {
  if (!title) return null;
  const normalized = String(title).trim().toLowerCase();
  if (!normalized) return null;
  const matches = (events || []).filter((ev) => String(ev?.title || "").trim().toLowerCase() === normalized);
  if (matches.length < 2) return null;
  const hours = [];
  const weekdays = new Map();
  for (const ev of matches) {
    const start = ev?.start ? new Date(ev.start) : null;
    if (!start || Number.isNaN(start.getTime())) continue;
    hours.push(start.getHours() + start.getMinutes() / 60);
    const day = start.getDay();
    weekdays.set(day, (weekdays.get(day) || 0) + 1);
  }
  if (hours.length < 2) return null;
  const avgHour = hours.reduce((acc, value) => acc + value, 0) / hours.length;
  const topWeekday = Array.from(weekdays.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
  return {
    count: hours.length,
    avgHour,
    weekday: Number.isFinite(topWeekday) ? topWeekday : null,
  };
}

function isConflict(occupied, start, end) {
  return occupied.some((o) => start < o.end && end > o.start);
}

function buildOccupiedIntervals(events, rangeStart, rangeEnd) {
  const intervals = [];
  for (const ev of events) {
    const start = ev?.start ? new Date(ev.start) : null;
    const end = ev?.end ? new Date(ev.end) : null;
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (start >= rangeEnd || end <= rangeStart) continue;
    intervals.push({ start, end });
  }
  return intervals;
}

function filterEventsByRange(events, rangeStart, rangeEnd) {
  return (events || []).filter((ev) => {
    const start = ev?.start ? new Date(ev.start) : null;
    const end = ev?.end ? new Date(ev.end) : null;
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
    return start < rangeEnd && end > rangeStart;
  });
}

async function loadEventsForRange(rangeStart, rangeEnd) {
  const tokens = (await loadTokens?.()) || null;
  if (tokens?.refresh_token) {
    try {
      await assertCorrectGoogleAccount();
      const out = await listGoogleEvents({
        timeMin: rangeStart.toISOString(),
        timeMax: rangeEnd.toISOString(),
      });
      if (out?.ok && Array.isArray(out.events)) {
        return { source: "google", events: out.events };
      }
    } catch (e) {
      console.error("[loadEventsForRange] google load failed:", e?.message || e);
    }
  }

  const db = readDb();
  return { source: "local", events: filterEventsByRange(db.events, rangeStart, rangeEnd) };
}

// ---- Auth (API Key) ----
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();

  const key =
    req.header("x-api-key") ||
    req.header("X-Api-Key") ||
    req.header("authorization")?.replace(/^Bearer\s+/i, "");

  if (!key || key !== API_KEY) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }
  next();
}

// ---- Static Web (www/ oder public/) ----
function pickWebDir() {
  const candidates = [
    path.join(__dirname, "..", "www"),
    path.join(__dirname, "..", "public"),
    path.join(__dirname, "www"),
    path.join(__dirname, "public"),
  ];
  for (const p of candidates) {
    try {
      if (
        fs.existsSync(p) &&
        fs.statSync(p).isDirectory() &&
        fs.existsSync(path.join(p, "index.html"))
      ) {
        return p;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

const WEB_DIR = pickWebDir();
if (WEB_DIR) {
  app.use(express.static(WEB_DIR));
  logDebug(`Serving static from: ${WEB_DIR}`);
} else {
  console.warn("⚠️  No static web dir found (expected ../www or ../public with index.html)");
}

// ---- Health ----
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "calendar-api", authEnabled: !!API_KEY, webDir: WEB_DIR || null });
});

app.get("/api/monitoring", requireApiKey, (req, res) => {
  res.json({ ok: true, monitoring: getMonitoringSnapshot() });
});

// ---- Google OAuth + Status ----
app.get("/api/google/status", async (req, res) => {
  try {
    const base = await getGoogleStatus();
    const tokens = (await loadTokens?.()) || null;
    const hasRefresh = !!tokens?.refresh_token;
    const storageInfo = getTokenStorageInfo();

    // base.google.connected basiert auf refresh_token; wir normalisieren trotzdem
    const connected = !!(base?.google?.connected && hasRefresh);

    const watchState = loadWatchState();
    const now = Date.now();

    let watchActive = false;
    let watchReason = "";

    if (!connected) {
      watchReason = "Google nicht verbunden";
    } else if (!watchState?.ok) {
      watchReason = "Status unbekannt";
    } else if (!watchState?.channelId || !watchState?.resourceId) {
      watchReason = "Watch nicht registriert";
    } else if (!watchState?.expiration) {
      watchReason = "Status unbekannt";
    } else if (int(watchState.expiration) <= now) {
      watchReason = "Watch abgelaufen";
    } else {
      watchActive = true;
    }

    let connectedEmail = null;
    let wrongAccount = false;

    if (connected) {
      try {
        connectedEmail = await getConnectedGoogleEmail();
        if (GOOGLE_ALLOWED_EMAIL && connectedEmail && connectedEmail !== GOOGLE_ALLOWED_EMAIL) {
          wrongAccount = true;
        }
      } catch {
        // ignore
      }
    }

    // WICHTIG: Immer base/google zurückgeben, auch wenn nicht verbunden.
    res.json({
      ...base,
      google: {
        ...base.google,
        connected,
        authenticated: hasRefresh,
        hasRefreshToken: hasRefresh,
        hasTokens: !!tokens,
        tokenStorage: storageInfo.tokenStorage,
        dbConfigured: storageInfo.dbConfigured,
        expiresAt: tokens?.expiry_date || null,
        expiry_date: tokens?.expiry_date || null,
        watchActive,
        reason: watchActive ? "" : watchReason,
        connectedEmail,
        allowedEmail: GOOGLE_ALLOWED_EMAIL || null,
        wrongAccount,
      },
      events: [],
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: "status failed", details: e?.message || String(e) });
  }
});

if (!IS_PROD) {
  app.get("/api/google/debug/storage", async (req, res) => {
    try {
      const tokens = (await loadTokens?.()) || null;
      const storageInfo = getTokenStorageInfo();
      res.json({
        ok: true,
        tokenStorage: storageInfo.tokenStorage,
        dbConfigured: storageInfo.dbConfigured,
        hasTokens: !!tokens,
        hasRefreshToken: !!tokens?.refresh_token,
        expiresAt: tokens?.expiry_date || null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, message: "debug storage failed", details: e?.message || String(e) });
    }
  });
}

function normalizeRedirectUri(raw) {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.pathname = "/api/google/callback";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return raw;
  }
}

function getRedirectUriInfo(req, { platform } = {}) {
  const envRedirect = (process.env.GOOGLE_REDIRECT_URI || "").trim();
  const envRedirectWeb = (process.env.GOOGLE_REDIRECT_URI_WEB || "").trim();
  const envRedirectAndroid = (process.env.GOOGLE_REDIRECT_URI_ANDROID || "").trim();
  const forwardedProto = req?.get?.("x-forwarded-proto") || "";
  const forwardedHost = req?.get?.("x-forwarded-host") || "";
  const hostHeader = req?.get?.("host") || "";
  const proto = String(forwardedProto || "https").split(",")[0].trim() || "https";
  const host = String(forwardedHost || hostHeader).split(",")[0].trim();
  const computedRedirectUri = envRedirect
    ? normalizeRedirectUri(envRedirect)
    : (host ? `${proto}://${host}/api/google/callback` : "");
  const resolvedWeb = normalizeRedirectUri(envRedirectWeb || envRedirect || computedRedirectUri);
  const resolvedAndroid = normalizeRedirectUri(envRedirectAndroid || envRedirect || computedRedirectUri);
  const selectedRedirectUri = platform === "android" ? resolvedAndroid : resolvedWeb;
  return {
    computedRedirectUri,
    envRedirect,
    envRedirectWeb,
    envRedirectAndroid,
    resolvedWeb,
    resolvedAndroid,
    selectedRedirectUri,
    headers: {
      "x-forwarded-proto": forwardedProto || null,
      "x-forwarded-host": forwardedHost || null,
      host: hostHeader || null,
    },
  };
}

function getRedirectUri(req, { platform } = {}) {
  return getRedirectUriInfo(req, { platform }).selectedRedirectUri;
}

function resolveGoogleOAuthParams(req, { platform, state } = {}) {
  const cfg = getGoogleConfig();
  const isAndroid = platform === "android" || state === "android";
  const clientId = cfg.GOOGLE_CLIENT_ID;
  const redirectUri = getRedirectUri(req, { platform: isAndroid ? "android" : "web" });
  return { cfg, isAndroid, clientId, redirectUri };
}

app.get("/api/google/debug-oauth", (req, res) => {
  const info = getRedirectUriInfo(req, { platform: req.query.platform });
  res.json({
    computedRedirectUri: info.computedRedirectUri,
    resolvedRedirectUri: info.selectedRedirectUri,
    platformRedirects: {
      web: info.resolvedWeb,
      android: info.resolvedAndroid,
    },
    headers: info.headers,
    env: {
      GOOGLE_REDIRECT_URI: info.envRedirect || null,
      GOOGLE_REDIRECT_URI_WEB: info.envRedirectWeb || null,
      GOOGLE_REDIRECT_URI_ANDROID: info.envRedirectAndroid || null,
    },
    hint: "This exact URI must be in Google Console Authorized redirect URIs",
  });
});

app.get("/api/google/auth-url", async (req, res) => {
  const { isAndroid, redirectUri, clientId } = resolveGoogleOAuthParams(req, { platform: req.query.platform });
  const state = isAndroid ? "android" : "";
  const platform = req.query.platform ? String(req.query.platform) : "";
  if (!redirectUri) {
    return res.status(500).json({
      ok: false,
      message:
        "Redirect URI konnte nicht berechnet werden (Host fehlt). Setze GOOGLE_REDIRECT_URI oder sende Host/x-forwarded-host.",
    });
  }
  logDebug(
    `[google oauth] auth-url redirectUri=${redirectUri} platform=${platform || "-"} state=${state || "-"}`
  );

  res.json(await getAuthUrl({ redirectUri, state, clientId }));
});

// Disconnect (löscht Tokens)
app.post("/api/google/disconnect", requireApiKey, async (req, res) => {
  try {
    await clearTokens();
    if (fs.existsSync(TOKENS_PATH)) fs.unlinkSync(TOKENS_PATH);
    res.json({ ok: true, disconnected: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: "disconnect failed", details: e?.message || String(e) });
  }
});

// Callback: Google redirectet zu GOOGLE_REDIRECT_URI?code=...
async function handleGoogleCallback(req, res) {
  try {
    const code = req.query.code ? String(req.query.code) : "";
    const state = req.query.state ? String(req.query.state) : "";
    const { isAndroid, redirectUri, clientId } = resolveGoogleOAuthParams(req, {
      platform: req.query.platform,
      state,
    });
    const platform = req.query.platform ? String(req.query.platform) : "";
    if (!redirectUri) {
      return res
        .status(500)
        .send("<h2>❌ Fehler</h2><pre>Redirect URI fehlt (Host-Header nicht vorhanden).</pre>");
    }
    logDebug(
      `[google oauth] callback redirectUri=${redirectUri} platform=${platform || "-"} state=${state || "-"}`
    );
    const out = await exchangeCodeForTokens(code, redirectUri, clientId);

    if (!out.ok) {
      return res.status(400).send(`<h2>❌ Fehler</h2><pre>${escapeHtml(out.message || "unknown")}</pre>`);
    }

    if (isAndroid) {
      return res.redirect(302, "calendar-mvp://oauth");
    }

    let hint = "";
    try {
      const email = await getConnectedGoogleEmail();
      if (email) {
        hint += `<p><b>Verbunden als:</b> ${escapeHtml(email)}</p>`;
        if (GOOGLE_ALLOWED_EMAIL && email.toLowerCase() !== GOOGLE_ALLOWED_EMAIL) {
          hint += `<p style="color:#b00020"><b>⚠️ Falscher Account.</b> Erlaubt ist: ${escapeHtml(
            GOOGLE_ALLOWED_EMAIL
          )}</p>`;
        }
      }
    } catch {
      // ignore
    }

    return res
      .status(200)
      .send(
        `<h2>✅ Google verbunden</h2>
         <p>Tokens gespeichert.</p>
         ${hint}
         <p>Du kannst dieses Fenster schließen.</p>`
      );
  } catch (e) {
    res.status(500).send(`<h2>❌ Fehler</h2><pre>${escapeHtml(e?.message || "unknown")}</pre>`);
  }
}

// Callback: Google redirectet zu GOOGLE_REDIRECT_URI?code=...
app.get("/api/google/callback", handleGoogleCallback);
// Alias for legacy redirect URIs like /auth/google/callback
app.get("/auth/google/callback", handleGoogleCallback);

async function createAndMirrorEvent({ title, start, end, location = "", notes = "" }) {
  const out = await createGoogleEvent({ title, start, end, location, notes });
  if (!out.ok) return { ok: false, status: 400, payload: out };

  const googleId = out.googleEvent?.id ? String(out.googleEvent.id) : uid("gcal");
  const db = readDb();
  const ev = {
    id: `gcal_${googleId}`,
    title: String(title),
    start: String(start),
    end: String(end),
    location: String(location || ""),
    notes: String(notes || ""),
    color: "",
    googleEventId: googleId,
  };
  db.events.push(ev);
  writeDb(db);

  const normalizedEvent = {
    id: `gcal_${googleId}`,
    title: String(out.googleEvent?.summary || title || "Termin"),
    start: String(out.googleEvent?.start?.dateTime || start || ""),
    end: String(out.googleEvent?.end?.dateTime || end || ""),
    location: String(out.googleEvent?.location || location || ""),
    notes: String(out.googleEvent?.description || notes || ""),
    googleEventId: googleId,
  };

  return { ok: true, normalizedEvent, googleEvent: out.googleEvent, mirroredEvent: ev };
}

async function handleGoogleEventCreate(req, res) {
  try {
    await assertCorrectGoogleAccount();

    const { title, start, end, location = "", notes = "" } = req.body || {};
    const created = await createAndMirrorEvent({ title, start, end, location, notes });
    if (!created.ok) return res.status(created.status || 400).json(created.payload || { ok: false });

    res.json({
      ok: true,
      event: created.normalizedEvent,
      googleEvent: created.googleEvent,
      mirroredEvent: created.mirroredEvent,
    });
  } catch (e) {
    const msg = String(e?.message || "");
    const isNotConnected =
      msg.includes("Nicht verbunden") ||
      msg.includes("keine Tokens") ||
      msg.includes("Google nicht verbunden") ||
      msg.includes("Access Token") ||
      msg.includes("Tokens");

    if (isNotConnected) {
      return res.status(401).json({
        ok: false,
        error: "GOOGLE_NOT_CONNECTED",
        message: "Google nicht verbunden",
      });
    }

    res.status(500).json({ ok: false, message: e?.message || "unknown" });
  }
}

async function handleEventSuggestions(req, res) {
  try {
    await assertCorrectGoogleAccount();
    pruneSuggestions();

    const {
      title,
      date,
      preferredTime,
      durationMinutes,
      location = "",
      notes = "",
      daysForward = 5,
      windowStart = "08:00",
      windowEnd = "18:00",
      stepMinutes = 30,
      maxSuggestions = 5,
    } = req.body || {};

    const baseDate = parseDateInput(date);
    const duration = Math.max(5, Math.min(int(durationMinutes), 24 * 60));
    const days = Math.max(1, Math.min(int(daysForward) || 5, 14));
    const step = Math.max(5, Math.min(int(stepMinutes) || 30, 120));
    const limit = Math.max(1, Math.min(int(maxSuggestions) || 5, 10));

    if (!title || !baseDate || !duration) {
      return res.status(400).json({ ok: false, message: "title/date/durationMinutes required" });
    }

    const rangeStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 0, 0, 0, 0);
    const rangeEnd = addDays(rangeStart, days);

    const eventsRes = await listGoogleEvents({
      timeMin: rangeStart.toISOString(),
      timeMax: rangeEnd.toISOString(),
    });
    if (!eventsRes?.ok) {
      return res.status(500).json({ ok: false, message: "events fetch failed" });
    }

    const occupied = buildOccupiedIntervals(eventsRes.events || [], rangeStart, rangeEnd);
    const suggestions = [];

    for (let dayOffset = 0; dayOffset < days; dayOffset += 1) {
      const dayDate = addDays(rangeStart, dayOffset);
      const windowStartDate = atTime(dayDate, windowStart);
      const windowEndDate = atTime(dayDate, windowEnd);
      if (!windowStartDate || !windowEndDate || windowEndDate <= windowStartDate) continue;

      let cursor = windowStartDate;
      if (dayOffset === 0 && preferredTime) {
        const preferred = atTime(dayDate, preferredTime);
        if (preferred && preferred > cursor) cursor = preferred;
      }

      while (addMinutes(cursor, duration) <= windowEndDate) {
        const candidateEnd = addMinutes(cursor, duration);
        if (!isConflict(occupied, cursor, candidateEnd)) {
          const id = crypto.randomUUID ? crypto.randomUUID() : uid("sugg");
          const startIso = toLocalIsoWithOffset(cursor);
          const endIso = toLocalIsoWithOffset(candidateEnd);
          suggestionStore.set(id, {
            id,
            title,
            start: startIso,
            end: endIso,
            location,
            notes,
            source: "classic",
            createdAt: Date.now(),
          });
          suggestions.push({ id, start: startIso, end: endIso });
          if (suggestions.length >= limit) break;
        }
        cursor = addMinutes(cursor, step);
      }
      if (suggestions.length >= limit) break;
    }

    return res.json({
      ok: true,
      suggestions,
      timezone: getGoogleConfig().GOOGLE_TIMEZONE || "Europe/Zurich",
    });
  } catch (e) {
    const msg = String(e?.message || "");
    const isNotConnected =
      msg.includes("Nicht verbunden") ||
      msg.includes("keine Tokens") ||
      msg.includes("Google nicht verbunden") ||
      msg.includes("Access Token") ||
      msg.includes("Tokens");

    if (isNotConnected) {
      return res.status(401).json({
        ok: false,
        error: "GOOGLE_NOT_CONNECTED",
        message: "Google nicht verbunden",
      });
    }

    res.status(500).json({ ok: false, message: e?.message || "unknown" });
  }
}

async function handleEventSuggestionConfirm(req, res) {
  try {
    await assertCorrectGoogleAccount();
    pruneSuggestions();

    const { suggestionId } = req.body || {};
    if (!suggestionId) {
      return res.status(400).json({ ok: false, message: "suggestionId required" });
    }

    const entry = suggestionStore.get(String(suggestionId));
    if (!entry) {
      return res.status(404).json({ ok: false, message: "suggestion not found or expired" });
    }

    const created = await createAndMirrorEvent({
      title: entry.title,
      start: entry.start,
      end: entry.end,
      location: entry.location || "",
      notes: entry.notes || "",
    });
    if (!created.ok) return res.status(created.status || 400).json(created.payload || { ok: false });

    const db = readDb();
    updateLearningFromInteraction(db, {
      start: entry.start,
      source: entry.source || "suggestion",
      title: entry.title,
    });
    writeDb(db);

    suggestionStore.delete(String(suggestionId));
    return res.json({
      ok: true,
      event: created.normalizedEvent,
      googleEvent: created.googleEvent,
      mirroredEvent: created.mirroredEvent,
    });
  } catch (e) {
    const msg = String(e?.message || "");
    const isNotConnected =
      msg.includes("Nicht verbunden") ||
      msg.includes("keine Tokens") ||
      msg.includes("Google nicht verbunden") ||
      msg.includes("Access Token") ||
      msg.includes("Tokens");

    if (isNotConnected) {
      return res.status(401).json({
        ok: false,
        error: "GOOGLE_NOT_CONNECTED",
        message: "Google nicht verbunden",
      });
    }

    res.status(500).json({ ok: false, message: e?.message || "unknown" });
  }
}

function addEventToHourlyUsage(hourlyUsage, start, end) {
  let cursor = new Date(start);
  while (cursor < end) {
    const next = new Date(cursor);
    next.setMinutes(0, 0, 0);
    next.setHours(cursor.getHours() + 1);
    const overlapEnd = end < next ? end : next;
    const minutes = Math.max(0, (overlapEnd - cursor) / 60000);
    hourlyUsage[cursor.getHours()] += minutes;
    cursor = next;
  }
}

function buildHourlyHabits(events, rangeStart, rangeEnd) {
  const hourlyUsage = Array.from({ length: 24 }, () => 0);
  for (const ev of events || []) {
    const start = ev?.start ? new Date(ev.start) : null;
    const end = ev?.end ? new Date(ev.end) : null;
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (start >= rangeEnd || end <= rangeStart) continue;
    addEventToHourlyUsage(hourlyUsage, start, end);
  }
  return hourlyUsage;
}

function normalizeHourlyUsage(hourlyUsage, rangeStart, rangeEnd) {
  const dayMs = 24 * 60 * 60 * 1000;
  const dayCount = Math.max(1, Math.round((rangeEnd - rangeStart) / dayMs));
  return hourlyUsage.map((minutes) => clamp(minutes / (dayCount * 60), 0, 1));
}

function buildDayLoads(events, rangeStart, days) {
  const loads = new Map();
  for (let i = 0; i < days; i += 1) {
    const dayStart = addDays(rangeStart, i);
    const dayEnd = addDays(dayStart, 1);
    let minutes = 0;
    for (const ev of events || []) {
      const start = ev?.start ? new Date(ev.start) : null;
      const end = ev?.end ? new Date(ev.end) : null;
      if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
      const overlap = overlapMinutes(start, end, dayStart, dayEnd);
      if (overlap > 0) minutes += overlap;
    }
    loads.set(dateKeyLocal(dayStart), Math.round(minutes));
  }
  return loads;
}

function getCandidateReason({ preferenceLabel, habitScore, dayLoadMinutes, bufferOk, recurringMatch }) {
  const reasons = [];
  if (preferenceLabel) reasons.push(`passt zu deiner Präferenz (${preferenceLabel})`);
  if (recurringMatch) reasons.push("passt zu deinen regelmäßigen Aktivitäten");
  if (habitScore <= 0.25) reasons.push("ruhige Gewohnheitszeit");
  if (dayLoadMinutes <= 240) reasons.push("Tag mit Luft für Fokus");
  if (bufferOk) reasons.push("Puffer zu anderen Terminen");
  return reasons.join(" • ");
}

async function handleSmartSuggestions(req, res) {
  try {
    pruneSuggestions();

    const {
      title,
      date,
      durationMinutes,
      daysForward = 7,
      windowStart,
      windowEnd,
      stepMinutes = 30,
      maxSuggestions = 5,
      preference = "none",
      bufferMinutes,
      lookbackDays = 21,
    } = req.body || {};

    const db = readDb();
    const storedPreferences = normalizePreferences(db.preferences || {});

    const baseDate = parseDateInput(date) || new Date();
    const duration = Math.max(5, Math.min(int(durationMinutes) || 60, 24 * 60));
    const days = Math.max(1, Math.min(int(daysForward) || 7, 14));
    const step = Math.max(5, Math.min(int(stepMinutes) || 30, 120));
    const limit = Math.max(1, Math.min(int(maxSuggestions) || 5, 10));
    const bufferFallback = Number.isFinite(Number(bufferMinutes)) ? int(bufferMinutes) : int(storedPreferences.bufferMinutes);
    const buffer = Math.max(0, Math.min(bufferFallback || 0, 120));
    const resolvedWindowStart = windowStart || storedPreferences.windowStart || "08:00";
    const resolvedWindowEnd = windowEnd || storedPreferences.windowEnd || "18:00";

    if (!title || !duration) {
      return res.status(400).json({ ok: false, message: "title/durationMinutes required" });
    }

    const rangeStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 0, 0, 0, 0);
    const rangeEnd = addDays(rangeStart, days);

    const { events: upcomingEvents } = await loadEventsForRange(rangeStart, rangeEnd);
    const occupied = buildOccupiedIntervals(upcomingEvents || [], rangeStart, rangeEnd);
    const dayLoads = buildDayLoads(upcomingEvents || [], rangeStart, days);

    const habitRangeStart = addDays(rangeStart, -Math.max(7, Math.min(int(lookbackDays) || 21, 60)));
    const habitRangeEnd = rangeStart;
    const { events: pastEvents } = await loadEventsForRange(habitRangeStart, habitRangeEnd);
    const habitUsage = buildHourlyHabits(pastEvents || [], habitRangeStart, habitRangeEnd);
    const habitScores = normalizeHourlyUsage(habitUsage, habitRangeStart, habitRangeEnd);
    const recurringPattern = summarizeRecurringPattern(pastEvents || [], title);

    const suggestions = [];
    const preferenceMap = {
      morning: { start: 6, end: 12, label: "Vormittag" },
      afternoon: { start: 12, end: 17, label: "Nachmittag" },
      evening: { start: 17, end: 21, label: "Abend" },
    };
    const learnedPreference = derivePreferredTimeOfDay(storedPreferences);
    const effectivePreference = preference === "none" ? learnedPreference : preference;
    const pref = preferenceMap[effectivePreference] || null;
    const preferenceSource = pref ? (preference === "none" ? "learned" : "user") : "none";

    for (let dayOffset = 0; dayOffset < days; dayOffset += 1) {
      const dayDate = addDays(rangeStart, dayOffset);
      const windowStartDate = atTime(dayDate, resolvedWindowStart);
      const windowEndDate = atTime(dayDate, resolvedWindowEnd);
      if (!windowStartDate || !windowEndDate || windowEndDate <= windowStartDate) continue;

      let cursor = windowStartDate;
      while (addMinutes(cursor, duration) <= windowEndDate) {
        const candidateEnd = addMinutes(cursor, duration);
        if (!isConflict(occupied, cursor, candidateEnd)) {
          const candidateHours = [];
          let score = 50;
          let bufferOk = true;
          let minGap = Infinity;

          for (let h = cursor.getHours(); h <= candidateEnd.getHours(); h += 1) {
            candidateHours.push(h % 24);
          }

          const avgHabit = candidateHours.length
            ? candidateHours.reduce((acc, h) => acc + (habitScores[h] || 0), 0) / candidateHours.length
            : 0;
          score += (1 - avgHabit) * 20;

          const dayKey = dateKeyLocal(dayDate);
          const dayLoad = dayLoads.get(dayKey) || 0;
          score += (1 - clamp(dayLoad / 480, 0, 1)) * 15;

          let inPref = false;
          if (pref) {
            inPref = cursor.getHours() >= pref.start && cursor.getHours() < pref.end;
            if (inPref) score += 15;
          }

          let recurringMatch = false;
          if (recurringPattern) {
            const candidateHour = cursor.getHours() + cursor.getMinutes() / 60;
            const hourDelta = Math.abs(candidateHour - recurringPattern.avgHour);
            const hourScore = (1 - clamp(hourDelta / 6, 0, 1)) * 12;
            score += hourScore;
            if (recurringPattern.weekday !== null && cursor.getDay() === recurringPattern.weekday) {
              score += 6;
              recurringMatch = true;
            }
            if (hourDelta <= 1.5) recurringMatch = true;
          }

          for (const block of occupied) {
            if (block.end <= cursor) {
              minGap = Math.min(minGap, (cursor - block.end) / 60000);
            } else if (block.start >= candidateEnd) {
              minGap = Math.min(minGap, (block.start - candidateEnd) / 60000);
            }
          }

          if (Number.isFinite(minGap)) {
            bufferOk = minGap >= buffer;
            if (bufferOk) score += 10;
          }

          const id = crypto.randomUUID ? crypto.randomUUID() : uid("smart");
          const startIso = toLocalIsoWithOffset(cursor);
          const endIso = toLocalIsoWithOffset(candidateEnd);
          const reason = getCandidateReason({
            preferenceLabel: inPref ? pref?.label || "" : "",
            habitScore: avgHabit,
            dayLoadMinutes: dayLoad,
            bufferOk,
            recurringMatch,
          });

          suggestionStore.set(id, {
            id,
            title,
            start: startIso,
            end: endIso,
            location: "",
            notes: "",
            source: "smart",
            preferenceUsed: pref ? effectivePreference : "none",
            createdAt: Date.now(),
          });

          suggestions.push({ id, start: startIso, end: endIso, score, reason });
        }
        cursor = addMinutes(cursor, step);
      }
    }

    suggestions.sort((a, b) => b.score - a.score);
    const topSuggestions = suggestions.slice(0, limit);

    const dayLoadEntries = Array.from(dayLoads.entries()).sort((a, b) => b[1] - a[1]);
    const busiestDay = dayLoadEntries[0]?.[0] || null;
    const quietestDay = dayLoadEntries[dayLoadEntries.length - 1]?.[0] || null;
    const leastBusyHour = habitScores
      .map((value, hour) => ({ hour, value }))
      .sort((a, b) => a.value - b.value)[0];

    const optimizations = [];
    if (busiestDay && quietestDay && busiestDay !== quietestDay) {
      optimizations.push({
        title: "Auslastung ausgleichen",
        message: `Der ${busiestDay} ist besonders dicht. Der ${quietestDay} bietet mehr Luft für Fokusblöcke.`,
      });
    }
    if (leastBusyHour) {
      optimizations.push({
        title: "Gewohnheitsbasierter Fokus-Slot",
        message: `Historisch ist es um ${pad2(leastBusyHour.hour)}:00 am ruhigsten. Ideal für konzentrierte Arbeit.`,
      });
    }

    res.json({
      ok: true,
      suggestions: topSuggestions,
      optimizations,
      appliedPreferences: {
        timeOfDay: pref ? effectivePreference : "none",
        source: preferenceSource,
        weights: storedPreferences.timeOfDayWeights,
        bufferMinutes: buffer,
        windowStart: resolvedWindowStart,
        windowEnd: resolvedWindowEnd,
      },
      habits: {
        leastBusyHour: leastBusyHour?.hour ?? null,
      },
      timezone: getGoogleConfig().GOOGLE_TIMEZONE || "Europe/Zurich",
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "smart suggestions failed" });
  }
}

async function handleFreeSlots(req, res) {
  try {
    await assertCorrectGoogleAccount();
    pruneFreeSlots();

    const {
      date,
      durationMinutes,
      daysForward = 5,
      windowStart = "08:00",
      windowEnd = "18:00",
      stepMinutes = 30,
      maxSlots = 8,
    } = req.body || {};

    const baseDate = parseDateInput(date);
    const duration = Math.max(5, Math.min(int(durationMinutes), 24 * 60));
    const days = Math.max(1, Math.min(int(daysForward) || 5, 14));
    const step = Math.max(5, Math.min(int(stepMinutes) || 30, 120));
    const limit = Math.max(1, Math.min(int(maxSlots) || 8, 12));

    if (!baseDate || !duration) {
      return res.status(400).json({ ok: false, message: "date/durationMinutes required" });
    }

    const rangeStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 0, 0, 0, 0);
    const rangeEnd = addDays(rangeStart, days);

    const eventsRes = await listGoogleEvents({
      timeMin: rangeStart.toISOString(),
      timeMax: rangeEnd.toISOString(),
    });
    if (!eventsRes?.ok) {
      return res.status(500).json({ ok: false, message: "events fetch failed" });
    }

    const occupied = buildOccupiedIntervals(eventsRes.events || [], rangeStart, rangeEnd);
    const slots = [];

    for (let dayOffset = 0; dayOffset < days; dayOffset += 1) {
      const dayDate = addDays(rangeStart, dayOffset);
      const windowStartDate = atTime(dayDate, windowStart);
      const windowEndDate = atTime(dayDate, windowEnd);
      if (!windowStartDate || !windowEndDate || windowEndDate <= windowStartDate) continue;

      let cursor = windowStartDate;
      while (addMinutes(cursor, duration) <= windowEndDate) {
        const candidateEnd = addMinutes(cursor, duration);
        if (!isConflict(occupied, cursor, candidateEnd)) {
          const id = crypto.randomUUID ? crypto.randomUUID() : uid("slot");
          const startIso = toLocalIsoWithOffset(cursor);
          const endIso = toLocalIsoWithOffset(candidateEnd);
          freeSlotStore.set(id, {
            id,
            start: startIso,
            end: endIso,
            createdAt: Date.now(),
          });
          slots.push({ id, start: startIso, end: endIso });
          if (slots.length >= limit) break;
        }
        cursor = addMinutes(cursor, step);
      }
      if (slots.length >= limit) break;
    }

    return res.json({
      ok: true,
      slots,
      timezone: getGoogleConfig().GOOGLE_TIMEZONE || "Europe/Zurich",
    });
  } catch (e) {
    const msg = String(e?.message || "");
    const isNotConnected =
      msg.includes("Nicht verbunden") ||
      msg.includes("keine Tokens") ||
      msg.includes("Google nicht verbunden") ||
      msg.includes("Access Token") ||
      msg.includes("Tokens");

    if (isNotConnected) {
      return res.status(401).json({
        ok: false,
        error: "GOOGLE_NOT_CONNECTED",
        message: "Google nicht verbunden",
      });
    }

    res.status(500).json({ ok: false, message: e?.message || "unknown" });
  }
}

function handlePreferencesGet(req, res) {
  const db = readDb();
  res.json({
    ok: true,
    preferences: normalizePreferences(db.preferences || {}),
    learning: normalizeLearning(db.learning || {}),
  });
}

function handlePreferencesUpdate(req, res) {
  const db = readDb();
  const updates = req.body || {};
  const nextPreferences = normalizePreferences({
    ...db.preferences,
    bufferMinutes: Number.isFinite(Number(updates.bufferMinutes)) ? Number(updates.bufferMinutes) : db.preferences?.bufferMinutes,
    windowStart: updates.windowStart || db.preferences?.windowStart,
    windowEnd: updates.windowEnd || db.preferences?.windowEnd,
  });

  if (updates.timeOfDayWeights && typeof updates.timeOfDayWeights === "object") {
    const nextWeights = {
      morning: Number(updates.timeOfDayWeights.morning ?? nextPreferences.timeOfDayWeights.morning ?? 0),
      afternoon: Number(updates.timeOfDayWeights.afternoon ?? nextPreferences.timeOfDayWeights.afternoon ?? 0),
      evening: Number(updates.timeOfDayWeights.evening ?? nextPreferences.timeOfDayWeights.evening ?? 0),
    };
    nextPreferences.timeOfDayWeights = normalizeWeights(nextWeights);
  }

  nextPreferences.lastUpdated = Date.now();
  db.preferences = nextPreferences;
  writeDb(db);
  res.json({ ok: true, preferences: nextPreferences });
}

async function handleFreeSlotApprove(req, res) {
  try {
    await assertCorrectGoogleAccount();
    pruneFreeSlots();

    const { slotId } = req.body || {};
    if (!slotId) {
      return res.status(400).json({ ok: false, message: "slotId required" });
    }

    const entry = freeSlotStore.get(String(slotId));
    if (!entry) {
      return res.status(404).json({ ok: false, message: "slot not found or expired" });
    }

    approvedFreeSlotStore.set(String(slotId), {
      ...entry,
      approvedAt: Date.now(),
      createdAt: entry.createdAt || Date.now(),
    });

    return res.json({
      ok: true,
      approvedSlots: Array.from(approvedFreeSlotStore.values()),
    });
  } catch (e) {
    const msg = String(e?.message || "");
    const isNotConnected =
      msg.includes("Nicht verbunden") ||
      msg.includes("keine Tokens") ||
      msg.includes("Google nicht verbunden") ||
      msg.includes("Access Token") ||
      msg.includes("Tokens");

    if (isNotConnected) {
      return res.status(401).json({
        ok: false,
        error: "GOOGLE_NOT_CONNECTED",
        message: "Google nicht verbunden",
      });
    }

    res.status(500).json({ ok: false, message: e?.message || "unknown" });
  }
}

async function handleFreeSlotsApproved(req, res) {
  try {
    await assertCorrectGoogleAccount();
    pruneFreeSlots();
    return res.json({ ok: true, approvedSlots: Array.from(approvedFreeSlotStore.values()) });
  } catch (e) {
    const msg = String(e?.message || "");
    const isNotConnected =
      msg.includes("Nicht verbunden") ||
      msg.includes("keine Tokens") ||
      msg.includes("Google nicht verbunden") ||
      msg.includes("Access Token") ||
      msg.includes("Tokens");

    if (isNotConnected) {
      return res.status(401).json({
        ok: false,
        error: "GOOGLE_NOT_CONNECTED",
        message: "Google nicht verbunden",
      });
    }

    res.status(500).json({ ok: false, message: e?.message || "unknown" });
  }
}

async function handleFreeSlotConfirm(req, res) {
  try {
    await assertCorrectGoogleAccount();
    pruneFreeSlots();

    const { slotId, title, location = "", notes = "" } = req.body || {};
    if (!slotId || !title) {
      return res.status(400).json({ ok: false, message: "slotId/title required" });
    }

    const entry = approvedFreeSlotStore.get(String(slotId));
    if (!entry) {
      return res.status(404).json({ ok: false, message: "approved slot not found or expired" });
    }

    const created = await createAndMirrorEvent({
      title,
      start: entry.start,
      end: entry.end,
      location,
      notes,
    });
    if (!created.ok) return res.status(created.status || 400).json(created.payload || { ok: false });

    const db = readDb();
    updateLearningFromInteraction(db, {
      start: entry.start,
      source: "free-slot",
      title,
    });
    writeDb(db);

    approvedFreeSlotStore.delete(String(slotId));
    freeSlotStore.delete(String(slotId));

    return res.json({
      ok: true,
      event: created.normalizedEvent,
      googleEvent: created.googleEvent,
      mirroredEvent: created.mirroredEvent,
      approvedSlots: Array.from(approvedFreeSlotStore.values()),
    });
  } catch (e) {
    const msg = String(e?.message || "");
    const isNotConnected =
      msg.includes("Nicht verbunden") ||
      msg.includes("keine Tokens") ||
      msg.includes("Google nicht verbunden") ||
      msg.includes("Access Token") ||
      msg.includes("Tokens");

    if (isNotConnected) {
      return res.status(401).json({
        ok: false,
        error: "GOOGLE_NOT_CONNECTED",
        message: "Google nicht verbunden",
      });
    }

    res.status(500).json({ ok: false, message: e?.message || "unknown" });
  }
}

// ---- Create event in Google Calendar (insert) + Spiegelung in db.json ----
app.post("/api/google/events", requireApiKey, handleGoogleEventCreate);
app.post("/api/create-event", requireApiKey, handleGoogleEventCreate);
app.post("/api/event-suggestions", requireApiKey, handleEventSuggestions);
app.post("/api/event-suggestions/confirm", requireApiKey, handleEventSuggestionConfirm);
app.post("/api/smart-suggestions", requireApiKey, handleSmartSuggestions);
app.post("/api/free-slots", requireApiKey, handleFreeSlots);
app.post("/api/free-slots/approve", requireApiKey, handleFreeSlotApprove);
app.post("/api/free-slots/confirm", requireApiKey, handleFreeSlotConfirm);
app.get("/api/free-slots/approved", requireApiKey, handleFreeSlotsApproved);
app.get("/api/preferences", requireApiKey, handlePreferencesGet);
app.patch("/api/preferences", requireApiKey, handlePreferencesUpdate);

async function handleGoogleEventsList(req, res) {
  const tokens = (await loadTokens?.()) || null;
  if (!tokens?.refresh_token) {
    return res.status(200).json({ ok: true, events: [] });
  }

  try {
    await assertCorrectGoogleAccount();

    const daysPast = Number(req.query.daysPast || 365);
    const daysFuture = Number(req.query.daysFuture || 365);

    const now = new Date();
    const timeMin = new Date(now.getTime() - daysPast * 24 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(now.getTime() + daysFuture * 24 * 60 * 60 * 1000).toISOString();

    const out = await listGoogleEvents({ timeMin, timeMax });
    if (!out?.ok) {
      console.error("[/api/google/events] error:", out?.message || "unknown");
      return res.status(200).json({ ok: false, error: "google_events_failed", events: [] });
    }
    return res.status(200).json(out);
  } catch (err) {
    console.error("[/api/google/events] error:", err);
    return res.status(200).json({ ok: false, error: "google_events_failed", events: [] });
  }
}

// ---- Phase 2 Sync (READ): Google Events list ----
// ❗ bewusst ohne requireApiKey, damit die App im LAN/Emulator ohne Key lesen kann
// Query: ?daysPast=365&daysFuture=365
app.get("/api/google/events", handleGoogleEventsList);
app.get("/api/get-events", handleGoogleEventsList);

async function loadWeekEvents(rangeStart, rangeEnd) {
  const tokens = (await loadTokens?.()) || null;
  if (tokens?.refresh_token) {
    try {
      await assertCorrectGoogleAccount();
      const out = await listGoogleEvents({
        timeMin: rangeStart.toISOString(),
        timeMax: rangeEnd.toISOString(),
      });
      if (out?.ok && Array.isArray(out.events)) {
        return { source: "google", events: out.events };
      }
    } catch (e) {
      console.error("[/api/weekly-load] google load failed:", e?.message || e);
    }
  }

  const db = readDb();
  return { source: "local", events: Array.isArray(db.events) ? db.events : [] };
}

app.get("/api/weekly-load", async (req, res) => {
  try {
    const rawWeekStart = parseDateInput(String(req.query.weekStart || ""));
    const weekStart = rawWeekStart ? startOfWeekLocal(rawWeekStart) : startOfWeekLocal(new Date());
    const weekEnd = addDays(weekStart, 7);

    const { events, source } = await loadWeekEvents(weekStart, weekEnd);
    const days = [];
    const suggestions = [];
    const breakRecommendations = [];
    let totalMinutes = 0;
    let totalStress = 0;
    let busiest = null;

    for (let i = 0; i < 7; i++) {
      const dayStart = addDays(weekStart, i);
      const dayEnd = addDays(dayStart, 1);
      let minutes = 0;
      let count = 0;

      for (const ev of events || []) {
        const start = ev?.start ? new Date(ev.start) : null;
        const end = ev?.end ? new Date(ev.end) : null;
        if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
        const overlap = overlapMinutes(start, end, dayStart, dayEnd);
        if (overlap > 0) {
          minutes += overlap;
          count += 1;
        }
      }

      const stressScore = clamp(Math.round((minutes / 480) * 100 + (count / 6) * 15), 0, 100);
      const densityScore = clamp(Math.round((count / 8) * 100), 0, 100);

      const dayKey = dateKeyLocal(dayStart);
      days.push({
        date: dayKey,
        minutes: Math.round(minutes),
        count,
        stress: stressScore,
        density: densityScore,
      });

      totalMinutes += minutes;
      totalStress += stressScore;

      if (!busiest || minutes > busiest.minutes) {
        busiest = { date: dayKey, minutes, count };
      }

      if (minutes >= 480 || count >= 8) {
        suggestions.push({
          date: dayKey,
          message: "Sehr viele Termine – plane einen Pufferblock (30–60 Min) für Erholung.",
        });
      } else if (minutes >= 360 || count >= 6) {
        suggestions.push({
          date: dayKey,
          message: "Hohe Dichte – plane mindestens zwei kurze Pausen (15–30 Min).",
        });
      }

      const needsBreak = minutes >= 240 || count >= 4 || stressScore >= 60;
      if (needsBreak) {
        const breakSlot = findBestBreakSlot(events || [], dayStart);
        if (breakSlot) {
          breakRecommendations.push({
            date: dayKey,
            start: toLocalIsoWithOffset(breakSlot.start),
            end: toLocalIsoWithOffset(breakSlot.end),
            minutes: breakSlot.minutes,
          });
        }
      }
    }

    const averageStress = Math.round(totalStress / 7);
    const weekOverloaded = averageStress >= 65 || totalMinutes >= 2400;
    if (weekOverloaded) {
      suggestions.unshift({
        date: "Woche",
        message: "Woche stark ausgelastet – plane zusätzliche Pausen (mind. 2×15–30 Min pro Tag).",
      });
    }
    res.json({
      ok: true,
      source,
      weekStart: dateKeyLocal(weekStart),
      days,
      totals: {
        totalMinutes: Math.round(totalMinutes),
        averageStress,
        busiestDay: busiest?.date || null,
        busiestMinutes: Math.round(busiest?.minutes || 0),
        busiestCount: busiest?.count || 0,
      },
      suggestions,
      breakRecommendations,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "weekly load failed" });
  }
});



// ---- Phase 3 Push-Sync: Status + Ack (App fragt alle 30s) ----
// bewusst ohne requireApiKey, damit Emulator/Handy einfach lesen kann
app.get("/api/sync/status", async (req, res) => {
  try {
    const st = loadWatchState();
    const cfg = getGoogleConfig();
    const connected = !!(await loadTokens?.())?.refresh_token;
    if (!connected) {
      return res.json({ ok: true, events: [] });
    }
    const webhookUrl = getWebhookUrl() || null;

    res.json({
      ok: true,
      connected,
      dirty: !!st.dirty,
      lastChangeAt: st.lastChangeAt || null,
      lastPushAt: st.lastPushAt || null,
      lastResourceState: st.lastResourceState || null,
      watch: {
        hasChannel: !!(st.channelId && st.resourceId),
        expiration: st.expiration || null,
        webhookUrl,
        calendarId: cfg?.GOOGLE_CALENDAR_ID || "primary",
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "unknown" });
  }
});

app.post("/api/sync/ack", async (req, res) => {
  try {
    clearDirty();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "unknown" });
  }
});

// Google Watch Webhook (Google -> Server)
// Google sendet POSTs mit Headers (X-Goog-*) und meist leerem Body.
app.post("/api/google/watch/notify", async (req, res) => {
  // immer sofort 200 geben (Google erwartet schnelle Antwort)
  res.status(200).json({ ok: true });

  try {
    const st = loadWatchState();
    const expectedToken = st?.token ? String(st.token) : "";
    const gotToken = String(req.header("x-goog-channel-token") || "");

    if (expectedToken && gotToken && gotToken !== expectedToken) {
      // falsches Token -> ignorieren
      return;
    }

    const resourceState = String(req.header("x-goog-resource-state") || "");

    // Resource-State sauber unterscheiden (Phase 3 Spec)
    if (resourceState === "exists" || resourceState === "not_exists") {
      markDirty(resourceState);
      return;
    }

    if (resourceState === "sync") {
      // initial ping - nicht zwingend dirty, wir merken aber den letzten state
      const cur = loadWatchState();
      saveWatchState({ ...cur, lastPushAt: Date.now(), lastResourceState: "sync", lastError: null });
      return;
    }

    if (resourceState === "stop") {
      markDirty("stop");
      // watch schnell neu setzen (async)
      ensureGoogleWatch({ reason: "stop" }).catch(() => {});
      return;
    }

    // unknown state -> defensiv dirty
    markDirty(resourceState || "unknown");
  } catch {
    // ignore
  }
});

// Debug: Watch Status
app.get("/api/google/watch/status", async (req, res) => {
  try {
    const st = loadWatchState();
    const webhookUrl = getWebhookUrl() || null;
    res.json({ ok: true, ...st, webhookUrl });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "unknown" });
  }
});

// ---- Assistant Parse + Commit (AI Quick-Add Preview) ----
app.post("/api/assistant/parse", async (req, res) => {
  try {
    console.log("[ai-quick-add] request start");
    const { text = "", timezone, locale, referenceDateISO } = req.body || {};
    const rawText = String(text || "").trim();
    if (!rawText) {
      return res.status(400).json({ ok: false, message: "text fehlt" });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, message: "OPENAI_API_KEY fehlt" });
    }

    const tz = String(timezone || "Europe/Zurich");
    const loc = String(locale || "de-CH");
    const refDate = referenceDateISO || getDateISOInTimeZone(tz);

    const systemPrompt = [
      "You are a calendar parsing engine.",
      "Return a strict JSON object with the required fields only.",
      "If anything is missing or ambiguous, set needs_clarification=true and ask one short clarification_question.",
      "Never invent details.",
    ].join(" ");

    const userPrompt = [
      `Text: ${rawText}`,
      `Timezone: ${tz}`,
      `Locale: ${loc}`,
      `ReferenceDateISO: ${refDate}`,
    ].join("\n");

    const schema = {
      type: "object",
      additionalProperties: false,
      required: [
        "title",
        "date",
        "start",
        "end",
        "description",
        "needs_clarification",
        "clarification_question",
      ],
      properties: {
        title: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        start: { type: "string", description: "HH:MM 24h" },
        end: { type: "string", description: "HH:MM 24h" },
        description: { type: "string" },
        needs_clarification: { type: "boolean" },
        clarification_question: { type: "string" },
      },
    };

    const payload = {
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content: [{ type: "input_text", text: userPrompt }] },
      ],
      // Responses API: response_format -> text.format migration
      text: {
        format: {
          type: "json_schema",
          name: "ai_quick_add",
          strict: true,
          schema,
        },
      },
    };

    // TEMP DEBUG (remove later): return safe OpenAI error details to client.
    const buildOpenAiDebugPayload = ({ err, status, details }) => {
      const statusCode = status ?? err?.status ?? err?.response?.status ?? null;
      const code = err?.code || err?.error?.code || details?.error?.code || null;
      const type = err?.type || err?.error?.type || details?.error?.type || null;
      const message =
        err?.message ||
        details?.error?.message ||
        details?.message ||
        "OpenAI request failed";
      const safeDetails = details ?? err?.response?.data ?? err?.error?.message ?? null;
      return {
        ok: false,
        where: "ai_quick_add",
        status: statusCode,
        message,
        code,
        type,
        details: safeDetails,
        hint: "TEMP_DEBUG_REMOVE_LATER",
      };
    };

    let resp;
    let body;
    try {
      resp = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      body = await resp.json();
    } catch (err) {
      console.warn("[ai-quick-add] OpenAI request failed");
      return res.status(500).json(buildOpenAiDebugPayload({ err }));
    }

    if (!resp.ok) {
      console.warn("[ai-quick-add] OpenAI request failed");
      return res.status(500).json(
        buildOpenAiDebugPayload({
          err: new Error(body?.error?.message || "OpenAI error"),
          status: resp.status,
          details: body,
        }),
      );
    }

    const outputText =
      body?.output_text ||
      body?.output?.[0]?.content?.find((c) => c.type === "output_text")?.text ||
      body?.output?.[0]?.content?.[0]?.text ||
      "";

    console.log("[ai-quick-add] OpenAI request success");
    let parsed;
    try {
      parsed = JSON.parse(outputText || "{}");
    } catch (err) {
      console.warn("[ai-quick-add] Failed to parse OpenAI response JSON");
      return res.status(500).json({ ok: false, message: "AI response parse failed" });
    }

    const proposal = normalizeAssistantProposal({
      intent: parsed?.needs_clarification ? "clarify" : "create_event",
      confidence: parsed?.needs_clarification ? 0.5 : 1,
      event: {
        title: parsed?.title ?? null,
        dateISO: parsed?.date ?? null,
        startTime: parsed?.start ?? null,
        endTime: parsed?.end ?? null,
        durationMin: null,
        allDay: false,
        location: null,
        description: parsed?.description ?? null,
      },
      questions: parsed?.needs_clarification
        ? [parsed?.clarification_question].filter(Boolean)
        : [],
    });

    if (proposal.intent === "create_event" && !hasRequiredAssistantFields(proposal)) {
      const fallback = {
        ...proposal,
        intent: "clarify",
        confidence: Math.min(proposal.confidence || 0, 0.5),
        questions: proposal.questions?.length
          ? proposal.questions
          : ["Was ist der Titel?", "Wann genau soll der Termin stattfinden?"],
      };
      return res.json(fallback);
    }

    res.json(proposal);
  } catch (e) {
    res.status(500).json({ ok: false, message: "assistant parse failed", details: e?.message || "unknown" });
  }
});

// ---- AI Extract (PDF/Image -> Suggestions only) ----
// Example:
// curl -X POST "http://localhost:3000/api/ai/extract" \
//   -F "file=@./schedule.pdf" \
//   -F "timezone=Europe/Zurich" \
//   -F "locale=de-CH" \
//   -F "referenceDate=2025-01-15"
app.post(
  "/api/ai/extract",
  express.raw({ type: "multipart/form-data", limit: MAX_FORM_BYTES }),
  async (req, res) => {
    try {
      if (!OPENAI_API_KEY) {
        return res.status(400).json({ ok: false, message: "OPENAI_API_KEY missing" });
      }

      const parsed = parseMultipartFormData(req);
      if (!parsed.ok) {
        return res.status(parsed.status || 400).json({ ok: false, message: parsed.message || "invalid upload" });
      }

      const { fields, file } = parsed;
      const tz = String(fields.timezone || "Europe/Zurich").trim();
      const loc = String(fields.locale || "de-CH").trim();
      const referenceDate = String(fields.referenceDate || "").trim();
      const refDate = referenceDate || getDateISOInTimeZone(tz);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(refDate)) {
        return res.status(400).json({ ok: false, message: "referenceDate must be YYYY-MM-DD" });
      }

      const systemPrompt = [
        "You extract calendar suggestions from documents.",
        "Return JSON only with the schema provided.",
        "Do not invent times or dates; use null when unknown and lower confidence.",
        "Never auto-save; suggestions only.",
        "Include evidence hints (page or snippet references) for each proposal.",
      ].join(" ");

      const userPrompt = [
        "Extract events and tasks from the uploaded document.",
        `Timezone: ${tz}`,
        `Locale: ${loc}`,
        `ReferenceDate: ${refDate}`,
        "If locale is de-CH or de-DE and dates are ambiguous, prefer dd.mm.yyyy interpretation.",
      ].join("\n");

      const isImage = file.mimeType.startsWith("image/");
      const isPdf = file.mimeType === "application/pdf";
      const isDocx =
        file.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

      if (!isImage && !isPdf && !isDocx) {
        return res.status(400).json({ ok: false, message: "invalid file type" });
      }

      if (isPdf || isDocx) {
        const startedAt = Date.now();
        let extractedText = "";
        let pages = null;
        const warnings = [];

        try {
          if (isPdf) {
            const pdfResult = await extractPdfText(file.buffer);
            extractedText = pdfResult.text || "";
            pages = Number.isFinite(pdfResult.totalPages) ? pdfResult.totalPages : null;
          } else {
            const docxResult = await extractDocxText(file.buffer);
            extractedText = docxResult.text || "";
          }
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          console.log(
            `[ai-extract] mime=${file.mimeType} pages=${pages ?? "n/a"} extracted_chars=0 duration_ms=${durationMs}`,
          );
          return res.status(200).json({
            ok: false,
            message: "text extraction failed",
            warnings: [err?.message || String(err)],
            source: { mime: file.mimeType, ...(pages ? { pages } : {}) },
          });
        }

        extractedText = extractedText.trim();
        if (!extractedText) {
          const durationMs = Date.now() - startedAt;
          console.log(
            `[ai-extract] mime=${file.mimeType} pages=${pages ?? "n/a"} extracted_chars=0 duration_ms=${durationMs}`,
          );
          return res.status(200).json({
            ok: false,
            message: "no text extracted",
            warnings: ["no text extracted"],
            source: { mime: file.mimeType, ...(pages ? { pages } : {}) },
          });
        }

        if (extractedText.length > MAX_EXTRACTED_TEXT_CHARS) {
          extractedText = extractedText.slice(0, MAX_EXTRACTED_TEXT_CHARS);
          warnings.push(`Text truncated to ${MAX_EXTRACTED_TEXT_CHARS} characters.`);
        }

        const docSchema = {
          type: "object",
          additionalProperties: false,
          required: ["ok", "source", "proposals", "warnings"],
          properties: {
            ok: { type: "boolean" },
            source: {
              type: "object",
              additionalProperties: false,
              required: ["mime"],
              properties: {
                mime: { type: "string" },
                pages: { type: ["integer", "null"] },
              },
            },
            proposals: {
              type: "object",
              additionalProperties: false,
              required: ["events", "tasks"],
              properties: {
                events: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["title", "confidence", "evidence"],
                    properties: {
                      title: { type: "string" },
                      date: { type: ["string", "null"], description: "YYYY-MM-DD or null" },
                      start: { type: ["string", "null"], description: "HH:MM 24h or null" },
                      end: { type: ["string", "null"], description: "HH:MM 24h or null" },
                      durationMin: { type: ["number", "null"] },
                      description: { type: ["string", "null"] },
                      location: { type: ["string", "null"] },
                      confidence: { type: "number", minimum: 0, maximum: 1 },
                      evidence: { type: "array", items: { type: "string" } },
                    },
                  },
                },
                tasks: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["title", "confidence", "evidence"],
                    properties: {
                      title: { type: "string" },
                      dueDate: { type: ["string", "null"], description: "YYYY-MM-DD or null" },
                      description: { type: ["string", "null"] },
                      location: { type: ["string", "null"] },
                      confidence: { type: "number", minimum: 0, maximum: 1 },
                      evidence: { type: "array", items: { type: "string" } },
                    },
                  },
                },
              },
            },
            warnings: { type: "array", items: { type: "string" } },
            usage: {
              type: "object",
              additionalProperties: false,
              required: ["input_tokens", "output_tokens"],
              properties: {
                input_tokens: { type: "number" },
                output_tokens: { type: "number" },
              },
            },
          },
        };

        const schema = docSchema;
        console.log(
          "[ai-extract] doc schema keys=",
          Object.keys(schema),
          "source.required=",
          schema?.properties?.source?.required,
        );

        const payload = {
          model: AI_EXTRACT_MODEL,
          input: [
            { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
            {
              role: "user",
              content: [
                { type: "input_text", text: userPrompt },
                { type: "input_text", text: `Document text:\n${extractedText}` },
              ],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "calendar_extract_doc",
              strict: true,
              schema,
            },
          },
          max_output_tokens: 900,
        };

        let resp;
        let body;
        let rawBody = "";
        try {
          resp = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          });
          rawBody = await resp.text();
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          console.log(
            `[ai-extract] mime=${file.mimeType} pages=${pages ?? "n/a"} extracted_chars=${extractedText.length} duration_ms=${durationMs}`,
          );
          logOpenAiError({
            status: null,
            requestId: null,
            errorType: "request_failed",
            errorCode: null,
            errorMessage: err?.message || String(err),
            bodySnippet: null,
          });
          return res.status(502).json({ ok: false, message: "OpenAI upstream error", warnings });
        }

        if (!resp.ok) {
          const durationMs = Date.now() - startedAt;
          const parsedError = safeJsonParse(rawBody || "");
          const errorPayload = parsedError?.error || {};
          const requestId = getOpenAiRequestId(resp.headers);
          const bodySnippet = toSnippet(rawBody);
          console.log(
            `[ai-extract] mime=${file.mimeType} pages=${pages ?? "n/a"} extracted_chars=${extractedText.length} duration_ms=${durationMs}`,
          );
          logOpenAiError({
            status: resp.status,
            requestId,
            errorType: errorPayload?.type || null,
            errorCode: errorPayload?.code || null,
            errorMessage: errorPayload?.message || parsedError?.message || null,
            bodySnippet,
          });

          let status = 502;
          let message = "OpenAI upstream error";
          let warningTag = null;
          if (resp.status === 401 || resp.status === 403) {
            status = 500;
            message = "OpenAI auth/config error";
            warningTag = "openai_auth";
          } else if (resp.status === 429) {
            status = 503;
            message = "OpenAI rate limited";
            warningTag = "openai_429";
          }
          const nextWarnings = warningTag ? [...warnings, warningTag] : [...warnings];
          return res.status(status).json({ ok: false, message, warnings: nextWarnings });
        }

        body = safeJsonParse(rawBody || "");

        const outputText =
          body?.output_text ||
          body?.output?.[0]?.content?.find((c) => c.type === "output_text")?.text ||
          body?.output?.[0]?.content?.[0]?.text ||
          "";

        const aiParsed = parseDocExtractJson(outputText || "");
        const durationMs = Date.now() - startedAt;
        console.log(
          `[ai-extract] mime=${file.mimeType} pages=${pages ?? "n/a"} extracted_chars=${extractedText.length} duration_ms=${durationMs}`,
        );
        if (!aiParsed) {
          return res.status(502).json({
            ok: false,
            message: "invalid ai output",
            warnings: warnings.length ? warnings : ["invalid ai output"],
            source: { mime: file.mimeType, ...(pages ? { pages } : {}) },
          });
        }

        const mergedWarnings = [...warnings, ...(aiParsed.warnings || [])];
        const usage = body?.usage
          ? { input_tokens: body.usage.input_tokens, output_tokens: body.usage.output_tokens }
          : undefined;

        return res.json({
          ok: aiParsed.ok,
          source: { mime: file.mimeType, ...(pages ? { pages } : {}) },
          proposals: aiParsed.proposals,
          warnings: mergedWarnings,
          ...(usage ? { usage } : {}),
        });
      }

      const schema = {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "type",
                "title",
                "date",
                "start",
                "end",
                "durationMin",
                "description",
                "location",
                "confidence",
                "sourceSnippet",
              ],
              properties: {
                type: { type: "string", enum: ["event", "task"] },
                title: { type: "string" },
                date: { type: "string", description: "YYYY-MM-DD" },
                start: { type: ["string", "null"], description: "HH:MM 24h or null" },
                end: { type: ["string", "null"], description: "HH:MM 24h or null" },
                durationMin: { type: ["number", "null"] },
                description: { type: "string" },
                location: { type: "string" },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                sourceSnippet: { type: "string" },
              },
            },
          },
        },
      };

      const base64File = file.buffer.toString("base64");
      const payload = {
        model: AI_EXTRACT_MODEL,
        input: [
          { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
          {
            role: "user",
            content: [
              { type: "input_text", text: userPrompt },
              {
                type: "input_image",
                image_url: `data:${file.mimeType};base64,${base64File}`,
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "calendar_extract",
            strict: true,
            schema,
          },
        },
        max_output_tokens: 800,
      };

      let resp;
      let body;
      try {
        resp = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        body = await resp.json();
      } catch {
        return res.status(500).json({ ok: false, message: "OpenAI request failed" });
      }

      if (!resp.ok) {
        return res.status(500).json({ ok: false, message: "OpenAI request failed" });
      }

      const outputText =
        body?.output_text ||
        body?.output?.[0]?.content?.find((c) => c.type === "output_text")?.text ||
        body?.output?.[0]?.content?.[0]?.text ||
        "";

      const aiParsed = parseAIJson(outputText || "");
      if (!aiParsed) {
        return res.status(502).json({ ok: false, error: "invalid_ai_output" });
      }

      const normalizedItems = normalizeExtractItems(aiParsed.items);
      return res.json({ ok: true, items: normalizedItems });
    } catch {
      return res.status(500).json({ ok: false, message: "ai extract failed" });
    }
  },
);

app.use((err, req, res, next) => {
  if (req.path === "/api/ai/extract" && err?.type === "entity.too.large") {
    return res.status(413).json({ ok: false, message: "file too large" });
  }
  return next(err);
});

app.post("/api/assistant/commit", requireApiKey, async (req, res) => {
  try {
    const { proposal, provider = "local" } = req.body || {};
    const normalized = normalizeAssistantProposal(proposal);

    if (normalized.intent !== "create_event") {
      return res.status(400).json({ ok: false, message: "proposal intent must be create_event" });
    }
    if (!hasRequiredAssistantFields(normalized)) {
      return res.status(400).json({ ok: false, message: "proposal missing required fields" });
    }

    const event = normalized.event;
    const dateISO = event.dateISO;
    const startTime = event.startTime || "00:00";
    const durationMin = Number.isFinite(event.durationMin) ? Number(event.durationMin) : null;
    const endTime = event.endTime || null;

    const startDate = buildLocalDateTime(dateISO, startTime);
    if (!startDate) {
      return res.status(400).json({ ok: false, message: "invalid dateISO/startTime" });
    }

    let endDate = null;
    if (event.allDay) {
      endDate = addDays(new Date(startDate), 1);
    } else if (endTime) {
      endDate = buildLocalDateTime(dateISO, endTime);
      if (!endDate) {
        return res.status(400).json({ ok: false, message: "invalid endTime" });
      }
      if (endDate <= startDate) {
        endDate = addDays(endDate, 1);
      }
    } else if (durationMin) {
      endDate = addMinutes(new Date(startDate), durationMin);
    }

    if (!endDate) {
      return res.status(400).json({ ok: false, message: "missing endTime or durationMin" });
    }

    const start = toLocalIsoWithOffset(startDate);
    const end = toLocalIsoWithOffset(endDate);
    const title = String(event.title || "Termin");
    const location = String(event.location || "");
    const notes = String(event.description || "");

    if (provider === "google") {
      await assertCorrectGoogleAccount();
      const created = await createAndMirrorEvent({ title, start, end, location, notes });
      if (!created.ok) return res.status(created.status || 400).json(created.payload || { ok: false });
      return res.json({ ok: true, createdEvent: created.normalizedEvent, source: "google" });
    }

    const db = readDb();
    const localEvent = {
      id: uid("evt"),
      title,
      start,
      end,
      location,
      notes,
      color: "",
    };
    db.events.push(localEvent);
    writeDb(db);
    return res.json({ ok: true, createdEvent: localEvent, source: "local" });
  } catch (e) {
    const msg = String(e?.message || "");
    const isNotConnected =
      msg.includes("Nicht verbunden") ||
      msg.includes("keine Tokens") ||
      msg.includes("Google nicht verbunden") ||
      msg.includes("Access Token") ||
      msg.includes("Tokens");

    if (isNotConnected) {
      return res.status(401).json({
        ok: false,
        error: "GOOGLE_NOT_CONNECTED",
        message: "Google nicht verbunden",
      });
    }

    res.status(500).json({ ok: false, message: "assistant commit failed", details: msg || "unknown" });
  }
});
// ---- Quick Add (ROBUST): Text parsen -> events.insert (createGoogleEvent) ----
app.post("/api/google/quick-add", async (req, res) => {
  try {
    await assertCorrectGoogleAccount();

    const { text = "" } = req.body || {};
    const raw = String(text || "").trim();
    if (!raw) return res.status(400).json({ ok: false, message: "text fehlt" });

    const cfg = getGoogleConfig();
    const parsed = parseQuickAddText(raw, cfg?.GOOGLE_TIMEZONE || "Europe/Zurich");
    if (!parsed.ok) return res.status(400).json(parsed);

    const out = await createGoogleEvent({
      title: parsed.title,
      start: parsed.start,
      end: parsed.end,
      location: parsed.location || "",
      notes: parsed.notes || "",
    });

    if (!out.ok) return res.status(400).json(out);

    const ge = out.googleEvent || null;

    if (ge) {
      const googleId = ge.id ? String(ge.id) : uid("gcal");
      const db = readDb();

      const startStr = ge.start?.dateTime || ge.start?.date || parsed.start;
      const endStr = ge.end?.dateTime || ge.end?.date || parsed.end;

      const ev = {
        id: `gcal_${googleId}`,
        title: String(ge.summary || parsed.title || "Termin"),
        start: startStr ? String(startStr) : "",
        end: endStr ? String(endStr) : "",
        location: String(ge.location || parsed.location || ""),
        notes: String(ge.description || parsed.notes || ""),
        color: "",
        googleEventId: googleId,
      };

      db.events.push(ev);
      writeDb(db);

      return res.json({ ok: true, googleEvent: ge, mirroredEvent: ev, parsed });
    }

    return res.json({ ok: true, googleEvent: null, parsed });
  } catch (e) {
	    const msg = String(e?.message || "");
	    const details = e?.response?.data || e?.errors || e?.stack || msg || String(e);

	    // ✅ UX-Fix (Phase 4): Wenn Google nicht verbunden ist (keine Tokens), soll Quick-Add
	    // nicht mit 500 crashen, sondern sauber 401 zurückgeben.
	    const isNotConnected =
	      msg.includes("Nicht verbunden") ||
	      msg.includes("keine Tokens") ||
	      msg.includes("Google nicht verbunden") ||
	      msg.includes("auth-url") ||
	      msg.includes("Tokens");

	    if (isNotConnected) {
	      return res.status(401).json({
	        ok: false,
	        code: "GOOGLE_NOT_CONNECTED",
	        message: "Google nicht verbunden. Öffne /api/google/auth-url (oder /api/google/auth) und verbinde.",
	        details: msg,
	      });
	    }

	    res.status(500).json({ ok: false, message: "quick-add failed", details });
  }
});

// ---- Events (local db.json) ----
app.get("/api/events", (req, res) => {
  const db = readDb();
  res.json({ ok: true, events: db.events });
});

app.post("/api/events", requireApiKey, (req, res) => {
  const { title, start, end, location = "", notes = "", color = "" } = req.body || {};
  if (!title || !start || !end) {
    return res.status(400).json({ ok: false, message: "title/start/end required" });
  }

  const db = readDb();
  const ev = {
    id: uid("evt"),
    title: String(title),
    start: String(start),
    end: String(end),
    location: String(location || ""),
    notes: String(notes || ""),
    color: String(color || ""),
  };
  db.events.push(ev);
  writeDb(db);
  res.json({ ok: true, event: ev });
});

// ---- Tasks (local db.json) ----
app.get("/api/tasks", (req, res) => {
  const db = readDb();
  res.json({ ok: true, tasks: db.tasks });
});

app.post("/api/tasks", requireApiKey, (req, res) => {
  const {
    title,
    durationMinutes,
    deadline = null,
    importance = false,
    urgency = false,
    status = "open",
    scheduledStart = null,
    scheduledEnd = null,
  } = req.body || {};

  if (!title || !durationMinutes) {
    return res.status(400).json({ ok: false, message: "title/durationMinutes required" });
  }

  const db = readDb();
  const task = {
    id: uid("tsk"),
    title: String(title),
    durationMinutes: Number(durationMinutes),
    deadline: deadline ? String(deadline) : null,
    importance: !!importance,
    urgency: !!urgency,
    status: String(status || "open"),
    scheduledStart: scheduledStart ? String(scheduledStart) : null,
    scheduledEnd: scheduledEnd ? String(scheduledEnd) : null,
    createdAt: Date.now(),
  };
  db.tasks.push(task);
  writeDb(db);
  res.json({ ok: true, task });
});

// ---- Fallback: SPA / Root (damit "Cannot GET /" nicht passiert) ----
app.get("/", (req, res) => {
  if (!WEB_DIR) return res.status(404).send("Web UI not configured");
  res.sendFile(path.join(WEB_DIR, "index.html"));
});

app.get("/*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ ok: false, message: "Not found" });
  if (!WEB_DIR) return res.status(404).send("Web UI not configured");
  res.sendFile(path.join(WEB_DIR, "index.html"));
});

/**
 * ✅ WICHTIG: auf 0.0.0.0 binden, damit Android Emulator (10.0.2.2) / Handy zugreifen kann
 */
// ======================
// DELETE Google Event
// ======================
app.patch("/api/google/events/:id", requireApiKey, async (req, res) => {
  const rawId = String(req.params.id || "").trim();
  const eventId = rawId.startsWith("gcal_") ? rawId.slice(5) : rawId;

  if (!eventId) {
    return res.status(400).json({ ok: false, message: "Missing event id" });
  }

  try {
    await assertCorrectGoogleAccount();

    const { title, start, end, location = "", notes = "" } = req.body || {};
    if (!title || !start || !end) {
      return res.status(400).json({ ok: false, message: "title/start/end required" });
    }

    const auth = await buildAuthedOAuthClient();

    const calendar = google.calendar({ version: "v3", auth });
    const requestBody = {
      summary: String(title),
      location: String(location || ""),
      description: String(notes || ""),
      start: {
        dateTime: String(start),
        timeZone: "Europe/Zurich",
      },
      end: {
        dateTime: String(end),
        timeZone: "Europe/Zurich",
      },
    };

    await calendar.events.patch({
      calendarId: "primary",
      eventId: String(eventId),
      requestBody,
    });

    logDebug(`google patch ok: ${eventId}`);

    try {
      const db = readDb();
      let changed = false;
      db.events = db.events.map((ev) => {
        if (ev.id === rawId || ev.googleEventId === eventId) {
          changed = true;
          return {
            ...ev,
            title: String(title),
            start: String(start),
            end: String(end),
            location: String(location || ""),
            notes: String(notes || ""),
          };
        }
        return ev;
      });
      if (changed) writeDb(db);
    } catch (e) {
      console.warn(`db.json update failed: ${e?.message || String(e)}`);
    }

    return res.json({ ok: true, updatedId: eventId });
  } catch (e) {
    const msg = String(e?.message || "");
    const status = e?.code || e?.response?.status;

    if (status === 404 || status === 410) {
      logDebug(`google patch not found: ${eventId} (${status})`);
      return res.status(404).json({ ok: false, message: "Event nicht gefunden/gelöscht" });
    }

    const isNotConnected =
      msg.includes("Nicht verbunden") ||
      msg.includes("keine Tokens") ||
      msg.includes("Google nicht verbunden") ||
      msg.includes("Access Token") ||
      msg.includes("Tokens");

    if (isNotConnected) {
      logDebug(`google patch blocked: ${eventId} (not connected)`);
      return res.status(401).json({ ok: false, error: "GOOGLE_NOT_CONNECTED", message: "Google nicht verbunden" });
    }

    logDebug(`google patch failed: ${eventId}`);
    return res.status(500).json({ ok: false, message: "update failed", details: msg });
  }
});

app.delete("/api/google/events/:id", requireApiKey, async (req, res) => {
  const rawId = String(req.params.id || "").trim();
  const eventId = rawId.startsWith("gcal_") ? rawId.slice(5) : rawId;

  if (!eventId) {
    return res.status(400).json({ ok: false, message: "Missing event id" });
  }

  try {
    await deleteGoogleEvent({ eventId });
    logDebug(`google delete ok: ${eventId}`);

    // Lokale Spiegelung (db.json) bereinigen
    try {
      const db = readDb();
      const before = db.events.length;
      db.events = db.events.filter((e) => e.id !== rawId && e.googleEventId !== eventId);
      if (db.events.length !== before) writeDb(db);
    } catch (e) {
      console.warn(`db.json cleanup failed: ${e?.message || String(e)}`);
    }

    return res.json({ ok: true, deletedId: eventId, eventId });
  } catch (e) {
    const msg = String(e?.message || "");
    const status = e?.code || e?.response?.status;

    if (status === 404 || status === 410) {
      logDebug(`google delete already gone: ${eventId} (${status})`);
      return res.json({ ok: true, deletedId: eventId, eventId, alreadyDeleted: true });
    }

    const isNotConnected =
      msg.includes("Nicht verbunden") ||
      msg.includes("keine Tokens") ||
      msg.includes("Google nicht verbunden") ||
      msg.includes("Access Token") ||
      msg.includes("Tokens");

    if (isNotConnected) {
      logDebug(`google delete blocked: ${eventId} (not connected)`);
      return res.status(401).json({
        ok: false,
        error: "GOOGLE_NOT_CONNECTED",
        message: "Google nicht verbunden",
      });
    }

    logDebug(`google delete failed: ${eventId}`);
    return res.status(500).json({ ok: false, message: "delete failed", details: msg });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  const cfg = getGoogleConfig();
  logDebug(`calendar-api running on port ${PORT}`);
  logDebug(`google timezone: ${cfg.GOOGLE_TIMEZONE || "Europe/Zurich"}`);
  if (GOOGLE_ALLOWED_EMAIL) logDebug(`google allowed email: ${GOOGLE_ALLOWED_EMAIL}`);

  // Phase 3 Push-Sync: Watch bei Start erstellen + periodisch erneuern
  (async () => {
    try {
      const out = await ensureGoogleWatch({ reason: "startup" });
      if (out?.ok) {
        logDebug(`google watch ok (${out.reused ? "reused" : "created"})`);
      } else {
        logDebug(`google watch skipped: ${out?.message || "unknown"}`);
      }
    } catch (e) {
      logDebug(`google watch init failed: ${e?.message || String(e)}`);
    }
  })();

  // periodisch pruefen (stundlich) und erneuern, wenn Expiration bald ablaeuft
  const WATCH_RENEW_TIMER = setInterval(async () => {
    try {
      const st = loadWatchState();
      const now = Date.now();
      const exp = st?.expiration ? int(st.expiration) : 0;
      const needsRenew = !st?.channelId || !st?.resourceId || !exp || exp < now + 6 * 60 * 60 * 1000; // <6h
      if (needsRenew) {
        const out = await ensureGoogleWatch({ reason: "renew" });
        if (out?.ok) logDebug(`google watch renewed`);
      }
    } catch {
      // ignore
    }
  }, 60 * 60 * 1000);

  // prevent unhandled rejection warnings in some envs
  WATCH_RENEW_TIMER.unref?.();

});

// -------------------- Google Helpers --------------------

function isRevokedError(err) {
  const message = err?.message || "";
  const code = err?.code;
  return (
    code === 400 ||
    /invalid_grant/i.test(message) ||
    /token has been expired or revoked/i.test(message)
  );
}

async function buildAuthedOAuthClient() {
  const cfg = getGoogleConfig();
  if (!cfg.GOOGLE_CLIENT_ID || !cfg.GOOGLE_CLIENT_SECRET || !cfg.GOOGLE_REDIRECT_URI) {
    throw new Error("Google OAuth nicht konfiguriert (Env Vars fehlen)");
  }

  const tokens = (await loadTokens?.()) || null;
  if (!tokens?.refresh_token) throw new Error("Nicht verbunden (kein Refresh Token gespeichert)");

  const oauth2 = new google.auth.OAuth2(cfg.GOOGLE_CLIENT_ID, cfg.GOOGLE_CLIENT_SECRET, cfg.GOOGLE_REDIRECT_URI);
  oauth2.setCredentials(tokens);

  oauth2.on("tokens", (t) => {
    void (async () => {
      try {
        const current = (await loadTokens?.()) || {};
        await saveTokens({ ...current, ...t });
      } catch {
        // ignore
      }
    })();
  });

  try {
    const tokenResult = await oauth2.getAccessToken();
    if (!tokenResult?.token) {
      throw new Error("OAuth liefert keinen Access Token. Bitte neu verbinden.");
    }
  } catch (err) {
    if (isRevokedError(err)) {
      await clearTokens();
      throw new Error("Google OAuth Token widerrufen/ungueltig. Bitte neu verbinden.");
    }
    throw err;
  }

  // ✅ Wichtig: global setzen, damit andere googleapis-Calls authen
  google.options({ auth: oauth2 });

  return oauth2;
}

/**
 * ✅ FIX (minimal): Kein calendars.get('primary') mehr.
 *
 * Warum:
 * - Dein Scope ist typischerweise nur "calendar.events".
 * - calendars.get braucht jedoch einen breiteren Scope (z.B. "calendar" oder "calendar.readonly").
 * - Das führt zu: ACCESS_TOKEN_SCOPE_INSUFFICIENT.
 *
 * Lösung:
 * - Wenn GOOGLE_ALLOWED_EMAIL gesetzt ist, verwenden wir das als "verbundene" E-Mail (UX/Hinweis).
 * - Sonst geben wir null zurück (unbekannt).
 */
async function getConnectedGoogleEmail() {
  return GOOGLE_ALLOWED_EMAIL || null;
}

async function assertCorrectGoogleAccount() {
  if (!GOOGLE_ALLOWED_EMAIL) return;

  const status = await getGoogleStatus();
  if (!status?.google?.connected) {
    throw new Error(`Google nicht verbunden. Bitte zuerst /api/google/auth-url öffnen und verbinden.`);
  }

  // NOTE: Ohne zusätzlichen Scope können wir die Account-E-Mail nicht zuverlässig über Google prüfen.
  // Wir erzwingen hier daher nur, dass Tokens vorhanden sind (connected:true).
  // Wenn du die E-Mail serverseitig wirklich verifizieren willst, musst du einen zusätzlichen Scope
  // (z.B. "https://www.googleapis.com/auth/calendar.readonly") hinzufügen und neu verbinden.
}

// -------------------- Quick-Add Parser --------------------

function parseQuickAddText(input, tzName = "Europe/Zurich") {
  const original = String(input || "").trim();
  const s = normalizeSpaces(original.toLowerCase());

  // 1) duration: "30min", "60min", "1h", "1.5h"
  let durationMinutes = 60;
  let rest = original;

  const durMatchMin = s.match(/(?:^|\s)(\d{1,4})\s*min(?:\s|$)/i);
  const durMatchH = s.match(/(?:^|\s)(\d+(?:[.,]\d+)?)\s*h(?:\s|$)/i);

  if (durMatchMin) {
    durationMinutes = clampInt(parseInt(durMatchMin[1], 10), 5, 24 * 60);
    rest = removeTokenCaseInsensitive(rest, durMatchMin[0].trim());
  } else if (durMatchH) {
    const rawH = durMatchH[1].replace(",", ".");
    const hours = Number(rawH);
    if (Number.isFinite(hours) && hours > 0) {
      durationMinutes = clampInt(Math.round(hours * 60), 5, 24 * 60);
      rest = removeTokenCaseInsensitive(rest, durMatchH[0].trim());
    }
  }

  // 2) time: "14:00" / "9:15"
  const timeMatch = s.match(/(?:^|\s)(\d{1,2}):(\d{2})(?:\s|$)/);
  if (!timeMatch) {
    return {
      ok: false,
      message: "Parse failed: Uhrzeit fehlt (z.B. 14:00)",
      example: 'Beispiel: "morgen 14:00 testtermin 30min"',
    };
  }
  const hh = clampInt(parseInt(timeMatch[1], 10), 0, 23);
  const mm = clampInt(parseInt(timeMatch[2], 10), 0, 59);
  const timeHHMM = `${pad2(hh)}:${pad2(mm)}`;

  rest = removeTokenCaseInsensitive(rest, timeMatch[0].trim());

  // 3) date: "morgen" | "heute" | "dd.mm.yyyy" | "dd.mm."
  let date = new Date();
  let year = date.getFullYear();
  let month = date.getMonth() + 1;
  let day = date.getDate();

  const s2 = normalizeSpaces(rest.toLowerCase());

  const hasMorgen = /\bmorgen\b/.test(s2);
  const hasHeute = /\bheute\b/.test(s2);

  const dmY = s2.match(/(?:^|\s)(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s|$)/);
  const dm = s2.match(/(?:^|\s)(\d{1,2})\.(\d{1,2})\.(?:\s|$)/);

  if (dmY) {
    day = clampInt(parseInt(dmY[1], 10), 1, 31);
    month = clampInt(parseInt(dmY[2], 10), 1, 12);
    year = clampInt(parseInt(dmY[3], 10), 1970, 3000);
    rest = removeTokenCaseInsensitive(rest, dmY[0].trim());
  } else if (dm) {
    day = clampInt(parseInt(dm[1], 10), 1, 31);
    month = clampInt(parseInt(dm[2], 10), 1, 12);
    year = new Date().getFullYear();
    rest = removeTokenCaseInsensitive(rest, dm[0].trim());
  } else if (hasMorgen) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    year = d.getFullYear();
    month = d.getMonth() + 1;
    day = d.getDate();
    rest = removeTokenCaseInsensitive(rest, "morgen");
  } else if (hasHeute) {
    const d = new Date();
    year = d.getFullYear();
    month = d.getMonth() + 1;
    day = d.getDate();
    rest = removeTokenCaseInsensitive(rest, "heute");
  } else {
    const d = new Date();
    year = d.getFullYear();
    month = d.getMonth() + 1;
    day = d.getDate();
  }

  // 4) title: verbleibender Text
  const title = normalizeSpaces(rest)
    .replace(/^[-–—:]+/, "")
    .trim();

  if (!title) {
    return {
      ok: false,
      message: "Parse failed: Titel fehlt (z.B. 'testtermin')",
      example: 'Beispiel: "morgen 14:00 testtermin 30min"',
    };
  }

  const dateISO = `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
  const start = `${dateISO}T${timeHHMM}:00`;

  const startMinutes = hh * 60 + mm;
  const endTotal = startMinutes + durationMinutes;

  let endYear = year;
  let endMonth = month;
  let endDay = day;

  let endMinutesOfDay = endTotal;
  if (endTotal >= 24 * 60) {
    endMinutesOfDay = endTotal % (24 * 60);
    const tmp = new Date(year, month - 1, day);
    tmp.setDate(tmp.getDate() + Math.floor(endTotal / (24 * 60)));
    endYear = tmp.getFullYear();
    endMonth = tmp.getMonth() + 1;
    endDay = tmp.getDate();
  }

  const endHH = Math.floor(endMinutesOfDay / 60);
  const endMM = endMinutesOfDay % 60;
  const endDateISO = `${pad4(endYear)}-${pad2(endMonth)}-${pad2(endDay)}`;
  const end = `${endDateISO}T${pad2(endHH)}:${pad2(endMM)}:00`;

  return {
    ok: true,
    title,
    start,
    end,
    durationMinutes,
    timezone: tzName,
    raw: original,
  };
}

function normalizeSpaces(str) {
  return String(str || "")
    .replace(/\s+/g, " ")
    .trim();
}

function removeTokenCaseInsensitive(haystack, token) {
  if (!token) return haystack;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\s)${escaped}($|\\s)`, "i");
  return normalizeSpaces(String(haystack || "").replace(re, " "));
}

function clampInt(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function pad4(n) {
  return String(n).padStart(4, "0");
}

// -------------------- Utils --------------------

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
