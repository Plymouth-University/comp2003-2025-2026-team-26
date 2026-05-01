import { guardPage } from "./auth.js";
import { setPageGuardPromise } from "./page-guard.js";

// Managers can access manager pages; admins can access everything.
await setPageGuardPromise(guardPage(["admin", "manager"], "../login/index.html"));
