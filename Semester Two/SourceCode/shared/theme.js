// Theme initialization and toggle functionality
// Include this file after the theme toggle button is in the DOM

(function() {
  const STORAGE_KEY = "theme";
  const root = document.documentElement;

  function readSavedTheme() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved === "dark" || saved === "light" ? saved : null;
    } catch {
      return null;
    }
  }

  function persistTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Ignore storage failures and keep the active theme in-memory only.
    }
  }

  function applyTheme(theme) {
    const nextTheme = theme === "dark" ? "dark" : "light";
    root.setAttribute("data-theme", nextTheme);
    window.dispatchEvent(new CustomEvent("friary-theme-change", { detail: { theme: nextTheme } }));
    return nextTheme;
  }

  function initTheme() {
    const saved = readSavedTheme();
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = saved || (prefersDark ? "dark" : "light");
    return applyTheme(theme);
  }

  function setupToggle() {
    const toggle = document.getElementById("themeToggle");
    if (!toggle) return;

    function syncToggle() {
      const isDark = root.getAttribute("data-theme") === "dark";
      toggle.setAttribute("aria-pressed", isDark ? "true" : "false");
      toggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
      toggle.setAttribute("title", isDark ? "Switch to light mode" : "Switch to dark mode");
      toggle.dataset.themeState = isDark ? "dark" : "light";
    }

    if (!root.getAttribute("data-theme")) initTheme();
    syncToggle();

    toggle.addEventListener("click", () => {
      const current = root.getAttribute("data-theme");
      const next = current === "dark" ? "light" : "dark";
      applyTheme(next);
      persistTheme(next);
      syncToggle();
    });

    window.addEventListener("friary-theme-change", syncToggle);
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY) return;
      const theme = event.newValue === "dark" ? "dark" : "light";
      applyTheme(theme);
      syncToggle();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupToggle);
  } else {
    setupToggle();
  }

  window.FriaryTheme = { applyTheme, initTheme, setupToggle };
})();
