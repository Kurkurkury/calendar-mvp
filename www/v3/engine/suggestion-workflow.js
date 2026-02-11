export const SUGGESTION_STATUS = Object.freeze({
  PENDING: "pending",
  ACCEPTED: "accepted",
  DISMISSED: "dismissed",
  COMMITTED: "committed",
});

export function createSuggestionStatusMap(suggestions) {
  const next = {};
  (Array.isArray(suggestions) ? suggestions : []).forEach((suggestion) => {
    if (!suggestion?.id) return;
    next[suggestion.id] = SUGGESTION_STATUS.PENDING;
  });
  return next;
}

export function setSuggestionStatus(currentMap, suggestionId, nextStatus) {
  const base = currentMap && typeof currentMap === "object" ? currentMap : {};
  if (!suggestionId) return { ...base };
  if (!Object.values(SUGGESTION_STATUS).includes(nextStatus)) return { ...base };
  return {
    ...base,
    [suggestionId]: nextStatus,
  };
}

export function canCommitSuggestion(status) {
  return status === SUGGESTION_STATUS.ACCEPTED;
}

export function shouldCommitSuggestion(status, explicitlyConfirmed) {
  return canCommitSuggestion(status) && explicitlyConfirmed === true;
}
