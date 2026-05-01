import { db } from "./logbook-app.js";
import {
  doc,
  getDoc,
  setDoc
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

export const INSTANCE_ENTRY_COLLECTION = "log_entry_instances";

function clean(value) {
  const text = String(value || "").trim();
  return text || "";
}

function sanitize(value) {
  if (value === undefined || typeof value === "function") return undefined;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item)).filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const next = {};
    Object.entries(value).forEach(([key, nested]) => {
      const sanitized = sanitize(nested);
      if (sanitized !== undefined) next[key] = sanitized;
    });
    return next;
  }
  return value;
}

export function getInstanceEntryRef(instanceId) {
  const id = clean(instanceId);
  if (!id) return null;
  return doc(db, INSTANCE_ENTRY_COLLECTION, id);
}

export function getLegacyEntryRef(templateId, dateKey) {
  const tId = clean(templateId);
  const date = clean(dateKey);
  if (!tId || !date) return null;
  return doc(db, "log_entries", tId, date, "meta");
}

export async function loadEntryRecord({ instanceId = "", templateId = "", dateKey = "" } = {}) {
  const nextInstanceId = clean(instanceId);
  const nextTemplateId = clean(templateId);
  const nextDateKey = clean(dateKey);

  if (nextInstanceId) {
    try {
      const ref = getInstanceEntryRef(nextInstanceId);
      const snap = ref ? await getDoc(ref) : null;
      if (snap?.exists()) {
        return {
          source: "instance",
          ref,
          data: snap.data() || null
        };
      }
    } catch (error) {
      console.warn("instance entry lookup failed", nextInstanceId, error);
    }
  }

  if (nextTemplateId && nextDateKey) {
    try {
      const ref = getLegacyEntryRef(nextTemplateId, nextDateKey);
      const snap = ref ? await getDoc(ref) : null;
      if (snap?.exists()) {
        return {
          source: "legacy",
          ref,
          data: snap.data() || null
        };
      }
    } catch (error) {
      console.warn("legacy entry lookup failed", nextTemplateId, nextDateKey, error);
    }
  }

  return {
    source: "missing",
    ref: nextInstanceId ? getInstanceEntryRef(nextInstanceId) : getLegacyEntryRef(nextTemplateId, nextDateKey),
    data: null
  };
}

export async function loadEntryMeta(options = {}) {
  const loaded = await loadEntryRecord(options);
  return loaded.data || null;
}

export async function saveInstanceEntry(instanceId, data, options = {}) {
  const ref = getInstanceEntryRef(instanceId);
  if (!ref) throw new Error("Instance entry save requires an instanceId.");
  const merge = options.merge !== false;
  await setDoc(ref, sanitize(data), { merge });
  return ref;
}
