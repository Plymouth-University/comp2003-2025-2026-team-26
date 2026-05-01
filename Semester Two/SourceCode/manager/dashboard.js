import { db } from "../shared/logbook-app.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { buildWordStylePdfDom, exportDomToPdf, sanitizeFilename } from "../shared/pdf-export.js";
import { writeUserActivity } from "../shared/activity-log.js";
import { addDaysToDateKey, buildBusinessWeekRows, getBusinessDateISO } from "../shared/business-time.js";
import { clearElement, replaceWithMessage, safeClassToken, setSelectOptions } from "../shared/dom-utils.js";
import { buildMissingIndexError } from "../shared/firestore-query.js";
import { loadEntryMeta } from "../shared/instance-entry-storage.js";
import { detectLogbookExceptions as detectRuntimeExceptions } from "../shared/logbook-runtime.js";
import { resolveManagerScopeOrThrow } from "../shared/manager-scope.js";
import { waitForPageGuard } from "../shared/page-guard.js";
await waitForPageGuard();

const FETCH_BATCH_SIZE = 120;
const MAX_FETCH_BATCHES = 20;
const PAGE_SIZE = 24;

const statusEl = document.getElementById("status");
const storeFilter = document.getElementById("storeFilter");
const departmentFilter = document.getElementById("departmentFilter");
const sectionFilter = document.getElementById("sectionFilter");
const statusFilter = document.getElementById("statusFilter");
const dateFromFilter = document.getElementById("dateFromFilter");
const dateToFilter = document.getElementById("dateToFilter");
const searchBox = document.getElementById("searchBox");
const searchBtn = document.getElementById("searchBtn");
const clearBtn = document.getElementById("clearBtn");
const resultsContainer = document.getElementById("resultsContainer");

const selectedCountEl = document.getElementById("selectedCount");
const visibleCountEl = document.getElementById("visibleCount");
const selectAllBtn = document.getElementById("selectAllBtn");
const clearSelectionBtn = document.getElementById("clearSelectionBtn");
const exportSelectedPdfBtn = document.getElementById("exportSelectedPdfBtn");
const exportFilteredPdfBtn = document.getElementById("exportFilteredPdfBtn");
const prevPageBtn = document.getElementById("prevPageBtn");
const nextPageBtn = document.getElementById("nextPageBtn");
const pageInfoEl = document.getElementById("pageInfo");

const storeNameById = new Map();
const templateMetaById = new Map();
const templateBlocksById = new Map();
const entryByKey = new Map();
let enrichedRecords = [];
let initialDepartment = "";
let initialSection = "";
let selectedIds = new Set();
let exportInProgress = false;
let openedSectionLogged = false;
let currentPage = 1;
let managerScopeReady = true;
const scope = {
  storeId: "",
  department: ""
};

function setStatus(msg, kind = "info") {
  statusEl.textContent = msg;
  statusEl.classList.remove("success", "error");
  if (kind === "success") statusEl.classList.add("success");
  if (kind === "error") statusEl.classList.add("error");
}

function clean(value) {
  const text = String(value || "").trim();
  return text || "";
}

function parseTs(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getFirst(...vals) {
  for (const v of vals) {
    if (v !== null && v !== undefined && String(v).trim() !== "") return String(v).trim();
  }
  return "Unknown";
}

function ensureDefaults() {
  if (!dateFromFilter.value && !dateToFilter.value) {
    const today = getBusinessDateISO();
    dateFromFilter.value = addDaysToDateKey(today, -30);
    dateToFilter.value = today;
  }
}

function mondayOfWeek(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function buildAutoDayRows(dateStr) {
  return buildBusinessWeekRows(dateStr || getBusinessDateISO(), true);
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

  if (!managerScopeReady) {
    storeFilter.disabled = true;
  }
}

async function resolveScope() {
  try {
    const resolved = await resolveManagerScopeOrThrow();
    scope.storeId = clean(resolved.storeId);
    scope.department = clean(resolved.department);
    managerScopeReady = true;
  } catch (error) {
    managerScopeReady = false;
    scope.storeId = "";
    scope.department = "";
    console.warn("Failed to resolve manager scope", error);
  }
}

async function getTemplateMeta(templateId) {
  if (!templateId) return { name: "Unknown" };
  if (templateMetaById.has(templateId)) return templateMetaById.get(templateId);
  let data = { name: templateId };
  try {
    const snap = await getDoc(doc(db, "logbook_templates", templateId));
    if (snap.exists()) data = { id: templateId, ...snap.data() };
  } catch (error) {
    console.warn("template lookup failed", templateId, error);
  }
  templateMetaById.set(templateId, data);
  return data;
}

async function getTemplateBlocks(templateId) {
  if (!templateId) return [];
  if (templateBlocksById.has(templateId)) return templateBlocksById.get(templateId);
  let blocks = [];
  try {
    const snap = await getDocs(query(collection(db, "logbook_templates", templateId, "blocks"), orderBy("sort_index")));
    blocks = snap.docs.map((row) => ({ block_id: row.id, ...row.data() }));
  } catch (error) {
    console.warn("blocks lookup failed", templateId, error);
  }
  templateBlocksById.set(templateId, blocks);
  return blocks;
}

async function getEntry(instanceId, templateId, dateKey) {
  const key = `${instanceId || "none"}::${templateId || "none"}::${dateKey || "none"}`;
  if (entryByKey.has(key)) return entryByKey.get(key);
  const data = await loadEntryMeta({ instanceId, templateId, dateKey });
  entryByKey.set(key, data);
  return data;
}

function detectExceptions(blocks, values, dateKey) {
  const issues = [];
  for (const block of blocks) {
    const cfg = block.config || {};
    const bId = block.block_id;
    if (!bId) continue;

    if (block.type === "yes_no") {
      if (String(values[bId] || "").toLowerCase() === "no" && cfg.no_is_exception !== false) {
        issues.push(`${block.label || "Yes/No"}: No`);
      }
      continue;
    }

    if (block.type === "temperature") {
      const num = asNumber(values[bId]);
      if (num === null) continue;
      const min = asNumber(cfg.min);
      const max = asNumber(cfg.max);
      if ((min !== null && num < min) || (max !== null && num > max)) {
        issues.push(`${block.label || "Temperature"}: ${num}`);
      }
      continue;
    }

    if (block.type !== "table") continue;

    const columns = Array.isArray(cfg.columns) ? cfg.columns : [];
    let rows = Array.isArray(cfg.rows) ? cfg.rows : [];
    if (cfg.row_mode === "per_day") rows = buildAutoDayRows(dateKey);

    for (const row of rows) {
      const rowId = row.id || row.label || "row";
      for (const col of columns) {
        const key = `${bId}::${rowId}::${col.key || "col"}`;
        const val = values[key];
        if (col.input === "yn" && String(val || "").toLowerCase() === "no") {
          issues.push(`${cfg.title || block.label || "Table"} / ${row.label || rowId}`);
          continue;
        }
        if (col.input === "number") {
          const num = asNumber(val);
          if (num === null) continue;
          const min = asNumber(col.min);
          const max = asNumber(col.max);
          if ((min !== null && num < min) || (max !== null && num > max)) {
            issues.push(`${cfg.title || block.label || "Table"} / ${row.label || rowId}: ${num}`);
          }
        }
      }
    }
  }
  return issues;
}

async function fetchInstances() {
  if (!managerScopeReady) {
    throw new Error("Manager scope could not be resolved. Sign out and back in to restore access.");
  }

  const storeId = scope.storeId || storeFilter.value;
  const from = dateFromFilter.value;
  const to = dateToFilter.value;
  const colRef = collection(db, "logbook_instances");
  const constraints = [];
  if (storeId) constraints.push(where("storeId", "==", storeId));
  if (from) constraints.push(where("date", ">=", from));
  if (to) constraints.push(where("date", "<=", to));

  let rows = [];
  let cursorDoc = null;
  let batchCount = 0;
  const orderField = (from || to) ? "date" : "updatedAt";

  try {
    while (batchCount < MAX_FETCH_BATCHES) {
      const paging = cursorDoc ? [startAfter(cursorDoc)] : [];
      const q = query(colRef, ...constraints, orderBy(orderField, "desc"), ...paging, limit(FETCH_BATCH_SIZE));
      const snap = await getDocs(q);
      if (snap.empty) break;
      snap.docs.forEach((docRow) => rows.push({ id: docRow.id, ...docRow.data() }));
      cursorDoc = snap.docs[snap.docs.length - 1];
      batchCount += 1;
      if (snap.docs.length < FETCH_BATCH_SIZE) break;
    }
  } catch (error) {
    throw buildMissingIndexError("Manager compliance records", error, "Failed to load records.");
  }

  if (from) rows = rows.filter((row) => String(row.date || "") >= from);
  if (to) rows = rows.filter((row) => String(row.date || "") <= to);
  return rows;
}

function getDepartment(instance, templateName, templateData) {
  const explicit = getFirst(instance.department, instance.dept, templateData.department, templateData.dept, templateData.category);
  if (explicit !== "Unknown") return explicit;
  if (templateName.includes(":")) return templateName.split(":")[0].trim() || "General";
  if (templateName.includes(" - ")) return templateName.split(" - ")[0].trim() || "General";
  return "General";
}

function getSection(instance, templateName, templateData) {
  const explicit = getFirst(instance.section, instance.logbookSection, templateData.section, templateData.logbookSection);
  if (explicit !== "Unknown") return explicit;
  return templateName || "General";
}

function canonicalStatus(instanceStatus, exceptionCount) {
  const status = String(instanceStatus || "").toLowerCase();
  if (status === "flagged") return "flagged";
  if (status === "completed") return exceptionCount > 0 ? "flagged" : "completed";
  return "incomplete";
}

async function enrich(instance, index, total) {
  if (index > 0 && index % 20 === 0) setStatus(`Analysing ${index}/${total}...`);
  let template = {};
  let entry = null;
  let issues = Array.isArray(instance.exceptionPreview)
    ? instance.exceptionPreview.filter(Boolean)
    : [];
  const exceptionCount = Number(instance.exceptionCount || 0);
  const needsTemplateMeta = !getFirst(instance.templateName, instance.templateId) || !clean(instance.department) || !clean(instance.section);
  const needsEntryFallback =
    !getFirst(instance.completedBy, instance.completedByUid, instance.completed_by) ||
    !clean(instance.complianceStatus) ||
    (exceptionCount > 0 && issues.length === 0) ||
    (!instance.locked && !instance.lockedAt && String(instance.status || "").toLowerCase() === "completed");

  if (needsTemplateMeta) {
    template = await getTemplateMeta(instance.templateId || "");
  }
  if (needsEntryFallback) {
    entry = await getEntry(instance.id, instance.templateId || "", instance.date || "");
  }
  if (needsEntryFallback && exceptionCount > 0 && issues.length === 0 && entry?.values && instance.templateId) {
    const blocks = await getTemplateBlocks(instance.templateId || "");
    issues = detectRuntimeExceptions(blocks, entry.values || {}, instance.date || "");
  } else if (issues.length === 0 && exceptionCount > 0) {
    issues = Array.from({ length: Math.min(exceptionCount, 3) }, (_value, issueIndex) => `Issue ${issueIndex + 1}`);
  }

  const templateName = getFirst(instance.templateName, template.name, instance.templateId, "Unknown");
  const department = getFirst(instance.department, instance.dept) !== "Unknown"
    ? getFirst(instance.department, instance.dept)
    : getDepartment(instance, templateName, template);
  const section = getFirst(instance.section, instance.logbookSection) !== "Unknown"
    ? getFirst(instance.section, instance.logbookSection)
    : getSection(instance, templateName, template);
  const completedBy = getFirst(
    instance.completedBy,
    instance.completedByUid,
    instance.completed_by,
    entry?.completedBy,
    entry?.completedByUid,
    entry?.submittedBy,
    entry?.savedBy,
    entry?.uid,
    entry?.userId
  );
  const submittedAt =
    parseTs(instance.completedAt) ||
    parseTs(instance.submittedAt) ||
    parseTs(instance.updatedAt) ||
    parseTs(entry?.submittedAt) ||
    parseTs(entry?.saved_at);
  const status = clean(instance.complianceStatus) || canonicalStatus(instance.status, exceptionCount || issues.length);

  return {
    id: instance.id,
    instanceId: instance.id,
    templateId: instance.templateId || "",
    storeId: instance.storeId || "Unknown",
    storeName: storeNameById.get(instance.storeId) || instance.storeId || "Unknown",
    date: instance.date || "Unknown",
    submittedAt,
    submittedText: submittedAt ? submittedAt.toLocaleString() : "Unknown",
    templateName,
    department,
    section,
    completedBy,
    status,
    exceptions: issues,
    locked: Boolean(instance.locked || instance.lockedAt || entry?.recordLocked || status !== "incomplete")
  };
}

function applyClientFilters() {
  const dep = departmentFilter.value;
  const section = sectionFilter.value;
  const status = statusFilter.value;
  const search = searchBox.value.trim().toLowerCase();

  return enrichedRecords.filter((row) => {
    if (scope.storeId && row.storeId !== scope.storeId) return false;
    if (scope.department && row.department !== scope.department) return false;
    if (dep && row.department !== dep) return false;
    if (section && row.section !== section) return false;
    if (status && row.status !== status) return false;
    if (search) {
      const text = [row.storeName, row.storeId, row.department, row.section, row.completedBy, row.templateName, row.date, row.status, ...row.exceptions].join(" ").toLowerCase();
      if (!text.includes(search)) return false;
    }
    return true;
  }).sort((a, b) => {
    const aMs = a.submittedAt ? a.submittedAt.getTime() : 0;
    const bMs = b.submittedAt ? b.submittedAt.getTime() : 0;
    if (bMs !== aMs) return bMs - aMs;
    return String(b.date).localeCompare(String(a.date));
  });
}

function repopulateContextFilters(records) {
  const currentDep = departmentFilter.value;
  const currentSection = sectionFilter.value;
  const deps = [...new Set(records.map((r) => r.department).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const sections = [...new Set(records.map((r) => r.section).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  setSelectOptions(departmentFilter, [{ value: "", label: "All departments" }, ...deps.map((d) => ({ value: d, label: d }))]);
  setSelectOptions(sectionFilter, [{ value: "", label: "All sections" }, ...sections.map((s) => ({ value: s, label: s }))]);

  if (initialDepartment && deps.includes(initialDepartment)) {
    departmentFilter.value = initialDepartment;
    initialDepartment = "";
  } else if (deps.includes(currentDep)) {
    departmentFilter.value = currentDep;
  }

  if (scope.department) {
    departmentFilter.value = scope.department;
    departmentFilter.disabled = true;
  } else {
    departmentFilter.disabled = false;
  }

  if (initialSection && sections.includes(initialSection)) {
    sectionFilter.value = initialSection;
    initialSection = "";
  } else if (sections.includes(currentSection)) {
    sectionFilter.value = currentSection;
  }
}

function updateSelectionUi(visibleRecords) {
  if (visibleCountEl) visibleCountEl.textContent = String(visibleRecords.length);
  const selectedVisible = visibleRecords.filter((r) => selectedIds.has(r.instanceId)).length;
  if (selectedCountEl) selectedCountEl.textContent = String(selectedVisible);
  if (exportSelectedPdfBtn) exportSelectedPdfBtn.disabled = exportInProgress || selectedVisible === 0;
}

function createStatusPill(label, ...extraClasses) {
  const pill = document.createElement("span");
  pill.classList.add("status-pill");
  extraClasses.filter(Boolean).forEach((className) => pill.classList.add(className));
  pill.textContent = label;
  return pill;
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

function appendPrimaryMeta(cell, primaryText, metaText) {
  const strong = document.createElement("strong");
  strong.textContent = primaryText;
  cell.appendChild(strong);
  if (metaText) {
    cell.appendChild(document.createElement("br"));
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = metaText;
    cell.appendChild(meta);
  }
}

async function exportRowsToPdfs(rows, label) {
  if (exportInProgress) return;
  if (!rows.length) {
    setStatus("No records to export", "error");
    return;
  }

  if (rows.length > 15) {
    const _confirm = typeof styledConfirm === "function" ? styledConfirm : (msg) => Promise.resolve(window.confirm(msg));
    const ok = await _confirm(`This will download ${rows.length} PDF files. Your browser may ask to allow multiple downloads. Continue?`, "Bulk PDF Export", { icon: "📄", confirmText: "Download All" });
    if (!ok) return;
  }

  exportInProgress = true;
  if (exportFilteredPdfBtn) exportFilteredPdfBtn.disabled = true;
  if (exportSelectedPdfBtn) exportSelectedPdfBtn.disabled = true;
  if (searchBtn) searchBtn.disabled = true;
  if (clearBtn) clearBtn.disabled = true;

  const failures = [];
  const canvasScale = rows.length >= 20 ? 1.25 : rows.length >= 10 ? 1.5 : 2;
  const imageQuality = rows.length >= 20 ? 0.92 : rows.length >= 10 ? 0.95 : 0.98;

  try {
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      setStatus(`Exporting ${label}: ${i + 1}/${rows.length}...`);

      try {
        const templateMeta = await getTemplateMeta(row.templateId);
        const blocks = await getTemplateBlocks(row.templateId);
        const entry = await getEntry(row.instanceId, row.templateId, row.date);
        const values = entry?.values || {};

        const dom = buildWordStylePdfDom({
          title: row.templateName || templateMeta.name || row.templateId || "Logbook",
          templateId: row.templateId || "",
          storeName: row.storeName || row.storeId || "Unknown",
          dateKey: row.date || "",
          blocks,
          values,
          extraMeta: [
            {
              leftLabel: "Completed By",
              leftValue: row.completedBy || "Unknown",
              rightLabel: "Status",
              rightValue: row.status || "Unknown"
            },
            {
              leftLabel: "Exceptions",
              leftValue: row.exceptions?.length ? `${row.exceptions.length} flagged` : "None",
              rightLabel: "Integrity",
              rightValue: row.locked ? "Locked" : "Unlocked"
            }
          ]
        });

        const idSuffix = row.instanceId ? `_${sanitizeFilename(row.instanceId).slice(0, 8)}` : "";
        const filename = `${sanitizeFilename(row.templateName || templateMeta.name || row.templateId || "record")}_${sanitizeFilename(row.storeName || row.storeId || "store")}_${sanitizeFilename(row.date || "date")}${idSuffix}.pdf`;
        await exportDomToPdf(dom, filename, {
          image: { type: "jpeg", quality: imageQuality },
          html2canvas: { scale: canvasScale, useCORS: true, backgroundColor: "#ffffff" }
        });
      } catch (error) {
        console.error(error);
        failures.push(row);
      }

      // Yield between exports to keep UI responsive and reduce memory pressure.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 60));
    }

    if (failures.length) {
      setStatus(`Export finished with ${failures.length} failure(s). See console.`, "error");
    } else {
      setStatus(`Exported ${rows.length} PDF file(s)`, "success");
    }

    const exportedCount = Math.max(0, rows.length - failures.length);
    if (exportedCount > 0) {
      await writeUserActivity({
        actionType: "exported_record",
        summary: `Exported ${exportedCount} saved record PDF(s)`,
        storeId: storeFilter.value || "",
        department: departmentFilter.value || "",
        section: sectionFilter.value || "",
        metadata: {
          source: "manager_saved_records",
          mode: label,
          requestedCount: rows.length,
          exportedCount,
          failureCount: failures.length,
          dateFrom: dateFromFilter.value || "",
          dateTo: dateToFilter.value || ""
        }
      });
    }
  } finally {
    exportInProgress = false;
    if (exportFilteredPdfBtn) exportFilteredPdfBtn.disabled = false;
    if (searchBtn) searchBtn.disabled = false;
    if (clearBtn) clearBtn.disabled = false;
    updateSelectionUi(applyClientFilters());
  }
}

function render(records) {
  updateSelectionUi(records);
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
        <th class="select-col"><input type="checkbox" id="selectAllVisible" title="Select all visible rows" /></th>
        <th>Date/Time</th>
        <th>Store</th>
        <th>Department</th>
        <th>Section</th>
        <th>Completed by</th>
        <th>Status</th>
        <th>Exceptions</th>
        <th>Integrity</th>
        <th>Action</th>
      </tr>
    </thead>
    <tbody id="resultsBody"></tbody>
  `;

  const tbody = table.querySelector("#resultsBody");
  const back = new URLSearchParams({
    store: storeFilter.value || "",
    department: departmentFilter.value || "",
    section: sectionFilter.value || "",
    status: statusFilter.value || "",
    from: dateFromFilter.value || "",
    to: dateToFilter.value || "",
    q: searchBox.value || ""
  }).toString();

  pageRecords.forEach((row) => {
    const tr = document.createElement("tr");
    const exceptionText = row.exceptions.length ? `${row.exceptions.length} flagged` : "None";
    const statusLabel = row.status.charAt(0).toUpperCase() + row.status.slice(1);

    const selectCell = document.createElement("td");
    selectCell.className = "select-col";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "row-select";
    checkbox.dataset.instanceId = row.instanceId;
    checkbox.checked = selectedIds.has(row.instanceId);
    checkbox.title = "Select row";
    selectCell.appendChild(checkbox);
    tr.appendChild(selectCell);

    const dateCell = document.createElement("td");
    appendPrimaryMeta(dateCell, row.date, row.submittedText);
    tr.appendChild(dateCell);

    const storeCell = document.createElement("td");
    appendPrimaryMeta(storeCell, row.storeName, row.storeId);
    tr.appendChild(storeCell);

    const departmentCell = document.createElement("td");
    departmentCell.textContent = row.department;
    tr.appendChild(departmentCell);

    const sectionCell = document.createElement("td");
    sectionCell.appendChild(document.createTextNode(row.section));
    sectionCell.appendChild(document.createElement("br"));
    const sectionMeta = document.createElement("span");
    sectionMeta.className = "meta";
    sectionMeta.textContent = row.templateName;
    sectionCell.appendChild(sectionMeta);
    tr.appendChild(sectionCell);

    const completedByCell = document.createElement("td");
    completedByCell.textContent = row.completedBy;
    tr.appendChild(completedByCell);

    const statusCell = document.createElement("td");
    statusCell.appendChild(createStatusPill(statusLabel, safeClassToken(row.status, "unknown")));
    tr.appendChild(statusCell);

    const exceptionsCell = document.createElement("td");
    exceptionsCell.appendChild(createStatusPill(exceptionText, row.exceptions.length ? "overdue" : "completed"));
    if (row.exceptions.length) {
      const details = document.createElement("div");
      details.className = "meta";
      details.textContent = row.exceptions.slice(0, 2).join(" | ");
      exceptionsCell.appendChild(details);
    }
    tr.appendChild(exceptionsCell);

    const integrityCell = document.createElement("td");
    integrityCell.appendChild(createStatusPill(row.locked ? "Locked" : "Unlocked", row.locked ? "completed" : "overdue"));
    tr.appendChild(integrityCell);

    const actionCell = document.createElement("td");
    const viewLink = document.createElement("a");
    viewLink.className = "btn";
    viewLink.href = `view-record.html?instanceId=${encodeURIComponent(row.instanceId)}&templateId=${encodeURIComponent(row.templateId)}&storeId=${encodeURIComponent(row.storeId)}&date=${encodeURIComponent(row.date)}&back=${encodeURIComponent(`compliance-records.html?${back}`)}`;
    viewLink.textContent = "View";
    actionCell.appendChild(viewLink);
    tr.appendChild(actionCell);

    tbody.appendChild(tr);
  });

  clearElement(resultsContainer);
  resultsContainer.appendChild(table);

  const selectAllVisible = table.querySelector("#selectAllVisible");
  const rowBoxes = [...table.querySelectorAll(".row-select")];

  function refreshHeaderCheckbox() {
    const allChecked = rowBoxes.length > 0 && rowBoxes.every((box) => box.checked);
    const anyChecked = rowBoxes.some((box) => box.checked);
    selectAllVisible.checked = allChecked;
    selectAllVisible.indeterminate = anyChecked && !allChecked;
  }

  rowBoxes.forEach((box) => {
    box.addEventListener("change", () => {
      const id = box.dataset.instanceId || "";
      if (box.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      updateSelectionUi(records);
      refreshHeaderCheckbox();
    });
  });

  selectAllVisible.addEventListener("change", () => {
    rowBoxes.forEach((box) => {
      box.checked = selectAllVisible.checked;
      const id = box.dataset.instanceId || "";
      if (selectAllVisible.checked) selectedIds.add(id);
      else selectedIds.delete(id);
    });
    updateSelectionUi(records);
    refreshHeaderCheckbox();
  });

  refreshHeaderCheckbox();
}

async function loadAndRender() {
  setStatus("Loading records...");
  replaceWithMessage(resultsContainer, "empty", "Loading...");
  selectedIds = new Set();
  updateSelectionUi([]);
  currentPage = 1;

  try {
    const raw = await fetchInstances();
    setStatus(`Analysing ${raw.length} record(s)...`);
    const records = [];
    for (let i = 0; i < raw.length; i += 1) {
      records.push(await enrich(raw[i], i, raw.length));
    }
    enrichedRecords = records;
    repopulateContextFilters(enrichedRecords);
    const filtered = applyClientFilters();
    render(filtered);
    setStatus(`Showing ${filtered.length} record(s)`, "success");
  } catch (error) {
    console.error(error);
    const message = error?.message || "Search failed. Please refresh and try again.";
    setStatus(message, "error");
    replaceWithMessage(resultsContainer, "empty", message);
  }
}

clearBtn.addEventListener("click", async () => {
  if (!scope.storeId) storeFilter.value = "";
  departmentFilter.value = "";
  sectionFilter.value = "";
  statusFilter.value = "";
  searchBox.value = "";
  initialDepartment = "";
  initialSection = "";
  ensureDefaults();
  currentPage = 1;
  await loadAndRender();
});

searchBtn.addEventListener("click", loadAndRender);
[departmentFilter, sectionFilter, statusFilter].forEach((el) => el.addEventListener("change", () => {
  currentPage = 1;
  const filtered = applyClientFilters();
  render(filtered);
  setStatus(`Showing ${filtered.length} record(s)`, "success");
}));
searchBox.addEventListener("input", () => {
  currentPage = 1;
  const filtered = applyClientFilters();
  render(filtered);
});

if (selectAllBtn) {
  selectAllBtn.addEventListener("click", () => {
    const filtered = applyClientFilters();
    filtered.forEach((r) => selectedIds.add(r.instanceId));
    render(filtered);
    setStatus(`Selected ${filtered.length} record(s)`, "success");
  });
}

if (clearSelectionBtn) {
  clearSelectionBtn.addEventListener("click", () => {
    selectedIds = new Set();
    const filtered = applyClientFilters();
    render(filtered);
    setStatus("Selection cleared", "success");
  });
}

if (exportSelectedPdfBtn) {
  exportSelectedPdfBtn.addEventListener("click", async () => {
    const filtered = applyClientFilters();
    const selected = filtered.filter((r) => selectedIds.has(r.instanceId));
    await exportRowsToPdfs(selected, "selected");
  });
}

if (exportFilteredPdfBtn) {
  exportFilteredPdfBtn.addEventListener("click", async () => {
    const filtered = applyClientFilters();
    await exportRowsToPdfs(filtered, "filtered");
  });
}

if (prevPageBtn) {
  prevPageBtn.addEventListener("click", () => {
    if (currentPage <= 1) return;
    currentPage -= 1;
    render(applyClientFilters());
  });
}

if (nextPageBtn) {
  nextPageBtn.addEventListener("click", () => {
    const filtered = applyClientFilters();
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (currentPage >= totalPages) return;
    currentPage += 1;
    render(filtered);
  });
}

async function init() {
  setStatus("Loading filters...");
  await resolveScope();
  await loadStores();

  const params = new URLSearchParams(window.location.search);
  if (params.get("store") && !scope.storeId) storeFilter.value = params.get("store");
  if (params.get("department")) initialDepartment = params.get("department");
  if (params.get("section")) initialSection = params.get("section");
  if (params.get("from")) dateFromFilter.value = params.get("from");
  if (params.get("to")) dateToFilter.value = params.get("to");
  if (params.get("status")) statusFilter.value = params.get("status");
  if (params.get("q")) searchBox.value = params.get("q");

  ensureDefaults();
  if (!openedSectionLogged) {
    openedSectionLogged = true;
    await writeUserActivity({
      actionType: "opened_section",
      summary: "Opened Manager Saved Records",
      storeId: scope.storeId || storeFilter.value || "",
      department: scope.department || initialDepartment || departmentFilter.value || "",
      section: initialSection || sectionFilter.value || "Saved Records",
      metadata: {
        source: "manager_saved_records"
      }
    });
  }
  await loadAndRender();
}

init();
