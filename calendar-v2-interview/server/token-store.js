import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKENS_PATH = path.join(__dirname, "google-tokens.json");
const TOKEN_KEY = (process.env.GOOGLE_TOKENS_KEY || "default").trim() || "default";
const DATABASE_URL = (process.env.GOOGLE_TOKENS_DATABASE_URL || process.env.DATABASE_URL || "").trim();

let pool;
let initPromise;

function needsSsl(url) {
  if (!url) return false;
  if (/sslmode=require/i.test(url)) return true;
  if ((process.env.PGSSLMODE || "").toLowerCase() === "require") return true;
  return false;
}

function getPool() {
  if (!DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: needsSsl(DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

export function getTokenStorageInfo() {
  const dbConfigured = !!DATABASE_URL;
  return {
    dbConfigured,
    tokenStorage: dbConfigured ? "db" : "file",
  };
}

async function ensureTable() {
  const client = getPool();
  if (!client) return;
  if (!initPromise) {
    initPromise = client.query(`
      create table if not exists google_tokens (
        id text primary key,
        refresh_token text,
        access_token text,
        expiry_date bigint,
        scope text,
        token_type text,
        updated_at timestamptz not null default now()
      );
    `);
  }
  await initPromise;
}

function normalizeTokens(tokens) {
  if (!tokens) return null;
  const out = {
    refresh_token: tokens.refresh_token || null,
    access_token: tokens.access_token || null,
    expiry_date: tokens.expiry_date || tokens.expiry_date === 0 ? Number(tokens.expiry_date) : null,
    scope: tokens.scope || null,
    token_type: tokens.token_type || null,
  };
  if (tokens.id) out.id = tokens.id;
  return out;
}

export async function loadTokens() {
  const client = getPool();
  if (client) {
    await ensureTable();
    const res = await client.query(
      "select refresh_token, access_token, expiry_date, scope, token_type from google_tokens where id=$1",
      [TOKEN_KEY]
    );
    if (!res?.rows?.length) return null;
    return normalizeTokens(res.rows[0]);
  }

  try {
    if (!fs.existsSync(TOKENS_PATH)) return null;
    const raw = fs.readFileSync(TOKENS_PATH, "utf-8");
    return normalizeTokens(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveTokens(tokens) {
  const normalized = normalizeTokens(tokens);
  if (!normalized) return;

  const client = getPool();
  if (client) {
    await ensureTable();
    await client.query(
      `
      insert into google_tokens (id, refresh_token, access_token, expiry_date, scope, token_type, updated_at)
      values ($1, $2, $3, $4, $5, $6, now())
      on conflict (id)
      do update set
        refresh_token = excluded.refresh_token,
        access_token = excluded.access_token,
        expiry_date = excluded.expiry_date,
        scope = excluded.scope,
        token_type = excluded.token_type,
        updated_at = now();
      `,
      [
        TOKEN_KEY,
        normalized.refresh_token,
        normalized.access_token,
        normalized.expiry_date,
        normalized.scope,
        normalized.token_type,
      ]
    );
    return;
  }

  fs.writeFileSync(TOKENS_PATH, JSON.stringify(normalized, null, 2), "utf-8");
}

export async function clearTokens() {
  const client = getPool();
  if (client) {
    await ensureTable();
    await client.query("delete from google_tokens where id=$1", [TOKEN_KEY]);
    return;
  }

  try {
    if (fs.existsSync(TOKENS_PATH)) fs.unlinkSync(TOKENS_PATH);
  } catch {
    // ignore
  }
}
