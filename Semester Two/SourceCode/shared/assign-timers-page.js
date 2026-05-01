import { db } from "./logbook-app.js";
import { collection, doc, getDoc, getDocs, query, setDoc, where } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { auth } from "./auth.js";
import { writeUserActivity } from "./activity-log.js";
import { getBusinessDateISO } from "./business-time.js";
import { saveDepartmentTimerRule, loadDepartmentTimerRule, buildTimerFields } from "./department-timers.js";
import { normalizeDepartmentValue } from "./logbook-runtime.js";
import { resolveManagerScopeOrThrow } from "./manager-scope.js";
import { waitForPageGuard } from "./page-guard.js";
await waitForPageGuard();

const pageRole = document.body.dataset.role || "admin";
const todayISO = getBusinessDateISO();

const statusEl = document.getElementById("status");
const scopeLine = document.getElementById("scopeLine");
const storeSelect = document.getElementById("storeSelect");
const departmentSelect = document.getElementById("departmentSelect");
const timeInput = document.getElementById("timeInput");
const saveBtn = document.getElementById("saveBtn");
const clearBtn = document.getElementById("clearBtn");
const ruleList = document.getElementById("ruleList");

const managerScope = {
  storeId: "",
  department: ""
};
let managerScopeReady = true;

const assignmentMap = new Map();
const storeNameById = new Map();

function clean(value) {
  const text = String(value || "").trim();
  return text || "";
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
}

async function resolveScope() {
  if (pageRole !== "manager") {
    if (scopeLine) scopeLine.textContent = "Admin scope: all stores";
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
    scopeLine.textContent = bits.length ? `Manager scope: ${bits.join(" • ")}` : "Manager scope: all assigned stores";
  } catch (error) {
    console.warn("Failed to resolve manager scope", error);
    managerScopeReady = false;
    managerScope.storeId = "";
    managerScope.department = "";
    scopeLine.textContent = "Manager scope unavailable";
  }
}

async function loadAssignments() {
  assignmentMap.clear();
  storeNameById.clear();
  let rulesSnap = null;

  if (managerScope.storeId) {
    rulesSnap = await getDocs(query(collection(db, "store_template_rules"), where("storeId", "==", managerScope.storeId)));
    const storeSnap = await getDoc(doc(db, "stores", managerScope.storeId));
    if (storeSnap.exists()) {
      const data = storeSnap.data() || {};
      storeNameById.set(storeSnap.id, data.name || storeSnap.id);
    }
  } else {
    const [storeSnap, nextRulesSnap] = await Promise.all([
      getDocs(collection(db, "stores")),
      getDocs(collection(db, "store_template_rules"))
    ]);
    rulesSnap = nextRulesSnap;
    storeSnap.forEach((row) => {
      const data = row.data() || {};
      storeNameById.set(row.id, data.name || row.id);
    });
  }

  rulesSnap.forEach((row) => {
    const data = row.data() || {};
    const storeId = clean(data.storeId);
    if (!storeId) return;
    if (managerScope.storeId && storeId !== managerScope.storeId) return;

    const department = normalizeDepartmentValue(data.department, "General");
    if (managerScope.department && department !== managerScope.department) return;

    const current = assignmentMap.get(storeId) || new Set();
    current.add(department);
    assignmentMap.set(storeId, current);
  });
}

function populateStoreOptions() {
  const stores = [...assignmentMap.keys()]
    .sort((a, b) => (storeNameById.get(a) || a).localeCompare(storeNameById.get(b) || b))
    .map((storeId) => ({
      value: storeId,
      label: `${storeNameById.get(storeId) || storeId} (${storeId})`
    }));

  setSelectOptions(storeSelect, stores, "Select store…");
  if (managerScope.storeId && assignmentMap.has(managerScope.storeId)) {
    storeSelect.value = managerScope.storeId;
    storeSelect.disabled = true;
  }
}

async function populateDepartmentOptions() {
  const storeId = clean(storeSelect?.value);
  const departments = storeId && assignmentMap.has(storeId)
    ? [...assignmentMap.get(storeId)].sort((a, b) => a.localeCompare(b)).map((department) => ({
        value: department,
        label: department
      }))
    : [];

  setSelectOptions(departmentSelect, departments, "Select department…");

  if (managerScope.department && departments.some((item) => item.value === managerScope.department)) {
    departmentSelect.value = managerScope.department;
    departmentSelect.disabled = true;
  } else {
    departmentSelect.disabled = false;
  }

  if (departments.length === 1) {
    departmentSelect.value = departments[0].value;
  }

  await syncSelectedRule();
  await renderRuleList();
}

async function syncSelectedRule() {
  const storeId = clean(storeSelect?.value);
  const department = clean(departmentSelect?.value);
  if (!storeId || !department) {
    timeInput.value = "";
    return;
  }
  const rule = await loadDepartmentTimerRule(storeId, department);
  timeInput.value = clean(rule?.dueTime);
}

async function applyTimerToTodayInstances(storeId, department, dueTime) {
  const snap = await getDocs(query(
    collection(db, "logbook_instances"),
    where("date", "==", todayISO),
    where("storeId", "==", storeId)
  ));

  const nowIso = new Date().toISOString();
  const tasks = [];
  snap.forEach((row) => {
    const data = row.data() || {};
    if (clean(data.storeId) !== storeId) return;
    const rowDepartment = normalizeDepartmentValue(data.department, "General");
    if (rowDepartment !== department) return;

    tasks.push(setDoc(doc(db, "logbook_instances", row.id), {
      department,
      updatedAt: nowIso,
      ...buildTimerFields({
        dateKey: todayISO,
        dueTime,
        status: data.status || ""
      })
    }, { merge: true }));
  });

  await Promise.all(tasks);
}

async function saveRule({ clear = false } = {}) {
  const storeId = clean(storeSelect?.value);
  const department = clean(departmentSelect?.value);
  const dueTime = clear ? "" : clean(timeInput?.value);
  if (!storeId || !department) {
    setStatus("Choose a store and department first.", "error");
    return;
  }
  if (!clear && !dueTime) {
    setStatus("Choose a due time before saving.", "error");
    return;
  }

  const actionLabel = clear ? "Clearing" : "Saving";
  setStatus(`${actionLabel} timer…`);
  try {
    const updatedBy = auth.currentUser?.uid || auth.currentUser?.email || "unknown";
    await saveDepartmentTimerRule({
      storeId,
      department,
      dueTime,
      updatedBy,
      updatedAt: new Date().toISOString()
    });
    await applyTimerToTodayInstances(storeId, department, dueTime);
    await writeUserActivity({
      actionType: clear ? "cleared_timer_rule" : "updated_timer_rule",
      summary: clear
        ? `Cleared ${department} timer for ${storeId}`
        : `Set ${department} timer for ${storeId} to ${dueTime}`,
      storeId,
      department,
      section: "Department Timers",
      metadata: {
        dueTime: dueTime || null,
        role: pageRole
      }
    });
    setStatus(clear ? "Timer cleared" : "Timer saved", "success");
    await syncSelectedRule();
    await renderRuleList();
  } catch (error) {
    console.error(error);
    setStatus("Timer update failed", "error");
  }
}

async function renderRuleList() {
  const storeId = clean(storeSelect?.value);
  ruleList.replaceChildren();
  if (!storeId) {
    ruleList.innerHTML = `<div class="empty">Choose a store to manage timers.</div>`;
    return;
  }

  const departments = assignmentMap.has(storeId) ? [...assignmentMap.get(storeId)].sort((a, b) => a.localeCompare(b)) : [];
  if (!departments.length) {
    ruleList.innerHTML = `<div class="empty">No departments are assigned to this store yet.</div>`;
    return;
  }

  for (const department of departments) {
    const rule = await loadDepartmentTimerRule(storeId, department);
    const row = document.createElement("div");
    row.className = "rule-item";

    const left = document.createElement("div");
    left.className = "rule-left";
    const title = document.createElement("div");
    title.className = "rule-title";
    title.textContent = department;
    const sub = document.createElement("div");
    sub.className = "rule-meta";
    sub.textContent = clean(rule?.dueTime) ? `Daily due time: ${rule.dueTime}` : "No timer assigned";
    left.appendChild(title);
    left.appendChild(sub);

    const actions = document.createElement("div");
    actions.className = "rule-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn small";
    editBtn.textContent = clean(rule?.dueTime) ? "Edit" : "Assign";
    editBtn.addEventListener("click", async () => {
      departmentSelect.value = department;
      await syncSelectedRule();
      timeInput.focus();
    });
    actions.appendChild(editBtn);

    const clearAction = document.createElement("button");
    clearAction.type = "button";
    clearAction.className = "btn small";
    clearAction.disabled = !clean(rule?.dueTime);
    clearAction.textContent = "Clear";
    clearAction.addEventListener("click", async () => {
      departmentSelect.value = department;
      timeInput.value = "";
      await saveRule({ clear: true });
    });
    actions.appendChild(clearAction);

    row.appendChild(left);
    row.appendChild(actions);
    ruleList.appendChild(row);
  }
}

async function init() {
  await resolveScope();
  if (pageRole === "manager" && !managerScopeReady) {
    if (storeSelect) storeSelect.disabled = true;
    if (departmentSelect) departmentSelect.disabled = true;
    if (timeInput) timeInput.disabled = true;
    if (saveBtn) saveBtn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
    ruleList.innerHTML = `<div class="empty">Manager scope could not be resolved, so timer controls are unavailable.</div>`;
    setStatus("Scope unavailable", "error");
    return;
  }
  await loadAssignments();
  populateStoreOptions();

  if (!assignmentMap.size) {
    ruleList.innerHTML = `<div class="empty">No assigned departments are available to manage yet.</div>`;
    setStatus("No assignments", "error");
    return;
  }

  if (storeSelect && !storeSelect.value) {
    const firstStore = [...assignmentMap.keys()].sort()[0];
    if (firstStore) storeSelect.value = firstStore;
  }
  await populateDepartmentOptions();
  setStatus("Ready", "success");
}

if (storeSelect) {
  storeSelect.addEventListener("change", () => {
    void populateDepartmentOptions();
  });
}

if (departmentSelect) {
  departmentSelect.addEventListener("change", () => {
    void syncSelectedRule();
  });
}

if (saveBtn) saveBtn.addEventListener("click", () => void saveRule({ clear: false }));
if (clearBtn) clearBtn.addEventListener("click", () => void saveRule({ clear: true }));

init().catch((error) => {
  console.error(error);
  setStatus("Failed to load", "error");
  ruleList.innerHTML = `<div class="empty">Failed to load timer controls.</div>`;
});
