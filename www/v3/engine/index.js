import { detectStructureCandidates } from "./structureDetector.js";
import { computeSuggestionConfidence } from "./confidence.js";
import { buildExplanation } from "./explanations.js";
import { deduplicateSuggestions } from "./dedup.js";
import { groupDeterministically } from "./grouping.js";

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function normalizeDate(dateISO, fallbackDate) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || ""))) return dateISO;
  return fallbackDate;
}

function normalizeTime(time, fallback = "00:00") {
  if (/^\d{2}:\d{2}$/.test(String(time || ""))) return time;
  return fallback;
}

function plusMinutes(start, duration) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(start || ""))) return start;
  const d = new Date(`${start}:00Z`);
  if (!Number.isFinite(d.getTime())) return start;
  d.setUTCMinutes(d.getUTCMinutes() + Math.max(0, Number(duration) || 60));
  return `${d.toISOString().slice(0, 10)}T${d.toISOString().slice(11, 16)}`;
}

function toCandidates(parsedDocument, opts = {}) {
  const items = Array.isArray(parsedDocument?.items) ? parsedDocument.items : [];
  const fallbackDate = opts.referenceDate || new Date().toISOString().slice(0, 10);
  return items.map((item, idx) => {
    const date = normalizeDate(item?.dateISO, fallbackDate);
    const time = normalizeTime(item?.startTime, "00:00");
    const start = `${date}T${time}`;
    const end = plusMinutes(start, item?.durationMin);
    return {
      id: String(item?.id || item?._suggestionId || `s${idx + 1}`),
      title: String(item?.title || "Event"),
      start,
      end,
      location: item?.location ? String(item.location) : null,
      fieldConfidence: clamp01(item?.fieldConfidence ?? item?.confidence ?? 0.5),
      sourceText: String(item?.sourceSnippet || item?.sourceText || ""),
      sourceDocumentId: String(parsedDocument?.documentId || parsedDocument?.meta?.documentId || "doc-1"),
      sourceLineHints: Array.isArray(item?.lineHints) ? item.lineHints.map((x) => String(x)) : (item?.sourceSnippet ? [String(item.sourceSnippet).slice(0, 80)] : []),
      raw: item,
      missingDate: !/^\d{4}-\d{2}-\d{2}$/.test(String(item?.dateISO || "")),
      missingTime: !/^\d{2}:\d{2}$/.test(String(item?.startTime || "")),
    };
  });
}

function assertExactKeys(obj, keys, path) {
  const actual = Object.keys(obj || {}).sort();
  const expected = keys.slice().sort();
  if (actual.join("|") !== expected.join("|")) {
    throw new Error(`[PHASE3][SCHEMA] ${path} keys mismatch. expected=${expected.join(",")} actual=${actual.join(",")}`);
  }
}

function validateOutputSchema(output) {
  assertExactKeys(output, ["groups", "meta"], "root");
  if (!Array.isArray(output.groups)) throw new Error("[PHASE3][SCHEMA] groups must be array");
  output.groups.forEach((g, gi) => {
    assertExactKeys(g, ["groupId", "groupType", "groupTitle", "groupRationale", "groupConfidence", "members"], `groups[${gi}]`);
    if (!/[a-z0-9-]+/i.test(g.groupId)) throw new Error("[PHASE3][SCHEMA] invalid groupId");
    if (!["trip", "agenda", "series", "none"].includes(g.groupType)) throw new Error("[PHASE3][SCHEMA] invalid groupType");
    if (!Array.isArray(g.members)) throw new Error("[PHASE3][SCHEMA] members must be array");
    g.members.forEach((m, mi) => {
      assertExactKeys(m, ["id", "title", "start", "end", "location", "suggestionConfidence", "explanation", "source"], `groups[${gi}].members[${mi}]`);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(m.start || ""))) throw new Error("[PHASE3][SCHEMA] invalid start format");
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(m.end || ""))) throw new Error("[PHASE3][SCHEMA] invalid end format");
      if (!(m.location === null || typeof m.location === "string")) throw new Error("[PHASE3][SCHEMA] invalid location");
      assertExactKeys(m.explanation, ["title", "bullets"], `groups[${gi}].members[${mi}].explanation`);
      if (!Array.isArray(m.explanation.bullets)) throw new Error("[PHASE3][SCHEMA] explanation.bullets must be array");
      assertExactKeys(m.source, ["documentId", "lineHints"], `groups[${gi}].members[${mi}].source`);
      if (!Array.isArray(m.source.lineHints)) throw new Error("[PHASE3][SCHEMA] source.lineHints must be array");
    });
  });
  assertExactKeys(output.meta, ["aiFallbackUsed", "aiFallbackReason"], "meta");
  if (typeof output.meta.aiFallbackUsed !== "boolean") throw new Error("[PHASE3][SCHEMA] meta.aiFallbackUsed must be boolean");
  if (!(output.meta.aiFallbackReason === null || typeof output.meta.aiFallbackReason === "string")) {
    throw new Error("[PHASE3][SCHEMA] meta.aiFallbackReason invalid");
  }
}

/**
 * @param {object} parsedDocument
 * @param {object} opts
 * @returns {object}
 */
export function buildSuggestionGroups(parsedDocument, opts = {}) {
  const contextConfidence = clamp01(parsedDocument?.meta?.context?.confidence ?? parsedDocument?.contextConfidence ?? 0.5);
  const contextType = String(parsedDocument?.meta?.context?.contextType || "generic");
  const candidatesBase = toCandidates(parsedDocument, opts);

  const preScored = candidatesBase.map((candidate) => ({
    ...candidate,
    suggestionConfidence: computeSuggestionConfidence({ candidate, contextConfidence, structureMatchStrong: false }),
  }));

  const deduped = deduplicateSuggestions(preScored);
  const structures = detectStructureCandidates(deduped);
  const structureByMember = new Map();
  structures.groups.forEach((g) => g.memberIds.forEach((id) => structureByMember.set(id, g)));

  const rescored = deduped.map((candidate) => {
    const structure = structureByMember.get(candidate.id);
    const suggestionConfidence = computeSuggestionConfidence({
      candidate,
      contextConfidence,
      structureMatchStrong: Boolean(structure && structure.groupType !== "none"),
    });
    return {
      ...candidate,
      suggestionConfidence,
      explanation: buildExplanation({
        candidate,
        groupType: structure?.groupType || "none",
        contextType,
        confidence: suggestionConfidence,
        missingDate: candidate.missingDate,
        missingTime: candidate.missingTime,
      }),
    };
  });

  let groups = groupDeterministically(rescored, structures).map((g) => ({
    groupId: g.groupId,
    groupType: g.groupType,
    groupTitle: g.groupTitle,
    groupRationale: g.groupRationale,
    groupConfidence: clamp01(g.groupConfidence),
    members: g.members.map((m) => ({
      id: m.id,
      title: m.title,
      start: m.start,
      end: m.end,
      location: m.location,
      suggestionConfidence: clamp01(m.suggestionConfidence),
      explanation: m.explanation,
      source: {
        documentId: m.sourceDocumentId,
        lineHints: m.sourceLineHints,
      },
    })),
  }));

  const deterministicConfidence = groups.length ? Math.max(...groups.map((g) => g.groupConfidence)) : 0;
  // Spec gate (must all be true):
  // 1) no deterministic structure detected
  // 2) more than one candidate
  // 3) deterministic grouping confidence < 0.55
  // This also guarantees AI is never triggered for clear trip/agenda/series structures.
  const shouldUseAiFallback = !structures.hasStructure && rescored.length > 1 && deterministicConfidence < 0.55;
  let aiFallbackUsed = false;
  let aiFallbackReason = null;

  if (shouldUseAiFallback) {
    aiFallbackReason = "No deterministic structure and low grouping confidence (<0.55).";
    if (opts.devLog !== false) console.log("[PHASE3][AI_FALLBACK]", aiFallbackReason);
    const aiFallbackFn = typeof opts.aiGroupFallback === "function" ? opts.aiGroupFallback : null;
    if (aiFallbackFn) {
      try {
        const aiOut = aiFallbackFn({ candidates: rescored, deterministic: groups });
        if (aiOut && Array.isArray(aiOut.groups)) {
          groups = aiOut.groups;
          aiFallbackUsed = true;
        }
      } catch {
        aiFallbackUsed = false;
      }
    }
  }

  const output = { groups, meta: { aiFallbackUsed, aiFallbackReason } };
  validateOutputSchema(output);
  return output;
}

export { detectStructureCandidates, computeSuggestionConfidence, buildExplanation, deduplicateSuggestions, groupDeterministically };
