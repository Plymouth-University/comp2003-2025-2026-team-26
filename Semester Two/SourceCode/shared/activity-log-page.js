import { db } from "./logbook-app.js";
import { collection, getDocs, limit, orderBy, query, startAfter, where } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { writeUserActivity } from "./activity-log.js";
import { clearElement, replaceWithMessage, setSelectOptions } from "./dom-utils.js";
import { buildMissingIndexError } from "./firestore-query.js";
import { resolveManagerScopeOrThrow } from "./manager-scope.js";
import { waitForPageGuard } from "./page-guard.js";
await waitForPageGuard();

const PAGE_SIZE = 120;
const SEARCH_INPUT_DEBOUNCE_MS = 250;
const EDIT_ACTIONS = new Set(["edited_record", "voided_record"]);

const role = String(document.body?.dataset?.role || "admin").toLowerCase() === "manager" ? "manager" : "admin";
const scope = {
  storeId: "",
  department: ""
};
let managerScopeReady = true;

const statusEl = document.getElementById("status");
const scopeLineEl = document.getElementById("scopeLine");
const countBadgeEl = document.getElementById("countBadge");
const storeFilter = document.getElementById("storeFilter");
const departmentFilter = document.getElementById("departmentFilter");
const sectionFilter = document.getElementById("sectionFilter");
const actionFilter = document.getElementById("actionFilter");
const dateFromFilter = document.getElementById("dateFromFilter");
const dateToFilter = document.getElementById("dateToFilter");
const searchBox = document.getElementById("searchBox");
const applyBtn = document.getElementById("applyBtn");
const clearBtn = document.getElementById("clearBtn");
const resultsContainer = document.getElementById("resultsContainer");
const prevPageBtn = document.getElementById("prevPageBtn");
const nextPageBtn = document.getElementById("nextPageBtn");
const pageInfoEl = document.getElementById("pageInfo");

const panelOverlay = document.getElementById("logPanelOverlay");
const panel = document.getElementById("logPanel");
const panelCloseBtn = document.getElementById("closePanelBtn");
const panelActionEl = document.getElementById("panelAction");
const panelTimeEl = document.getElementById("panelTime");
const panelUserEl = document.getElementById("panelUser");
const panelStoreEl = document.getElementById("panelStore");
const panelDepartmentEl = document.getElementById("panelDepartment");
const panelSectionEl = document.getElementById("panelSection");
const panelSummaryEl = document.getElementById("panelSummary");
const panelReasonEl = document.getElementById("panelReason");
const panelReasonRow = document.getElementById("panelReasonRow");
const beforeAfterWrap = document.getElementById("beforeAfterWrap");
const panelBeforeEl = document.getElementById("panelBefore");
const panelAfterEl = document.getElementById("panelAfter");

let allRows = [];
const rowById = new Map();
const storeNameById = new Map();
let pageCache = [];
let currentPageIndex = 0;
let activeServerFilters = null;
let activeServerFilterKey = "";
let searchDebounceTimer = null;

function clean(value) {
  const text = String(value || "").trim();
  return text || "";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setStatus(message, kind = "info") {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.remove("success", "error");
  if (kind === "success") statusEl.classList.add("success");
  if (kind === "error") statusEl.classList.add("error");
}

function toDateInputValue(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function ensureDateDefaults() {
  if (dateFromFilter.value && dateToFilter.value) return;
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 30);
  if (!dateFromFilter.value) dateFromFilter.value = toDateInputValue(from);
  if (!dateToFilter.value) dateToFilter.value = toDateInputValue(today);
}

function parseEventDate(row) {
  const iso = clean(row.createdAtIso || row.timestamp || row.atIso);
  if (iso) {
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const ts = row.createdAt || row.at;
  if (ts && typeof ts.toDate === "function") return ts.toDate();
  if (ts && typeof ts.seconds === "number") return new Date(ts.seconds * 1000);
  return null;
}

function actionLabel(actionType) {
  const text = clean(actionType).toLowerCase();
  if (!text) return "Unknown";
  return text
    .replace(/_/g, " ")
    .split(" ")
    .map((item) => item.charAt(0).toUpperCase() + item.slice(1))
    .join(" ");
}

function renderScopeLine() {
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

function buildSearchBlob(row) {
  return [
    row.actorStaffId,
    row.actorIdentifier,
    row.actorUid,
    row.actorName,
    row.actorEmail,
    row.summary,
    row.reasonForChange,
    row.storeName,
    row.storeId,
    row.department,
    row.section,
    row.logbookSection,
    row.actionType,
    row.recordId,
    row.instanceId,
    row.templateId,
    row.dateKey
  ]
    .join(" ")
    .toLowerCase();
}

async function resolveScope() {
  if (role !== "manager") return;
  try {
    const resolved = await resolveManagerScopeOrThrow();
    scope.storeId = clean(resolved.storeId);
    scope.department = clean(resolved.department);
    managerScopeReady = true;
  } catch (error) {
    managerScopeReady = false;
    scope.storeId = "";
    scope.department = "";
    console.warn("Failed to resolve manager scope.", error);
  }
}

async function loadStores() {
  const snap = await getDocs(collection(db, "stores"));
  const options = [{ value: "", label: "All stores" }];
  storeNameById.clear();

  snap.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const id = docSnap.id;
    const name = clean(data.name) || id;
    storeNameById.set(id, name);
    options.push({ value: id, label: `${name} (${id})` });
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

function normalizeRow(raw) {
  const eventDate = parseEventDate(raw);
  return {
    id: clean(raw.id),
    actionType: clean(raw.actionType).toLowerCase(),
    summary: clean(raw.summary) || "No summary",
    reasonForChange: clean(raw.reasonForChange),
    storeId: clean(raw.storeId),
    storeName: clean(raw.storeName) || storeNameById.get(clean(raw.storeId)) || clean(raw.storeId) || "Unknown",
    department: clean(raw.department),
    section: clean(raw.section),
    logbookSection: clean(raw.logbookSection),
    actorUid: clean(raw.actorUid),
    actorRole: clean(raw.actorRole),
    actorEmail: clean(raw.actorEmail),
    actorName: clean(raw.actorName),
    actorStaffId: clean(raw.actorStaffId),
    actorIdentifier: clean(raw.actorIdentifier),
    recordId: clean(raw.recordId),
    instanceId: clean(raw.instanceId),
    templateId: clean(raw.templateId),
    dateKey: clean(raw.dateKey),
    before: raw.before ?? null,
    after: raw.after ?? null,
    metadata: raw.metadata ?? null,
    createdAtIso: clean(raw.createdAtIso),
    eventDate,
    eventText: eventDate ? eventDate.toLocaleString() : clean(raw.createdAtIso) || "Unknown",
    searchBlob: buildSearchBlob(raw)
  };
}

function readServerFilters() {
  const storeId = clean(scope.storeId || storeFilter.value);
  const department = clean(scope.department || departmentFilter.value);
  const section = clean(sectionFilter.value);
  const actionType = clean(actionFilter.value).toLowerCase();
  const search = clean(searchBox.value).toLowerCase();
  const fromValue = clean(dateFromFilter.value);
  const toValue = clean(dateToFilter.value);

  const fromDate = fromValue ? new Date(`${fromValue}T00:00:00`) : null;
  const toDate = toValue ? new Date(`${toValue}T23:59:59.999`) : null;

  if (fromDate && Number.isNaN(fromDate.getTime())) throw new Error("Date From is invalid.");
  if (toDate && Number.isNaN(toDate.getTime())) throw new Error("Date To is invalid.");
  if (fromDate && toDate && fromDate > toDate) throw new Error("Date From cannot be later than Date To.");

  return {
    storeId,
    department,
    section,
    actionType,
    search,
    fromDate,
    toDate,
    fromIso: fromDate ? fromDate.toISOString() : "",
    toIso: toDate ? toDate.toISOString() : ""
  };
}

function buildServerFilterKey(filters) {
  return JSON.stringify({
    storeId: filters.storeId || "",
    department: filters.department || "",
    section: filters.section || "",
    actionType: filters.actionType || "",
    search: filters.search || "",
    fromIso: filters.fromIso || "",
    toIso: filters.toIso || "",
    scopeStoreId: scope.storeId || "",
    scopeDepartment: scope.department || ""
  });
}

function resolveServerSearchToken(search) {
  const value = clean(search).toLowerCase();
  if (!value) return "";
  // Firestore array-contains only supports exact single-token matches.
  if (/\s/.test(value)) return "";
  return value;
}

function toActivityQueryError(error) {
  return buildMissingIndexError("Activity log", error, "Failed to load activity logs.");
}

function rowMatchesServerFilters(row, filters) {
  if (filters.storeId && clean(row.storeId) !== filters.storeId) return false;
  if (filters.department && clean(row.department) !== filters.department) return false;
  if (filters.section) {
    const section = clean(row.section);
    const logbookSection = clean(row.logbookSection);
    if (section !== filters.section && logbookSection !== filters.section) return false;
  }
  if (filters.actionType && clean(row.actionType).toLowerCase() !== filters.actionType) return false;
  if (filters.search) {
    const tokenText = Array.isArray(row.searchTokens) ? row.searchTokens.join(" ") : "";
    const blob = [
      tokenText,
      row.searchText,
      row.actorStaffId,
      row.actorIdentifier,
      row.actorUid,
      row.actorName,
      row.actorEmail,
      row.summary,
      row.reasonForChange,
      row.storeName,
      row.storeId,
      row.department,
      row.section,
      row.logbookSection,
      row.actionType,
      row.recordId,
      row.instanceId,
      row.templateId,
      row.dateKey
    ]
      .join(" ")
      .toLowerCase();
    if (!blob.includes(filters.search)) return false;
  }

  const createdAtIso = clean(row.createdAtIso);
  if (createdAtIso) {
    if (filters.fromIso && createdAtIso < filters.fromIso) return false;
    if (filters.toIso && createdAtIso > filters.toIso) return false;
    return true;
  }

  const eventDate = parseEventDate(row);
  if (!eventDate) return false;
  if (filters.fromDate && eventDate < filters.fromDate) return false;
  if (filters.toDate && eventDate > filters.toDate) return false;
  return true;
}

async function fetchPrimaryPage(filters, cursorDoc) {
  const col = collection(db, "user_activity_logs");
  const constraints = [];
  const serverSearchToken = resolveServerSearchToken(filters.search);

  if (filters.storeId) constraints.push(where("storeId", "==", filters.storeId));
  if (filters.department) constraints.push(where("department", "==", filters.department));
  if (serverSearchToken) constraints.push(where("searchTokens", "array-contains", serverSearchToken));
  if (filters.fromIso) constraints.push(where("createdAtIso", ">=", filters.fromIso));
  if (filters.toIso) constraints.push(where("createdAtIso", "<=", filters.toIso));
  constraints.push(orderBy("createdAtIso", "desc"));
  if (cursorDoc) constraints.push(startAfter(cursorDoc));
  constraints.push(limit(PAGE_SIZE + 1));

  const snap = await getDocs(query(col, ...constraints));
  const docs = snap.docs;
  const hasNext = docs.length > PAGE_SIZE;
  const pageDocs = hasNext ? docs.slice(0, PAGE_SIZE) : docs;
  const rows = pageDocs
    .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
    .filter((row) => rowMatchesServerFilters(row, filters))
    .map((row) => normalizeRow(row));
  const cursor = pageDocs.length ? pageDocs[pageDocs.length - 1] : cursorDoc || null;

  return {
    rows,
    hasNext,
    cursorDoc: cursor,
    mode: "primary"
  };
}

async function fetchLogsPage(filters, cursorDoc = null) {
  try {
    return await fetchPrimaryPage(filters, cursorDoc);
  } catch (error) {
    throw toActivityQueryError(error);
  }
}

function repopulateSelectOptions(rows) {
  const currentDepartment = departmentFilter.value;
  const currentSection = sectionFilter.value;
  const currentAction = actionFilter.value;

  const departments = [...new Set(rows.map((row) => row.department).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const sections = [...new Set(rows.map((row) => row.section || row.logbookSection).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const actions = [...new Set(rows.map((row) => row.actionType).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  if (currentDepartment && !departments.includes(currentDepartment)) departments.unshift(currentDepartment);
  if (scope.department && !departments.includes(scope.department)) departments.unshift(scope.department);
  if (currentSection && !sections.includes(currentSection)) sections.unshift(currentSection);
  if (currentAction && !actions.includes(currentAction)) actions.unshift(currentAction);

  setSelectOptions(departmentFilter, [{ value: "", label: "All departments" }, ...departments.map((value) => ({ value, label: value }))]);
  setSelectOptions(sectionFilter, [{ value: "", label: "All sections" }, ...sections.map((value) => ({ value, label: value }))]);
  setSelectOptions(actionFilter, [{ value: "", label: "All actions" }, ...actions.map((value) => ({ value, label: actionLabel(value) }))]);

  if (scope.department) {
    departmentFilter.value = scope.department;
    departmentFilter.disabled = true;
  } else if (currentDepartment) {
    departmentFilter.value = currentDepartment;
    departmentFilter.disabled = false;
  } else {
    departmentFilter.disabled = false;
  }

  if (currentSection) sectionFilter.value = currentSection;
  if (currentAction) actionFilter.value = currentAction;
}

function applyFilters() {
  const store = clean(storeFilter.value);
  const department = clean(departmentFilter.value);
  const section = clean(sectionFilter.value);
  const action = clean(actionFilter.value).toLowerCase();
  const search = clean(searchBox.value).toLowerCase();

  return allRows
    .filter((row) => {
      if (scope.storeId && row.storeId !== scope.storeId) return false;
      if (scope.department && row.department !== scope.department) return false;
      if (store && row.storeId !== store) return false;
      if (department && row.department !== department) return false;
      if (section && row.section !== section && row.logbookSection !== section) return false;
      if (action && row.actionType !== action) return false;
      if (search && !row.searchBlob.includes(search)) return false;
      return true;
    })
    .sort((a, b) => {
      const aMs = a.eventDate ? a.eventDate.getTime() : 0;
      const bMs = b.eventDate ? b.eventDate.getTime() : 0;
      return bMs - aMs;
    });
}

function renderCount(count) {
  if (!countBadgeEl) return;
  countBadgeEl.textContent = `${count} result${count === 1 ? "" : "s"}`;
}

function closePanel() {
  if (panelOverlay) panelOverlay.classList.remove("show");
  if (panel) panel.classList.remove("show");
}

function openPanel() {
  if (panelOverlay) panelOverlay.classList.add("show");
  if (panel) panel.classList.add("show");
}

function prettyJson(value) {
  if (value == null) return "None";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function setPanelRow(row) {
  panelActionEl.textContent = actionLabel(row.actionType);
  panelTimeEl.textContent = row.eventText;
  panelUserEl.textContent = row.actorName || row.actorStaffId || row.actorIdentifier || row.actorUid || "Unknown";
  panelStoreEl.textContent = row.storeName || row.storeId || "Unknown";
  panelDepartmentEl.textContent = row.department || "Unknown";
  panelSectionEl.textContent = row.section || row.logbookSection || "Unknown";
  panelSummaryEl.textContent = row.summary || "No summary";

  const reason = row.reasonForChange;
  const requiresReason = EDIT_ACTIONS.has(row.actionType);
  panelReasonEl.textContent = reason || (requiresReason ? "Missing reason (required for edit/void)." : "Not required");
  panelReasonRow.classList.toggle("missing", requiresReason && !reason);

  const hasDiff = row.before != null || row.after != null;
  beforeAfterWrap.style.display = hasDiff ? "grid" : "none";
  panelBeforeEl.textContent = prettyJson(row.before);
  panelAfterEl.textContent = prettyJson(row.after);
}

function renderRows(rows) {
  renderCount(rows.length);
  rowById.clear();
  rows.forEach((row) => rowById.set(row.id, row));

  if (!rows.length) {
    replaceWithMessage(resultsContainer, "empty", "No activity logs match the current filters.");
    return;
  }

  const table = document.createElement("table");
  table.className = "results-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Time</th>
        <th>User (PIN/ID)</th>
        <th>Store</th>
        <th>Department</th>
        <th>Section</th>
        <th>Action</th>
        <th>Summary</th>
        <th>View</th>
      </tr>
    </thead>
    <tbody id="activityRows"></tbody>
  `;

  const tbody = table.querySelector("#activityRows");
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const userId = row.actorStaffId || row.actorIdentifier || row.actorUid || "Unknown";
    const userMeta = [row.actorName, row.actorRole].filter(Boolean).join(" | ");
    const actionText = actionLabel(row.actionType);

    tr.innerHTML = `
      <td><strong>${escapeHtml(row.eventText)}</strong></td>
      <td><strong>${escapeHtml(userId)}</strong><br><span class="meta">${escapeHtml(userMeta || "-")}</span></td>
      <td><strong>${escapeHtml(row.storeName || row.storeId || "Unknown")}</strong><br><span class="meta">${escapeHtml(row.storeId || "-")}</span></td>
      <td>${escapeHtml(row.department || "Unknown")}</td>
      <td>${escapeHtml(row.section || row.logbookSection || "Unknown")}</td>
      <td><span class="status-pill">${escapeHtml(actionText)}</span></td>
      <td>${escapeHtml(row.summary || "No summary")}</td>
      <td><button type="button" class="btn" data-view-id="${escapeHtml(row.id)}">View</button></td>
    `;
    tbody.appendChild(tr);
  });

  clearElement(resultsContainer);
  resultsContainer.appendChild(table);

  const viewButtons = table.querySelectorAll("[data-view-id]");
  viewButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-view-id");
      const row = rowById.get(id);
      if (!row) return;
      setPanelRow(row);
      openPanel();
    });
  });
}

function renderPager() {
  const page = pageCache[currentPageIndex];
  const hasPrev = currentPageIndex > 0;
  const hasNext = Boolean(page?.hasNext);

  if (prevPageBtn) prevPageBtn.disabled = !hasPrev;
  if (nextPageBtn) nextPageBtn.disabled = !hasNext;

  if (!pageInfoEl) return;
  if (!page) {
    pageInfoEl.textContent = "Page 0";
    return;
  }
  if (hasNext) {
    pageInfoEl.textContent = `Page ${currentPageIndex + 1}`;
    return;
  }
  pageInfoEl.textContent = `Page ${currentPageIndex + 1} of ${Math.max(pageCache.length, currentPageIndex + 1)}`;
}

function renderCurrentPage({ rebuildFilterOptions = false } = {}) {
  const page = pageCache[currentPageIndex];
  allRows = page?.rows || [];

  if (rebuildFilterOptions) repopulateSelectOptions(allRows);

  const filtered = applyFilters();
  renderRows(filtered);
  renderPager();
  setStatus(`Showing ${filtered.length} log entr${filtered.length === 1 ? "y" : "ies"} (page ${currentPageIndex + 1})`, "success");
}

async function loadAndRender({ resetPagination = true } = {}) {
  setStatus("Loading activity logs...");
  replaceWithMessage(resultsContainer, "empty", "Loading...");
  try {
    if (role === "manager" && !managerScopeReady) {
      throw new Error("Manager scope could not be resolved. Sign out and back in to restore access.");
    }

    const filters = readServerFilters();
    const filterKey = buildServerFilterKey(filters);

    if (resetPagination || filterKey !== activeServerFilterKey) {
      pageCache = [];
      currentPageIndex = 0;
      activeServerFilters = filters;
      activeServerFilterKey = filterKey;
    }

    if (!pageCache[currentPageIndex]) {
      pageCache[currentPageIndex] = await fetchLogsPage(filters, null);
    }

    renderCurrentPage({ rebuildFilterOptions: true });
  } catch (error) {
    console.error(error);
    pageCache = [];
    allRows = [];
    renderPager();
    replaceWithMessage(resultsContainer, "empty", "Failed to load activity logs.");
    setStatus(error?.message || "Failed to load activity logs", "error");
  }
}

async function goToPage(targetIndex) {
  if (targetIndex < 0 || targetIndex === currentPageIndex) return;
  if (!pageCache[currentPageIndex]) return;

  if (pageCache[targetIndex]) {
    currentPageIndex = targetIndex;
    renderCurrentPage({ rebuildFilterOptions: true });
    return;
  }

  if (targetIndex !== currentPageIndex + 1) return;
  const currentPage = pageCache[currentPageIndex];
  if (!currentPage.hasNext) return;

  setStatus("Loading activity logs...");
  try {
    const filters = activeServerFilters || readServerFilters();
    pageCache[targetIndex] = await fetchLogsPage(filters, currentPage.cursorDoc);
    currentPageIndex = targetIndex;
    renderCurrentPage({ rebuildFilterOptions: true });
  } catch (error) {
    console.error(error);
    setStatus("Failed to load next page", "error");
  }
}

function wireEvents() {
  if (applyBtn) applyBtn.addEventListener("click", () => void loadAndRender({ resetPagination: true }));
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (!scope.storeId) storeFilter.value = "";
      if (!scope.department) {
        departmentFilter.value = "";
        departmentFilter.disabled = false;
      }
      sectionFilter.value = "";
      actionFilter.value = "";
      searchBox.value = "";
      dateFromFilter.value = "";
      dateToFilter.value = "";
      ensureDateDefaults();
      void loadAndRender({ resetPagination: true });
    });
  }

  [departmentFilter, sectionFilter, actionFilter].forEach((el) => {
    if (!el) return;
    el.addEventListener("change", () => {
      void loadAndRender({ resetPagination: true });
    });
  });

  if (storeFilter) {
    storeFilter.addEventListener("change", () => {
      void loadAndRender({ resetPagination: true });
    });
  }

  [dateFromFilter, dateToFilter].forEach((el) => {
    if (!el) return;
    el.addEventListener("change", () => {
      void loadAndRender({ resetPagination: true });
    });
  });

  if (searchBox) {
    searchBox.addEventListener("input", () => {
      if (searchDebounceTimer) window.clearTimeout(searchDebounceTimer);
      searchDebounceTimer = window.setTimeout(() => {
        void loadAndRender({ resetPagination: true });
      }, SEARCH_INPUT_DEBOUNCE_MS);
    });
  }

  if (prevPageBtn) {
    prevPageBtn.addEventListener("click", () => {
      void goToPage(currentPageIndex - 1);
    });
  }

  if (nextPageBtn) {
    nextPageBtn.addEventListener("click", () => {
      void goToPage(currentPageIndex + 1);
    });
  }

  if (panelOverlay) panelOverlay.addEventListener("click", closePanel);
  if (panelCloseBtn) panelCloseBtn.addEventListener("click", closePanel);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePanel();
  });
}

function applyQueryParams() {
  const params = new URLSearchParams(window.location.search);
  const store = clean(params.get("store"));
  const department = clean(params.get("department"));
  const section = clean(params.get("section"));
  const action = clean(params.get("action"));
  const from = clean(params.get("from"));
  const to = clean(params.get("to"));
  const q = clean(params.get("q"));

  if (store && !scope.storeId) storeFilter.value = store;
  if (department && !scope.department) departmentFilter.value = department;
  if (section) sectionFilter.value = section;
  if (action) actionFilter.value = action;
  if (from) dateFromFilter.value = from;
  if (to) dateToFilter.value = to;
  if (q) searchBox.value = q;
}

async function init() {
  ensureDateDefaults();
  await resolveScope();
  renderScopeLine();
  await loadStores();
  applyQueryParams();
  wireEvents();
  await loadAndRender();
  await writeUserActivity({
    actionType: "opened_section",
    section: "User Activity Log",
    summary: `Opened ${role} activity log view`,
    storeId: scope.storeId,
    department: scope.department,
    metadata: {
      page: `${window.location.pathname}${window.location.search}`
    }
  });
}

init();
