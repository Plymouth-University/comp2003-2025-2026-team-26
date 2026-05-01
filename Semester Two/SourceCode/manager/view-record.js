import { db } from "../shared/logbook-app.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { buildWordStylePdfDom, exportDomToPdf, sanitizeFilename } from "../shared/pdf-export.js";
import { writeUserActivity } from "../shared/activity-log.js";
import { buildBusinessWeekRows, mondayOfBusinessWeek } from "../shared/business-time.js";
import { getSignatureImageUrl } from "../shared/signature-storage.js";
import { loadEntryMeta } from "../shared/instance-entry-storage.js";
import { detectLogbookExceptions as detectRuntimeExceptions } from "../shared/logbook-runtime.js";
import { waitForPageGuard } from "../shared/page-guard.js";
await waitForPageGuard();

const params = new URLSearchParams(window.location.search);
const instanceId = params.get("instanceId");
const templateId = params.get("templateId");
const storeId = params.get("storeId");
const dateKey = params.get("date");
const back = params.get("back");

const statusEl = document.getElementById("status");
const headerSub = document.getElementById("headerSub");
const formRoot = document.getElementById("formRoot");
const exportBtn = document.getElementById("exportBtn");
const printBtn = document.getElementById("printBtn");
const exceptionCard = document.getElementById("exceptionCard");
const exceptionList = document.getElementById("exceptionList");
const backBtn = document.getElementById("backBtn");

const metaStore = document.getElementById("metaStore");
const metaTemplate = document.getElementById("metaTemplate");
const metaDate = document.getElementById("metaDate");
const metaStatus = document.getElementById("metaStatus");
const metaUpdated = document.getElementById("metaUpdated");
const metaCompletedBy = document.getElementById("metaCompletedBy");
const metaExceptions = document.getElementById("metaExceptions");
const metaIntegrity = document.getElementById("metaIntegrity");

let blocks = [];
let values = {};
let instanceData = {};
let templateData = {};
let exceptionItems = [];
let recordReady = false;

if (back && backBtn) backBtn.href = back;

function syncPageActions(enabled) {
  recordReady = Boolean(enabled);
  exportBtn.disabled = !recordReady;
  printBtn.disabled = !recordReady;
}

function setStatus(msg, kind = "info") {
  statusEl.textContent = msg;
  statusEl.classList.remove("success", "error");
  if (kind === "success") statusEl.classList.add("success");
  if (kind === "error") statusEl.classList.add("error");
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseTs(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getFirst(...vals) {
  for (const v of vals) {
    if (v !== null && v !== undefined && String(v).trim() !== "") return String(v).trim();
  }
  return "Unknown";
}

function mondayOfWeek(dateStr) {
  return mondayOfBusinessWeek(dateStr || dateKey);
}

function buildAutoDayRows(dateStr, showDates) {
  return buildBusinessWeekRows(dateStr || dateKey, showDates);
}

function buildStatusPill(kind, label) {
  const pill = document.createElement("span");
  pill.className = `status-pill ${String(kind || "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;
  pill.textContent = label;
  return pill;
}

function detectExceptions() {
  return detectRuntimeExceptions(blocks, values, dateKey);
}

function issueSet() {
  return new Set(exceptionItems.map((item) => item.key));
}

function renderTable(block, flaggedKeys) {
  const cfg = block.config || {};
  const cols = Array.isArray(cfg.columns) ? cfg.columns : [];
  let rows = Array.isArray(cfg.rows) ? cfg.rows : [];
  if (cfg.row_mode === "per_day") rows = buildAutoDayRows(dateKey, Boolean(cfg.show_dates_in_rows));

  const card = document.createElement("div");
  card.className = "card";

  const title = document.createElement("div");
  title.className = "h2";
  title.textContent = cfg.title || block.label || "Table";
  card.appendChild(title);

  const table = document.createElement("table");
  table.className = "grid";

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  cols.forEach((col) => {
    const th = document.createElement("th");
    th.textContent = col.label || col.key || "";
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const rowId = row.id || row.label || "row";
    cols.forEach((col) => {
      const td = document.createElement("td");
      if (col.input === "rowLabel") {
        td.textContent = row.label || row.id || "";
      } else {
        const key = `${block.block_id}::${rowId}::${col.key || "col"}`;
        const value = values[key];
        td.textContent = value || "-";
        if (!value) td.classList.add("empty");
        if (flaggedKeys.has(key)) td.classList.add("temp-warn");
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  card.appendChild(table);
  return card;
}

function renderRecord() {
  formRoot.innerHTML = "";
  if (!blocks.length) {
    formRoot.innerHTML = '<div class="empty">No block definition found for this template.</div>';
    return;
  }

  const flaggedKeys = issueSet();

  blocks.forEach((block) => {
    const cfg = block.config || {};
    const label = block.label || block.type;
    const id = block.block_id;
    const value = values[id];

    if (block.type === "heading") {
      const card = document.createElement("div");
      card.className = "card";
      const title = document.createElement("div");
      title.className = "h1";
      title.textContent = label;
      card.appendChild(title);
      formRoot.appendChild(card);
      return;
    }

    if (block.type === "section") {
      const card = document.createElement("div");
      card.className = "card";
      const title = document.createElement("div");
      title.className = "h2";
      title.textContent = label;
      card.appendChild(title);
      formRoot.appendChild(card);
      return;
    }

    if (block.type === "table") {
      formRoot.appendChild(renderTable(block, flaggedKeys));
      return;
    }

    const card = document.createElement("div");
    card.className = "card";
    const row = document.createElement("div");
    row.className = "field-row";
    const labelEl = document.createElement("div");
    labelEl.className = "field-label";
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const valueEl = document.createElement("div");
    valueEl.className = "field-value";

    if (block.type === "signature") {
      const imageUrl = getSignatureImageUrl(value);
      if (imageUrl) {
        const img = document.createElement("img");
        img.src = imageUrl;
        img.alt = "Signature";
        valueEl.appendChild(img);
      } else {
        valueEl.classList.add("empty");
        valueEl.textContent = "No signature";
      }
    } else if (block.type === "week_commencing") {
      valueEl.textContent = value || mondayOfWeek(dateKey);
    } else if (block.type === "yes_no") {
      if (value === "yes") {
        valueEl.classList.add("yes");
        valueEl.textContent = cfg.yes_label || "Yes";
      } else if (value === "no") {
        valueEl.classList.add("no");
        valueEl.textContent = cfg.no_label || "No";
      } else {
        valueEl.classList.add("empty");
        valueEl.textContent = "No data entered";
      }
    } else if (block.type === "temperature") {
      if (value || value === 0) {
        const min = asNumber(cfg.min);
        const max = asNumber(cfg.max);
        const num = asNumber(value);
        const bad = num !== null && ((min !== null && num < min) || (max !== null && num > max));
        valueEl.classList.add(bad ? "temp-warn" : "temp-ok");
        valueEl.textContent = `${value} C`;
      } else {
        valueEl.classList.add("empty");
        valueEl.textContent = "No data entered";
      }
    } else {
      valueEl.textContent = value || "No data entered";
      if (!value) valueEl.classList.add("empty");
      if (flaggedKeys.has(id)) valueEl.classList.add("temp-warn");
    }

    row.appendChild(valueEl);
    card.appendChild(row);
    formRoot.appendChild(card);
  });
}

function renderExceptions() {
  if (!exceptionItems.length) {
    exceptionCard.style.display = "none";
    metaExceptions.textContent = "None";
    return;
  }

  exceptionCard.style.display = "block";
  metaExceptions.textContent = `${exceptionItems.length} flagged`;
  exceptionList.replaceChildren();
  exceptionItems.forEach((item) => {
    const row = document.createElement("div");
    row.className = "field-row";

    const labelEl = document.createElement("div");
    labelEl.className = "field-label";
    labelEl.textContent = item.label;

    const valueEl = document.createElement("div");
    valueEl.className = "field-value temp-warn";
    valueEl.textContent = item.value;

    row.appendChild(labelEl);
    row.appendChild(valueEl);
    exceptionList.appendChild(row);
  });
}

function buildPdfDom() {
  const title = templateData.name || templateId || "Logbook";
  const storeName = metaStore.textContent || storeId || "Unknown";

  return buildWordStylePdfDom({
    title,
    templateId: templateId || "",
    storeName,
    dateKey: dateKey || "",
    blocks,
    values,
    extraMeta: [
      {
        leftLabel: "Completed By",
        leftValue: metaCompletedBy.textContent || "Unknown",
        rightLabel: "Status",
        rightValue: metaStatus.textContent || "Unknown"
      },
      {
        leftLabel: "Exceptions",
        leftValue: metaExceptions.textContent || "None",
        rightLabel: "Integrity",
        rightValue: metaIntegrity.textContent || "Unknown"
      }
    ]
  });
}

async function loadRecord() {
  syncPageActions(false);
  if (!templateId || !dateKey) {
    setStatus("Missing parameters", "error");
    formRoot.innerHTML = '<div class="empty">Missing templateId or date.</div>';
    return;
  }

  setStatus("Loading...");
  try {
    if (instanceId) {
      const snap = await getDoc(doc(db, "logbook_instances", instanceId));
      if (snap.exists()) instanceData = snap.data();
    }

    const templateSnap = await getDoc(doc(db, "logbook_templates", templateId));
    if (templateSnap.exists()) templateData = templateSnap.data();

    const blocksSnap = await getDocs(query(collection(db, "logbook_templates", templateId, "blocks"), orderBy("sort_index")));
    blocks = blocksSnap.docs.map((row) => ({ block_id: row.id, ...row.data() }));

    const entry = await loadEntryMeta({ instanceId, templateId, dateKey }) || {};
    values = entry.values || {};

    let storeName = storeId || "Unknown";
    if (storeId) {
      const storeSnap = await getDoc(doc(db, "stores", storeId));
      if (storeSnap.exists()) {
        const data = storeSnap.data() || {};
        storeName = data.name || storeId;
      }
    }

    exceptionItems = detectExceptions();

    const status = (() => {
      const base = String(instanceData.status || "incomplete").toLowerCase();
      if (base === "completed" && exceptionItems.length) return "flagged";
      if (base === "flagged") return "flagged";
      if (base === "completed") return "completed";
      return "incomplete";
    })();
    const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);

    const updatedAt =
      parseTs(instanceData.completedAt) ||
      parseTs(instanceData.submittedAt) ||
      parseTs(entry.submittedAt) ||
      parseTs(entry.saved_at) ||
      parseTs(instanceData.updatedAt);

    const completedBy = getFirst(
      instanceData.completedBy,
      instanceData.completedByUid,
      entry.completedBy,
      entry.completedByUid,
      entry.submittedBy,
      entry.savedBy,
      entry.uid,
      entry.userId
    );

    const locked = Boolean(instanceData.locked || instanceData.lockedAt || entry.recordLocked || status !== "incomplete");

    metaStore.textContent = storeName;
    metaTemplate.textContent = templateData.name || templateId;
    metaDate.textContent = dateKey;
    metaStatus.replaceChildren(buildStatusPill(status, statusLabel));
    metaUpdated.textContent = updatedAt ? updatedAt.toLocaleString() : "Unknown";
    metaCompletedBy.textContent = completedBy;
    metaIntegrity.textContent = locked ? "Locked compliance record" : "Unlocked";

    headerSub.textContent = `${templateData.name || templateId} - ${storeName} - ${dateKey}`;

    renderExceptions();
    renderRecord();
    syncPageActions(true);
    await writeUserActivity({
      actionType: "opened_section",
      summary: `Opened saved record ${templateData.name || templateId}`,
      storeId,
      storeName,
      department: templateData.department || templateData.dept || "",
      section: templateData.section || templateData.logbookSection || templateData.name || templateId,
      templateId,
      instanceId,
      dateKey,
      metadata: {
        source: "manager_view_record"
      }
    });
    setStatus("Loaded", "success");
  } catch (error) {
    console.error(error);
    syncPageActions(false);
    setStatus("Load failed", "error");
    formRoot.innerHTML = '<div class="empty">Failed to load this record.</div>';
  }
}

exportBtn.addEventListener("click", async () => {
  if (!recordReady) {
    setStatus("Load a record first", "error");
    return;
  }
  try {
    const dom = buildPdfDom();
    const idSuffix = instanceId ? `_${sanitizeFilename(instanceId).slice(0, 8)}` : "";
    const filename = `${sanitizeFilename(templateData.name || templateId || "record")}_${sanitizeFilename(metaStore.textContent || "store")}_${sanitizeFilename(dateKey || "date")}${idSuffix}.pdf`;
    setStatus("Generating PDF...");
    await exportDomToPdf(dom, filename);
    await writeUserActivity({
      actionType: "exported_record",
      summary: `Exported saved record ${templateData.name || templateId}`,
      storeId,
      storeName: metaStore.textContent || storeId,
      department: templateData.department || templateData.dept || "",
      section: templateData.section || templateData.logbookSection || templateData.name || templateId,
      templateId,
      instanceId,
      dateKey,
      metadata: {
        source: "manager_view_record",
        filename
      }
    });
    setStatus("PDF downloaded", "success");
  } catch (error) {
    console.error(error);
    setStatus("PDF export failed", "error");
  }
});

printBtn.addEventListener("click", () => {
  if (!recordReady) {
    setStatus("Load a record first", "error");
    return;
  }
  window.print();
});

loadRecord();
