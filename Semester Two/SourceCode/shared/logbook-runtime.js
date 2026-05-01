import { buildBusinessWeekRows, getBusinessDateISO, mondayOfBusinessWeek } from "./business-time.js";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const TEMPERATURE_MODE_PRESETS = Object.freeze({
  freezer: Object.freeze({
    label: "Freezer",
    min: -25,
    max: -18,
    placeholder: "e.g. -20",
    acceptsNegative: true,
    acceptsPositive: false
  }),
  fridge: Object.freeze({
    label: "Fridge / Chiller",
    min: 1,
    max: 5,
    placeholder: "e.g. 3",
    acceptsNegative: false,
    acceptsPositive: true
  }),
  ambient: Object.freeze({
    label: "Ambient",
    min: 10,
    max: 25,
    placeholder: "e.g. 20",
    acceptsNegative: false,
    acceptsPositive: true
  }),
  hot_hold: Object.freeze({
    label: "Hot Hold",
    min: 63,
    max: null,
    placeholder: "e.g. 75",
    acceptsNegative: false,
    acceptsPositive: true
  }),
  oven: Object.freeze({
    label: "Oven",
    min: 80,
    max: 260,
    placeholder: "e.g. 180",
    acceptsNegative: false,
    acceptsPositive: true
  }),
  custom: Object.freeze({
    label: "Custom",
    min: null,
    max: null,
    placeholder: "Enter temperature...",
    acceptsNegative: true,
    acceptsPositive: true
  })
});

export function cleanString(value) {
  const text = String(value || "").trim();
  return text || "";
}

export function normalizeDepartmentValue(value, fallback = "General") {
  return cleanString(value) || cleanString(fallback) || "General";
}

export function buildLogbookInstanceId({ storeId = "", department = "", templateId = "", dateKey = "" } = {}) {
  const nextStoreId = cleanString(storeId);
  const nextTemplateId = cleanString(templateId);
  const nextDateKey = cleanString(dateKey);
  if (!nextStoreId || !nextTemplateId || !nextDateKey) return "";
  return `${nextStoreId}__${encodeURIComponent(normalizeDepartmentValue(department))}__${nextTemplateId}__${nextDateKey}`;
}

export function buildAssignmentRuleId({ storeId = "", department = "", templateId = "", frequency = "daily" } = {}) {
  const nextStoreId = cleanString(storeId);
  const nextTemplateId = cleanString(templateId);
  const nextFrequency = cleanString(frequency).toLowerCase() || "daily";
  if (!nextStoreId || !nextTemplateId) return "";
  return `${nextStoreId}__${encodeURIComponent(normalizeDepartmentValue(department))}__${nextTemplateId}__${nextFrequency}`;
}

export function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

export function parseTs(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  const next = new Date(value);
  return Number.isNaN(next.getTime()) ? null : next;
}

export function mondayOfWeek(dateStr) {
  return mondayOfBusinessWeek(dateStr || getBusinessDateISO());
}

export function buildAutoDayRows(dateStr, showDates = false) {
  return buildBusinessWeekRows(dateStr || getBusinessDateISO(), showDates)
    .map((row, index) => ({
      id: row.id,
      label: showDates ? row.label : DAY_NAMES[index]
    }));
}

export function getCellKey(blockId, rowId, colKey) {
  return `${blockId}::${rowId}::${colKey}`;
}

export function getTemperaturePreset(mode) {
  const key = cleanString(mode).toLowerCase();
  return TEMPERATURE_MODE_PRESETS[key] || TEMPERATURE_MODE_PRESETS.custom;
}

export function normalizeTemperatureConfig(config = {}) {
  const mode = cleanString(config.temperature_mode).toLowerCase() || "custom";
  const preset = getTemperaturePreset(mode);
  const min = mode === "custom" ? asNumber(config.min) : (config.min != null ? asNumber(config.min) : preset.min);
  const max = mode === "custom" ? asNumber(config.max) : (config.max != null ? asNumber(config.max) : preset.max);
  return {
    ...config,
    temperature_mode: mode,
    min,
    max,
    placeholder: cleanString(config.placeholder) || preset.placeholder || "Enter temperature...",
    acceptsNegative: preset.acceptsNegative,
    acceptsPositive: preset.acceptsPositive,
    modeLabel: preset.label
  };
}

export function evaluateTemperatureValue(value, config = {}) {
  const normalized = normalizeTemperatureConfig(config);
  const num = asNumber(value);
  if (num === null) {
    return {
      numericValue: null,
      inRange: null,
      isPositiveDirectionValid: null,
      ...normalized
    };
  }
  let inRange = true;
  if (normalized.min != null && num < normalized.min) inRange = false;
  if (normalized.max != null && num > normalized.max) inRange = false;

  let directionValid = true;
  if (!normalized.acceptsNegative && num < 0) directionValid = false;
  if (!normalized.acceptsPositive && num > 0) directionValid = false;

  return {
    numericValue: num,
    inRange,
    isPositiveDirectionValid: directionValid,
    ...normalized
  };
}

export function getFirstNonEmpty(...values) {
  for (const value of values) {
    const text = cleanString(value);
    if (text) return text;
  }
  return "Unknown";
}

export function getDepartmentLabel(instance = {}, templateName = "", templateData = {}) {
  const explicit = getFirstNonEmpty(
    instance.department,
    instance.dept,
    templateData.department,
    templateData.dept,
    templateData.category
  );
  if (explicit !== "Unknown") return explicit;
  if (templateName.includes(":")) return templateName.split(":")[0].trim() || "General";
  if (templateName.includes(" - ")) return templateName.split(" - ")[0].trim() || "General";
  return "General";
}

export function getSectionLabel(instance = {}, templateName = "", templateData = {}) {
  const explicit = getFirstNonEmpty(
    instance.section,
    instance.logbookSection,
    templateData.section,
    templateData.logbookSection
  );
  if (explicit !== "Unknown") return explicit;
  return templateName || "General";
}

export function detectLogbookExceptions(blocks = [], values = {}, dateKey = "") {
  const issues = [];
  blocks.forEach((block) => {
    const cfg = block.config || {};
    const blockId = block.block_id;
    if (!blockId) return;

    if (block.type === "yes_no") {
      if (String(values[blockId] || "").toLowerCase() === "no" && cfg.no_is_exception !== false) {
        issues.push({
          key: blockId,
          label: block.label || "Yes / No",
          value: "No",
          kind: "yes_no"
        });
      }
      return;
    }

    if (block.type === "temperature") {
      const result = evaluateTemperatureValue(values[blockId], cfg);
      if (result.numericValue !== null && (result.inRange === false || result.isPositiveDirectionValid === false)) {
        issues.push({
          key: blockId,
          label: block.label || "Temperature",
          value: String(result.numericValue),
          kind: "temperature"
        });
      }
      return;
    }

    if (block.type !== "table") return;

    const columns = Array.isArray(cfg.columns) ? cfg.columns : [];
    let rows = Array.isArray(cfg.rows) ? cfg.rows : [];
    if (cfg.row_mode === "per_day") rows = buildAutoDayRows(dateKey, Boolean(cfg.show_dates_in_rows));

    rows.forEach((row) => {
      const rowId = row.id || row.label || "row";
      columns.forEach((column) => {
        const key = getCellKey(blockId, rowId, column.key || "col");
        const raw = values[key];
        if (column.input === "yn" && String(raw || "").toLowerCase() === "no") {
          issues.push({
            key,
            label: `${cfg.title || block.label || "Table"} / ${row.label || rowId}`,
            value: "No",
            kind: "yes_no"
          });
          return;
        }
        if (column.input === "number") {
          const result = evaluateTemperatureValue(raw, column);
          if (result.numericValue !== null && (result.inRange === false || result.isPositiveDirectionValid === false)) {
            issues.push({
              key,
              label: `${cfg.title || block.label || "Table"} / ${row.label || rowId}`,
              value: String(result.numericValue),
              kind: "temperature"
            });
          }
        }
      });
    });
  });
  return issues;
}

export function collectReportableNotes(blocks = [], values = {}) {
  const notes = [];
  blocks.forEach((block) => {
    if (block.type !== "note") return;
    const cfg = block.config || {};
    if (cfg.monitor_when_filled === false) return;
    const text = cleanString(values[block.block_id]);
    if (!text) return;
    notes.push({
      key: block.block_id,
      label: block.label || "Note",
      text,
      snippet: text.length > 100 ? `${text.slice(0, 100)}...` : text
    });
  });
  return notes;
}
