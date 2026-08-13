// ======================================================
// BLACKBOX LAB — PLATFORM BRIDGE
// ======================================================
//
// The desktop app gets window.blackboxLab from Electron's
// preload. Nothing else in the app knows or cares where it
// came from — so this module installs the same three
// methods for the Android (Capacitor) and plain-browser
// builds, and the renderer stays unchanged.
//
// Importing this module installs the bridge. Under Electron
// the preload has already run, so it stands aside.
//
// ======================================================

// Same allowlist the Electron main process enforces: only
// the project's own release pages leave the app.
const ALLOWED_EXTERNAL_PREFIX =
  "https://github.com/hillbilly1975/Blackbox_Lab";

export const isNativePlatform = Boolean(
  globalThis.Capacitor?.isNativePlatform?.()
);

export const isAndroid =
  isNativePlatform &&
  globalThis.Capacitor?.getPlatform?.() === "android";

// Capacitor injects its plugins as globals in the WebView.
// Blackbox Lab has no bundler, so this is the supported way
// to reach them — there is no import to resolve.
function plugin(name) {
  return globalThis.Capacitor?.Plugins?.[name] ?? null;
}

// ---- sample flights ----
//
// The desktop app lists and reads samples/ over IPC. In a
// WebView there is no filesystem to walk, so the samples ship
// as web assets with a manifest baked in by scripts/build-web.mjs.

async function listSampleLogs() {
  try {
    const response = await fetch("./samples/manifest.json");

    if (!response.ok) {
      return [];
    }

    const names = await response.json();

    return Array.isArray(names) ? names : [];
  } catch {
    return [];
  }
}

async function readSampleLog(name) {
  // Mirrors the main process's path.basename() guard.
  const safeName = String(name).split(/[\\/]/).pop();

  if (!safeName.toLowerCase().endsWith(".bbl")) {
    return null;
  }

  try {
    const response = await fetch(`./samples/${safeName}`);

    if (!response.ok) {
      return null;
    }

    // The renderer wraps this in new Uint8Array(bytes), which
    // accepts a Uint8Array just as happily as Electron's Buffer.
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

async function openExternal(url) {
  if (typeof url !== "string" ||
      !url.startsWith(ALLOWED_EXTERNAL_PREFIX)) {
    return;
  }

  const browser = plugin("Browser");

  if (browser) {
    await browser.open({ url });
    return;
  }

  globalThis.open(url, "_blank", "noopener");
}

// ---- report export ----
//
// Blob + <a download> is a no-op in an Android WebView: the
// anchor click is swallowed and the pilot gets nothing. On
// native the report goes to cache and out through the share
// sheet instead, which is also how you'd get it off the phone.

export async function saveReport(html, fileName) {
  const filesystem = plugin("Filesystem");
  const share = plugin("Share");

  if (!filesystem || !share) {
    return false;
  }

  await filesystem.writeFile({
    path: fileName,
    data: html,
    directory: "CACHE",
    encoding: "utf8"
  });

  const { uri } = await filesystem.getUri({
    path: fileName,
    directory: "CACHE"
  });

  await share.share({
    title: fileName,
    files: [uri]
  });

  return true;
}

// ---- install ----

if (!globalThis.blackboxLab) {
  globalThis.blackboxLab = {
    readSampleLog,
    openExternal,
    listSampleLogs
  };
}
