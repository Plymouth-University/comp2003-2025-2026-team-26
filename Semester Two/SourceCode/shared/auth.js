import { getApps, initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithCustomToken,
  signOut,
  getIdTokenResult
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-functions.js";

const loginFirebaseConfig = {
  apiKey: "AIzaSyBw5-v1Nt55DGagdMA_-GSPqBIYrGC9W2M",
  authDomain: "friarymilllogbooks.firebaseapp.com",
  databaseURL: "https://friarymilllogbooks-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "friarymilllogbooks",
  storageBucket: "friarymilllogbooks.firebasestorage.app",
  messagingSenderId: "365033208152",
  appId: "1:365033208152:web:23dbd25920cb2a0ce34d2d"
};

const LOGIN_APP_NAME = "friarymill-login-app";
const DEFAULT_SESSION_ROLE = "default";
const SESSION_TIMEOUT_MINUTES_BY_ROLE = Object.freeze({
  staff: 30,
  manager: 30,
  admin: 30,
  default: 15
});
const SESSION_TIMEOUT_STORAGE_PREFIX = "sessionTimeout.minutes.";
const SESSION_TIMEOUT_WARNING_SECONDS_KEY = "sessionTimeout.warningSeconds";
const SESSION_TIMEOUT_DEFAULT_WARNING_SECONDS = 60;
const SESSION_TIMEOUT_ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "scroll",
  "wheel",
  "touchstart",
  "mousedown"
];

const existing = getApps().find((app) => app.name === LOGIN_APP_NAME);
export const loginApp = existing || initializeApp(loginFirebaseConfig, LOGIN_APP_NAME);

export const auth = getAuth(loginApp);
export const functions = getFunctions(loginApp);
let activeSessionTimeoutController = null;
const resolvedRoleByUid = new Map();

function normaliseRoles(requiredRole) {
  if (Array.isArray(requiredRole)) {
    return [...new Set(requiredRole.filter(Boolean))];
  }
  return requiredRole ? [requiredRole] : [];
}

function redirectToLogin(loginPath, allowedRoles = []) {
  const loginUrl = new URL(loginPath, window.location.href);
  const nextPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  loginUrl.searchParams.set("next", nextPath);

  if (allowedRoles.length) {
    loginUrl.searchParams.set("roles", allowedRoles.join(","));
  } else {
    loginUrl.searchParams.delete("roles");
  }

  window.location.replace(loginUrl.toString());
}

function cacheResolvedRole(user, role) {
  const uid = typeof user === "string" ? user : String(user?.uid || "").trim();
  const nextRole = normaliseRole(role);
  if (!uid) return;

  if (!nextRole) {
    resolvedRoleByUid.delete(uid);
    if (user && typeof user === "object") {
      try {
        delete user.__friaryResolvedRole;
      } catch {
        // ignore readonly user objects
      }
    }
    return;
  }

  resolvedRoleByUid.set(uid, nextRole);
  if (user && typeof user === "object") {
    try {
      user.__friaryResolvedRole = nextRole;
    } catch {
      // ignore readonly user objects
    }
  }
}

function getCachedRole(user) {
  if (!user) return null;
  const direct = normaliseRole(user.__friaryResolvedRole || user.role || user?.claims?.role || user?.account?.role);
  if (direct) return direct;
  const uid = String(user.uid || "").trim();
  if (!uid) return null;
  return normaliseRole(resolvedRoleByUid.get(uid));
}

function inferRoleFromUid(user) {
  if (!user) return null;
  return user.uid.startsWith("staff_") ? "staff" : null;
}

function normaliseRole(role) {
  const value = String(role || "").trim().toLowerCase();
  return value || null;
}

function normaliseSignInIdentifier(value) {
  return String(value || "").trim();
}

function normalisePin(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 4);
}

function readStoredNumber(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function resolveSessionTimeoutMinutes(role) {
  const normalised = normaliseRole(role) || DEFAULT_SESSION_ROLE;
  const specific = readStoredNumber(`${SESSION_TIMEOUT_STORAGE_PREFIX}${normalised}`);
  if (specific && specific > 0) return Math.max(1, specific);

  const fallback = readStoredNumber(`${SESSION_TIMEOUT_STORAGE_PREFIX}default`);
  if (fallback && fallback > 0) return Math.max(1, fallback);

  return SESSION_TIMEOUT_MINUTES_BY_ROLE[normalised] || SESSION_TIMEOUT_MINUTES_BY_ROLE.default;
}

function resolveSessionWarningLeadMs(timeoutMs) {
  const configuredSeconds = readStoredNumber(SESSION_TIMEOUT_WARNING_SECONDS_KEY);
  const warningSeconds =
    configuredSeconds && configuredSeconds > 0
      ? configuredSeconds
      : SESSION_TIMEOUT_DEFAULT_WARNING_SECONDS;
  const configuredMs = Math.round(warningSeconds * 1000);
  const maxLeadMs = Math.max(5000, timeoutMs - 5000);
  return Math.min(configuredMs, maxLeadMs);
}

function ensureSessionTimeoutStyles() {
  if (document.getElementById("session-timeout-styles")) return;

  const style = document.createElement("style");
  style.id = "session-timeout-styles";
  style.textContent = `
    .session-timeout-backdrop {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 16px;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(2px);
    }

    .session-timeout-backdrop.show {
      display: flex;
    }

    .session-timeout-dialog {
      width: min(420px, 100%);
      border-radius: 12px;
      border: 1px solid var(--border-color, #d4d4d8);
      background: var(--bg-secondary, #ffffff);
      color: var(--text-primary, #111827);
      box-shadow: 0 18px 42px rgba(0, 0, 0, 0.3);
      padding: 20px;
    }

    .session-timeout-dialog h2 {
      margin: 0 0 10px;
      font-size: 1.15rem;
      line-height: 1.3;
    }

    .session-timeout-dialog p {
      margin: 0;
      color: var(--text-secondary, #52525b);
      line-height: 1.45;
    }

    .session-timeout-countdown {
      font-weight: 700;
      color: var(--text-primary, #111827);
    }

    .session-timeout-actions {
      margin-top: 18px;
      display: flex;
      gap: 10px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }

    .session-timeout-btn {
      border: 1px solid var(--border-color, #d4d4d8);
      border-radius: 9999px;
      background: var(--bg-secondary, #ffffff);
      color: var(--text-primary, #111827);
      min-height: 42px;
      padding: 0 14px;
      font: inherit;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
    }

    .session-timeout-btn:hover {
      background: var(--bg-tertiary, #f3f4f6);
    }

    .session-timeout-btn:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--bg-secondary, #ffffff), 0 0 0 4px var(--accent-primary, #2563eb);
    }

    .session-timeout-btn.primary {
      background: var(--accent-primary, #2563eb);
      border-color: var(--accent-primary, #2563eb);
      color: var(--accent-primary-contrast, #ffffff);
    }

    .session-timeout-btn.primary:hover {
      background: var(--accent-primary-hover, #1d4ed8);
      border-color: var(--accent-primary-hover, #1d4ed8);
    }
  `;

  (document.head || document.documentElement).appendChild(style);
}

function runWhenBodyReady(callback) {
  if (document.body) {
    callback();
    return () => {};
  }

  const onReady = () => {
    document.removeEventListener("DOMContentLoaded", onReady);
    callback();
  };

  document.addEventListener("DOMContentLoaded", onReady);
  return () => document.removeEventListener("DOMContentLoaded", onReady);
}

function buildSessionTimeoutController({ role, loginPath, allowedRoles }) {
  const timeoutMs = resolveSessionTimeoutMinutes(role) * 60 * 1000;
  const warningLeadMs = resolveSessionWarningLeadMs(timeoutMs);
  let warningAt = 0;
  let expiresAt = 0;
  let lastActivityPing = 0;
  let warningTimerId = 0;
  let logoutTimerId = 0;
  let countdownTimerId = 0;
  let isWarningVisible = false;
  let isStopping = false;
  let isLoggingOut = false;
  let cleanupReadyHandler = () => {};
  let modalRoot = null;
  let countdownText = null;
  let stayLoggedInBtn = null;
  let logOutNowBtn = null;
  let previousFocusedElement = null;

  function clearTimers() {
    window.clearTimeout(warningTimerId);
    window.clearTimeout(logoutTimerId);
    window.clearInterval(countdownTimerId);
    warningTimerId = 0;
    logoutTimerId = 0;
    countdownTimerId = 0;
  }

  function countdownSecondsRemaining() {
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  }

  function syncCountdownText() {
    if (!countdownText) return;
    countdownText.textContent = String(countdownSecondsRemaining());
  }

  function hideWarning() {
    if (!isWarningVisible) return;
    isWarningVisible = false;
    window.clearInterval(countdownTimerId);
    countdownTimerId = 0;

    if (modalRoot) modalRoot.classList.remove("show");
    if (previousFocusedElement && typeof previousFocusedElement.focus === "function") {
      previousFocusedElement.focus();
    }
    previousFocusedElement = null;
  }

  function ensureModal() {
    if (modalRoot || !document.body) return;
    ensureSessionTimeoutStyles();

    const wrapper = document.createElement("div");
    wrapper.className = "session-timeout-backdrop";
    wrapper.innerHTML = `
      <section class="session-timeout-dialog" role="alertdialog" aria-modal="true" aria-labelledby="session-timeout-title" aria-describedby="session-timeout-message">
        <h2 id="session-timeout-title">Your session is about to expire</h2>
        <p id="session-timeout-message">
          For security, you will be logged out in
          <span class="session-timeout-countdown" data-session-timeout-countdown></span>
          seconds due to inactivity.
        </p>
        <div class="session-timeout-actions">
          <button type="button" class="session-timeout-btn" data-session-timeout-logout>Log out now</button>
          <button type="button" class="session-timeout-btn primary" data-session-timeout-stay>Stay logged in</button>
        </div>
      </section>
    `;

    document.body.appendChild(wrapper);
    modalRoot = wrapper;
    countdownText = wrapper.querySelector("[data-session-timeout-countdown]");
    stayLoggedInBtn = wrapper.querySelector("[data-session-timeout-stay]");
    logOutNowBtn = wrapper.querySelector("[data-session-timeout-logout]");

    if (stayLoggedInBtn) {
      stayLoggedInBtn.addEventListener("click", () => {
        hideWarning();
        resetTimers(true);
      });
    }

    if (logOutNowBtn) {
      logOutNowBtn.addEventListener("click", () => {
        void forceLogout();
      });
    }

    syncCountdownText();
  }

  function showWarning() {
    if (isWarningVisible || isLoggingOut || isStopping) return;
    ensureModal();
    if (!modalRoot) return;

    isWarningVisible = true;
    previousFocusedElement = document.activeElement;
    syncCountdownText();
    modalRoot.classList.add("show");
    if (stayLoggedInBtn) stayLoggedInBtn.focus();
    countdownTimerId = window.setInterval(syncCountdownText, 1000);
  }

  async function forceLogout() {
    if (isLoggingOut || isStopping) return;
    isLoggingOut = true;
    clearTimers();
    hideWarning();

    try {
      await logoutUser();
    } catch (error) {
      console.error("Automatic session logout failed:", error);
    }

    redirectToLogin(loginPath, allowedRoles);
  }

  function syncWithClock() {
    if (isLoggingOut || isStopping) return;

    const now = Date.now();
    if (now >= expiresAt) {
      void forceLogout();
      return;
    }

    if (now >= warningAt) showWarning();
    if (isWarningVisible) syncCountdownText();
  }

  function scheduleTimers(fromMs = Date.now()) {
    clearTimers();
    warningAt = fromMs + timeoutMs - warningLeadMs;
    expiresAt = fromMs + timeoutMs;

    const warningDelay = Math.max(0, warningAt - fromMs);
    const logoutDelay = Math.max(0, expiresAt - fromMs);

    warningTimerId = window.setTimeout(showWarning, warningDelay);
    logoutTimerId = window.setTimeout(() => void forceLogout(), logoutDelay);
  }

  function resetTimers(force = false) {
    if (isLoggingOut || isStopping) return;
    const now = Date.now();
    if (!force && now - lastActivityPing < 1000) return;
    lastActivityPing = now;

    // Keep the warning explicit: once shown, require "Stay logged in".
    if (isWarningVisible && !force) return;

    scheduleTimers(now);
  }

  const onActivity = () => resetTimers(false);
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") syncWithClock();
  };
  const onWindowFocus = () => syncWithClock();

  function start() {
    cleanupReadyHandler = runWhenBodyReady(() => ensureModal());
    SESSION_TIMEOUT_ACTIVITY_EVENTS.forEach((eventName) => {
      window.addEventListener(eventName, onActivity);
    });
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWindowFocus);
    resetTimers(true);
  }

  function stop() {
    if (isStopping) return;
    isStopping = true;
    clearTimers();
    hideWarning();
    cleanupReadyHandler();
    SESSION_TIMEOUT_ACTIVITY_EVENTS.forEach((eventName) => {
      window.removeEventListener(eventName, onActivity);
    });
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("focus", onWindowFocus);
    if (modalRoot) {
      modalRoot.remove();
      modalRoot = null;
    }
  }

  start();
  return { stop };
}

function startSessionTimeout(role, loginPath, allowedRoles) {
  if (activeSessionTimeoutController) {
    activeSessionTimeoutController.stop();
  }

  activeSessionTimeoutController = buildSessionTimeoutController({ role, loginPath, allowedRoles });
}

function stopSessionTimeout() {
  if (!activeSessionTimeoutController) return;
  activeSessionTimeoutController.stop();
  activeSessionTimeoutController = null;
}

async function resolveRole(user, forceRefresh = false) {
  if (!user) return null;

  const inferred = inferRoleFromUid(user);
  if (inferred) {
    cacheResolvedRole(user, inferred);
    return inferred;
  }

  try {
    const token = await getIdTokenResult(user, forceRefresh);
    const claimRole = normaliseRole(token?.claims?.role);
    if (claimRole) {
      cacheResolvedRole(user, claimRole);
      return claimRole;
    }
    if (token?.claims?.admin === true) {
      cacheResolvedRole(user, "admin");
      return "admin";
    }
  } catch {
    // Ignore token resolution errors and fall through to backend lookup.
  }

  try {
    const result = await callFunction("getMyAccount", {});
    const backendRole = normaliseRole(result?.account?.role || result?.role);
    if (backendRole) {
      cacheResolvedRole(user, backendRole);
      return backendRole;
    }
  } catch {
    // Ignore backend lookup errors and fall through to in-memory cache only.
  }

  return getCachedRole(user);
}

export function getRoleFromUser(user) {
  if (!user) return null;
  return inferRoleFromUid(user) || getCachedRole(user) || null;
}

export async function loginAdmin(email, password) {
  const normalisedEmail = normaliseSignInIdentifier(email);
  const cred = await signInWithEmailAndPassword(auth, normalisedEmail, String(password || ""));
  const role = await resolveRole(cred.user, true);
  cacheResolvedRole(cred.user, role);
  return cred.user;
}

export async function loginStaffWithPin(pin) {
  const normalisedPin = normalisePin(pin);
  if (!/^\d{4}$/.test(normalisedPin)) {
    const error = new Error("A 4-digit PIN is required.");
    error.code = "functions/invalid-argument";
    throw error;
  }

  const authenticateStaffPin = httpsCallable(functions, "authenticateStaffPin");
  const result = await authenticateStaffPin({ pin: normalisedPin });
  const cred = await signInWithCustomToken(auth, result.data.customToken);
  cacheResolvedRole(cred.user, "staff");
  return cred.user;
}

export async function logoutUser() {
  stopSessionTimeout();
  cacheResolvedRole(auth.currentUser, null);
  await signOut(auth);
}

export function onAuthChanged(callback) {
  return onAuthStateChanged(auth, (user) => {
    if (!user) {
      stopSessionTimeout();
      callback(null);
      return;
    }

    resolveRole(user, false)
      .then((role) => cacheResolvedRole(user, role || inferRoleFromUid(user)))
      .catch(() => cacheResolvedRole(user, inferRoleFromUid(user) || null))
      .finally(() => callback(user));
  });
}

export function guardPage(requiredRole, loginPath = "../login/index.html") {
  const allowedRoles = normaliseRoles(requiredRole);

  return new Promise((resolve) => {
    let unsubscribe = () => {};
    unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) {
        stopSessionTimeout();
        unsubscribe();
        redirectToLogin(loginPath, allowedRoles);
        return;
      }

      resolveRole(user, true)
        .then((role) => {
          cacheResolvedRole(user, role);

          if (allowedRoles.length && !allowedRoles.includes(role)) {
            stopSessionTimeout();
            unsubscribe();
            redirectToLogin(loginPath, allowedRoles);
            return;
          }

          startSessionTimeout(role, loginPath, allowedRoles);
          unsubscribe();
          resolve(user);
        })
        .catch(() => {
          stopSessionTimeout();
          unsubscribe();
          redirectToLogin(loginPath, allowedRoles);
        });
    });
  });
}

async function callFunction(name, payload) {
  const fn = httpsCallable(functions, name);
  const result = await fn(payload);
  return result.data;
}

export async function getMyAccount() {
  return callFunction("getMyAccount", {});
}

// Admin-only account creation + management (implemented in Cloud Functions).
export async function adminCreateEmailAccount({ email, password, role, name, store, department }) {
  return callFunction("adminCreateEmailAccount", { email, password, role, name, store, department });
}

export async function adminCreateStaffAccount({ staffId, pin, name, store, department }) {
  // Uses the existing staff-creation function name, now admin-only.
  return callFunction("createStaffAccountFinal", { staffId, pin, name, store, department });
}

export async function adminListAccounts() {
  return callFunction("adminListAccounts", {});
}

export async function adminSetAccountDisabled({ uid, disabled }) {
  return callFunction("adminSetAccountDisabled", { uid, disabled });
}

export async function adminSetAccountRole({ uid, role }) {
  return callFunction("adminSetAccountRole", { uid, role });
}

export async function adminUpdateAccountProfile({ uid, name, store, department }) {
  return callFunction("adminUpdateAccountProfile", { uid, name, store, department });
}

export async function adminSetStaffPin({ staffId, pin }) {
  return callFunction("adminSetStaffPin", { staffId, pin });
}

export async function adminGeneratePasswordResetLink({ email }) {
  return callFunction("adminGeneratePasswordResetLink", { email });
}
