// ======================================================
// BLACKBOX LAB — MOBILE SHELL BEHAVIOUR
// ======================================================
//
// Two things a phone needs that a desktop window does not:
// a sidebar that gets out of the way, and a file picker
// that can actually see .bbl files.
//
// ======================================================

import { isAndroid } from "./bridge.js";

// ---- navigation drawer ----

const sidebar = document.getElementById("appSidebar");
const scrim = document.getElementById("sidebarScrim");
const menuButton = document.getElementById("mobileMenuButton");

function setDrawer(open) {
  if (!sidebar || !scrim || !menuButton) {
    return;
  }

  sidebar.classList.toggle("open", open);
  scrim.hidden = !open;
  menuButton.setAttribute("aria-expanded", open ? "true" : "false");
  menuButton.setAttribute(
    "aria-label",
    open ? "Close navigation" : "Open navigation"
  );
}

if (menuButton) {
  menuButton.addEventListener("click", () => {
    setDrawer(!sidebar.classList.contains("open"));
  });
}

if (scrim) {
  scrim.addEventListener("click", () => setDrawer(false));
}

// Picking a screen (or opening a log) should hand the pilot
// straight back to the workspace. navigation.js adds its own
// listener to these buttons; ours just rides alongside.
for (const button of document.querySelectorAll(".nav-button")) {
  button.addEventListener("click", () => setDrawer(false));
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setDrawer(false);
  }
});

// ---- file picker ----
//
// Android's document picker filters by MIME type, not by
// extension. There is no MIME mapping for .bbl (or .bfl), so
// the honest accept list greys out exactly the files this app
// exists to open. Widening it is the only way through; the
// app already identifies logs by content, not by name.

if (isAndroid) {
  for (const input of document.querySelectorAll('input[type="file"]')) {
    input.setAttribute("accept", "*/*");
  }
}
