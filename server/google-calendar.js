// server/google-calendar.js
// Google Calendar OAuth + Create Event
// Tokens werden lokal in server/google-tokens.json gespeichert.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKENS_PATH = path.join(__dirname, "google-tokens.json");

// --- Token Storage (Free Render Setup) ---
// Render Persistent Disks are paid. For the MVP we support storing the full
// token JSON in an ENV var: GOOGLE_TOKENS_JSON.
//
// Priority:
// 1) process.env.GOOGLE_TOKENS_JSON (if set)
// 2) server/google-tokens.json (local dev)
//
// Note: ENV vars cannot be modified at runtime, so when GOOGLE_TOKENS_JSON is
// set we treat tokens as read-only (no save on refresh). This is OK because the
// refresh_token stays stable and is enough to rehydrate auth after restarts.

export function getGoogleConfig() {
  const {
    GOOGLE_CLIENT_ID = "",
    GOOGLE_CLIENT_SECRET = "",
    GOOGLE_REDIRECT_URI = "",
    GOOGLE_SCOPES = "https://www.googleapis.com/auth/calendar.events",
    GOOGLE_CALENDAR_ID = "primary",
    GOOGLE_TIMEZONE = "Europe/Zurich",
  } = process.env;

  return {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
    GOOGLE_SCOPES,
    GOOGLE_CALENDAR_ID,
    GOOGLE_TIMEZONE,
  };
}

export function isGoogleConfigured() {
  const cfg = getGoogleConfig();
  return !!(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET && cfg.GOOGLE_REDIRECT_URI);
}

function buildOAuthClient() {
  const cfg = getGoogleConfig();
  return new google.auth.OAuth2(
    cfg.GOOGLE_CLIENT_ID,
    cfg.GOOGLE_CLIENT_SECRET,
    cfg.GOOGLE_REDIRECT_URI
  );
}

export function loadTokens() {
  try {
    // 1) ENV (Render free)
    const envJson = (process.env.GOOGLE_TOKENS_JSON || "").trim();
    if (envJson) {
      return JSON.parse(envJson);
    }

    // 2) File (local dev)
    if (!fs.existsSync(TOKENS_PATH)) return null;
    return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function saveTokens(tokens) {
  // If tokens are stored in ENV, we can't persist updates at runtime.
  // (ENV is read-only.) Keep it as a no-op in that mode.
  const envJson = (process.env.GOOGLE_TOKENS_JSON || "").trim();
  if (envJson) return;

  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), "utf-8");
}

export function isConnected() {
  const t = loadTokens();
  return !!(t && (t.access_token || t.refresh_token));
}

export function getGoogleStatus() {
  const cfg = getGoogleConfig();
  return {
    ok: true,
    google: {
      configured: isGoogleConfigured(),
      connected: isConnected(),
      scopes: cfg.GOOGLE_SCOPES,
      calendarId: cfg.GOOGLE_CALENDAR_ID,
      timezone: cfg.GOOGLE_TIMEZONE,
    },
  };
}

export function getAuthUrl() {
  if (!isGoogleConfigured()) {
    return { ok: false, message: "Google OAuth nicht konfiguriert" };
  }

  const cfg = getGoogleConfig();
  const oauth2 = buildOAuthClient();

  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: cfg.GOOGLE_SCOPES.split(" ").filter(Boolean),
  });

  return { ok: true, url };
}

export async function exchangeCodeForTokens(code) {
  if (!isGoogleConfigured()) {
    return { ok: false, message: "Google OAuth nicht konfiguriert" };
  }
  if (!code) return { ok: false, message: "code fehlt" };

  const oauth2 = buildOAuthClient();
  const { tokens } = await oauth2.getToken(code);
  saveTokens(tokens);

  return { ok: true };
}

function getAuthedClient() {
  if (!isGoogleConfigured()) {
    throw new Error("Google OAuth nicht konfiguriert");
  }

  const tokens = loadTokens();
  if (!tokens) {
    throw new Error("Nicht verbunden (keine Tokens)");
  }

  const oauth2 = buildOAuthClient();
  oauth2.setCredentials(tokens);

  oauth2.on("tokens", (t) => {
    try {
      const current = loadTokens() || {};
      saveTokens({ ...current, ...t });
    } catch {}
  });

  return oauth2;
}

export async function createGoogleEvent({ title, start, end, location = "", notes = "" }) {
  if (!title || !start || !end) {
    return { ok: false, message: "title/start/end required" };
  }

  const cfg = getGoogleConfig();
  const auth = getAuthedClient();

  const tokenResult = await auth.getAccessToken();
  if (!tokenResult?.token) {
    throw new Error("OAuth liefert keinen Access Token. Bitte neu verbinden.");
  }

  const calendar = google.calendar({
    version: "v3",
    auth,
  });

  const resource = {
    summary: String(title),
    location: String(location || ""),
    description: String(notes || ""),
    start: {
      dateTime: String(start),
      timeZone: cfg.GOOGLE_TIMEZONE || "Europe/Zurich",
    },
    end: {
      dateTime: String(end),
      timeZone: cfg.GOOGLE_TIMEZONE || "Europe/Zurich",
    },
  };

  const res = await calendar.events.insert({
    calendarId: cfg.GOOGLE_CALENDAR_ID || "primary",
    requestBody: resource,
  });

  return { ok: true, googleEvent: res.data };
}

export async function listGoogleEvents({ timeMin, timeMax, maxTotal = 2500 } = {}) {
  const cfg = getGoogleConfig();
  const auth = getAuthedClient();

  const tokenResult = await auth.getAccessToken();
  if (!tokenResult?.token) {
    throw new Error("OAuth liefert keinen Access Token. Bitte neu verbinden.");
  }

  const calendar = google.calendar({ version: "v3", auth });

  const out = [];
  let pageToken = undefined;

  while (true) {
    const res = await calendar.events.list({
      calendarId: cfg.GOOGLE_CALENDAR_ID || "primary",
      timeMin: timeMin ? String(timeMin) : undefined,
      timeMax: timeMax ? String(timeMax) : undefined,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 2500,
      pageToken,
      showDeleted: false,
    });

    const items = Array.isArray(res?.data?.items) ? res.data.items : [];
    for (const it of items) {
      if (it?.status === "cancelled") continue;
      out.push({
        id: `gcal_${it.id}`,
        title: it.summary || "Termin",
        start: it.start?.dateTime || "",
        end: it.end?.dateTime || "",
        location: it.location || "",
        notes: it.description || "",
        googleEventId: it.id,
      });
      if (out.length >= maxTotal) {
        return { ok: true, events: out, truncated: true };
      }
    }

    pageToken = res?.data?.nextPageToken;
    if (!pageToken) break;
  }

  return { ok: true, events: out, truncated: false };
}
