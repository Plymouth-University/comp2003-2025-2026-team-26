import { db } from "./logbook-app.js";
import {
  addDoc,
  collection,
  deleteDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  where
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { auth, getMyAccount, getRoleFromUser } from "./auth.js";
import { summarizeMediaValue } from "./media-assets.js";
const ACTIVITY_COLLECTION = "user_activity_logs";
const LOGIN_SESSION_KEY_PREFIX = "activity.login.";
const ACTOR_CACHE_MS = 30 * 1000;
const ACTIVITY_RETENTION_DEFAULT_DAYS = 180;
const ACTIVITY_RETENTION_MIN_DAYS = 30;
const ACTIVITY_RETENTION_MAX_DAYS = 3650;
const ACTIVITY_RETENTION_DAYS_KEY = "activity.retention.days";
const ACTIVITY_RETENTION_LAST_RUN_KEY = "activity.retention.lastRunAt";
const ACTIVITY_RETENTION_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const ACTIVITY_RETENTION_DELETE_BATCH_SIZE = 150;
const ACTIVITY_RETENTION_MAX_BATCHES_PER_RUN = 3;
const ACTIVITY_MAX_STRING_LENGTH = 240;
const ACTIVITY_MAX_ARRAY_ITEMS = 20;
const ACTIVITY_MAX_OBJECT_KEYS = 30;
const ACTIVITY_MAX_DIFF_KEYS = 24;

let actorCache = null;
let actorCacheAt = 0;
let retentionCleanupInFlight = null;

function cleanString(value) {
  const text = String(value || "").trim();
  return text || "";
}

function toIso(value) {
  if (!value) return "";
  if (typeof value.toDate === "function") {
    const dateValue = value.toDate();
    return Number.isNaN(dateValue.getTime()) ? "" : dateValue.toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  const dateValue = new Date(value);
  return Number.isNaN(dateValue.getTime()) ? "" : dateValue.toISOString();
}

function normalizeActionType(value) {
  const raw = cleanString(value).toLowerCase().replace(/\s+/g, "_");
  if (!raw) return "unknown";
  return raw;
}

function inferStaffId(uid, staffId) {
  const explicit = cleanString(staffId);
  if (explicit) return explicit;
  const normalizedUid = cleanString(uid);
  if (normalizedUid.startsWith("staff_")) return normalizedUid.slice("staff_".length);
  return "";
}

function uniqueLower(values) {
  return [...new Set(values.map((value) => cleanString(value).toLowerCase()).filter(Boolean))];
}

function readStoredNumber(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function resolveRetentionDays() {
  const configured = readStoredNumber(ACTIVITY_RETENTION_DAYS_KEY);
  const value = configured == null ? ACTIVITY_RETENTION_DEFAULT_DAYS : Math.floor(configured);
  return Math.max(ACTIVITY_RETENTION_MIN_DAYS, Math.min(ACTIVITY_RETENTION_MAX_DAYS, value));
}

function shouldRunRetentionCleanup(actor) {
  // Keep deletion authority on admin sessions only.
  if (cleanString(actor?.role).toLowerCase() !== "admin") return false;
  const now = Date.now();
  const lastRunAt = readStoredNumber(ACTIVITY_RETENTION_LAST_RUN_KEY) || 0;
  return now - lastRunAt >= ACTIVITY_RETENTION_COOLDOWN_MS;
}

function markRetentionCleanupRun(nowMs = Date.now()) {
  try {
    window.localStorage.setItem(ACTIVITY_RETENTION_LAST_RUN_KEY, String(nowMs));
  } catch {
    // ignore storage failures
  }
}

async function runRetentionCleanup() {
  const retentionDays = resolveRetentionDays();
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  let deletedCount = 0;

  for (let batchIndex = 0; batchIndex < ACTIVITY_RETENTION_MAX_BATCHES_PER_RUN; batchIndex += 1) {
    const snap = await getDocs(
      query(
        collection(db, ACTIVITY_COLLECTION),
        where("createdAtIso", "<=", cutoffIso),
        orderBy("createdAtIso", "asc"),
        limit(ACTIVITY_RETENTION_DELETE_BATCH_SIZE)
      )
    );

    if (snap.empty) break;
    await Promise.all(snap.docs.map((docSnap) => deleteDoc(docSnap.ref)));
    deletedCount += snap.size;

    if (snap.size < ACTIVITY_RETENTION_DELETE_BATCH_SIZE) break;
  }

  return deletedCount;
}

function scheduleRetentionCleanup(actor) {
  if (!shouldRunRetentionCleanup(actor)) return;
  if (retentionCleanupInFlight) return;

  // Set run marker before starting to avoid thundering herd from parallel tabs.
  markRetentionCleanupRun();
  retentionCleanupInFlight = runRetentionCleanup()
    .catch((error) => {
      console.warn("Activity retention cleanup failed:", error);
    })
    .finally(() => {
      retentionCleanupInFlight = null;
    });
}

function sanitizeForFirestore(value) {
  if (value === undefined || typeof value === "function") return undefined;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && typeof value._methodName === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForFirestore(item)).filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    const next = {};
    for (const [key, nested] of Object.entries(value)) {
      const sanitized = sanitizeForFirestore(nested);
      if (sanitized !== undefined) next[key] = sanitized;
    }
    return next;
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compactLogValue(value, depth = 0) {
  if (value === undefined || typeof value === "function") return undefined;
  if (value === null) return null;

  const summarizedMedia = summarizeMediaValue(value);
  if (summarizedMedia !== value) return compactLogValue(summarizedMedia, depth + 1);

  if (typeof value === "string") {
    return value.length > ACTIVITY_MAX_STRING_LENGTH
      ? `${value.slice(0, ACTIVITY_MAX_STRING_LENGTH)}…`
      : value;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    const items = value
      .slice(0, ACTIVITY_MAX_ARRAY_ITEMS)
      .map((item) => compactLogValue(item, depth + 1))
      .filter((item) => item !== undefined);

    if (value.length > ACTIVITY_MAX_ARRAY_ITEMS) {
      items.push({ _truncatedItems: value.length - ACTIVITY_MAX_ARRAY_ITEMS });
    }
    return items;
  }

  if (!isPlainObject(value)) return value;
  if (typeof value._methodName === "string") return value;

  if (depth >= 3) {
    return {
      _summary: "object",
      keyCount: Object.keys(value).length
    };
  }

  const next = {};
  const entries = Object.entries(value);
  entries.slice(0, ACTIVITY_MAX_OBJECT_KEYS).forEach(([key, nested]) => {
    const compacted = compactLogValue(nested, depth + 1);
    if (compacted !== undefined) next[key] = compacted;
  });
  if (entries.length > ACTIVITY_MAX_OBJECT_KEYS) {
    next._truncatedKeys = entries.length - ACTIVITY_MAX_OBJECT_KEYS;
  }
  return next;
}

function roughlyEqual(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return left === right;
  }
}

function buildCompactChangeSet(before, after, depth = 0) {
  if (!isPlainObject(before) || !isPlainObject(after)) return null;

  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const beforeDiff = {};
  const afterDiff = {};
  let changedCount = 0;

  for (const key of keys) {
    if (changedCount >= ACTIVITY_MAX_DIFF_KEYS) break;

    const left = before[key];
    const right = after[key];
    if (isPlainObject(left) && isPlainObject(right) && depth < 1) {
      const nested = buildCompactChangeSet(left, right, depth + 1);
      if (nested && (Object.keys(nested.before).length || Object.keys(nested.after).length)) {
        beforeDiff[key] = nested.before;
        afterDiff[key] = nested.after;
        changedCount += 1;
        continue;
      }
    }

    const compactLeft = compactLogValue(left, depth + 1);
    const compactRight = compactLogValue(right, depth + 1);
    if (roughlyEqual(compactLeft, compactRight)) continue;

    beforeDiff[key] = compactLeft;
    afterDiff[key] = compactRight;
    changedCount += 1;
  }

  if (changedCount === 0) return null;

  beforeDiff._changedFieldCount = changedCount;
  afterDiff._changedFieldCount = changedCount;
  if (keys.length > changedCount) {
    const truncated = Math.max(0, keys.length - changedCount);
    if (truncated > 0) {
      beforeDiff._truncatedChanges = truncated;
      afterDiff._truncatedChanges = truncated;
    }
  }

  return { before: beforeDiff, after: afterDiff, changedCount };
}

export async function resolveActivityActor(options = {}) {
  const { force = false } = options;
  const now = Date.now();
  if (!force && actorCache && now - actorCacheAt < ACTOR_CACHE_MS) return actorCache;

  const user = auth.currentUser;
  let account = null;
  try {
    const accountResult = await getMyAccount();
    account = accountResult?.account || null;
  } catch {
    account = null;
  }

  const uid = cleanString(account?.uid || user?.uid);
  const role = cleanString(account?.role || getRoleFromUser(user) || "unknown").toLowerCase();
  const email = cleanString(account?.email || user?.email);
  const name = cleanString(account?.name || user?.displayName);
  const staffId = inferStaffId(uid, account?.staffId);
  const userIdentifier = cleanString(staffId || email || uid || "unknown");
  const store = cleanString(account?.store);
  const department = cleanString(account?.department);

  const resolved = {
    uid,
    role,
    email,
    name,
    staffId,
    userIdentifier,
    store,
    department
  };

  actorCache = resolved;
  actorCacheAt = now;
  return resolved;
}

export async function writeUserActivity(payload = {}) {
  try {
    const actor = payload.actor || (await resolveActivityActor());
    const nowIso = toIso(new Date());
    const retentionDays = resolveRetentionDays();
    const expiresAtIso = toIso(new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000));

    const actionType = normalizeActionType(payload.actionType);
    const storeId = cleanString(payload.storeId || actor.store);
    const storeName = cleanString(payload.storeName);
    const department = cleanString(payload.department || actor.department);
    const section = cleanString(payload.section || payload.logbookSection);
    const logbookSection = cleanString(payload.logbookSection || payload.section);
    const summary = cleanString(payload.summary) || "No summary provided";
    const reasonForChange = cleanString(payload.reasonForChange);

    const actorTokens = uniqueLower([
      actor.uid,
      actor.staffId,
      actor.userIdentifier,
      actor.email,
      actor.name
    ]);
    const scopeTokens = uniqueLower([
      storeId,
      storeName,
      department,
      section,
      logbookSection,
      actionType,
      summary,
      reasonForChange,
      payload.recordId,
      payload.instanceId,
      payload.templateId
    ]);
    const searchTokens = [...new Set([...actorTokens, ...scopeTokens])];
    const compactDiff = buildCompactChangeSet(payload.before, payload.after);
    const compactBefore = compactDiff ? compactDiff.before : compactLogValue(payload.before);
    const compactAfter = compactDiff ? compactDiff.after : compactLogValue(payload.after);
    const compactMetadataValue = compactLogValue(payload.metadata);
    let compactMetadata = compactMetadataValue;
    if (compactDiff?.changedCount) {
      const changeSummary = { changedFieldCount: compactDiff.changedCount };
      if (isPlainObject(compactMetadataValue)) {
        compactMetadata = { ...compactMetadataValue, changeSummary };
      } else if (compactMetadataValue == null) {
        compactMetadata = { changeSummary };
      } else {
        compactMetadata = { value: compactMetadataValue, changeSummary };
      }
    }

    const entry = sanitizeForFirestore({
      createdAt: serverTimestamp(),
      createdAtIso: nowIso,
      actionType,
      summary,
      reasonForChange: reasonForChange || null,
      storeId: storeId || null,
      storeName: storeName || null,
      department: department || null,
      section: section || null,
      logbookSection: logbookSection || null,
      recordType: cleanString(payload.recordType) || null,
      recordId: cleanString(payload.recordId) || null,
      instanceId: cleanString(payload.instanceId) || null,
      templateId: cleanString(payload.templateId) || null,
      dateKey: cleanString(payload.dateKey) || null,
      actorUid: actor.uid || null,
      actorRole: actor.role || null,
      actorEmail: actor.email || null,
      actorName: actor.name || null,
      actorStaffId: actor.staffId || null,
      actorIdentifier: actor.userIdentifier || null,
      actorSearch: actorTokens,
      searchTokens,
      searchText: searchTokens.join(" "),
      retentionDays,
      expiresAtIso,
      before: compactBefore == null ? null : compactBefore,
      after: compactAfter == null ? null : compactAfter,
      metadata: compactMetadata == null ? null : compactMetadata
    });

    await addDoc(collection(db, ACTIVITY_COLLECTION), entry);
    scheduleRetentionCleanup(actor);
    return entry;
  } catch (error) {
    console.warn("Activity logging failed:", error);
    return null;
  }
}

export async function logLoginActivityOncePerSession(extra = {}) {
  const actor = await resolveActivityActor({ force: true });
  const identity = actor.uid || actor.staffId || actor.email || "";
  if (!identity) return false;
  const sessionKey = `${LOGIN_SESSION_KEY_PREFIX}${identity}`;
  try {
    if (window.sessionStorage.getItem(sessionKey)) return false;
  } catch {
    // ignore storage access issues
  }

  const summary = cleanString(extra.summary) || `Signed in as ${actor.role || "user"}`;
  const result = await writeUserActivity({
    actor,
    actionType: "login",
    summary,
    storeId: extra.storeId || actor.store,
    department: extra.department || actor.department,
    section: cleanString(extra.section) || "Authentication",
    metadata: {
      destination: `${window.location.pathname}${window.location.search}`,
      loginMethod: cleanString(extra.loginMethod) || null
    }
  });

  if (result) {
    try {
      window.sessionStorage.setItem(sessionKey, result.createdAtIso || new Date().toISOString());
    } catch {
      // ignore storage access issues
    }
    return true;
  }

  return false;
}
