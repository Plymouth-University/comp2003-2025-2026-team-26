import { getApps, initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-storage.js";

export const LOGBOOK_APP_NAME = "friarymill-logbook-app";

export const logbookFirebaseConfig = Object.freeze({
  apiKey: "AIzaSyD--9gIymq-tT-o9CGp32W7GFtgXuGQeJw",
  authDomain: "dradanddrop-bb7c5.firebaseapp.com",
  projectId: "dradanddrop-bb7c5",
  storageBucket: "dradanddrop-bb7c5.firebasestorage.app",
  messagingSenderId: "907742522220",
  appId: "1:907742522220:web:4fd124ca048626c9e1e149",
  measurementId: "G-W83330W3GJ"
});

export const logbookApp =
  getApps().find((app) => app.name === LOGBOOK_APP_NAME) ||
  initializeApp(logbookFirebaseConfig, LOGBOOK_APP_NAME);

export const db = getFirestore(logbookApp);
export const storage = getStorage(logbookApp);
