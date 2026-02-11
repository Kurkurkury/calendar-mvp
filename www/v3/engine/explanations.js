function clean(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

export function buildExplanation({ candidate, groupType, contextType, confidence, missingDate, missingTime }) {
  const kind = groupType && groupType !== "none" ? groupType : (contextType || "event");
  const bullets = [];
  const cues = [];
  if (candidate?.title) cues.push(`title "${clean(candidate.title).slice(0, 40)}"`);
  if (candidate?.start) cues.push(`date/time ${candidate.start}`);
  if (candidate?.location) cues.push(`location ${clean(candidate.location).slice(0, 30)}`);
  bullets.push(cues.length ? `Key cues: ${cues.slice(0, 2).join(", ")}.` : "Key cues: keyword-based extraction.");

  if (missingDate || missingTime) {
    const missing = [missingDate ? "date" : "", missingTime ? "start time" : ""].filter(Boolean).join(" + ");
    bullets.push(`Lower confidence: missing ${missing}.`);
  } else {
    bullets.push("High confidence: date and start time available.");
  }

  if (groupType && groupType !== "none") {
    bullets.push(`Grouping rationale: part of ${groupType} structure.`);
  }

  bullets.push(`Confidence summary: ${Math.round((Number(confidence) || 0) * 100)}%.`);

  return {
    title: clean(`Erkannt als ${kind} basierend auf deterministischen Signalen.`),
    bullets: bullets.slice(0, 4).map(clean),
  };
}
