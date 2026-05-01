const BUSINESS_TIME_ZONE = "Europe/London";

function buildDateFormatter(timeZone = BUSINESS_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
}

function cleanDateKey(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function getPart(parts, type) {
  return parts.find((part) => part.type === type)?.value || "";
}

export { BUSINESS_TIME_ZONE };

export function getBusinessDateISO(value = new Date(), timeZone = BUSINESS_TIME_ZONE) {
  const dateValue = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dateValue.getTime())) return "";
  const formatter = buildDateFormatter(timeZone);
  const parts = formatter.formatToParts(dateValue);
  const year = getPart(parts, "year");
  const month = getPart(parts, "month");
  const day = getPart(parts, "day");
  if (!year || !month || !day) return "";
  return `${year}-${month}-${day}`;
}

export function parseDateKey(dateKey) {
  const normalized = cleanDateKey(dateKey);
  if (!normalized) return null;
  const [yearText, monthText, dayText] = normalized.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export function formatDateKey(dateValue) {
  if (!(dateValue instanceof Date) || Number.isNaN(dateValue.getTime())) return "";
  const year = dateValue.getUTCFullYear();
  const month = String(dateValue.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dateValue.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDaysToDateKey(dateKey, amount = 0) {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return "";
  parsed.setUTCDate(parsed.getUTCDate() + Number(amount || 0));
  return formatDateKey(parsed);
}

export function mondayOfBusinessWeek(dateKey = "") {
  const target = parseDateKey(dateKey || getBusinessDateISO());
  if (!target) return getBusinessDateISO();
  const day = target.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day;
  target.setUTCDate(target.getUTCDate() + diff);
  return formatDateKey(target);
}

export function buildBusinessWeekRows(dateKey = "", showDates = false) {
  const mondayKey = mondayOfBusinessWeek(dateKey || getBusinessDateISO());
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return Array.from({ length: 7 }, (_, index) => {
    const iso = addDaysToDateKey(mondayKey, index);
    return {
      id: iso,
      label: showDates ? `${names[index]} ${iso}` : names[index]
    };
  });
}
