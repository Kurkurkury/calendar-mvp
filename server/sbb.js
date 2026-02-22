const SBB_BASE_URL = "https://www.sbb.ch/de";

function formatDate(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatTime(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function buildSbbUrl({ from, to, eventStartIso } = {}) {
  const fromValue = String(from || "").trim();
  const toValue = String(to || "").trim();
  const params = new URLSearchParams();

  params.set("von", fromValue);
  params.set("nach", toValue);

  if (eventStartIso) {
    const when = new Date(eventStartIso);
    if (!Number.isNaN(when.getTime()) && when.getTime() > Date.now()) {
      const date = formatDate(when);
      const time = formatTime(when);
      if (date) params.set("date", date);
      if (time) params.set("time", time);
      params.set("moment", "DEPARTURE");
    }
  }

  return `${SBB_BASE_URL}?${params.toString()}`;
}
