import { getDownloadURL, getStorage, ref, uploadString } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-storage.js";
import { loginApp } from "./auth.js";
import { buildStorageImageAsset, getImageAssetUrl } from "./media-assets.js";

// Signature uploads need to use the authenticated login project so Storage writes
// carry the same session as the current user.
const loginStorage = getStorage(loginApp);
const signatureStorageTargets = [
  {
    label: "login",
    storage: loginStorage
  }
];

function clean(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function buildSignatureStoragePath({ scope = "shared", templateId = "", dateKey = "", blockId = "", instanceId = "", storeId = "" } = {}) {
  const scopePart = clean(scope) || "shared";
  const templatePart = clean(templateId) || "template";
  const datePart = clean(dateKey) || "date";
  const blockPart = clean(blockId) || "signature";
  const contextPart = clean(instanceId || storeId || "context");
  return `signatures/${scopePart}/${templatePart}/${datePart}/${contextPart}/${blockPart}.png`;
}

function getStorageBucketLabel(storageTarget) {
  return String(storageTarget?.storage?.app?.options?.storageBucket || "").trim() || "unknown-bucket";
}

function buildSignatureUploadFailureSummary(errors = []) {
  return errors.map(({ label, bucket, code, message }) => ({
    label,
    bucket,
    code: code || "unknown",
    message: String(message || "").trim() || "Unknown upload error"
  }));
}

export async function uploadSignatureDataUrl(dataUrl, options = {}) {
  const normalizedDataUrl = String(dataUrl || "");
  const storagePath = buildSignatureStoragePath(options);
  const errors = [];

  for (const target of signatureStorageTargets) {
    try {
      const storageRef = ref(target.storage, storagePath);
      await uploadString(storageRef, normalizedDataUrl, "data_url");
      const downloadURL = await getDownloadURL(storageRef);
      return buildStorageImageAsset({
        storagePath,
        downloadURL,
        updatedAt: new Date().toISOString(),
        inlineDataUrl: normalizedDataUrl
      });
    } catch (error) {
      const failure = {
        label: target.label,
        bucket: getStorageBucketLabel(target),
        code: String(error?.code || "").trim(),
        message: String(error?.message || error || "").trim()
      };
      errors.push(failure);
      console.warn(`Signature upload failed for ${target.label} storage (${failure.bucket}).`, error);
    }
  }

  // Keep signatures usable even when Firebase Storage is unavailable or misconfigured.
  console.warn("All configured Firebase Storage targets failed for signature upload. Falling back to inline signature data.", {
    storagePath,
    failures: buildSignatureUploadFailureSummary(errors)
  });
  return normalizedDataUrl;
}

export function getSignatureImageUrl(value) {
  return getImageAssetUrl(value);
}
