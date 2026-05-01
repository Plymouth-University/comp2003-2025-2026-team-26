function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isStorageImageAsset(value) {
  return isPlainObject(value) && String(value.kind || "").toLowerCase() === "storage-image";
}

function hasImageFileExtension(value) {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(String(value || "").trim());
}

function normaliseImageUrlString(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^data:image\//i.test(text)) return text;
  if (/^blob:/i.test(text)) return text;

  try {
    const parsed = new URL(text, "https://image-source.invalid");
    const protocol = parsed.protocol.toLowerCase();
    if (!["http:", "https:", "file:"].includes(protocol)) return "";

    const decodedPath = decodeURIComponent(parsed.pathname || "");
    if (!hasImageFileExtension(decodedPath)) return "";
    return text;
  } catch {
    return "";
  }
}

function canAppendCacheBust(url) {
  return !/^(data:|blob:)/i.test(String(url || "").trim());
}

export function getImageAssetUrl(value, { cacheBust = true } = {}) {
  if (!value) return "";
  if (typeof value === "string") return normaliseImageUrlString(value);
  if (!isStorageImageAsset(value)) return "";

  const baseUrl = normaliseImageUrlString(value.downloadURL || value.url || "");
  if (!baseUrl) return "";
  if (!cacheBust || !canAppendCacheBust(baseUrl)) return baseUrl;

  const version = String(value.updatedAt || value.version || "").trim();
  if (!version) return baseUrl;
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}v=${encodeURIComponent(version)}`;
}

export function getImageAssetInlineUrl(value) {
  if (!value || typeof value === "string" || !isStorageImageAsset(value)) return "";
  return normaliseImageUrlString(value.inlineDataUrl || value.inlineUrl || "");
}

export function getImageAssetUrlForExport(value) {
  const inlineUrl = getImageAssetInlineUrl(value);
  if (inlineUrl) return inlineUrl;
  return getImageAssetUrl(value);
}

export function buildStorageImageAsset({ storagePath, downloadURL, updatedAt, width = null, height = null, inlineDataUrl = "" } = {}) {
  return {
    kind: "storage-image",
    storagePath: String(storagePath || "").trim(),
    downloadURL: String(downloadURL || "").trim(),
    updatedAt: String(updatedAt || "").trim() || new Date().toISOString(),
    inlineDataUrl: normaliseImageUrlString(inlineDataUrl),
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null
  };
}

export function summarizeMediaValue(value) {
  if (typeof value === "string") {
    if (value.startsWith("data:image")) {
      return {
        kind: "inline-image",
        length: value.length
      };
    }
    return value;
  }

  if (isStorageImageAsset(value)) {
    return {
      kind: "storage-image",
      storagePath: value.storagePath || "",
      updatedAt: value.updatedAt || "",
      hasInlineDataUrl: Boolean(getImageAssetInlineUrl(value))
    };
  }

  return value;
}
