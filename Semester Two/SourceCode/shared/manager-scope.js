import { auth, getMyAccount, getRoleFromUser } from "./auth.js";

function clean(value) {
  const text = String(value || "").trim();
  return text || "";
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return "";
}

function readScope(source) {
  if (!source || typeof source !== "object") {
    return { role: "", storeId: "", department: "" };
  }

  const nestedScope = source.scope && typeof source.scope === "object" ? source.scope : {};
  return {
    role: firstNonEmpty(source.role, source.claims?.role, source.account?.role),
    storeId: firstNonEmpty(
      source.storeId,
      source.store,
      source.scopeStoreId,
      source.scopeStore,
      nestedScope.storeId,
      nestedScope.store
    ),
    department: firstNonEmpty(
      source.department,
      source.dept,
      source.scopeDepartment,
      nestedScope.department,
      nestedScope.dept
    )
  };
}

export async function resolveManagerScopeOrThrow() {
  let accountResult = null;
  let accountLookupSucceeded = false;
  let accountLookupError = null;

  try {
    accountResult = await getMyAccount();
    accountLookupSucceeded = true;
  } catch (error) {
    accountLookupError = error;
  }

  const accountScope = readScope(accountResult?.account);
  const resultScope = readScope(accountResult);
  const userScope = readScope(auth.currentUser);
  const claimScope = readScope(auth.currentUser?.claims);
  const nestedUserAccountScope = readScope(auth.currentUser?.account);

  const storeId = firstNonEmpty(
    accountScope.storeId,
    resultScope.storeId,
    userScope.storeId,
    claimScope.storeId,
    nestedUserAccountScope.storeId
  );
  const department = firstNonEmpty(
    accountScope.department,
    resultScope.department,
    userScope.department,
    claimScope.department,
    nestedUserAccountScope.department
  );
  const role = firstNonEmpty(
    accountScope.role,
    resultScope.role,
    userScope.role,
    claimScope.role,
    nestedUserAccountScope.role,
    getRoleFromUser(auth.currentUser)
  ).toLowerCase();

  if (storeId || department) {
    return { storeId, department };
  }

  // A successful account lookup for a manager/admin with no explicit store or
  // department means "broad manager scope", which the rest of the UI supports.
  if (accountLookupSucceeded && (role === "manager" || role === "admin")) {
    return { storeId: "", department: "" };
  }

  if (accountLookupError) {
    throw accountLookupError;
  }

  throw new Error("Manager scope is unavailable for this account.");
}
