import test from "node:test";
import assert from "node:assert/strict";
import {
  SUGGESTION_STATUS,
  createSuggestionStatusMap,
  setSuggestionStatus,
  shouldCommitSuggestion,
} from "../engine/suggestion-workflow.js";

test("Accept sets status=accepted", () => {
  const map = createSuggestionStatusMap([{ id: "s1" }]);
  const next = setSuggestionStatus(map, "s1", SUGGESTION_STATUS.ACCEPTED);
  assert.equal(next.s1, SUGGESTION_STATUS.ACCEPTED);
});

test("Dismiss sets status=dismissed", () => {
  const map = createSuggestionStatusMap([{ id: "s1" }]);
  const next = setSuggestionStatus(map, "s1", SUGGESTION_STATUS.DISMISSED);
  assert.equal(next.s1, SUGGESTION_STATUS.DISMISSED);
});

test("Commit cannot run unless accepted + explicit confirm", () => {
  assert.equal(shouldCommitSuggestion(SUGGESTION_STATUS.PENDING, true), false);
  assert.equal(shouldCommitSuggestion(SUGGESTION_STATUS.ACCEPTED, false), false);
});

test("Successful commit sets status=committed", () => {
  const map = createSuggestionStatusMap([{ id: "s1" }]);
  const accepted = setSuggestionStatus(map, "s1", SUGGESTION_STATUS.ACCEPTED);
  assert.equal(shouldCommitSuggestion(accepted.s1, true), true);
  const committed = setSuggestionStatus(accepted, "s1", SUGGESTION_STATUS.COMMITTED);
  assert.equal(committed.s1, SUGGESTION_STATUS.COMMITTED);
});

test("Cancel does not write", () => {
  const map = createSuggestionStatusMap([{ id: "s1" }]);
  const accepted = setSuggestionStatus(map, "s1", SUGGESTION_STATUS.ACCEPTED);
  const shouldWrite = shouldCommitSuggestion(accepted.s1, false);
  assert.equal(shouldWrite, false);
  assert.equal(accepted.s1, SUGGESTION_STATUS.ACCEPTED);
});
