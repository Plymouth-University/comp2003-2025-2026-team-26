import { collection, getDocs } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { normalizeDepartmentValue } from "./logbook-runtime.js";

export function cleanDirectoryValue(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

export function dedupeDirectoryValues(values = []) {
  const seen = new Set();
  const next = [];
  values.forEach((value) => {
    const cleaned = cleanDirectoryValue(value);
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    next.push(cleaned);
  });
  return next;
}

export function sortDirectoryStores(items = []) {
  return [...items].sort((a, b) => {
    const nameCompare = String(a.name || a.id || "").localeCompare(String(b.name || b.id || ""), "en", { sensitivity: "base" });
    if (nameCompare !== 0) return nameCompare;
    return String(a.id || "").localeCompare(String(b.id || ""), "en", { sensitivity: "base" });
  });
}

export function buildStoreDirectoryLabel(store = {}) {
  const id = cleanDirectoryValue(store.id);
  const name = cleanDirectoryValue(store.name) || id;
  if (!id) return "";
  if (name && name !== id) return `${name} (${id})`;
  return store.referenceOnly ? `${id} (from assignments)` : id;
}

export function canonicalDepartmentDirectoryValue(value, options = [], fallback = "General") {
  const raw = cleanDirectoryValue(value);
  if (!raw) {
    const cleanFallback = cleanDirectoryValue(fallback);
    return cleanFallback ? normalizeDepartmentValue(cleanFallback, "General") : "";
  }
  const normalized = normalizeDepartmentValue(raw, fallback || "General");
  const lookup = new Map();
  dedupeDirectoryValues(options).forEach((option) => {
    lookup.set(option.toLowerCase(), option);
  });
  return lookup.get(normalized.toLowerCase()) || normalized;
}

export function buildDepartmentSuggestions(directory, storeId = "", seeded = []) {
  const nextStoreId = cleanDirectoryValue(storeId);
  const scoped = nextStoreId ? (directory?.departmentsByStore?.get(nextStoreId) || []) : [];
  return dedupeDirectoryValues([
    ...seeded,
    ...scoped,
    ...(directory?.allDepartments || [])
  ]);
}

export function renderDatalistOptions(listEl, values = []) {
  if (!listEl) return;
  listEl.innerHTML = dedupeDirectoryValues(values)
    .map((value) => `<option value="${String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></option>`)
    .join("");
}

export async function loadStoreDepartmentDirectory(db) {
  const [storesSnap, rulesSnap] = await Promise.all([
    getDocs(collection(db, "stores")),
    getDocs(collection(db, "store_template_rules"))
  ]);

  const storeMap = new Map();
  const departmentsByStore = new Map();
  const allDepartments = [];

  storesSnap.forEach((row) => {
    const data = row.data() || {};
    storeMap.set(row.id, {
      id: row.id,
      name: cleanDirectoryValue(data.name) || row.id,
      referenceOnly: false
    });
  });

  rulesSnap.forEach((row) => {
    const data = row.data() || {};
    const storeId = cleanDirectoryValue(data.storeId);
    if (!storeId) return;

    if (!storeMap.has(storeId)) {
      storeMap.set(storeId, {
        id: storeId,
        name: storeId,
        referenceOnly: true
      });
    }

    const department = normalizeDepartmentValue(cleanDirectoryValue(data.department), "General");
    const current = departmentsByStore.get(storeId) || [];
    current.push(department);
    departmentsByStore.set(storeId, current);
    allDepartments.push(department);
  });

  const normalizedDepartmentsByStore = new Map(
    [...departmentsByStore.entries()].map(([storeId, departments]) => [storeId, dedupeDirectoryValues(departments)])
  );

  return {
    stores: sortDirectoryStores([...storeMap.values()]),
    departmentsByStore: normalizedDepartmentsByStore,
    allDepartments: dedupeDirectoryValues(allDepartments)
  };
}
