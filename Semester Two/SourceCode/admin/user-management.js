import {
  guardPage,
  adminGeneratePasswordResetLink,
  adminListAccounts,
  adminSetAccountDisabled,
  adminSetAccountRole,
  adminSetStaffPin,
  adminUpdateAccountProfile
} from "../shared/auth.js";
import { db } from "../shared/logbook-app.js";
import { buildDepartmentSuggestions, buildStoreDirectoryLabel, canonicalDepartmentDirectoryValue, loadStoreDepartmentDirectory, renderDatalistOptions } from "../shared/store-department-directory.js";
import { waitForPageGuard } from "../shared/page-guard.js";
await waitForPageGuard();

const listWrap = document.getElementById("listWrap");
const listStatus = document.getElementById("listStatus");
const refreshBtn = document.getElementById("refreshBtn");
const searchInput = document.getElementById("searchInput");
const roleFilter = document.getElementById("roleFilter");
const statusFilter = document.getElementById("statusFilter");
const clearFiltersBtn = document.getElementById("clearFiltersBtn");
const countLabel = document.getElementById("countLabel");
const accountsBody = document.getElementById("accountsBody");
const mobileCards = document.getElementById("mobileCards");
const emptyState = document.getElementById("emptyState");
const statTotal = document.getElementById("statTotal");
const statActive = document.getElementById("statActive");
const statDisabled = document.getElementById("statDisabled");
const statStaff = document.getElementById("statStaff");

const detailPanel = document.getElementById("detailPanel");
const detailCloseBtn = document.getElementById("detailCloseBtn");
const detailNameLabel = document.getElementById("detailNameLabel");
const detailMeta = document.getElementById("detailMeta");

const detailName = document.getElementById("detailName");
const detailRole = document.getElementById("detailRole");
const detailStore = document.getElementById("detailStore");
const detailDepartment = document.getElementById("detailDepartment");
const detailDepartmentList = document.getElementById("detailDepartmentList");

const detailSaveBtn = document.getElementById("detailSaveBtn");
const detailDisableBtn = document.getElementById("detailDisableBtn");
const detailResetPasswordBtn = document.getElementById("detailResetPasswordBtn");

const staffPinRow = document.getElementById("staffPinRow");
const detailPin = document.getElementById("detailPin");
const detailSetPinBtn = document.getElementById("detailSetPinBtn");

const resetLinkRow = document.getElementById("resetLinkRow");
const resetLinkBox = document.getElementById("resetLinkBox");

const detailMessage = document.getElementById("detailMessage");

let allAccounts = [];
let selectedUid = null;
let directoryCache = {
  stores: [],
  departmentsByStore: new Map(),
  allDepartments: []
};

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setStatus(text, kind = "") {
  if (!listStatus) return;
  listStatus.textContent = text;
  listStatus.classList.remove("success", "error");
  if (kind === "success") listStatus.classList.add("success");
  if (kind === "error") listStatus.classList.add("error");
}

function showDetailMessage(text, type) {
  if (!detailMessage) return;
  detailMessage.textContent = text;
  detailMessage.className = `message ${type}`;
}

function clearDetailMessage() {
  if (!detailMessage) return;
  detailMessage.textContent = "";
  detailMessage.className = "message";
}

function setLoading(isLoading) {
  if (!listWrap) return;
  listWrap.classList.toggle("loading", isLoading);
  if (refreshBtn) refreshBtn.disabled = isLoading;
}

function formatDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function prettyRole(role) {
  const value = String(role || "").toLowerCase();
  if (!value) return "-";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function setText(el, value) {
  if (!el) return;
  el.textContent = String(value);
}

function renderSummary() {
  const total = allAccounts.length;
  const active = allAccounts.filter((acc) => !acc.disabled).length;
  const disabled = total - active;
  const staff = allAccounts.filter((acc) => String(acc.role || "").toLowerCase() === "staff").length;

  setText(statTotal, total);
  setText(statActive, active);
  setText(statDisabled, disabled);
  setText(statStaff, staff);
}

function getFilteredAccounts() {
  const q = String(searchInput?.value || "").trim().toLowerCase();
  const role = String(roleFilter?.value || "").trim().toLowerCase();
  const status = String(statusFilter?.value || "").trim().toLowerCase();

  return allAccounts.filter((acc) => {
    if (role && String(acc.role || "").toLowerCase() !== role) return false;
    if (status === "active" && acc.disabled) return false;
    if (status === "disabled" && !acc.disabled) return false;
    if (!q) return true;

    const hay = [
      acc.name,
      acc.email,
      acc.role,
      acc.store,
      acc.department,
      acc.staffId,
      acc.uid
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return hay.includes(q);
  });
}

function renderActions(acc) {
  const uid = escapeHtml(acc.uid);
  const disableLabel = acc.disabled ? "Enable" : "Disable";
  const resetBtn =
    acc.role !== "staff" && acc.email
      ? `<button class="btn" type="button" data-action="reset" data-uid="${uid}">Reset Password</button>`
      : "";
  const pinBtn =
    acc.role === "staff"
      ? `<button class="btn" type="button" data-action="pin" data-uid="${uid}">Set PIN</button>`
      : "";

  return `
    <button class="btn primary" type="button" data-action="edit" data-uid="${uid}">Edit</button>
    ${resetBtn}
    ${pinBtn}
    <button class="btn ${acc.disabled ? "" : "danger"}" type="button" data-action="toggle" data-uid="${uid}">${disableLabel}</button>
  `;
}

function renderTable() {
  const filtered = getFilteredAccounts();
  const total = allAccounts.length;
  renderSummary();

  if (accountsBody) {
    accountsBody.innerHTML = filtered
      .map((acc) => {
        const name = escapeHtml(acc.name || "");
        const role = escapeHtml(prettyRole(acc.role));
        const store = escapeHtml(acc.store || "");
        const dept = escapeHtml(acc.department || "");
        const status = acc.disabled ? '<span class="pill bad">Disabled</span>' : '<span class="pill ok">Active</span>';
        const lastLogin = escapeHtml(formatDate(acc.lastLogin));
        const selected = selectedUid === acc.uid ? "is-selected" : "";

        return `
          <tr class="${selected}">
            <td>
              <div><strong>${name || "-"}</strong></div>
              <div class="muted">${escapeHtml(acc.email || acc.staffId || acc.uid || "")}</div>
            </td>
            <td>${role || "-"}</td>
            <td>${store || "-"}</td>
            <td>${dept || "-"}</td>
            <td>${status}</td>
            <td>${lastLogin}</td>
            <td>
              <div class="actions">
                ${renderActions(acc)}
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  if (mobileCards) {
    mobileCards.innerHTML = filtered
      .map((acc) => {
        const selected = selectedUid === acc.uid ? "active" : "";
        const name = escapeHtml(acc.name || "");
        const role = escapeHtml(prettyRole(acc.role));
        const store = escapeHtml(acc.store || "-");
        const dept = escapeHtml(acc.department || "-");
        const lastLogin = escapeHtml(formatDate(acc.lastLogin));
        const status = acc.disabled ? '<span class="pill bad">Disabled</span>' : '<span class="pill ok">Active</span>';
        const meta = escapeHtml(acc.email || acc.staffId || acc.uid || "");

        return `
          <article class="account-card ${selected}">
            <div class="account-card-top">
              <div>
                <h3 class="account-name">${name || "-"}</h3>
                <div class="account-meta">${meta}</div>
              </div>
              ${status}
            </div>
            <div class="account-fields">
              <div>
                <div class="account-field-label">Role</div>
                <div class="account-field-value">${role}</div>
              </div>
              <div>
                <div class="account-field-label">Last Login</div>
                <div class="account-field-value">${lastLogin}</div>
              </div>
              <div>
                <div class="account-field-label">Store</div>
                <div class="account-field-value">${store}</div>
              </div>
              <div>
                <div class="account-field-label">Department</div>
                <div class="account-field-value">${dept}</div>
              </div>
            </div>
            <div class="actions">
              ${renderActions(acc)}
            </div>
          </article>
        `;
      })
      .join("");
  }

  if (countLabel) {
    countLabel.textContent = `Showing ${filtered.length} of ${total}`;
  }

  if (emptyState) {
    emptyState.style.display = filtered.length ? "none" : "block";
  }
}

function findAccount(uid) {
  return allAccounts.find((a) => a.uid === uid) || null;
}

function openDetail(uid) {
  const acc = findAccount(uid);
  if (!acc || !detailPanel) return;

  selectedUid = uid;
  clearDetailMessage();

  if (detailNameLabel) detailNameLabel.textContent = acc.name || acc.email || acc.staffId || "User";
  if (detailMeta) {
    const bits = [
      acc.email ? `Email: ${acc.email}` : null,
      acc.staffId ? `Staff ID: ${acc.staffId}` : null,
      `UID: ${acc.uid}`,
      acc.createdAt ? `Created: ${formatDate(acc.createdAt)}` : null,
      acc.lastLogin ? `Last login: ${formatDate(acc.lastLogin)}` : "Last login: -"
    ].filter(Boolean);
    detailMeta.textContent = `(${bits.join(" | ")})`;
  }

  if (detailName) detailName.value = acc.name || "";
  fillDetailStoreSelect(acc.store || "");
  if (detailDepartment) detailDepartment.value = acc.department || "";
  refreshDetailDepartmentList(acc.department || "");

  if (detailRole) {
    detailRole.value = acc.role || "staff";
    detailRole.disabled = acc.role === "staff";
  }

  if (detailDisableBtn) {
    detailDisableBtn.textContent = acc.disabled ? "Enable" : "Disable";
    detailDisableBtn.classList.toggle("danger", !acc.disabled);
  }

  const isStaff = acc.role === "staff";
  if (staffPinRow) staffPinRow.style.display = isStaff ? "block" : "none";
  if (detailResetPasswordBtn) detailResetPasswordBtn.style.display = !isStaff && acc.email ? "inline-flex" : "none";
  if (resetLinkRow) resetLinkRow.style.display = "none";
  if (resetLinkBox) resetLinkBox.value = "";
  if (detailPin) detailPin.value = "";

  detailPanel.classList.add("active");
  renderTable();
}

function closeDetail() {
  selectedUid = null;
  if (detailPanel) detailPanel.classList.remove("active");
  renderTable();
}

async function copyToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function toFriendlyError(error) {
  const code = String(error?.code || "");
  const msg = String(error?.message || "");

  if (code === "functions/permission-denied") return "Permission denied.";
  if (code === "functions/invalid-argument") return msg || "Invalid input.";
  if (code === "functions/not-found") return msg || "Not found.";
  if (code === "functions/already-exists") return msg || "Already exists.";
  if (code === "functions/internal" && msg.trim().toLowerCase() === "internal") {
    return "Server blocked (Cloud Run invoker). Ask for Cloud Run IAM to allow unauthenticated invocation, then delete + redeploy Functions.";
  }
  return msg || "Request failed.";
}

function sanitizePin(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 4);
}

function fillDetailStoreSelect(currentValue = "") {
  if (!detailStore) return;
  const previous = String(currentValue || detailStore.value || "").trim();
  detailStore.innerHTML = '<option value="">Unassigned</option>';
  directoryCache.stores.forEach((store) => {
    const option = document.createElement("option");
    option.value = store.id;
    option.textContent = buildStoreDirectoryLabel(store);
    detailStore.appendChild(option);
  });
  if (previous && ![...detailStore.options].some((option) => option.value === previous)) {
    const option = document.createElement("option");
    option.value = previous;
    option.textContent = `${previous} (legacy value)`;
    detailStore.appendChild(option);
  }
  detailStore.value = previous;
}

function refreshDetailDepartmentList(seedValue = detailDepartment?.value || "") {
  renderDatalistOptions(
    detailDepartmentList,
    buildDepartmentSuggestions(directoryCache, detailStore?.value, [seedValue])
  );
}

function canonicalizeDetailDepartment() {
  if (!detailDepartment) return "";
  const next = canonicalDepartmentDirectoryValue(
    detailDepartment.value,
    buildDepartmentSuggestions(directoryCache, detailStore?.value),
    ""
  );
  detailDepartment.value = next;
  return next;
}

async function loadAssignmentDirectory() {
  try {
    directoryCache = await loadStoreDepartmentDirectory(db);
    fillDetailStoreSelect(selectedUid ? findAccount(selectedUid)?.store : detailStore?.value);
    refreshDetailDepartmentList();
  } catch (error) {
    console.warn("Failed to load store/department directory", error);
  }
}

async function doResetPassword(uid) {
  const acc = findAccount(uid);
  if (!acc?.email) return;

  clearDetailMessage();
  setLoading(true);
  setStatus("Generating reset link...");

  try {
    const result = await adminGeneratePasswordResetLink({ email: acc.email });
    const link = result.link;

    const copied = await copyToClipboard(link);
    if (copied) {
      showDetailMessage("Password reset link copied to clipboard.", "success");
      setStatus("Reset link copied", "success");
      if (resetLinkRow) resetLinkRow.style.display = "none";
    } else {
      // Fallback: show the link for manual copy (e.g. file:// or restricted clipboard).
      if (resetLinkRow) resetLinkRow.style.display = "block";
      if (resetLinkBox) {
        resetLinkBox.value = link;
        resetLinkBox.focus();
        resetLinkBox.select();
      }
      showDetailMessage("Copy the reset link shown below.", "success");
      setStatus("Reset link generated", "success");
    }
  } catch (error) {
    showDetailMessage(toFriendlyError(error), "error");
    setStatus("Reset failed", "error");
  } finally {
    setLoading(false);
  }
}

async function doToggleDisabled(uid) {
  const acc = findAccount(uid);
  if (!acc) return;

  const target = acc.name || acc.email || acc.staffId || "this user";
  const action = acc.disabled ? "enable" : "disable";
  const confirmed = await styledConfirm(`Are you sure you want to ${action} ${target}?`, `${action.charAt(0).toUpperCase() + action.slice(1)} User`, { danger: action === "disable", confirmText: action.charAt(0).toUpperCase() + action.slice(1), icon: action === "disable" ? "🚫" : "✅" });
  if (!confirmed) return;

  clearDetailMessage();
  setLoading(true);
  setStatus(acc.disabled ? "Enabling..." : "Disabling...");

  try {
    await adminSetAccountDisabled({ uid: acc.uid, disabled: !acc.disabled });
    setStatus("Updated", "success");
    await loadAccounts();
    if (selectedUid) openDetail(selectedUid);
  } catch (error) {
    setStatus("Update failed", "error");
    showDetailMessage(toFriendlyError(error), "error");
  } finally {
    setLoading(false);
  }
}

async function doSaveChanges() {
  const acc = selectedUid ? findAccount(selectedUid) : null;
  if (!acc) return;

  clearDetailMessage();
  setLoading(true);
  setStatus("Saving...");

  try {
    const nextRole = String(detailRole?.value || acc.role || "").trim().toLowerCase();
    const nextName = String(detailName?.value || "").trim();
    const nextStore = String(detailStore?.value || "").trim();
    const nextDept = canonicalizeDetailDepartment();

    if (acc.role !== "staff" && nextRole && nextRole !== acc.role) {
      if (nextRole === "staff") {
        throw new Error("Email/password users cannot be switched to staff PIN accounts.");
      }
      await adminSetAccountRole({ uid: acc.uid, role: nextRole });
    }

    await adminUpdateAccountProfile({ uid: acc.uid, name: nextName, store: nextStore, department: nextDept });

    setStatus("Saved", "success");
    await loadAccounts();
    openDetail(acc.uid);
    showDetailMessage("Changes saved.", "success");
  } catch (error) {
    setStatus("Save failed", "error");
    showDetailMessage(toFriendlyError(error), "error");
  } finally {
    setLoading(false);
  }
}

async function doSetPin() {
  const acc = selectedUid ? findAccount(selectedUid) : null;
  if (!acc || acc.role !== "staff") return;

  const newPin = sanitizePin(detailPin?.value || "");
  if (newPin.length !== 4) {
    showDetailMessage("Enter a 4-digit PIN.", "error");
    return;
  }
  if (!acc.staffId) {
    showDetailMessage("Missing staffId for this user.", "error");
    return;
  }

  clearDetailMessage();
  setLoading(true);
  setStatus("Updating PIN...");

  try {
    await adminSetStaffPin({ staffId: acc.staffId, pin: newPin });
    if (detailPin) detailPin.value = "";
    showDetailMessage("PIN updated.", "success");
    setStatus("PIN updated", "success");
  } catch (error) {
    showDetailMessage(toFriendlyError(error), "error");
    setStatus("PIN update failed", "error");
  } finally {
    setLoading(false);
  }
}

async function loadAccounts() {
  setLoading(true);
  setStatus("Loading...");
  try {
    const result = await adminListAccounts();
    const list = result?.accounts || result?.users || [];
    allAccounts = Array.isArray(list) ? list : [];
    const roleOrder = { admin: 0, manager: 1, staff: 2 };
    allAccounts.sort((a, b) => {
      const ra = String(a.role || "").toLowerCase();
      const rb = String(b.role || "").toLowerCase();
      const roleCmp = (roleOrder[ra] ?? 99) - (roleOrder[rb] ?? 99);
      if (roleCmp) return roleCmp;
      return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
    });
    setStatus(`Loaded ${allAccounts.length} users`, "success");
    if (emptyState) emptyState.textContent = "No users found.";
    renderTable();
  } catch (error) {
    allAccounts = [];
    renderTable();
    setStatus(toFriendlyError(error), "error");
    if (emptyState) emptyState.textContent = "Failed to load users. Check your connection, then press Refresh.";
    console.error(error);
  } finally {
    setLoading(false);
  }
}

if (refreshBtn) {
  refreshBtn.addEventListener("click", async () => {
    await loadAssignmentDirectory();
    await loadAccounts();
  });
}
if (searchInput) searchInput.addEventListener("input", renderTable);
if (roleFilter) roleFilter.addEventListener("change", renderTable);
if (statusFilter) statusFilter.addEventListener("change", renderTable);

if (searchInput) {
  searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!searchInput.value) return;
    searchInput.value = "";
    renderTable();
  });
}

if (clearFiltersBtn) {
  clearFiltersBtn.addEventListener("click", () => {
    if (searchInput) searchInput.value = "";
    if (roleFilter) roleFilter.value = "";
    if (statusFilter) statusFilter.value = "";
    renderTable();
    searchInput?.focus();
  });
}

async function handleAccountActionClick(event) {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;

  const uid = btn.dataset.uid;
  const action = btn.dataset.action;

  if (!uid) return;

  if (action === "edit") {
    openDetail(uid);
    return;
  }
  if (action === "toggle") {
    await doToggleDisabled(uid);
    return;
  }
  if (action === "reset") {
    openDetail(uid);
    await doResetPassword(uid);
    return;
  }
  if (action === "pin") {
    openDetail(uid);
    if (detailPin) detailPin.focus();
  }
}

if (accountsBody) accountsBody.addEventListener("click", handleAccountActionClick);
if (mobileCards) mobileCards.addEventListener("click", handleAccountActionClick);

if (detailCloseBtn) detailCloseBtn.addEventListener("click", closeDetail);
if (detailSaveBtn) detailSaveBtn.addEventListener("click", doSaveChanges);
if (detailDisableBtn) detailDisableBtn.addEventListener("click", () => selectedUid && doToggleDisabled(selectedUid));
if (detailResetPasswordBtn) detailResetPasswordBtn.addEventListener("click", () => selectedUid && doResetPassword(selectedUid));
if (detailSetPinBtn) detailSetPinBtn.addEventListener("click", doSetPin);

if (detailPin) {
  detailPin.addEventListener("input", () => {
    detailPin.value = sanitizePin(detailPin.value);
  });
}

if (detailStore) {
  detailStore.addEventListener("change", () => {
    refreshDetailDepartmentList();
  });
}

if (detailDepartment) {
  detailDepartment.addEventListener("focus", () => refreshDetailDepartmentList());
  detailDepartment.addEventListener("input", () => refreshDetailDepartmentList());
  detailDepartment.addEventListener("blur", () => {
    canonicalizeDetailDepartment();
    refreshDetailDepartmentList();
  });
}

async function init() {
  try {
    await guardPage("admin", "../login/index.html");
  } catch {
    return;
  }
  await loadAssignmentDirectory();
  await loadAccounts();
}

init();
