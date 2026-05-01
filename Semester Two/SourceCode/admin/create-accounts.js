import { adminCreateEmailAccount, adminCreateStaffAccount } from "../shared/auth.js";
import { db } from "../shared/logbook-app.js";
import { buildDepartmentSuggestions, buildStoreDirectoryLabel, canonicalDepartmentDirectoryValue, loadStoreDepartmentDirectory, renderDatalistOptions } from "../shared/store-department-directory.js";
import { waitForPageGuard } from "../shared/page-guard.js";
await waitForPageGuard();

const rootWrap = document.querySelector(".wrap");

const tabAdmin = document.getElementById("create-tab-admin");
const tabManager = document.getElementById("create-tab-manager");
const tabStaff = document.getElementById("create-tab-staff");

const panelAdmin = document.getElementById("create-panel-admin");
const panelManager = document.getElementById("create-panel-manager");
const panelStaff = document.getElementById("create-panel-staff");

const adminForm = document.getElementById("createAdminForm");
const adminName = document.getElementById("adminName");
const adminEmail = document.getElementById("adminEmail");
const adminPassword = document.getElementById("adminPassword");
const adminBtn = document.getElementById("adminCreateBtn");
const adminMessage = document.getElementById("adminMessage");

const managerForm = document.getElementById("createManagerForm");
const managerName = document.getElementById("managerName");
const managerEmail = document.getElementById("managerEmail");
const managerPassword = document.getElementById("managerPassword");
const managerStore = document.getElementById("managerStore");
const managerDepartment = document.getElementById("managerDepartment");
const managerDepartmentList = document.getElementById("managerDepartmentList");
const managerBtn = document.getElementById("managerCreateBtn");
const managerMessage = document.getElementById("managerMessage");

const staffForm = document.getElementById("createStaffForm");
const staffId = document.getElementById("staffId");
const staffName = document.getElementById("staffName");
const staffPin = document.getElementById("staffPin");
const staffStore = document.getElementById("staffStore");
const staffDepartment = document.getElementById("staffDepartment");
const staffDepartmentList = document.getElementById("staffDepartmentList");
const staffBtn = document.getElementById("staffCreateBtn");
const staffMessage = document.getElementById("staffMessage");

let directoryCache = {
  stores: [],
  departmentsByStore: new Map(),
  allDepartments: []
};

function showMessage(el, message, type) {
  if (!el) return;
  el.textContent = message;
  el.className = `message ${type}`;
}

function clearMessages() {
  [adminMessage, managerMessage, staffMessage].filter(Boolean).forEach((el) => {
    el.textContent = "";
    el.className = "message";
  });
}

function toFriendlyError(error) {
  const code = String(error?.code || "");
  const msg = String(error?.message || "");

  if (code === "functions/permission-denied") return "Permission denied.";
  if (code === "functions/already-exists") return msg || "Already exists.";
  if (code === "functions/invalid-argument") return msg || "Invalid input.";
  if (code === "functions/internal" && msg.trim().toLowerCase() === "internal") {
    return "Server blocked (Cloud Run invoker). Ask for Cloud Run IAM to allow unauthenticated invocation, then delete + redeploy Functions.";
  }
  return msg || "Request failed.";
}

function setPanel(which) {
  const isAdmin = which === "admin";
  const isManager = which === "manager";
  const isStaff = which === "staff";

  if (tabAdmin) tabAdmin.setAttribute("aria-selected", isAdmin ? "true" : "false");
  if (tabManager) tabManager.setAttribute("aria-selected", isManager ? "true" : "false");
  if (tabStaff) tabStaff.setAttribute("aria-selected", isStaff ? "true" : "false");

  if (panelAdmin) panelAdmin.classList.toggle("active", isAdmin);
  if (panelManager) panelManager.classList.toggle("active", isManager);
  if (panelStaff) panelStaff.classList.toggle("active", isStaff);

  clearMessages();

  if (isAdmin && adminEmail) adminEmail.focus();
  if (isManager && managerEmail) managerEmail.focus();
  if (isStaff && staffId) staffId.focus();
}

function setLoading(isLoading) {
  if (!rootWrap) return;
  rootWrap.classList.toggle("loading", isLoading);

  const controls = rootWrap.querySelectorAll("input, button, select, textarea");
  controls.forEach((el) => {
    if (isLoading) {
      el.dataset.wasDisabled = el.disabled ? "1" : "0";
      el.disabled = true;
      return;
    }
    if (el.dataset.wasDisabled === "1") return;
    el.disabled = false;
  });
}

function sanitizePin(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 4);
}

function fillStoreSelect(selectEl) {
  if (!selectEl) return;
  const previous = String(selectEl.value || "");
  selectEl.innerHTML = '<option value="">Unassigned</option>';
  directoryCache.stores.forEach((store) => {
    const option = document.createElement("option");
    option.value = store.id;
    option.textContent = buildStoreDirectoryLabel(store);
    selectEl.appendChild(option);
  });
  if (previous && [...selectEl.options].some((option) => option.value === previous)) {
    selectEl.value = previous;
  }
}

function refreshDepartmentList(inputEl, listEl, storeId) {
  renderDatalistOptions(listEl, buildDepartmentSuggestions(directoryCache, storeId, [inputEl?.value]));
}

function canonicalizeDepartmentInput(inputEl, storeId) {
  if (!inputEl) return "";
  const next = canonicalDepartmentDirectoryValue(
    inputEl.value,
    buildDepartmentSuggestions(directoryCache, storeId),
    ""
  );
  inputEl.value = next;
  return next;
}

async function loadAssignmentDirectory() {
  try {
    directoryCache = await loadStoreDepartmentDirectory(db);
    fillStoreSelect(managerStore);
    fillStoreSelect(staffStore);
    refreshDepartmentList(managerDepartment, managerDepartmentList, managerStore?.value);
    refreshDepartmentList(staffDepartment, staffDepartmentList, staffStore?.value);
  } catch (error) {
    console.warn("Failed to load store/department directory", error);
  }
}

function onTabsKeydown(event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const order = ["admin", "manager", "staff"];
  const current =
    (tabAdmin?.getAttribute("aria-selected") === "true" && "admin") ||
    (tabManager?.getAttribute("aria-selected") === "true" && "manager") ||
    "staff";

  const idx = order.indexOf(current);
  const next = event.key === "ArrowLeft" ? order[Math.max(0, idx - 1)] : order[Math.min(order.length - 1, idx + 1)];
  setPanel(next);
}

if (tabAdmin) {
  tabAdmin.addEventListener("click", () => setPanel("admin"));
  tabAdmin.addEventListener("keydown", onTabsKeydown);
}
if (tabManager) {
  tabManager.addEventListener("click", () => setPanel("manager"));
  tabManager.addEventListener("keydown", onTabsKeydown);
}
if (tabStaff) {
  tabStaff.addEventListener("click", () => setPanel("staff"));
  tabStaff.addEventListener("keydown", onTabsKeydown);
}

if (staffPin) {
  staffPin.addEventListener("input", () => {
    staffPin.value = sanitizePin(staffPin.value);
  });
}

if (managerStore) {
  managerStore.addEventListener("change", () => {
    refreshDepartmentList(managerDepartment, managerDepartmentList, managerStore.value);
  });
}

if (staffStore) {
  staffStore.addEventListener("change", () => {
    refreshDepartmentList(staffDepartment, staffDepartmentList, staffStore.value);
  });
}

if (managerDepartment) {
  managerDepartment.addEventListener("focus", () => refreshDepartmentList(managerDepartment, managerDepartmentList, managerStore?.value));
  managerDepartment.addEventListener("input", () => refreshDepartmentList(managerDepartment, managerDepartmentList, managerStore?.value));
  managerDepartment.addEventListener("blur", () => {
    canonicalizeDepartmentInput(managerDepartment, managerStore?.value);
    refreshDepartmentList(managerDepartment, managerDepartmentList, managerStore?.value);
  });
}

if (staffDepartment) {
  staffDepartment.addEventListener("focus", () => refreshDepartmentList(staffDepartment, staffDepartmentList, staffStore?.value));
  staffDepartment.addEventListener("input", () => refreshDepartmentList(staffDepartment, staffDepartmentList, staffStore?.value));
  staffDepartment.addEventListener("blur", () => {
    canonicalizeDepartmentInput(staffDepartment, staffStore?.value);
    refreshDepartmentList(staffDepartment, staffDepartmentList, staffStore?.value);
  });
}

if (adminForm) {
  adminForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearMessages();
    setLoading(true);
    if (adminBtn) adminBtn.textContent = "Creating...";

    try {
      const result = await adminCreateEmailAccount({
        role: "admin",
        name: adminName?.value || "",
        email: adminEmail?.value || "",
        password: adminPassword?.value || ""
      });
      showMessage(adminMessage, `Admin created: ${result.email || result.uid}`, "success");
      adminForm.reset();
    } catch (error) {
      showMessage(adminMessage, toFriendlyError(error), "error");
    } finally {
      if (adminBtn) adminBtn.textContent = "Create Admin Account";
      setLoading(false);
      if (adminEmail) adminEmail.focus();
    }
  });
}

if (managerForm) {
  managerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearMessages();
    setLoading(true);
    if (managerBtn) managerBtn.textContent = "Creating...";

    try {
      const result = await adminCreateEmailAccount({
        role: "manager",
        name: managerName?.value || "",
        email: managerEmail?.value || "",
        password: managerPassword?.value || "",
        store: managerStore?.value || "",
        department: canonicalizeDepartmentInput(managerDepartment, managerStore?.value)
      });
      showMessage(managerMessage, `Manager created: ${result.email || result.uid}`, "success");
      managerForm.reset();
      refreshDepartmentList(managerDepartment, managerDepartmentList, "");
    } catch (error) {
      showMessage(managerMessage, toFriendlyError(error), "error");
    } finally {
      if (managerBtn) managerBtn.textContent = "Create Manager Account";
      setLoading(false);
      if (managerEmail) managerEmail.focus();
    }
  });
}

if (staffForm) {
  staffForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearMessages();
    setLoading(true);
    if (staffBtn) staffBtn.textContent = "Creating...";

    try {
      const result = await adminCreateStaffAccount({
        staffId: staffId?.value || "",
        name: staffName?.value || "",
        store: staffStore?.value || "",
        department: canonicalizeDepartmentInput(staffDepartment, staffStore?.value),
        pin: sanitizePin(staffPin?.value || "")
      });
      showMessage(staffMessage, result.message || "Staff account created.", "success");
      staffForm.reset();
      refreshDepartmentList(staffDepartment, staffDepartmentList, "");
    } catch (error) {
      showMessage(staffMessage, toFriendlyError(error), "error");
    } finally {
      if (staffBtn) staffBtn.textContent = "Create Staff Account";
      setLoading(false);
      if (staffId) staffId.focus();
    }
  });
}

setPanel("admin");
void loadAssignmentDirectory();
