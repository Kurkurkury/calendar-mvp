function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toMinute(ts) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(ts || ""))) return null;
  const hh = Number(String(ts).slice(11, 13));
  const mm = Number(String(ts).slice(14, 16));
  return hh * 60 + mm;
}

export function deduplicateSuggestions(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const kept = [];
  const byKey = new Map();

  for (const cand of list) {
    const title = normalizeTitle(cand.title);
    const date = String(cand.start || "").slice(0, 10);
    const minute = toMinute(cand.start);
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || minute == null) {
      kept.push(cand);
      continue;
    }

    const key = `${title}|${date}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, cand);
      kept.push(cand);
      continue;
    }

    const diff = Math.abs((toMinute(existing.start) ?? 9999) - minute);
    if (diff <= 5) {
      if ((cand.suggestionConfidence ?? 0) > (existing.suggestionConfidence ?? 0)) {
        const idx = kept.indexOf(existing);
        if (idx >= 0) kept[idx] = cand;
        byKey.set(key, cand);
      }
    } else {
      kept.push(cand);
    }
  }

  return kept.filter((item) => {
    const umbrella = /\b(trip|reise|travel)\b/i.test(item.title || "") && !item.location;
    if (!umbrella) return true;
    return !kept.some((other) => other !== item && normalizeTitle(other.title) === normalizeTitle(item.title));
  });
}
