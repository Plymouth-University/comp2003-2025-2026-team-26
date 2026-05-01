#!/usr/bin/env node
"use strict";

/*
  One-time bootstrap script to create/promote an email account to admin/manager.

  Requires Application Default Credentials:
    - PowerShell: $env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\service-account.json"

  Examples:
    node scripts/seed-admin.js --email you@example.com --password "StrongPass!" --role admin --name "First Admin"
    node scripts/seed-admin.js --email you@example.com --role admin
    node scripts/seed-admin.js --uid <uid> --role admin
*/

const admin = require("firebase-admin");

const databaseURL =
  process.env.FIREBASE_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "https://friarymilllogbooks-default-rtdb.europe-west1.firebasedatabase.app";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function usage(exitCode = 1) {
  const msg = `
Usage:
  node scripts/seed-admin.js --email <email> [--password <password>] [--role admin|manager] [--name <name>] [--store <store>] [--department <department>]
  node scripts/seed-admin.js --uid <uid> [--role admin|manager] [--name <name>] [--store <store>] [--department <department>]

Notes:
  - This targets the login Firebase project (Auth + RTDB) and writes:
      - Custom claim: { role: "admin"|"manager" }
      - RTDB: accounts/<uid> metadata
  - Staff PIN accounts use UID prefix "staff_" and are intentionally NOT promotable.
  - Set credentials:
      PowerShell: $env:GOOGLE_APPLICATION_CREDENTIALS="C:\\path\\service-account.json"
`;

  console.error(msg.trim());
  process.exit(exitCode);
}

function cleanString(value) {
  const text = String(value || "").trim();
  return text || "";
}

function buildScopedClaims(existingClaims = {}, { role, store, department } = {}) {
  const claims = existingClaims && typeof existingClaims === "object" ? { ...existingClaims } : {};
  const resolvedRole = cleanString(role);
  const resolvedStore = cleanString(store);
  const resolvedDepartment = cleanString(department);

  if (resolvedRole) claims.role = resolvedRole;
  else delete claims.role;

  if (resolvedStore) {
    claims.store = resolvedStore;
    claims.storeId = resolvedStore;
  } else {
    delete claims.store;
    delete claims.storeId;
  }

  if (resolvedDepartment) claims.department = resolvedDepartment;
  else delete claims.department;

  return claims;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help || args.h) usage(0);

  const role = String(args.role || "admin")
    .trim()
    .toLowerCase();
  if (!["admin", "manager"].includes(role)) {
    throw new Error("role must be 'admin' or 'manager'.");
  }

  const uidArg = typeof args.uid === "string" ? args.uid.trim() : "";
  const emailArg = typeof args.email === "string" ? args.email.trim().toLowerCase() : "";
  const passwordArg = typeof args.password === "string" ? args.password : "";

  const nameArg = typeof args.name === "string" ? args.name.trim() : "";
  const storeArg = typeof args.store === "string" ? args.store.trim() : "";
  const departmentArg = typeof args.department === "string" ? args.department.trim() : "";

  if (!uidArg && !emailArg) usage(1);

  try {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      databaseURL
    });
  } catch (err) {
    const message = err?.message || String(err);
    throw new Error(
      `Failed to initialize Firebase Admin SDK. Ensure GOOGLE_APPLICATION_CREDENTIALS is set.\n${message}`
    );
  }

  const auth = admin.auth();
  const db = admin.database();

  let userRecord;

  if (uidArg) {
    userRecord = await auth.getUser(uidArg);
  } else {
    try {
      userRecord = await auth.getUserByEmail(emailArg);
    } catch (err) {
      const code = err?.code || "";
      if (code !== "auth/user-not-found") throw err;
      if (!passwordArg) {
        throw new Error(
          `No user found for email '${emailArg}'. Create it in Firebase Auth first, or re-run with --password to create it.`
        );
      }

      userRecord = await auth.createUser({
        email: emailArg,
        password: passwordArg,
        displayName: nameArg || undefined,
        disabled: false
      });
    }
  }

  const uid = userRecord.uid;
  if (uid.startsWith("staff_")) {
    throw new Error(
      `Refusing to set role '${role}' on staff UID '${uid}'. Staff PIN accounts are PIN-only and always treated as staff by the frontend.\n` +
        `Create an email/password admin account instead (UID will not start with 'staff_').`
    );
  }

  const ref = db.ref(`accounts/${uid}`);
  const existing = (await ref.once("value")).val() || {};
  const now = admin.database.ServerValue.TIMESTAMP;

  const payload = {
    uid,
    role,
    email: userRecord.email || existing.email || emailArg || null,
    name: nameArg || existing.name || userRecord.displayName || "",
    store: storeArg || existing.store || "",
    department: departmentArg || existing.department || "",
    updatedAt: now
  };

  if (!existing.createdAt) payload.createdAt = now;
  await auth.setCustomUserClaims(uid, buildScopedClaims(userRecord.customClaims || {}, payload));
  await ref.update(payload);

  console.log(`OK: set role=${role} for uid=${uid} email=${payload.email || "(none)"}`);
  console.log("Next: log out and log back in (or refresh token) so the new claim takes effect.");
}

main().catch((err) => {
  console.error(`ERROR: ${err?.message || String(err)}`);
  process.exit(1);
});

