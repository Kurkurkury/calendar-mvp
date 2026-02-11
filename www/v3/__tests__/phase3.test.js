import test from "node:test";
import assert from "node:assert/strict";
import { buildSuggestionGroups, computeSuggestionConfidence } from "../engine/index.js";

function mkItem(partial) {
  return {
    title: "Event",
    dateISO: "2026-03-10",
    startTime: "09:00",
    durationMin: 60,
    location: "",
    confidence: 0.7,
    sourceSnippet: "source",
    ...partial,
  };
}

test("Trip: outbound + return => one trip group ordered + explanations", () => {
  const parsed = {
    documentId: "d1",
    items: [
      mkItem({ title: "Return flight BER-ZRH", dateISO: "2026-03-15", startTime: "18:30", location: "BER" }),
      mkItem({ title: "Outbound flight ZRH-BER", dateISO: "2026-03-12", startTime: "08:00", location: "ZRH" }),
    ],
    meta: { context: { confidence: 0.8, contextType: "travel" } },
  };
  const out = buildSuggestionGroups(parsed, { devLog: false });
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].groupType, "trip");
  assert.equal(out.groups[0].members[0].start, "2026-03-12T08:00");
  assert.equal(out.groups[0].members[1].start, "2026-03-15T18:30");
  assert.ok(out.groups[0].members[0].explanation.title.length > 0);
});

test("Agenda: 3 same-day slots => one agenda group sorted", () => {
  const parsed = {
    items: [
      mkItem({ title: "Workshop Produkt", startTime: "14:00" }),
      mkItem({ title: "Workshop Produkt", startTime: "09:00" }),
      mkItem({ title: "Workshop Produkt", startTime: "11:00" }),
    ],
    meta: { context: { confidence: 0.7, contextType: "invitation" } },
  };
  const out = buildSuggestionGroups(parsed, { devLog: false });
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].groupType, "agenda");
  assert.deepEqual(out.groups[0].members.map((m) => m.start.slice(11, 16)), ["09:00", "11:00", "14:00"]);
});

test("Series: recurring title/time => one series group", () => {
  const parsed = {
    items: [
      mkItem({ title: "Team Sync", dateISO: "2026-03-10", startTime: "10:00" }),
      mkItem({ title: "Team Sync", dateISO: "2026-03-17", startTime: "10:00" }),
      mkItem({ title: "Team Sync", dateISO: "2026-03-24", startTime: "10:00" }),
    ],
    meta: { context: { confidence: 0.6, contextType: "generic" } },
  };
  const out = buildSuggestionGroups(parsed, { devLog: false });
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].groupType, "series");
});

test("Dedup: same normalized title + date + +-5min keeps higher confidence", () => {
  const parsed = {
    items: [
      mkItem({ title: "Budget Review", startTime: "09:00", confidence: 0.6 }),
      mkItem({ title: "budget review", startTime: "09:04", confidence: 0.9 }),
    ],
    meta: { context: { confidence: 0.5, contextType: "generic" } },
  };
  const out = buildSuggestionGroups(parsed, { devLog: false });
  const count = out.groups.reduce((acc, g) => acc + g.members.length, 0);
  assert.equal(count, 1);
  assert.equal(out.groups[0].members[0].title.toLowerCase(), "budget review");
});

test("Missing date/time lowers confidence and explanation mentions missing fields", () => {
  const parsed = {
    items: [mkItem({ title: "Termin", dateISO: "", startTime: "" })],
    meta: { context: { confidence: 0.5, contextType: "generic" } },
  };
  const out = buildSuggestionGroups(parsed, { devLog: false, referenceDate: "2026-03-10" });
  const member = out.groups[0].members[0];
  assert.ok(member.suggestionConfidence < 0.55);
  assert.ok(member.explanation.bullets.join(" ").includes("missing"));
});

test("Confidence formula applies penalties and structure bonus", () => {
  const baseCandidate = {
    title: "Client Review",
    start: "2026-03-10T09:00",
    end: "2026-03-10T10:00",
    location: "Zurich",
    fieldConfidence: 0.7,
    missingDate: false,
    missingTime: false,
  };
  const withStructure = computeSuggestionConfidence({ candidate: baseCandidate, contextConfidence: 0.7, structureMatchStrong: true });
  const withoutStructure = computeSuggestionConfidence({ candidate: baseCandidate, contextConfidence: 0.7, structureMatchStrong: false });
  assert.ok(withStructure > withoutStructure, "structure bonus should increase confidence");

  const missingBoth = computeSuggestionConfidence({
    candidate: { ...baseCandidate, missingDate: true, missingTime: true, title: "Termin" },
    contextConfidence: 0.7,
    structureMatchStrong: false,
  });
  assert.ok(missingBoth + 0.55 <= withoutStructure, "missing date/time + generic title penalties should lower confidence significantly");
});

test("AI fallback gate: clear structures never trigger AI", () => {
  let fallbackCalled = false;
  const out = buildSuggestionGroups({
    items: [
      mkItem({ title: "Outbound flight ZRH-BER", dateISO: "2026-03-10", startTime: "08:00", location: "ZRH" }),
      mkItem({ title: "Return flight BER-ZRH", dateISO: "2026-03-12", startTime: "18:00", location: "BER" }),
    ],
    meta: { context: { confidence: 0.8, contextType: "travel" } },
  }, {
    devLog: false,
    aiGroupFallback: () => {
      fallbackCalled = true;
      return { groups: [] };
    },
  });

  assert.equal(out.groups[0].groupType, "trip");
  assert.equal(out.meta.aiFallbackUsed, false);
  assert.equal(fallbackCalled, false);
});

test("AI gating: >=0.55 no fallback, <0.55 uses fallback stub", () => {
  const high = buildSuggestionGroups({
    items: [mkItem({ title: "Review", confidence: 0.9 }), mkItem({ title: "Planning", confidence: 0.8 })],
    meta: { context: { confidence: 0.9, contextType: "generic" } },
  }, {
    devLog: false,
    aiGroupFallback: () => ({ groups: [] }),
  });
  assert.equal(high.meta.aiFallbackUsed, false);

  const low = buildSuggestionGroups({
    items: [mkItem({ title: "Event", dateISO: "", startTime: "", confidence: 0.1 }), mkItem({ title: "Termin", dateISO: "", startTime: "", confidence: 0.1 })],
    meta: { context: { confidence: 0.1, contextType: "generic" } },
  }, {
    devLog: false,
    referenceDate: "2026-03-10",
    aiGroupFallback: ({ deterministic }) => ({ groups: deterministic }),
  });
  assert.equal(low.meta.aiFallbackUsed, true);
  assert.ok(typeof low.meta.aiFallbackReason === "string");
});

test("Schema validation throws on invalid output shape (UI catches and shows Suggestion Engine Error)", () => {
  assert.throws(() => {
    buildSuggestionGroups({
      items: [mkItem({ title: "Event", dateISO: "", startTime: "", confidence: 0.1 }), mkItem({ title: "Termin", dateISO: "", startTime: "", confidence: 0.1 })],
      meta: { context: { confidence: 0.1, contextType: "generic" } },
    }, {
      devLog: false,
      referenceDate: "2026-03-10",
      aiGroupFallback: () => ({ groups: [{ invalid: true }] }),
    });
  }, /\[PHASE3\]\[SCHEMA\]/);
});
