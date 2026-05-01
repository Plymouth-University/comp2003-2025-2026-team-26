function clean(value) {
  const text = String(value || "").trim();
  return text || "";
}

export function extractFirestoreIndexUrl(error) {
  const text = clean(error?.message);
  const match = text.match(/https:\/\/console\.firebase\.google\.com\/[^\s]+/i);
  return match ? match[0] : "";
}

export function isLikelyMissingIndexError(error) {
  const code = clean(error?.code).toLowerCase();
  const message = clean(error?.message);
  return code === "failed-precondition" || /index/i.test(message);
}

export function buildMissingIndexError(scopeLabel, error, fallbackMessage) {
  if (!isLikelyMissingIndexError(error)) {
    return error instanceof Error ? error : new Error(clean(error?.message) || fallbackMessage);
  }

  const indexUrl = extractFirestoreIndexUrl(error);
  const guidance = indexUrl
    ? `Create the missing index: ${indexUrl}`
    : "Deploy the required indexes from logbook/firestore.indexes.json.";
  return new Error(`${scopeLabel} query requires a Firestore index. ${guidance}`);
}
