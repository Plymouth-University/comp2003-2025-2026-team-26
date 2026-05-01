import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const PROJECT_ID = "friarymilllogbooks";
const DATABASE_URL = "https://friarymilllogbooks-default-rtdb.europe-west1.firebasedatabase.app";
const APPLY = process.argv.includes("--apply");
const VALID_ROLES = new Set(["admin", "manager", "staff"]);

function resolveFirebaseToolsRoot() {
  if (process.env.FIREBASE_TOOLS_ROOT) return process.env.FIREBASE_TOOLS_ROOT;
  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error("Set FIREBASE_TOOLS_ROOT or APPDATA so the script can find firebase-tools.");
  }
  return path.join(appData, "npm", "node_modules", "firebase-tools");
}

const toolsRoot = resolveFirebaseToolsRoot();
const firebaseAuth = require(path.join(toolsRoot, "lib", "auth"));
const scopes = require(path.join(toolsRoot, "lib", "scopes"));

let token = "";

function clean(value) {
  return String(value || "").trim();
}

function cleanRole(value) {
  const role = clean(value).toLowerCase();
  return VALID_ROLES.has(role) ? role : "";
}

function parseClaims(user) {
  try {
    return user.customAttributes ? JSON.parse(user.customAttributes) : {};
  } catch {
    return {};
  }
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

async function readRtdb(pathValue) {
  const response = await fetch(`${DATABASE_URL}/${pathValue}.json`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`RTDB ${pathValue} read failed: ${response.status} ${body.slice(0, 250)}`);
  }
  return response.json();
}

async function identityFetch(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Identity Toolkit request failed: ${response.status} ${text.slice(0, 250)}`);
  }

  return response.json();
}

async function listUsers() {
  const users = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    const result = await identityFetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts:query`,
      {
        offset: String(offset),
        limit: String(limit)
      }
    );

    const batch = result.userInfo || [];
    users.push(...batch);
    const count = Number(result.recordsCount || batch.length || 0);
    if (!count || batch.length < limit) break;
    offset += count;
  }

  return users.map((user) => ({
    ...user,
    uid: user.uid || user.localId || ""
  }));
}

async function mergeCustomClaims(uid, updates) {
  await identityFetch("https://identitytoolkit.googleapis.com/v1/accounts:update", {
    targetProjectId: PROJECT_ID,
    localId: uid,
    customAttributes: JSON.stringify(updates),
    returnSecureToken: false
  });
}

function buildDesiredClaims(user, accountMeta, staffMeta) {
  const claims = parseClaims(user);
  const uid = user.uid || user.localId || "";
  const isStaff = uid.startsWith("staff_");
  const currentRole = cleanRole(claims.role);
  const metaRole = cleanRole(accountMeta?.role || staffMeta?.role);
  const role = currentRole || (isStaff ? "staff" : metaRole);

  if (!role) return { claims, updates: null, reason: "no-role" };

  const store = clean(claims.store || claims.storeId || accountMeta?.store || staffMeta?.store);
  const department = clean(claims.department || accountMeta?.department || staffMeta?.department);
  const updates = {};

  if (cleanRole(claims.role) !== role) updates.role = role;
  if (store && (claims.store !== store || claims.storeId !== store)) {
    updates.store = store;
    updates.storeId = store;
  }
  if (department && claims.department !== department) updates.department = department;

  return {
    claims,
    updates: Object.keys(updates).length ? updates : null,
    role,
    roleSource: currentRole ? "existing-claim" : (isStaff ? "staff-uid" : "rtdb-account")
  };
}

async function main() {
  token = await getAccessToken();
  const [users, accounts, staff] = await Promise.all([
    listUsers(),
    readRtdb("accounts"),
    readRtdb("staff")
  ]);

  const planned = [];
  const skipped = [];

  for (const user of users) {
    const uid = user.uid || user.localId || "";
    const staffId = uid.startsWith("staff_") ? uid.slice("staff_".length) : "";
    const accountMeta = accounts?.[uid] || {};
    const staffMeta = staffId ? (staff?.[staffId] || {}) : {};
    const plan = buildDesiredClaims(user, accountMeta, staffMeta);

    if (!plan.updates) {
      if (plan.reason === "no-role") skipped.push(user);
      continue;
    }

    planned.push({
      uid,
      email: user.email || accountMeta.email || staffMeta.email || "",
      displayName: user.displayName || accountMeta.name || staffMeta.name || "",
      claims: plan.claims,
      updates: plan.updates,
      roleSource: plan.roleSource
    });
  }

  console.log(`${APPLY ? "Applying" : "Dry run"} Auth custom-claim sync for ${PROJECT_ID}`);
  console.log(`Scanned ${users.length} user(s). ${planned.length} need claim update(s). ${skipped.length} have no role source.`);

  for (const item of planned) {
    const label = item.email || item.displayName || item.uid;
    const updateKeys = Object.keys(item.updates).join(", ");
    console.log(`- ${label}: ${updateKeys} (${item.roleSource})`);
  }

  if (!APPLY) {
    console.log("No writes made. Re-run with --apply to update custom claims.");
    return;
  }

  for (const item of planned) {
    await mergeCustomClaims(item.uid, { ...item.claims, ...item.updates });
  }

  console.log(`Updated ${planned.length} user(s). Existing sessions may need to sign out/in or refresh their token.`);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
