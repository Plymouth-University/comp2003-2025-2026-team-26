import { db } from "./logbook-app.js";
import {
  collection,
  getCountFromServer,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { addDaysToDateKey, getBusinessDateISO } from "./business-time.js";
import { clearElement, replaceWithMessage, safeClassToken } from "./dom-utils.js";
import { waitForPageGuard } from "./page-guard.js";

await waitForPageGuard();

const statusEl = document.getElementById("status");
const countBadge = document.getElementById("countBadge");
const tableContainer = document.getElementById("tableContainer");
const refreshBtn = document.getElementById("refreshBtn");
const fromDateInput = document.getElementById("fromDateInput");
const toDateInput = document.getElementById("toDateInput");
const applyRangeBtn = document.getElementById("applyRangeBtn");
const filterInput = document.getElementById("filterInput");
const clearFilterBtn = document.getElementById("clearFilterBtn");
const pageInfoEl = document.getElementById("pageInfo");
const prevPageBtn = document.getElementById("prevPageBtn");
const nextPageBtn = document.getElementById("nextPageBtn");

const PAGE_SIZE = 50;
const todayISO = getBusinessDateISO();
const testPatterns = ["test", "debug", "demo", "sample", "dev"];

let activeServerFilters = null;
let activeServerKey = "";
let currentFieldName = "date";
let currentPageIndex = 0;
let currentTotalCount = 0;
let pageCache = [];

function setStatus(message, kind = "info") {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.remove("success", "error", "warning");
  if (kind === "success") statusEl.classList.add("success");
  if (kind === "error") statusEl.classList.add("error");
  if (kind === "warning") statusEl.classList.add("warning");
}

function ensureDateDefaults() {
  if (fromDateInput?.value && toDateInput?.value) return;
  if (fromDateInput && !fromDateInput.value) fromDateInput.value = addDaysToDateKey(todayISO, -30);
  if (toDateInput && !toDateInput.value) toDateInput.value = todayISO;
}

function getTime(value) {
  if (!value) return 0;
  if (value.toDate && typeof value.toDate === "function") return value.toDate().getTime();
  if (value.seconds) return value.seconds * 1000;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function formatTimestamp(value) {
  if (!value) return "-";
  try {
    if (value.toDate && typeof value.toDate === "function") return value.toDate().toLocaleString();
    if (value.seconds) return new Date(value.seconds * 1000).toLocaleString();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "-" : parsed.toLocaleString();
  } catch {
    return "-";
  }
}

function getDisplayStatus(entry) {
  const status = entry.status || "not_started";
  if ((status === "not_started" || status === "in_progress") && entry.date && entry.date < todayISO) {
    return "overdue";
  }
  return status;
}

function isTestStore(storeId) {
  const lower = String(storeId || "").toLowerCase();
  return Boolean(lower) && testPatterns.some((pattern) => lower.includes(pattern));
}

function readServerFilters() {
  const from = String(fromDateInput?.value || "").trim();
  const to = String(toDateInput?.value || "").trim();
  if (from && to && from > to) {
    throw new Error("Date From cannot be later than Date To.");
  }
  return { from, to };
}

function buildServerKey(filters) {
  return JSON.stringify(filters || {});
}

async function getMatchingCount(filters, fieldName) {
  const constraints = [];
  if (filters.from) constraints.push(where(fieldName, ">=", filters.from));
  if (filters.to) constraints.push(where(fieldName, "<=", filters.to));
  const snapshot = await getCountFromServer(query(collection(db, "logbook_instances"), ...constraints));
  return snapshot.data().count || 0;
}

async function resolveFieldName(filters) {
  try {
    const dateCount = await getMatchingCount(filters, "date");
    if (dateCount > 0) {
      return { fieldName: "date", totalCount: dateCount };
    }
  } catch (error) {
    console.warn("Failed debug count by 'date'.", error);
  }

  const workDateCount = await getMatchingCount(filters, "workDate");
  return {
    fieldName: workDateCount > 0 ? "workDate" : "date",
    totalCount: workDateCount
  };
}

async function fetchEntriesPage(filters, cursorDoc = null) {
  const constraints = [];
  if (filters.from) constraints.push(where(currentFieldName, ">=", filters.from));
  if (filters.to) constraints.push(where(currentFieldName, "<=", filters.to));
  constraints.push(orderBy(currentFieldName, "desc"));
  if (cursorDoc) constraints.push(startAfter(cursorDoc));
  constraints.push(limit(PAGE_SIZE + 1));

  const snap = await getDocs(query(collection(db, "logbook_instances"), ...constraints));
  const docs = snap.docs;
  const hasNext = docs.length > PAGE_SIZE;
  const pageDocs = hasNext ? docs.slice(0, PAGE_SIZE) : docs;
  const rows = pageDocs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));

  rows.sort((a, b) => {
    const aTime = getTime(a.updatedAt) || getTime(a.date);
    const bTime = getTime(b.updatedAt) || getTime(b.date);
    return bTime - aTime;
  });

  return {
    rows,
    cursorDoc: pageDocs.length ? pageDocs[pageDocs.length - 1] : cursorDoc,
    hasNext
  };
}

async function ensurePageLoaded(pageIndex) {
  if (pageCache[pageIndex]) return pageCache[pageIndex];
  if (!activeServerFilters) return null;

  if (pageIndex === 0) {
    const page = await fetchEntriesPage(activeServerFilters);
    pageCache[0] = page;
    return page;
  }

  const previousPage = await ensurePageLoaded(pageIndex - 1);
  if (!previousPage || !previousPage.hasNext) return null;

  const nextPage = await fetchEntriesPage(activeServerFilters, previousPage.cursorDoc);
  pageCache[pageIndex] = nextPage;
  return nextPage;
}

function getCurrentPageRows() {
  const page = pageCache[currentPageIndex];
  return page ? page.rows : [];
}

function getVisibleRows() {
  const queryText = String(filterInput?.value || "").toLowerCase().trim();
  const rows = getCurrentPageRows();
  if (!queryText) return rows;

  return rows.filter((entry) => {
    const searchStr = [
      entry.id,
      entry.storeId,
      entry.templateId,
      entry.templateName,
      entry.date,
      entry.status
    ].filter(Boolean).join(" ").toLowerCase();
    return searchStr.includes(queryText);
  });
}

function updateCountBadge(visibleRows) {
  const loadedCount = getCurrentPageRows().length;
  if (!currentTotalCount && !loadedCount) {
    countBadge.textContent = "0 entries";
    return;
  }

  if (String(filterInput?.value || "").trim()) {
    countBadge.textContent = `${visibleRows.length} of ${loadedCount} loaded (${currentTotalCount} in range)`;
    return;
  }

  countBadge.textContent = `${loadedCount} loaded (${currentTotalCount} in range)`;
}

function updatePaginationUi() {
  const totalPages = Math.max(1, Math.ceil(Math.max(currentTotalCount, 1) / PAGE_SIZE));
  pageInfoEl.textContent = `Page ${currentPageIndex + 1} of ${totalPages}`;
  prevPageBtn.disabled = currentPageIndex === 0;
  nextPageBtn.disabled = !pageCache[currentPageIndex]?.hasNext;
}

function renderTable(entries) {
  if (!entries.length) {
    replaceWithMessage(tableContainer, "empty", "No entries found.");
    return;
  }

  const table = document.createElement("table");
  table.className = "debug-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Instance ID</th>
        <th>Store ID</th>
        <th>Template ID</th>
        <th>Template Name</th>
        <th>Date</th>
        <th>Status</th>
        <th>Updated At</th>
        <th>Action</th>
      </tr>
    </thead>
    <tbody id="tableBody"></tbody>
  `;

  const tbody = table.querySelector("#tableBody");

  entries.forEach((entry) => {
    const tr = document.createElement("tr");
    if (isTestStore(entry.storeId)) tr.className = "test-store";

    const status = getDisplayStatus(entry);
    const statusLabel = status === "overdue" ? "overdue" : String(status || "not_started").replace("_", " ");
    const updatedAt = formatTimestamp(entry.updatedAt);

    const instanceCell = document.createElement("td");
    const instanceCode = document.createElement("code");
    instanceCode.style.fontSize = "10px";
    instanceCode.textContent = entry.id || "-";
    instanceCell.appendChild(instanceCode);
    tr.appendChild(instanceCell);

    const storeCell = document.createElement("td");
    const storeStrong = document.createElement("strong");
    storeStrong.textContent = entry.storeId || "-";
    storeCell.appendChild(storeStrong);
    tr.appendChild(storeCell);

    const templateIdCell = document.createElement("td");
    const templateCode = document.createElement("code");
    templateCode.style.fontSize = "10px";
    templateCode.textContent = entry.templateId || "-";
    templateIdCell.appendChild(templateCode);
    tr.appendChild(templateIdCell);

    const templateNameCell = document.createElement("td");
    templateNameCell.textContent = entry.templateName || "-";
    tr.appendChild(templateNameCell);

    const dateCell = document.createElement("td");
    dateCell.textContent = entry.date || entry.workDate || "-";
    tr.appendChild(dateCell);

    const statusCell = document.createElement("td");
    const statusPill = document.createElement("span");
    statusPill.className = `status-pill ${safeClassToken(status, "unknown")}`;
    statusPill.textContent = statusLabel;
    statusCell.appendChild(statusPill);
    tr.appendChild(statusCell);

    const updatedCell = document.createElement("td");
    const updatedMeta = document.createElement("span");
    updatedMeta.className = "meta";
    updatedMeta.textContent = updatedAt;
    updatedCell.appendChild(updatedMeta);
    tr.appendChild(updatedCell);

    const actionCell = document.createElement("td");
    const viewButton = document.createElement("button");
    viewButton.className = "btn view-btn";
    viewButton.style.padding = "6px 10px";
    viewButton.style.fontSize = "12px";
    viewButton.style.minHeight = "32px";
    viewButton.dataset.instanceId = entry.id || "";
    viewButton.dataset.templateId = entry.templateId || "";
    viewButton.dataset.storeId = entry.storeId || "";
    viewButton.dataset.date = entry.date || entry.workDate || "";
    viewButton.textContent = "View";
    actionCell.appendChild(viewButton);
    tr.appendChild(actionCell);

    tbody.appendChild(tr);
  });

  clearElement(tableContainer);
  tableContainer.appendChild(table);

  document.querySelectorAll(".view-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const instanceId = button.dataset.instanceId || "";
      const templateId = button.dataset.templateId || "";
      const storeId = button.dataset.storeId || "";
      const date = button.dataset.date || "";
      if (!templateId || !date) {
        window.alert("Missing template ID or date for this entry.");
        return;
      }
      window.location.href = `view-entry.html?instanceId=${encodeURIComponent(instanceId)}&templateId=${encodeURIComponent(templateId)}&storeId=${encodeURIComponent(storeId)}&date=${encodeURIComponent(date)}`;
    });
  });
}

function renderCurrentPage() {
  const visibleRows = getVisibleRows();
  renderTable(visibleRows);
  updateCountBadge(visibleRows);
  updatePaginationUi();
}

async function loadEntries(options = {}) {
  const resetPagination = options.resetPagination !== false;
  ensureDateDefaults();
  setStatus("Loading...");
  replaceWithMessage(tableContainer, "empty", "Loading entries...");

  try {
    const filters = readServerFilters();
    const nextKey = buildServerKey(filters);

    if (resetPagination || nextKey !== activeServerKey) {
      const resolved = await resolveFieldName(filters);
      activeServerFilters = filters;
      activeServerKey = nextKey;
      currentFieldName = resolved.fieldName;
      currentTotalCount = resolved.totalCount;
      currentPageIndex = 0;
      pageCache = [];
    }

    await ensurePageLoaded(currentPageIndex);
    renderCurrentPage();
    setStatus(`Loaded ${currentTotalCount} entries in range`, "success");
  } catch (error) {
    console.error(error);
    setStatus("Load failed", "error");
    replaceWithMessage(tableContainer, "empty", error?.message || "Failed to load entries. Please refresh and try again.");
    countBadge.textContent = "0 entries";
    pageInfoEl.textContent = "Page 1 of 1";
  }
}

filterInput?.addEventListener("input", renderCurrentPage);
clearFilterBtn?.addEventListener("click", () => {
  filterInput.value = "";
  renderCurrentPage();
});
applyRangeBtn?.addEventListener("click", () => {
  void loadEntries({ resetPagination: true });
});
refreshBtn?.addEventListener("click", () => {
  void loadEntries({ resetPagination: true });
});
prevPageBtn?.addEventListener("click", () => {
  if (currentPageIndex === 0) return;
  currentPageIndex -= 1;
  renderCurrentPage();
});
nextPageBtn?.addEventListener("click", async () => {
  const nextIndex = currentPageIndex + 1;
  const nextPage = await ensurePageLoaded(nextIndex);
  if (!nextPage) return;
  currentPageIndex = nextIndex;
  renderCurrentPage();
});

ensureDateDefaults();
void loadEntries({ resetPagination: true });
