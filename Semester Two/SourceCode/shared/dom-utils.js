export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeClassToken(value, fallback = "") {
  const token = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return token || fallback;
}

export function clearElement(element) {
  if (!element) return;
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

export function appendTextBlock(parent, className, text) {
  const element = document.createElement("div");
  if (className) element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

export function replaceWithMessage(container, className, text, tagName = "div") {
  clearElement(container);
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  container.appendChild(element);
  return element;
}

export function setSelectOptions(selectElement, options) {
  clearElement(selectElement);
  options.forEach(({ value = "", label = "" }) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    selectElement.appendChild(option);
  });
}
