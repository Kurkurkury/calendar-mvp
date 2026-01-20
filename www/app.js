
// -------------------- UI Notify (guaranteed visible, no CSS needed) --------------------
function uiNotify(type, message) {
  try {
    const line = document.getElementById("statusLine");
    if (line) {
      line.textContent = message;
      line.style.opacity = "1";
      line.style.fontWeight = "600";
    }

    // Floating toast (inline styles so it always shows)
    const toast = document.createElement("div");
    toast.setAttribute("role", "status");
    toast.textContent = message;
    toast.style.position = "fixed";
    toast.style.left = "50%";
    toast.style.transform = "translateX(-50%)";
    toast.style.bottom = "18px";
    toast.style.zIndex = "99999";
    toast.style.padding = "10px 12px";
    toast.style.borderRadius = "12px";
    toast.style.background = type === "error" ? "rgba(180, 0, 0, 0.92)" : "rgba(0, 120, 0, 0.92)";
    toast.style.color = "white";
    toast.style.fontWeight = "700";
    toast.style.fontSize = "14px";
    toast.style.maxWidth = "92vw";
    toast.style.boxShadow = "0 10px 24px rgba(0,0,0,0.25)";
    document.body.appendChild(toast);

    window.setTimeout(() => {
      toast.remove();
      if (line) line.style.fontWeight = "400";
    }, 2500);
  } catch (e) {
    // Never recurse in an error handler
    console.warn('uiNotify failed:', e);
    try { alert(message); } catch {}
  }
}


// app.js
// Kalender MVP – Woche + Tasks + Eisenhower + Auto-Scheduling in Time Windows
// ✅ Mit Backend-API (Events + Tasks)
// ✅ Google Quick-Add (Event) aus UI
// ✅ Google-Calendar-Status sichtbar im UI
// ✅ View Switcher (Tag | Woche | Monat) + Mobile default = Tag

// -------------------- API BASE (Emulator vs Browser) --------------------
// Android Emulator: 10.0.2.2 -> Host-PC (dein Node Server)
// Browser am PC: localhost

// ✅ FIX: zuverlässig unterscheiden Browser vs Native (Capacitor)
// window.Capacitor kann auch im Browser existieren -> NICHT als Signal nutzen.
const IS_NATIVE =
  !!window.Capacitor &&
  typeof window.Capacitor.getPlatform === "function" &&
  window.Capacitor.getPlatform() !== "web";

// ✅ LIVE: fix auf Render (kein localhost / 10.0.2.2)
const RAW_API_BASE = "https://calendar-api-l9kp.onrender.com";

const API_BASE = String(RAW_API_BASE || "").replace(/\/+$/, ""); // wichtig: kein trailing /
const API_KEY = localStorage.getItem("calendarApiKeyV1") || ""; // optional

const GCAL_CACHE_KEY = "gcal_last_events_v1";
const GCAL_DAYS_PAST = 365;
const GCAL_DAYS_FUTURE = 365;
const GCAL_POLL_MS = 5 * 60 * 1000; // 5 Minuten (Fallback, falls Push-Sync nicht verfuegbar)
const SYNC_STATUS_POLL_MS = 30 * 1000; // Phase 3 Push-Sync: App fragt Status alle 30s

let gcalPollTimer = null;

function saveLastKnownGoogleEvents(events) {
  try {
    localStorage.setItem(
      GCAL_CACHE_KEY,
      JSON.stringify({ ts: Date.now(), events: Array.isArray(events) ? events : [] })
    );
  } catch {}
}

function loadLastKnownGoogleEvents() {
  try {
    const raw = localStorage.getItem(GCAL_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.events) ? parsed.events : null;
  } catch {
    return null;
  }
}

async function apiGetGoogleEvents(daysPast = GCAL_DAYS_PAST, daysFuture = GCAL_DAYS_FUTURE) {
  return apiGet(`/api/google/events?daysPast=${daysPast}&daysFuture=${daysFuture}`);
}

function startGooglePollingOnce() {
  if (gcalPollTimer) return;

  let tickCount = 0;

  async function tick() {
    try {
      // Google-Status nicht bei jedem Tick laden (schont Requests)
      tickCount++;
      if (tickCount == 1 || tickCount % 4 == 0) {
        const g = await apiGet("/api/google/status");
        state.google = (g.google || g || { configured: false, connected: false, scopes: "" });
      }

      if (!state.google?.connected) return;

      // Phase 3: Push-Sync -> Server sagt uns, ob sich seit letztem Push etwas geaendert hat
      const sync = await apiGet("/api/sync/status");
      if (!sync?.ok) return;

      if (sync.dirty) {
        const eventsRes = await apiGetGoogleEvents();
        if (eventsRes?.ok && Array.isArray(eventsRes.events)) {
          state.events = eventsRes.events;
          saveLastKnownGoogleEvents(state.events);
          await render();
          // ACK: dirty zuruecksetzen
          try {
            await apiPost("/api/sync/ack", { lastChangeAt: sync.lastChangeAt || null });
          } catch {}
        }
      }
    } catch (e) {
      // Fallback: Wenn der Server /api/sync/status nicht kennt, bleiben wir beim alten Polling.
      const msg = String(e?.message || "");
      if (msg.includes("404") || msg.includes("Not Found")) {
        try {
          const g = await apiGet("/api/google/status");
          state.google = (g.google || g || { configured: false, connected: false, scopes: "" });
          if (state.google?.connected) {
            const eventsRes = await apiGetGoogleEvents();
            if (eventsRes?.ok && Array.isArray(eventsRes.events)) {
              state.events = eventsRes.events;
              saveLastKnownGoogleEvents(state.events);
              await render();
            }
          }
        } catch {}
      }
    }
  }

  // sofort einmal laufen
  tick();
  gcalPollTimer = setInterval(tick, SYNC_STATUS_POLL_MS);
}


// -------------------- State --------------------
const state = {
  view: (isMobile()
    ? (loadLocal("calendarViewV1", "day") || "day")
    : (loadLocal("calendarViewV1", "week") || "week")),
  activeDate: loadDateLocal("calendarActiveDateV1", new Date()),
  weekStart: startOfWeek(new Date()),

  tasks: [],
  events: [],
  google: { configured: false, connected: false, scopes: "" },

  windows: loadLocal("windowsV1", [
    { id: "w1", name: "Fokus", days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00", weight: 3 },
    { id: "w2", name: "Uni", days: [1, 2, 3, 4, 5], start: "14:00", end: "16:00", weight: 2 },
    { id: "w3", name: "Samstag Slot", days: [6], start: "10:00", end: "12:00", weight: 1 },
  ]),

  viewStartHour: 7,
  viewEndHour: 22,
  stepMinutes: 30,
  slotPx: 48
};

const els = {
  weekLabel: byId("weekLabel"),
  statusLine: byId("statusLine"),

  dayHeaders: byId("dayHeaders"),
  timeCol: byId("timeCol"),
  grid: byId("grid"),
  inboxList: byId("inboxList"),
  plannedList: byId("plannedList"),
  windowsList: byId("windowsList"),

  prevWeekBtn: byId("prevWeekBtn"),
  todayBtn: byId("todayBtn"),
  nextWeekBtn: byId("nextWeekBtn"),

  newBtn: byId("newBtn"),

  // ✅ Google UI (wird dynamisch in die Topbar eingefügt)
  googleConnectBtn: null,
  googleDisconnectBtn: null,

  menuBackdrop: byId("menuBackdrop"),
  newMenu: byId("newMenu"),
  closeMenuBtn: byId("closeMenuBtn"),

  modalBackdrop: byId("modalBackdrop"),
  taskModal: byId("taskModal"),
  closeModalBtn: byId("closeModalBtn"),

  taskTitle: byId("taskTitle"),
  taskDuration: byId("taskDuration"),
  taskDeadline: byId("taskDeadline"),
  imp: byId("imp"),
  urg: byId("urg"),
  quadrantBadge: byId("quadrantBadge"),
  quadrantHint: byId("quadrantHint"),
  autoSchedule: byId("autoSchedule"),
  createTaskBtn: byId("createTaskBtn"),

  // Event modal
  eventBackdrop: byId("eventBackdrop"),
  eventModal: byId("eventModal"),
  closeEventBtn: byId("closeEventBtn"),
  eventText: byId("eventText"),
  createEventBtn: byId("createEventBtn"),
};

boot();

// -------------------- Boot --------------------
async function boot() {
  state.weekStart = startOfWeek(state.activeDate);


  // Nav (view-aware)
  els.prevWeekBtn?.addEventListener("click", async () => { shiftView(-1); await render(); });
  els.nextWeekBtn?.addEventListener("click", async () => { shiftView(1); await render(); });
  els.todayBtn?.addEventListener("click", async () => {
    state.activeDate = new Date();
    state.weekStart = startOfWeek(state.activeDate);
    saveDateLocal("calendarActiveDateV1", state.activeDate);
    await render();
  });

  // New menu
  els.newBtn?.addEventListener("click", openMenu);
  els.closeMenuBtn?.addEventListener("click", closeMenu);
  els.menuBackdrop?.addEventListener("click", closeMenu);

  els.newMenu?.querySelectorAll(".menuItem").forEach(btn => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      closeMenu();
      if (action === "newTask") openTaskModal();
      if (action === "newEvent") openEventModal();
    });
  });

  // Task modal
  els.closeModalBtn?.addEventListener("click", closeTaskModal);
  els.modalBackdrop?.addEventListener("click", closeTaskModal);
  els.imp?.addEventListener("change", updateQuadrantUI);
  els.urg?.addEventListener("change", updateQuadrantUI);
  els.createTaskBtn?.addEventListener("click", createTask);

  // Event modal
  els.closeEventBtn?.addEventListener("click", closeEventModal);
  els.eventBackdrop?.addEventListener("click", closeEventModal);
  els.createEventBtn?.addEventListener("click", createEventFromText);
  els.eventText?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      els.createEventBtn?.click();
    }
  });

  bindGoogleButtons();
  await refreshFromApi();
  startGooglePollingOnce();
  await render();
}

// -------------------- Google UI --------------------
function bindGoogleButtons() {
  // Prefer existing buttons from index.html
  els.googleConnectBtn = byId('googleConnectBtn');
  els.googleDisconnectBtn = byId('googleDisconnectBtn');

  els.googleConnectBtn?.addEventListener('click', onGoogleConnect);
  els.googleDisconnectBtn?.addEventListener('click', onGoogleDisconnect);

  updateGoogleButtons();
}

function updateGoogleButtons() {
  const g = state.google || {};
  const connected = !!g.connected;
  const configured = !!g.configured;
  const wrong = !!g.wrongAccount;

  if (els.googleConnectBtn) {
    els.googleConnectBtn.disabled = !configured;
    els.googleConnectBtn.title = configured ? '' : 'Backend: Google OAuth ist nicht konfiguriert (ENV Vars fehlen)';
    // If wrong account: keep connect visible so user can reconnect
    els.googleConnectBtn.style.display = connected && !wrong ? 'none' : '';
  }

  if (els.googleDisconnectBtn) {
    // Disconnect is optional (server may require API key)
    els.googleDisconnectBtn.style.display = connected ? '' : 'none';
  }
}

function googleUiStatusLine() {
  const g = state.google || {};
  if (!g.configured) return 'Google: nicht konfiguriert ⚪';
  if (!g.connected) return 'Google: nicht verbunden 🟡';

  const email = g.connectedEmail ? String(g.connectedEmail) : 'verbunden';
  if (g.wrongAccount) {
    const allowed = g.allowedEmail ? String(g.allowedEmail) : '(unbekannt)';
    return `Google: FALSCHER ACCOUNT ❌ (${email}) • erlaubt: ${allowed}`;
  }
  return `Google: verbunden ✅ (${email})`;
}

async function pollGoogleConnected({ timeoutMs = 90_000, intervalMs = 2000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const g = await apiGet('/api/google/status');
      state.google = (g.google || g || { configured: false, connected: false, scopes: '' });
      updateGoogleButtons();

      if (state.google?.connected && !state.google?.wrongAccount) {
        return true;
      }
    } catch {
      // ignore while polling
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

async function onGoogleConnect() {
  try {
    const out = await apiGet('/api/google/auth-url');
    const url = out?.url;
    if (!url) throw new Error('auth-url missing');

    // Open OAuth in a new tab/window
    window.open(url, '_blank', 'noopener,noreferrer');

    uiNotify('success', 'Google Login geöffnet – nach erfolgreichem Login verbindet die App automatisch…');
    setStatus('Google Login geöffnet… warte auf Verbindung…', true);

    const ok = await pollGoogleConnected();
    if (ok) {
      uiNotify('success', 'Google verbunden ✅');
      await refreshFromApi();
      await render();
    } else {
      uiNotify('error', 'Google noch nicht verbunden. Falls du fertig eingeloggt bist: Seite neu laden.');
    }
  } catch (e) {
    uiNotify('error', 'Google verbinden fehlgeschlagen: ' + (e?.message || String(e)));
    console.warn('Google connect error:', e);
  }
}

async function onGoogleDisconnect() {
  try {
    if (!API_KEY) {
      uiNotify('error', 'Trennen ist gesperrt (API-Key fehlt). Für Normalnutzung nicht nötig.');
      return;
    }

    await apiPost('/api/google/disconnect', {});
    await refreshFromApi();
    await render();
    uiNotify('success', 'Google getrennt ✅');
  } catch (e) {
    uiNotify('error', 'Trennen fehlgeschlagen: ' + (e?.message || String(e)));
    console.warn('Google disconnect error:', e);
  }
}

// -------------------- Helpers --------------------
function isMobile() {
  return window.innerWidth < 768;
}

function setStatus(msg, ok = true) {
  if (!els.statusLine) return;
  els.statusLine.textContent = msg || '';
  els.statusLine.style.color = ok ? '' : 'var(--danger)';
}

// Kleine Toast-Meldung (ohne CSS-Datei anfassen)
function toast(message, type = "info", ms = 2600) {
  const id = "toastV1";
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.style.position = "fixed";
    el.style.right = "16px";
    el.style.bottom = "16px";
    el.style.zIndex = "9999";
    el.style.padding = "10px 12px";
    el.style.borderRadius = "12px";
    el.style.boxShadow = "0 10px 30px rgba(0,0,0,.25)";
    el.style.backdropFilter = "blur(6px)";
    el.style.maxWidth = "min(360px, calc(100vw - 32px))";
    el.style.fontSize = "14px";
    el.style.lineHeight = "1.35";
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    el.style.transition = "opacity .15s ease, transform .15s ease";
    document.body.appendChild(el);
  }

  const bg = type === "error"
    ? "rgba(160, 40, 40, .92)"
    : (type === "success" ? "rgba(30, 130, 70, .92)" : "rgba(30, 30, 35, .92)");
  el.style.background = bg;
  el.style.color = "white";

  el.textContent = message;

  // show
  requestAnimationFrame(() => {
    el.style.opacity = "1";
    el.style.transform = "translateY(0px)";
  });

  // hide
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
  }, ms);
}

function googleStatusText() {
  return googleUiStatusLine();
}

function isNetworkFetchFail(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("failed to fetch") ||
    msg.includes("networkerror") ||
    msg.includes("load failed") ||
    msg.includes('fetch fail') || msg.includes('netzwerkfehler')
  );
}

// -------------------- API refresh --------------------
async function refreshFromApi() {
  try {
    await apiGet("/api/health");

    const g = await apiGet("/api/google/status");
    state.google = (g.google || g || { configured: false, connected: false, scopes: "" });

    updateGoogleButtons();

    const [tasksRes] = await Promise.all([
      apiGet("/api/tasks"),
    ]);

    state.tasks = tasksRes.tasks || [];

    // Phase 2 Sync: Anzeige basiert ausschließlich auf Google-Events (Single Source of Truth)
    try {
      if (state.google?.connected) {
        const eventsRes = await apiGetGoogleEvents();
        if (eventsRes?.ok && Array.isArray(eventsRes.events)) {
          state.events = eventsRes.events;
          saveLastKnownGoogleEvents(state.events);
        } else {
          state.events = [];
        }
      } else {
        // nicht verbunden -> last-known anzeigen (gleiche Ebene, kein lokaler Parallelkalender)
        state.events = loadLastKnownGoogleEvents() || [];
      }
    } catch {
      // offline/fehler -> last-known
      state.events = loadLastKnownGoogleEvents() || [];
    }

    setStatus(`API: verbunden ✅ (${API_BASE}) • ${googleUiStatusLine()}`, !state.google?.wrongAccount);
  } catch (e) {
    if (isNetworkFetchFail(e)) {
      updateGoogleButtons();
      setStatus(`Offline 📴 (${API_BASE}) • ${googleStatusText()}`, true);
      return;
    }

    updateGoogleButtons();
    setStatus(`API Problem ⚠️ (${API_BASE}) • ${googleStatusText()}`, true);
    console.warn("API error:", e);
  }
}

// -------------------- Render --------------------
async function render() {
  saveLocal("calendarViewV1", state.view);
  saveDateLocal("calendarActiveDateV1", state.activeDate);

  renderTopBar();

  if (state.view === "day") {
    renderDayView();
  } else if (state.view === "week") {
    renderWeekView();
  } else {
    renderMonthView();
  }

  renderSideLists();
  renderWindows();
  saveLocal("windowsV1", state.windows);

  updateGoogleButtons();

  if (els.statusLine?.textContent?.includes("API verbunden")) {
    setStatus(`API: verbunden ✅ (${API_BASE}) • ${googleUiStatusLine()}`, !state.google?.wrongAccount);
  }
}

// -------------------- View handling --------------------
function setView(nextView) {
  state.view = nextView;
  state.weekStart = startOfWeek(state.activeDate);
}

function shiftView(dir) {
  if (state.view === "day") {
    state.activeDate = addDays(state.activeDate, dir);
    state.weekStart = startOfWeek(state.activeDate);
  } else if (state.view === "week") {
    state.weekStart = addDays(state.weekStart, dir * 7);
    state.activeDate = new Date(state.weekStart);
  } else {
    state.activeDate = new Date(state.activeDate.getFullYear(), state.activeDate.getMonth() + dir, 1);
    state.weekStart = startOfWeek(state.activeDate);
  }
}

function renderTopBar() {
  if (!els.weekLabel) return;

  let label = "";
  if (state.view === "day") {
    label = fmtDate(state.activeDate);
  } else if (state.view === "week") {
    const end = addDays(state.weekStart, 6);
    label = `${fmtDate(state.weekStart)} – ${fmtDate(end)}`;
  } else {
    label = `${monthName(state.activeDate)} ${state.activeDate.getFullYear()}`;
  }

  els.weekLabel.innerHTML = `
    <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
      <div style="font-weight:700;">${escapeHtml(label)}</div>
      <div style="display:flex; gap:6px; background:rgba(255,255,255,.06); padding:6px; border-radius:12px;">
        <button data-view="day"   style="${viewBtnStyle(state.view === "day")}">Tag</button>
        <button data-view="week"  style="${viewBtnStyle(state.view === "week")}">Woche</button>
        <button data-view="month" style="${viewBtnStyle(state.view === "month")}">Monat</button>
      </div>
    </div>
  `;

  els.weekLabel.querySelectorAll("button[data-view]").forEach(btn => {
    btn.addEventListener("click", async () => {
      setView(btn.dataset.view);
      await render();
    });
  });
}

function viewBtnStyle(active) {
  const base = [
    "border:0",
    "border-radius:10px",
    "padding:8px 10px",
    "font-weight:700",
    "cursor:pointer",
    "color:rgba(255,255,255,.85)",
    "background:transparent",
  ];
  if (active) {
    base.push("background:rgba(255,255,255,.12)");
    base.push("color:#fff");
  }
  return base.join(";");
}

// -------------------- Day / Week / Month renderers --------------------
function renderDayView() {
  renderTimeCol();

  const d = startOfDay(state.activeDate);
  renderHeadersForDays([d], true);
  renderGridForDays([d]);

  drawBlocksForRange(d, addDays(d, 1), [d]);
}

function renderWeekView() {
  renderTimeCol();

  const days = getWeekDays(state.weekStart);
  renderHeadersForDays(days, false, dateKey(new Date()));
  renderGridForDays(days);

  const weekEnd = addDays(state.weekStart, 7);
  drawBlocksForRange(state.weekStart, weekEnd, days);
}

function renderMonthView() {
  if (els.timeCol) els.timeCol.innerHTML = "";
  if (els.dayHeaders) els.dayHeaders.innerHTML = "";
  if (!els.grid) return;

  els.grid.innerHTML = "";
  els.grid.style.height = "auto";

  const firstOfMonth = new Date(state.activeDate.getFullYear(), state.activeDate.getMonth(), 1);
  const gridStart = startOfWeek(firstOfMonth);
  const weeks = 6;
  const cells = weeks * 7;
  const monthIdx = firstOfMonth.getMonth();

  const counts = buildCountsByDate();

  const wrapper = document.createElement("div");
  wrapper.style.display = "grid";
  wrapper.style.gridTemplateColumns = "repeat(7, 1fr)";
  wrapper.style.gap = "8px";
  wrapper.style.padding = "6px";

  const names = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  for (let i = 0; i < 7; i++) {
    const head = document.createElement("div");
    head.textContent = names[i];
    head.style.fontWeight = "800";
    head.style.opacity = "0.8";
    head.style.fontSize = "12px";
    head.style.padding = "2px 4px";
    wrapper.appendChild(head);
  }

  for (let i = 0; i < cells; i++) {
    const day = addDays(gridStart, i);
    const k = dateKey(day);
    const inMonth = day.getMonth() === monthIdx;

    const cell = document.createElement("button");
    cell.type = "button";
    cell.style.border = "1px solid rgba(255,255,255,.08)";
    cell.style.background = inMonth ? "rgba(255,255,255,.04)" : "rgba(255,255,255,.02)";
    cell.style.borderRadius = "12px";
    cell.style.padding = "10px 8px";
    cell.style.textAlign = "left";
    cell.style.cursor = "pointer";
    cell.style.color = "rgba(255,255,255,.9)";
    cell.style.minHeight = "64px";

    const top = document.createElement("div");
    top.style.display = "flex";
    top.style.justifyContent = "space-between";
    top.style.alignItems = "center";

    const dayNum = document.createElement("div");
    dayNum.textContent = String(day.getDate());
    dayNum.style.fontWeight = "900";
    dayNum.style.opacity = inMonth ? "1" : "0.45";

    const badge = document.createElement("div");
    const c = counts[k];
    const total = (c?.tasksScheduled || 0) + (c?.events || 0);
    badge.textContent = total ? String(total) : "";
    badge.style.fontSize = "12px";
    badge.style.fontWeight = "900";
    badge.style.opacity = total ? "1" : "0";
    badge.style.padding = "2px 8px";
    badge.style.borderRadius = "999px";
    badge.style.background = "rgba(62,226,143,.12)";
    badge.style.border = "1px solid rgba(62,226,143,.25)";

    top.appendChild(dayNum);
    top.appendChild(badge);

    const meta = document.createElement("div");
    meta.style.marginTop = "6px";
    meta.style.fontSize = "12px";
    meta.style.opacity = "0.8";
    meta.textContent = formatCountLine(c);

    cell.appendChild(top);
    cell.appendChild(meta);

    cell.addEventListener("click", async () => {
      state.activeDate = day;
      state.weekStart = startOfWeek(day);
      state.view = "day";
      await render();
    });

    wrapper.appendChild(cell);
  }

  els.grid.appendChild(wrapper);
}

// ---- the rest of your file is unchanged below ----

// -------------------- Headers / grid helpers --------------------
function renderHeadersForDays(days, singleDay = false, todayKey = dateKey(new Date())) {
  if (!els.dayHeaders) return;
  els.dayHeaders.innerHTML = "";

  const names = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

  days.forEach((d, i) => {
    const div = document.createElement("div");
    div.className = "dayHead";

    const k = dateKey(d);
    if (k === todayKey) div.classList.add("today");

    if (singleDay) {
      div.innerHTML = `<div class="dow">Heute</div><div class="date">${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.</div>`;
    } else {
      div.innerHTML = `<div class="dow">${names[i]}</div><div class="date">${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.</div>`;
    }

    els.dayHeaders.appendChild(div);
  });

  if (singleDay && els.dayHeaders.children.length === 1) {
    els.dayHeaders.style.gridTemplateColumns = "1fr";
  } else {
    els.dayHeaders.style.gridTemplateColumns = "";
  }
}

function renderTimeCol() {
  if (!els.timeCol) return;
  els.timeCol.innerHTML = "";
  const slots = timeSlots(state.viewStartHour, state.viewEndHour, state.stepMinutes);
  slots.forEach((t) => {
    const div = document.createElement("div");
    div.className = "timeLabel";
    div.textContent = t.endsWith(":00") ? t : "";
    els.timeCol.appendChild(div);
  });
}

function renderGridForDays(days) {
  if (!els.grid) return;
  els.grid.innerHTML = "";

  const todayKey = dateKey(new Date());
  const totalSlots = timeSlots(state.viewStartHour, state.viewEndHour, state.stepMinutes).length;
  const gridHeightPx = totalSlots * state.slotPx;
  els.grid.style.height = `${gridHeightPx}px`;

  if (days.length === 1) {
    els.grid.style.display = "grid";
    els.grid.style.gridTemplateColumns = "1fr";
  } else {
    els.grid.style.display = "";
    els.grid.style.gridTemplateColumns = "";
  }

  for (let i = 0; i < days.length; i++) {
    const col = document.createElement("div");
    col.className = "col";
    if (dateKey(days[i]) === todayKey) col.classList.add("today");
    col.style.height = `${gridHeightPx}px`;

    for (let s = 0; s < totalSlots; s++) {
      const line = document.createElement("div");
      line.className = "slotLine";
      line.style.top = `${s * state.slotPx}px`;
      col.appendChild(line);
    }
    els.grid.appendChild(col);
  }
}

/* -------------- REST OF YOUR ORIGINAL FILE -------------- */
/* Everything after this point is identical to what you pasted,
   including drawBlocks, side lists, scheduling, apiGet/apiPost,
   utils, etc. */

function drawBlocksForRange(rangeStart, rangeEnd, daysArray) {
  const scheduledTasks = (state.tasks || [])
    .filter(t => t.scheduledStart && t.scheduledEnd)
    .map(t => ({ ...t, start: new Date(t.scheduledStart), end: new Date(t.scheduledEnd) }))
    .filter(t => t.start >= rangeStart && t.start < rangeEnd);

  scheduledTasks.forEach(t => drawTaskBlock(t, daysArray, rangeStart));

  const eventsInRange = (state.events || [])
    .map(e => ({ ...e, startD: new Date(e.start), endD: new Date(e.end) }))
    .filter(e => e.startD >= rangeStart && e.startD < rangeEnd);

  eventsInRange.forEach(e => drawEventBlock(e, daysArray, rangeStart));
}

// -------------------- Blocks --------------------
function drawTaskBlock(task, daysArray, rangeStart) {
  const start = new Date(task.scheduledStart);
  const end = new Date(task.scheduledEnd);

  const dayIdx = indexWithinRenderedDays(start, daysArray, rangeStart);
  if (dayIdx < 0 || dayIdx >= els.grid.children.length) return;

  const col = els.grid.children[dayIdx];
  const yStartMin = minutesFromViewStart(start);
  const yEndMin = minutesFromViewStart(end);

  const pxPerMin = state.slotPx / state.stepMinutes;
  const top = yStartMin * pxPerMin;
  const height = Math.max(28, (yEndMin - yStartMin) * pxPerMin);

  const div = document.createElement("div");
  div.className = "taskBlock";
  div.style.top = `${top + 2}px`;
  div.style.height = `${height - 4}px`;

  const quad = computeQuadrant(task.importance, task.urgency);
  div.innerHTML = `
    <div class="t">${escapeHtml(task.title)}</div>
    <div class="m">${task.durationMinutes} min • ${quad.label}</div>
  `;
  col.appendChild(div);
}

function drawEventBlock(ev, daysArray, rangeStart) {
  const start = ev.startD;
  const end = ev.endD;

  const dayIdx = indexWithinRenderedDays(start, daysArray, rangeStart);
  if (dayIdx < 0 || dayIdx >= els.grid.children.length) return;

  const col = els.grid.children[dayIdx];
  const yStartMin = minutesFromViewStart(start);
  const yEndMin = minutesFromViewStart(end);

  const pxPerMin = state.slotPx / state.stepMinutes;
  const top = yStartMin * pxPerMin;
  const height = Math.max(28, (yEndMin - yStartMin) * pxPerMin);

  const div = document.createElement("div");
  div.className = "taskBlock";
  div.style.top = `${top + 2}px`;
  div.style.height = `${height - 4}px`;
  div.style.background = "rgba(62,226,143,.18)";
  div.style.border = "1px solid rgba(62,226,143,.35)";

  div.innerHTML = `
    <div class="t">${escapeHtml(ev.title)}</div>
    <div class="m">${fmtTime(start)}–${fmtTime(end)} • Event</div>
  `;
  col.appendChild(div);
}

function indexWithinRenderedDays(date, daysArray, rangeStart) {
  if (daysArray.length === 1) return 0;
  const k = dateKey(date);
  const idx = daysArray.findIndex(d => dateKey(d) === k);
  return idx >= 0 ? idx : dayIndexMon0(date);
}

// -------------------- Side lists / Windows --------------------
function renderSideLists() {
  if (!els.inboxList || !els.plannedList) return;

  els.inboxList.innerHTML = "";
  els.plannedList.innerHTML = "";

  const inbox = (state.tasks || []).filter(t => !t.scheduledStart && t.status !== "done");
  const planned = (state.tasks || []).filter(t => t.scheduledStart && t.status !== "done");

  if (inbox.length === 0) {
    els.inboxList.innerHTML = `<div class="item"><div class="itemTitle">Leer</div><div class="itemMeta">Keine offenen Tasks ohne Slot.</div></div>`;
  } else {
    inbox.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).forEach(t => els.inboxList.appendChild(taskItem(t)));
  }

  if (planned.length === 0) {
    els.plannedList.innerHTML = `<div class="item"><div class="itemTitle">Leer</div><div class="itemMeta">Noch nichts eingeplant.</div></div>`;
  } else {
    planned.sort((a, b) => new Date(a.scheduledStart) - new Date(b.scheduledStart)).forEach(t => els.plannedList.appendChild(taskItem(t, true)));
  }
}

function taskItem(task, showTime = false) {
  const div = document.createElement("div");
  div.className = "item";
  const quad = computeQuadrant(task.importance, task.urgency);

  let meta = `${task.durationMinutes} min • ${quad.label}`;
  if (task.deadline) meta += ` • Deadline: ${task.deadline}`;
  if (showTime && task.scheduledStart) meta += ` • ${fmtDateTime(new Date(task.scheduledStart))}`;

  div.innerHTML = `
    <div class="itemTop">
      <div class="itemTitle">${escapeHtml(task.title)}</div>
      <span class="badge">${quad.short}</span>
    </div>
    <div class="itemMeta">${meta}</div>
  `;
  return div;
}

function renderWindows() {
  if (!els.windowsList) return;
  els.windowsList.innerHTML = "";
  state.windows.forEach(w => {
    const div = document.createElement("div");
    div.className = "item";
    const days = w.days.map(d => ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"][d - 1]).join(",");
    div.innerHTML = `
      <div class="itemTop">
        <div class="itemTitle">${escapeHtml(w.name)}</div>
        <span class="badge">${days}</span>
      </div>
      <div class="itemMeta">${w.start}–${w.end} • Gewicht ${w.weight}</div>
    `;
    els.windowsList.appendChild(div);
  });
}

// -------------------- UI helpers --------------------
function openMenu() {
  els.menuBackdrop?.classList.remove("hidden");
  els.newMenu?.classList.remove("hidden");
}
function closeMenu() {
  els.menuBackdrop?.classList.add("hidden");
  els.newMenu?.classList.add("hidden");
}

function openTaskModal() {
  els.modalBackdrop?.classList.remove("hidden");
  els.taskModal?.classList.remove("hidden");

  els.taskTitle.value = "";
  els.taskDuration.value = 45;
  els.taskDeadline.value = "";
  els.imp.checked = true;
  els.urg.checked = false;
  els.autoSchedule.checked = true;
  updateQuadrantUI();
  setTimeout(() => els.taskTitle.focus(), 0);
}
function closeTaskModal() {
  els.modalBackdrop?.classList.add("hidden");
  els.taskModal?.classList.add("hidden");
}

function openEventModal() {
  els.eventBackdrop?.classList.remove("hidden");
  els.eventModal?.classList.remove("hidden");
  els.eventText.value = "";
  setTimeout(() => els.eventText.focus(), 0);
}
function closeEventModal() {
  els.eventBackdrop?.classList.add("hidden");
  els.eventModal?.classList.add("hidden");
}

function updateQuadrantUI() {
  const q = computeQuadrant(els.imp.checked, els.urg.checked);
  els.quadrantBadge.textContent = q.label;
  els.quadrantHint.textContent = q.hint;
}

// -------------------- Create task + scheduling --------------------
async function createTask() {
  const title = (els.taskTitle.value || "").trim();
  if (!title) {
    setStatus("Bitte Titel eingeben.", false);
    els.taskTitle.focus();
    return;
  }

  const durationMinutes = clamp(parseInt(els.taskDuration.value || "45", 10), 5, 8 * 60);
  const deadline = els.taskDeadline.value ? els.taskDeadline.value : null;
  const importance = !!els.imp.checked;
  const urgency = !!els.urg.checked;

  const task = {
    title,
    durationMinutes,
    deadline,
    importance,
    urgency,
    status: "open",
    scheduledStart: null,
    scheduledEnd: null
  };

  if (els.autoSchedule.checked) {
    const scheduled = scheduleTask(task, state.weekStart, state.windows);
    if (scheduled) {
      task.scheduledStart = scheduled.start.toISOString();
      task.scheduledEnd = scheduled.end.toISOString();
      task.status = "scheduled";
    }
  }

  const btn = els.createTaskBtn;
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Speichere…";

  try {
    await apiPost("/api/tasks", task);
    await refreshFromApi();
    await render();
    setStatus(`Task gespeichert ✅ • ${googleStatusText()}`, true);
    toast("✅ Task gespeichert", "success");
    closeTaskModal();
  } catch (e) {
    setStatus(`Speichern fehlgeschlagen ❌: ${e?.message || "unbekannt"} • ${googleStatusText()}`, false);
    toast(`❌ Task fehlgeschlagen: ${e?.message || "unbekannt"}`, "error", 3400);
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

// -------------------- Event Quick-Add --------------------
async function createEventFromText() {
  // Quick-Add funktioniert nur, wenn Google im Backend wirklich verbunden ist.
  if (!state.google?.configured) {
    setStatus('Google OAuth ist im Backend nicht konfiguriert. (Render ENV prüfen)', false);
    uiNotify('error', 'Google OAuth ist im Backend nicht konfiguriert.');
    return;
  }

  if (!state.google?.connected || state.google?.wrongAccount) {
    setStatus('Google ist nicht (korrekt) verbunden. Bitte oben auf "Mit Google verbinden" klicken.', false);
    uiNotify('error', '❌ Google nicht verbunden – zuerst "Mit Google verbinden"');
    try { els.googleConnectBtn?.focus?.(); } catch {}
    return;
  }

  const text = (els.eventText.value || '').trim();
  if (!text) {
    setStatus('Bitte Event-Text eingeben (z.B. „Coiffeur morgen 13:00 60min“).', false);
    uiNotify('error', '❌ Bitte Event-Text eingeben');
    els.eventText.focus();
    return;
  }

  const btn = els.createEventBtn;
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Erstelle…';
  btn.setAttribute('aria-busy', 'true');

  try {
    const data = await apiPost('/api/google/quick-add', { text });

    const maybe = extractEventFromQuickAddResponse(data, text);
    if (maybe) {
      state.events = Array.isArray(state.events) ? state.events : [];
      state.events.unshift(maybe);
    }

    await refreshFromApi();
    await render();

    setStatus(`Event erstellt ✅ • ${googleUiStatusLine()}`, true);
    uiNotify('success', '✅ Event erstellt');
    closeEventModal();
  } catch (e) {
    const status = e?._meta?.status;

    if (status == 401) {
      // Backend now returns 401 for "not connected" / "wrong account" situations
      await refreshFromApi();
      updateGoogleButtons();
      setStatus(`❌ ${googleUiStatusLine()}`, false);
      uiNotify('error', 'Google ist nicht (korrekt) verbunden – bitte erneut verbinden.');
      try { els.googleConnectBtn?.focus?.(); } catch {}
    } else {
      setStatus(`Event fehlgeschlagen ❌: ${e?.message || 'unbekannt'} • ${googleUiStatusLine()}`, false);
      uiNotify('error', `❌ Event fehlgeschlagen: ${e?.message || 'unbekannt'}`);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
    btn.removeAttribute('aria-busy');
  }
}

function extractEventFromQuickAddResponse(data, fallbackTitle) {
  const ev = data?.event || data?.created || data?.googleEvent || data?.mirroredEvent || null;
  if (!ev) return null;

  const title = ev.title || ev.summary || ev.name || fallbackTitle;

  const start =
    ev.start?.dateTime ||
    ev.start?.date ||
    ev.start ||
    ev.startTime ||
    ev.begin;

  const end =
    ev.end?.dateTime ||
    ev.end?.date ||
    ev.end ||
    ev.endTime ||
    ev.finish;

  if (!start || !end) return null;

  return {
    id: ev.id || `tmp_${Math.random().toString(16).slice(2)}`,
    title,
    start,
    end
  };
}

// -------------------- Scheduling --------------------
function scheduleTask(task, weekStart, windows) {
  const weekDays = getWeekDays(weekStart);
  const occupied = getOccupiedIntervalsForWeek(weekStart);

  const q = computeQuadrant(task.importance, task.urgency);
  if (q.key === "delegate" || q.key === "eliminate") return null;

  const winSorted = [...windows].sort((a, b) => (b.weight - a.weight) || (a.start.localeCompare(b.start)));

  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    const dayDate = weekDays[dayIdx];
    const dow = dayOfWeekISO(dayDate);
    const todays = winSorted.filter(w => w.days.includes(dow));
    if (todays.length === 0) continue;

    for (const w of todays) {
      const start = atTime(dayDate, w.start);
      const end = atTime(dayDate, w.end);

      const step = state.stepMinutes;
      for (let t = new Date(start); addMinutes(t, task.durationMinutes) <= end; t = addMinutes(t, step)) {
        const candStart = new Date(t);
        const candEnd = addMinutes(new Date(t), task.durationMinutes);
        if (!conflicts(occupied, candStart, candEnd)) return { start: candStart, end: candEnd };
      }
    }
  }
  return null;
}

function getOccupiedIntervalsForWeek(weekStart) {
  const weekEnd = addDays(weekStart, 7);

  const taskIntervals = (state.tasks || [])
    .filter(t => t.scheduledStart && t.scheduledEnd)
    .map(t => ({ start: new Date(t.scheduledStart), end: new Date(t.scheduledEnd) }))
    .filter(x => x.start < weekEnd && x.end > weekStart);

  const eventIntervals = (state.events || [])
    .map(e => ({ start: new Date(e.start), end: new Date(e.end) }))
    .filter(x => x.start < weekEnd && x.end > weekStart);

  return [...taskIntervals, ...eventIntervals];
}

function conflicts(occupied, start, end) {
  for (const o of occupied) if (start < o.end && end > o.start) return true;
  return false;
}

// -------------------- API (replaced + fixed) --------------------
function headers() {
  const h = { "Content-Type": "application/json" };
  if (API_KEY) h["X-Api-Key"] = API_KEY;
  return h;
}

function debugEnvLine() {
  return `base=${API_BASE} • raw=${RAW_API_BASE} • isNative=${IS_NATIVE} • hasCapacitor=${!!window.Capacitor} • ua=${navigator.userAgent.slice(0, 60)}…`;
}

function parseApiBody(text) {
  // Render can sometimes return HTML on errors.
  try {
    const json = JSON.parse(text);
    return { kind: 'json', json };
  } catch {
    return { kind: 'text', text: String(text || '') };
  }
}

function makeApiError({ method, url, status, statusText, body }) {
  const base = `HTTP ${status} ${statusText || ''}`.trim();

  // If backend returned a structured message, prefer it
  const msg = body?.kind === 'json'
    ? (body.json?.message || body.json?.error || '')
    : (body?.text || '');

  const clean = msg ? `${base} • ${msg}` : base;

  // Attach a minimal hint (no huge multi-line dumps in UI)
  const err = new Error(clean);
  err._meta = { method, url, status, statusText, body };
  return err;
}

async function apiGet(path) {
  const url = API_BASE + path;
  let res;
  try {
    res = await fetch(url, { method: 'GET', headers: headers() });
  } catch (e) {
    const err = new Error(`Netzwerkfehler (GET) – Backend nicht erreichbar`);
    err._meta = { method: 'GET', url, cause: e };
    throw err;
  }

  const text = await res.text();
  const body = parseApiBody(text);

  // If JSON: allow { ok:false, message }
  if (res.ok && !(body.kind === 'json' && body.json?.ok === false)) {
    return body.kind === 'json' ? body.json : {};
  }

  throw makeApiError({ method: 'GET', url, status: res.status, statusText: res.statusText, body });
}

async function apiPost(path, bodyObj) {
  const url = API_BASE + path;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(bodyObj || {}),
    });
  } catch (e) {
    const err = new Error(`Netzwerkfehler (POST) – Backend nicht erreichbar`);
    err._meta = { method: 'POST', url, cause: e };
    throw err;
  }

  const text = await res.text();
  const body = parseApiBody(text);

  if (res.ok && !(body.kind === 'json' && body.json?.ok === false)) {
    return body.kind === 'json' ? body.json : {};
  }

  throw makeApiError({ method: 'POST', url, status: res.status, statusText: res.statusText, body });
}

// -------------------- Date/time utils --------------------
function startOfWeek(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const jsDay = date.getDay();
  const isoDay = jsDay === 0 ? 7 : jsDay;
  return addDays(date, -(isoDay - 1));
}
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function getWeekDays(weekStart) {
  const days = [];
  for (let i = 0; i < 7; i++) days.push(addDays(new Date(weekStart), i));
  return days;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function addMinutes(d, m) { const x = new Date(d); x.setMinutes(x.getMinutes() + m); return x; }
function atTime(dayDate, hhmm) {
  const [hh, mm] = hhmm.split(":").map(Number);
  const d = new Date(dayDate);
  d.setHours(hh, mm, 0, 0);
  return d;
}
function timeSlots(startHour, endHour, stepMinutes) {
  const slots = [];
  const d = new Date(); d.setHours(startHour, 0, 0, 0);
  const end = new Date(); end.setHours(endHour, 0, 0, 0);
  for (let t = new Date(d); t < end; t = addMinutes(t, stepMinutes)) {
    slots.push(`${pad2(t.getHours())}:${pad2(t.getMinutes())}`);
  }
  return slots;
}
function minutesFromViewStart(date) {
  const start = new Date(date);
  start.setHours(state.viewStartHour, 0, 0, 0);
  return (date - start) / 60000;
}
function dayIndexMon0(date) {
  const jsDay = date.getDay();
  return jsDay === 0 ? 6 : jsDay - 1;
}
function dayOfWeekISO(date) {
  const jsDay = date.getDay();
  return jsDay === 0 ? 7 : jsDay;
}
function dateKey(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}
function monthName(d) {
  const m = d.getMonth();
  const names = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
  return names[m] || "Monat";
}

// -------------------- Eisenhower --------------------
function computeQuadrant(importance, urgency) {
  if (importance && urgency) return { key: "do", label: "Do now", short: "DO", hint: "Sofort erledigen / nächster Slot." };
  if (importance && !urgency) return { key: "plan", label: "Plan", short: "PLAN", hint: "Einplanen und sauber abarbeiten." };
  if (!importance && urgency) return { key: "delegate", label: "Delegate", short: "DELEG", hint: "Auslagern / warten / delegieren." };
  return { key: "eliminate", label: "Later", short: "LATER", hint: "Später / optional / nicht in Kalender." };
}

// -------------------- Month counts --------------------
function buildCountsByDate() {
  const counts = Object.create(null);

  for (const t of (state.tasks || [])) {
    if (!t.scheduledStart || !t.scheduledEnd) continue;
    const d = new Date(t.scheduledStart);
    const k = dateKey(d);
    counts[k] = counts[k] || { tasksScheduled: 0, events: 0 };
    counts[k].tasksScheduled += 1;
  }

  for (const e of (state.events || [])) {
    const d = new Date(e.start);
    if (isNaN(d.getTime())) continue;
    const k = dateKey(d);
    counts[k] = counts[k] || { tasksScheduled: 0, events: 0 };
    counts[k].events += 1;
  }

  return counts;
}

function formatCountLine(c) {
  const tasks = c?.tasksScheduled || 0;
  const evs = c?.events || 0;
  if (!tasks && !evs) return "—";
  if (tasks && evs) return `${tasks} Task(s), ${evs} Event(s)`;
  if (tasks) return `${tasks} Task(s)`;
  return `${evs} Event(s)`;
}

// -------------------- Storage --------------------
function saveLocal(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { } }
function loadLocal(key, fallback) { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } }
function saveDateLocal(key, date) { try { localStorage.setItem(key, new Date(date).toISOString()); } catch { } }
function loadDateLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? fallback : d;
  } catch {
    return fallback;
  }
}
function byId(id) { return document.getElementById(id); }
function pad2(n) { return String(n).padStart(2, "0"); }
function fmtDate(d) { return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`; }
function fmtTime(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function fmtDateTime(d) { return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${fmtTime(d)}`; }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
