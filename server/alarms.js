import { buildSbbUrl } from "./sbb.js";

const SEVERITY_RANK = { urgent: 0, warning: 1, info: 2 };

function toMs(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime();
}

function trimLocation(location) {
  return String(location || "").trim();
}

export function normalizeTravelAlarmState(event, previousEvent = null) {
  const nextEvent = { ...(event || {}) };
  const location = trimLocation(nextEvent.location);
  const prevLocation = trimLocation(previousEvent?.location);
  const previousTravel = previousEvent?.alarmState?.travel || null;
  const currentTravel = nextEvent?.alarmState?.travel || null;

  const changedLocation = previousEvent ? location !== prevLocation : false;

  const baseTravel = {
    needsCheck: false,
    confirmed: false,
    lastOpenedAt: null,
    lastConfirmedAt: null,
    ...(previousTravel || {}),
    ...(currentTravel || {}),
  };

  if (!location) {
    baseTravel.needsCheck = false;
    baseTravel.confirmed = false;
  } else {
    // If location exists, travel check is relevant unless confirmed
    baseTravel.needsCheck = baseTravel.confirmed ? false : true;
  }

  // Re-open loop when location changes
  if (location && previousEvent && changedLocation) {
    baseTravel.needsCheck = true;
    baseTravel.confirmed = false;
    baseTravel.lastConfirmedAt = null;
  }

  nextEvent.alarmState = {
    ...(nextEvent.alarmState || {}),
    travel: baseTravel,
  };

  return nextEvent;
}

export function deriveTravelSeverity(startIso, preferences = {}, nowMs = Date.now()) {
  const startMs = toMs(startIso);
  const urgentHours = Number(preferences?.alarmUrgentHours ?? 24);
  const warningHours = Number(preferences?.alarmWarningHours ?? 72);

  if (!startMs) return "info";
  if (startMs < nowMs) return null;

  if (startMs <= nowMs + urgentHours * 60 * 60 * 1000) return "urgent";
  if (startMs <= nowMs + warningHours * 60 * 60 * 1000) return "warning";
  return "info";
}

export function buildTravelAlarms({ events = [], preferences = {}, nowMs = Date.now() } = {}) {
  const homeStop = String(preferences?.homeStop || "Olsberg, Mitteldorf");
  const lookaheadHours = Number(preferences?.alarmLookaheadHours ?? 168);
  const lookaheadLimit = nowMs + lookaheadHours * 60 * 60 * 1000;

  const alarms = [];

  for (const rawEvent of events) {
    const event = normalizeTravelAlarmState(rawEvent);
    const location = trimLocation(event.location);
    const travel = event?.alarmState?.travel || {};
    if (!location || !travel.needsCheck || travel.confirmed) continue;

    const startIso = event.start || event.startIso || null;
    const startMs = toMs(startIso);
    if (startMs && startMs < nowMs) continue;
    if (startMs && startMs > lookaheadLimit) continue;

    const severity = deriveTravelSeverity(startIso, preferences, nowMs) || "info";

    alarms.push({
      id: `travel_check:${event.id}`,
      type: "travel_check",
      severity,
      event: {
        id: event.id,
        title: event.title || "Termin",
        startIso: startIso,
        endIso: event.end || event.endIso || null,
        location,
      },
      state: {
        needsCheck: !!travel.needsCheck,
        confirmed: !!travel.confirmed,
        lastOpenedAt: travel.lastOpenedAt || null,
        lastConfirmedAt: travel.lastConfirmedAt || null,
      },
      actions: {
        openSbbUrl: buildSbbUrl({ from: homeStop, to: location, eventStartIso: startIso || undefined }),
        confirmUrl: "/api/travel/confirm",
        dismissUrl: "/api/travel/dismiss",
      },
      _sortStartMs: startMs ?? Number.MAX_SAFE_INTEGER,
    });
  }

  alarms.sort((a, b) => {
    const sev = (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99);
    if (sev !== 0) return sev;
    if (a._sortStartMs !== b._sortStartMs) return a._sortStartMs - b._sortStartMs;
    return String(a?.event?.title || "").localeCompare(String(b?.event?.title || ""), "de", { sensitivity: "base" });
  });

  return alarms.map(({ _sortStartMs, ...alarm }) => alarm);
}
