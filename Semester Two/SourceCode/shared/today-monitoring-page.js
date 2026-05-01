import { db } from "./logbook-app.js";
import { collection, doc, getDoc, getDocs, onSnapshot, orderBy, query, where } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { getBusinessDateISO } from "./business-time.js";
import { loadEntryMeta } from "./instance-entry-storage.js";
import { collectReportableNotes, detectLogbookExceptions, normalizeDepartmentValue } from "./logbook-runtime.js";
import { describeTimerWindow } from "./department-timers.js";
import { resolveManagerScopeOrThrow } from "./manager-scope.js";
import { waitForPageGuard } from "./page-guard.js";
await waitForPageGuard();

const pageRole = String(document.body?.dataset?.role || "admin").toLowerCase() === "manager" ? "manager" : "admin";
const todayISO = getBusinessDateISO();
const basePage = "today-monitoring.html";

const statusEl = document.getElementById("status");
const scopeLine = document.getElementById("scopeLine");
const storeFilter = document.getElementById("storeFilter");
const departmentFilter = document.getElementById("departmentFilter");
const statusFilter = document.getElementById("statusFilter");
const attentionFilter = document.getElementById("attentionFilter");
const groupByFilter = document.getElementById("groupByFilter");
const sortFilter = document.getElementById("sortFilter");
const searchBox = document.getElementById("searchBox");
const clearFiltersBtn = document.getElementById("clearFiltersBtn");
const refreshBtn = document.getElementById("refreshBtn");
const summaryCardsEl = document.getElementById("summaryCards");
const activeFiltersEl = document.getElementById("activeFilters");
const summaryMetaEl = document.getElementById("summaryMeta");
const resultsMetaEl = document.getElementById("resultsMeta");
const resultsEl = document.getElementById("results");
const visibleCountEl = document.getElementById("visibleCount");
const updatedAtEl = document.getElementById("updatedAt");

const params = new URLSearchParams(window.location.search);

const managerScope = {
  storeId: "",
  department: ""
};
let managerScopeReady = true;
let rows = [];
let lastLoadedAt = null;
let initialSelectionsApplied = false;
let liveFeedUnsubscribe = null;
let liveFeedGeneration = 0;

const expandedIds = new Set();
const storeNameById = new Map();
const templateMetaById = new Map();
const templateBlocksById = new Map();
const rowCacheById = new Map();
const rowSignatureById = new Map();

const SUMMARY_DEFS = [
  {
    key: "attention",
    label: "Needs Attention",
    tone: "critical",
    note: "Overdue, reminders, notes, or exceptions",
    count: (items) => items.filter((row) => row.needsAttention).length
  },
  {
    key: "overdue",
    label: "Overdue",
    tone: "critical",
    note: "Past their due time right now",
    count: (items) => items.filter((row) => hasReason(row, "overdue")).length
  },
  {
    key: "reminder",
    label: "Reminder Requests",
    tone: "warning",
    note: "Staff have actively asked for help",
    count: (items) => items.filter((row) => hasReason(row, "reminder")).length
  },
  {
    key: "note",
    label: "Staff Notes",
    tone: "warning",
    note: "Notes marked for today monitoring",
    count: (items) => items.filter((row) => hasReason(row, "note")).length
  },
  {
    key: "exception",
    label: "Exceptions",
    tone: "critical",
    note: "Checks or readings outside expectation",
    count: (items) => items.filter((row) => hasReason(row, "exception")).length
  },
  {
    key: "completed",
    label: "Completed",
    tone: "success",
    note: "All completed logbooks in the current scope",
    count: (items) => items.filter((row) => row.workflowState === "completed").length
  },
  {
    key: "no_timer",
    label: "No Timer",
    tone: "neutral",
    note: "Operational gap, but not a blocker by itself",
    count: (items) => items.filter((row) => hasReason(row, "no_timer")).length
  }
];

const ATTENTION_GROUP_ORDER = {
  overdue: 0,
  urgent: 1,
  reminder: 2,
  exception: 3,
  note: 4,
  no_timer: 5,
  clean: 6
};

const WORKFLOW_GROUP_ORDER = {
  not_started: 0,
  in_progress: 1,
  completed: 2,
  skipped: 3
};

function clean(value) {
  const text = String(value || "").trim();
  return text || "";
}

function parseTs(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function humanizeKey(value) {
  return clean(value)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDateTime(value) {
  const parsed = value instanceof Date ? value : parseTs(value);
  if (!parsed) return "Unknown";
  return parsed.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function formatClock(value) {
  const parsed = value instanceof Date ? value : parseTs(value);
  if (!parsed) return "Unknown";
  return parsed.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function formatRelative(value) {
  const parsed = value instanceof Date ? value : parseTs(value);
  if (!parsed) return "No recent activity";
  const diffMs = Date.now() - parsed.getTime();
  const absMinutes = Math.round(Math.abs(diffMs) / 60000);
  if (absMinutes < 1) return "Just now";
  if (absMinutes < 60) return `${absMinutes} min ${diffMs >= 0 ? "ago" : "from now"}`;
  const absHours = Math.round(absMinutes / 60);
  if (absHours < 24) return `${absHours}h ${diffMs >= 0 ? "ago" : "from now"}`;
  const absDays = Math.round(absHours / 24);
  return `${absDays} day${absDays === 1 ? "" : "s"} ${diffMs >= 0 ? "ago" : "from now"}`;
}

function maxDate(values = []) {
  return values.reduce((best, current) => {
    if (!(current instanceof Date) || Number.isNaN(current.getTime())) return best;
    if (!best || current.getTime() > best.getTime()) return current;
    return best;
  }, null);
}

function compareText(a, b) {
  return String(a || "").localeCompare(String(b || ""), "en-GB", { sensitivity: "base" });
}

function compareNullableDatesAsc(a, b) {
  const aTime = a instanceof Date ? a.getTime() : Number.POSITIVE_INFINITY;
  const bTime = b instanceof Date ? b.getTime() : Number.POSITIVE_INFINITY;
  return aTime - bTime;
}

function compareNullableDatesDesc(a, b) {
  const aTime = a instanceof Date ? a.getTime() : 0;
  const bTime = b instanceof Date ? b.getTime() : 0;
  return bTime - aTime;
}

function setStatus(text, kind = "info") {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.remove("success", "error");
  if (kind === "success") statusEl.classList.add("success");
  if (kind === "error") statusEl.classList.add("error");
}

function setSelectOptions(selectEl, items, placeholder) {
  if (!selectEl) return;
  const current = clean(selectEl.value);
  selectEl.innerHTML = "";
  if (placeholder) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = placeholder;
    selectEl.appendChild(option);
  }
  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    selectEl.appendChild(option);
  });
  if (current && items.some((item) => item.value === current)) {
    selectEl.value = current;
  }
}

function setSelectValueIfValid(selectEl, value, fallback = "") {
  if (!selectEl) return;
  const next = clean(value);
  if (next && [...selectEl.options].some((option) => option.value === next)) {
    selectEl.value = next;
    return;
  }
  selectEl.value = fallback;
}

function getSelectedLabel(selectEl) {
  if (!selectEl) return "";
  return clean(selectEl.options[selectEl.selectedIndex]?.textContent);
}

function getDefaultGroupBy() {
  return pageRole === "manager" ? "department" : "store";
}

function normaliseStatusParam(value) {
  const next = clean(value).toLowerCase();
  if (next === "flagged") return "attention";
  return next;
}

function syncUrlState() {
  const next = new URLSearchParams();
  const store = clean(storeFilter?.value);
  const department = clean(departmentFilter?.value);
  const status = clean(statusFilter?.value);
  const reason = clean(attentionFilter?.value);
  const group = clean(groupByFilter?.value);
  const sort = clean(sortFilter?.value);
  const queryText = clean(searchBox?.value);

  if (store) next.set("store", store);
  if (department) next.set("department", department);
  if (status) next.set("status", status);
  if (reason) next.set("reason", reason);
  if (group && group !== getDefaultGroupBy()) next.set("group", group);
  if (sort && sort !== "priority") next.set("sort", sort);
  if (queryText) next.set("q", queryText);

  const queryString = next.toString();
  const nextUrl = queryString ? `${window.location.pathname}?${queryString}` : window.location.pathname;
  window.history.replaceState(null, "", nextUrl);
}

function buildBackUrl() {
  const next = new URLSearchParams();
  const store = clean(storeFilter?.value);
  const department = clean(departmentFilter?.value);
  const status = clean(statusFilter?.value);
  const reason = clean(attentionFilter?.value);
  const group = clean(groupByFilter?.value);
  const sort = clean(sortFilter?.value);
  const queryText = clean(searchBox?.value);

  if (store) next.set("store", store);
  if (department) next.set("department", department);
  if (status) next.set("status", status);
  if (reason) next.set("reason", reason);
  if (group && group !== getDefaultGroupBy()) next.set("group", group);
  if (sort && sort !== "priority") next.set("sort", sort);
  if (queryText) next.set("q", queryText);
  return next.toString() ? `${basePage}?${next}` : basePage;
}

function createPillMarkup(text, kind = "none") {
  return `<span class="pill ${escapeHtml(kind)}">${escapeHtml(text)}</span>`;
}

function summaryBoxMarkup(label, value, note = "") {
  return `
    <div class="summary-box">
      <div class="summary-box-label">${escapeHtml(label)}</div>
      <div class="summary-box-value">
        ${escapeHtml(value)}
        ${note ? `<small>${escapeHtml(note)}</small>` : ""}
      </div>
    </div>
  `;
}

function timelineItemMarkup(label, value) {
  return `
    <div class="timeline-item">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(value)}</span>
    </div>
  `;
}

function hasReason(row, key) {
  return Array.isArray(row.reasonKeys) && row.reasonKeys.includes(key);
}

function getWorkflowLabel(status) {
  const next = clean(status).toLowerCase();
  if (next === "not_started") return "Not started";
  if (next === "in_progress") return "In progress";
  if (next === "completed") return "Completed";
  if (next === "skipped") return "Skipped";
  return humanizeKey(next || "unknown");
}

function getWorkflowTone(status) {
  const next = clean(status).toLowerCase();
  if (next === "completed") return "completed";
  if (next === "in_progress") return "in_progress";
  if (next === "skipped") return "skipped";
  return "not_started";
}

function deriveAttentionReasons({ timer, hasReminder, noteCount, exceptionCount, hasTimer }) {
  const reasons = [];
  if (timer.state === "overdue") {
    reasons.push({ key: "overdue", label: "Overdue", tone: "overdue", attention: true });
  } else if (timer.state === "urgent") {
    reasons.push({ key: "urgent", label: "Due in 15 min", tone: "urgent", attention: true });
  } else if (timer.state === "warning") {
    reasons.push({ key: "urgent", label: "Due within 1 hour", tone: "due_soon", attention: true });
  }
  if (hasReminder) {
    reasons.push({ key: "reminder", label: "Reminder requested", tone: "reminder", attention: true });
  }
  if (exceptionCount > 0) {
    reasons.push({
      key: "exception",
      label: exceptionCount === 1 ? "1 exception" : `${exceptionCount} exceptions`,
      tone: "exception",
      attention: true
    });
  }
  if (noteCount > 0) {
    reasons.push({
      key: "note",
      label: noteCount === 1 ? "1 staff note" : `${noteCount} staff notes`,
      tone: "note",
      attention: true
    });
  }
  if (!hasTimer) {
    reasons.push({ key: "no_timer", label: "No timer assigned", tone: "no_timer", attention: false });
  }
  return reasons;
}

function calculateSeverity({ workflowState, timer, hasReminder, noteCount, exceptionCount, hasTimer }) {
  let score = 0;
  if (timer.state === "overdue") score += 92;
  else if (timer.state === "urgent") score += 72;
  else if (timer.state === "warning") score += 44;
  else if (timer.state === "upcoming") score += 8;

  if (hasReminder) score += 32;
  if (exceptionCount > 0) score += Math.min(42, exceptionCount * 14);
  if (noteCount > 0) score += Math.min(24, noteCount * 8);
  if (!hasTimer) score += 8;

  if (workflowState === "not_started") score += 10;
  if (workflowState === "in_progress") score += 6;
  if (workflowState === "completed") score -= 12;
  if (workflowState === "skipped") score -= 6;

  return Math.max(0, score);
}

function getSeverityTone(score) {
  if (score >= 85) return "critical";
  if (score >= 48) return "high";
  if (score >= 18) return "medium";
  return "calm";
}

function getSeverityLabel(tone) {
  if (tone === "critical") return "Critical";
  if (tone === "high") return "High attention";
  if (tone === "medium") return "Watch";
  return "Routine";
}

function getSeverityPillTone(tone) {
  if (tone === "critical") return "flagged";
  if (tone === "high") return "warning";
  if (tone === "medium") return "active";
  return "clean";
}

async function resolveScope() {
  if (pageRole !== "manager") {
    if (scopeLine) scopeLine.textContent = `Admin scope: ${todayISO}`;
    return;
  }
  try {
    const scope = await resolveManagerScopeOrThrow();
    managerScope.storeId = clean(scope.storeId);
    managerScope.department = clean(scope.department);
    managerScopeReady = true;
    const bits = [];
    if (managerScope.storeId) bits.push(`Store: ${managerScope.storeId}`);
    if (managerScope.department) bits.push(`Department: ${managerScope.department}`);
    if (scopeLine) scopeLine.textContent = bits.length ? `Manager scope: ${bits.join(" | ")}` : `Manager scope: ${todayISO}`;
  } catch (error) {
    console.warn("Manager scope unavailable", error);
    managerScopeReady = false;
    managerScope.storeId = "";
    managerScope.department = "";
    if (scopeLine) scopeLine.textContent = "Manager scope unavailable";
  }
}

async function getTemplateMeta(templateId) {
  if (!templateId) return { name: "Unknown" };
  if (templateMetaById.has(templateId)) return templateMetaById.get(templateId);

  const promise = (async () => {
    let data = { name: templateId };
    try {
      const snap = await getDoc(doc(db, "logbook_templates", templateId));
      if (snap.exists()) data = { id: templateId, ...snap.data() };
    } catch (error) {
      console.warn("template lookup failed", templateId, error);
    }
    return data;
  })();

  templateMetaById.set(templateId, promise);
  const resolved = await promise;
  templateMetaById.set(templateId, resolved);
  return resolved;
}

async function getTemplateBlocks(templateId) {
  if (!templateId) return [];
  if (templateBlocksById.has(templateId)) return templateBlocksById.get(templateId);

  const promise = (async () => {
    let blocks = [];
    try {
      const snap = await getDocs(query(collection(db, "logbook_templates", templateId, "blocks"), orderBy("sort_index")));
      blocks = snap.docs.map((row) => ({ block_id: row.id, ...row.data() }));
    } catch (error) {
      console.warn("blocks lookup failed", templateId, error);
    }
    return blocks;
  })();

  templateBlocksById.set(templateId, promise);
  const resolved = await promise;
  templateBlocksById.set(templateId, resolved);
  return resolved;
}

async function loadStoreNames() {
  storeNameById.clear();
  if (pageRole === "manager" && managerScope.storeId) {
    const snap = await getDoc(doc(db, "stores", managerScope.storeId));
    if (snap.exists()) {
      const data = snap.data() || {};
      storeNameById.set(snap.id, data.name || snap.id);
    } else {
      storeNameById.set(managerScope.storeId, managerScope.storeId);
    }
    return;
  }

  const snap = await getDocs(collection(db, "stores"));
  snap.forEach((row) => {
    const data = row.data() || {};
    storeNameById.set(row.id, data.name || row.id);
  });
}

function buildTodayFeedQuery(fieldName = "date") {
  const constraints = [where(fieldName, "==", todayISO)];
  if (pageRole === "manager" && managerScope.storeId) {
    constraints.push(where("storeId", "==", managerScope.storeId));
  }
  return query(collection(db, "logbook_instances"), ...constraints);
}

function timestampKey(value) {
  if (!value) return "";
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (typeof value.seconds === "number") {
    return `${value.seconds}:${value.nanoseconds || 0}`;
  }
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return clean(value);
}

function reportableNotesKey(value) {
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    if (!item || typeof item !== "object") return clean(item);
    return `${clean(item.label)}::${clean(item.text || item.snippet || item.value)}`;
  }).join("|");
}

function buildInstanceSignature(instance) {
  return [
    clean(instance.id),
    clean(instance.templateId),
    clean(instance.templateName),
    clean(instance.storeId),
    clean(instance.department),
    clean(instance.status).toLowerCase(),
    clean(instance.date || instance.workDate),
    clean(instance.dueTime),
    clean(instance.dueAtIso),
    timestampKey(instance.createdAt),
    timestampKey(instance.updatedAt),
    timestampKey(instance.completedAt),
    timestampKey(instance.submittedAt),
    timestampKey(instance.reminderRequestedAt),
    clean(instance.reminderRequestedBy),
    String(Number(instance.exceptionCount || 0)),
    String(Boolean(instance.hasReportableNotes)),
    reportableNotesKey(instance.reportableNotes)
  ].join("||");
}

async function applyInstances(instances, options = {}) {
  const background = Boolean(options.background);
  const nextRows = [];
  const nextIds = new Set();

  for (let index = 0; index < instances.length; index += 1) {
    const instance = instances[index];
    const id = clean(instance.id);
    if (!id) continue;

    nextIds.add(id);
    const signature = buildInstanceSignature(instance);
    const cachedSignature = rowSignatureById.get(id);
    const cachedRow = rowCacheById.get(id);

    if (cachedSignature === signature && cachedRow) {
      nextRows.push(cachedRow);
      continue;
    }

    if (!background && index > 0 && index % 12 === 0) {
      setStatus(`Analysing ${index}/${instances.length}...`);
    }

    const enriched = await enrichRow(instance, index, instances.length);
    rowSignatureById.set(id, signature);
    rowCacheById.set(id, enriched);
    nextRows.push(enriched);
  }

  [...rowCacheById.keys()].forEach((id) => {
    if (nextIds.has(id)) return;
    rowCacheById.delete(id);
    rowSignatureById.delete(id);
  });

  rows = nextRows;
}

function stopLiveFeed() {
  if (typeof liveFeedUnsubscribe === "function") {
    liveFeedUnsubscribe();
  }
  liveFeedUnsubscribe = null;
}

async function enrichRow(instance, index, total) {
  if (index > 0 && index % 12 === 0) {
    setStatus(`Analysing ${index}/${total}...`);
  }

  const templateId = clean(instance.templateId);
  const dateKey = clean(instance.date) || todayISO;
  const needsTemplateMeta = !clean(instance.templateName) || !clean(instance.department);
  const template = needsTemplateMeta ? await getTemplateMeta(templateId) : {};
  const templateName = clean(instance.templateName || template.name || templateId) || "Logbook";
  const department = normalizeDepartmentValue(instance.department || template.department, "General");
  const workflowState = clean(instance.status).toLowerCase() || "not_started";
  const timer = describeTimerWindow({
    dueAtIso: clean(instance.dueAtIso),
    status: workflowState
  });

  let noteSummary = Array.isArray(instance.reportableNotes) ? instance.reportableNotes.filter(Boolean) : [];
  let exceptionCount = Number(instance.exceptionCount || 0);
  let exceptionItems = [];
  const needsEntryInspection = !noteSummary.length && exceptionCount <= 0;

  if (needsEntryInspection) {
    try {
      const entry = await loadEntryMeta({ instanceId: instance.id, templateId, dateKey });
      if (entry?.values && templateId) {
        const blocks = await getTemplateBlocks(templateId);
        noteSummary = collectReportableNotes(blocks, entry.values);
        exceptionItems = detectLogbookExceptions(blocks, entry.values, dateKey);
        exceptionCount = exceptionItems.length;
      }
    } catch (error) {
      console.warn("Failed to inspect monitoring detail", instance.id, error);
    }
  }

  if (!noteSummary.length && Array.isArray(instance.reportableNotes) && instance.reportableNotes.length) {
    noteSummary = instance.reportableNotes;
  }
  if (!exceptionItems.length && exceptionCount > 0) {
    exceptionItems = Array.from({ length: Math.min(exceptionCount, 3) }, (_, issueIndex) => ({
      label: `Issue ${issueIndex + 1}`,
      value: "Open the record for full detail"
    }));
  }

  const dueAt = parseTs(instance.dueAtIso);
  const createdAt = parseTs(instance.createdAt);
  const updatedAt = parseTs(instance.updatedAt);
  const completedAt = parseTs(instance.completedAt) || parseTs(instance.submittedAt);
  const reminderRequestedAt = parseTs(instance.reminderRequestedAt);
  const reminderRequestedBy = clean(instance.reminderRequestedBy);
  const noteCount = noteSummary.length;
  const hasTimer = Boolean(dueAt || clean(instance.dueTime));
  const attentionReasons = deriveAttentionReasons({
    timer,
    hasReminder: Boolean(reminderRequestedAt),
    noteCount,
    exceptionCount,
    hasTimer
  });
  const reasonKeys = attentionReasons.map((item) => item.key);
  const primaryReason = attentionReasons.find((item) => item.attention) || attentionReasons[0] || null;
  const needsAttention = attentionReasons.some((item) => item.attention);
  const severityScore = calculateSeverity({
    workflowState,
    timer,
    hasReminder: Boolean(reminderRequestedAt),
    noteCount,
    exceptionCount,
    hasTimer
  });
  const severityTone = getSeverityTone(severityScore);
  const lastActivityAt = maxDate([reminderRequestedAt, completedAt, updatedAt, createdAt]);

  return {
    id: instance.id,
    templateId,
    templateName,
    storeId: clean(instance.storeId),
    storeName: storeNameById.get(clean(instance.storeId)) || clean(instance.storeId) || "Unknown",
    department,
    workflowState,
    workflowLabel: getWorkflowLabel(workflowState),
    statusCategory: needsAttention ? "attention" : (workflowState === "completed" ? "completed" : (workflowState === "skipped" ? "skipped" : "outstanding")),
    timer,
    dueTime: clean(instance.dueTime),
    dueAt,
    hasTimer,
    reminderRequestedAt,
    reminderRequestedBy,
    noteSummary,
    noteCount,
    exceptionItems,
    exceptionCount,
    attentionReasons,
    reasonKeys,
    primaryReason,
    needsAttention,
    severityScore,
    severityTone,
    severityLabel: getSeverityLabel(severityTone),
    createdAt,
    updatedAt,
    completedAt,
    lastActivityAt,
    date: dateKey
  };
}

function populateFilters() {
  const stores = [...new Set(rows.map((row) => row.storeId).filter(Boolean))]
    .sort((a, b) => compareText(storeNameById.get(a) || a, storeNameById.get(b) || b))
    .map((storeId) => ({ value: storeId, label: `${storeNameById.get(storeId) || storeId} (${storeId})` }));

  const departments = [...new Set(rows.map((row) => row.department).filter(Boolean))]
    .sort(compareText)
    .map((department) => ({ value: department, label: department }));

  setSelectOptions(storeFilter, stores, "All stores");
  setSelectOptions(departmentFilter, departments, "All departments");

  if (managerScope.storeId) {
    storeFilter.value = managerScope.storeId;
    storeFilter.disabled = true;
  } else if (storeFilter) {
    storeFilter.disabled = false;
  }

  if (managerScope.department) {
    departmentFilter.value = managerScope.department;
    departmentFilter.disabled = true;
  } else if (departmentFilter) {
    departmentFilter.disabled = false;
  }

  if (!initialSelectionsApplied) {
    setSelectValueIfValid(storeFilter, params.get("store"));
    setSelectValueIfValid(departmentFilter, params.get("department"));
    initialSelectionsApplied = true;
  }
}

function buildSearchHaystack(row) {
  return [
    row.storeName,
    row.storeId,
    row.department,
    row.templateName,
    row.workflowLabel,
    row.dueTime,
    row.timer.text,
    row.reminderRequestedBy,
    ...row.attentionReasons.map((item) => item.label),
    ...row.noteSummary.map((note) => note.label || ""),
    ...row.noteSummary.map((note) => note.text || note.snippet || ""),
    ...row.exceptionItems.map((issue) => issue.label || ""),
    ...row.exceptionItems.map((issue) => issue.value || "")
  ].join(" ").toLowerCase();
}

function getScopeRows() {
  const store = clean(storeFilter?.value);
  const department = clean(departmentFilter?.value);
  const queryText = clean(searchBox?.value).toLowerCase();

  return rows.filter((row) => {
    if (managerScope.storeId && row.storeId !== managerScope.storeId) return false;
    if (managerScope.department && row.department !== managerScope.department) return false;
    if (store && row.storeId !== store) return false;
    if (department && row.department !== department) return false;
    if (queryText && !buildSearchHaystack(row).includes(queryText)) return false;
    return true;
  });
}

function matchesStatusFilter(row, status) {
  const next = clean(status).toLowerCase();
  if (!next) return true;
  if (next === "attention") return row.needsAttention;
  if (next === "completed") return row.workflowState === "completed";
  if (next === "outstanding") return row.workflowState !== "completed" && row.workflowState !== "skipped";
  if (next === "in_progress") return row.workflowState === "in_progress";
  if (next === "not_started") return row.workflowState === "not_started";
  if (next === "skipped") return row.workflowState === "skipped";
  return true;
}

function matchesReasonFilter(row, reason) {
  const next = clean(reason).toLowerCase();
  if (!next) return true;
  if (next === "clean") return !row.needsAttention && !hasReason(row, "no_timer");
  return hasReason(row, next);
}

function sortRows(items) {
  const sortKey = clean(sortFilter?.value) || "priority";
  const next = [...items];

  next.sort((a, b) => {
    if (sortKey === "due") {
      const dueCompare = compareNullableDatesAsc(a.dueAt, b.dueAt);
      if (dueCompare !== 0) return dueCompare;
      if (a.dueAt && !b.dueAt) return -1;
      if (!a.dueAt && b.dueAt) return 1;
      if (b.severityScore !== a.severityScore) return b.severityScore - a.severityScore;
      return compareText(a.templateName, b.templateName);
    }

    if (sortKey === "updated") {
      const activityCompare = compareNullableDatesDesc(a.lastActivityAt, b.lastActivityAt);
      if (activityCompare !== 0) return activityCompare;
      return compareText(a.templateName, b.templateName);
    }

    if (sortKey === "alphabetical") {
      const storeCompare = compareText(a.storeName, b.storeName);
      if (storeCompare !== 0) return storeCompare;
      const departmentCompare = compareText(a.department, b.department);
      if (departmentCompare !== 0) return departmentCompare;
      return compareText(a.templateName, b.templateName);
    }

    if (b.severityScore !== a.severityScore) return b.severityScore - a.severityScore;
    const dueCompare = compareNullableDatesAsc(a.dueAt, b.dueAt);
    if (dueCompare !== 0) return dueCompare;
    const activityCompare = compareNullableDatesDesc(a.lastActivityAt, b.lastActivityAt);
    if (activityCompare !== 0) return activityCompare;
    return compareText(a.templateName, b.templateName);
  });

  return next;
}

function getFilteredRows(baseRows) {
  const workflow = clean(statusFilter?.value);
  const reason = clean(attentionFilter?.value);
  return sortRows(baseRows.filter((row) => matchesStatusFilter(row, workflow) && matchesReasonFilter(row, reason)));
}

function getActiveSummaryKey() {
  const workflow = clean(statusFilter?.value);
  const reason = clean(attentionFilter?.value);
  if (workflow === "attention" && !reason) return "attention";
  if (workflow === "completed" && !reason) return "completed";
  if (!workflow && ["overdue", "urgent", "reminder", "note", "exception", "no_timer"].includes(reason)) {
    return reason;
  }
  return "";
}

function renderSummaryCards(scopeRows) {
  if (!summaryCardsEl) return;
  const activeKey = getActiveSummaryKey();
  summaryCardsEl.innerHTML = "";

  SUMMARY_DEFS.forEach((def) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `summary-card${activeKey === def.key ? " active" : ""}`;
    button.dataset.tone = def.tone;
    button.innerHTML = `
      <strong>${escapeHtml(def.label)}</strong>
      <span class="summary-card-count">${def.count(scopeRows)}</span>
      <span class="summary-card-note">${escapeHtml(def.note)}</span>
    `;
    button.addEventListener("click", () => {
      if (def.key === "attention") {
        statusFilter.value = "attention";
        attentionFilter.value = "";
      } else if (def.key === "completed") {
        statusFilter.value = "completed";
        attentionFilter.value = "";
      } else {
        statusFilter.value = "";
        attentionFilter.value = def.key;
      }
      renderDashboard();
    });
    summaryCardsEl.appendChild(button);
  });
}

function renderActiveFilters(scopeRows, filteredRows) {
  if (!activeFiltersEl) return;
  const chips = [];

  if (managerScope.storeId) chips.push(`Locked store: ${managerScope.storeId}`);
  else if (clean(storeFilter?.value)) chips.push(`Store: ${getSelectedLabel(storeFilter)}`);

  if (managerScope.department) chips.push(`Locked department: ${managerScope.department}`);
  else if (clean(departmentFilter?.value)) chips.push(`Department: ${getSelectedLabel(departmentFilter)}`);

  if (clean(statusFilter?.value)) chips.push(`Workflow: ${getSelectedLabel(statusFilter)}`);
  if (clean(attentionFilter?.value)) chips.push(`Attention: ${getSelectedLabel(attentionFilter)}`);
  if (clean(groupByFilter?.value) && clean(groupByFilter?.value) !== getDefaultGroupBy()) chips.push(`Grouped: ${getSelectedLabel(groupByFilter)}`);
  if (clean(sortFilter?.value) && clean(sortFilter?.value) !== "priority") chips.push(`Sorted: ${getSelectedLabel(sortFilter)}`);
  if (clean(searchBox?.value)) chips.push(`Search: ${clean(searchBox.value)}`);

  if (!chips.length) {
    chips.push(scopeRows.length === filteredRows.length ? "No extra filters active" : "Base scope only");
  }

  activeFiltersEl.innerHTML = chips.map((chip) => `<span class="filter-chip">${escapeHtml(chip)}</span>`).join("");
}

function getGroupDescriptor(row, groupBy) {
  if (groupBy === "store") {
    return {
      key: `store:${row.storeId || "unknown"}`,
      label: row.storeName || row.storeId || "Unknown store",
      meta: row.storeId ? `Store ID ${row.storeId}` : "Store grouping"
    };
  }

  if (groupBy === "department") {
    return {
      key: `department:${row.department || "General"}`,
      label: row.department || "General",
      meta: row.storeId ? `${row.storeName} (${row.storeId})` : "Department grouping"
    };
  }

  if (groupBy === "attention") {
    const key = row.primaryReason?.key || (hasReason(row, "no_timer") ? "no_timer" : "clean");
    if (key === "clean") {
      return {
        key: "attention:clean",
        label: "Clean / routine",
        meta: "No active monitoring signals"
      };
    }
    const label = key === "urgent" ? "Due soon" : humanizeKey(key);
    return {
      key: `attention:${key}`,
      label,
      meta: "Primary monitoring signal"
    };
  }

  if (groupBy === "status") {
    return {
      key: `status:${row.workflowState}`,
      label: row.workflowLabel,
      meta: "Workflow state"
    };
  }

  return {
    key: "all",
    label: "All matching logbooks",
    meta: `${pluralize(rows.length, "logbook")}`
  };
}

function buildGroups(items) {
  const groupBy = clean(groupByFilter?.value) || getDefaultGroupBy();
  if (groupBy === "none") {
    return [{
      key: "all",
      label: "All matching logbooks",
      meta: `${pluralize(items.length, "logbook")}`,
      rows: items,
      attentionCount: items.filter((row) => row.needsAttention).length,
      overdueCount: items.filter((row) => hasReason(row, "overdue")).length,
      maxSeverity: Math.max(0, ...items.map((row) => row.severityScore))
    }];
  }

  const buckets = new Map();
  items.forEach((row) => {
    const descriptor = getGroupDescriptor(row, groupBy);
    if (!buckets.has(descriptor.key)) {
      buckets.set(descriptor.key, { ...descriptor, rows: [] });
    }
    buckets.get(descriptor.key).rows.push(row);
  });

  const groups = [...buckets.values()].map((group) => ({
    ...group,
    rows: group.rows,
    attentionCount: group.rows.filter((row) => row.needsAttention).length,
    overdueCount: group.rows.filter((row) => hasReason(row, "overdue")).length,
    maxSeverity: Math.max(0, ...group.rows.map((row) => row.severityScore))
  }));

  groups.sort((a, b) => {
    if (groupBy === "attention") {
      const aKey = a.key.split(":")[1] || "clean";
      const bKey = b.key.split(":")[1] || "clean";
      return (ATTENTION_GROUP_ORDER[aKey] ?? 99) - (ATTENTION_GROUP_ORDER[bKey] ?? 99);
    }
    if (groupBy === "status") {
      const aKey = a.key.split(":")[1] || "not_started";
      const bKey = b.key.split(":")[1] || "not_started";
      return (WORKFLOW_GROUP_ORDER[aKey] ?? 99) - (WORKFLOW_GROUP_ORDER[bKey] ?? 99);
    }
    if (b.maxSeverity !== a.maxSeverity) return b.maxSeverity - a.maxSeverity;
    return compareText(a.label, b.label);
  });

  return groups;
}

function getWorkflowSummary(row) {
  if (row.workflowState === "completed") {
    return {
      value: "Completed",
      note: row.completedAt ? `Submitted ${formatDateTime(row.completedAt)}` : "Marked complete today"
    };
  }
  if (row.workflowState === "in_progress") {
    return {
      value: "In progress",
      note: row.lastActivityAt ? `Last activity ${formatRelative(row.lastActivityAt)}` : "No recent activity"
    };
  }
  if (row.workflowState === "skipped") {
    return {
      value: "Skipped",
      note: "Excluded from today's completion flow"
    };
  }
  return {
    value: "Not started",
    note: row.lastActivityAt ? `Last activity ${formatRelative(row.lastActivityAt)}` : "No activity yet"
  };
}

function getTimerSummary(row) {
  if (!row.hasTimer) {
    return {
      value: "No timer",
      note: "No due time is assigned to this logbook"
    };
  }
  const dueLabel = row.dueTime ? `Due ${row.dueTime}` : `Due ${formatClock(row.dueAt)}`;
  return {
    value: dueLabel,
    note: row.timer.text || "Timer is active"
  };
}

function getReminderSummary(row) {
  if (!row.reminderRequestedAt) {
    return {
      value: "No reminder",
      note: "Staff have not requested a reminder"
    };
  }
  const note = row.reminderRequestedBy
    ? `${formatDateTime(row.reminderRequestedAt)} by ${row.reminderRequestedBy}`
    : formatDateTime(row.reminderRequestedAt);
  return {
    value: "Requested",
    note
  };
}

function getMonitoringSummary(row) {
  const parts = [];
  if (row.exceptionCount) parts.push(pluralize(row.exceptionCount, "exception"));
  if (row.noteCount) parts.push(pluralize(row.noteCount, "staff note", "staff notes"));
  if (row.reminderRequestedAt) parts.push("reminder");
  if (hasReason(row, "no_timer")) parts.push("no timer");

  if (!parts.length) {
    return {
      value: "Clean",
      note: "No active notes, exceptions, or reminders"
    };
  }

  return {
    value: parts.slice(0, 2).join(", "),
    note: row.primaryReason?.label || "Needs review"
  };
}

function renderNoteList(row) {
  if (!row.noteSummary.length) {
    return `<div class="muted-note">No reportable staff notes for this logbook today.</div>`;
  }
  return `
    <ul class="detail-list">
      ${row.noteSummary.map((note) => `
        <li>
          <strong>${escapeHtml(note.label || "Note")}:</strong> ${escapeHtml(note.text || note.snippet || "")}
        </li>
      `).join("")}
    </ul>
  `;
}

function renderExceptionList(row) {
  if (!row.exceptionItems.length) {
    return `<div class="muted-note">No exceptions detected for this logbook today.</div>`;
  }
  return `
    <ul class="detail-list">
      ${row.exceptionItems.map((issue) => `
        <li>
          <strong>${escapeHtml(issue.label || "Issue")}:</strong> ${escapeHtml(issue.value || "Recorded")}
        </li>
      `).join("")}
    </ul>
  `;
}

function renderFactsList(row) {
  return `
    <ul class="detail-list">
      <li><strong>Store:</strong> ${escapeHtml(row.storeName)} (${escapeHtml(row.storeId || "Unknown")})</li>
      <li><strong>Department:</strong> ${escapeHtml(row.department || "General")}</li>
      <li><strong>Instance ID:</strong> ${escapeHtml(row.id)}</li>
      <li><strong>Timer state:</strong> ${escapeHtml(row.timer.text || "No timer")}</li>
    </ul>
  `;
}

function renderTimeline(row) {
  return `
    <div class="timeline">
      ${timelineItemMarkup("Created", row.createdAt ? formatDateTime(row.createdAt) : "Unknown")}
      ${timelineItemMarkup("Last activity", row.lastActivityAt ? `${formatDateTime(row.lastActivityAt)} (${formatRelative(row.lastActivityAt)})` : "No activity yet")}
      ${timelineItemMarkup("Reminder", row.reminderRequestedAt ? `${formatDateTime(row.reminderRequestedAt)}${row.reminderRequestedBy ? ` by ${row.reminderRequestedBy}` : ""}` : "No reminder requested")}
      ${timelineItemMarkup("Submitted", row.completedAt ? formatDateTime(row.completedAt) : "Not submitted")}
    </div>
  `;
}

function renderRowCard(row) {
  const back = encodeURIComponent(buildBackUrl());
  const viewHref = pageRole === "manager"
    ? `view-record.html?instanceId=${encodeURIComponent(row.id)}&templateId=${encodeURIComponent(row.templateId)}&storeId=${encodeURIComponent(row.storeId)}&date=${encodeURIComponent(row.date)}&back=${back}`
    : `view-entry.html?instanceId=${encodeURIComponent(row.id)}&templateId=${encodeURIComponent(row.templateId)}&storeId=${encodeURIComponent(row.storeId)}&date=${encodeURIComponent(row.date)}&back=${back}`;
  const workflowSummary = getWorkflowSummary(row);
  const timerSummary = getTimerSummary(row);
  const reminderSummary = getReminderSummary(row);
  const monitoringSummary = getMonitoringSummary(row);
  const statusPills = [
    createPillMarkup(row.workflowLabel, getWorkflowTone(row.workflowState)),
    ...row.attentionReasons.map((item) => createPillMarkup(item.label, item.tone))
  ];
  if (!row.attentionReasons.length) {
    statusPills.push(createPillMarkup("Clean", "clean"));
  }

  return `
    <article class="monitor-card severity-${escapeHtml(row.severityTone)}">
      <div class="monitor-card-head">
        <div class="monitor-card-main">
          <div class="monitor-card-title">${escapeHtml(row.templateName)}</div>
          <div class="monitor-card-sub">
            <span>${escapeHtml(row.storeName)} (${escapeHtml(row.storeId || "Unknown")})</span>
            <span>${escapeHtml(row.department || "General")}</span>
            <span>${escapeHtml(row.id)}</span>
          </div>
          <div class="pill-row">${statusPills.join("")}</div>
          <div class="summary-line">
            ${summaryBoxMarkup("Workflow", workflowSummary.value, workflowSummary.note)}
            ${summaryBoxMarkup("Timer", timerSummary.value, timerSummary.note)}
            ${summaryBoxMarkup("Reminder", reminderSummary.value, reminderSummary.note)}
            ${summaryBoxMarkup("Monitoring", monitoringSummary.value, monitoringSummary.note)}
          </div>
          <details class="monitor-details"${expandedIds.has(row.id) ? " open" : ""} data-row-id="${escapeHtml(row.id)}">
            <summary>View monitoring detail</summary>
            <div class="monitor-details-grid">
              <div class="detail-card">
                <h3>Timeline</h3>
                ${renderTimeline(row)}
              </div>
              <div class="detail-card">
                <h3>Staff Notes</h3>
                ${renderNoteList(row)}
              </div>
              <div class="detail-card">
                <h3>Exceptions</h3>
                ${renderExceptionList(row)}
              </div>
              <div class="detail-card">
                <h3>Quick Facts</h3>
                ${renderFactsList(row)}
              </div>
            </div>
          </details>
        </div>
        <div class="monitor-card-side">
          ${createPillMarkup(row.severityLabel, getSeverityPillTone(row.severityTone))}
          <div class="meta">${escapeHtml(row.lastActivityAt ? `Last activity ${formatRelative(row.lastActivityAt)}` : "No activity recorded yet")}</div>
          <div class="card-actions">
            <a class="btn" href="${escapeHtml(viewHref)}">Open record</a>
          </div>
        </div>
      </div>
    </article>
  `;
}

function attachDetailListeners() {
  if (!resultsEl) return;
  resultsEl.querySelectorAll("details[data-row-id]").forEach((detailsEl) => {
    detailsEl.addEventListener("toggle", () => {
      const rowId = clean(detailsEl.getAttribute("data-row-id"));
      if (!rowId) return;
      if (detailsEl.open) expandedIds.add(rowId);
      else expandedIds.delete(rowId);
    });
  });
}

function renderResults(filteredRows) {
  if (!resultsEl) return;
  if (!filteredRows.length) {
    resultsEl.innerHTML = `
      <div class="queue-empty">
        No logbooks match the current monitoring view for ${escapeHtml(todayISO)}.
      </div>
    `;
    return;
  }

  const groups = buildGroups(filteredRows);
  resultsEl.innerHTML = groups.map((group) => `
    <section class="monitor-group">
      <div class="group-head">
        <div>
          <div class="group-title">${escapeHtml(group.label)}</div>
          <div class="meta">${escapeHtml(group.meta)}</div>
        </div>
        <div class="group-stats">
          ${createPillMarkup(pluralize(group.rows.length, "logbook"), "neutral")}
          ${group.attentionCount ? createPillMarkup(pluralize(group.attentionCount, "attention item", "attention items"), "flagged") : createPillMarkup("No active alerts", "clean")}
          ${group.overdueCount ? createPillMarkup(pluralize(group.overdueCount, "overdue item", "overdue items"), "overdue") : ""}
        </div>
      </div>
      <div class="group-body">
        ${group.rows.map((row) => renderRowCard(row)).join("")}
      </div>
    </section>
  `).join("");

  attachDetailListeners();
}

function renderDashboard() {
  const scopeRows = getScopeRows();
  const filteredRows = getFilteredRows(scopeRows);
  const groupValue = clean(groupByFilter?.value) || getDefaultGroupBy();
  const sortValue = clean(sortFilter?.value) || "priority";

  renderSummaryCards(scopeRows);
  renderActiveFilters(scopeRows, filteredRows);
  renderResults(filteredRows);

  if (summaryMetaEl) {
    summaryMetaEl.textContent = scopeRows.length
      ? `${pluralize(scopeRows.length, "logbook")} in the current scope. Click a tile to focus the queue.`
      : `No logbooks were found for ${todayISO} in the current scope.`;
  }

  if (resultsMetaEl) {
    resultsMetaEl.textContent = filteredRows.length
      ? `${pluralize(filteredRows.length, "matching logbook")} grouped by ${groupValue === "none" ? "none" : groupValue} and sorted by ${sortValue}.`
      : "No matching logbooks after the current workflow, attention, and search filters.";
  }

  if (visibleCountEl) {
    visibleCountEl.textContent = String(filteredRows.length);
  }

  syncUrlState();
}

function seedStaticFiltersFromQuery() {
  setSelectValueIfValid(statusFilter, normaliseStatusParam(params.get("status")));
  setSelectValueIfValid(attentionFilter, clean(params.get("reason")).toLowerCase());
  setSelectValueIfValid(groupByFilter, clean(params.get("group")).toLowerCase(), getDefaultGroupBy());
  setSelectValueIfValid(sortFilter, clean(params.get("sort")).toLowerCase(), "priority");
  if (groupByFilter && !clean(groupByFilter.value)) groupByFilter.value = getDefaultGroupBy();
  if (sortFilter && !clean(sortFilter.value)) sortFilter.value = "priority";
  if (searchBox && params.get("q")) searchBox.value = params.get("q");
}

function updateRefreshStamp() {
  if (!updatedAtEl || !lastLoadedAt) return;
  updatedAtEl.textContent = `${formatDateTime(lastLoadedAt)} (${formatRelative(lastLoadedAt)})`;
}

function clearFilters() {
  if (storeFilter && !managerScope.storeId) storeFilter.value = "";
  if (departmentFilter && !managerScope.department) departmentFilter.value = "";
  if (statusFilter) statusFilter.value = "";
  if (attentionFilter) attentionFilter.value = "";
  if (groupByFilter) groupByFilter.value = getDefaultGroupBy();
  if (sortFilter) sortFilter.value = "priority";
  if (searchBox) searchBox.value = "";
  renderDashboard();
}

async function startLiveFeed(options = {}) {
  const background = Boolean(options.background);
  const fieldName = clean(options.fieldName) || "date";
  const generation = ++liveFeedGeneration;

  stopLiveFeed();
  if (!background) setStatus("Loading monitoring...");

  await resolveScope();
  if (pageRole === "manager" && !managerScopeReady) {
    rows = [];
    if (resultsEl) {
      resultsEl.innerHTML = `<div class="queue-empty">Manager scope could not be resolved, so today's monitoring cannot be shown.</div>`;
    }
    if (visibleCountEl) visibleCountEl.textContent = "0";
    setStatus("Scope unavailable", "error");
    return;
  }

  await loadStoreNames();

  const liveQuery = buildTodayFeedQuery(fieldName);
  liveFeedUnsubscribe = onSnapshot(liveQuery, async (snapshot) => {
    if (generation !== liveFeedGeneration) return;

    const instances = snapshot.docs.map((row) => ({ id: row.id, ...row.data() }));
    if (!instances.length && fieldName === "date") {
      await startLiveFeed({ background, fieldName: "workDate" });
      return;
    }

    await applyInstances(instances, { background });
    populateFilters();
    renderDashboard();
    lastLoadedAt = new Date();
    updateRefreshStamp();
    setStatus(`Monitoring updated (${todayISO})`, "success");
  }, async (error) => {
    if (generation !== liveFeedGeneration) return;
    if (fieldName === "date") {
      console.warn("Failed monitoring query by 'date'.", error);
      await startLiveFeed({ background, fieldName: "workDate" });
      return;
    }

    console.error(error);
    setStatus("Monitoring failed", "error");
    if (resultsEl) {
      resultsEl.innerHTML = `<div class="queue-empty">Failed to load today's monitoring view.</div>`;
    }
  });
}

if (refreshBtn) {
  refreshBtn.addEventListener("click", () => {
    void startLiveFeed({ fieldName: "date" });
  });
}

[storeFilter, departmentFilter, statusFilter, attentionFilter, groupByFilter, sortFilter].forEach((control) => {
  if (!control) return;
  control.addEventListener("change", () => {
    renderDashboard();
  });
});

if (searchBox) {
  searchBox.addEventListener("input", () => {
    renderDashboard();
  });
}

if (clearFiltersBtn) {
  clearFiltersBtn.addEventListener("click", () => {
    clearFilters();
  });
}

seedStaticFiltersFromQuery();
startLiveFeed({ fieldName: "date" }).catch((error) => {
  console.error(error);
  setStatus("Monitoring failed", "error");
  if (resultsEl) {
    resultsEl.innerHTML = `<div class="queue-empty">Failed to load today's monitoring view.</div>`;
  }
});
