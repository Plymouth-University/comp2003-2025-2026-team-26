import { db } from "./logbook-app.js";
import {
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  startAfter,
  where
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { auth, getRoleFromUser } from "./auth.js";
import { writeUserActivity } from "./activity-log.js";
import { getBusinessDateISO } from "./business-time.js";
import { clearElement, replaceWithMessage, setSelectOptions } from "./dom-utils.js";
import { buildMissingIndexError } from "./firestore-query.js";
import { loadEntryMeta, saveInstanceEntry } from "./instance-entry-storage.js";
import { resolveManagerScopeOrThrow } from "./manager-scope.js";
import { waitForPageGuard } from "./page-guard.js";
await waitForPageGuard();

const FETCH_BATCH_SIZE = 150;
const MAX_FETCH_BATCHES = 20;
const PAGE_SIZE = 25;

const role = String(document.body?.dataset?.role || "admin").toLowerCase() === "manager" ? "manager" : "admin";

const statusEl = document.getElementById("status");
const scopeLineEl = document.getElementById("scopeLine");
const lastUpdatedEl = document.getElementById("lastUpdated");
const storeFilter = document.getElementById("storeFilter");
const dateFromFilter = document.getElementById("dateFromFilter");
const dateToFilter = document.getElementById("dateToFilter");
const lockFilter = document.getElementById("lockFilter");
const searchBox = document.getElementById("searchBox");
const applyBtn = document.getElementById("applyBtn");
const clearBtn = document.getElementById("clearBtn");
const refreshBtn = document.getElementById("refreshBtn");
const resultsContainer = document.getElementById("resultsContainer");
const prevPageBtn = document.getElementById("prevPageBtn");
const nextPageBtn = document.getElementById("nextPageBtn");
const pageInfoEl = document.getElementById("pageInfo");

const scope = {
  storeId: "",
  department: ""
};
let managerScopeReady = true;

const storeNameById = new Map();
const templateNameById = new Map();
const entryMetaByKey = new Map();

let allRecords = [];
let loadInProgress = false;
let lastLoadAt = null;
const pendingUnlockIds = new Set();
let currentPage = 1;

function setStatus(msg, kind = "info") {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.classList.remove("success", "error");
  if (kind === "success") statusEl.classList.add("success");
  if (kind === "error") statusEl.classList.add("error");
}

function ensureDateDefaults() {
  const today = getBusinessDateISO();
  if (!dateFromFilter.value) dateFromFilter.value = today;
  if (!dateToFilter.value) dateToFilter.value = today;
}

function parseTs(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function withinRange(dateKey, from, to) {
  if (!dateKey) return false;
  if (from && dateKey < from) return false;
  if (to && dateKey > to) return false;
  return true;
}

function recordDateKey(instance) {
  return String(instance?.date || instance?.workDate || "").trim();
}

function getActiveStoreId() {
  return scope.storeId || storeFilter.value || "";
}

function renderScope() {
  if (!scopeLineEl) return;
  if (role !== "manager") {
    scopeLineEl.textContent = "Scope: All stores";
    return;
  }
  if (!managerScopeReady) {
    scopeLineEl.textContent = "Scope: unavailable";
    return;
  }
  if (!scope.storeId && !scope.department) {
    scopeLineEl.textContent = "Scope: Manager (all stores)";
    return;
  }
  const bits = [];
  if (scope.storeId) bits.push(`Store ${scope.storeId}`);
  if (scope.department) bits.push(`Department ${scope.department}`);
  scopeLineEl.textContent = `Scope: ${bits.join(" | ")}`;
}

function renderLastUpdated() {
  if (!lastUpdatedEl) return;
  if (!lastLoadAt) {
    lastUpdatedEl.textContent = "Never";
    return;
  }
  lastUpdatedEl.textContent = lastLoadAt.toLocaleTimeString();
}

async function resolveManagerScope() {
  if (role !== "manager") return;
  try {
    const resolved = await resolveManagerScopeOrThrow();
    scope.storeId = String(resolved.storeId || "").trim();
    scope.department = String(resolved.department || "").trim();
    managerScopeReady = true;
  } catch (error) {
    managerScopeReady = false;
    scope.storeId = "";
    scope.department = "";
    console.warn("Failed to resolve manager scope", error);
  }
}

async function loadStores() {
  const snap = await getDocs(collection(db, "stores"));
  storeNameById.clear();

  const options = [{ value: "", label: "All stores" }];
  snap.forEach((row) => {
    const data = row.data() || {};
    const name = data.name || row.id;
    storeNameById.set(row.id, name);
    options.push({ value: row.id, label: `${name} (${row.id})` });
  });

  setSelectOptions(storeFilter, options);

  if (scope.storeId) {
    storeFilter.value = scope.storeId;
    storeFilter.disabled = true;
    return;
  }

  if (role === "manager" && !managerScopeReady) {
    storeFilter.disabled = true;
  }
}

async function getTemplateName(templateId) {
  if (!templateId) return "Unknown";
  if (templateNameById.has(templateId)) return templateNameById.get(templateId);
  let name = templateId;
  try {
    const snap = await getDoc(doc(db, "logbook_templates", templateId));
    if (snap.exists()) {
      const data = snap.data() || {};
      name = data.name || templateId;
    }
  } catch (error) {
    console.warn("template lookup failed", templateId, error);
  }
  templateNameById.set(templateId, name);
  return name;
}

async function getEntryMeta(instanceId, templateId, dateKey) {
  if (!instanceId && (!templateId || !dateKey)) return null;
  const key = `${instanceId || "none"}::${templateId || "none"}::${dateKey || "none"}`;
  if (entryMetaByKey.has(key)) return entryMetaByKey.get(key);
  const data = await loadEntryMeta({ instanceId, templateId, dateKey });
  entryMetaByKey.set(key, data);
  return data;
}

function isLocked(instance, entryMeta) {
  const instanceStatus = String(instance?.status || "").toLowerCase();
  return Boolean(
    instance?.locked ||
    instance?.lockedAt ||
    entryMeta?.recordLocked ||
    instanceStatus === "completed"
  );
}

async function queryByDateField(fieldName, storeId, from, to) {
  const constraints = [];
  if (from) constraints.push(where(fieldName, ">=", from));
  if (to) constraints.push(where(fieldName, "<=", to));
  if (storeId) constraints.push(where("storeId", "==", storeId));

  const rows = [];
  let cursorDoc = null;
  let batchCount = 0;

  while (batchCount < MAX_FETCH_BATCHES) {
    const paging = cursorDoc ? [startAfter(cursorDoc)] : [];
    const snap = await getDocs(query(collection(db, "logbook_instances"), ...constraints, orderBy(fieldName, "desc"), ...paging, limit(FETCH_BATCH_SIZE)));
    if (snap.empty) break;
    snap.docs.forEach((row) => rows.push({ id: row.id, ...row.data() }));
    cursorDoc = snap.docs[snap.docs.length - 1];
    batchCount += 1;
    if (snap.docs.length < FETCH_BATCH_SIZE) break;
  }

  return rows;
}

async function fetchInstances() {
  if (role === "manager" && !managerScopeReady) {
    throw new Error("Manager scope could not be resolved. Sign out and back in to restore access.");
  }

  const storeId = getActiveStoreId();
  const from = dateFromFilter.value;
  const to = dateToFilter.value;
  const byId = new Map();

  try {
    const rows = await queryByDateField("date", storeId, from, to);
    rows.forEach((row) => byId.set(row.id, row));
  } catch (error) {
    console.warn("date query failed, trying workDate", error);
  }

  if (byId.size === 0) {
    try {
      const rows = await queryByDateField("workDate", storeId, from, to);
      rows.forEach((row) => byId.set(row.id, row));
    } catch (error) {
      throw buildMissingIndexError("Unlock records", error, "Failed to load records.");
    }
  }

  return [...byId.values()];
}

async function enrichRecords(rows) {
  const enriched = [];
  for (const row of rows) {
    const templateId = String(row.templateId || "").trim();
    const dateKey = recordDateKey(row);
    if (!dateKey) continue;
    if (!withinRange(dateKey, dateFromFilter.value, dateToFilter.value)) continue;

    let entryMeta = null;
    const needsEntryFallback =
      typeof row.locked !== "boolean" ||
      (!row.lockedAt && String(row.status || "").toLowerCase() === "completed") ||
      !String(row.completedBy || "").trim();
    if (needsEntryFallback) {
      entryMeta = await getEntryMeta(row.id, templateId, dateKey);
    }
    const locked = isLocked(row, entryMeta);
    const templateName = row.templateName || (templateId ? await getTemplateName(templateId) : "Unknown");
    const storeId = row.storeId || "Unknown";
    const storeName = storeNameById.get(storeId) || storeId;
    const status = String(row.status || "not_started").toLowerCase();

    const updatedAt =
      parseTs(row.updatedAt) ||
      parseTs(row.completedAt) ||
      parseTs(row.submittedAt) ||
      parseTs(entryMeta?.saved_at) ||
      null;

    const completedBy =
      row.completedBy ||
      entryMeta?.completedBy ||
      entryMeta?.savedBy ||
      "Unknown";

    enriched.push({
      instanceId: row.id,
      templateId,
      templateName: templateName || "Unknown",
      storeId,
      storeName,
      dateKey,
      status,
      locked,
      updatedAt,
      updatedText: updatedAt ? updatedAt.toLocaleString() : "Unknown",
      completedBy
    });
  }

  return enriched.sort((a, b) => {
    const byDate = String(b.dateKey).localeCompare(String(a.dateKey));
    if (byDate !== 0) return byDate;
    return String(a.templateName).localeCompare(String(b.templateName));
  });
}

function applyClientFilters(rows) {
  const lockMode = lockFilter.value || "locked";
  const search = searchBox.value.trim().toLowerCase();

  return rows.filter((row) => {
    if (lockMode === "locked" && !row.locked) return false;
    if (lockMode === "unlocked" && row.locked) return false;

    if (search) {
      const text = [
        row.dateKey,
        row.storeName,
        row.storeId,
        row.templateName,
        row.templateId,
        row.status,
        row.completedBy,
        row.instanceId
      ].join(" ").toLowerCase();
      if (!text.includes(search)) return false;
    }
    return true;
  });
}

function statusPillClass(status) {
  const s = String(status || "").toLowerCase();
  if (s === "completed") return "completed";
  if (s === "in_progress") return "in_progress";
  if (s === "skipped") return "skipped";
  return "not_started";
}

function renderPager(totalCount) {
  const totalPages = totalCount > 0 ? Math.ceil(totalCount / PAGE_SIZE) : 0;
  if (totalPages > 0 && currentPage > totalPages) currentPage = totalPages;
  if (totalPages === 0) currentPage = 1;

  if (prevPageBtn) prevPageBtn.disabled = totalPages <= 1 || currentPage <= 1;
  if (nextPageBtn) nextPageBtn.disabled = totalPages <= 1 || currentPage >= totalPages;
  if (!pageInfoEl) return;

  if (totalPages === 0) {
    pageInfoEl.textContent = "Page 0 of 0";
    return;
  }

  pageInfoEl.textContent = `Page ${currentPage} of ${totalPages}`;
}

function render(records) {
  renderPager(records.length);
  if (!records.length) {
    replaceWithMessage(resultsContainer, "empty", "No records match current filters.");
    return;
  }

  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const pageRecords = records.slice(startIndex, startIndex + PAGE_SIZE);
  const table = document.createElement("table");
  table.className = "results-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Date</th>
        <th>Store</th>
        <th>Template</th>
        <th>Status</th>
        <th>Integrity</th>
        <th>Completed By</th>
        <th>Updated</th>
        <th>Action</th>
      </tr>
    </thead>
    <tbody id="unlockRows"></tbody>
  `;

  const body = table.querySelector("#unlockRows");
  pageRecords.forEach((row) => {
    const tr = document.createElement("tr");
    const pending = pendingUnlockIds.has(row.instanceId);

    const dateCell = document.createElement("td");
    const dateStrong = document.createElement("strong");
    dateStrong.textContent = row.dateKey;
    dateCell.appendChild(dateStrong);
    dateCell.appendChild(document.createElement("br"));
    const dateMeta = document.createElement("span");
    dateMeta.className = "meta";
    dateMeta.textContent = row.instanceId;
    dateCell.appendChild(dateMeta);
    tr.appendChild(dateCell);

    const storeCell = document.createElement("td");
    const storeStrong = document.createElement("strong");
    storeStrong.textContent = row.storeName;
    storeCell.appendChild(storeStrong);
    storeCell.appendChild(document.createElement("br"));
    const storeMeta = document.createElement("span");
    storeMeta.className = "meta";
    storeMeta.textContent = row.storeId;
    storeCell.appendChild(storeMeta);
    tr.appendChild(storeCell);

    const templateCell = document.createElement("td");
    templateCell.appendChild(document.createTextNode(row.templateName));
    templateCell.appendChild(document.createElement("br"));
    const templateMeta = document.createElement("span");
    templateMeta.className = "meta";
    templateMeta.textContent = row.templateId || "Unknown template";
    templateCell.appendChild(templateMeta);
    tr.appendChild(templateCell);

    const statusCell = document.createElement("td");
    const statusPill = document.createElement("span");
    statusPill.className = `status-pill ${statusPillClass(row.status)}`;
    statusPill.textContent = row.status.replace(/_/g, " ");
    statusCell.appendChild(statusPill);
    tr.appendChild(statusCell);

    const integrityCell = document.createElement("td");
    const integrityPill = document.createElement("span");
    integrityPill.className = `status-pill ${row.locked ? "locked" : "unlocked"}`;
    integrityPill.textContent = row.locked ? "Locked" : "Unlocked";
    integrityCell.appendChild(integrityPill);
    tr.appendChild(integrityCell);

    const completedByCell = document.createElement("td");
    completedByCell.textContent = row.completedBy;
    tr.appendChild(completedByCell);

    const updatedCell = document.createElement("td");
    updatedCell.textContent = row.updatedText;
    tr.appendChild(updatedCell);

    const actionCell = document.createElement("td");
    const actionButton = document.createElement("button");
    actionButton.className = `btn ${row.locked ? "primary" : ""}`.trim();
    actionButton.dataset.action = "unlock";
    actionButton.dataset.id = row.instanceId;
    actionButton.disabled = !row.locked || pending;
    actionButton.textContent = pending ? "Unlocking..." : (row.locked ? "Unlock" : "Already Unlocked");
    actionCell.appendChild(actionButton);
    tr.appendChild(actionCell);
    body.appendChild(tr);
  });

  clearElement(resultsContainer);
  resultsContainer.appendChild(table);

  const unlockButtons = [...table.querySelectorAll('button[data-action="unlock"]')];
  unlockButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.id || "";
      const target = records.find((record) => record.instanceId === id);
      if (!target) return;
      void unlockRecord(target);
    });
  });
}

async function unlockRecord(record) {
  if (!record.locked) return;
  if (pendingUnlockIds.has(record.instanceId)) return;
  if (!record.templateId || !record.dateKey) {
    setStatus("Cannot unlock: missing template or date data", "error");
    return;
  }

  const _confirm = typeof styledConfirm === "function" ? styledConfirm : (msg) => Promise.resolve(window.confirm(msg));
  const _prompt = typeof styledPrompt === "function" ? styledPrompt : (msg, def) => Promise.resolve(window.prompt(msg, def));

  const ok = await _confirm(
    `Unlock this record?\n\nStore: ${record.storeId}\nTemplate: ${record.templateName}\nDate: ${record.dateKey}\n\nStaff will be able to continue editing after unlock.`,
    "Unlock Record",
    { icon: "🔓", confirmText: "Unlock", danger: false }
  );
  if (!ok) return;
  const reasonForChange = await _prompt(
    "Please provide a reason for unlocking this record.",
    "",
    "Reason Required",
    { required: true, requiredMsg: "A reason is required for unlock actions.", placeholder: "e.g. Staff needs to correct an entry…", icon: "📝", confirmText: "Continue" }
  );
  if (!reasonForChange) {
    setStatus("Reason for change is required for unlock actions.", "error");
    return;
  }

  pendingUnlockIds.add(record.instanceId);
  render(applyClientFilters(allRecords));
  setStatus("Unlocking record...");

  try {
    const nowIso = new Date().toISOString();
    const currentUser = auth.currentUser;
    const actor = currentUser?.uid || currentUser?.email || "unknown";
    const actorRole = getRoleFromUser(currentUser) || role;

    await saveInstanceEntry(record.instanceId, {
      recordLocked: false,
      locked: false,
      entryState: "draft",
      unlockedAt: nowIso,
      unlockedBy: actor,
      unlockedByRole: actorRole,
      unlockReason: reasonForChange,
      saved_at: nowIso
    });

    await setDoc(doc(db, "logbook_instances", record.instanceId), {
      status: "in_progress",
      complianceStatus: "incomplete",
      locked: false,
      lockedAt: null,
      unlockedAt: nowIso,
      unlockedBy: actor,
      unlockedByRole: actorRole,
      unlockReason: reasonForChange,
      updatedAt: nowIso
    }, { merge: true });

    await writeUserActivity({
      actionType: "voided_record",
      summary: `Unlocked ${record.templateName} so staff can continue editing`,
      reasonForChange,
      storeId: record.storeId,
      storeName: record.storeName,
      department: scope.department || "",
      section: record.templateName,
      templateId: record.templateId,
      instanceId: record.instanceId,
      dateKey: record.dateKey,
      before: {
        status: record.status,
        locked: true
      },
      after: {
        status: "in_progress",
        locked: false
      },
      metadata: {
        source: "unlock_records",
        actorRole
      }
    });

    entryMetaByKey.delete(`${record.instanceId || "none"}::${record.templateId || "none"}::${record.dateKey || "none"}`);
    setStatus("Record unlocked. Staff can continue editing.", "success");
    await loadAndRender({ silent: true });
  } catch (error) {
    console.error(error);
    setStatus("Failed to unlock record", "error");
  } finally {
    pendingUnlockIds.delete(record.instanceId);
    render(applyClientFilters(allRecords));
  }
}

async function loadAndRender(options = {}) {
  const { silent = false } = options;
  if (loadInProgress) return;
  loadInProgress = true;
  if (refreshBtn) refreshBtn.disabled = true;
  if (!silent) setStatus("Loading records...");

  try {
    const raw = await fetchInstances();
    const enriched = await enrichRecords(raw);
    allRecords = enriched;
    const filtered = applyClientFilters(allRecords);
    render(filtered);
    lastLoadAt = new Date();
    renderLastUpdated();
    setStatus(`Showing ${filtered.length} record(s)`, "success");
  } catch (error) {
    console.error(error);
    replaceWithMessage(resultsContainer, "empty", "Failed to load records.");
    setStatus("Failed to load records", "error");
  } finally {
    loadInProgress = false;
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

function applyQueryParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("store") && !scope.storeId) storeFilter.value = params.get("store");
  if (params.get("from")) dateFromFilter.value = params.get("from");
  if (params.get("to")) dateToFilter.value = params.get("to");
  if (params.get("lock")) lockFilter.value = params.get("lock");
  if (params.get("q")) searchBox.value = params.get("q");
}

async function init() {
  ensureDateDefaults();
  await resolveManagerScope();
  renderScope();
  setStatus("Loading stores...");
  await loadStores();
  applyQueryParams();
  await loadAndRender();
}

if (applyBtn) applyBtn.addEventListener("click", () => {
  currentPage = 1;
  void loadAndRender();
});
if (refreshBtn) refreshBtn.addEventListener("click", () => void loadAndRender());

if (clearBtn) {
  clearBtn.addEventListener("click", () => {
    const today = getBusinessDateISO();
    dateFromFilter.value = today;
    dateToFilter.value = today;
    if (!scope.storeId) storeFilter.value = "";
    lockFilter.value = "locked";
    searchBox.value = "";
    currentPage = 1;
    void loadAndRender();
  });
}

if (lockFilter) {
  lockFilter.addEventListener("change", () => {
    currentPage = 1;
    render(applyClientFilters(allRecords));
  });
}

if (searchBox) {
  searchBox.addEventListener("input", () => {
    currentPage = 1;
    render(applyClientFilters(allRecords));
  });
}

if (prevPageBtn) {
  prevPageBtn.addEventListener("click", () => {
    if (currentPage <= 1) return;
    currentPage -= 1;
    render(applyClientFilters(allRecords));
  });
}

if (nextPageBtn) {
  nextPageBtn.addEventListener("click", () => {
    const filtered = applyClientFilters(allRecords);
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (currentPage >= totalPages) return;
    currentPage += 1;
    render(filtered);
  });
}

window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void loadAndRender({ silent: true });
  }
});

init();
