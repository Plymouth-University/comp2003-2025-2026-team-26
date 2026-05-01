import { guardPage } from "./auth.js";
import { setPageGuardPromise } from "./page-guard.js";

await setPageGuardPromise(guardPage("staff", "../login/index.html"));
