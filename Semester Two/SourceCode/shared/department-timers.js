import { db } from "./logbook-app.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  where
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { cleanString } from "./logbook-runtime.js";

export const DEPARTMENT_TIMER_COLLECTION = "department_timer_rules";
export const TIMER_STATE_DEFAULTS = Object.freeze({
  upcoming: "upcoming",
  warning: "warning",
  urgent: "urgent",
  overdue: "overdue",
  completed: "completed",
  none: "none"
});

export function buildDepartmentTimerRuleId(storeId, department) {
  const nextStoreId = cleanString(storeId);
  const nextDepartment = cleanString(department);
  if (!nextStoreId || !nextDepartment) return "";
  return `${nextStoreId}__${encodeURIComponent(nextDepartment)}`;
}

export function getDepartmentTimerRef(storeId, department) {
  const id = buildDepartmentTimerRuleId(storeId, department);
  return id ? doc(db, DEPARTMENT_TIMER_COLLECTION, id) : null;
}

export function buildDueAtIso(dateKey, dueTime) {
  const nextDateKey = cleanString(dateKey);
  const nextDueTime = cleanString(dueTime);
  if (!nextDateKey || !nextDueTime) return "";
  const next = new Date(`${nextDateKey}T${nextDueTime}:00`);
  return Number.isNaN(next.getTime()) ? "" : next.toISOString();
}

export function buildTimerFields({ dateKey = "", dueTime = "", status = "" } = {}) {
  const nextDueTime = cleanString(dueTime);
  if (!nextDueTime) {
    return {
      dueTime: null,
      dueAtIso: null,
      timerState: TIMER_STATE_DEFAULTS.none
    };
  }
  const dueAtIso = buildDueAtIso(dateKey, nextDueTime);
  return {
    dueTime: nextDueTime,
    dueAtIso: dueAtIso || null,
    timerState: deriveTimerState({
      dueAtIso,
      status
    })
  };
}

export function deriveTimerState({ dueAtIso = "", status = "", now = new Date() } = {}) {
  const nextStatus = cleanString(status).toLowerCase();
  if (nextStatus === "completed" || nextStatus === "skipped") return TIMER_STATE_DEFAULTS.completed;

  const dueAt = dueAtIso ? new Date(dueAtIso) : null;
  if (!dueAt || Number.isNaN(dueAt.getTime())) return TIMER_STATE_DEFAULTS.none;

  const msRemaining = dueAt.getTime() - now.getTime();
  if (msRemaining < 0) return TIMER_STATE_DEFAULTS.overdue;
  if (msRemaining <= 15 * 60 * 1000) return TIMER_STATE_DEFAULTS.urgent;
  if (msRemaining <= 60 * 60 * 1000) return TIMER_STATE_DEFAULTS.warning;
  return TIMER_STATE_DEFAULTS.upcoming;
}

export function describeTimerWindow({ dueAtIso = "", status = "", now = new Date() } = {}) {
  const dueAt = dueAtIso ? new Date(dueAtIso) : null;
  const state = deriveTimerState({ dueAtIso, status, now });
  if (!dueAt || Number.isNaN(dueAt.getTime())) {
    return {
      state,
      text: "No timer assigned",
      minutesRemaining: null
    };
  }
  const msRemaining = dueAt.getTime() - now.getTime();
  const minutesRemaining = Math.round(msRemaining / 60000);
  if (state === TIMER_STATE_DEFAULTS.completed) {
    return {
      state,
      text: `Due ${dueAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      minutesRemaining
    };
  }
  if (msRemaining < 0) {
    const overdueMinutes = Math.abs(minutesRemaining);
    if (overdueMinutes < 60) {
      return { state, text: `${overdueMinutes} min overdue`, minutesRemaining };
    }
    const hours = Math.floor(overdueMinutes / 60);
    const mins = overdueMinutes % 60;
    return { state, text: `${hours}h ${mins}m overdue`, minutesRemaining };
  }
  const hours = Math.floor(minutesRemaining / 60);
  const mins = Math.abs(minutesRemaining % 60);
  if (hours > 0) {
    return { state, text: `${hours}h ${mins}m left`, minutesRemaining };
  }
  return { state, text: `${Math.max(0, minutesRemaining)} min left`, minutesRemaining };
}

export async function loadDepartmentTimerRule(storeId, department) {
  const ref = getDepartmentTimerRef(storeId, department);
  if (!ref) return null;
  try {
    const snap = await getDoc(ref);
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch (error) {
    console.warn("department timer lookup failed", storeId, department, error);
    return null;
  }
}

export async function loadDepartmentTimerRulesForStore(storeId) {
  const nextStoreId = cleanString(storeId);
  if (!nextStoreId) return [];
  try {
    const snap = await getDocs(query(collection(db, DEPARTMENT_TIMER_COLLECTION), where("storeId", "==", nextStoreId)));
    return snap.docs.map((row) => ({ id: row.id, ...row.data() }));
  } catch (error) {
    console.warn("department timer rules lookup failed", nextStoreId, error);
    return [];
  }
}

export async function saveDepartmentTimerRule({ storeId, department, dueTime, updatedAt, updatedBy }) {
  const ref = getDepartmentTimerRef(storeId, department);
  if (!ref) throw new Error("Store and department are required for timer rules.");
  await setDoc(ref, {
    storeId: cleanString(storeId),
    department: cleanString(department),
    dueTime: cleanString(dueTime) || null,
    updatedAt: updatedAt || new Date().toISOString(),
    updatedBy: cleanString(updatedBy) || null
  }, { merge: true });
  return ref;
}
