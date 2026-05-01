import { guardPage } from "./auth.js";
import { setPageGuardPromise } from "./page-guard.js";

await setPageGuardPromise(guardPage("admin", "../login/index.html"));
