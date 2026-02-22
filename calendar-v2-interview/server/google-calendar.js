import { google } from "googleapis";
import { clearTokens, loadTokens, saveTokens, getTokenStorageInfo } from "./token-store.js";

export { clearTokens, loadTokens, saveTokens, getTokenStorageInfo };

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

function hasGoogleConfig({ clientId, redirectUri } = {}) {
  const cfg = getGoogleConfig();
  return !!(clientId || cfg.GOOGLE_CLIENT_ID) && !!cfg.GOOGLE_CLIENT_SECRET && !!(redirectUri || cfg.GOOGLE_REDIRECT_URI);
}

function buildOAuthClient({ clientId, redirectUri } = {}) {
  const cfg = getGoogleConfig();
  return new google.auth.OAuth2(
    clientId || cfg.GOOGLE_CLIENT_ID,
    cfg.GOOGLE_CLIENT_SECRET,
    redirectUri || cfg.GOOGLE_REDIRECT_URI
  );
}

export async function getGoogleStatus() {
  const cfg = getGoogleConfig();
  const tokens = await loadTokens();
  const authenticated = !!tokens?.refresh_token;
  return {
    ok: true,
    google: {
      configured: hasGoogleConfig(),
      connected: authenticated,
      authenticated,
      expiry_date: tokens?.expiry_date || null,
      scopes: cfg.GOOGLE_SCOPES,
      calendarId: cfg.GOOGLE_CALENDAR_ID,
      timezone: cfg.GOOGLE_TIMEZONE,
    },
  };
}

export async function getAuthUrl({ redirectUri, state, clientId } = {}) {
  if (!hasGoogleConfig({ clientId, redirectUri })) {
    return { ok: false, message: "Google OAuth not configured" };
  }

  const cfg = getGoogleConfig();
  const oauth2 = buildOAuthClient({ clientId, redirectUri });
  const tokens = await loadTokens();
  const needsConsent = !tokens?.refresh_token;

  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    ...(needsConsent ? { prompt: "consent" } : {}),
    scope: cfg.GOOGLE_SCOPES.split(" ").filter(Boolean),
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    ...(state ? { state } : {}),
  });

  return { ok: true, url };
}

export async function exchangeCodeForTokens(code, redirectUri, clientId) {
  if (!hasGoogleConfig({ clientId, redirectUri })) {
    return { ok: false, message: "Google OAuth not configured" };
  }
  if (!code) return { ok: false, message: "code missing" };

  const oauth2 = buildOAuthClient({ clientId, redirectUri });
  const { tokens } = await oauth2.getToken(code);
  await saveTokens(tokens);

  return { ok: true };
}

function isRevokedError(err) {
  const message = err?.message || "";
  const code = err?.code;
  return code === 400 || /invalid_grant/i.test(message) || /token has been expired or revoked/i.test(message);
}

async function ensureFreshTokens(oauth2, tokens) {
  const expiry = tokens?.expiry_date ? Number(tokens.expiry_date) : null;
  const now = Date.now();
  const needsRefresh = !tokens?.access_token || !expiry || expiry <= now;
  if (!needsRefresh) return;

  const tokenResult = await oauth2.getAccessToken();
  const updated = oauth2.credentials || {};
  const merged = { ...tokens, ...updated };

  if (!tokenResult?.token && !merged?.access_token) {
    throw new Error("OAuth did not return access token");
  }

  await saveTokens(merged);
}

export async function getAuthedClient() {
  if (!hasGoogleConfig()) throw new Error("Google OAuth not configured");

  const tokens = await loadTokens();
  if (!tokens?.refresh_token) throw new Error("Not connected");

  const oauth2 = buildOAuthClient();
  oauth2.setCredentials(tokens);

  oauth2.on("tokens", (t) => {
    void (async () => {
      try {
        const current = (await loadTokens()) || {};
        await saveTokens({ ...current, ...t });
      } catch {
        // ignore
      }
    })();
  });

  await ensureFreshTokens(oauth2, tokens);

  try {
    const tokenResult = await oauth2.getAccessToken();
    if (!tokenResult?.token) throw new Error("No access token");
  } catch (err) {
    if (isRevokedError(err)) {
      await clearTokens();
      throw new Error("Google token invalid/revoked. Reconnect required.");
    }
    throw err;
  }

  return oauth2;
}

export async function getConnectedGoogleEmail() {
  const auth = await getAuthedClient();
  const oauth2Api = google.oauth2({ auth, version: "v2" });
  const me = await oauth2Api.userinfo.get();
  return String(me?.data?.email || "").toLowerCase() || null;
}

export async function listGoogleEvents({ timeMin, timeMax, maxTotal = 2500 } = {}) {
  const cfg = getGoogleConfig();
  const auth = await getAuthedClient();
  const calendar = google.calendar({ version: "v3", auth });

  const out = [];
  let pageToken;

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
        title: it.summary || "Event",
        start: it.start?.dateTime || it.start?.date || "",
        end: it.end?.dateTime || it.end?.date || "",
        location: it.location || "",
        notes: it.description || "",
        googleEventId: it.id,
      });
      if (out.length >= maxTotal) return { ok: true, events: out, truncated: true };
    }

    pageToken = res?.data?.nextPageToken;
    if (!pageToken) break;
  }

  return { ok: true, events: out, truncated: false };
}

export async function createGoogleEvent({ title, start, end, location = "", notes = "" }) {
  if (!title || !start || !end) {
    return { ok: false, message: "title/start/end required" };
  }

  const cfg = getGoogleConfig();
  const auth = await getAuthedClient();
  const calendar = google.calendar({ version: "v3", auth });

  const resource = {
    summary: String(title),
    location: String(location || ""),
    description: String(notes || ""),
    start: { dateTime: String(start), timeZone: cfg.GOOGLE_TIMEZONE || "Europe/Zurich" },
    end: { dateTime: String(end), timeZone: cfg.GOOGLE_TIMEZONE || "Europe/Zurich" },
  };

  const res = await calendar.events.insert({
    calendarId: cfg.GOOGLE_CALENDAR_ID || "primary",
    requestBody: resource,
  });

  return { ok: true, googleEvent: res.data };
}
