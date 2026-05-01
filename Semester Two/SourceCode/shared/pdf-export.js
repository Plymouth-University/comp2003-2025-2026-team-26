// Shared helpers for generating Word-style PDFs (html2pdf.js).
// This intentionally uses inline styles so exported PDFs look consistent across pages.
import { getImageAssetUrlForExport } from "./media-assets.js";
import { buildBusinessWeekRows, getBusinessDateISO, mondayOfBusinessWeek } from "./business-time.js";

const HTML2PDF_BUNDLE_SRC = "https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.1/dist/html2pdf.bundle.min.js";
let html2PdfLoader = null;

function asText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function ensureHtml2PdfLoaded() {
  if (typeof window === "undefined") {
    throw new Error("html2pdf.js requires a browser environment");
  }

  if (typeof window.html2pdf === "function") {
    return window.html2pdf;
  }

  if (html2PdfLoader) return html2PdfLoader;

  html2PdfLoader = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-html2pdf-bundle="true"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(window.html2pdf), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load html2pdf.js")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = HTML2PDF_BUNDLE_SRC;
    script.async = true;
    script.dataset.html2pdfBundle = "true";
    script.onload = () => {
      if (typeof window.html2pdf === "function") {
        resolve(window.html2pdf);
        return;
      }
      reject(new Error("html2pdf.js loaded but window.html2pdf is unavailable"));
    };
    script.onerror = () => reject(new Error("Failed to load html2pdf.js"));
    document.head.appendChild(script);
  }).catch((error) => {
    html2PdfLoader = null;
    throw error;
  });

  return html2PdfLoader;
}

export function sanitizeFilename(value, fallback = "export") {
  const raw = String(value || "").trim() || fallback;
  // Windows filename blacklist + ASCII control chars.
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, "_")
    .replace(/\.+$/g, "")
    .trim();

  return cleaned.slice(0, 160) || fallback;
}

function mondayOfWeekIso(dateStr) {
  return mondayOfBusinessWeek(dateStr || getBusinessDateISO());
}

function buildAutoDayRows(dateStr, showDates) {
  return buildBusinessWeekRows(dateStr || getBusinessDateISO(), showDates);
}

function appendHeaderRow(parent, leftLabel, leftValue, rightLabel, rightValue) {
  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.justifyContent = "space-between";
  row.style.gap = "10px";
  row.style.marginTop = "6px";
  row.style.fontSize = "11px";
  row.style.color = "#374151";

  const left = document.createElement("div");
  const leftB = document.createElement("b");
  leftB.textContent = `${leftLabel}: `;
  left.appendChild(leftB);
  left.appendChild(document.createTextNode(asText(leftValue)));

  const right = document.createElement("div");
  const rightB = document.createElement("b");
  rightB.textContent = `${rightLabel}: `;
  right.appendChild(rightB);
  right.appendChild(document.createTextNode(asText(rightValue)));

  row.appendChild(left);
  row.appendChild(right);
  parent.appendChild(row);
}

function normalizeYesNo(value, yesLabel = "Yes", noLabel = "No") {
  const v = String(value || "").toLowerCase();
  if (v === "yes") return yesLabel;
  if (v === "no") return noLabel;
  return "";
}

function setInlineTableBaseStyles(table) {
  table.style.width = "100%";
  table.style.borderCollapse = "collapse";
  table.style.tableLayout = "fixed";
  table.style.marginTop = "6px";
  table.style.fontSize = "9.5px";
  table.style.wordBreak = "break-word";
}

export function buildWordStylePdfDom({
  title,
  templateId,
  storeName,
  dateKey,
  blocks = [],
  values = {},
  extraMeta = [],
  headerRows = null
}) {
  const wrap = document.createElement("div");
  wrap.style.background = "white";
  wrap.style.color = "#111827";
  wrap.style.padding = "18px";
  wrap.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", Arial, sans-serif';
  wrap.style.fontSize = "11px";
  wrap.style.lineHeight = "1.35";

  const titleEl = document.createElement("div");
  titleEl.style.textAlign = "center";
  titleEl.style.fontWeight = "800";
  titleEl.style.fontSize = "16px";
  titleEl.style.textTransform = "uppercase";
  titleEl.style.letterSpacing = ".04em";
  titleEl.textContent = asText(title || "Logbook");
  wrap.appendChild(titleEl);

  if (Array.isArray(headerRows) && headerRows.length) {
    headerRows.filter(Boolean).forEach((pair) => {
      if (!pair || typeof pair !== "object") return;
      const { leftLabel, leftValue, rightLabel, rightValue } = pair;
      if (leftLabel && rightLabel) appendHeaderRow(wrap, leftLabel, leftValue, rightLabel, rightValue);
    });
  } else {
    appendHeaderRow(wrap, "Store", storeName || "Unknown", "Date", dateKey || "Unknown");
    appendHeaderRow(wrap, "Template ID", templateId || "Unknown", "Generated", getBusinessDateISO());
  }

  if (Array.isArray(extraMeta)) {
    extraMeta.filter(Boolean).slice(0, 4).forEach((pair) => {
      if (!pair || typeof pair !== "object") return;
      const { leftLabel, leftValue, rightLabel, rightValue } = pair;
      if (leftLabel && rightLabel) appendHeaderRow(wrap, leftLabel, leftValue, rightLabel, rightValue);
    });
  }

  const divider = document.createElement("div");
  divider.style.height = "1px";
  divider.style.background = "#e5e7eb";
  divider.style.margin = "10px 0 14px";
  wrap.appendChild(divider);

  function cellVal(blockId, rowId, colKey) {
    const k = `${blockId}::${rowId}::${colKey}`;
    return values[k] ?? "";
  }

  const safeDateKey = dateKey || getBusinessDateISO();
  const computedWeekComm = mondayOfWeekIso(safeDateKey);

  const sectionIds = new Set(blocks.filter(b => b.type === "section").map(b => b.block_id));

  function renderPdfBlock(block, target) {
    const cfg = block?.config || {};
    const label = asText(block?.label || block?.type || "Field");
    const bId = block?.block_id;

    if (block.type === "heading") {
      const h = document.createElement("div");
      h.style.textAlign = "center";
      h.style.fontWeight = "800";
      h.style.fontSize = "14px";
      h.style.textTransform = "uppercase";
      h.style.margin = "6px 0 8px";
      h.textContent = label;
      target.appendChild(h);
      return;
    }

    if (block.type === "week_commencing") {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.gap = "8px";
      row.style.alignItems = "center";
      row.style.margin = "6px 0 8px";

      const left = document.createElement("div");
      left.style.fontWeight = "700";
      left.style.minWidth = "130px";
      left.textContent = `${label}:`;

      const right = document.createElement("div");
      right.style.borderBottom = "1px solid #111827";
      right.style.minWidth = "200px";
      right.style.paddingBottom = "2px";
      right.textContent = asText(values[bId] || computedWeekComm);

      row.appendChild(left);
      row.appendChild(right);
      target.appendChild(row);
      return;
    }

    if (block.type === "signature") {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.gap = "8px";
      row.style.alignItems = "flex-start";
      row.style.margin = "10px 0 8px";
      row.style.flexDirection = "column";

      const labelDiv = document.createElement("div");
      labelDiv.style.fontWeight = "700";
      labelDiv.style.minWidth = "160px";
      labelDiv.textContent = `${label}:`;
      row.appendChild(labelDiv);

      const sigUrl = getImageAssetUrlForExport(values[bId]);
      if (sigUrl) {
        const img = document.createElement("img");
        img.src = sigUrl;
        img.style.maxWidth = "300px";
        img.style.maxHeight = "100px";
        img.style.border = "1px solid #e5e7eb";
        img.style.borderRadius = "4px";
        row.appendChild(img);
      } else {
        const line = document.createElement("div");
        line.style.flex = "1";
        line.style.borderBottom = "2px solid #1f2937";
        line.style.height = "20px";
        line.style.minWidth = "200px";
        row.appendChild(line);
      }

      target.appendChild(row);
      return;
    }

    if (block.type === "section") return;

    if (block.type === "table") {
      const titleEl = document.createElement("div");
      titleEl.style.fontWeight = "800";
      titleEl.style.fontSize = "12px";
      titleEl.style.textTransform = "uppercase";
      titleEl.style.marginTop = "10px";
      titleEl.textContent = asText(cfg.title || label || "Table");
      target.appendChild(titleEl);

      if (cfg.note) {
        const note = document.createElement("div");
        note.style.fontSize = "10px";
        note.style.color = "#4b5563";
        note.style.marginTop = "2px";
        note.textContent = asText(cfg.note);
        target.appendChild(note);
      }

      const cols = Array.isArray(cfg.columns) ? cfg.columns : [];
      let rows = Array.isArray(cfg.rows) ? cfg.rows : [];
      if (cfg.row_mode === "per_day") {
        rows = buildAutoDayRows(safeDateKey, Boolean(cfg.show_dates_in_rows));
      }

      const table = document.createElement("table");
      setInlineTableBaseStyles(table);

      const thead = document.createElement("thead");
      const trh = document.createElement("tr");
      cols.forEach((col) => {
        const th = document.createElement("th");
        th.textContent = asText(col.label || col.key || "");
        th.style.border = "1px solid #111827";
        th.style.padding = "4px 3px";
        th.style.background = "#f3f4f6";
        th.style.textTransform = "uppercase";
        th.style.letterSpacing = ".04em";
        trh.appendChild(th);
      });
      thead.appendChild(trh);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      rows.forEach((row) => {
        const tr = document.createElement("tr");
        cols.forEach((col) => {
          const td = document.createElement("td");
          td.style.border = "1px solid #111827";
          td.style.padding = "3px 3px";
          td.style.verticalAlign = "top";

          if (col.input === "rowLabel") {
            td.style.fontWeight = "700";
            td.style.background = "#f9fafb";
            td.textContent = asText(row.label || row.id || "");
          } else {
            const rowId = row.id || row.label || "row";
            const colKey = col.key || "col";
            let v = cellVal(bId, rowId, colKey);

            if (col.input === "yn") {
              v = normalizeYesNo(v, cfg.yes_label || "Yes", cfg.no_label || "No");
            } else if (col.input === "checkbox") {
              v = (v === "true" || v === true) ? "✓" : "—";
            } else if (col.input === "tickcross") {
              v = v === "tick" ? "✓" : v === "cross" ? "✗" : "";
            } else if (col.input === "initials") {
              v = v ? String(v).toUpperCase() : "";
            }

            td.textContent = v !== "" && v != null ? asText(v) : " ";
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      target.appendChild(table);
      return;
    }

    let v = values[bId] ?? "";
    if (block.type === "temperature" && v !== "") v = `${asText(v)} C`;
    if (block.type === "yes_no") v = normalizeYesNo(v, cfg.yes_label || "Yes", cfg.no_label || "No");

    const row = document.createElement("div");
    row.style.display = "grid";
    row.style.gridTemplateColumns = "38% 1fr";
    row.style.gap = "6px";
    row.style.marginTop = "6px";

    const labelEl = document.createElement("div");
    labelEl.style.fontWeight = "600";
    labelEl.textContent = label;

    const valEl = document.createElement("div");
    valEl.style.border = "1px solid #111827";
    valEl.style.padding = "6px";
    valEl.style.borderRadius = "4px";
    valEl.style.background = "#f9fafb";
    valEl.style.minHeight = "18px";

    const text = asText(v);
    const imageUrl = getImageAssetUrlForExport(v);
    if (imageUrl) {
      const img = document.createElement("img");
      img.src = imageUrl;
      img.style.maxWidth = "340px";
      img.style.maxHeight = "220px";
      img.style.border = "1px solid #e5e7eb";
      img.style.borderRadius = "4px";
      valEl.appendChild(img);
    } else {
      valEl.textContent = text || " ";
    }

    row.appendChild(labelEl);
    row.appendChild(valEl);
    target.appendChild(row);
  }

  blocks.forEach((block) => {
    // Skip children — rendered inside their section
    if (block.parent_block_id && sectionIds.has(block.parent_block_id)) return;

    if (block.type === "section") {
      const label = asText(block?.label || "Section");

      // Section header
      const sectionBox = document.createElement("div");
      sectionBox.style.marginTop = "12px";
      sectionBox.style.marginBottom = "6px";
      sectionBox.style.borderLeft = "3px solid #2563eb";
      sectionBox.style.paddingLeft = "10px";

      const h = document.createElement("div");
      h.style.fontWeight = "800";
      h.style.fontSize = "12px";
      h.style.textTransform = "uppercase";
      h.style.borderBottom = "1px solid #e5e7eb";
      h.style.paddingBottom = "3px";
      h.style.marginBottom = "4px";
      h.textContent = label;
      sectionBox.appendChild(h);

      // Children
      const children = blocks.filter(c => c.parent_block_id === block.block_id);
      children.forEach(child => renderPdfBlock(child, sectionBox));

      wrap.appendChild(sectionBox);
      return;
    }

    renderPdfBlock(block, wrap);
  });

  return wrap;
}

export async function exportDomToPdf(dom, filename, options = {}) {
  await ensureHtml2PdfLoaded();

  const base = {
    margin: 10,
    filename,
    image: { type: "jpeg", quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }
  };

  await window.html2pdf().from(dom).set({ ...base, ...options }).save();
}
