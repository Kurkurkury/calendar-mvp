# Calendar V2 – Interview Edition

Minimal standalone Google Calendar tool for interview demos.

## Features
- Google OAuth connect/disconnect
- List events by date range (`GET /api/events?from=...&to=...`)
- Create event (`POST /api/events`)
- Export endpoint (`GET /api/export?from=...&to=...`)
- Minimal dark UI in `public/`

## Setup
1. Copy `.env.example` to `.env`
2. Fill in Google OAuth values
3. Install and run:

```bash
npm install
npm start
```

Server runs on `http://localhost:3000` by default.

## Google OAuth redirect URI
Use:

- `http://localhost:3000/api/google/callback` (local)
- `https://<your-render-domain>/api/google/callback` (Render)

## Render notes
- Build Command: `npm install`
- Start Command: `npm start`
- Add env vars from `.env.example`
