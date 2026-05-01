import { db } from "../shared/logbook-app.js";
import { collection, getCountFromServer, getDocs, query, where } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { logLoginActivityOncePerSession } from "../shared/activity-log.js";
import { getBusinessDateISO } from "../shared/business-time.js";
import { buildMissingIndexError } from "../shared/firestore-query.js";
import { resolveManagerScopeOrThrow } from "../shared/manager-scope.js";
import { waitForPageGuard } from "../shared/page-guard.js";
await waitForPageGuard();

const todayISO = getBusinessDateISO();

const statusEl = document.getElementById("dashboardStatus");
const refreshSummaryBtn = document.getElementById("refreshSummaryBtn");
const scopeLabelEl = document.getElementById("scopeLabel");
const savedRecordsCard = document.getElementById("savedRecordsCard");
const activityLogCard = document.getElementById("activityLogCard");
const unlockRecordsCard = document.getElementById("unlockRecordsCard");
const todayMonitoringCard = document.getElementById("todayMonitoringCard");
const assignTimersCard = document.getElementById("assignTimersCard");

const todayEntriesEl = document.getElementById("summaryTodayEntries");
const completedEl = document.getElementById("summaryCompleted");
const outstandingEl = document.getElementById("summaryOutstanding");
const flaggedEl = document.getElementById("summaryFlagged");
const summaryTodayCard = document.getElementById("summaryTodayCard");
const summaryCompletedCard = document.getElementById("summaryCompletedCard");
const summaryOutstandingCard = document.getElementById("summaryOutstandingCard");
const summaryFlaggedCard = document.getElementById("summaryFlaggedCard");

const scope = {
  storeId: "",
  department: ""
};
let managerScopeReady = true;

function matchesDepartmentScope(entry) {
  if (!scope.department) return true;
  const department = String(entry?.department || entry?.dept || "").trim();
  if (!department) return true;
  return department === scope.department;
}

function setStatus(text, kind = "info") {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.remove("success", "error");
  if (kind === "success") statusEl.classList.add("success");
  if (kind === "error") statusEl.classList.add("error");
}

function setCard(el, value) {
  if (!el) return;
  el.textContent = String(value);
}

function updateScopeLabel() {
  if (!scopeLabelEl) return;

  if (!managerScopeReady) {
    scopeLabelEl.textContent = "Manager scope: unavailable";
    return;
  }

  if (!scope.storeId && !scope.department) {
    scopeLabelEl.textContent = "Manager scope: all assigned stores";
    return;
  }

  const bits = [];
  if (scope.storeId) bits.push(`Store: ${scope.storeId}`);
  if (scope.department) bits.push(`Department: ${scope.department}`);
  scopeLabelEl.textContent = `Manager scope: ${bits.join(" | ")}`;
}

function updateActionLinks() {
  if (!savedRecordsCard && !activityLogCard && !unlockRecordsCard && !todayMonitoringCard && !assignTimersCard) return;

  if (!managerScopeReady) {
    if (savedRecordsCard) savedRecordsCard.href = "#";
    if (activityLogCard) activityLogCard.href = "#";
    if (unlockRecordsCard) unlockRecordsCard.href = "#";
    if (todayMonitoringCard) todayMonitoringCard.href = "#";
    if (assignTimersCard) assignTimersCard.href = "#";
    return;
  }

  const params = new URLSearchParams();
  if (scope.storeId) params.set("store", scope.storeId);
  if (scope.department) params.set("department", scope.department);

  const suffix = params.toString();
  const savedHref = suffix ? `compliance-records.html?${suffix}` : "compliance-records.html";
  const activityHref = suffix ? `activity-log.html?${suffix}` : "activity-log.html";
  const unlockHref = suffix ? `unlock-records.html?${suffix}` : "unlock-records.html";
  const monitoringHref = suffix ? `today-monitoring.html?${suffix}` : "today-monitoring.html";
  const timersHref = suffix ? `assign-timers.html?${suffix}` : "assign-timers.html";
  if (savedRecordsCard) savedRecordsCard.href = savedHref;
  if (activityLogCard) activityLogCard.href = activityHref;
  if (unlockRecordsCard) unlockRecordsCard.href = unlockHref;
  if (todayMonitoringCard) todayMonitoringCard.href = monitoringHref;
  if (assignTimersCard) assignTimersCard.href = timersHref;
}

async function resolveScope() {
  try {
    const resolved = await resolveManagerScopeOrThrow();
    scope.storeId = resolved.storeId;
    scope.department = resolved.department;
    managerScopeReady = true;
  } catch (error) {
    managerScopeReady = false;
    scope.storeId = "";
    scope.department = "";
    console.warn("Failed to resolve manager scope", error);
  }

  updateScopeLabel();
  updateActionLinks();
}

async function getTodayInstances() {
  if (!managerScopeReady) {
    throw new Error("Manager scope could not be resolved. Try signing out and back in.");
  }

  const colRef = collection(db, "logbook_instances");
  const byId = new Map();

  const dateConstraints = [where("date", "==", todayISO)];
  if (scope.storeId) dateConstraints.push(where("storeId", "==", scope.storeId));

  try {
    const snap = await getDocs(query(colRef, ...dateConstraints));
    snap.forEach((docSnap) => byId.set(docSnap.id, { id: docSnap.id, ...docSnap.data() }));
  } catch (error) {
    console.warn("Failed query by 'date'.", error);
  }

  if (byId.size === 0) {
    const workConstraints = [where("workDate", "==", todayISO)];
    if (scope.storeId) workConstraints.push(where("storeId", "==", scope.storeId));
    try {
      const snap = await getDocs(query(colRef, ...workConstraints));
      snap.forEach((docSnap) => byId.set(docSnap.id, { id: docSnap.id, ...docSnap.data() }));
    } catch (error) {
      throw buildMissingIndexError("Manager dashboard summary", error, "Failed to load summary.");
    }
  }

  return [...byId.values()].filter((entry) => matchesDepartmentScope(entry));
}

async function getTodayCount(fieldName, extraConstraints = []) {
  if (!managerScopeReady) {
    throw new Error("Manager scope could not be resolved. Try signing out and back in.");
  }

  const constraints = [where(fieldName, "==", todayISO), ...extraConstraints];
  if (scope.storeId) constraints.push(where("storeId", "==", scope.storeId));
  const snapshot = await getCountFromServer(query(collection(db, "logbook_instances"), ...constraints));
  return snapshot.data().count || 0;
}

async function getTodaySummaryCounts() {
  try {
    const [todayEntries, completedCount] = await Promise.all([
      getTodayCount("date"),
      getTodayCount("date", [where("status", "==", "completed")])
    ]);
    if (todayEntries > 0 || completedCount > 0) {
      return { todayEntries, completedCount };
    }
  } catch (error) {
    console.warn("Failed manager count query by 'date'.", error);
  }

  try {
    const [todayEntries, completedCount] = await Promise.all([
      getTodayCount("workDate"),
      getTodayCount("workDate", [where("status", "==", "completed")])
    ]);
    return { todayEntries, completedCount };
  } catch (error) {
    throw buildMissingIndexError("Manager dashboard summary", error, "Failed to load summary.");
  }
}

async function loadSummaryCards() {
  if (refreshSummaryBtn) refreshSummaryBtn.disabled = true;
  setStatus("Loading summary...");

  try {
    const [summaryCounts, todayEntries] = await Promise.all([
      getTodaySummaryCounts(),
      getTodayInstances()
    ]);
    const completedCount = summaryCounts.completedCount;
    const flaggedCount = todayEntries.filter((entry) => {
      const status = String(entry.status || "").toLowerCase();
      return status === "flagged" || Number(entry.exceptionCount || 0) > 0 || Boolean(entry.hasReportableNotes) || Boolean(entry.reminderRequestedAt);
    }).length;
    const outstandingCount = Math.max(0, summaryCounts.todayEntries - completedCount);

    setCard(todayEntriesEl, summaryCounts.todayEntries);
    setCard(completedEl, completedCount);
    setCard(outstandingEl, outstandingCount);
    setCard(flaggedEl, flaggedCount);
    setStatus(`Summary updated (${todayISO})`, "success");
  } catch (error) {
    console.error(error);
    setCard(todayEntriesEl, "-");
    setCard(completedEl, "-");
    setCard(outstandingEl, "-");
    setCard(flaggedEl, "-");
    setStatus("Summary failed to load", "error");
  } finally {
    if (refreshSummaryBtn) refreshSummaryBtn.disabled = false;
  }
}

async function init() {
  await resolveScope();
  await logLoginActivityOncePerSession({
    section: "Manager Dashboard",
    summary: "Signed in to Manager dashboard"
  });
  await loadSummaryCards();
}

if (refreshSummaryBtn) refreshSummaryBtn.addEventListener("click", loadSummaryCards);

if (summaryTodayCard) summaryTodayCard.addEventListener("click", () => {
  const params = new URLSearchParams();
  if (scope.storeId) params.set("store", scope.storeId);
  if (scope.department) params.set("department", scope.department);
  window.location.href = params.toString() ? `today-monitoring.html?${params}` : "today-monitoring.html";
});

if (summaryCompletedCard) summaryCompletedCard.addEventListener("click", () => {
  const params = new URLSearchParams();
  params.set("status", "completed");
  if (scope.storeId) params.set("store", scope.storeId);
  if (scope.department) params.set("department", scope.department);
  window.location.href = `today-monitoring.html?${params}`;
});

if (summaryOutstandingCard) summaryOutstandingCard.addEventListener("click", () => {
  const params = new URLSearchParams();
  params.set("status", "outstanding");
  if (scope.storeId) params.set("store", scope.storeId);
  if (scope.department) params.set("department", scope.department);
  window.location.href = `today-monitoring.html?${params}`;
});

if (summaryFlaggedCard) summaryFlaggedCard.addEventListener("click", () => {
  const params = new URLSearchParams();
  params.set("status", "flagged");
  if (scope.storeId) params.set("store", scope.storeId);
  if (scope.department) params.set("department", scope.department);
  window.location.href = `today-monitoring.html?${params}`;
});

init();
