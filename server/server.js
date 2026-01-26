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

import {
  getGoogleStatus,
  getAuthUrl,
  exchangeCodeForTokens,
  createGoogleEvent,
  listGoogleEvents, // ✅ Phase 2 Sync (Read)
  deleteGoogleEvent,
  getGoogleConfig,
  loadTokens,
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

// ---- Paths ----
const DB_PATH = path.join(__dirname, "db.json");
const TOKENS_PATH = path.join(__dirname, "google-tokens.json"); // fuer Disconnect


// ---- Phase 3 Push-Sync (Google Watch API) ----
const WATCH_PATH = path.join(__dirname, "google-watch.json");

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

  const tokens = loadTokens?.() || null;
  if (!tokens) {
    return { ok: false, message: "Google nicht verbunden (keine Tokens)" };
  }

  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) {
    return { ok: false, message: "Webhook URL fehlt (setze GOOGLE_WATCH_WEBHOOK_URL oder PUBLIC_BASE_URL)" };
  }
  if (!isHttpsUrl(webhookUrl)) {
    return { ok: false, message: "Webhook URL muss https sein" };
  }

  const oauth2 = buildAuthedOAuthClient();
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

// ---- Config ----
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";

// Setze z.B. GOOGLE_ALLOWED_EMAIL=noahsp@gmx.ch
const GOOGLE_ALLOWED_EMAIL = (process.env.GOOGLE_ALLOWED_EMAIL || "").trim().toLowerCase();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

// ---- Mini-DB (JSON Datei) ----
function ensureDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ events: [], tasks: [] }, null, 2), "utf-8");
  }
}
function readDb() {
  ensureDb();
  try {
    const raw = fs.readFileSync(DB_PATH, "utf-8");
    const parsed = JSON.parse(raw || "{}");
    if (!Array.isArray(parsed.events)) parsed.events = [];
    if (!Array.isArray(parsed.tasks)) parsed.tasks = [];
    return parsed;
  } catch {
    const safe = { events: [], tasks: [] };
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

// ---- Google OAuth + Status ----
app.get("/api/google/status", async (req, res) => {
  try {
    const base = getGoogleStatus();
    const tokens = loadTokens?.() || null;
    const hasTokens = !!tokens;
    const connected = !!base?.google?.connected;
    const watchState = loadWatchState();
    const now = Date.now();
    let watchActive = false;
    let watchReason = "";

    if (!connected) {
      watchReason = "Google nicht verbunden";
    } else if (!hasTokens) {
      watchReason = "Keine Tokens";
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

    if (base?.google?.connected) {
      try {
        connectedEmail = await getConnectedGoogleEmail();
        if (GOOGLE_ALLOWED_EMAIL && connectedEmail && connectedEmail !== GOOGLE_ALLOWED_EMAIL) {
          wrongAccount = true;
        }
      } catch {
        // ignore
      }
    }

    res.json({
      ...base,
      google: {
        ...base.google,
        connected,
        hasTokens,
        watchActive,
        reason: watchActive ? "" : watchReason,
        connectedEmail,
        allowedEmail: GOOGLE_ALLOWED_EMAIL || null,
        wrongAccount,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: "status failed", details: e?.message || String(e) });
  }
});

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

app.get("/api/google/auth-url", (req, res) => {
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

  res.json(getAuthUrl({ redirectUri, state, clientId }));
});

// Disconnect (löscht Tokens)
app.post("/api/google/disconnect", requireApiKey, (req, res) => {
  try {
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

// ---- Create event in Google Calendar (insert) + Spiegelung in db.json ----
app.post("/api/google/events", requireApiKey, async (req, res) => {
  try {
    await assertCorrectGoogleAccount();

    const { title, start, end, location = "", notes = "" } = req.body || {};
    const out = await createGoogleEvent({ title, start, end, location, notes });
    if (!out.ok) return res.status(400).json(out);

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

    res.json({ ok: true, event: normalizedEvent, googleEvent: out.googleEvent, mirroredEvent: ev });
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
});

// ---- Phase 2 Sync (READ): Google Events list ----
// ❗ bewusst ohne requireApiKey, damit die App im LAN/Emulator ohne Key lesen kann
// Query: ?daysPast=365&daysFuture=365
app.get("/api/google/events", async (req, res) => {
  try {
    await assertCorrectGoogleAccount();

    const daysPast = Number(req.query.daysPast || 365);
    const daysFuture = Number(req.query.daysFuture || 365);

    const now = new Date();
    const timeMin = new Date(now.getTime() - daysPast * 24 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(now.getTime() + daysFuture * 24 * 60 * 60 * 1000).toISOString();

    const out = await listGoogleEvents({ timeMin, timeMax });

    if (!out?.ok) return res.status(400).json(out || { ok: false, message: "list failed" });
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message || "unknown" });
  }
});



// ---- Phase 3 Push-Sync: Status + Ack (App fragt alle 30s) ----
// bewusst ohne requireApiKey, damit Emulator/Handy einfach lesen kann
app.get("/api/sync/status", async (req, res) => {
  try {
    const st = loadWatchState();
    const cfg = getGoogleConfig();
    const connected = !!(loadTokens?.() || null);
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

    const auth = buildAuthedOAuthClient();
    const tokenResult = await auth.getAccessToken();
    if (!tokenResult?.token) {
      throw new Error("OAuth liefert keinen Access Token. Bitte neu verbinden.");
    }

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

function buildAuthedOAuthClient() {
  const cfg = getGoogleConfig();
  if (!cfg.GOOGLE_CLIENT_ID || !cfg.GOOGLE_CLIENT_SECRET || !cfg.GOOGLE_REDIRECT_URI) {
    throw new Error("Google OAuth nicht konfiguriert (Env Vars fehlen)");
  }

  const tokens = loadTokens?.() || null;
  if (!tokens) throw new Error("Nicht verbunden (keine Tokens gespeichert)");

  const oauth2 = new google.auth.OAuth2(cfg.GOOGLE_CLIENT_ID, cfg.GOOGLE_CLIENT_SECRET, cfg.GOOGLE_REDIRECT_URI);
  oauth2.setCredentials(tokens);

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

  const status = getGoogleStatus();
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

function pad2(n) {
  return String(n).padStart(2, "0");
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
