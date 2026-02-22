const connectedEmailEl = document.getElementById("connectedEmail");
const connectBtn = document.getElementById("connectBtn");
const refreshBtn = document.getElementById("refreshBtn");
const exportBtn = document.getElementById("exportBtn");
const todayBtn = document.getElementById("todayBtn");
const weekBtn = document.getElementById("weekBtn");
const eventsList = document.getElementById("eventsList");
const createForm = document.getElementById("createForm");
const jsonPanel = document.getElementById("jsonPanel");
const copyBtn = document.getElementById("copyBtn");

let currentRange = getTodayRange();
let lastExport = [];

function toIso(date, hhmm = "00:00") {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(date);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.toISOString();
}

function getTodayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function getWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const start = new Date(now);
  start.setDate(now.getDate() + diffToMonday);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { from: start.toISOString(), to: end.toISOString() };
}

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "request failed");
  return data;
}

function renderEvents(events) {
  eventsList.innerHTML = "";
  for (const ev of events) {
    const li = document.createElement("li");
    const start = ev.start ? new Date(ev.start).toLocaleString() : "(no time)";
    li.textContent = `${start} — ${ev.title || "Untitled"}`;
    eventsList.appendChild(li);
  }
}

async function refreshStatus() {
  const status = await getJson("/api/google/status");
  connectedEmailEl.textContent = status?.google?.connectedEmail || "Not connected";
}

async function refreshEvents() {
  const q = new URLSearchParams(currentRange);
  const out = await getJson(`/api/events?${q}`);
  renderEvents(out.events || []);
}

async function runExport() {
  const q = new URLSearchParams(currentRange);
  const out = await getJson(`/api/export?${q}`);
  lastExport = out.events || [];
  jsonPanel.textContent = JSON.stringify(lastExport, null, 2);
}

connectBtn.addEventListener("click", async () => {
  const out = await getJson("/api/google/auth-url");
  if (out.url) window.location.href = out.url;
});

refreshBtn.addEventListener("click", async () => {
  await refreshStatus();
  await refreshEvents();
});

exportBtn.addEventListener("click", runExport);

todayBtn.addEventListener("click", async () => {
  currentRange = getTodayRange();
  await refreshEvents();
});

weekBtn.addEventListener("click", async () => {
  currentRange = getWeekRange();
  await refreshEvents();
});

createForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const date = document.getElementById("date").value;
  const startTime = document.getElementById("startTime").value;
  const endTime = document.getElementById("endTime").value;
  const payload = {
    title: document.getElementById("title").value,
    start: toIso(date, startTime),
    end: toIso(date, endTime),
  };
  await getJson("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await refreshEvents();
  createForm.reset();
});

copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(JSON.stringify(lastExport, null, 2));
});

await refreshStatus();
await refreshEvents();
