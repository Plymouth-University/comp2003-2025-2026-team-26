import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const SOURCE_PROJECT = "dradanddrop-bb7c5";
const DEST_PROJECT = "friarymilllogbooks";
const DATABASE = "(default)";
const BATCH_SIZE = 450;
const PAGE_SIZE = 300;
const APPLY = process.argv.includes("--apply");

function resolveFirebaseToolsRoot() {
  if (process.env.FIREBASE_TOOLS_ROOT) return process.env.FIREBASE_TOOLS_ROOT;
  const appData = process.env.APPDATA || "C:/Users/bayley/AppData/Roaming";
  return path.join(appData, "npm", "node_modules", "firebase-tools");
}

const toolsRoot = resolveFirebaseToolsRoot();
const firebaseAuth = require(path.join(toolsRoot, "lib", "auth"));
const scopes = require(path.join(toolsRoot, "lib", "scopes"));

const sourceRoot = `projects/${SOURCE_PROJECT}/databases/${DATABASE}/documents`;
const destRoot = `projects/${DEST_PROJECT}/databases/${DATABASE}/documents`;
const stats = new Map();
let token = "";
let pendingWrites = [];
let writtenDocs = 0;
let scannedDocs = 0;

function firestoreUrl(resourcePath) {
  return `https://firestore.googleapis.com/v1/${encodeURI(resourcePath)}`;
}

async function getAccessToken() {
  const account = firebaseAuth.getGlobalDefaultAccount();
  if (!account?.tokens?.refresh_token) {
    throw new Error("No Firebase CLI account is logged in. Run firebase login first.");
  }

  const authScopes = [
    scopes.EMAIL,
    scopes.OPENID,
    scopes.CLOUD_PROJECTS_READONLY,
    scopes.FIREBASE_PLATFORM,
    scopes.CLOUD_PLATFORM
  ];
  const result = await firebaseAuth.getAccessToken(account.tokens.refresh_token, authScopes);
  if (!result?.access_token) throw new Error("Firebase CLI did not return an access token.");
  return result.access_token;
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

function documentPathFromName(name) {
  const marker = "/documents/";
  const index = name.indexOf(marker);
  if (index === -1) throw new Error(`Unexpected Firestore document name: ${name}`);
  return name.slice(index + marker.length);
}

function collectionPathForStats(parentName, collectionId) {
  if (parentName === sourceRoot) return collectionId;
  return `${documentPathFromName(parentName)}/${collectionId}`;
}

function countCollection(pathValue) {
  stats.set(pathValue, (stats.get(pathValue) || 0) + 1);
}

async function listCollectionIds(parentName) {
  const ids = [];
  let pageToken = "";

  do {
    const body = {
      pageSize: PAGE_SIZE,
      ...(pageToken ? { pageToken } : {})
    };
    const result = await apiFetch(`${firestoreUrl(parentName)}:listCollectionIds`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    ids.push(...(result.collectionIds || []));
    pageToken = result.nextPageToken || "";
  } while (pageToken);

  return ids.sort();
}

async function listDocuments(parentName, collectionId) {
  const docs = [];
  let pageToken = "";

  do {
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
    if (pageToken) params.set("pageToken", pageToken);
    const result = await apiFetch(`${firestoreUrl(`${parentName}/${collectionId}`)}?${params.toString()}`, {
      method: "GET"
    });
    docs.push(...(result.documents || []));
    pageToken = result.nextPageToken || "";
  } while (pageToken);

  return docs;
}

async function flushWrites() {
  if (!pendingWrites.length || !APPLY) {
    pendingWrites = [];
    return;
  }

  const writes = pendingWrites;
  pendingWrites = [];
  await apiFetch(`${firestoreUrl(destRoot)}:commit`, {
    method: "POST",
    body: JSON.stringify({ writes })
  });
  writtenDocs += writes.length;
}

async function queueDocumentCopy(sourceDoc) {
  scannedDocs += 1;
  const docPath = documentPathFromName(sourceDoc.name);
  pendingWrites.push({
    update: {
      name: `${destRoot}/${docPath}`,
      fields: sourceDoc.fields || {}
    }
  });

  if (pendingWrites.length >= BATCH_SIZE) {
    await flushWrites();
  }
}

async function copyCollection(parentName, collectionId) {
  const statPath = collectionPathForStats(parentName, collectionId);
  const docs = await listDocuments(parentName, collectionId);

  for (const doc of docs) {
    countCollection(statPath);
    await queueDocumentCopy(doc);

    const childCollectionIds = await listCollectionIds(doc.name);
    for (const childId of childCollectionIds) {
      await copyCollection(doc.name, childId);
    }
  }
}

async function main() {
  token = await getAccessToken();

  console.log(`${APPLY ? "Applying" : "Dry run"} Firestore copy ${SOURCE_PROJECT} -> ${DEST_PROJECT}`);
  const rootCollectionIds = await listCollectionIds(sourceRoot);
  if (!rootCollectionIds.length) {
    console.log("No source collections found.");
    return;
  }

  for (const collectionId of rootCollectionIds) {
    await copyCollection(sourceRoot, collectionId);
  }

  await flushWrites();

  console.log(`Scanned ${scannedDocs} document(s).`);
  console.log(APPLY ? `Wrote ${writtenDocs} document(s).` : "No writes made. Re-run with --apply to copy data.");
  console.log("Collections:");
  [...stats.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([collectionPath, count]) => {
      console.log(`- ${collectionPath}: ${count}`);
    });
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
