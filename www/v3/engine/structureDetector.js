function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function tokenize(value) {
  return normalizeText(value)
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 3);
}

function dateOnly(start) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(start || "")) ? String(start).slice(0, 10) : "";
}

function timeOnly(start) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(start || "")) ? String(start).slice(11, 16) : "";
}

function dayDiff(a, b) {
  if (!a || !b) return 999;
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  if (!Number.isFinite(da) || !Number.isFinite(db)) return 999;
  return Math.abs(Math.round((da - db) / 86400000));
}

function tokenOverlap(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap += 1;
  return overlap / Math.max(ta.size, tb.size);
}

function hasTripCue(candidate) {
  const hay = `${candidate.title || ""} ${(candidate.sourceText || "")}`.toLowerCase();
  return /\b(flight|zug|trip|reise|abfahrt|ankunft|outbound|return|rückfahrt|hinreise|check-in|check-out|airport)\b/.test(hay);
}

function hasOutboundCue(candidate) {
  return /\b(outbound|hinreise|abfahrt|departure|depart)\b/.test(normalizeText(`${candidate.title} ${candidate.sourceText}`));
}

function hasReturnCue(candidate) {
  return /\b(return|rückreise|rückfahrt|ankunft|inbound|back)\b/.test(normalizeText(`${candidate.title} ${candidate.sourceText}`));
}

function locationKey(candidate) {
  const loc = normalizeText(candidate.location || "");
  const code = (normalizeText(`${candidate.title} ${candidate.sourceText}`).match(/\b[a-z]{3}\b/g) || []).slice(0, 2).join("-");
  return loc || code || "trip";
}

function toGroup(groupId, groupType, groupTitle, groupRationale, memberIds, confidenceBoost = 0.08) {
  return {
    groupId,
    groupType,
    groupTitle,
    groupRationale,
    memberIds,
    confidenceBoost,
    orderingBonus: 0.03,
  };
}

export function detectStructureCandidates(candidates) {
  const items = Array.isArray(candidates) ? candidates.slice() : [];
  const unassigned = new Set(items.map((c) => c.id));
  const groups = [];
  let seq = 1;

  const tripPool = items.filter(hasTripCue);
  const tripBuckets = new Map();
  for (const item of tripPool) {
    const key = locationKey(item);
    if (!tripBuckets.has(key)) tripBuckets.set(key, []);
    tripBuckets.get(key).push(item);
  }

  for (const [, bucket] of tripBuckets.entries()) {
    const sorted = bucket.slice().sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")));
    if (sorted.length < 2) continue;
    const hasOut = sorted.some(hasOutboundCue);
    const hasRet = sorted.some(hasReturnCue);
    const within14 = dayDiff(dateOnly(sorted[0].start), dateOnly(sorted[sorted.length - 1].start)) <= 14;
    if (!(hasOut || hasRet || within14)) continue;
    const members = sorted.filter((s) => unassigned.has(s.id));
    if (members.length < 2) continue;
    members.forEach((m) => unassigned.delete(m.id));
    const route = (members[0].location || members[0].title || "Route").slice(0, 30);
    groups.push(toGroup(`g${seq++}`, "trip", `Trip: ${route}`, "Matched travel cues with outbound/return or close travel dates.", members.map((m) => m.id), 0.1));
  }


  const globalTripCandidates = items.filter((c) => unassigned.has(c.id) && hasTripCue(c));
  if (globalTripCandidates.length >= 2) {
    const sorted = globalTripCandidates.slice().sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")));
    const hasOut = sorted.some(hasOutboundCue);
    const hasRet = sorted.some(hasReturnCue);
    const within14 = dayDiff(dateOnly(sorted[0].start), dateOnly(sorted[sorted.length - 1].start)) <= 14;
    if ((hasOut && hasRet) || within14) {
      sorted.forEach((m) => unassigned.delete(m.id));
      const route = (sorted[0].title || sorted[0].location || "Route").slice(0, 30);
      groups.push(toGroup(`g${seq++}`, "trip", `Trip: ${route}`, "Matched outbound/return travel signals across document.", sorted.map((m) => m.id), 0.1));
    }
  }
  const byDate = new Map();
  for (const item of items.filter((c) => unassigned.has(c.id))) {
    const d = dateOnly(item.start);
    if (!d) continue;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(item);
  }

  for (const [d, bucket] of byDate.entries()) {
    if (bucket.length < 2) continue;
    const topic = bucket[0].title || "Thema";
    const related = bucket.filter((b) => tokenOverlap(topic, b.title) >= 0.3 || tokenOverlap(topic, b.sourceText) >= 0.3);
    if (related.length < 2) continue;
    const members = related.filter((b) => unassigned.has(b.id));
    if (members.length < 2) continue;
    members.forEach((m) => unassigned.delete(m.id));
    groups.push(toGroup(`g${seq++}`, "agenda", `Agenda: ${(topic || d).slice(0, 30)}`, "Multiple same-day slots with shared topic keywords.", members.map((m) => m.id), 0.08));
  }

  const byTitle = new Map();
  for (const item of items.filter((c) => unassigned.has(c.id))) {
    const key = tokenize(item.title).slice(0, 3).join(" ") || "untitled";
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(item);
  }

  for (const [titleKey, bucket] of byTitle.entries()) {
    if (bucket.length < 3) continue;
    const timePattern = new Map();
    bucket.forEach((b) => {
      const t = timeOnly(b.start) || "00:00";
      timePattern.set(t, (timePattern.get(t) || 0) + 1);
    });
    const maxPattern = Math.max(...timePattern.values());
    if (maxPattern < 2) continue;
    const members = bucket.filter((b) => unassigned.has(b.id));
    if (members.length < 3) continue;
    members.forEach((m) => unassigned.delete(m.id));
    groups.push(toGroup(`g${seq++}`, "series", `Series: ${(titleKey || "Termin").slice(0, 30)}`, "Recurring title and weekday/time pattern detected.", members.map((m) => m.id), 0.08));
  }

  return { groups, hasStructure: groups.length > 0 };
}
