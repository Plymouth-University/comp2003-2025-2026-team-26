const { randomUUID } = require("crypto");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const bcrypt = require("bcryptjs");

// Callable functions must be publicly invokable from the browser; we enforce access
// control using Firebase Auth inside each handler (assertAuthenticated/assertAdmin).
setGlobalOptions({ invoker: "public" });

const databaseURL =
  process.env.FIREBASE_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "https://friarymilllogbooks-default-rtdb.europe-west1.firebasedatabase.app";

admin.initializeApp({ databaseURL });
const db = admin.database();
const auth = admin.auth();
const firestore = admin.firestore();

const HASH_SALT_ROUNDS = 10;
const PIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const PIN_RATE_LIMIT_MAX_ATTEMPTS = 8;
const PIN_RATE_LIMIT_LOCKOUT_MS = 30 * 60 * 1000;
const RECORD_ARCHIVE_DEFAULT_DAYS = 365;
const RECORD_ARCHIVE_MIN_DAYS = 90;
const RECORD_ARCHIVE_MAX_DAYS = 3650;
const RECORD_ARCHIVE_DEFAULT_BATCH_SIZE = 80;
const RECORD_ARCHIVE_MAX_BATCH_SIZE = 100;
const RECORD_ARCHIVE_SCHEDULE = "15 3 * * *";
const RECORD_ARCHIVE_SCHEDULE_TIME_ZONE = "Europe/London";
const RECORD_ARCHIVE_SCHEDULE_MAX_BATCHES = 25;
const RECORD_ARCHIVE_LEASE_TTL_MS = 20 * 60 * 1000;
const RECORD_ARCHIVE_CONTROL_DOC_PATH = "system_jobs/record_archive";

async function hashPin(pin) {
  return bcrypt.hash(pin, HASH_SALT_ROUNDS);
}

function cleanString(value) {
  const text = String(value || "").trim();
  return text || "";
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function base64UrlEncodeUtf8(input) {
  return Buffer.from(String(input), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64AnyDecodeToUtf8(input) {
  let b64 = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  return Buffer.from(b64, "base64").toString("utf8");
}

function flattenPinIndex(node, prefix = "") {
  const out = [];
  if (!node || typeof node !== "object") return out;

  for (const [key, value] of Object.entries(node)) {
    const nextKey = prefix ? `${prefix}/${key}` : key;
    if (typeof value === "string") {
      out.push({ key: nextKey, uid: value });
      continue;
    }
    if (value && typeof value === "object") {
      out.push(...flattenPinIndex(value, nextKey));
    }
  }

  return out;
}

function logInternalError(functionName, error, context = {}) {
  console.error(`[${functionName}]`, {
    message: error?.message || String(error),
    code: error?.code || null,
    stack: error?.stack || null,
    context
  });
}

function throwPublicInternal(functionName, error, publicMessage, context = {}) {
  logInternalError(functionName, error, context);
  throw new HttpsError("internal", publicMessage);
}

function getRequestIp(request) {
  const rawRequest = request?.rawRequest;
  const forwarded = rawRequest?.headers?.["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const forwardedIp = cleanString(value).split(",")[0].trim();
  if (forwardedIp) return forwardedIp;
  return cleanString(rawRequest?.ip || rawRequest?.socket?.remoteAddress);
}

function getPinRateLimitKey(request) {
  const ip = getRequestIp(request);
  const userAgent = cleanString(request?.rawRequest?.headers?.["user-agent"]).slice(0, 120);
  const fingerprint = ip ? `ip:${ip}` : `ua:${userAgent || "unknown"}`;
  return base64UrlEncodeUtf8(fingerprint).slice(0, 180);
}

async function assertPinLoginAllowed(rateLimitKey) {
  const snap = await db.ref(`security/pinLoginRateLimits/${rateLimitKey}`).once("value");
  const state = snap.val() || {};
  const now = Date.now();
  const lockoutUntil = Number(state.lockoutUntil || 0);
  if (lockoutUntil > now) {
    throw new HttpsError("resource-exhausted", "Too many PIN attempts. Try again later.");
  }
}

async function recordPinFailure(rateLimitKey) {
  const ref = db.ref(`security/pinLoginRateLimits/${rateLimitKey}`);
  const now = Date.now();
  let attempts = 0;
  let lockoutUntil = 0;

  await ref.transaction((current) => {
    const state = current && typeof current === "object" ? current : {};
    const currentLockout = Number(state.lockoutUntil || 0);
    if (currentLockout > now) {
      attempts = Number(state.attemptCount || PIN_RATE_LIMIT_MAX_ATTEMPTS);
      lockoutUntil = currentLockout;
      return state;
    }

    const previousFirstAttemptAt = Number(state.firstAttemptAt || 0);
    const withinWindow = previousFirstAttemptAt > 0 && now - previousFirstAttemptAt < PIN_RATE_LIMIT_WINDOW_MS;
    const nextFirstAttemptAt = withinWindow ? previousFirstAttemptAt : now;
    attempts = withinWindow ? Number(state.attemptCount || 0) + 1 : 1;
    lockoutUntil = attempts >= PIN_RATE_LIMIT_MAX_ATTEMPTS ? now + PIN_RATE_LIMIT_LOCKOUT_MS : 0;

    return {
      firstAttemptAt: nextFirstAttemptAt,
      attemptCount: attempts,
      lastFailureAt: now,
      lockoutUntil,
      updatedAt: now
    };
  });

  return { attempts, lockoutUntil };
}

async function clearPinRateLimit(rateLimitKey) {
  await db.ref(`security/pinLoginRateLimits/${rateLimitKey}`).remove().catch(() => {});
}

function buildArchiveEntryId(templateId, dateKey) {
  return `${templateId}__${dateKey}`;
}

async function fetchArchiveCandidateInstances(cutoffDate, batchSize) {
  const byId = new Map();
  const primarySnap = await firestore
    .collection("logbook_instances")
    .where("date", "<=", cutoffDate)
    .orderBy("date", "asc")
    .limit(batchSize)
    .get();

  primarySnap.docs.forEach((docSnap) => byId.set(docSnap.id, docSnap));

  if (byId.size < batchSize) {
    const legacySnap = await firestore
      .collection("logbook_instances")
      .where("workDate", "<=", cutoffDate)
      .orderBy("workDate", "asc")
      .limit(batchSize)
      .get();

    legacySnap.docs.forEach((docSnap) => {
      if (byId.size >= batchSize) return;
      if (!byId.has(docSnap.id)) byId.set(docSnap.id, docSnap);
    });
  }

  return [...byId.values()];
}

async function archiveOldRecordsImpl({ actorUid, olderThanDays, batchSize }) {
  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);
  const candidateDocs = await fetchArchiveCandidateInstances(cutoffDate, batchSize);
  if (candidateDocs.length === 0) {
    return {
      cutoffDate,
      archivedInstances: 0,
      archivedEntries: 0
    };
  }

  const archiveAtIso = new Date().toISOString();
  const batch = firestore.batch();
  const entryRefsByPath = new Map();

  candidateDocs.forEach((docSnap) => {
    const instance = docSnap.data() || {};
    const archiveRef = firestore.collection("archived_logbook_instances").doc(docSnap.id);
    batch.set(archiveRef, {
      ...instance,
      archivedAt: admin.firestore.FieldValue.serverTimestamp(),
      archivedAtIso,
      archivedBy: actorUid,
      archivedFromPath: docSnap.ref.path
    }, { merge: true });
    batch.delete(docSnap.ref);

    const templateId = cleanString(instance.templateId);
    const dateKey = cleanString(instance.date || instance.workDate);
    if (!templateId || !dateKey) return;
    const entryRef = firestore.doc(`log_entries/${templateId}/${dateKey}/meta`);
    entryRefsByPath.set(entryRef.path, entryRef);
  });

  const entryRefs = [...entryRefsByPath.values()];
  if (entryRefs.length > 0) {
    const entrySnaps = await firestore.getAll(...entryRefs);
    entrySnaps.forEach((entrySnap) => {
      if (!entrySnap.exists) return;
      const entryData = entrySnap.data() || {};
      const [, templateId = "", dateKey = ""] = entrySnap.ref.path.split("/");
      const archiveRef = firestore.collection("archived_log_entries").doc(buildArchiveEntryId(templateId, dateKey));
      batch.set(archiveRef, {
        ...entryData,
        templateId,
        dateKey,
        archivedAt: admin.firestore.FieldValue.serverTimestamp(),
        archivedAtIso,
        archivedBy: actorUid,
        archivedFromPath: entrySnap.ref.path
      }, { merge: true });
      batch.delete(entrySnap.ref);
    });
  }

  await batch.commit();

  return {
    cutoffDate,
    archivedInstances: candidateDocs.length,
    archivedEntries: entryRefs.length
  };
}

class ArchiveLeaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArchiveLeaseError";
  }
}

function getArchiveControlRef() {
  return firestore.doc(RECORD_ARCHIVE_CONTROL_DOC_PATH);
}

function toDateOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value.toDate === "function") {
    const parsed = value.toDate();
    return parsed instanceof Date && !Number.isNaN(parsed.getTime()) ? parsed : null;
  }
  if (typeof value.seconds === "number") {
    const parsed = new Date(value.seconds * 1000);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildArchiveLeaseExpiry() {
  return admin.firestore.Timestamp.fromMillis(Date.now() + RECORD_ARCHIVE_LEASE_TTL_MS);
}

function sanitizeArchiveResult(result = {}) {
  return {
    success: Boolean(result.success),
    trigger: cleanString(result.trigger),
    actorUid: cleanString(result.actorUid),
    olderThanDays: clampInteger(result.olderThanDays, RECORD_ARCHIVE_DEFAULT_DAYS, RECORD_ARCHIVE_MIN_DAYS, RECORD_ARCHIVE_MAX_DAYS),
    batchSize: clampInteger(result.batchSize, RECORD_ARCHIVE_DEFAULT_BATCH_SIZE, 1, RECORD_ARCHIVE_MAX_BATCH_SIZE),
    maxBatches: clampInteger(result.maxBatches, RECORD_ARCHIVE_SCHEDULE_MAX_BATCHES, 1, 1000),
    batchRuns: clampInteger(result.batchRuns, 0, 0, 1000),
    cutoffDate: cleanString(result.cutoffDate),
    archivedInstances: clampInteger(result.archivedInstances, 0, 0, Number.MAX_SAFE_INTEGER),
    archivedEntries: clampInteger(result.archivedEntries, 0, 0, Number.MAX_SAFE_INTEGER),
    backlogRemaining: Boolean(result.backlogRemaining)
  };
}

async function acquireArchiveLease({ owner = "", trigger = "unknown" } = {}) {
  const leaseId = randomUUID();
  const controlRef = getArchiveControlRef();
  const now = Date.now();
  const ownerLabel = cleanString(owner) || "system";
  const triggerLabel = cleanString(trigger) || "unknown";

  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(controlRef);
    const state = snapshot.exists ? (snapshot.data() || {}) : {};
    const activeLeaseId = cleanString(state.activeLeaseId);
    const activeLeaseExpiresAt = toDateOrNull(state.activeLeaseExpiresAt);
    const leaseStillActive = Boolean(
      activeLeaseId &&
      activeLeaseExpiresAt &&
      activeLeaseExpiresAt.getTime() > now
    );

    if (leaseStillActive) {
      const activeOwner = cleanString(state.activeLeaseOwner) || "another worker";
      throw new ArchiveLeaseError(`Archive maintenance already running (${activeOwner}).`);
    }

    transaction.set(controlRef, {
      activeLeaseId: leaseId,
      activeLeaseOwner: ownerLabel,
      activeLeaseTrigger: triggerLabel,
      activeLeaseStartedAt: admin.firestore.FieldValue.serverTimestamp(),
      activeLeaseExpiresAt: buildArchiveLeaseExpiry(),
      lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
      lastAttemptOwner: ownerLabel,
      lastAttemptTrigger: triggerLabel,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });

  return {
    leaseId,
    owner: ownerLabel,
    trigger: triggerLabel,
    controlRef
  };
}

async function refreshArchiveLease(lease) {
  if (!lease?.leaseId) return;

  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(lease.controlRef);
    const state = snapshot.exists ? (snapshot.data() || {}) : {};
    if (cleanString(state.activeLeaseId) !== lease.leaseId) {
      throw new ArchiveLeaseError("Archive lease was lost before refresh completed.");
    }

    transaction.set(lease.controlRef, {
      activeLeaseExpiresAt: buildArchiveLeaseExpiry(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
}

async function releaseArchiveLease(lease, { status = "success", result = null, error = null } = {}) {
  if (!lease?.leaseId) return;

  const normalizedStatus = cleanString(status) || "success";
  const normalizedError = cleanString(error);
  const normalizedResult = result ? sanitizeArchiveResult(result) : null;

  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(lease.controlRef);
    const state = snapshot.exists ? (snapshot.data() || {}) : {};
    if (cleanString(state.activeLeaseId) !== lease.leaseId) return;

    const payload = {
      activeLeaseId: null,
      activeLeaseOwner: null,
      activeLeaseTrigger: null,
      activeLeaseExpiresAt: null,
      lastCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastCompletedStatus: normalizedStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (normalizedStatus === "success") {
      payload.lastSuccessAt = admin.firestore.FieldValue.serverTimestamp();
      payload.lastError = null;
    } else if (normalizedError) {
      payload.lastError = normalizedError;
    }

    if (normalizedResult) {
      payload.lastResult = normalizedResult;
    }

    transaction.set(lease.controlRef, payload, { merge: true });
  });
}

async function writeSystemAudit(action, details = {}) {
  try {
    await db.ref("auditLogs").push({
      at: admin.database.ServerValue.TIMESTAMP,
      action,
      actorUid: null,
      actorEmail: null,
      targetUid: null,
      targetEmail: null,
      details
    });
  } catch (error) {
    console.warn("System audit logging failed:", error?.message || error);
  }
}

async function runArchiveMaintenanceJob({
  actorUid = "",
  trigger = "callable",
  olderThanDays = RECORD_ARCHIVE_DEFAULT_DAYS,
  batchSize = RECORD_ARCHIVE_DEFAULT_BATCH_SIZE,
  maxBatches = RECORD_ARCHIVE_SCHEDULE_MAX_BATCHES
} = {}) {
  const normalizedActorUid = cleanString(actorUid) || `system:${cleanString(trigger) || "archive"}`;
  const normalizedTrigger = cleanString(trigger) || "callable";
  const normalizedOlderThanDays = clampInteger(
    olderThanDays,
    RECORD_ARCHIVE_DEFAULT_DAYS,
    RECORD_ARCHIVE_MIN_DAYS,
    RECORD_ARCHIVE_MAX_DAYS
  );
  const normalizedBatchSize = clampInteger(
    batchSize,
    RECORD_ARCHIVE_DEFAULT_BATCH_SIZE,
    1,
    RECORD_ARCHIVE_MAX_BATCH_SIZE
  );
  const normalizedMaxBatches = clampInteger(maxBatches, RECORD_ARCHIVE_SCHEDULE_MAX_BATCHES, 1, 1000);
  const lease = await acquireArchiveLease({
    owner: normalizedActorUid,
    trigger: normalizedTrigger
  });

  let totalArchivedInstances = 0;
  let totalArchivedEntries = 0;
  let cutoffDate = "";
  let batchRuns = 0;
  let backlogRemaining = false;

  try {
    while (batchRuns < normalizedMaxBatches) {
      const result = await archiveOldRecordsImpl({
        actorUid: normalizedActorUid,
        olderThanDays: normalizedOlderThanDays,
        batchSize: normalizedBatchSize
      });

      cutoffDate = cleanString(result.cutoffDate) || cutoffDate;
      totalArchivedInstances += clampInteger(result.archivedInstances, 0, 0, Number.MAX_SAFE_INTEGER);
      totalArchivedEntries += clampInteger(result.archivedEntries, 0, 0, Number.MAX_SAFE_INTEGER);
      batchRuns += 1;

      const archivedInstancesThisBatch = clampInteger(result.archivedInstances, 0, 0, Number.MAX_SAFE_INTEGER);
      if (archivedInstancesThisBatch === 0) break;
      if (archivedInstancesThisBatch < normalizedBatchSize) break;

      await refreshArchiveLease(lease);
      if (batchRuns >= normalizedMaxBatches) {
        backlogRemaining = true;
      }
    }

    const finalResult = sanitizeArchiveResult({
      success: true,
      trigger: normalizedTrigger,
      actorUid: normalizedActorUid,
      olderThanDays: normalizedOlderThanDays,
      batchSize: normalizedBatchSize,
      maxBatches: normalizedMaxBatches,
      batchRuns,
      cutoffDate,
      archivedInstances: totalArchivedInstances,
      archivedEntries: totalArchivedEntries,
      backlogRemaining
    });

    await releaseArchiveLease(lease, {
      status: "success",
      result: finalResult
    });
    return finalResult;
  } catch (error) {
    await releaseArchiveLease(lease, {
      status: "error",
      error: error?.message || String(error)
    });
    throw error;
  }
}

function assertAuthenticated(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
}

async function readAccountMeta(uid) {
  if (!uid) return {};
  try {
    const snap = await db.ref(`accounts/${uid}`).once("value");
    return snap.val() || {};
  } catch {
    return {};
  }
}

function buildScopedClaims(existingClaims = {}, updates = {}) {
  const claims = existingClaims && typeof existingClaims === "object" ? { ...existingClaims } : {};

  if (Object.prototype.hasOwnProperty.call(updates, "role")) {
    const role = cleanString(updates.role);
    if (role) claims.role = role;
    else delete claims.role;
  }

  if (Object.prototype.hasOwnProperty.call(updates, "store")) {
    const store = cleanString(updates.store);
    if (store) {
      claims.store = store;
      claims.storeId = store;
    } else {
      delete claims.store;
      delete claims.storeId;
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, "department")) {
    const department = cleanString(updates.department);
    if (department) claims.department = department;
    else delete claims.department;
  }

  return claims;
}

async function syncAccountClaims(uid, updates = {}) {
  const normalizedUid = cleanString(uid);
  if (!normalizedUid) return;

  let existingClaims = {};
  try {
    const userRecord = await auth.getUser(normalizedUid);
    existingClaims = userRecord?.customClaims || {};
  } catch {
    existingClaims = {};
  }

  await auth.setCustomUserClaims(normalizedUid, buildScopedClaims(existingClaims, updates));
}

function getCallerRole(request) {
  const uid = request.auth?.uid || "";
  const token = request.auth?.token || {};
  const claimRole = token.role;

  if (typeof claimRole === "string" && claimRole.trim()) return claimRole.trim().toLowerCase();
  if (token.admin === true) return "admin";
  if (uid.startsWith("staff_")) return "staff";

  return null;
}

async function assertAdmin(request) {
  assertAuthenticated(request);
  const role = getCallerRole(request);
  if (role !== "admin") {
    throw new HttpsError("permission-denied", "Admin access required.");
  }
}

// Used by the frontend to resolve role + scope reliably after login.
exports.getMyAccount = onCall(async (request) => {
  assertAuthenticated(request);

  const uid = request.auth.uid;
  const token = request.auth?.token || {};

  const meta = await readAccountMeta(uid);
  const role = getCallerRole(request);
  const store = cleanString(meta.store || token.store || token.storeId);
  const department = cleanString(meta.department || token.department);

  return {
    success: true,
    account: {
      uid,
      role,
      email: token.email || meta.email || null,
      name: meta.name || null,
      store,
      storeId: store,
      department,
      staffId: meta.staffId || (uid.startsWith("staff_") ? uid.slice("staff_".length) : null)
    }
  };
});

async function writeAudit(action, request, target = {}, details = {}) {
  try {
    const actorUid = request?.auth?.uid || null;
    const actorEmail = request?.auth?.token?.email || null;

    await db.ref("auditLogs").push({
      at: admin.database.ServerValue.TIMESTAMP,
      action,
      actorUid,
      actorEmail,
      targetUid: target.uid || null,
      targetEmail: target.email || null,
      details
    });
  } catch (error) {
    console.warn("Audit logging failed:", error?.message || error);
  }
}

async function getUidForPin(pin) {
  const pinIndexRef = db.ref("pinsToUids");
  const snapshot = await pinIndexRef.once("value");
  const allPins = snapshot.val() || {};

  const entries = flattenPinIndex(allPins);
  for (const entry of entries) {
    const storedHash = base64AnyDecodeToUtf8(entry.key);
    const match = await bcrypt.compare(pin, storedHash);
    if (match) return entry.uid;
  }

  return null;
}

exports.adminCreateEmailAccount = onCall(async (request) => {
  await assertAdmin(request);

  const data = request.data || {};
  const email = String(data.email || "").trim().toLowerCase();
  const password = String(data.password || "");
  const role = String(data.role || "").trim().toLowerCase();
  const name = String(data.name || "").trim();
  const store = String(data.store || "").trim();
  const department = String(data.department || "").trim();

  if (!email || !email.includes("@")) {
    throw new HttpsError("invalid-argument", "Email is required.");
  }
  if (!password || password.length < 6) {
    throw new HttpsError("invalid-argument", "Password must be at least 6 characters.");
  }
  if (!["admin", "manager"].includes(role)) {
    throw new HttpsError("invalid-argument", "Role must be 'admin' or 'manager'.");
  }

  try {
    const userRecord = await auth.createUser({
      email,
      password,
      displayName: name || undefined,
      disabled: false
    });

    await syncAccountClaims(userRecord.uid, { role, store, department });

    await db.ref(`accounts/${userRecord.uid}`).set({
      uid: userRecord.uid,
      role,
      email: userRecord.email || email,
      name: name || userRecord.displayName || "",
      store,
      department,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });

    await writeAudit(
      "create_email_account",
      request,
      { uid: userRecord.uid, email: userRecord.email || email },
      { role, store, department }
    );

    return { success: true, uid: userRecord.uid, email: userRecord.email || email, role };
  } catch (error) {
    throwPublicInternal("adminCreateEmailAccount", error, "Failed to create account.", { email, role });
  }
});

exports.adminUpdateAccountProfile = onCall(async (request) => {
  await assertAdmin(request);

  const data = request.data || {};
  const uid = String(data.uid || "").trim();
  const name = typeof data.name === "string" ? data.name.trim() : undefined;
  const store = typeof data.store === "string" ? data.store.trim() : undefined;
  const department = typeof data.department === "string" ? data.department.trim() : undefined;

  if (!uid) throw new HttpsError("invalid-argument", "uid is required.");

  const updates = {};
  if (name != null) updates.name = name;
  if (store != null) updates.store = store;
  if (department != null) updates.department = department;
  updates.updatedAt = admin.database.ServerValue.TIMESTAMP;
  const currentMeta = await readAccountMeta(uid);

  try {
    const userRecord = await auth.getUser(uid);
    const existingClaims = userRecord?.customClaims || {};
    const existingRole = uid.startsWith("staff_") ? "staff" : cleanString(existingClaims.role);

    await db.ref(`accounts/${uid}`).update(updates);
    if (typeof name === "string") {
      await auth.updateUser(uid, { displayName: name || undefined });
    }

    await syncAccountClaims(uid, {
      ...(existingRole ? { role: existingRole } : {}),
      ...(store != null || currentMeta.store != null ? { store: store != null ? store : currentMeta.store } : {}),
      ...(department != null || currentMeta.department != null
        ? { department: department != null ? department : currentMeta.department }
        : {})
    });

    await writeAudit("update_account_profile", request, { uid }, { name, store, department });
    return { success: true };
  } catch (error) {
    throwPublicInternal("adminUpdateAccountProfile", error, "Failed to update profile.", { uid });
  }
});

exports.adminSetAccountRole = onCall(async (request) => {
  await assertAdmin(request);

  const data = request.data || {};
  const uid = String(data.uid || "").trim();
  const role = String(data.role || "").trim().toLowerCase();

  if (!uid) throw new HttpsError("invalid-argument", "uid is required.");
  if (uid.startsWith("staff_")) throw new HttpsError("failed-precondition", "Staff accounts cannot be switched to email roles.");
  if (!["admin", "manager"].includes(role)) {
    throw new HttpsError("invalid-argument", "Role must be 'admin' or 'manager'.");
  }

  try {
    const currentMeta = await readAccountMeta(uid);
    await syncAccountClaims(uid, {
      role,
      ...(currentMeta.store != null ? { store: currentMeta.store } : {}),
      ...(currentMeta.department != null ? { department: currentMeta.department } : {})
    });
    await db.ref(`accounts/${uid}`).update({
      role,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });

    await writeAudit("set_account_role", request, { uid }, { role });
    return { success: true };
  } catch (error) {
    throwPublicInternal("adminSetAccountRole", error, "Failed to set role.", { uid, role });
  }
});

exports.adminSetAccountDisabled = onCall(async (request) => {
  await assertAdmin(request);

  const data = request.data || {};
  const uid = String(data.uid || "").trim();
  const disabled = Boolean(data.disabled);

  if (!uid) throw new HttpsError("invalid-argument", "uid is required.");

  try {
    await auth.updateUser(uid, { disabled });
    await db.ref(`accounts/${uid}`).update({
      disabled,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });

    await writeAudit("set_account_disabled", request, { uid }, { disabled });
    return { success: true };
  } catch (error) {
    throwPublicInternal("adminSetAccountDisabled", error, "Failed to update status.", { uid, disabled });
  }
});

exports.adminGeneratePasswordResetLink = onCall(async (request) => {
  await assertAdmin(request);

  const data = request.data || {};
  const email = String(data.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) throw new HttpsError("invalid-argument", "Email is required.");

  try {
    const link = await auth.generatePasswordResetLink(email);
    await writeAudit("generate_password_reset_link", request, { email }, {});
    return { success: true, link };
  } catch (error) {
    throwPublicInternal("adminGeneratePasswordResetLink", error, "Failed to generate reset link.", { email });
  }
});

exports.adminListAccounts = onCall(async (request) => {
  await assertAdmin(request);

  try {
    const [usersResult, accountsSnap] = await Promise.all([
      auth.listUsers(1000),
      db.ref("accounts").once("value")
    ]);

    const metaByUid = accountsSnap.val() || {};

    const accounts = usersResult.users.map((user) => {
      const uid = user.uid;
      const isStaff = uid.startsWith("staff_");
      const meta = metaByUid[uid] || {};

      const role = isStaff ? "staff" : (user.customClaims?.role || meta.role || "manager");
      const staffId = isStaff ? (meta.staffId || uid.slice("staff_".length)) : null;

      return {
        uid,
        email: user.email || meta.email || null,
        name: meta.name || user.displayName || (staffId || ""),
        role,
        store: meta.store || "",
        department: meta.department || "",
        disabled: Boolean(user.disabled),
        lastLogin: user.metadata?.lastSignInTime || null,
        createdAt: user.metadata?.creationTime || null,
        staffId
      };
    });

    return { success: true, accounts };
  } catch (error) {
    throwPublicInternal("adminListAccounts", error, "Failed to list accounts.");
  }
});

exports.adminSetStaffPin = onCall(async (request) => {
  await assertAdmin(request);

  const data = request.data || {};
  const staffId = String(data.staffId || "").trim().toLowerCase();
  const pin = String(data.pin || "");

  if (!staffId) throw new HttpsError("invalid-argument", "Staff ID is required.");
  if (!/^\d{4}$/.test(pin)) throw new HttpsError("invalid-argument", "A 4-digit PIN is required.");

  const staffRef = db.ref(`staff/${staffId}`);
  const staffSnapshot = await staffRef.once("value");
  if (!staffSnapshot.exists()) throw new HttpsError("not-found", "Staff record not found.");

  const staff = staffSnapshot.val() || {};
  const uid = String(staff.uid || `staff_${staffId}`);

  try {
    // Enforce unique PINs to avoid ambiguous logins.
    const existingUid = await getUidForPin(pin);
    if (existingUid && existingUid !== uid) {
      throw new HttpsError("already-exists", "PIN already in use. Choose a different 4-digit PIN.");
    }

    // Remove old pin index entry if present.
    const oldHashedPin = staff.hashedPin;
    const oldIndexKeyUrl = staff.pinIndexKey ? String(staff.pinIndexKey) : null;
    if (oldIndexKeyUrl) {
      await db.ref("pinsToUids").child(oldIndexKeyUrl).remove().catch(() => {});
    }
    if (oldHashedPin) {
      const oldKeyUrl = base64UrlEncodeUtf8(oldHashedPin);
      const oldKeyStd = Buffer.from(String(oldHashedPin), "utf8").toString("base64");
      await db.ref("pinsToUids").child(oldKeyUrl).remove().catch(() => {});
      await db.ref("pinsToUids").child(oldKeyStd).remove().catch(() => {});
    }

    const hashedPin = await hashPin(pin);
    const pinIndexKey = base64UrlEncodeUtf8(hashedPin);

    await Promise.all([
      staffRef.update({
        hashedPin,
        pinIndexKey,
        updatedAt: admin.database.ServerValue.TIMESTAMP
      }),
      db.ref(`pinsToUids/${pinIndexKey}`).set(uid)
    ]);

    await writeAudit("set_staff_pin", request, { uid, email: staff.email || null }, { staffId });
    return { success: true, message: "PIN updated." };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throwPublicInternal("adminSetStaffPin", error, "Failed to update PIN.", { staffId });
  }
});

exports.createStaffAccountFinal = onCall(async (request) => {
  await assertAdmin(request);

  const data = request.data || {};
  const staffId = data.staffId;
  const pin = data.pin;
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const store = typeof data.store === "string" ? data.store.trim() : "";
  const department = typeof data.department === "string" ? data.department.trim() : "";

  if (!staffId || typeof staffId !== "string" || staffId.trim().length === 0) {
    throw new HttpsError("invalid-argument", "Staff ID is required.");
  }
  if (!pin || typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
    throw new HttpsError("invalid-argument", "A 4-digit PIN is required.");
  }

  const staffIdNormalized = staffId.trim().toLowerCase();

  try {
    const staffRef = db.ref(`staff/${staffIdNormalized}`);
    const staffSnapshot = await staffRef.once("value");
    if (staffSnapshot.exists()) {
      throw new HttpsError("already-exists", `Staff ID '${staffIdNormalized}' already exists.`);
    }

    // Enforce unique PINs to avoid ambiguous logins.
    const existingUid = await getUidForPin(pin);
    if (existingUid) {
      throw new HttpsError("already-exists", "PIN already in use. Choose a different 4-digit PIN.");
    }

    const hashedPin = await hashPin(pin);
    const pinIndexKey = base64UrlEncodeUtf8(hashedPin);

    const authUid = `staff_${staffIdNormalized}`;
    const userRecord = await auth.createUser({
      uid: authUid,
      displayName: name || staffIdNormalized,
      email: `${staffIdNormalized}@friarymilllogbooks.com`,
      emailVerified: false,
      disabled: false
    });

    await syncAccountClaims(userRecord.uid, { role: "staff", store, department });

    await Promise.all([
      staffRef.set({
        uid: userRecord.uid,
        staffId: staffIdNormalized,
        hashedPin,
        pinIndexKey,
        role: "staff",
        name: name || staffIdNormalized,
        store,
        department,
        createdAt: admin.database.ServerValue.TIMESTAMP
      }),
      db.ref(`pinsToUids/${pinIndexKey}`).set(userRecord.uid),
      db.ref(`accounts/${userRecord.uid}`).set({
        uid: userRecord.uid,
        role: "staff",
        email: userRecord.email || "",
        staffId: staffIdNormalized,
        name: name || staffIdNormalized,
        store,
        department,
        disabled: false,
        createdAt: admin.database.ServerValue.TIMESTAMP
      })
    ]);

    await writeAudit(
      "create_staff_account",
      request,
      { uid: userRecord.uid, email: userRecord.email || "" },
      { staffId: staffIdNormalized, store, department }
    );

    return {
      success: true,
      message: `Staff account '${staffIdNormalized}' created successfully.`
    };
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }
    throwPublicInternal("createStaffAccountFinal", error, "Failed to create staff account.", { staffId: staffIdNormalized });
  }
});

exports.authenticateStaffPin = onCall(async (request) => {
  const data = request.data || {};
  const pin = data.pin;
  const rateLimitKey = getPinRateLimitKey(request);

  if (!pin || typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
    throw new HttpsError("invalid-argument", "A 4-digit PIN is required.");
  }

  try {
    await assertPinLoginAllowed(rateLimitKey);
    const authenticatedUid = await getUidForPin(pin);
    if (!authenticatedUid) {
      const failure = await recordPinFailure(rateLimitKey);
      if (failure.lockoutUntil > Date.now()) {
        throw new HttpsError("resource-exhausted", "Too many PIN attempts. Try again later.");
      }
      throw new HttpsError("unauthenticated", "Invalid PIN.");
    }

    const userRecord = await auth.getUser(authenticatedUid);
    if (userRecord.disabled) {
      await recordPinFailure(rateLimitKey);
      throw new HttpsError("unauthenticated", "Account disabled.");
    }

    await clearPinRateLimit(rateLimitKey);
    const customToken = await auth.createCustomToken(authenticatedUid, {
      role: "staff"
    });

    return { customToken };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throwPublicInternal("authenticateStaffPin", error, "PIN login failed.");
  }
});

exports.archiveOldRecordsScheduled = onSchedule({
  schedule: RECORD_ARCHIVE_SCHEDULE,
  timeZone: RECORD_ARCHIVE_SCHEDULE_TIME_ZONE,
  region: "europe-west1",
  timeoutSeconds: 540,
  memory: "512MiB"
}, async () => {
  try {
    const result = await runArchiveMaintenanceJob({
      actorUid: "system:scheduler",
      trigger: "scheduler",
      olderThanDays: RECORD_ARCHIVE_DEFAULT_DAYS,
      batchSize: RECORD_ARCHIVE_DEFAULT_BATCH_SIZE,
      maxBatches: RECORD_ARCHIVE_SCHEDULE_MAX_BATCHES
    });

    await writeSystemAudit("archive_old_records_scheduled", result);
    return result;
  } catch (error) {
    if (error instanceof ArchiveLeaseError) {
      console.log("[archiveOldRecordsScheduled] skipped:", error.message);
      return {
        skipped: true,
        reason: "already-running",
        message: error.message
      };
    }

    logInternalError("archiveOldRecordsScheduled", error);
    throw error;
  }
});

exports.archiveOldRecords = onCall(async (request) => {
  await assertAdmin(request);

  const olderThanDays = clampInteger(
    request?.data?.olderThanDays,
    RECORD_ARCHIVE_DEFAULT_DAYS,
    RECORD_ARCHIVE_MIN_DAYS,
    RECORD_ARCHIVE_MAX_DAYS
  );
  const batchSize = clampInteger(
    request?.data?.batchSize,
    RECORD_ARCHIVE_DEFAULT_BATCH_SIZE,
    1,
    RECORD_ARCHIVE_MAX_BATCH_SIZE
  );

  try {
    const result = await runArchiveMaintenanceJob({
      actorUid: request.auth.uid,
      trigger: "callable",
      olderThanDays,
      batchSize,
      maxBatches: 1
    });

    await writeAudit("archive_old_records", request, {}, {
      olderThanDays,
      batchSize,
      archivedInstances: result.archivedInstances,
      archivedEntries: result.archivedEntries,
      cutoffDate: result.cutoffDate
    });

    return {
      success: true,
      ...result,
      olderThanDays,
      batchSize
    };
  } catch (error) {
    if (error instanceof ArchiveLeaseError) {
      throw new HttpsError("aborted", "Archive maintenance is already running.");
    }
    if (error instanceof HttpsError) throw error;
    throwPublicInternal("archiveOldRecords", error, "Failed to archive old records.", {
      olderThanDays,
      batchSize
    });
  }
});
