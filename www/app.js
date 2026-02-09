const API_BASE = (() => {
  const params = new URLSearchParams(window.location.search || "");
  const override = (params.get("api") || "").toLowerCase();
  if (override === "live") return "https://calendar-api-v2.onrender.com";
  if (override === "local") return "http://localhost:3000";

  const hostname = (window.location.hostname || "").toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return "http://localhost:3000";
  }

  if (hostname.startsWith("192.168.") || hostname.startsWith("10.")) {
    return "http://localhost:3000";
  }

  const octets = hostname.split(".");
  if (octets.length === 4 && octets[0] === "172") {
    const second = Number.parseInt(octets[1], 10);
    if (!Number.isNaN(second) && second >= 16 && second <= 31) {
      return "http://localhost:3000";
    }
  }

  return "https://calendar-api-v2.onrender.com";
})();
const API_BASE_CLEAN = String(API_BASE || "").replace(/\/+$/, "");

const IS_NATIVE =
  !!window.Capacitor &&
  typeof window.Capacitor.getPlatform === "function" &&
  window.Capacitor.getPlatform() !== "web";

if (IS_NATIVE) {
  (async () => {
    try {
      const mod = await import("@capacitor/app");
      const App = mod?.App;
      if (!App?.addListener) return;

      App.addListener("appUrlOpen", async ({ url }) => {
        if (url && url.startsWith("calendar-mvp://oauth")) {
          try {
            await fetch(`${API_BASE_CLEAN}/api/google/status`, {
              credentials: "include"
            });
          } catch {}
          location.reload();
        }
      });
    } catch {
      // ignore in web
    }
  })();
}

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
  } catch {
    // Never recurse in an error handler
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

// ✅ LIVE: fix auf Render (kein localhost / 10.0.2.2)
const API_KEY = localStorage.getItem("calendarApiKeyV1") || ""; // optional

const GCAL_CACHE_KEY = "gcal_last_events_v1";
const GCAL_DAYS_PAST = 365;
const GCAL_DAYS_FUTURE = 365;
const GCAL_POLL_MS = 5 * 60 * 1000; // 5 Minuten (Fallback, falls Push-Sync nicht verfuegbar)
const SYNC_STATUS_POLL_MS = 30 * 1000; // Phase 3 Push-Sync: App fragt Status alle 30s
const WEEK_LOAD_TTL_MS = 2 * 60 * 1000;
const SCROLL_BUFFER_PX = isMobile() ? 220 : 120;
const ENABLE_DAY_SCROLLER_MONTH_SWAP = false;
const DEFAULT_VIEW_START_HOUR = 0;
const DEFAULT_VIEW_END_HOUR = 24;
const DEFAULT_STEP_MINUTES = 30;
const HOUR_HEIGHT_PX = 60;
const DEFAULT_SLOT_PX = Math.round(HOUR_HEIGHT_PX * (DEFAULT_STEP_MINUTES / 60));
const WEEK_STEP_MINUTES = 60;
const WEEK_SLOT_PX = 60;
const DAY_MODE_STORAGE_KEY = "calendarDayModeV1";
const SMART_PREFS_KEY = "smartPrefsV1";
const DEFAULT_SMART_PREFS = {
  title: "Fokuszeit",
  date: "",
  durationMinutes: 60,
  daysForward: 7,
  windowStart: "08:00",
  windowEnd: "18:00",
  preference: "none",
  bufferMinutes: 15,
  maxSuggestions: 5,
};
const DEFAULT_PREFS_UI = {
  windowStart: "08:00",
  windowEnd: "18:00",
  bufferMinutes: 15,
  timeOfDay: "auto",
};
const AI_EXTRACT_ACCEPT = ".png,.jpg,.jpeg,.webp,.pdf,.docx";
const AI_EXTRACT_ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const AI_EXTRACT_ALLOWED_EXT = new Set(["png", "jpg", "jpeg", "webp", "pdf", "docx"]);

async function openExternal(url) {
  if (window.Capacitor?.Plugins?.Browser?.open) {
    await window.Capacitor.Plugins.Browser.open({ url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

let gcalPollTimer = null;
let nowIndicatorTimer = null;
let currentRenderedDays = [];

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
  return apiGet(`/api/get-events?daysPast=${daysPast}&daysFuture=${daysFuture}`);
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
        applyGoogleStatus(g.google || g);
      }

      // Phase 3: Push-Sync -> Server sagt uns, ob sich seit letztem Push etwas geaendert hat
      const sync = await apiGet("/api/sync/status");
      if (!sync?.ok) return;

      if (sync.dirty) {
        setSyncLoading(true);
        try {
          const eventsRes = await apiGetGoogleEvents();
          if (eventsRes?.ok && Array.isArray(eventsRes.events)) {
            state.events = eventsRes.events;
            saveLastKnownGoogleEvents(state.events);
          }
          await render();
          // ACK: dirty zuruecksetzen
          try {
            await apiPost("/api/sync/ack", { lastChangeAt: sync.lastChangeAt || null });
          } catch {}
        } catch (e) {
          console.error("Fehler beim Laden von /api/google/events", e);
        } finally {
          setSyncLoading(false);
        }
      }
    } catch (e) {
      // Fallback: Wenn der Server /api/sync/status nicht kennt, bleiben wir beim alten Polling.
      const msg = String(e?.message || "");
      if (msg.includes("404") || msg.includes("Not Found")) {
        try {
          const g = await apiGet("/api/google/status");
          applyGoogleStatus(g.google || g);
          setSyncLoading(true);
          try {
            const eventsRes = await apiGetGoogleEvents();
            if (eventsRes?.ok && Array.isArray(eventsRes.events)) {
              state.events = eventsRes.events;
              saveLastKnownGoogleEvents(state.events);
            }
            await render();
          } catch (e) {
            console.error("Fehler beim Laden von /api/google/events", e);
            await render();
          } finally {
            setSyncLoading(false);
          }
        } catch {}
      }
    }
  }

  // sofort einmal laufen
  tick();
  gcalPollTimer = setInterval(tick, SYNC_STATUS_POLL_MS);
}


const VALID_VIEWS = new Set(["day", "week", "month"]);
const INITIAL_VIEW = (() => {
  const saved = loadLocal("calendarViewV1", "day");
  const normalized = VALID_VIEWS.has(saved) ? saved : "day";
  return isMobile() ? "day" : normalized;
})();
const INITIAL_DAY_MODE = loadLocal(DAY_MODE_STORAGE_KEY, isMobile() ? "fit" : "scroll");

function setAppReady(ready) {
  document.body.classList.toggle("app-ready", ready);
}

// -------------------- State --------------------
const state = {
  view: INITIAL_VIEW,
  activeDate: loadDateLocal("calendarActiveDateV1", new Date(2013, 7, 27)),
  currentYear: null,
  currentMonth: null,
  selectedDay: null,
  weekStart: startOfWeek(new Date()),
  dayMode: INITIAL_DAY_MODE,

  tasks: [],
  events: [],
  google: { configured: false, connected: false, hasTokens: false, watchActive: false, reason: "", scopes: "" },
  editingEvent: null,
  assistant: {
    originalText: "",
    proposal: null,
    intent: "none",
    questions: [],
    provider: "local",
  },
  selectedEventId: null,
  selectedEventData: null,
  detailEvent: null,
  eventSuggestions: [],
  selectedSuggestionId: null,
  eventSuggestionRequest: null,
  freeSlots: [],
  approvedFreeSlots: [],
  weekLoad: null,
  weekLoadKey: null,
  weekLoadFetchedAt: 0,
  weekLoadLoading: false,
  weekLoadError: null,

  smartPrefs: loadLocal(SMART_PREFS_KEY, DEFAULT_SMART_PREFS),
  smartSuggestions: [],
  smartOptimizations: [],
  smartAppliedPreferences: null,
  smartHabits: null,
  smartSuggestionsLoading: false,
  smartSuggestionsError: null,

  windows: loadLocal("windowsV1", [
    { id: "w1", name: "Fokus", days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00", weight: 3 },
    { id: "w2", name: "Uni", days: [1, 2, 3, 4, 5], start: "14:00", end: "16:00", weight: 2 },
    { id: "w3", name: "Samstag Slot", days: [6], start: "10:00", end: "12:00", weight: 1 },
  ]),

  viewStartHour: DEFAULT_VIEW_START_HOUR,
  viewEndHour: DEFAULT_VIEW_END_HOUR,
  stepMinutes: DEFAULT_STEP_MINUTES,
  slotPx: DEFAULT_SLOT_PX,
  hasAutoScrolled: false,
  isSyncing: false,
  isConnecting: false,

  preferences: null,
  learning: null,
  preferencesError: null,
  preferencesSaving: false,
  preferencesLoadedAt: 0,

  monitoring: null,
  monitoringError: null,
  monitoringLoading: false,
  monitoringFetchedAt: 0,
};

let lastDayScrollerScrollLeft = 0;
let dayScrollerPrevWidth = 0;
let dayScrollerCurWidth = 0;
let dayScrollerIsSwapping = false;
let dayScrollerScrollRaf = null;

const els = {
  weekLabel: byId("weekLabel"),
  statusLine: byId("statusLine"),
  googleConnectionState: byId("googleConnectionState"),
  reconnectHint: byId("reconnectHint"),
  googleStatusBadge: byId("googleStatusBadge"),
  syncStatusBadge: byId("syncStatusBadge"),

  calBody: document.querySelector(".calBody"),
  dayHeaders: byId("dayHeaders"),
  timeCol: byId("timeCol"),
  grid: byId("grid"),
  inboxList: byId("inboxList"),
  plannedList: byId("plannedList"),
  windowsList: byId("windowsList"),
  weekLoadSummary: byId("weekLoadSummary"),
  weekLoadChart: byId("weekLoadChart"),
  weekLoadSuggestions: byId("weekLoadSuggestions"),
  weekLoadBreaks: byId("weekLoadBreaks"),
  smartTitle: byId("smartTitle"),
  smartDate: byId("smartDate"),
  smartDuration: byId("smartDuration"),
  smartDaysForward: byId("smartDaysForward"),
  smartWindowStart: byId("smartWindowStart"),
  smartWindowEnd: byId("smartWindowEnd"),
  smartPreference: byId("smartPreference"),
  smartBuffer: byId("smartBuffer"),
  smartMaxSuggestions: byId("smartMaxSuggestions"),
  smartSuggestBtn: byId("smartSuggestBtn"),
  smartPreferenceSummary: byId("smartPreferenceSummary"),
  smartSuggestionList: byId("smartSuggestionList"),
  smartOptimizationList: byId("smartOptimizationList"),

  aiExtractInput: byId("aiExtractInput"),
  aiExtractDrop: byId("aiExtractDrop"),
  aiExtractStatus: byId("aiExtractStatus"),
  aiExtractError: byId("aiExtractError"),
  aiExtractResults: byId("aiExtractResults"),
  aiExtractWarnings: byId("aiExtractWarnings"),

  prefWindowStart: byId("prefWindowStart"),
  prefWindowEnd: byId("prefWindowEnd"),
  prefBufferMinutes: byId("prefBufferMinutes"),
  prefTimeOfDay: byId("prefTimeOfDay"),
  prefSaveBtn: byId("prefSaveBtn"),
  prefStatus: byId("prefStatus"),
  prefLearningSummary: byId("prefLearningSummary"),
  prefLearningDetails: byId("prefLearningDetails"),

  monitoringStatus: byId("monitoringStatus"),
  monitoringList: byId("monitoringList"),
  monitoringIssues: byId("monitoringIssues"),

  dayScroller: byId("dayScroller"),
  dayEventList: byId("dayEventList"),
  dayEventDetailBackdrop: byId("dayEventDetailBackdrop"),
  dayEventDetailPopup: byId("dayEventDetailPopup"),
  dayEventDetailTitle: byId("dayEventDetailTitle"),
  dayEventDetailDate: byId("dayEventDetailDate"),
  dayEventDetailTime: byId("dayEventDetailTime"),
  dayEventDetailLocation: byId("dayEventDetailLocation"),
  dayEventDetailDescription: byId("dayEventDetailDescription"),
  closeDayEventDetailBtn: byId("closeDayEventDetailBtn"),

  prevWeekBtn: byId("prevWeekBtn"),
  todayBtn: byId("todayBtn"),
  nextWeekBtn: byId("nextWeekBtn"),
  prevMonthBtn: byId("prevMonthBtn"),
  monthNameBtn: byId("monthNameBtn"),
  nextMonthBtn: byId("nextMonthBtn"),

  btnNew: byId("btnNew"),
  sidebar: byId("sidebar"),
  sidebarOverlay: byId("sidebarOverlay"),

  // ✅ Google UI (wird dynamisch in die Topbar eingefügt)
  googleConnectBtn: null,
  googleDisconnectBtn: null,
  googleConnectBtns: [],
  googleDisconnectBtns: [],

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

  // Create event form
  eventTitle: byId("eventTitle"),
  eventDate: byId("eventDate"),
  eventStartTime: byId("eventStartTime"),
  eventDuration: byId("eventDuration"),
  eventLocation: byId("eventLocation"),
  eventNotes: byId("eventNotes"),
  createEventFormBtn: byId("createEventFormBtn"),

  // Free slots (Phase 3)
  freeSlotTitle: byId("freeSlotTitle"),
  freeSlotDate: byId("freeSlotDate"),
  freeSlotDuration: byId("freeSlotDuration"),
  freeSlotDaysForward: byId("freeSlotDaysForward"),
  freeSlotFindBtn: byId("freeSlotFindBtn"),
  freeSlotList: byId("freeSlotList"),
  approvedSlotList: byId("approvedSlotList"),

  // Event modal
  eventBackdrop: byId("eventBackdrop"),
  eventModal: byId("eventModal"),
  closeEventBtn: byId("closeEventBtn"),
  eventText: byId("eventText"),
  createEventBtn: byId("createEventBtn"),
  assistantClarify: byId("assistantClarify"),
  assistantQuestionList: byId("assistantQuestionList"),
  assistantAnswer: byId("assistantAnswer"),
  assistantAnswerBtn: byId("assistantAnswerBtn"),
  assistantPreview: byId("assistantPreview"),
  assistantPreviewTitle: byId("assistantPreviewTitle"),
  assistantPreviewTime: byId("assistantPreviewTime"),
  assistantPreviewLocationRow: byId("assistantPreviewLocationRow"),
  assistantPreviewLocation: byId("assistantPreviewLocation"),
  assistantPreviewDescriptionRow: byId("assistantPreviewDescriptionRow"),
  assistantPreviewDescription: byId("assistantPreviewDescription"),
  assistantCreateBtn: byId("assistantCreateBtn"),
  assistantEditBtn: byId("assistantEditBtn"),
  assistantNone: byId("assistantNone"),

  // Suggestion modal
  suggestionBackdrop: byId("suggestionBackdrop"),
  suggestionModal: byId("suggestionModal"),
  closeSuggestionBtn: byId("closeSuggestionBtn"),
  suggestionList: byId("suggestionList"),
  suggestionCancelBtn: byId("suggestionCancelBtn"),
  suggestionConfirmBtn: byId("suggestionConfirmBtn"),

  // Edit event modal
  editEventBackdrop: byId("editEventBackdrop"),
  editEventModal: byId("editEventModal"),
  closeEditEventBtn: byId("closeEditEventBtn"),
  cancelEditEventBtn: byId("cancelEditEventBtn"),
  saveEditEventBtn: byId("saveEditEventBtn"),
  editEventTitle: byId("editEventTitle"),
  editEventDate: byId("editEventDate"),
  editEventStartTime: byId("editEventStartTime"),
  editEventDuration: byId("editEventDuration"),
  editEventLocation: byId("editEventLocation"),
  editEventNotes: byId("editEventNotes"),

  // Event detail modal
  eventDetailBackdrop: byId("eventDetailBackdrop"),
  eventDetailModal: byId("eventDetailModal"),
  closeEventDetailBtn: byId("closeEventDetailBtn"),
  eventDetailCloseBtn: byId("eventDetailCloseBtn"),
  eventDetailDeleteBtn: byId("eventDetailDeleteBtn"),
  eventDetailTitle: byId("eventDetailTitle"),
  eventDetailDate: byId("eventDetailDate"),
  eventDetailStart: byId("eventDetailStart"),
  eventDetailEnd: byId("eventDetailEnd"),
  eventDetailDuration: byId("eventDetailDuration"),
  eventDetailNotesRow: byId("eventDetailNotesRow"),
  eventDetailNotes: byId("eventDetailNotes"),

  eventsList: byId("eventsList"),

  selectedEventCard: byId("selectedEventCard"),
  selectedEventMeta: byId("selectedEventMeta"),
  selectedEventTitle: byId("selectedEventTitle"),
  selectedEventDate: byId("selectedEventDate"),
  selectedEventTime: byId("selectedEventTime"),
  selectedEventDuration: byId("selectedEventDuration"),
  selectedEventNotesRow: byId("selectedEventNotesRow"),
  selectedEventNotes: byId("selectedEventNotes"),
  selectedEventDeleteBtn: byId("selectedEventDeleteBtn"),
};

function warnDuplicateIds(ids) {
  ids.forEach((id) => {
    const matches = document.querySelectorAll(`#${id}`);
    if (matches.length > 1) {
      console.warn(`[ui] Duplicate id "${id}" detected (${matches.length}).`);
    }
  });
}

function bindButtonsById(id, handler) {
  const buttons = Array.from(document.querySelectorAll(`#${id}`));
  if (buttons.length > 1) {
    console.warn(`[ui] Duplicate id "${id}" detected (${buttons.length}).`);
  }
  buttons.forEach(btn => btn.addEventListener("click", handler));
  return buttons;
}

function bindViewportResize() {
  let resizeTimer = null;
  const handleResize = () => {
    if (!isMobile() || state.view !== "day") return;
    if (state.dayMode === "fit") {
      state.slotPx = computeSlotPxToFitDay();
    } else {
      state.slotPx = DEFAULT_SLOT_PX;
    }
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      void render();
    }, 120);
  };
  window.addEventListener("resize", handleResize);
  window.addEventListener("orientationchange", handleResize);
}

function initAiExtractUI() {
  if (!els.aiExtractInput || !els.aiExtractDrop) return;

  els.aiExtractInput.accept = AI_EXTRACT_ACCEPT;
  els.aiExtractDrop.style.borderStyle = "dashed";
  els.aiExtractDrop.style.cursor = "pointer";

  const setDropActive = (active) => {
    if (!els.aiExtractDrop) return;
    els.aiExtractDrop.style.borderColor = active ? "rgba(91,140,255,.6)" : "";
    els.aiExtractDrop.style.background = active ? "rgba(91,140,255,.08)" : "";
  };

  const handleFiles = (files) => {
    if (!files?.length) return;
    void handleAiExtractFile(files[0]);
  };

  els.aiExtractInput.addEventListener("change", (event) => {
    handleFiles(event.target.files);
  });

  els.aiExtractDrop.addEventListener("click", () => {
    els.aiExtractInput?.click();
  });

  els.aiExtractDrop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      els.aiExtractInput?.click();
    }
  });

  els.aiExtractDrop.addEventListener("dragover", (event) => {
    event.preventDefault();
    setDropActive(true);
  });

  els.aiExtractDrop.addEventListener("dragleave", (event) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setDropActive(false);
  });

  els.aiExtractDrop.addEventListener("drop", (event) => {
    event.preventDefault();
    setDropActive(false);
    handleFiles(event.dataTransfer?.files);
  });

  clearAiExtractResults();
  clearAiExtractWarnings();
  setAiExtractStatus("");
  setAiExtractError("");
}

function clearAiExtractResults() {
  if (els.aiExtractResults) {
    els.aiExtractResults.innerHTML = "";
  }
}

function clearAiExtractWarnings() {
  if (els.aiExtractWarnings) {
    els.aiExtractWarnings.innerHTML = "";
  }
}

function setAiExtractStatus(message) {
  if (!els.aiExtractStatus) return;
  els.aiExtractStatus.textContent = message || "";
  els.aiExtractStatus.style.color = "";
}

function setAiExtractError(message) {
  if (!els.aiExtractError) return;
  els.aiExtractError.textContent = message || "";
  els.aiExtractError.style.color = message ? "rgba(255,120,120,.95)" : "";
}

function setAiExtractLoading(isLoading) {
  if (els.aiExtractInput) {
    els.aiExtractInput.disabled = isLoading;
  }
  if (els.aiExtractDrop) {
    els.aiExtractDrop.setAttribute("aria-busy", String(isLoading));
    els.aiExtractDrop.style.opacity = isLoading ? "0.6" : "";
  }
}

function isAiExtractAllowedFile(file) {
  if (!file) return false;
  if (AI_EXTRACT_ALLOWED_MIME.has(file.type)) return true;
  const ext = String(file.name || "").split(".").pop()?.toLowerCase();
  return AI_EXTRACT_ALLOWED_EXT.has(ext);
}

async function handleAiExtractFile(file) {
  if (!file) return;
  if (!isAiExtractAllowedFile(file)) {
    setAiExtractError("Dateityp nicht unterstützt. Bitte PNG/JPG/WebP, PDF oder DOCX wählen.");
    return;
  }

  setAiExtractLoading(true);
  setAiExtractError("");
  setAiExtractStatus(`Lade "${file.name}" hoch…`);
  clearAiExtractResults();
  clearAiExtractWarnings();

  try {
    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch(`${API_BASE_CLEAN}/api/ai/extract`, {
      method: "POST",
      body: formData,
    });

    const text = await res.text();
    const body = parseApiBody(text);
    const data = body.kind === "json" ? body.json : null;

    if (!res.ok || !data?.ok) {
      const message = data?.message || data?.error || res.statusText || "Extraktion fehlgeschlagen.";
      throw new Error(message);
    }

    renderAiExtractResults(data);
    renderAiExtractWarnings(data?.warnings);

    const sourceBits = [];
    if (data?.source?.mime) sourceBits.push(data.source.mime);
    if (Number.isFinite(data?.source?.pages)) {
      sourceBits.push(`${data.source.pages} Seite(n)`);
    }

    setAiExtractStatus(sourceBits.length ? `Quelle: ${sourceBits.join(" • ")}` : "Extraktion abgeschlossen.");
  } catch (error) {
    setAiExtractStatus("");
    setAiExtractError(`Fehler: ${error?.message || "Extraktion fehlgeschlagen."}`);
  } finally {
    setAiExtractLoading(false);
    if (els.aiExtractInput) els.aiExtractInput.value = "";
  }
}

function renderAiExtractResults(payload) {
  if (!els.aiExtractResults) return;
  const events = Array.isArray(payload?.proposals?.events) ? payload.proposals.events : [];
  const tasks = Array.isArray(payload?.proposals?.tasks) ? payload.proposals.tasks : [];

  els.aiExtractResults.innerHTML = "";

  if (!events.length && !tasks.length) {
    const empty = document.createElement("div");
    empty.className = "item";
    empty.textContent = "Keine Vorschläge gefunden.";
    els.aiExtractResults.appendChild(empty);
    return;
  }

  appendAiExtractGroup("Events", events, (event) =>
    pickAiExtractValue(event?.date, event?.startDate, event?.start, event?.startTime, event?.when)
  );
  appendAiExtractGroup("Tasks", tasks, (task) =>
    pickAiExtractValue(task?.due, task?.dueDate, task?.deadline, task?.date)
  );
}

function appendAiExtractGroup(label, items, getDateLabel) {
  if (!els.aiExtractResults) return;
  const heading = document.createElement("div");
  heading.className = "cardSub";
  heading.textContent = `${label} (${items.length})`;
  els.aiExtractResults.appendChild(heading);

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "item";
    empty.textContent = `Keine ${label.toLowerCase()} gefunden.`;
    els.aiExtractResults.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const title = pickAiExtractValue(item?.title, item?.summary, item?.name, item?.task, "Ohne Titel");
    const dateLabel = getDateLabel ? getDateLabel(item) : "";
    const confidence = formatAiExtractConfidence(item?.confidence ?? item?.score);
    const metaParts = [label.slice(0, -1)];
    if (dateLabel) metaParts.push(dateLabel);
    if (confidence) metaParts.push(`Confidence ${confidence}`);

    const entry = document.createElement("div");
    entry.className = "item";

    const top = document.createElement("div");
    top.className = "itemTop";

    const titleEl = document.createElement("div");
    titleEl.className = "itemTitle";
    titleEl.textContent = title;

    top.appendChild(titleEl);

    const meta = document.createElement("div");
    meta.className = "itemMeta";
    meta.textContent = metaParts.filter(Boolean).join(" • ");

    entry.appendChild(top);
    entry.appendChild(meta);
    els.aiExtractResults.appendChild(entry);
  });
}

function renderAiExtractWarnings(warnings) {
  if (!els.aiExtractWarnings) return;
  els.aiExtractWarnings.innerHTML = "";
  const list = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
  if (!list.length) return;

  list.forEach((warning) => {
    const item = document.createElement("div");
    item.className = "item";
    const message = typeof warning === "string" ? warning : warning?.message;
    item.textContent = message ? String(message) : JSON.stringify(warning);
    els.aiExtractWarnings.appendChild(item);
  });
}

function pickAiExtractValue(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Number.isFinite(value)) return String(value);
    if (value) return String(value);
  }
  return "";
}

function formatAiExtractConfidence(value) {
  if (!Number.isFinite(value)) return "";
  const numeric = Number(value);
  const percent = numeric <= 1 ? numeric * 100 : numeric;
  return `${Math.round(percent)}%`;
}

const deletingEvents = new Set();
let activeEventDrag = null;
let pendingUndoToast = null;

boot();

// -------------------- Boot --------------------
async function boot() {
  setAppReady(false);
  setBodyViewClass(state.view);
  setActiveDate(state.activeDate);

  warnDuplicateIds([
    "prevWeekBtn",
    "todayBtn",
    "nextWeekBtn",
    "prevMonthBtn",
    "monthNameBtn",
    "nextMonthBtn",
    "btnNew",
    "googleConnectBtn",
    "googleDisconnectBtn",
  ]);

  // Nav (view-aware)
  const handlePrevDay = async () => {
    if (state.view === "month") return;
    shiftView(-1);
    await render();
  };
  const handleNextDay = async () => {
    if (state.view === "month") return;
    shiftView(1);
    await render();
  };
  const handleToday = async () => {
    setActiveDate(new Date());
    saveDateLocal("calendarActiveDateV1", state.activeDate);
    await render();
  };

  bindButtonsById("prevWeekBtn", handlePrevDay);
  bindButtonsById("nextWeekBtn", handleNextDay);
  bindButtonsById("prevDayBtnMobile", handlePrevDay);
  bindButtonsById("nextDayBtnMobile", handleNextDay);
  bindButtonsById("prevMonthBtn", async () => { await changeMonth("prev"); });
  bindButtonsById("nextMonthBtn", async () => { await changeMonth("next"); });
  bindButtonsById("monthNameBtn", async () => { await changeMonth("next"); });
  bindButtonsById("todayBtn", handleToday);
  bindButtonsById("todayBtnMobile", handleToday);

  // New menu
  bindButtonsById("btnNew", handleNewButtonClick);
  els.closeMenuBtn?.addEventListener("click", closeMenu);
  els.menuBackdrop?.addEventListener("click", closeMenu);

  els.sidebarOverlay?.addEventListener("click", closeSidebarDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSidebarDrawer();
      closeEventDetailModal();
      closeDayEventDetailModal();
      closeSuggestionModal();
    }
  });

  els.dayScroller?.addEventListener("scroll", handleDayScrollerScroll, { passive: true });

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

  els.closeDayEventDetailBtn?.addEventListener("click", closeDayEventDetailModal);
  els.dayEventDetailBackdrop?.addEventListener("click", closeDayEventDetailModal);

  // Create event form
  els.createEventFormBtn?.addEventListener("click", createEventFromForm);

  // Free slots (Phase 3)
  ensureFreeSlotDefaults();
  els.freeSlotFindBtn?.addEventListener("click", loadFreeSlots);

  // AI Extract (Phase 3 Minimal UI)
  initAiExtractUI();

  // Smart suggestions (Phase 5)
  applySmartPrefsToInputs();
  const smartInputs = [
    els.smartTitle,
    els.smartDate,
    els.smartDuration,
    els.smartDaysForward,
    els.smartWindowStart,
    els.smartWindowEnd,
    els.smartPreference,
    els.smartBuffer,
    els.smartMaxSuggestions,
  ].filter(Boolean);
  smartInputs.forEach((input) => {
    input.addEventListener("change", saveSmartPrefsFromInputs);
    input.addEventListener("input", saveSmartPrefsFromInputs);
  });
  els.smartSuggestBtn?.addEventListener("click", loadSmartSuggestions);

  // Preferences (Phase 8)
  const prefInputs = [
    els.prefWindowStart,
    els.prefWindowEnd,
    els.prefBufferMinutes,
    els.prefTimeOfDay,
  ].filter(Boolean);
  prefInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (!state.preferencesSaving) renderPreferences();
    });
  });
  els.prefSaveBtn?.addEventListener("click", savePreferencesFromInputs);

  // Event modal
  els.closeEventBtn?.addEventListener("click", closeEventModal);
  els.eventBackdrop?.addEventListener("click", closeEventModal);
  els.createEventBtn?.addEventListener("click", createEventFromText);
  els.assistantAnswerBtn?.addEventListener("click", submitAssistantAnswer);
  els.assistantCreateBtn?.addEventListener("click", commitAssistantProposal);
  els.assistantEditBtn?.addEventListener("click", openAssistantEditModal);
  els.eventText?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      els.createEventBtn?.click();
    }
  });
  els.assistantAnswer?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      els.assistantAnswerBtn?.click();
    }
  });

  // Suggestion modal
  els.closeSuggestionBtn?.addEventListener("click", closeSuggestionModal);
  els.suggestionBackdrop?.addEventListener("click", closeSuggestionModal);
  els.suggestionCancelBtn?.addEventListener("click", closeSuggestionModal);
  els.suggestionConfirmBtn?.addEventListener("click", confirmSuggestedEvent);

  // Edit event modal
  els.closeEditEventBtn?.addEventListener("click", closeEditEventModal);
  els.cancelEditEventBtn?.addEventListener("click", closeEditEventModal);
  els.editEventBackdrop?.addEventListener("click", closeEditEventModal);
  els.saveEditEventBtn?.addEventListener("click", saveEditEvent);

  // Event detail modal
  els.closeEventDetailBtn?.addEventListener("click", closeEventDetailModal);
  els.eventDetailCloseBtn?.addEventListener("click", closeEventDetailModal);
  els.eventDetailBackdrop?.addEventListener("click", closeEventDetailModal);
  els.eventDetailDeleteBtn?.addEventListener("click", async () => {
    if (!state.detailEvent) return;
    await deleteEvent(state.detailEvent);
    closeEventDetailModal();
  });

  els.selectedEventDeleteBtn?.addEventListener("click", async () => {
    const ev = getSelectedEvent();
    if (!ev) return;
    await deleteEvent(ev);
  });

  els.grid?.addEventListener("click", (event) => {
    if (event.target.closest(".eventBlock")) return;
    if (event.target.closest(".taskBlock")) return;
    clearSelectedEvent();
  });

  if (isMobile() && state.view !== "day") {
    setView("day");
  }

  bindGoogleButtons();
  bindViewportResize();
  window.addEventListener("resize", () => {
    requestAnimationFrame(updateCalendarScrollbarGutter);
  });
  try {
    await refreshFromApi();
    startGooglePollingOnce();
    await render();
  } finally {
    setAppReady(true);
  }
}

// -------------------- Google UI --------------------
function bindGoogleButtons() {
  // Prefer existing buttons from index.html
  els.googleConnectBtns = Array.from(document.querySelectorAll('#googleConnectBtn'));
  els.googleDisconnectBtns = Array.from(document.querySelectorAll('#googleDisconnectBtn'));
  if (els.googleConnectBtns.length > 1) {
    console.warn(`[ui] Duplicate id "googleConnectBtn" detected (${els.googleConnectBtns.length}).`);
  }
  if (els.googleDisconnectBtns.length > 1) {
    console.warn(`[ui] Duplicate id "googleDisconnectBtn" detected (${els.googleDisconnectBtns.length}).`);
  }

  els.googleConnectBtn = els.googleConnectBtns[0] || null;
  els.googleDisconnectBtn = els.googleDisconnectBtns[0] || null;

  els.googleConnectBtns.forEach(btn => btn.addEventListener('click', onGoogleConnect));
  els.googleDisconnectBtns.forEach(btn => btn.addEventListener('click', onGoogleDisconnect));

  updateGoogleButtons();
}

function updateGoogleButtons() {
  const g = state.google || {};
  const connected = !!g.connected;
  const configured = !!g.configured;
  const wrong = !!g.wrongAccount;

  els.googleConnectBtns.forEach(btn => {
    btn.disabled = !configured;
    btn.title = configured ? '' : 'Backend: Google OAuth ist nicht konfiguriert (ENV Vars fehlen)';
    // If wrong account: keep connect visible so user can reconnect
    btn.style.display = connected && !wrong ? 'none' : '';
  });

  els.googleDisconnectBtns.forEach(btn => {
    // Disconnect is optional (server may require API key)
    btn.style.display = connected ? '' : 'none';
  });
}

function normalizeGoogleStatus(raw) {
  const g = raw || {};
  return {
    configured: !!g.configured,
    connected: !!g.connected,
    hasTokens: g.hasTokens ?? !!g.connected,
    authenticated: g.authenticated ?? !!g.connected,
    hasRefreshToken: g.hasRefreshToken ?? !!g.connected,
    tokenStorage: g.tokenStorage || null,
    dbConfigured: typeof g.dbConfigured === "boolean" ? g.dbConfigured : true,
    expiresAt: g.expiresAt || null,
    watchActive: typeof g.watchActive === "boolean" ? g.watchActive : false,
    reason: g.reason || "",
    scopes: g.scopes || "",
    allowDisconnect: typeof g.allowDisconnect === "boolean" ? g.allowDisconnect : false,
    calendarId: g.calendarId,
    timezone: g.timezone,
    connectedEmail: g.connectedEmail,
    allowedEmail: g.allowedEmail,
    wrongAccount: !!g.wrongAccount,
  };
}

function applyGoogleStatus(raw) {
  state.google = normalizeGoogleStatus(raw);
  updateGoogleButtons();
  updateConnectionStatus();
}

function updateConnectionStatus() {
  const g = state.google || {};
  const connected = !!g.connected;
  const configured = !!g.configured;

  if (els.googleConnectionState) {
    let text = "Nicht verbunden";
    let color = "var(--danger)";

    if (!configured) {
      text = "Google nicht konfiguriert";
      color = "var(--muted)";
    } else if (connected) {
      text = "Google verbunden";
      color = "var(--ok)";
    }

    els.googleConnectionState.textContent = text;
    els.googleConnectionState.style.color = color;
  }

  if (els.reconnectHint) {
    let hint = "";
    if (!connected) {
      hint = "Bitte Google verbinden, um Events zu erstellen und Live-Sync zu aktivieren.";
    }
    els.reconnectHint.textContent = hint;
  }

  if (els.googleStatusBadge) {
    if (!configured) {
      els.googleStatusBadge.textContent = "Google: nicht konfiguriert";
      els.googleStatusBadge.className = "statusBadge warn";
    } else if (connected) {
      els.googleStatusBadge.textContent = "Google: verbunden";
      els.googleStatusBadge.className = "statusBadge ok";
    } else {
      els.googleStatusBadge.textContent = "Google: nicht verbunden";
      els.googleStatusBadge.className = "statusBadge warn";
    }
  }

  if (els.syncStatusBadge) {
    if (!configured || !connected) {
      els.syncStatusBadge.textContent = "Live-Sync: inaktiv";
      els.syncStatusBadge.className = "statusBadge live-sync-status inactive";
    } else if (g.watchActive) {
      els.syncStatusBadge.textContent = "Live-Sync: aktiv";
      els.syncStatusBadge.className = "statusBadge live-sync-status active";
    } else {
      els.syncStatusBadge.textContent = "Live-Sync: inaktiv";
      els.syncStatusBadge.className = "statusBadge live-sync-status inactive";
    }
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
      applyGoogleStatus(g.google || g);
      updateGoogleButtons();

      if (state.google?.wrongAccount) {
        return { connected: false, wrongAccount: true };
      }

      if (state.google?.connected) {
        return { connected: true, wrongAccount: false };
      }
    } catch {
      // ignore while polling
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { connected: false, wrongAccount: false };
}

async function onGoogleConnect() {
  const disclosureText = "Die App greift auf deinen Google Kalender zu, um Termine anzuzeigen und zu erstellen.";
  const confirmed = window.confirm(`${disclosureText}\n\nMöchtest du fortfahren?`);
  if (!confirmed) {
    uiNotify("error", "Login abgebrochen");
    setStatus("Login abgebrochen.", false);
    return;
  }

  const btn = els.googleConnectBtn;
  const oldText = btn?.textContent || "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Verbinde…";
    btn.setAttribute("aria-busy", "true");
  }
  state.isConnecting = true;
  uiNotify("info", "Lädt…");
  setStatus("Lädt… Verbindung zu Google wird aufgebaut.", true);
  try {
    const authUrl = IS_NATIVE ? "/api/google/auth-url?platform=android" : "/api/google/auth-url";
    const out = await apiGet(authUrl);
    const url = out?.url;
    if (!url) throw new Error('auth-url missing');

    // Open OAuth in a new tab/window
    await openExternal(url);

    uiNotify('success', 'Google Login geöffnet – nach erfolgreichem Login verbindet die App automatisch…');
    setStatus('Google Login geöffnet… warte auf Verbindung…', true);

    const result = await pollGoogleConnected();
    if (result.connected) {
      uiNotify('success', 'Google verbunden ✅');
      await refreshFromApi();
      await render();
    } else if (result.wrongAccount) {
      uiNotify('error', 'Falscher Google-Account');
      setStatus('Falscher Google-Account – bitte mit dem erlaubten Konto anmelden.', false);
    } else {
      uiNotify('error', 'Login abgebrochen');
      setStatus('Login abgebrochen oder nicht abgeschlossen.', false);
    }
  } catch (e) {
    const message = e?.message || String(e);
    const status = e?._meta?.status || 0;
    const lower = String(message).toLowerCase();
    if (status === 400 && (lower.includes("redirect") || lower.includes("redirect_uri_mismatch"))) {
      uiNotify(
        "error",
        "Google OAuth Redirect URI mismatch. Open /api/google/debug-oauth and add computedRedirectUri to Google Console Authorized redirect URIs."
      );
    } else if (lower.includes("access_denied") || status === 403) {
      uiNotify('error', 'Keine Berechtigung');
      setStatus('Keine Berechtigung – Zugriff auf Google Kalender wurde verweigert.', false);
    } else {
      uiNotify('error', 'Google verbinden fehlgeschlagen: ' + message);
    }
  } finally {
    state.isConnecting = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText;
      btn.removeAttribute("aria-busy");
    }
  }
}

async function onGoogleDisconnect() {
  try {
    if (!API_KEY && !state.google?.allowDisconnect) {
      uiNotify('error', 'Trennen ist gesperrt (API-Key fehlt oder nicht erlaubt).');
      return;
    }

    await apiPost('/api/google/disconnect', {});
    markGoogleDisconnected("Manuell getrennt");
    await refreshFromApi();
    await render();
    uiNotify('success', 'Google getrennt ✅');
  } catch (e) {
    uiNotify('error', 'Trennen fehlgeschlagen: ' + (e?.message || String(e)));
  }
}

// -------------------- Helpers --------------------
function isMobile() {
  return window.matchMedia?.("(max-width: 768px)").matches ?? window.innerWidth <= 768;
}

function setStatus(msg, ok = true) {
  if (!els.statusLine) return;
  els.statusLine.textContent = msg || '';
  els.statusLine.style.color = ok ? '' : 'var(--danger)';
}

function setSyncLoading(active, context = "Events synchronisieren…") {
  state.isSyncing = active;
  if (active) {
    setStatus(`${context} • ${googleUiStatusLine()}`, true);
  } else if (els.statusLine?.textContent?.includes("synchronisieren")) {
    setStatus(`API: verbunden ✅ (${API_BASE}) • ${googleUiStatusLine()}`, !state.google?.wrongAccount);
  }

  if (els.syncStatusBadge) {
    if (active) {
      els.syncStatusBadge.textContent = "Sync läuft…";
      els.syncStatusBadge.className = "statusBadge warn";
    } else {
      updateConnectionStatus();
    }
  }
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

async function loadPreferences({ force = false } = {}) {
  const now = Date.now();
  if (!force && state.preferencesLoadedAt && now - state.preferencesLoadedAt < 60 * 1000) return;
  try {
    const res = await apiGet("/api/preferences");
    if (res?.ok) {
      state.preferences = res.preferences || state.preferences;
      state.learning = res.learning || state.learning;
      state.preferencesError = null;
      state.preferencesLoadedAt = Date.now();
      applyPreferencesToInputs();
      renderPreferences();
    } else {
      throw new Error(res?.message || "Präferenzen konnten nicht geladen werden");
    }
  } catch (e) {
    state.preferencesError = String(e?.message || "Präferenzen konnten nicht geladen werden");
    renderPreferences();
  }
}

async function refreshMonitoring({ force = false } = {}) {
  const now = Date.now();
  if (!force && state.monitoringFetchedAt && now - state.monitoringFetchedAt < 60 * 1000) return;
  state.monitoringLoading = true;
  renderMonitoring();
  try {
    const res = await apiGet("/api/monitoring");
    if (res?.ok) {
      state.monitoring = res.monitoring || null;
      state.monitoringError = null;
      state.monitoringFetchedAt = Date.now();
    } else {
      throw new Error(res?.message || "Monitoring nicht verfügbar");
    }
  } catch (e) {
    state.monitoringError = String(e?.message || "Monitoring nicht verfügbar");
  } finally {
    state.monitoringLoading = false;
    renderMonitoring();
  }
}

// -------------------- API refresh --------------------
async function refreshFromApi() {
  let hadNetworkFailure = false;
  let hadApiFailure = false;
  const cachedEvents = loadLastKnownGoogleEvents();
  const existingEvents = Array.isArray(state.events) ? state.events : [];
  let usedCachedEvents = false;
  let googleEventsNotice = "";

  try {
    await apiGet("/api/health");
  } catch (e) {
    if (isNetworkFetchFail(e)) {
      hadNetworkFailure = true;
    } else {
      hadApiFailure = true;
    }
  }

  try {
    const g = await apiGet("/api/google/status");
    applyGoogleStatus(g.google || g);
  } catch (e) {
    if (isNetworkFetchFail(e)) {
      hadNetworkFailure = true;
    } else {
      hadApiFailure = true;
    }
  }

  try {
    const tasksRes = await apiGet("/api/tasks");
    state.tasks = tasksRes.tasks || [];
  } catch (e) {
    console.error("Fehler beim Laden von /api/tasks", e);
    if (isNetworkFetchFail(e)) {
      hadNetworkFailure = true;
    } else {
      hadApiFailure = true;
    }
  }

  try {
    const approvedRes = await apiGet("/api/free-slots/approved");
    if (approvedRes?.ok && Array.isArray(approvedRes.approvedSlots)) {
      state.approvedFreeSlots = approvedRes.approvedSlots;
    }
  } catch (e) {
    if (isNetworkFetchFail(e)) {
      hadNetworkFailure = true;
    } else {
      hadApiFailure = true;
    }
  }

  // Phase 2 Sync: Anzeige basiert ausschließlich auf Google-Events (Single Source of Truth)
  setSyncLoading(true);
  try {
    let eventsRes = null;
    try {
      eventsRes = await apiGetGoogleEvents();
    } catch (e) {
      console.error("Fehler beim Laden von /api/google/events", e);
      uiNotify("error", "Google-Events konnten nicht geladen werden – zeige letzte gespeicherte Daten (Cache).");
      googleEventsNotice = "Google-Events konnten nicht geladen werden – zeige letzte gespeicherte Daten (Cache).";
      if (Array.isArray(cachedEvents)) {
        state.events = cachedEvents;
        usedCachedEvents = true;
      }
      throw e;
    }

    if (eventsRes?.ok === true && Array.isArray(eventsRes.events)) {
      state.events = eventsRes.events;
      saveLastKnownGoogleEvents(state.events);
    } else {
      uiNotify("error", "Google-Events konnten nicht geladen werden – zeige letzte gespeicherte Daten (Cache).");
      googleEventsNotice = "Google-Events konnten nicht geladen werden – zeige letzte gespeicherte Daten (Cache).";
      if (Array.isArray(cachedEvents)) {
        state.events = cachedEvents;
        usedCachedEvents = true;
      }
    }
  } catch (e) {
    if (!usedCachedEvents) {
      state.events = existingEvents;
    }
  } finally {
    if (!Array.isArray(state.events)) {
      state.events = existingEvents;
    }
    setSyncLoading(false);
  }

  if (state.google?.connected === false && Array.isArray(cachedEvents)) {
    state.events = cachedEvents;
    usedCachedEvents = true;
    googleEventsNotice = "Nicht verbunden – zeige letzte Daten (Cache).";
  }

  await Promise.allSettled([
    loadPreferences(),
    refreshMonitoring(),
  ]);

  updateGoogleButtons();
  updateConnectionStatus();

  if (googleEventsNotice) {
    setStatus(googleEventsNotice, false);
  } else if (hadNetworkFailure) {
    setStatus(`Offline 📴 (${API_BASE}) • ${googleStatusText()}`, true);
  } else if (hadApiFailure) {
    setStatus(`API Problem ⚠️ (${API_BASE}) • ${googleStatusText()}`, true);
  } else {
    setStatus(`API: verbunden ✅ (${API_BASE}) • ${googleUiStatusLine()}`, !state.google?.wrongAccount);
  }

  await render();
}

// -------------------- Render --------------------
function setBodyViewClass(view) {
  document.body.classList.toggle("view-day", view === "day");
  document.body.classList.toggle("view-week", view === "week");
  document.body.classList.toggle("view-month", view === "month");
}

async function render() {
  saveLocal("calendarViewV1", state.view);
  saveDateLocal("calendarActiveDateV1", state.activeDate);
  setBodyViewClass(state.view);
  if (state.currentYear === null || state.currentMonth === null || state.selectedDay === null) {
    setActiveDate(state.activeDate);
  }
  if (state.selectedDay > daysInMonth(state.currentYear, state.currentMonth)) {
    const shifted = resolveMonthShift(state.currentYear, state.currentMonth, 1);
    setDaySelection(shifted.year, shifted.month, state.selectedDay);
  }

  renderTopBar();

  if (state.view === "day") {
    renderDayView();
    renderDayAgenda();
  } else if (state.view === "week") {
    renderWeekView();
  } else {
    renderMonthView();
  }

  renderSideLists();
  renderWindows();
  refreshWeeklyLoad();
  renderSmartSuggestions();
  renderSmartOptimizations();
  renderPreferences();
  renderMonitoring();
  saveLocal("windowsV1", state.windows);

  syncSelectedEvent();
  renderSelectedEventDetails();
  updateEventSelectionStyles();

  updateGoogleButtons();
  updateConnectionStatus();

  if (els.statusLine?.textContent?.includes("API verbunden")) {
    setStatus(`API: verbunden ✅ (${API_BASE}) • ${googleUiStatusLine()}`, !state.google?.wrongAccount);
  }

  requestAnimationFrame(updateCalendarScrollbarGutter);
}

// -------------------- View handling --------------------
function setActiveDate(date) {
  const next = new Date(date);
  state.activeDate = next;
  state.currentYear = next.getFullYear();
  state.currentMonth = next.getMonth();
  state.selectedDay = next.getDate();
  state.weekStart = startOfWeek(next);
}

function setDaySelection(year, month, day) {
  const safeDay = Math.min(day, daysInMonth(year, month));
  state.currentYear = year;
  state.currentMonth = month;
  state.selectedDay = safeDay;
  state.activeDate = new Date(year, month, safeDay);
  state.weekStart = startOfWeek(state.activeDate);
}

function resolveMonthShift(year, month, delta) {
  const date = new Date(year, month + delta, 1);
  return { year: date.getFullYear(), month: date.getMonth() };
}

async function changeMonth(direction) {
  const shift = direction === "prev" ? -1 : 1;
  const next = resolveMonthShift(state.currentYear, state.currentMonth, shift);
  const safeDay = Math.min(state.selectedDay, daysInMonth(next.year, next.month));
  setDaySelection(next.year, next.month, safeDay);
  await render();
  const scroller = els.dayScroller;
  if (scroller) {
    scroller.scrollLeft = 0;
    lastDayScrollerScrollLeft = 0;
  }
}

function buildMonthDays(year, month) {
  const total = daysInMonth(year, month);
  const days = [];
  for (let day = 1; day <= total; day += 1) {
    days.push({ dayNumber: day, date: new Date(year, month, day) });
  }
  return days;
}

function getDayScrollerWidths(scroller) {
  const prevStrip = scroller.querySelector('.month-strip[data-strip="prev"]');
  const curStrip = scroller.querySelector('.month-strip[data-strip="cur"]');
  const dayChip = scroller.querySelector('.day-chip');
  const fallback = scroller.clientWidth || 0;
  return {
    prevWidth: prevStrip?.getBoundingClientRect().width || fallback,
    curWidth: curStrip?.getBoundingClientRect().width || fallback,
    chipWidth: dayChip?.getBoundingClientRect().width || 0,
  };
}

async function commitDayScrollerMonth(direction) {
  if (dayScrollerIsSwapping) return;
  dayScrollerIsSwapping = true;
  const next = resolveMonthShift(state.currentYear, state.currentMonth, direction);
  const nextSelectedDay = direction > 0 ? 1 : daysInMonth(next.year, next.month);
  setDaySelection(next.year, next.month, nextSelectedDay);
  await render();
  requestAnimationFrame(() => {
    const scroller = els.dayScroller;
    if (!scroller) {
      dayScrollerIsSwapping = false;
      return;
    }
    const widths = getDayScrollerWidths(scroller);
    dayScrollerPrevWidth = widths.prevWidth;
    dayScrollerCurWidth = widths.curWidth;
    scroller.scrollLeft = dayScrollerPrevWidth;
    lastDayScrollerScrollLeft = scroller.scrollLeft;
    dayScrollerIsSwapping = false;
  });
}

function handleDayScrollerScroll() {
  if (!ENABLE_DAY_SCROLLER_MONTH_SWAP) return;
  const scroller = els.dayScroller;
  if (!scroller || dayScrollerIsSwapping) return;
  if (dayScrollerScrollRaf) return;
  dayScrollerScrollRaf = requestAnimationFrame(() => {
    dayScrollerScrollRaf = null;
    if (!dayScrollerPrevWidth || !dayScrollerCurWidth) {
      const widths = getDayScrollerWidths(scroller);
      dayScrollerPrevWidth = widths.prevWidth;
      dayScrollerCurWidth = widths.curWidth;
    }
    if (!dayScrollerPrevWidth || !dayScrollerCurWidth) return;
    const widths = getDayScrollerWidths(scroller);
    const snapBuffer = widths.chipWidth ? widths.chipWidth * 0.5 : 0;
    const currentLeft = scroller.scrollLeft;
    lastDayScrollerScrollLeft = currentLeft;
    if (currentLeft >= dayScrollerPrevWidth + dayScrollerCurWidth - snapBuffer) {
      void commitDayScrollerMonth(1);
    } else if (currentLeft <= snapBuffer) {
      void commitDayScrollerMonth(-1);
    }
  });
}

function setView(nextView) {
  state.view = nextView;
  setBodyViewClass(state.view);
  state.weekStart = startOfWeek(state.activeDate);
  if (isMobile()) {
    closeSidebarDrawer();
  }
}

function shiftView(dir) {
  if (state.view === "day") {
    setActiveDate(addDays(state.activeDate, dir));
  } else if (state.view === "week") {
    state.weekStart = addDays(state.weekStart, dir * 7);
    setActiveDate(new Date(state.weekStart));
  } else {
    setActiveDate(new Date(state.activeDate.getFullYear(), state.activeDate.getMonth() + dir, 1));
  }
}

function formatDayHeader(date) {
  const dayNames = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
  const name = dayNames[date.getDay()] || "";
  return `${name} • ${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`;
}

function formatHeaderDate(date) {
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return `${pad2(date.getDate())}. ${dayNames[date.getDay()] || ""}`;
}

function renderTopBar() {
  if (!els.weekLabel) return;

  const titleEl = els.monthNameBtn || document.querySelector(".title .h1");
  const monthYear = monthTitle(state.currentYear, state.currentMonth);
  if (titleEl) {
    titleEl.textContent = monthYear;
  }

  const dayLabel = formatHeaderDate(state.activeDate);
  els.weekLabel.textContent = dayLabel;
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

function getScrollBufferPx() {
  if (state.view === "day" && state.dayMode === "fit" && isMobile()) {
    return 0;
  }
  return SCROLL_BUFFER_PX;
}

function getCalendarAvailableHeight() {
  const bodyHeight = els.calBody?.clientHeight || 0;
  const headHeight = document.querySelector(".calHead")?.clientHeight || 0;
  return Math.max(1, bodyHeight - headHeight);
}

function applyDayFitSettings(day, isFit) {
  if (!isFit) {
    state.viewStartHour = 0;
    state.viewEndHour = 24;
    state.slotPx = DEFAULT_SLOT_PX;
    if (els.calBody) els.calBody.style.overflowY = "auto";
    return;
  }

  state.viewStartHour = 0;
  state.viewEndHour = 24;
  state.slotPx = computeSlotPxToFitDay();
  if (els.calBody) els.calBody.style.overflowY = "hidden";
}

function computeSlotPxToFitDay() {
  const totalSlots = (24 * 60) / state.stepMinutes;
  if (!totalSlots) return DEFAULT_SLOT_PX;
  const availableHeight = getCalendarAvailableHeight();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const baseHeight = Math.max(availableHeight, viewportHeight || 0);
  const px = Math.floor(baseHeight / totalSlots);
  const minPx = Math.max(12, Math.floor(DEFAULT_SLOT_PX * 0.75));
  const maxPx = DEFAULT_SLOT_PX;
  return Math.min(maxPx, Math.max(minPx, px));
}

// -------------------- Day / Week / Month renderers --------------------
function renderDayView() {
  const d = startOfDay(state.activeDate);
  state.stepMinutes = DEFAULT_STEP_MINUTES;
  const isFit = state.dayMode === "fit";
  applyDayFitSettings(d, isFit);
  renderTimeCol();

  currentRenderedDays = [d];
  renderHeadersForDays([d], true);
  renderGridForDays([d]);
  renderNowIndicator([d]);
  if (!isFit) {
    autoScrollToNow([d]);
  }

  drawBlocksForRange(d, addDays(d, 1), [d]);
}

function renderDayAgenda() {
  renderDayScroller();
  renderDayEventList();
}

function renderWeekView() {
  state.viewStartHour = 0;
  state.viewEndHour = 24;
  state.stepMinutes = WEEK_STEP_MINUTES;
  state.slotPx = WEEK_SLOT_PX;
  if (els.calBody) els.calBody.style.overflowY = "auto";
  renderTimeCol();

  const days = getWeekDays(state.weekStart);
  currentRenderedDays = days;
  renderHeadersForDays(days, false, dateKey(new Date()));
  renderGridForDays(days);
  renderNowIndicator(days);
  autoScrollToNow(days);

  const weekEnd = addDays(state.weekStart, 7);
  drawBlocksForRange(state.weekStart, weekEnd, days);
}

function renderMonthView() {
  state.stepMinutes = DEFAULT_STEP_MINUTES;
  state.viewStartHour = DEFAULT_VIEW_START_HOUR;
  state.viewEndHour = DEFAULT_VIEW_END_HOUR;
  state.slotPx = DEFAULT_SLOT_PX;
  if (els.calBody) els.calBody.style.overflowY = "auto";
  if (els.timeCol) els.timeCol.innerHTML = "";
  if (els.dayHeaders) els.dayHeaders.innerHTML = "";
  if (!els.grid) return;

  els.grid.innerHTML = "";
  els.grid.style.height = "auto";
  currentRenderedDays = [];
  if (nowIndicatorTimer) {
    clearInterval(nowIndicatorTimer);
    nowIndicatorTimer = null;
  }

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
      setActiveDate(day);
      state.view = "day";
      await render();
    });

    wrapper.appendChild(cell);
  }

  els.grid.appendChild(wrapper);
}

function renderDayScroller() {
  if (!els.dayScroller) return;
  const dayNames = ["SO", "MO", "DI", "MI", "DO", "FR", "SA"];
  const curDays = buildMonthDays(state.currentYear, state.currentMonth);
  const strips = [
    { key: "cur", year: state.currentYear, month: state.currentMonth, days: curDays },
  ];

  els.dayScroller.innerHTML = "";
  strips.forEach((strip) => {
    const stripEl = document.createElement("div");
    stripEl.className = "month-strip";
    stripEl.dataset.strip = strip.key;
    stripEl.dataset.month = strip.key === "cur" ? "current" : strip.key;
    strip.days.forEach((dayObj) => {
      const dayDate = dayObj.date;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "day-chip";
      button.innerHTML = `
        <span class="day-number">${pad2(dayObj.dayNumber)}</span>
        <span class="day-label">${dayNames[dayDate.getDay()]}</span>
      `;
      if (
        dayObj.dayNumber === state.selectedDay
        && strip.year === state.currentYear
        && strip.month === state.currentMonth
      ) {
        button.classList.add("selected");
      }
      button.addEventListener("click", async () => {
        setDaySelection(strip.year, strip.month, dayObj.dayNumber);
        await render();
      });
      stripEl.appendChild(button);
    });
    els.dayScroller.appendChild(stripEl);
  });

  const selected = els.dayScroller.querySelector('.month-strip[data-strip="cur"] .day-chip.selected');
  selected?.scrollIntoView({ inline: "center", block: "nearest" });
  requestAnimationFrame(() => {
    const scroller = els.dayScroller;
    scroller.scrollLeft = 0;
    lastDayScrollerScrollLeft = 0;
    if (dayScrollerIsSwapping) {
      dayScrollerIsSwapping = false;
    }
  });
}

function renderDayEventList() {
  if (!els.dayEventList) return;
  const dayKey = dateKey(state.activeDate);
  const items = [];

  (state.tasks || [])
    .filter(task => task.scheduledStart && task.status !== "done")
    .forEach((task) => {
      const start = new Date(task.scheduledStart);
      if (Number.isNaN(start.getTime())) return;
      if (dateKey(start) !== dayKey) return;
      const duration = Number(task.durationMinutes || 0);
      const end = duration ? addMinutes(start, duration) : null;
      const timeLabel = end ? `${fmtTime(start)}–${fmtTime(end)}` : fmtTime(start);
      items.push({
        type: "task",
        title: task.title || "Task",
        timeLabel,
        date: start,
        location: "Task",
        description: duration ? `Dauer: ${duration} Min` : "Task ohne Dauer",
      });
    });

  (state.events || []).forEach((ev) => {
    const start = ev?.start ? new Date(ev.start) : null;
    if (!start || Number.isNaN(start.getTime())) return;
    if (dateKey(start) !== dayKey) return;
    const end = ev?.end ? new Date(ev.end) : null;
    const hasEnd = end && !Number.isNaN(end.getTime());
    const timeLabel = hasEnd ? `${fmtTime(start)}–${fmtTime(end)}` : fmtTime(start);
    const location = (ev?.location || ev?.place || ev?.locationName || "").trim() || "—";
    const description = (ev?.notes || ev?.description || "").trim() || "—";
    items.push({
      type: "event",
      title: ev?.title || ev?.summary || "Event",
      timeLabel,
      date: start,
      location,
      description,
    });
  });

  items.sort((a, b) => new Date(a.date) - new Date(b.date));

  els.dayEventList.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "event-empty";
    empty.textContent = "Keine Events oder Tasks für diesen Tag.";
    els.dayEventList.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "event-card mirror-axis";

    const time = document.createElement("div");
    time.className = "event-time mirror-left";
    time.textContent = item.timeLabel;

    const title = document.createElement("div");
    title.className = "event-title mirror-right";
    title.textContent = item.title;

    const icon = document.createElement("button");
    icon.className = "expand-icon mirror-center";
    icon.type = "button";
    icon.setAttribute("aria-label", "Event-Details anzeigen");
    icon.setAttribute("aria-expanded", "false");
    icon.textContent = "›";
    icon.addEventListener("click", (event) => {
      event.stopPropagation();
      const isExpanded = card.classList.toggle("expanded");
      icon.setAttribute("aria-expanded", String(isExpanded));
      icon.setAttribute(
        "aria-label",
        isExpanded ? "Event-Details verbergen" : "Event-Details anzeigen",
      );
    });

    const detailPanel = document.createElement("div");
    detailPanel.className = "event-detail-panel";

    const locationRow = document.createElement("div");
    locationRow.className = "event-detail-row";
    const locationLabel = document.createElement("span");
    locationLabel.className = "event-detail-label";
    locationLabel.textContent = item.type === "task" ? "Info:" : "Ort:";
    const locationValue = document.createElement("span");
    locationValue.textContent = item.type === "task" ? item.description : item.location;
    locationRow.appendChild(locationLabel);
    locationRow.appendChild(locationValue);

    const descriptionRow = document.createElement("div");
    descriptionRow.className = "event-detail-row";
    const descriptionLabel = document.createElement("span");
    descriptionLabel.className = "event-detail-label";
    descriptionLabel.textContent = "Notiz:";
    const descriptionValue = document.createElement("span");
    descriptionValue.textContent = item.type === "task" ? "—" : item.description;
    descriptionRow.appendChild(descriptionLabel);
    descriptionRow.appendChild(descriptionValue);

    detailPanel.appendChild(locationRow);
    detailPanel.appendChild(descriptionRow);

    card.appendChild(time);
    card.appendChild(title);
    card.appendChild(icon);
    card.appendChild(detailPanel);

    els.dayEventList.appendChild(card);
  });
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

function updateCalendarScrollbarGutter() {
  if (!els.calBody) return;
  const scrollbarWidth = Math.max(0, els.calBody.offsetWidth - els.calBody.clientWidth);
  document.documentElement.style.setProperty("--calendar-scrollbar", `${scrollbarWidth}px`);
}

function renderTimeCol() {
  if (!els.timeCol) return;
  els.timeCol.innerHTML = "";
  const slots = timeSlots(state.viewStartHour, state.viewEndHour, state.stepMinutes);
  const totalSlots = slots.length;
  slots.forEach((t) => {
    const div = document.createElement("div");
    div.className = "timeLabel";
    div.textContent = t.endsWith(":00") ? t : "";
    div.style.height = `${state.slotPx}px`;
    if (state.slotPx <= 18) {
      div.style.fontSize = "10px";
    } else if (state.slotPx <= 22) {
      div.style.fontSize = "11px";
    }
    els.timeCol.appendChild(div);
  });
  if (state.view === "week" && state.stepMinutes === 60 && state.viewEndHour === 24) {
    const endLabel = document.createElement("div");
    endLabel.className = "timeLabel end";
    endLabel.textContent = "24:00";
    endLabel.style.top = `${totalSlots * state.slotPx - 10}px`;
    els.timeCol.appendChild(endLabel);
  }
  const spacer = document.createElement("div");
  spacer.style.height = `${getScrollBufferPx()}px`;
  spacer.style.borderBottom = "0";
  els.timeCol.appendChild(spacer);
}

function renderGridForDays(days) {
  if (!els.grid) return;
  els.grid.innerHTML = "";

  const todayKey = dateKey(new Date());
  const totalSlots = timeSlots(state.viewStartHour, state.viewEndHour, state.stepMinutes).length;
  const slotHeightPx = totalSlots * state.slotPx;
  const gridHeightPx = slotHeightPx + getScrollBufferPx();
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
      const minutesFromStart = s * state.stepMinutes;
      line.className = minutesFromStart % 60 === 0 ? "slotLine" : "slotLine minor";
      line.style.top = `${s * state.slotPx}px`;
      col.appendChild(line);
    }
    els.grid.appendChild(col);
  }
}

function renderNowIndicator(days) {
  if (!els.grid) return;
  els.grid.querySelectorAll(".nowLine").forEach((line) => line.remove());

  const now = new Date();
  const todayKey = dateKey(now);
  const totalSlots = timeSlots(state.viewStartHour, state.viewEndHour, state.stepMinutes).length;
  const gridHeightPx = totalSlots * state.slotPx;
  const pxPerMin = state.slotPx / state.stepMinutes;
  const top = minutesFromViewStart(now) * pxPerMin;

  if (top < 0 || top > gridHeightPx) return;

  days.forEach((day, idx) => {
    if (dateKey(day) !== todayKey) return;
    const col = els.grid.children[idx];
    if (!col) return;
    const line = document.createElement("div");
    line.className = "nowLine";
    line.style.top = `${top}px`;
    col.appendChild(line);
  });

  if (!nowIndicatorTimer) {
    nowIndicatorTimer = window.setInterval(() => {
      if (state.view === "month") return;
      renderNowIndicator(currentRenderedDays);
    }, 60 * 1000);
  }
}

function autoScrollToNow(days) {
  if (state.hasAutoScrolled || !els.calBody || !els.grid) return;
  const now = new Date();
  const todayKey = dateKey(now);
  const isTodayVisible = days.some((day) => dateKey(day) === todayKey);
  if (!isTodayVisible) return;

  const totalSlots = timeSlots(state.viewStartHour, state.viewEndHour, state.stepMinutes).length;
  const slotHeightPx = totalSlots * state.slotPx;
  const gridHeightPx = slotHeightPx + getScrollBufferPx();
  const pxPerMin = state.slotPx / state.stepMinutes;
  const top = minutesFromViewStart(now) * pxPerMin;
  const target = Math.max(0, top - els.calBody.clientHeight / 2);
  const maxScroll = Math.max(0, gridHeightPx - els.calBody.clientHeight);

  els.calBody.scrollTop = Math.min(target, maxScroll);
  state.hasAutoScrolled = true;
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
  const height = Math.max(50, (yEndMin - yStartMin) * pxPerMin);

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
  const height = Math.max(50, (yEndMin - yStartMin) * pxPerMin);

  const div = document.createElement("div");
  div.className = "eventBlock";
  div.draggable = false;
  div.style.top = `${top + 2}px`;
  div.style.height = `${height - 4}px`;
  const eventId = getGoogleEventId(ev) || ev.id;
  if (eventId) {
    div.dataset.eventId = eventId;
  }
  if (state.selectedEventId && eventId === state.selectedEventId) {
    div.classList.add("selected");
  }
  const title = ev.title || ev.summary || "Termin";
  div.innerHTML = `
    <div class="t">${escapeHtml(title)}</div>
  `;
  attachEventBlockHandlers(div, ev, dayIdx);
  col.appendChild(div);
}

function attachEventBlockHandlers(div, ev, dayIdx) {
  div.addEventListener("click", (event) => {
    event.stopPropagation();
    selectEvent(ev);
  });

  div.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    selectEvent(ev);
    openEventDetailModal(ev);
  });

  div.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    selectEvent(ev);
    void deleteEvent(ev);
  });
}

function indexWithinRenderedDays(date, daysArray, rangeStart) {
  if (daysArray.length === 1) return 0;
  const k = dateKey(date);
  const idx = daysArray.findIndex(d => dateKey(d) === k);
  return idx >= 0 ? idx : dayIndexMon0(date);
}

function startEventDrag(event, ev, dayIdx, block) {
  if (event.button !== 0) return;
  const eventId = getGoogleEventId(ev) || ev.id;
  if (!eventId) return;
  if (!els.grid) return;
  if (activeEventDrag) return;

  const start = new Date(ev.start);
  const end = new Date(ev.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;

  event.preventDefault();
  event.stopPropagation();
  selectEvent(ev);

  const durationMin = Math.max(state.stepMinutes, Math.round((end - start) / 60000));
  const pxPerMin = state.slotPx / state.stepMinutes;
  const startTop = minutesFromViewStart(start) * pxPerMin;

  const gridRect = els.grid.getBoundingClientRect();
  const daysCount = Math.max(1, currentRenderedDays.length || 1);
  const colWidth = gridRect.width / daysCount;

  activeEventDrag = {
    eventId,
    ev,
    block,
    start,
    end,
    durationMin,
    startTop,
    startDayIdx: dayIdx,
    originClientX: event.clientX,
    originClientY: event.clientY,
    daysCount,
    gridRect,
    colWidth,
    hasDragged: false,
    previewDayIdx: dayIdx,
    previewMinutes: minutesFromViewStart(start),
    ghost: null,
  };

  window.addEventListener("pointermove", onEventDragMove);
  window.addEventListener("pointerup", onEventDragEnd);
  window.addEventListener("pointercancel", onEventDragEnd);
}

function onEventDragMove(event) {
  if (!activeEventDrag || !els.grid) return;

  const drag = activeEventDrag;
  const deltaY = event.clientY - drag.originClientY;
  const deltaX = event.clientX - drag.originClientX;
  const distance = Math.hypot(deltaX, deltaY);

  const pxPerMin = state.slotPx / state.stepMinutes;
  const gridRect = els.grid.getBoundingClientRect();
  const daysCount = Math.max(1, currentRenderedDays.length || 1);
  const colWidth = gridRect.width / daysCount;
  const inset = getEventInsetPx();

  const rawTop = drag.startTop + deltaY;
  const rawMinutes = rawTop / pxPerMin;
  const snappedMinutes = Math.round(rawMinutes / state.stepMinutes) * state.stepMinutes;
  const maxMinutes = Math.max(0, (state.viewEndHour - state.viewStartHour) * 60 - drag.durationMin);
  const clampedMinutes = clamp(snappedMinutes, 0, maxMinutes);

  let nextDayIdx = drag.startDayIdx;
  if (daysCount > 1) {
    const relativeX = event.clientX - gridRect.left;
    nextDayIdx = clamp(Math.floor(relativeX / colWidth), 0, daysCount - 1);
  }

  drag.previewMinutes = clampedMinutes;
  drag.previewDayIdx = nextDayIdx;

  if (!drag.hasDragged && distance > 4) {
    drag.hasDragged = true;
    const ghost = document.createElement("div");
    ghost.className = "eventGhost";
    ghost.innerHTML = `
      <div class="t">${escapeHtml(drag.ev.title || "Termin")}</div>
    `;
    els.grid.appendChild(ghost);
    drag.ghost = ghost;
    drag.block.classList.add("dragging");
  }

  if (!drag.hasDragged || !drag.ghost) return;

  const top = clampedMinutes * pxPerMin;
  const height = Math.max(28, drag.durationMin * pxPerMin);
  const left = nextDayIdx * colWidth + inset;
  const width = Math.max(32, colWidth - inset * 2);

  drag.ghost.style.top = `${top + 2}px`;
  drag.ghost.style.left = `${left}px`;
  drag.ghost.style.width = `${width}px`;
  drag.ghost.style.height = `${height - 4}px`;
}

function onEventDragEnd() {
  if (!activeEventDrag) return;
  const drag = activeEventDrag;

  window.removeEventListener("pointermove", onEventDragMove);
  window.removeEventListener("pointerup", onEventDragEnd);
  window.removeEventListener("pointercancel", onEventDragEnd);

  if (drag.ghost) drag.ghost.remove();
  drag.block?.classList.remove("dragging");

  activeEventDrag = null;

  if (!drag.hasDragged) return;

  const targetDay = currentRenderedDays[drag.previewDayIdx] || state.activeDate;
  const newStart = minutesToDate(targetDay, drag.previewMinutes);
  const newEnd = addMinutes(new Date(newStart), drag.durationMin);

  const originalStart = new Date(drag.ev.start);
  const originalKey = dateKey(originalStart);
  const nextKey = dateKey(newStart);
  const timeChanged = originalStart.getTime() !== newStart.getTime() || originalKey !== nextKey;

  if (timeChanged) {
    void persistEventMove(drag.ev, newStart, newEnd);
  }
}

function minutesToDate(dayDate, minutesFromViewStart) {
  const d = new Date(dayDate);
  d.setHours(state.viewStartHour, 0, 0, 0);
  return addMinutes(d, minutesFromViewStart);
}

function getEventInsetPx() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--event-inset");
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 6;
}

function getGoogleEventId(ev) {
  if (!ev) return "";
  if (ev.googleEventId) return String(ev.googleEventId);
  if (typeof ev.id === "string" && ev.id.startsWith("gcal_")) return ev.id.slice(5);
  return ev.id ? String(ev.id) : "";
}

function getSelectedEvent() {
  if (!state.selectedEventId) return null;
  return findEventById(state.selectedEventId) || state.selectedEventData || null;
}

function findEventById(eventId) {
  if (!eventId) return null;
  return (state.events || []).find((ev) => {
    const id = getGoogleEventId(ev) || ev.id;
    return id === eventId;
  }) || null;
}

function selectEvent(ev) {
  const eventId = getGoogleEventId(ev) || ev.id;
  if (!eventId) return;
  state.selectedEventId = eventId;
  state.selectedEventData = ev;
  renderSelectedEventDetails();
  updateEventSelectionStyles();
}

function clearSelectedEvent() {
  state.selectedEventId = null;
  state.selectedEventData = null;
  renderSelectedEventDetails();
  updateEventSelectionStyles();
}

function syncSelectedEvent() {
  if (!state.selectedEventId) return;
  const found = findEventById(state.selectedEventId);
  if (!found) {
    clearSelectedEvent();
    return;
  }
  state.selectedEventData = found;
}

function updateEventSelectionStyles() {
  const selectedId = state.selectedEventId;
  document.querySelectorAll(".eventBlock").forEach((block) => {
    block.classList.toggle("selected", !!selectedId && block.dataset.eventId === selectedId);
  });
  document.querySelectorAll(".eventListItem").forEach((item) => {
    item.classList.toggle("selected", !!selectedId && item.dataset.eventId === selectedId);
  });
}

function formatEventMeta(ev) {
  const start = ev?.start ? new Date(ev.start) : null;
  const hasStart = start && !Number.isNaN(start.getTime());

  if (hasStart) {
    return `${fmtDate(start)}`;
  }
  return "Google Event";
}

function formatDurationMinutes(durationMin) {
  if (!Number.isFinite(durationMin)) return "";
  const hours = Math.floor(durationMin / 60);
  const mins = Math.round(durationMin % 60);
  if (hours && mins) return `${hours}h ${mins}m`;
  if (hours) return `${hours}h`;
  return `${mins}m`;
}

function renderSelectedEventDetails() {
  if (!els.selectedEventCard) return;
  const ev = getSelectedEvent();
  if (!ev) {
    els.selectedEventCard.classList.add("hidden");
    return;
  }

  const start = ev?.start ? new Date(ev.start) : null;
  const end = ev?.end ? new Date(ev.end) : null;
  const hasStart = start && !Number.isNaN(start.getTime());
  const hasEnd = end && !Number.isNaN(end.getTime());

  const durationMin = hasStart && hasEnd ? Math.max(5, Math.round((end - start) / 60000)) : null;
  const notes = (ev?.notes || ev?.description || "").trim();

  if (els.selectedEventMeta) {
    els.selectedEventMeta.textContent = hasStart ? formatEventMeta(ev) : "Google Event";
  }
  if (els.selectedEventTitle) {
    els.selectedEventTitle.textContent = ev?.title || ev?.summary || "Termin";
  }
  if (els.selectedEventDate) {
    els.selectedEventDate.textContent = hasStart ? fmtDate(start) : "-";
  }
  if (els.selectedEventTime) {
    els.selectedEventTime.textContent = hasStart ? fmtTime(start) : "-";
  }
  if (els.selectedEventDuration) {
    els.selectedEventDuration.textContent = durationMin ? formatDurationMinutes(durationMin) : "-";
  }
  if (els.selectedEventNotes) {
    els.selectedEventNotes.textContent = notes || "—";
  }
  if (els.selectedEventNotesRow) {
    els.selectedEventNotesRow.style.display = notes ? "grid" : "none";
  }
  if (els.selectedEventDeleteBtn) {
    const eventId = getGoogleEventId(ev) || ev.id || "";
    els.selectedEventDeleteBtn.disabled = !eventId || deletingEvents.has(eventId);
  }

  els.selectedEventCard.classList.remove("hidden");
}

// -------------------- Weekly load --------------------
function refreshWeeklyLoad() {
  if (!els.weekLoadChart || !els.weekLoadSummary || !els.weekLoadSuggestions || !els.weekLoadBreaks) return;

  const key = dateKey(state.weekStart);
  const now = Date.now();
  const shouldRefresh =
    !state.weekLoad ||
    state.weekLoadKey !== key ||
    now - (state.weekLoadFetchedAt || 0) > WEEK_LOAD_TTL_MS;

  if (!shouldRefresh || state.weekLoadLoading) {
    renderWeeklyLoad();
    return;
  }

  state.weekLoadLoading = true;
  state.weekLoadKey = key;
  state.weekLoadError = null;
  renderWeeklyLoad();

  void apiGet(`/api/weekly-load?weekStart=${encodeURIComponent(key)}`)
    .then((data) => {
      state.weekLoad = data;
      state.weekLoadFetchedAt = Date.now();
      state.weekLoadError = null;
    })
    .catch((err) => {
      state.weekLoadError = err;
    })
    .finally(() => {
      state.weekLoadLoading = false;
      renderWeeklyLoad();
    });
}

function renderWeeklyLoad() {
  if (!els.weekLoadChart || !els.weekLoadSummary || !els.weekLoadSuggestions || !els.weekLoadBreaks) return;

  const names = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  const dayNames = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  els.weekLoadChart.innerHTML = "";
  els.weekLoadSuggestions.innerHTML = "";
  els.weekLoadBreaks.innerHTML = "";

  if (state.weekLoadLoading) {
    els.weekLoadSummary.innerHTML = `<div class="weekLoadMeta">Lade Wochenbelastung...</div>`;
    return;
  }

  if (state.weekLoadError) {
    els.weekLoadSummary.innerHTML = `<div class="weekLoadMeta">Wochenbelastung nicht verfügbar.</div>`;
    return;
  }

  const data = state.weekLoad;
  if (!data?.days?.length) {
    els.weekLoadSummary.innerHTML = `<div class="weekLoadMeta">Noch keine Daten für diese Woche.</div>`;
    return;
  }

  const totalHours = (data.totals?.totalMinutes || 0) / 60;
  const avgStress = data.totals?.averageStress ?? 0;
  const busiestDay = data.totals?.busiestDay || "";

  els.weekLoadSummary.innerHTML = `
    <div class="weekLoadMeta">
      <div><strong>${totalHours.toFixed(1)} Std.</strong> geplant</div>
      <div>Ø Stress: <strong>${avgStress}%</strong></div>
      ${busiestDay ? `<div>Spitzen-Tag: <strong>${busiestDay}</strong></div>` : ""}
    </div>
  `;

  data.days.forEach((day, index) => {
    const dayWrap = document.createElement("div");
    dayWrap.className = "weekLoadDay";

    const bars = document.createElement("div");
    bars.className = "weekLoadBars";

    const stressBar = document.createElement("div");
    stressBar.className = "weekLoadBar stress";
    stressBar.style.setProperty("--value", `${day.stress || 0}`);
    stressBar.title = `Stress ${day.stress || 0}%`;

    const densityBar = document.createElement("div");
    densityBar.className = "weekLoadBar density";
    densityBar.style.setProperty("--value", `${day.density || 0}`);
    densityBar.title = `Dichte ${day.count || 0} Termine`;

    bars.appendChild(stressBar);
    bars.appendChild(densityBar);

    const label = document.createElement("div");
    label.className = "weekLoadLabel";
    label.textContent = names[index] || day.date;

    const meta = document.createElement("div");
    meta.className = "weekLoadMetaSmall";
    const minutes = Number(day.minutes || 0);
    meta.textContent = `${(minutes / 60).toFixed(1)}h • ${day.count || 0}x`;

    dayWrap.appendChild(bars);
    dayWrap.appendChild(label);
    dayWrap.appendChild(meta);
    els.weekLoadChart.appendChild(dayWrap);
  });

  if (!data.suggestions?.length) {
    els.weekLoadSuggestions.innerHTML = `<div class="item"><div class="itemTitle">Alles im grünen Bereich</div><div class="itemMeta">Aktuell sind ausreichend Pausen vorhanden.</div></div>`;
  } else {
    data.suggestions.forEach((tip) => {
      const item = document.createElement("div");
      item.className = "item";
      const title = document.createElement("div");
      title.className = "itemTitle";
      title.textContent = tip.date || "Tipp";
      const meta = document.createElement("div");
      meta.className = "itemMeta";
      meta.textContent = tip.message || "";
      item.appendChild(title);
      item.appendChild(meta);
      els.weekLoadSuggestions.appendChild(item);
    });
  }

  const breaks = Array.isArray(data.breakRecommendations) ? data.breakRecommendations : [];
  if (!breaks.length) {
    els.weekLoadBreaks.innerHTML = `<div class="item"><div class="itemTitle">Keine Empfehlung</div><div class="itemMeta">Für diese Woche wurden keine idealen Pausenfenster erkannt.</div></div>`;
    return;
  }

  breaks.forEach((pause) => {
    const item = document.createElement("div");
    item.className = "item";
    const title = document.createElement("div");
    title.className = "itemTitle";
    const start = pause.start ? new Date(pause.start) : null;
    const end = pause.end ? new Date(pause.end) : null;
    const date = pause.date ? new Date(`${pause.date}T00:00:00`) : null;
    const hasDate = date && !Number.isNaN(date.getTime());
    const hasTimes = start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime());
    const dateLabel = hasDate
      ? `${dayNames[date.getDay()]} ${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}`
      : pause.date || "Tag";
    title.textContent = dateLabel;
    const meta = document.createElement("div");
    meta.className = "itemMeta";
    const minutes = Number(pause.minutes || 0);
    meta.textContent = hasTimes
      ? `${fmtTime(start)}–${fmtTime(end)} • ${minutes || Math.round((end - start) / 60000)} Min`
      : pause.message || "";
    item.appendChild(title);
    item.appendChild(meta);
    els.weekLoadBreaks.appendChild(item);
  });
}

// -------------------- Side lists / Windows --------------------
function renderSideLists() {
  if (!els.inboxList || !els.plannedList) return;

  els.inboxList.innerHTML = "";
  els.plannedList.innerHTML = "";
  if (els.eventsList) els.eventsList.innerHTML = "";

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

  if (els.eventsList) {
    const events = Array.isArray(state.events) ? [...state.events] : [];
    events.sort((a, b) => new Date(a.start || 0) - new Date(b.start || 0));

    if (events.length === 0) {
      els.eventsList.innerHTML = `<div class="item"><div class="itemTitle">Keine Events</div><div class="itemMeta">Aktuell keine Google-Termine.</div></div>`;
    } else {
      events.forEach((ev) => {
        const item = document.createElement("div");
        item.className = "item eventListItem";

        const top = document.createElement("div");
        top.className = "itemTop";

        const title = document.createElement("div");
        title.className = "itemTitle";
        title.textContent = ev.title || "Termin";

        const actions = document.createElement("div");
        actions.className = "itemActions";

        const deleteId = getGoogleEventId(ev);
        if (deleteId) item.dataset.eventId = deleteId;
        if (state.selectedEventId && deleteId === state.selectedEventId) {
          item.classList.add("selected");
        }

        const toggleBtn = document.createElement("button");
        toggleBtn.className = "eventToggle";
        toggleBtn.type = "button";
        toggleBtn.setAttribute("aria-expanded", "false");
        toggleBtn.setAttribute("aria-label", "Eventdetails anzeigen");
        toggleBtn.textContent = "▾";
        actions.appendChild(toggleBtn);

        top.appendChild(title);
        top.appendChild(actions);

        item.appendChild(top);

        const details = document.createElement("div");
        details.className = "eventDropdown";

        const start = ev?.start ? new Date(ev.start) : null;
        const end = ev?.end ? new Date(ev.end) : null;
        const hasStart = start && !Number.isNaN(start.getTime());
        const hasEnd = end && !Number.isNaN(end.getTime());
        const timeLabel = hasStart
          ? `${fmtTime(start)}${hasEnd ? `–${fmtTime(end)}` : ""}`
          : "Zeit offen";
        const location = (ev?.location || ev?.place || ev?.locationName || "").trim() || "—";
        const description = (ev?.notes || ev?.description || "").trim() || "—";

        details.innerHTML = `
          <div class="eventDropdownRow">
            <span class="eventDropdownLabel">Zeit</span>
            <span class="eventDropdownValue">${escapeHtml(timeLabel)}</span>
          </div>
          <div class="eventDropdownRow">
            <span class="eventDropdownLabel">Ort</span>
            <span class="eventDropdownValue">${escapeHtml(location)}</span>
          </div>
          <div class="eventDropdownRow">
            <span class="eventDropdownLabel">Beschreibung</span>
            <span class="eventDropdownValue">${escapeHtml(description)}</span>
          </div>
        `;

        const actionRow = document.createElement("div");
        actionRow.className = "eventDropdownActions";

        const editBtn = document.createElement("button");
        editBtn.className = "btn small";
        editBtn.type = "button";
        editBtn.textContent = "Bearbeiten";
        editBtn.disabled = !deleteId;
        editBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          openEditEventModal(ev);
        });
        actionRow.appendChild(editBtn);

        const delBtn = document.createElement("button");
        delBtn.className = "btn small delete";
        delBtn.type = "button";
        delBtn.textContent = "Löschen";
        delBtn.disabled = !deleteId || deletingEvents.has(deleteId);
        delBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          void deleteEvent(ev);
        });
        actionRow.appendChild(delBtn);

        details.appendChild(actionRow);
        item.appendChild(details);

        const toggleDetails = () => {
          const next = !item.classList.contains("expanded");
          item.classList.toggle("expanded", next);
          toggleBtn.textContent = next ? "▴" : "▾";
          toggleBtn.setAttribute("aria-expanded", next ? "true" : "false");
        };

        toggleBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          toggleDetails();
        });

        item.addEventListener("click", (event) => {
          if (event.target.closest("button")) return;
          selectEvent(ev);
          toggleDetails();
        });
        els.eventsList.appendChild(item);
      });
    }
  }

  renderFreeSlotList();
  renderApprovedSlotList();
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
  closeSidebarDrawer();
  els.menuBackdrop?.classList.remove("hidden");
  els.newMenu?.classList.remove("hidden");
}
function closeMenu() {
  els.menuBackdrop?.classList.add("hidden");
  els.newMenu?.classList.add("hidden");
}

function openDayEventDetailModal(item) {
  if (!els.dayEventDetailPopup || !els.dayEventDetailBackdrop) return;
  const dateLabel = item?.date ? formatDayHeader(item.date) : formatDayHeader(state.activeDate);
  els.dayEventDetailTitle.textContent = item?.title || "Event";
  els.dayEventDetailDate.textContent = `Datum: ${dateLabel}`;
  els.dayEventDetailTime.textContent = `Startzeit: ${item?.timeLabel || "—"}`;
  els.dayEventDetailLocation.textContent = `Ort: ${item?.location || "—"}`;
  els.dayEventDetailDescription.textContent = `Beschreibung: ${item?.description || "—"}`;
  els.dayEventDetailBackdrop.classList.remove("hidden");
  els.dayEventDetailPopup.classList.remove("hidden");
}

function closeDayEventDetailModal() {
  els.dayEventDetailBackdrop?.classList.add("hidden");
  els.dayEventDetailPopup?.classList.add("hidden");
}

function openNewEventForm() {
  openMenu();
}

function handleNewButtonClick() {
  openNewEventForm();
}

window.openNewEventForm = openNewEventForm;

function openSidebarDrawer() {
  if (!isMobile()) return;
  els.sidebar?.classList.add("open");
  els.sidebarOverlay?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeSidebarDrawer() {
  els.sidebar?.classList.remove("open");
  els.sidebarOverlay?.classList.add("hidden");
  document.body.style.overflow = "";
}

function toggleSidebarDrawer() {
  if (els.sidebar?.classList.contains("open")) {
    closeSidebarDrawer();
  } else {
    openSidebarDrawer();
  }
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
  state.assistant = {
    originalText: "",
    proposal: null,
    intent: "none",
    questions: [],
    provider: determineAssistantProvider(),
  };
  resetAssistantUi();
  setTimeout(() => els.eventText.focus(), 0);
}
function closeEventModal() {
  els.eventBackdrop?.classList.add("hidden");
  els.eventModal?.classList.add("hidden");
  resetAssistantUi();
}

function openSuggestionModal(suggestions, requestPayload) {
  state.eventSuggestions = Array.isArray(suggestions) ? suggestions : [];
  state.selectedSuggestionId = null;
  state.eventSuggestionRequest = requestPayload || null;
  renderSuggestionList();
  els.suggestionBackdrop?.classList.remove("hidden");
  els.suggestionModal?.classList.remove("hidden");
}

function openSuggestionModalWithPreselect(suggestions, requestPayload, preselectedId) {
  state.eventSuggestions = Array.isArray(suggestions) ? suggestions : [];
  state.selectedSuggestionId = preselectedId || null;
  state.eventSuggestionRequest = requestPayload || null;
  renderSuggestionList();
  els.suggestionBackdrop?.classList.remove("hidden");
  els.suggestionModal?.classList.remove("hidden");
}

function closeSuggestionModal() {
  state.eventSuggestions = [];
  state.selectedSuggestionId = null;
  state.eventSuggestionRequest = null;
  els.suggestionBackdrop?.classList.add("hidden");
  els.suggestionModal?.classList.add("hidden");
}

function renderSuggestionList() {
  if (!els.suggestionList) return;
  els.suggestionList.innerHTML = "";

  const suggestions = state.eventSuggestions || [];
  if (suggestions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cardMini";
    empty.textContent = "Keine freien Slots gefunden. Passe Datum oder Dauer an.";
    els.suggestionList.appendChild(empty);
    if (els.suggestionConfirmBtn) {
      els.suggestionConfirmBtn.disabled = true;
    }
    return;
  }

  suggestions.forEach((suggestion) => {
    const start = suggestion?.start ? new Date(suggestion.start) : null;
    const end = suggestion?.end ? new Date(suggestion.end) : null;
    const hasStart = start && !Number.isNaN(start.getTime());
    const hasEnd = end && !Number.isNaN(end.getTime());
    const duration = hasStart && hasEnd ? Math.round((end - start) / 60000) : null;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestionItem";
    if (state.selectedSuggestionId === suggestion.id) button.classList.add("active");

    const title = document.createElement("div");
    title.className = "suggestionTitle";
    title.textContent = hasStart ? `${fmtDate(start)} • ${fmtTime(start)}–${fmtTime(end)}` : "Unbekannter Slot";

    const meta = document.createElement("div");
    meta.className = "suggestionMeta";
    const reason = suggestion?.reason ? String(suggestion.reason) : "";
    meta.textContent = duration ? `${duration} min` : "Dauer unbekannt";
    if (reason) {
      const reasonLine = document.createElement("div");
      reasonLine.className = "suggestionReason";
      reasonLine.textContent = reason;
      meta.appendChild(reasonLine);
    }

    button.appendChild(title);
    button.appendChild(meta);
    button.addEventListener("click", () => {
      state.selectedSuggestionId = suggestion.id;
      renderSuggestionList();
    });

    els.suggestionList.appendChild(button);
  });

  if (els.suggestionConfirmBtn) {
    els.suggestionConfirmBtn.disabled = !state.selectedSuggestionId;
  }
}

function ensureFreeSlotDefaults() {
  if (els.freeSlotDate && !els.freeSlotDate.value) {
    els.freeSlotDate.value = toInputDate(new Date());
  }
  if (els.freeSlotDuration && !els.freeSlotDuration.value) {
    els.freeSlotDuration.value = "60";
  }
  if (els.freeSlotDaysForward && !els.freeSlotDaysForward.value) {
    els.freeSlotDaysForward.value = "5";
  }
}

function renderFreeSlotList() {
  if (!els.freeSlotList) return;
  els.freeSlotList.innerHTML = "";

  const slots = Array.isArray(state.freeSlots) ? state.freeSlots : [];
  if (slots.length === 0) {
    const empty = document.createElement("div");
    empty.className = "item";
    empty.innerHTML = `<div class="itemTitle">Keine Vorschläge</div><div class="itemMeta">Noch keine freien Slots gefunden.</div>`;
    els.freeSlotList.appendChild(empty);
    return;
  }

  slots.forEach((slot) => {
    const start = slot?.start ? new Date(slot.start) : null;
    const end = slot?.end ? new Date(slot.end) : null;
    const hasStart = start && !Number.isNaN(start.getTime());
    const hasEnd = end && !Number.isNaN(end.getTime());
    const duration = hasStart && hasEnd ? Math.round((end - start) / 60000) : null;

    const item = document.createElement("div");
    item.className = "item";

    const top = document.createElement("div");
    top.className = "itemTop";

    const title = document.createElement("div");
    title.className = "itemTitle";
    title.textContent = hasStart ? `${fmtDate(start)} • ${fmtTime(start)}–${fmtTime(end)}` : "Unbekannter Slot";

    const actions = document.createElement("div");
    actions.className = "itemActions";

    const approveBtn = document.createElement("button");
    approveBtn.className = "btn small";
    approveBtn.type = "button";
    approveBtn.textContent = "Freigeben";
    approveBtn.addEventListener("click", async () => {
      await approveFreeSlot(slot);
    });
    actions.appendChild(approveBtn);

    top.appendChild(title);
    top.appendChild(actions);

    const meta = document.createElement("div");
    meta.className = "itemMeta";
    meta.textContent = duration ? `${duration} min` : "Dauer unbekannt";

    item.appendChild(top);
    item.appendChild(meta);
    els.freeSlotList.appendChild(item);
  });
}

function renderApprovedSlotList() {
  if (!els.approvedSlotList) return;
  els.approvedSlotList.innerHTML = "";

  const slots = Array.isArray(state.approvedFreeSlots) ? state.approvedFreeSlots : [];
  if (slots.length === 0) {
    const empty = document.createElement("div");
    empty.className = "item";
    empty.innerHTML = `<div class="itemTitle">Keine Freigaben</div><div class="itemMeta">Noch keine Slots freigegeben.</div>`;
    els.approvedSlotList.appendChild(empty);
    return;
  }

  slots.forEach((slot) => {
    const start = slot?.start ? new Date(slot.start) : null;
    const end = slot?.end ? new Date(slot.end) : null;
    const hasStart = start && !Number.isNaN(start.getTime());
    const hasEnd = end && !Number.isNaN(end.getTime());
    const duration = hasStart && hasEnd ? Math.round((end - start) / 60000) : null;

    const item = document.createElement("div");
    item.className = "item";

    const top = document.createElement("div");
    top.className = "itemTop";

    const title = document.createElement("div");
    title.className = "itemTitle";
    title.textContent = hasStart ? `${fmtDate(start)} • ${fmtTime(start)}–${fmtTime(end)}` : "Freigegebener Slot";

    const actions = document.createElement("div");
    actions.className = "itemActions";

    const createBtn = document.createElement("button");
    createBtn.className = "btn small primary";
    createBtn.type = "button";
    createBtn.textContent = "Termin erstellen";
    createBtn.addEventListener("click", async () => {
      await confirmFreeSlot(slot);
    });
    actions.appendChild(createBtn);

    top.appendChild(title);
    top.appendChild(actions);

    const meta = document.createElement("div");
    meta.className = "itemMeta";
    meta.textContent = duration ? `${duration} min` : "Dauer unbekannt";

    item.appendChild(top);
    item.appendChild(meta);
    els.approvedSlotList.appendChild(item);
  });
}

function applySmartPrefsToInputs() {
  if (!els.smartTitle) return;
  const prefs = state.smartPrefs || DEFAULT_SMART_PREFS;
  if (els.smartTitle) els.smartTitle.value = prefs.title || "";
  if (els.smartDate) els.smartDate.value = prefs.date || toInputDate(new Date());
  if (els.smartDuration) els.smartDuration.value = String(prefs.durationMinutes || 60);
  if (els.smartDaysForward) els.smartDaysForward.value = String(prefs.daysForward || 7);
  if (els.smartWindowStart) els.smartWindowStart.value = prefs.windowStart || "08:00";
  if (els.smartWindowEnd) els.smartWindowEnd.value = prefs.windowEnd || "18:00";
  if (els.smartPreference) els.smartPreference.value = prefs.preference || "none";
  if (els.smartBuffer) els.smartBuffer.value = String(prefs.bufferMinutes ?? 15);
  if (els.smartMaxSuggestions) els.smartMaxSuggestions.value = String(prefs.maxSuggestions || 5);
}

function readSmartPrefsFromInputs() {
  return {
    title: (els.smartTitle?.value || "").trim() || DEFAULT_SMART_PREFS.title,
    date: els.smartDate?.value || toInputDate(new Date()),
    durationMinutes: clamp(parseInt(els.smartDuration?.value || "60", 10), 5, 24 * 60),
    daysForward: clamp(parseInt(els.smartDaysForward?.value || "7", 10), 1, 14),
    windowStart: els.smartWindowStart?.value || "08:00",
    windowEnd: els.smartWindowEnd?.value || "18:00",
    preference: els.smartPreference?.value || "none",
    bufferMinutes: clamp(parseInt(els.smartBuffer?.value || "15", 10), 0, 120),
    maxSuggestions: clamp(parseInt(els.smartMaxSuggestions?.value || "5", 10), 1, 10),
  };
}

function saveSmartPrefsFromInputs() {
  const prefs = readSmartPrefsFromInputs();
  state.smartPrefs = prefs;
  saveLocal(SMART_PREFS_KEY, prefs);
  return prefs;
}

function applyPreferencesToInputs() {
  if (!els.prefWindowStart) return;
  const prefs = state.preferences || DEFAULT_PREFS_UI;
  els.prefWindowStart.value = prefs.windowStart || DEFAULT_PREFS_UI.windowStart;
  els.prefWindowEnd.value = prefs.windowEnd || DEFAULT_PREFS_UI.windowEnd;
  els.prefBufferMinutes.value = String(Number.isFinite(Number(prefs.bufferMinutes)) ? prefs.bufferMinutes : DEFAULT_PREFS_UI.bufferMinutes);
  const preferred = derivePreferredTimeOfDayLocal(prefs.timeOfDayWeights);
  els.prefTimeOfDay.value = preferred || "auto";
}

function readPreferencesFromInputs() {
  const windowStart = els.prefWindowStart?.value || DEFAULT_PREFS_UI.windowStart;
  const windowEnd = els.prefWindowEnd?.value || DEFAULT_PREFS_UI.windowEnd;
  const bufferMinutes = clamp(parseInt(els.prefBufferMinutes?.value || String(DEFAULT_PREFS_UI.bufferMinutes), 10), 0, 120);
  const timeOfDay = els.prefTimeOfDay?.value || "auto";

  const payload = {
    windowStart,
    windowEnd,
    bufferMinutes,
  };

  if (timeOfDay !== "auto") {
    payload.timeOfDayWeights = {
      morning: timeOfDay === "morning" ? 1 : 0,
      afternoon: timeOfDay === "afternoon" ? 1 : 0,
      evening: timeOfDay === "evening" ? 1 : 0,
    };
  }
  return payload;
}

async function savePreferencesFromInputs() {
  if (!els.prefSaveBtn) return;
  state.preferencesSaving = true;
  els.prefSaveBtn.disabled = true;
  renderPreferences();

  try {
    const payload = readPreferencesFromInputs();
    const res = await apiPatch("/api/preferences", payload);
    if (res?.ok) {
      state.preferences = res.preferences || state.preferences;
      state.preferencesError = null;
      state.preferencesLoadedAt = Date.now();
      applyPreferencesToInputs();
      if (els.prefStatus) els.prefStatus.textContent = "Präferenzen gespeichert ✅";
    } else {
      throw new Error(res?.message || "Speichern fehlgeschlagen");
    }
  } catch (e) {
    const msg = String(e?.message || "Speichern fehlgeschlagen");
    state.preferencesError = msg;
    if (els.prefStatus) els.prefStatus.textContent = `Fehler: ${msg}`;
  } finally {
    state.preferencesSaving = false;
    els.prefSaveBtn.disabled = false;
    renderPreferences();
  }
}

function renderPreferences() {
  if (!els.prefStatus) return;
  const pref = state.preferences || DEFAULT_PREFS_UI;
  const learning = state.learning || {};
  const preferred = derivePreferredTimeOfDayLocal(pref.timeOfDayWeights);
  const preferredLabel = preferred ? timeOfDayLabel(preferred) : "Automatisch";
  const lastUpdated = pref?.lastUpdated ? fmtDateTime(new Date(pref.lastUpdated)) : "—";

  if (state.preferencesSaving) {
    els.prefStatus.textContent = "Speichere Präferenzen…";
  } else {
    els.prefStatus.textContent = state.preferencesError
      ? `Fehler: ${state.preferencesError}`
      : `Zuletzt aktualisiert: ${lastUpdated}`;
  }

  if (els.prefLearningSummary) {
    els.prefLearningSummary.textContent =
      `Bevorzugt: ${preferredLabel} • Akzeptierte Vorschläge: ${learning?.acceptedSuggestions ?? 0}`;
  }

  if (els.prefLearningDetails) {
    els.prefLearningDetails.innerHTML = "";
    const details = [
      { label: "Letzte Interaktion", value: learning?.lastInteractionAt ? fmtDateTime(new Date(learning.lastInteractionAt)) : "—" },
      { label: "Morgens", value: Math.round((pref?.timeOfDayWeights?.morning || 0) * 100) + "%" },
      { label: "Nachmittags", value: Math.round((pref?.timeOfDayWeights?.afternoon || 0) * 100) + "%" },
      { label: "Abends", value: Math.round((pref?.timeOfDayWeights?.evening || 0) * 100) + "%" },
    ];
    details.forEach((row) => {
      const item = document.createElement("div");
      item.className = "item";
      item.innerHTML = `<div class="itemTitle">${row.label}</div><div class="itemMeta">${row.value}</div>`;
      els.prefLearningDetails.appendChild(item);
    });
  }
}

function renderSmartSuggestions() {
  if (!els.smartSuggestionList) return;
  els.smartSuggestionList.innerHTML = "";

  if (els.smartPreferenceSummary) {
    const applied = state.smartAppliedPreferences;
    if (applied) {
      const label = applied.timeOfDay && applied.timeOfDay !== "none"
        ? timeOfDayLabel(applied.timeOfDay)
        : "Keine Präferenz";
      const sourceLabel = applied.source === "learned" ? "gelernt" : applied.source === "user" ? "manuell" : "neutral";
      const habitHour = Number.isFinite(state.smartHabits?.leastBusyHour)
        ? ` • Ruhigste Stunde: ${pad2(state.smartHabits.leastBusyHour)}:00`
        : "";
      els.smartPreferenceSummary.textContent =
        `Berücksichtigte Präferenz: ${label} (${sourceLabel}) • Fenster ${applied.windowStart}–${applied.windowEnd} • Puffer ${applied.bufferMinutes} Min${habitHour}`;
    } else {
      els.smartPreferenceSummary.textContent = "Präferenzen werden beim Laden der Vorschläge berücksichtigt.";
    }
  }

  if (state.smartSuggestionsLoading) {
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `<div class="itemTitle">Lade smarte Vorschläge…</div><div class="itemMeta">Bitte kurz warten.</div>`;
    els.smartSuggestionList.appendChild(item);
    return;
  }

  if (state.smartSuggestionsError) {
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `<div class="itemTitle">Keine Vorschläge verfügbar</div><div class="itemMeta">${state.smartSuggestionsError}</div>`;
    els.smartSuggestionList.appendChild(item);
    return;
  }

  const suggestions = Array.isArray(state.smartSuggestions) ? state.smartSuggestions : [];
  if (suggestions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "item";
    empty.innerHTML = `<div class="itemTitle">Noch keine Vorschläge</div><div class="itemMeta">Passe Präferenzen an und lade Vorschläge.</div>`;
    els.smartSuggestionList.appendChild(empty);
    return;
  }

  suggestions.forEach((suggestion) => {
    const start = suggestion?.start ? new Date(suggestion.start) : null;
    const end = suggestion?.end ? new Date(suggestion.end) : null;
    const hasStart = start && !Number.isNaN(start.getTime());
    const hasEnd = end && !Number.isNaN(end.getTime());
    const duration = hasStart && hasEnd ? Math.round((end - start) / 60000) : null;

    const item = document.createElement("div");
    item.className = "item";

    const top = document.createElement("div");
    top.className = "itemTop";

    const title = document.createElement("div");
    title.className = "itemTitle";
    title.textContent = hasStart ? `${fmtDate(start)} • ${fmtTime(start)}–${fmtTime(end)}` : "Vorschlag";

    const actions = document.createElement("div");
    actions.className = "itemActions";

    const selectBtn = document.createElement("button");
    selectBtn.className = "btn small primary";
    selectBtn.type = "button";
    selectBtn.textContent = "Auswählen";
    selectBtn.addEventListener("click", () => {
      const request = { title: state.smartPrefs?.title || DEFAULT_SMART_PREFS.title };
      openSuggestionModalWithPreselect([suggestion], request, suggestion.id);
    });
    actions.appendChild(selectBtn);

    top.appendChild(title);
    top.appendChild(actions);

    const meta = document.createElement("div");
    meta.className = "itemMeta";
    const parts = [];
    if (duration) parts.push(`${duration} min`);
    if (suggestion?.reason) parts.push(String(suggestion.reason));
    meta.textContent = parts.join(" • ");

    item.appendChild(top);
    item.appendChild(meta);
    els.smartSuggestionList.appendChild(item);
  });
}

function renderSmartOptimizations() {
  if (!els.smartOptimizationList) return;
  els.smartOptimizationList.innerHTML = "";

  const tips = Array.isArray(state.smartOptimizations) ? state.smartOptimizations : [];
  if (tips.length === 0) {
    const empty = document.createElement("div");
    empty.className = "item";
    empty.innerHTML = `<div class="itemTitle">Noch keine Optimierungen</div><div class="itemMeta">Lade smarte Vorschläge, um Hinweise zu erhalten.</div>`;
    els.smartOptimizationList.appendChild(empty);
    return;
  }

  tips.forEach((tip) => {
    const item = document.createElement("div");
    item.className = "item";
    const title = document.createElement("div");
    title.className = "itemTitle";
    title.textContent = tip?.title || "Tipp";
    const meta = document.createElement("div");
    meta.className = "itemMeta";
    meta.textContent = tip?.message || "";
    item.appendChild(title);
    item.appendChild(meta);
    els.smartOptimizationList.appendChild(item);
  });
}

function renderMonitoring() {
  if (!els.monitoringList || !els.monitoringStatus || !els.monitoringIssues) return;
  els.monitoringList.innerHTML = "";
  els.monitoringIssues.innerHTML = "";

  if (state.monitoringLoading) {
    els.monitoringStatus.textContent = "Monitoring wird geladen…";
    return;
  }

  if (state.monitoringError) {
    els.monitoringStatus.textContent = `Monitoring nicht verfügbar: ${state.monitoringError}`;
    return;
  }

  const monitoring = state.monitoring;
  if (!monitoring) {
    els.monitoringStatus.textContent = "Noch keine Monitoring-Daten.";
    return;
  }

  const uptimeMin = Math.round((monitoring.uptimeSeconds || 0) / 60);
  const errorRate = monitoring.requestCount
    ? Math.round((monitoring.errorCount / monitoring.requestCount) * 1000) / 10
    : 0;
  const healthy = errorRate < 2 && (monitoring.p95ResponseMs || 0) < 1200;

  els.monitoringStatus.innerHTML = `
    <span class="infoPill ${healthy ? "ok" : "warn"}">${healthy ? "Stabil" : "Beobachten"}</span>
    <span class="infoPill">${uptimeMin} Min Uptime</span>
    <span class="infoPill">Ø ${monitoring.avgResponseMs || 0} ms</span>
  `;

  const rows = [
    { label: "Requests gesamt", value: monitoring.requestCount ?? 0 },
    { label: "Fehlerquote", value: `${errorRate}%` },
    { label: "P95 Latenz", value: `${monitoring.p95ResponseMs || 0} ms` },
    { label: "Langsame Requests", value: monitoring.slowRequestCount ?? 0 },
  ];

  rows.forEach((row) => {
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `<div class="itemTitle">${row.label}</div><div class="itemMeta">${row.value}</div>`;
    els.monitoringList.appendChild(item);
  });

  const issues = [];
  const lastErrors = Array.isArray(monitoring.lastErrors) ? monitoring.lastErrors : [];
  const lastSlow = Array.isArray(monitoring.lastSlow) ? monitoring.lastSlow : [];

  lastErrors.forEach((entry) => {
    issues.push({
      title: `Fehler ${entry.status || ""}`.trim(),
      meta: `${entry.method || "?"} ${entry.path || ""} • ${entry.durationMs || 0} ms`,
      at: entry.at ? fmtDateTime(new Date(entry.at)) : "",
    });
  });

  lastSlow.forEach((entry) => {
    issues.push({
      title: "Langsame Antwort",
      meta: `${entry.method || "?"} ${entry.path || ""} • ${entry.durationMs || 0} ms`,
      at: entry.at ? fmtDateTime(new Date(entry.at)) : "",
    });
  });

  if (!issues.length) {
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `<div class="itemTitle">Keine Auffälligkeiten</div><div class="itemMeta">System läuft stabil.</div>`;
    els.monitoringIssues.appendChild(item);
    return;
  }

  issues.slice(0, 6).forEach((issue) => {
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `<div class="itemTitle">${issue.title}</div><div class="itemMeta">${issue.meta}${issue.at ? ` • ${issue.at}` : ""}</div>`;
    els.monitoringIssues.appendChild(item);
  });
}

function openEditEventModal(event) {
  if (!event) return;
  closeSidebarDrawer();
  const eventId = getGoogleEventId(event);
  if (!eventId) {
    uiNotify("error", "Kein Google-Event gefunden.");
    return;
  }

  state.editingEvent = { ...event, _eventId: eventId };

  const start = event?.start ? new Date(event.start) : null;
  const end = event?.end ? new Date(event.end) : null;
  const hasStart = start && !Number.isNaN(start.getTime());
  const hasEnd = end && !Number.isNaN(end.getTime());

  const durationMin = hasStart && hasEnd
    ? clamp(Math.round((end - start) / 60000), 5, 24 * 60)
    : 60;

  if (els.editEventTitle) els.editEventTitle.value = event?.title || event?.summary || "";
  if (els.editEventDate) els.editEventDate.value = hasStart ? toInputDate(start) : "";
  if (els.editEventStartTime) els.editEventStartTime.value = hasStart ? toInputTime(start) : "";
  if (els.editEventDuration) els.editEventDuration.value = String(durationMin);
  if (els.editEventLocation) els.editEventLocation.value = event?.location || "";
  if (els.editEventNotes) els.editEventNotes.value = event?.notes || event?.description || "";

  els.editEventBackdrop?.classList.remove("hidden");
  els.editEventModal?.classList.remove("hidden");
}

function closeEditEventModal() {
  state.editingEvent = null;
  els.editEventBackdrop?.classList.add("hidden");
  els.editEventModal?.classList.add("hidden");
}

function openEventDetailModal(event) {
  if (!event) return;
  state.detailEvent = event;
  renderEventDetailModal(event);
  els.eventDetailBackdrop?.classList.remove("hidden");
  els.eventDetailModal?.classList.remove("hidden");
  setTimeout(() => els.eventDetailCloseBtn?.focus(), 0);
}

function closeEventDetailModal() {
  state.detailEvent = null;
  els.eventDetailBackdrop?.classList.add("hidden");
  els.eventDetailModal?.classList.add("hidden");
}

function renderEventDetailModal(event) {
  const start = event?.start ? new Date(event.start) : null;
  const end = event?.end ? new Date(event.end) : null;
  const hasStart = start && !Number.isNaN(start.getTime());
  const hasEnd = end && !Number.isNaN(end.getTime());
  const durationMin = hasStart && hasEnd ? Math.max(5, Math.round((end - start) / 60000)) : null;
  const notes = (event?.notes || event?.description || "").trim();

  if (els.eventDetailTitle) {
    els.eventDetailTitle.textContent = event?.title || event?.summary || "Termin";
  }
  if (els.eventDetailDate) {
    els.eventDetailDate.textContent = hasStart ? fmtDate(start) : "-";
  }
  if (els.eventDetailStart) {
    els.eventDetailStart.textContent = hasStart ? fmtTime(start) : "-";
  }
  if (els.eventDetailEnd) {
    els.eventDetailEnd.textContent = hasEnd ? fmtTime(end) : "-";
  }
  if (els.eventDetailDuration) {
    els.eventDetailDuration.textContent = durationMin ? formatDurationMinutes(durationMin) : "-";
  }
  if (els.eventDetailNotes) {
    els.eventDetailNotes.value = notes;
  }
  const eventId = getGoogleEventId(event);
  if (els.eventDetailDeleteBtn) {
    els.eventDetailDeleteBtn.disabled = !eventId || deletingEvents.has(eventId);
  }
}

async function saveEditEvent() {
  const editing = state.editingEvent;
  if (editing?._assistantDraft) {
    const title = (els.editEventTitle?.value || "").trim();
    const dateStr = els.editEventDate?.value || "";
    const timeStr = els.editEventStartTime?.value || "";
    const durationMin = clamp(parseInt(els.editEventDuration?.value || "60", 10), 5, 24 * 60);
    const location = (els.editEventLocation?.value || "").trim();
    const notes = (els.editEventNotes?.value || "").trim();

    if (!title || !dateStr || !timeStr || !durationMin) {
      uiNotify("error", "Bitte Titel, Datum, Startzeit und Dauer ausfüllen.");
      return;
    }

    const proposal = {
      intent: "create_event",
      confidence: 1,
      event: {
        title,
        dateISO: dateStr,
        startTime: timeStr,
        endTime: null,
        durationMin,
        allDay: false,
        location,
        description: notes,
      },
      questions: [],
    };

    const btn = els.saveEditEventBtn;
    const oldText = btn?.textContent || "Speichern";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Erstelle…";
      btn.setAttribute("aria-busy", "true");
    }
    uiNotify("info", "Erstelle Termin…");

    try {
      const createdRes = await apiPost("/api/assistant/commit", {
        proposal,
        provider: editing._assistantProvider || determineAssistantProvider(),
      });
      const createdEvent = createdRes?.createdEvent || null;
      if (createdEvent) {
        state.events = Array.isArray(state.events) ? state.events : [];
        state.events.unshift(createdEvent);
      }
      await refreshFromApi();
      await render();
      closeEditEventModal();
      resetAssistantUi();
      uiNotify("success", "Termin erstellt");
    } catch (e) {
      const status = e?._meta?.status;
      if (status === 401) {
        await refreshFromApi();
        updateGoogleButtons();
        uiNotify("error", "Google nicht verbunden – bitte verbinden");
        return;
      }
      uiNotify("error", `Fehler beim Erstellen: ${e?.message || "unbekannt"}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText;
        btn.removeAttribute("aria-busy");
      }
    }
    return;
  }

  const eventId = editing?._eventId || getGoogleEventId(editing);

  if (!eventId) {
    uiNotify("error", "Kein Event ausgewählt.");
    return;
  }

  const title = (els.editEventTitle?.value || "").trim();
  const dateStr = els.editEventDate?.value || "";
  const timeStr = els.editEventStartTime?.value || "";
  const durationMin = clamp(parseInt(els.editEventDuration?.value || "60", 10), 5, 24 * 60);
  const location = (els.editEventLocation?.value || "").trim();
  const notes = (els.editEventNotes?.value || "").trim();

  if (!title || !dateStr || !timeStr || !durationMin) {
    uiNotify("error", "Bitte Titel, Datum, Startzeit und Dauer ausfüllen.");
    return;
  }

  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  const startLocal = new Date(year, (month || 1) - 1, day || 1, hour || 0, minute || 0, 0, 0);
  const endLocal = addMinutes(new Date(startLocal), durationMin);

  const start = toLocalIsoWithOffset(startLocal);
  const end = toLocalIsoWithOffset(endLocal);

  const btn = els.saveEditEventBtn;
  const oldText = btn?.textContent || "Speichern";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Speichere…";
    btn.setAttribute("aria-busy", "true");
  }
  uiNotify("info", "Speichere Änderungen…");

  try {
    await apiPatch(`/api/google/events/${encodeURIComponent(eventId)}`, {
      title,
      start,
      end,
      location,
      notes,
    });

    uiNotify("success", "Gespeichert");
    closeEditEventModal();

    const eventsRes = await apiGetGoogleEvents(GCAL_DAYS_PAST, GCAL_DAYS_FUTURE);
    if (eventsRes?.ok && Array.isArray(eventsRes.events)) {
      state.events = eventsRes.events;
      saveLastKnownGoogleEvents(state.events);
    }

    await render();
  } catch (e) {
    const status = e?._meta?.status;
    const msg = String(e?.message || "");
    if (status === 401 || msg.toLowerCase().includes("google nicht verbunden")) {
      uiNotify("error", "Google nicht verbunden – bitte verbinden");
      return;
    }
    uiNotify("error", `Fehler beim Speichern: ${msg || "unbekannt"}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText;
      btn.removeAttribute("aria-busy");
    }
  }
}

function updateQuadrantUI() {
  const q = computeQuadrant(els.imp.checked, els.urg.checked);
  els.quadrantBadge.textContent = q.label;
  els.quadrantHint.textContent = q.hint;
}

function resetCreateEventForm() {
  if (!els.eventTitle) return;
  els.eventTitle.value = "";
  if (els.eventDate) els.eventDate.value = "";
  if (els.eventStartTime) els.eventStartTime.value = "";
  if (els.eventDuration) els.eventDuration.value = "60";
  if (els.eventLocation) els.eventLocation.value = "";
  if (els.eventNotes) els.eventNotes.value = "";
}

async function applyCreatedEvent(createdRes, fallbackTitle) {
  const createdEvent = extractEventFromQuickAddResponse(createdRes, fallbackTitle);

  if (createdEvent) {
    state.events = Array.isArray(state.events) ? state.events : [];
    const createdKey = getGoogleEventId(createdEvent) || createdEvent.id;
    const existingIdx = createdKey
      ? state.events.findIndex((ev) => (getGoogleEventId(ev) || ev.id) === createdKey)
      : -1;
    if (existingIdx >= 0) {
      state.events[existingIdx] = { ...state.events[existingIdx], ...createdEvent };
    } else {
      state.events.unshift(createdEvent);
    }
  }

  const eventsRes = await apiGetGoogleEvents(GCAL_DAYS_PAST, GCAL_DAYS_FUTURE);
  if (eventsRes?.ok && Array.isArray(eventsRes.events)) {
    state.events = eventsRes.events;
    saveLastKnownGoogleEvents(state.events);
  } else if (createdEvent) {
    saveLastKnownGoogleEvents(state.events);
  }

  await render();
  return createdEvent;
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

// -------------------- Create structured event --------------------
async function createEventFromForm() {
  if (!state.google?.configured) {
    setStatus('Google OAuth ist im Backend nicht konfiguriert. (Render ENV prüfen)', false);
    uiNotify('error', 'Google OAuth ist im Backend nicht konfiguriert.');
    return;
  }

  if (!state.google?.connected || state.google?.wrongAccount) {
    if (state.google?.wrongAccount) {
      setStatus('Falscher Google-Account – bitte mit dem erlaubten Konto verbinden.', false);
      uiNotify('error', 'Falscher Google-Account');
    } else {
      setStatus('Google ist nicht (korrekt) verbunden. Bitte oben auf "Mit Google verbinden" klicken.', false);
      uiNotify('error', 'Google nicht verbunden – bitte verbinden');
    }
    try { els.googleConnectBtn?.focus?.(); } catch {}
    return;
  }

  const title = (els.eventTitle?.value || "").trim();
  const dateStr = els.eventDate?.value || "";
  const timeStr = els.eventStartTime?.value || "";
  const durationMin = clamp(parseInt(els.eventDuration?.value || "60", 10), 5, 24 * 60);
  const location = (els.eventLocation?.value || "").trim();
  const notes = (els.eventNotes?.value || "").trim();

  if (!title || !dateStr || !timeStr || !durationMin) {
    setStatus("Bitte Titel, Datum, Startzeit und Dauer ausfüllen.", false);
    uiNotify('error', 'Bitte Titel, Datum, Startzeit und Dauer ausfüllen.');
    return;
  }

  const btn = els.createEventFormBtn;
  const oldText = btn?.textContent || "Termin erstellen";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Suche Vorschläge…";
    btn.setAttribute('aria-busy', 'true');
  }
  uiNotify('info', 'Lädt… suche freie Slots.');
  setSyncLoading(true, "Lädt… suche freie Slots");

  try {
    const suggestionsRes = await apiPost('/api/event-suggestions', {
      title,
      date: dateStr,
      preferredTime: timeStr,
      durationMinutes: durationMin,
      location,
      notes,
    });

    if (suggestionsRes?.ok && Array.isArray(suggestionsRes.suggestions)) {
      if (suggestionsRes.suggestions.length === 0) {
        uiNotify('error', 'Keine freien Slots gefunden. Bitte Datum oder Dauer anpassen.');
        setStatus('Keine freien Slots gefunden.', false);
      } else {
        openSuggestionModal(suggestionsRes.suggestions, {
          title,
          date: dateStr,
          preferredTime: timeStr,
          durationMinutes: durationMin,
          location,
          notes,
        });
      }
    } else {
      throw new Error('Keine Vorschläge erhalten');
    }
  } catch (e) {
    const status = e?._meta?.status;
    const msg = String(e?.message || "");
    const lower = msg.toLowerCase();

    if (status === 401 || msg.includes("GOOGLE_NOT_CONNECTED") || lower.includes("nicht verbunden")) {
      await refreshFromApi();
      updateGoogleButtons();
      setStatus('Google nicht verbunden – bitte verbinden.', false);
      uiNotify('error', 'Google nicht verbunden – bitte verbinden');
      try { els.googleConnectBtn?.focus?.(); } catch {}
    } else {
      const short = msg.split("\n")[0].slice(0, 160);
      setStatus(`Fehler beim Erstellen: ${short}`, false);
      uiNotify('error', `Fehler beim Erstellen: ${short}`);
    }
  } finally {
    setSyncLoading(false);
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText;
      btn.removeAttribute('aria-busy');
    }
  }
}

async function confirmSuggestedEvent() {
  if (!state.selectedSuggestionId) {
    uiNotify('error', 'Bitte einen Vorschlag auswählen.');
    return;
  }

  const btn = els.suggestionConfirmBtn;
  const oldText = btn?.textContent || "Termin erstellen";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Erstelle…";
    btn.setAttribute('aria-busy', 'true');
  }
  uiNotify('info', 'Lädt… Termin wird erstellt.');
  setSyncLoading(true, "Lädt… Termin wird erstellt");

  try {
    const createdRes = await apiPost('/api/event-suggestions/confirm', {
      suggestionId: state.selectedSuggestionId,
    });

    await applyCreatedEvent(createdRes, state.eventSuggestionRequest?.title || "Termin");
    uiNotify('success', 'Termin erstellt');
    resetCreateEventForm();
    closeSuggestionModal();
    if (isMobile()) {
      closeSidebarDrawer();
    }
  } catch (e) {
    const status = e?._meta?.status;
    const msg = String(e?.message || "");
    const lower = msg.toLowerCase();

    if (status === 401 || msg.includes("GOOGLE_NOT_CONNECTED") || lower.includes("nicht verbunden")) {
      await refreshFromApi();
      updateGoogleButtons();
      setStatus('Google nicht verbunden – bitte verbinden.', false);
      uiNotify('error', 'Google nicht verbunden – bitte verbinden');
      try { els.googleConnectBtn?.focus?.(); } catch {}
    } else {
      const short = msg.split("\n")[0].slice(0, 160);
      setStatus(`Fehler beim Erstellen: ${short}`, false);
      uiNotify('error', `Fehler beim Erstellen: ${short}`);
    }
  } finally {
    setSyncLoading(false);
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText;
      btn.removeAttribute('aria-busy');
    }
  }
}

async function loadFreeSlots() {
  const dateStr = els.freeSlotDate?.value || "";
  const durationMinutes = clamp(parseInt(els.freeSlotDuration?.value || "60", 10), 5, 24 * 60);
  const daysForward = clamp(parseInt(els.freeSlotDaysForward?.value || "5", 10), 1, 14);

  if (!dateStr) {
    uiNotify("error", "Bitte ein Startdatum auswählen.");
    return;
  }

  const btn = els.freeSlotFindBtn;
  const oldText = btn?.textContent || "Freie Zeiten finden";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Suche…";
  }

  uiNotify("info", "Lädt… freie Zeiten werden gesucht.");
  setSyncLoading(true, "Lädt… freie Zeiten werden gesucht");

  try {
    const res = await apiPost("/api/free-slots", {
      date: dateStr,
      durationMinutes,
      daysForward,
      windowStart: `${pad2(state.viewStartHour)}:00`,
      windowEnd: `${pad2(state.viewEndHour)}:00`,
      stepMinutes: state.stepMinutes,
      maxSlots: 8,
    });

    if (res?.ok && Array.isArray(res.slots)) {
      state.freeSlots = res.slots;
      renderFreeSlotList();
      if (res.slots.length === 0) {
        uiNotify("error", "Keine freien Slots gefunden.");
      }
    } else {
      throw new Error("Keine freien Slots erhalten");
    }
  } catch (e) {
    const msg = String(e?.message || "");
    uiNotify("error", `Fehler beim Laden der freien Slots: ${msg || "unbekannt"}`);
  } finally {
    setSyncLoading(false);
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }
}

async function loadSmartSuggestions() {
  const prefs = saveSmartPrefsFromInputs();
  if (!prefs.title) {
    uiNotify("error", "Bitte einen Titel für die Vorschläge eingeben.");
    return;
  }

  state.smartSuggestionsLoading = true;
  state.smartSuggestionsError = null;
  renderSmartSuggestions();
  renderSmartOptimizations();

  try {
    const res = await apiPost("/api/smart-suggestions", prefs);
    if (res?.ok) {
      state.smartSuggestions = Array.isArray(res.suggestions) ? res.suggestions : [];
      state.smartOptimizations = Array.isArray(res.optimizations) ? res.optimizations : [];
      state.smartAppliedPreferences = res.appliedPreferences || null;
      state.smartHabits = res.habits || null;
    } else {
      throw new Error(res?.message || "Keine Vorschläge erhalten");
    }
  } catch (e) {
    const msg = String(e?.message || "Fehler beim Laden");
    state.smartSuggestionsError = msg;
    state.smartSuggestions = [];
    state.smartOptimizations = [];
    state.smartAppliedPreferences = null;
    state.smartHabits = null;
  } finally {
    state.smartSuggestionsLoading = false;
    renderSmartSuggestions();
    renderSmartOptimizations();
  }
}

async function approveFreeSlot(slot) {
  if (!slot?.id) {
    uiNotify("error", "Slot ungültig.");
    return;
  }

  try {
    const res = await apiPost("/api/free-slots/approve", { slotId: slot.id });
    if (res?.ok && Array.isArray(res.approvedSlots)) {
      state.approvedFreeSlots = res.approvedSlots;
      state.freeSlots = state.freeSlots.filter((s) => s.id !== slot.id);
      renderFreeSlotList();
      renderApprovedSlotList();
      uiNotify("success", "Slot freigegeben.");
    } else {
      throw new Error("Slot konnte nicht freigegeben werden");
    }
  } catch (e) {
    const msg = String(e?.message || "");
    uiNotify("error", `Fehler beim Freigeben: ${msg || "unbekannt"}`);
  }
}

async function confirmFreeSlot(slot) {
  const title = (els.freeSlotTitle?.value || "").trim();
  if (!title) {
    uiNotify("error", "Bitte einen Titel für den Termin eingeben.");
    return;
  }
  if (!slot?.id) {
    uiNotify("error", "Slot ungültig.");
    return;
  }

  uiNotify("info", "Lädt… Termin wird erstellt.");
  setSyncLoading(true, "Lädt… Termin wird erstellt");

  try {
    const createdRes = await apiPost("/api/free-slots/confirm", {
      slotId: slot.id,
      title,
    });
    await applyCreatedEvent(createdRes, title);
    if (Array.isArray(createdRes?.approvedSlots)) {
      state.approvedFreeSlots = createdRes.approvedSlots;
    } else {
      state.approvedFreeSlots = state.approvedFreeSlots.filter((s) => s.id !== slot.id);
    }
    renderApprovedSlotList();
    uiNotify("success", "Termin erstellt");
  } catch (e) {
    const msg = String(e?.message || "");
    uiNotify("error", `Fehler beim Erstellen: ${msg || "unbekannt"}`);
  } finally {
    setSyncLoading(false);
  }
}

// -------------------- Event Quick-Add --------------------
function getUserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Zurich";
  } catch {
    return "Europe/Zurich";
  }
}

function getTodayISOInTimeZone(timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(new Date());
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // ignore
  }
  return new Date().toISOString().slice(0, 10);
}

function determineAssistantProvider() {
  if (state.google?.connected && !state.google?.wrongAccount) {
    return "google";
  }
  return "local";
}

function normalizeAssistantProposal(proposal) {
  const safe = proposal && typeof proposal === "object" ? proposal : {};
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

function assistantHasRequiredFields(proposal) {
  const event = proposal?.event || {};
  const hasTitle = !!event.title;
  const hasDate = !!event.dateISO;
  const hasStart = !!event.startTime;
  const hasAllDay = !!event.allDay;
  const hasEndOrDuration = !!event.endTime || Number.isFinite(event.durationMin);
  return hasTitle && hasDate && (hasStart || hasAllDay) && (hasEndOrDuration || hasAllDay);
}

function buildLocalDateTimeFromIso(dateISO, timeStr) {
  if (!dateISO || !timeStr) return null;
  const [year, month, day] = String(dateISO).split("-").map(Number);
  const [hour, minute] = String(timeStr).split(":").map(Number);
  if (!year || !month || !day || Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return new Date(year, (month || 1) - 1, day || 1, hour || 0, minute || 0, 0, 0);
}

function formatAssistantTimeRange(event) {
  if (!event?.dateISO) return "-";
  const locale = navigator.language || "de-CH";
  if (event.allDay) {
    const date = buildLocalDateTimeFromIso(event.dateISO, "00:00");
    const dayLabel = date ? date.toLocaleDateString(locale) : event.dateISO;
    return `${dayLabel} • Ganztägig`;
  }
  const start = event.startTime ? buildLocalDateTimeFromIso(event.dateISO, event.startTime) : null;
  const end = event.endTime
    ? buildLocalDateTimeFromIso(event.dateISO, event.endTime)
    : event.durationMin && start
    ? addMinutes(new Date(start), event.durationMin)
    : null;
  const dateLabel = start ? start.toLocaleDateString(locale) : event.dateISO;
  const startLabel = start ? fmtTime(start) : "-";
  const endLabel = end ? fmtTime(end) : "-";
  return `${dateLabel} • ${startLabel} – ${endLabel}`;
}

function resetAssistantUi() {
  if (els.assistantClarify) els.assistantClarify.classList.add("hidden");
  if (els.assistantPreview) els.assistantPreview.classList.add("hidden");
  if (els.assistantNone) els.assistantNone.classList.add("hidden");
  if (els.assistantQuestionList) els.assistantQuestionList.textContent = "";
  if (els.assistantAnswer) els.assistantAnswer.value = "";
  if (els.assistantPreviewTitle) els.assistantPreviewTitle.textContent = "";
  if (els.assistantPreviewTime) els.assistantPreviewTime.textContent = "";
  if (els.assistantPreviewLocation) els.assistantPreviewLocation.textContent = "";
  if (els.assistantPreviewDescription) els.assistantPreviewDescription.textContent = "";
  els.assistantPreviewLocationRow?.classList.add("hidden");
  els.assistantPreviewDescriptionRow?.classList.add("hidden");
  if (els.assistantCreateBtn) els.assistantCreateBtn.disabled = true;
}

function renderAssistantClarify(questions) {
  resetAssistantUi();
  const list = els.assistantQuestionList;
  if (list) {
    list.innerHTML = "";
    (questions || []).forEach((q) => {
      const div = document.createElement("div");
      div.textContent = `• ${q}`;
      list.appendChild(div);
    });
  }
  els.assistantClarify?.classList.remove("hidden");
  setTimeout(() => els.assistantAnswer?.focus(), 0);
}

function renderAssistantPreview(proposal) {
  resetAssistantUi();
  const event = proposal?.event || {};
  if (els.assistantPreviewTitle) els.assistantPreviewTitle.textContent = event.title || "-";
  if (els.assistantPreviewTime) els.assistantPreviewTime.textContent = formatAssistantTimeRange(event);
  if (event.location) {
    if (els.assistantPreviewLocation) els.assistantPreviewLocation.textContent = event.location;
    els.assistantPreviewLocationRow?.classList.remove("hidden");
  }
  if (event.description) {
    if (els.assistantPreviewDescription) els.assistantPreviewDescription.textContent = event.description;
    els.assistantPreviewDescriptionRow?.classList.remove("hidden");
  }
  if (els.assistantCreateBtn) {
    els.assistantCreateBtn.disabled = !assistantHasRequiredFields(proposal);
  }
  els.assistantPreview?.classList.remove("hidden");
}

function renderAssistantNone() {
  resetAssistantUi();
  els.assistantNone?.classList.remove("hidden");
}

async function requestAssistantParse(text) {
  const timeZone = getUserTimeZone();
  const locale = navigator.language || "de-CH";
  const referenceDateISO = getTodayISOInTimeZone(timeZone);
  return apiPost("/api/assistant/parse", {
    text,
    timezone: timeZone,
    locale,
    referenceDateISO,
  });
}

function handleAssistantResponse(raw, { originalText } = {}) {
  const proposal = normalizeAssistantProposal(raw);
  const provider = determineAssistantProvider();
  state.assistant = {
    originalText: originalText || state.assistant.originalText || "",
    proposal,
    intent: proposal.intent,
    questions: proposal.questions || [],
    provider,
  };

  if (proposal.intent === "clarify") {
    renderAssistantClarify(proposal.questions);
    return;
  }
  if (proposal.intent === "create_event") {
    renderAssistantPreview(proposal);
    return;
  }
  renderAssistantNone();
}

async function submitAssistantAnswer() {
  const answer = (els.assistantAnswer?.value || "").trim();
  if (!answer) {
    uiNotify("error", "Bitte Antwort eingeben.");
    els.assistantAnswer?.focus?.();
    return;
  }
  const original = state.assistant.originalText || (els.eventText?.value || "").trim();
  const followUpText = `${original}\nAntwort: ${answer}`;
  const btn = els.assistantAnswerBtn;
  const oldText = btn?.textContent || "Antwort senden";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sende…";
  }
  try {
    const parsed = await requestAssistantParse(followUpText);
    handleAssistantResponse(parsed, { originalText: original });
  } catch (e) {
    uiNotify("error", `Rückfrage fehlgeschlagen: ${e?.message || "unbekannt"}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }
}

async function commitAssistantProposal() {
  const proposal = state.assistant.proposal;
  if (!proposal || !assistantHasRequiredFields(proposal)) {
    uiNotify("error", "Bitte erst einen vollständigen Vorschlag auswählen.");
    return;
  }
  const provider = state.assistant.provider || "local";
  const btn = els.assistantCreateBtn;
  const oldText = btn?.textContent || "Erstellen";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Erstelle…";
  }
  uiNotify("info", "Lädt… Termin wird erstellt.");
  setSyncLoading(true, "Lädt… Termin wird erstellt");
  try {
    const createdRes = await apiPost("/api/assistant/commit", {
      proposal,
      provider,
    });
    const createdEvent = createdRes?.createdEvent || null;
    if (createdEvent) {
      state.events = Array.isArray(state.events) ? state.events : [];
      state.events.unshift(createdEvent);
    }
    await refreshFromApi();
    await render();
    uiNotify("success", "Termin erstellt");
    closeEventModal();
  } catch (e) {
    const status = e?._meta?.status;
    if (status === 401) {
      await refreshFromApi();
      updateGoogleButtons();
      uiNotify("error", "Google ist nicht (korrekt) verbunden – bitte erneut verbinden.");
      return;
    }
    uiNotify("error", `Erstellen fehlgeschlagen: ${e?.message || "unbekannt"}`);
  } finally {
    setSyncLoading(false);
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }
}

function openAssistantEditModal() {
  const proposal = state.assistant.proposal;
  const event = proposal?.event || {};
  if (!proposal) return;

  state.editingEvent = {
    _assistantDraft: true,
    _assistantProvider: state.assistant.provider || "local",
  };

  const dateISO = event.dateISO || "";
  const startTime = event.startTime || (event.allDay ? "00:00" : "");
  let durationMin = Number.isFinite(event.durationMin) ? event.durationMin : null;
  if (!durationMin && event.startTime && event.endTime) {
    const start = buildLocalDateTimeFromIso(event.dateISO, event.startTime);
    const end = buildLocalDateTimeFromIso(event.dateISO, event.endTime);
    if (start && end) {
      const raw = Math.round((end - start) / 60000);
      durationMin = raw > 0 ? raw : 60;
    }
  }
  if (event.allDay) {
    durationMin = 24 * 60;
  }

  if (els.editEventTitle) els.editEventTitle.value = event.title || "";
  if (els.editEventDate) els.editEventDate.value = dateISO;
  if (els.editEventStartTime) els.editEventStartTime.value = startTime;
  if (els.editEventDuration) els.editEventDuration.value = String(durationMin || 60);
  if (els.editEventLocation) els.editEventLocation.value = event.location || "";
  if (els.editEventNotes) els.editEventNotes.value = event.description || "";

  closeEventModal();
  els.editEventBackdrop?.classList.remove("hidden");
  els.editEventModal?.classList.remove("hidden");
  setTimeout(() => els.editEventTitle?.focus(), 0);
}

async function createEventFromText() {
  const text = (els.eventText.value || "").trim();
  if (!text) {
    setStatus('Bitte Event-Text eingeben (z.B. „Coiffeur morgen 13:00 60min“).', false);
    uiNotify("error", "❌ Bitte Event-Text eingeben");
    els.eventText.focus();
    return;
  }

  const btn = els.createEventBtn;
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Analysiere…";
  btn.setAttribute("aria-busy", "true");
  uiNotify("info", "Lädt… Vorschlag wird erstellt.");
  setSyncLoading(true, "Lädt… Vorschlag wird erstellt");

  try {
    const parsed = await requestAssistantParse(text);
    handleAssistantResponse(parsed, { originalText: text });
  } catch (e) {
    setStatus(`Vorschlag fehlgeschlagen ❌: ${e?.message || "unbekannt"}`, false);
    uiNotify("error", `❌ Vorschlag fehlgeschlagen: ${e?.message || "unbekannt"}`);
  } finally {
    setSyncLoading(false);
    btn.disabled = false;
    btn.textContent = oldText;
    btn.removeAttribute("aria-busy");
  }
}

function showUndoToast({ message, actionLabel = "Rückgängig", timeoutMs = 6500, onUndo }) {
  if (pendingUndoToast) {
    pendingUndoToast.remove();
    pendingUndoToast = null;
  }

  const toast = document.createElement("div");
  toast.setAttribute("role", "status");
  toast.style.position = "fixed";
  toast.style.left = "50%";
  toast.style.transform = "translateX(-50%)";
  toast.style.bottom = "18px";
  toast.style.zIndex = "99999";
  toast.style.padding = "10px 12px";
  toast.style.borderRadius = "12px";
  toast.style.background = "rgba(20, 20, 30, 0.95)";
  toast.style.color = "white";
  toast.style.fontWeight = "700";
  toast.style.fontSize = "14px";
  toast.style.maxWidth = "92vw";
  toast.style.boxShadow = "0 10px 24px rgba(0,0,0,0.35)";
  toast.style.display = "flex";
  toast.style.alignItems = "center";
  toast.style.gap = "10px";

  const text = document.createElement("span");
  text.textContent = message;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = actionLabel;
  btn.style.border = "0";
  btn.style.borderRadius = "999px";
  btn.style.padding = "6px 10px";
  btn.style.fontWeight = "700";
  btn.style.cursor = "pointer";
  btn.style.background = "rgba(91, 140, 255, 0.9)";
  btn.style.color = "white";

  toast.appendChild(text);
  toast.appendChild(btn);
  document.body.appendChild(toast);

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    toast.remove();
  };

  const timer = window.setTimeout(cleanup, timeoutMs);
  btn.addEventListener("click", () => {
    clearTimeout(timer);
    cleanup();
    if (typeof onUndo === "function") onUndo();
  });

  return { remove: cleanup };
}

async function deleteEvent(ev) {
  const eventId = getGoogleEventId(ev) || ev?.id;
  if (!eventId) {
    uiNotify("error", "Kein Event gefunden.");
    return;
  }

  if (!state.google?.connected) {
    uiNotify("error", "Google nicht verbunden – bitte verbinden");
    return;
  }

  if (deletingEvents.has(eventId)) return;

  deletingEvents.add(eventId);
  uiNotify("info", "Lösche Termin…");

  const snapshot = { ...ev };
  const previousEvents = Array.isArray(state.events) ? [...state.events] : [];
  state.events = previousEvents.filter((e) => (getGoogleEventId(e) || e.id) !== eventId);
  if (state.selectedEventId === eventId) clearSelectedEvent();
  await render();

  try {
    await apiDelete(`/api/google/events/${encodeURIComponent(eventId)}`);
    uiNotify("success", "Termin gelöscht");

    pendingUndoToast = showUndoToast({
      message: "Termin gelöscht.",
      onUndo: async () => {
        await undoDeleteEvent(snapshot);
      },
    });

    const eventsRes = await apiGetGoogleEvents(GCAL_DAYS_PAST, GCAL_DAYS_FUTURE);
    if (eventsRes?.ok && Array.isArray(eventsRes.events)) {
      state.events = eventsRes.events;
      saveLastKnownGoogleEvents(state.events);
      await render();
    }
  } catch (e) {
    const status = e?._meta?.status;
    const msg = String(e?.message || "");
    state.events = previousEvents;
    await render();
    if (status === 401 || msg.toLowerCase().includes("google nicht verbunden")) {
      uiNotify("error", "Google nicht verbunden – bitte verbinden");
      return;
    }
    uiNotify("error", `Fehler beim Löschen: ${msg || "unbekannt"}`);
  } finally {
    deletingEvents.delete(eventId);
    renderSideLists();
  }
}

async function undoDeleteEvent(ev) {
  if (!ev) return;
  if (!state.google?.connected) {
    uiNotify("error", "Google nicht verbunden – bitte verbinden");
    return;
  }

  const title = ev.title || ev.summary || "Termin";
  const startDate = ev.start ? new Date(ev.start) : null;
  const endDate = ev.end ? new Date(ev.end) : null;
  if (!startDate || Number.isNaN(startDate.getTime()) || !endDate || Number.isNaN(endDate.getTime())) {
    uiNotify("error", "Undo nicht möglich (fehlende Zeitdaten).");
    return;
  }

  uiNotify("info", "Stelle Termin wieder her…");
  try {
    await apiPost("/api/create-event", {
      title,
      start: toLocalIsoWithOffset(startDate),
      end: toLocalIsoWithOffset(endDate),
      location: ev.location || "",
      notes: ev.notes || ev.description || "",
    });

    const eventsRes = await apiGetGoogleEvents(GCAL_DAYS_PAST, GCAL_DAYS_FUTURE);
    if (eventsRes?.ok && Array.isArray(eventsRes.events)) {
      state.events = eventsRes.events;
      saveLastKnownGoogleEvents(state.events);
    }
    await render();
    uiNotify("success", "Termin wiederhergestellt");
  } catch (e) {
    const msg = String(e?.message || "");
    uiNotify("error", `Undo fehlgeschlagen: ${msg || "unbekannt"}`);
  }
}

async function persistEventMove(ev, newStart, newEnd) {
  const eventId = getGoogleEventId(ev) || ev?.id;
  if (!eventId) {
    uiNotify("error", "Kein Event gefunden.");
    return;
  }

  if (!state.google?.connected) {
    uiNotify("error", "Google nicht verbunden – bitte verbinden");
    return;
  }

  const startIso = toLocalIsoWithOffset(newStart);
  const endIso = toLocalIsoWithOffset(newEnd);
  const previousEvents = Array.isArray(state.events) ? [...state.events] : [];

  state.events = previousEvents.map((item) => {
    const id = getGoogleEventId(item) || item.id;
    if (id !== eventId) return item;
    return { ...item, start: startIso, end: endIso };
  });
  await render();

  uiNotify("info", "Speichere neue Zeit…");

  try {
    await apiPatch(`/api/google/events/${encodeURIComponent(eventId)}`, {
      title: ev.title || ev.summary || "Termin",
      start: startIso,
      end: endIso,
      location: ev.location || "",
      notes: ev.notes || ev.description || "",
    });

    uiNotify("success", "Termin verschoben");
    const eventsRes = await apiGetGoogleEvents(GCAL_DAYS_PAST, GCAL_DAYS_FUTURE);
    if (eventsRes?.ok && Array.isArray(eventsRes.events)) {
      state.events = eventsRes.events;
      saveLastKnownGoogleEvents(state.events);
      await render();
    }
  } catch (e) {
    const status = e?._meta?.status;
    const msg = String(e?.message || "");
    state.events = previousEvents;
    await render();
    if (status === 401 || msg.toLowerCase().includes("google nicht verbunden")) {
      uiNotify("error", "Google nicht verbunden – bitte verbinden");
      return;
    }
    uiNotify("error", `Fehler beim Verschieben: ${msg || "unbekannt"}`);
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

  let googleEventId = ev.googleEventId ? String(ev.googleEventId) : "";
  if (!googleEventId && typeof ev.id === "string" && ev.id.startsWith("gcal_")) {
    googleEventId = ev.id.slice(5);
  }
  if (!googleEventId && ev.id) {
    googleEventId = String(ev.id);
  }

  const rawId = ev.id ? String(ev.id) : "";
  const id = rawId || (googleEventId ? `gcal_${googleEventId}` : `tmp_${Math.random().toString(16).slice(2)}`);

  return {
    id,
    title,
    start,
    end,
    location: ev.location || "",
    notes: ev.notes || ev.description || "",
    googleEventId: googleEventId || undefined,
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

  const details = body?.kind === 'json' ? body.json?.details : null;
  const detailsText = details
    ? (typeof details === 'string' ? details : JSON.stringify(details))
    : '';
  const extra = [msg, detailsText].filter(Boolean).join(' • ');
  const clean = extra ? `${base} • ${extra}` : base;

  // Attach a minimal hint (no huge multi-line dumps in UI)
  const err = new Error(clean);
  err._meta = { method, url, status, statusText, body };
  return err;
}

function isGoogleNotConnected(body) {
  if (body?.kind !== "json") return false;
  const code = body.json?.error || body.json?.code;
  return code === "GOOGLE_NOT_CONNECTED";
}

function markGoogleDisconnected(reason = "Reconnect nötig") {
  state.google = {
    ...state.google,
    connected: false,
    hasTokens: false,
    watchActive: false,
    reason,
  };
  updateGoogleButtons();
  updateConnectionStatus();
}

function handleGoogleAuthError(res, body) {
  if (res?.status === 401 && isGoogleNotConnected(body)) {
    markGoogleDisconnected("Reconnect nötig");
    uiNotify("error", "Google nicht verbunden – bitte verbinden");
  }
}

async function apiGet(path) {
  const url = API_BASE_CLEAN + path;
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
  handleGoogleAuthError(res, body);

  // If JSON: allow { ok:false, message }
  if (res.ok && !(body.kind === 'json' && body.json?.ok === false)) {
    return body.kind === 'json' ? body.json : {};
  }

  throw makeApiError({ method: 'GET', url, status: res.status, statusText: res.statusText, body });
}

async function apiPost(path, bodyObj) {
  const url = API_BASE_CLEAN + path;
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
  handleGoogleAuthError(res, body);

  if (res.ok && !(body.kind === 'json' && body.json?.ok === false)) {
    return body.kind === 'json' ? body.json : {};
  }

  throw makeApiError({ method: 'POST', url, status: res.status, statusText: res.statusText, body });
}

async function apiPatch(path, bodyObj) {
  const url = API_BASE_CLEAN + path;
  let res;
  try {
    res = await fetch(url, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify(bodyObj || {}),
    });
  } catch (e) {
    const err = new Error(`Netzwerkfehler (PATCH) – Backend nicht erreichbar`);
    err._meta = { method: 'PATCH', url, cause: e };
    throw err;
  }

  const text = await res.text();
  const body = parseApiBody(text);
  handleGoogleAuthError(res, body);

  if (res.ok && !(body.kind === 'json' && body.json?.ok === false)) {
    return body.kind === 'json' ? body.json : {};
  }

  throw makeApiError({ method: 'PATCH', url, status: res.status, statusText: res.statusText, body });
}

async function apiDelete(path) {
  const url = API_BASE_CLEAN + path;
  let res;
  try {
    res = await fetch(url, { method: 'DELETE', headers: headers() });
  } catch (e) {
    const err = new Error(`Netzwerkfehler (DELETE) – Backend nicht erreichbar`);
    err._meta = { method: 'DELETE', url, cause: e };
    throw err;
  }

  const text = await res.text();
  const body = parseApiBody(text);
  handleGoogleAuthError(res, body);

  if (res.ok && !(body.kind === 'json' && body.json?.ok === false)) {
    return body.kind === 'json' ? body.json : {};
  }

  throw makeApiError({ method: 'DELETE', url, status: res.status, statusText: res.statusText, body });
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
function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}
function monthTitle(year, month) {
  const date = new Date(year, month, 1);
  try {
    return new Intl.DateTimeFormat(["de-CH", "de-DE"], { month: "long", year: "numeric" })
      .format(date)
      .toUpperCase();
  } catch {
    return `${monthName(date).toUpperCase()} ${year}`;
  }
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
function toInputDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function toInputTime(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function timeOfDayLabel(key) {
  if (key === "morning") return "Vormittag";
  if (key === "afternoon") return "Nachmittag";
  if (key === "evening") return "Abend";
  return "Keine Präferenz";
}
function derivePreferredTimeOfDayLocal(weights = {}) {
  const entries = Object.entries(weights || {}).filter(([, value]) => Number.isFinite(value));
  if (!entries.length) return null;
  const total = entries.reduce((acc, [, value]) => acc + value, 0);
  if (total < 0.2) return null;
  const [topKey, topValue] = entries.sort((a, b) => b[1] - a[1])[0] || [];
  if (!topKey || !topValue || topValue < 0.35) return null;
  return topKey;
}
function toLocalIsoWithOffset(date) {
  const d = new Date(date);
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const offH = pad2(Math.floor(abs / 60));
  const offM = pad2(abs % 60);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${sign}${offH}:${offM}`;
}
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
// ===== LIVE TIMESTAMP (Europe/Zurich) =====
(function () {
  const ID = "live-timestamp";

  function ensure() {
    let el = document.getElementById(ID);
    if (!el) {
      el = document.createElement("div");
      el.id = ID;
      el.className = "header-date";
      el.style.userSelect = "none";

      const header =
        document.querySelector(".topbar-right") ||
        document.querySelector(".topbar") ||
        document.querySelector("header") ||
        document.body;

      header.appendChild(el);
    } else {
      el.classList.add("header-date");
      el.style.userSelect = "none";
    }
    return el;
  }

  function tick() {
    ensure().textContent = new Intl.DateTimeFormat("de-CH", {
      dateStyle: "full",
      timeStyle: "medium",
      timeZone: "Europe/Zurich",
    }).format(new Date());
  }

  window.addEventListener("load", () => {
    tick();
    setInterval(tick, 1000);
  });
})();
