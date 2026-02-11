function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function isGenericTitle(title) {
  return /^(event|termin|meeting|task)$/i.test(String(title || "").trim());
}

export function computeSuggestionConfidence({ candidate, contextConfidence = 0.5, structureMatchStrong = false }) {
  const hasDate = candidate?.missingDate === true ? false : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(candidate?.start || ""));
  const hasTime = candidate?.missingTime === true ? false : hasDate;

  // Phase-3 spec inputs
  const fieldConfidence = clamp01(candidate?.fieldConfidence ?? candidate?.confidence ?? 0.5);
  const completenessScore = clamp01(
    (candidate?.title ? 0.35 : 0) +
    (hasDate ? 0.35 : 0) +
    (candidate?.location ? 0.15 : 0) +
    (candidate?.end ? 0.15 : 0),
  );

  // Phase-3 spec formula:
  // base = 0.45*fieldConfidence + 0.35*contextConfidence + 0.20*completenessScore
  const base = 0.45 * fieldConfidence + 0.35 * clamp01(contextConfidence) + 0.2 * completenessScore;

  // Phase-3 penalties:
  // 0.25 missing date, 0.25 missing start time, 0.10 generic title
  let penalty = 0;
  if (!hasDate) penalty += 0.25;
  if (!hasTime) penalty += 0.25;
  if (isGenericTitle(candidate?.title)) penalty += 0.1;

  // Phase-3 bonuses:
  // 0.10 strong structure, 0.05 location present, 0.05 consistent inferred duration/end
  let bonus = 0;
  if (structureMatchStrong) bonus += 0.1;
  if (candidate?.location) bonus += 0.05;
  if (candidate?.end) bonus += 0.05;

  // suggestionConfidence = clamp(base - penalty + bonus, 0, 1)
  return clamp01(base - penalty + bonus);
}

export function computeGroupConfidence(memberConfidences, orderingConsistent = true) {
  const list = (Array.isArray(memberConfidences) ? memberConfidences : [])
    .map((x) => clamp01(x))
    .sort((a, b) => b - a);
  const top = list.slice(0, 2);
  const avg = top.length ? top.reduce((s, n) => s + n, 0) / top.length : 0;
  return clamp01(avg + (orderingConsistent ? 0.03 : 0));
}
