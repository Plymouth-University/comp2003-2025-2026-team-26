/**
 * Styled Dialog System — replaces browser prompt(), confirm(), alert()
 * Include via <script src="../shared/dialog.js"></script>
 * 
 * Usage:
 *   await styledAlert("Something happened", "Info");
 *   const ok = await styledConfirm("Delete this?", "Confirm Delete");
 *   const val = await styledPrompt("Enter name:", "Olly", "Rename");
 *   const val = await styledPrompt("Reason:", "", "Reason Required", { required: true, placeholder: "Type reason…" });
 */

(function () {
  if (window.__styledDialogReady) return;
  window.__styledDialogReady = true;

  // ─── Inject CSS ───
  const style = document.createElement("style");
  style.textContent = `
    .sd-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; z-index:99999; animation:sd-fadeIn .15s ease; }
    @keyframes sd-fadeIn { from { opacity:0; } to { opacity:1; } }
    @keyframes sd-slideUp { from { opacity:0; transform:translateY(12px) scale(.97); } to { opacity:1; transform:translateY(0) scale(1); } }
    .sd-modal { width:min(440px,92vw); background:var(--bg-secondary, #fff); border:1px solid var(--border-color, #e5e7eb); border-radius:14px; box-shadow:0 20px 60px rgba(0,0,0,0.2); animation:sd-slideUp .2s ease; overflow:hidden; }
    [data-theme="dark"] .sd-modal { box-shadow:0 20px 60px rgba(0,0,0,0.5); }
    .sd-header { display:flex; align-items:center; justify-content:space-between; padding:18px 20px 0; }
    .sd-header h3 { margin:0; font-size:17px; font-weight:600; color:var(--text-primary, #1f2937); display:flex; align-items:center; gap:10px; }
    .sd-header .sd-icon { font-size:20px; line-height:1; }
    .sd-close { width:34px; height:34px; border-radius:50%; border:1px solid var(--border-color, #e5e7eb); background:var(--bg-secondary, #fff); color:var(--text-secondary, #6b7280); cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:16px; transition:all .15s; flex-shrink:0; }
    .sd-close:hover { background:var(--accent-danger-bg, #fee2e2); border-color:var(--accent-danger, #ef4444); color:var(--accent-danger, #ef4444); }
    .sd-body { padding:14px 20px 6px; }
    .sd-message { font-size:14px; color:var(--text-secondary, #6b7280); line-height:1.55; margin:0 0 14px; white-space:pre-line; }
    .sd-input { width:100%; box-sizing:border-box; background:var(--bg-secondary, #fff); border:1px solid var(--border-color, #e5e7eb); color:var(--text-primary, #1f2937); border-radius:10px; padding:12px 14px; font-size:14px; outline:none; transition:border-color .15s, box-shadow .15s; }
    .sd-input:focus { border-color:var(--accent-primary, #2563eb); box-shadow:var(--focus-ring, 0 0 0 3px rgba(17,17,17,0.16)); }
    .sd-input::placeholder { color:var(--text-muted, #9ca3af); }
    .sd-textarea { min-height:80px; resize:vertical; font-family:inherit; }
    .sd-hint { font-size:12px; color:var(--text-muted, #9ca3af); margin-top:6px; }
    .sd-error { font-size:13px; color:var(--accent-danger, #ef4444); margin-top:6px; display:none; }
    .sd-error.visible { display:block; }
    .sd-footer { padding:14px 20px 18px; display:flex; gap:10px; justify-content:flex-end; }
    .sd-btn { border-radius:50px; padding:10px 20px; font-size:14px; min-height:44px; cursor:pointer; transition:all .15s; border:1px solid var(--border-color, #e5e7eb); font-family:inherit; }
    .sd-btn-cancel { background:var(--bg-secondary, #fff); color:var(--text-primary, #1f2937); }
    .sd-btn-cancel:hover { background:var(--bg-tertiary, #f9fafb); }
    .sd-btn-ok { background:var(--accent-primary, #2563eb); border-color:var(--accent-primary, #2563eb); color:var(--accent-primary-contrast, #fff); }
    .sd-btn-ok:hover { background:var(--accent-primary-hover, #1d4ed8); }
    .sd-btn-danger { background:var(--accent-danger, #ef4444); border-color:var(--accent-danger, #ef4444); color:#fff; }
    .sd-btn-danger:hover { background:#dc2626; border-color:#dc2626; }
    @media (max-width:480px) {
      .sd-modal { border-radius:12px 12px 0 0; position:fixed; bottom:0; left:0; right:0; width:100%; max-width:100%; }
      .sd-footer { flex-direction:column-reverse; }
      .sd-btn { width:100%; text-align:center; min-height:48px; font-size:15px; }
    }
  `;
  document.head.appendChild(style);

  // ─── Helpers ───
  function esc(str) {
    return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function buildModal({ title, icon, message, inputType, inputDefault, placeholder, hint, required, multiline, showCancel, confirmText, confirmStyle }) {
    const backdrop = document.createElement("div");
    backdrop.className = "sd-backdrop";

    let inputHtml = "";
    if (inputType === "text") {
      if (multiline) {
        inputHtml = `<textarea class="sd-input sd-textarea" id="sdInput" placeholder="${esc(placeholder || "")}">${esc(inputDefault || "")}</textarea>`;
      } else {
        inputHtml = `<input class="sd-input" id="sdInput" type="text" value="${esc(inputDefault || "")}" placeholder="${esc(placeholder || "")}" />`;
      }
      if (hint) inputHtml += `<div class="sd-hint">${esc(hint)}</div>`;
      inputHtml += `<div class="sd-error" id="sdError"></div>`;
    }

    backdrop.innerHTML = `
      <div class="sd-modal">
        <div class="sd-header">
          <h3>${icon ? `<span class="sd-icon">${icon}</span>` : ""}${esc(title)}</h3>
          <button class="sd-close" id="sdCloseX" title="Close">&#x2715;</button>
        </div>
        <div class="sd-body">
          ${message ? `<div class="sd-message">${esc(message)}</div>` : ""}
          ${inputHtml}
        </div>
        <div class="sd-footer">
          ${showCancel ? `<button class="sd-btn sd-btn-cancel" id="sdCancel">Cancel</button>` : ""}
          <button class="sd-btn ${confirmStyle === 'danger' ? 'sd-btn-danger' : 'sd-btn-ok'}" id="sdOk">${esc(confirmText || "OK")}</button>
        </div>
      </div>
    `;

    return backdrop;
  }

  // ─── styledAlert ───
  window.styledAlert = function (message, title, opts = {}) {
    return new Promise(resolve => {
      const el = buildModal({
        title: title || "Notice",
        icon: opts.icon || "ℹ️",
        message,
        showCancel: false,
        confirmText: opts.confirmText || "OK"
      });
      document.body.appendChild(el);
      const ok = el.querySelector("#sdOk");
      const close = el.querySelector("#sdCloseX");
      function done() { el.remove(); resolve(); }
      ok.addEventListener("click", done);
      close.addEventListener("click", done);
      ok.focus();
      el.addEventListener("keydown", e => { if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); done(); } });
    });
  };

  // ─── styledConfirm ───
  window.styledConfirm = function (message, title, opts = {}) {
    return new Promise(resolve => {
      const el = buildModal({
        title: title || "Confirm",
        icon: opts.icon || "⚠️",
        message,
        showCancel: true,
        confirmText: opts.confirmText || "Confirm",
        confirmStyle: opts.danger ? "danger" : "primary"
      });
      document.body.appendChild(el);
      const ok = el.querySelector("#sdOk");
      const cancel = el.querySelector("#sdCancel");
      const close = el.querySelector("#sdCloseX");
      function done(val) { el.remove(); resolve(val); }
      ok.addEventListener("click", () => done(true));
      cancel.addEventListener("click", () => done(false));
      close.addEventListener("click", () => done(false));
      el.addEventListener("click", e => { if (e.target === el) done(false); });
      ok.focus();
      el.addEventListener("keydown", e => {
        if (e.key === "Escape") { e.preventDefault(); done(false); }
        if (e.key === "Enter") { e.preventDefault(); done(true); }
      });
    });
  };

  // ─── styledPrompt ───
  window.styledPrompt = function (message, defaultValue, title, opts = {}) {
    return new Promise(resolve => {
      const el = buildModal({
        title: title || "Input",
        icon: opts.icon || "✏️",
        message,
        inputType: "text",
        inputDefault: defaultValue || "",
        placeholder: opts.placeholder || "",
        hint: opts.hint || "",
        required: opts.required || false,
        multiline: opts.multiline || false,
        showCancel: true,
        confirmText: opts.confirmText || "Save",
        confirmStyle: opts.confirmStyle || "primary"
      });
      document.body.appendChild(el);
      const ok = el.querySelector("#sdOk");
      const cancel = el.querySelector("#sdCancel");
      const close = el.querySelector("#sdCloseX");
      const input = el.querySelector("#sdInput");
      const error = el.querySelector("#sdError");

      function trySubmit() {
        const val = (input.value || "").trim();
        if (opts.required && !val) {
          error.textContent = opts.requiredMsg || "This field is required.";
          error.classList.add("visible");
          input.focus();
          return;
        }
        el.remove();
        resolve(val || null);
      }
      function dismiss() { el.remove(); resolve(null); }
      ok.addEventListener("click", trySubmit);
      cancel.addEventListener("click", dismiss);
      close.addEventListener("click", dismiss);
      el.addEventListener("click", e => { if (e.target === el) dismiss(); });
      input.addEventListener("keydown", e => {
        if (e.key === "Enter" && !opts.multiline) { e.preventDefault(); trySubmit(); }
        if (e.key === "Escape") { e.preventDefault(); dismiss(); }
      });
      input.addEventListener("input", () => { error.classList.remove("visible"); });

      setTimeout(() => { input.focus(); input.select(); }, 50);
    });
  };
})();
