import { logoutUser } from "./auth.js";

const logoutBtn = document.getElementById("logoutBtn");

if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    logoutBtn.disabled = true;
    try {
      await logoutUser();
      window.location.href = "../login/index.html";
    } catch (error) {
      console.error("Logout failed:", error);
      logoutBtn.disabled = false;
      if (typeof styledAlert === "function") {
        await styledAlert("Logout failed. Please try again.", "Error");
      } else {
        alert("Logout failed. Please try again.");
      }
    }
  });
}
