import { computeGroupConfidence } from "./confidence.js";

function sortMembers(a, b) {
  const sa = String(a.start || "9999-99-99T99:99");
  const sb = String(b.start || "9999-99-99T99:99");
  const cmp = sa.localeCompare(sb);
  if (cmp !== 0) return cmp;
  return (b.suggestionConfidence || 0) - (a.suggestionConfidence || 0);
}

export function groupDeterministically(candidates, structures) {
  const list = Array.isArray(candidates) ? candidates.slice() : [];
  const defs = Array.isArray(structures?.groups) ? structures.groups : [];
  const byId = new Map(list.map((c) => [c.id, c]));
  const used = new Set();
  const groups = [];

  defs.forEach((def) => {
    const members = (def.memberIds || [])
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort(sortMembers);
    if (!members.length) return;
    members.forEach((m) => used.add(m.id));
    groups.push({
      groupId: def.groupId,
      groupType: def.groupType,
      groupTitle: def.groupTitle,
      groupRationale: def.groupRationale,
      groupConfidence: computeGroupConfidence(members.map((m) => m.suggestionConfidence), true),
      members,
      isStructured: def.groupType !== "none",
    });
  });

  list
    .filter((c) => !used.has(c.id))
    .sort(sortMembers)
    .forEach((c, i) => {
      groups.push({
        groupId: `g-none-${i + 1}`,
        groupType: "none",
        groupTitle: c.title || "Suggestion",
        groupRationale: "No strong deterministic multi-event structure match.",
        groupConfidence: computeGroupConfidence([c.suggestionConfidence], false),
        members: [c],
        isStructured: false,
      });
    });

  groups.sort((a, b) => {
    const conf = (b.groupConfidence || 0) - (a.groupConfidence || 0);
    if (conf !== 0) return conf;
    const structuredDiff = Number(b.isStructured) - Number(a.isStructured);
    if (structuredDiff !== 0) return structuredDiff;
    const aStart = String(a.members?.[0]?.start || "9999-99-99T99:99");
    const bStart = String(b.members?.[0]?.start || "9999-99-99T99:99");
    return aStart.localeCompare(bStart);
  });

  return groups;
}
