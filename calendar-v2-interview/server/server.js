import "dotenv/config";

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import {
  clearTokens,
  createGoogleEvent,
  exchangeCodeForTokens,
  getAuthUrl,
  getConnectedGoogleEmail,
  getGoogleStatus,
  getTokenStorageInfo,
  listGoogleEvents,
} from "./google-calendar.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "..", "public");

app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "calendar-v2-interview" });
});

app.get("/api/google/status", async (req, res) => {
  try {
    const base = await getGoogleStatus();
    const storage = getTokenStorageInfo();
    let connectedEmail = null;

    if (base?.google?.connected) {
      try {
        connectedEmail = await getConnectedGoogleEmail();
      } catch {
        connectedEmail = null;
      }
    }

    res.json({
      ...base,
      google: {
        ...base.google,
        tokenStorage: storage.tokenStorage,
        dbConfigured: storage.dbConfigured,
        connectedEmail,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: error?.message || "status failed" });
  }
});

app.get("/api/google/auth-url", async (req, res) => {
  try {
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    const out = await getAuthUrl({ redirectUri, clientId: process.env.GOOGLE_CLIENT_ID });
    if (!out.ok) return res.status(400).json(out);
    res.json(out);
  } catch (error) {
    res.status(500).json({ ok: false, message: error?.message || "auth-url failed" });
  }
});

async function handleGoogleCallback(req, res) {
  try {
    const code = req.query.code ? String(req.query.code) : "";
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    const out = await exchangeCodeForTokens(code, redirectUri, process.env.GOOGLE_CLIENT_ID);
    if (!out.ok) {
      return res.status(400).send(`<h2>Auth Error</h2><pre>${out.message || "unknown"}</pre>`);
    }
    res.status(200).send("<h2>Google connected</h2><p>You can close this window.</p>");
  } catch (error) {
    res.status(500).send(`<h2>Auth Error</h2><pre>${error?.message || "unknown"}</pre>`);
  }
}

app.get("/api/google/callback", handleGoogleCallback);
app.get("/auth/google/callback", handleGoogleCallback);

app.post("/api/google/disconnect", async (req, res) => {
  try {
    await clearTokens();
    res.json({ ok: true, disconnected: true });
  } catch (error) {
    res.status(500).json({ ok: false, message: error?.message || "disconnect failed" });
  }
});

app.get("/api/events", async (req, res) => {
  try {
    const { from, to } = req.query;
    const out = await listGoogleEvents({ timeMin: from, timeMax: to });
    if (!out.ok) return res.status(400).json(out);
    res.json({ ok: true, events: out.events });
  } catch (error) {
    res.status(500).json({ ok: false, message: error?.message || "list failed" });
  }
});

app.post("/api/events", async (req, res) => {
  try {
    const { title, start, end, location = "", notes = "" } = req.body || {};
    const out = await createGoogleEvent({ title, start, end, location, notes });
    if (!out.ok) return res.status(400).json(out);
    res.json({ ok: true, event: out.googleEvent });
  } catch (error) {
    res.status(500).json({ ok: false, message: error?.message || "create failed" });
  }
});

app.get("/api/export", async (req, res) => {
  try {
    const { from, to } = req.query;
    const out = await listGoogleEvents({ timeMin: from, timeMax: to });
    if (!out.ok) return res.status(400).json(out);
    res.json({ ok: true, events: out.events });
  } catch (error) {
    res.status(500).json({ ok: false, message: error?.message || "export failed" });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`calendar-v2-interview server running on ${PORT}`);
});
