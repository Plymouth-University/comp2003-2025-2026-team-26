import { getFirestore } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-storage.js";
import { loginApp } from "./auth.js";

export const LOGBOOK_APP_NAME = "friarymill-login-app";

export const logbookFirebaseConfig = Object.freeze({ ...loginApp.options });
export const logbookApp = loginApp;

export const db = getFirestore(logbookApp);
export const storage = getStorage(logbookApp);
