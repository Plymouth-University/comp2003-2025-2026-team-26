import {
  getRoleFromUser,
  loginAdmin,
  loginStaffWithPin,
  logoutUser,
  onAuthChanged
} from "../shared/auth.js";
import { logLoginActivityOncePerSession } from "../shared/activity-log.js";

const currentUserEl = document.getElementById("current-user");
const statusRow = document.getElementById("status-row");
const statusNote = document.getElementById("status-note");
const continueBtn = document.getElementById("continue-btn");
const logoutBtn = document.getElementById("logout-btn");
const authSections = document.getElementById("auth-sections");
const signInBox = document.getElementById("sign-in-box");

const tabStaff = document.getElementById("tab-staff");
const tabAdmin = document.getElementById("tab-admin");
const panelStaff = document.getElementById("panel-staff");
const panelAdmin = document.getElementById("panel-admin");

const loginForm = document.getElementById("login-form");
const loginEmailInput = document.getElementById("login-email");
const loginPasswordInput = document.getElementById("login-password");
const loginSubmitBtn = document.getElementById("login-submit");
const loginMessage = document.getElementById("login-message");

const pinLoginForm = document.getElementById("pin-login-form");
const pinInput = document.getElementById("pin-input");
const pinSubmitBtn = document.getElementById("pin-submit");
const pinLoginMessage = document.getElementById("pin-login-message");
const pinPad = document.querySelector(".pin-pad");

const queryParams = new URLSearchParams(window.location.search);
const isTouchPrimary = Boolean(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);

function clearMessages() {
  [loginMessage, pinLoginMessage].filter(Boolean).forEach((el) => {
    el.textContent = "";
    el.className = "message";
  });
}

function showMessage(el, message, type) {
  if (!el) return;
  el.textContent = message;
  el.className = `message ${type}`;
}

function normaliseRole(role) {
  return String(role || "").trim().toLowerCase();
}

function pageForRole(role) {
  const value = normaliseRole(role);
  if (value === "staff") return "../user/index.html";
  if (value === "manager") return "../manager/index.html";
  if (value === "admin") return "../admin/index.html";
  return "../manager/index.html";
}

function parseRoles(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((role) => role.trim().toLowerCase())
    .filter(Boolean);
}

function getRequestedDestination() {
  const next = queryParams.get("next");
  if (!next) return null;

  try {
    const nextUrl = new URL(next, window.location.href);
    const loginPath = new URL("./index.html", window.location.href).pathname;
    if (nextUrl.origin !== window.location.origin || nextUrl.pathname === loginPath) {
      return null;
    }

    return `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
  } catch {
    return null;
  }
}

const requiredRolesForNext = parseRoles(queryParams.get("roles"));
const requestedDestination = getRequestedDestination();

function continueLabelForRole(role) {
  const value = normaliseRole(role);
  if (value === "staff") return "Continue to Staff";
  if (value === "manager") return "Continue to Manager";
  if (value === "admin") return "Continue to Admin";
  return "Continue";
}

function roleDisplayName(role) {
  const value = normaliseRole(role);
  if (value === "staff") return "Staff";
  if (value === "manager") return "Manager";
  if (value === "admin") return "Admin";
  return "authorised";
}

function formatRoleList(roles) {
  const labels = roles.map(roleDisplayName);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

function roleAllowedForRequestedDestination(role) {
  if (!requestedDestination) return true;
  if (requiredRolesForNext.length === 0) return true;
  return requiredRolesForNext.includes(normaliseRole(role));
}

function destinationForRole(role) {
  const normalisedRole = normaliseRole(role);
  if (requestedDestination) {
    const roleAllowed = requiredRolesForNext.length === 0 || requiredRolesForNext.includes(normalisedRole);
    if (roleAllowed) return requestedDestination;
  }
  return pageForRole(normalisedRole);
}

function navigateForUser(user) {
  const role = normaliseRole(getRoleFromUser(user));
  window.location.replace(destinationForRole(role));
}

function hideStatusRow() {
  if (statusRow) statusRow.style.display = "none";
  if (statusNote) {
    statusNote.textContent = "";
    statusNote.style.display = "none";
  }
}

function applyAuthState(user) {
  clearMessages();

  if (!user) {
    currentUserEl.textContent = "Not logged in";
    continueBtn.style.display = "none";
    logoutBtn.style.display = "none";
    hideStatusRow();
    if (authSections) authSections.style.display = "block";
    if (signInBox) signInBox.style.display = "block";
    return;
  }

  const role = normaliseRole(getRoleFromUser(user));
  if (roleAllowedForRequestedDestination(role)) {
    navigateForUser(user);
    return;
  }

  const label = user.email || user.uid;
  currentUserEl.textContent = `${label} (${role})`;
  if (statusNote) {
    const requiredRoleText = formatRoleList(requiredRolesForNext);
    statusNote.textContent = requiredRoleText
      ? `This page is for ${requiredRoleText} accounts. Continue to your dashboard or log out to switch account.`
      : "Continue to your dashboard or log out to switch account.";
    statusNote.style.display = "block";
  }
  continueBtn.textContent = continueLabelForRole(role);

  continueBtn.style.display = "inline-flex";
  logoutBtn.style.display = "inline-flex";
  if (statusRow) statusRow.style.display = "flex";
  if (authSections) authSections.style.display = "block";
  if (signInBox) signInBox.style.display = "none";
}

function setSectionLoading(isLoading) {
  if (!authSections) return;
  authSections.classList.toggle("loading", isLoading);

  // Also hard-disable form controls for keyboard users.
  const controls = authSections.querySelectorAll("input, button, select, textarea");
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

function setButtonLoading(button, isLoading, loadingText) {
  if (!button) return;
  const labelEl = button.querySelector(".btn-label");
  const spinnerEl = button.querySelector(".spinner");

  if (isLoading) {
    button.dataset.originalText = labelEl ? labelEl.textContent : button.textContent;
    if (labelEl) labelEl.textContent = loadingText;
    if (spinnerEl) spinnerEl.style.display = "inline-block";
    return;
  }

  const original = button.dataset.originalText;
  if (original && labelEl) labelEl.textContent = original;
  if (spinnerEl) spinnerEl.style.display = "none";
}

function toFriendlyAuthError(error, kind) {
  const code = String(error?.code || "");
  const msg = String(error?.message || "");

  const isDisabled =
    code === "auth/user-disabled" ||
    /disabled/i.test(msg) ||
    code === "functions/permission-denied"; // may be used by admin-only routes

  if (isDisabled) return "Account disabled";

  if (kind === "pin") {
    if (code === "functions/unauthenticated" || /invalid pin/i.test(msg)) return "Incorrect PIN";
    if (code === "functions/invalid-argument") return "Incorrect PIN";
    if (code === "functions/resource-exhausted" || /too many/i.test(msg) || /try again later/i.test(msg)) {
      return "Too many attempts. Try again later.";
    }
    return msg || "PIN login failed";
  }

  // Email/password
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
    return "Invalid password";
  }
  if (code === "auth/too-many-requests") return "Too many attempts. Try again later.";
  if (code === "auth/invalid-email") return "Enter a valid email address.";
  if (code === "auth/network-request-failed") return "Network error. Check your connection.";
  return msg || "Login failed";
}

function clearFailedEmailAttempt(error) {
  if (loginPasswordInput) loginPasswordInput.value = "";
  const code = String(error?.code || "");
  if (code === "auth/invalid-email" && loginEmailInput) {
    loginEmailInput.value = "";
  }
}

function clearFailedPinAttempt() {
  if (!pinInput) return;
  pinInput.value = "";
  updatePinSubmitState();
}

function setMode(mode) {
  const isStaff = mode === "staff";

  if (tabStaff) tabStaff.setAttribute("aria-selected", isStaff ? "true" : "false");
  if (tabAdmin) tabAdmin.setAttribute("aria-selected", isStaff ? "false" : "true");

  if (panelStaff) panelStaff.classList.toggle("active", isStaff);
  if (panelAdmin) panelAdmin.classList.toggle("active", !isStaff);

  clearMessages();

  // Tablet-first: avoid popping the OS keyboard on touch-first devices.
  if (!isTouchPrimary) {
    if (isStaff) {
      if (pinInput) pinInput.focus();
    } else {
      if (loginEmailInput) loginEmailInput.focus();
    }
  }
}

function onTabKeydown(event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  setMode(event.key === "ArrowLeft" ? "staff" : "admin");
}

function sanitizeIdentifier(value) {
  return String(value || "").trim();
}

function normaliseLoginEmailInput() {
  if (!loginEmailInput) return "";
  const normalised = sanitizeIdentifier(loginEmailInput.value);
  loginEmailInput.value = normalised;
  return normalised;
}

function sanitizePin(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 4);
}

function updatePinSubmitState() {
  if (!pinSubmitBtn || !pinInput) return;
  const pin = sanitizePin(pinInput.value);
  pinSubmitBtn.disabled = pin.length !== 4;
}

if (tabStaff) {
  tabStaff.addEventListener("click", () => setMode("staff"));
  tabStaff.addEventListener("keydown", onTabKeydown);
}
if (tabAdmin) {
  tabAdmin.addEventListener("click", () => setMode("admin"));
  tabAdmin.addEventListener("keydown", onTabKeydown);
}

if (pinInput) {
  pinInput.addEventListener("input", () => {
    pinInput.value = sanitizePin(pinInput.value);
    updatePinSubmitState();
  });
}

if (loginEmailInput) {
  loginEmailInput.addEventListener("blur", () => {
    normaliseLoginEmailInput();
  });
}

if (pinPad) {
  pinPad.addEventListener("click", (event) => {
    const btn = event.target.closest("button");
    if (!btn || !pinInput) return;

    const digit = btn.dataset.digit;
    const action = btn.dataset.action;

    if (digit != null) {
      const next = sanitizePin(pinInput.value + digit);
      pinInput.value = next;
    } else if (action === "back") {
      pinInput.value = sanitizePin(pinInput.value).slice(0, -1);
    } else if (action === "clear") {
      pinInput.value = "";
    }

    if (!isTouchPrimary) pinInput.focus();
    updatePinSubmitState();
  });
}

onAuthChanged((user) => {
  applyAuthState(user);

  continueBtn.onclick = () => {
    if (!user) return;
    navigateForUser(user);
  };
});

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearMessages();
    setSectionLoading(true);
    setButtonLoading(loginSubmitBtn, true, "Signing in...");

    try {
      const email = normaliseLoginEmailInput();
      const password = String(loginPasswordInput?.value || "");
      const user = await loginAdmin(email, password);
      await logLoginActivityOncePerSession({
        loginMethod: "email_password",
        section: "Authentication",
        summary: "Signed in using email/password"
      });
      showMessage(loginMessage, "Signed in", "success");
      loginForm.reset();
      navigateForUser(user);
    } catch (error) {
      showMessage(loginMessage, toFriendlyAuthError(error, "email"), "error");
      clearFailedEmailAttempt(error);
    } finally {
      setButtonLoading(loginSubmitBtn, false, "");
      setSectionLoading(false);
      if (!isTouchPrimary) {
        if (loginEmailInput?.value && loginPasswordInput) {
          loginPasswordInput.focus();
        } else if (loginEmailInput) {
          loginEmailInput.focus();
        }
      }
    }
  });
}

if (pinLoginForm) {
  pinLoginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearMessages();

    const pin = sanitizePin(pinInput?.value || "");
    if (pin.length !== 4) {
      showMessage(pinLoginMessage, "Enter a 4-digit PIN", "error");
      updatePinSubmitState();
      if (pinInput && !isTouchPrimary) pinInput.focus();
      return;
    }

    setSectionLoading(true);
    setButtonLoading(pinSubmitBtn, true, "Checking...");

    try {
      const user = await loginStaffWithPin(pin);
      await logLoginActivityOncePerSession({
        loginMethod: "pin",
        section: "Authentication",
        summary: "Signed in using staff PIN"
      });
      showMessage(pinLoginMessage, "Signed in", "success");
      pinLoginForm.reset();
      updatePinSubmitState();
      navigateForUser(user);
    } catch (error) {
      showMessage(pinLoginMessage, toFriendlyAuthError(error, "pin"), "error");
      clearFailedPinAttempt();
      if (pinInput && !isTouchPrimary) pinInput.focus();
    } finally {
      setButtonLoading(pinSubmitBtn, false, "");
      setSectionLoading(false);
    }
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    clearMessages();
    try {
      await logoutUser();
      setMode("staff");
    } catch (error) {
      showMessage(loginMessage, String(error?.message || "Logout failed"), "error");
    }
  });
}

// Default mode: Staff PIN (tablet-first).
setMode("staff");
updatePinSubmitState();

if (pinInput && isTouchPrimary) {
  // Prevent the on-screen keyboard; the PIN pad is the primary input on tablets.
  pinInput.setAttribute("readonly", "readonly");
}
