// ======================================================
// BLACKBOX LAB — ANDROID/WEB SMOKE TEST
// ======================================================
//
// Drives the www/ build in Chromium at phone size, with
// touch on, to catch what the Electron smoke test cannot:
// the drawer, the platform bridge, and whether an 8 MB
// .bbl still decodes when it is fetched as a web asset
// instead of arriving over Electron IPC.
//
// Run:  npm run build:web && node tools/android-smoke.mjs
//
// ======================================================

import { chromium, devices } from "playwright-core";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { mkdirSync } from "node:fs";

const WWW = new URL("../www/", import.meta.url).pathname;
const PORT = 4173;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".bbl": "application/octet-stream",
  ".png": "image/png"
};

// ---- static server ----

const server = createServer(async (request, response) => {
  const path = decodeURIComponent(request.url.split("?")[0]);
  const relative = normalize(path).replace(/^(\.\.[/\\])+/, "");
  const file = join(WWW, relative === "/" ? "index.html" : relative);

  try {
    const info = await stat(file);

    if (!info.isFile()) {
      throw new Error("not a file");
    }

    response.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Content-Length": info.size
    });

    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end("not found");
  }
});

await new Promise((resolve) => server.listen(PORT, resolve));

// ---- browser ----

mkdirSync("smoke-shots", { recursive: true });

// PLAYWRIGHT_CHROMIUM lets CI point at whatever Chromium it has;
// falling back to Playwright's own resolution locally.
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined
});

const context = await browser.newContext({
  ...devices["Pixel 7"]
});

const page = await context.newPage();

const problems = [];
page.on("pageerror", (error) => problems.push(`PAGEERROR: ${error.message}`));
page.on("console", (message) => {
  // The update check calls api.github.com. Offline or behind a
  // proxy that is a network fact, not a port defect — the app
  // already degrades quietly. Only our own assets must be clean.
  // The failing URL is on location(), not in the message text.
  const source = `${message.location()?.url ?? ""} ${message.text()}`;

  if (message.type() === "error" && !/github\.com/.test(source)) {
    problems.push(`CONSOLE: ${message.text()}`);
  }
});
page.on("requestfailed", (request) => {
  if (request.url().startsWith(`http://127.0.0.1:${PORT}`)) {
    problems.push(`REQUEST FAILED: ${request.url()}`);
  }
});

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
await page.waitForTimeout(600);

function check(label, condition) {
  console.log(`${condition ? "  ok" : "FAIL"}  ${label}`);

  if (!condition) {
    problems.push(`CHECK FAILED: ${label}`);
  }
}

// The consent ask fires on first run once an ingest endpoint exists.
if (await page.isVisible("#contributeAsk")) {
  await page.click("#askNo");
}

// ---- layout ----

check("mobile bar is visible", await page.isVisible(".mobile-bar"));

const sidebarOffscreen = await page.evaluate(() => {
  const sidebar = document.getElementById("appSidebar");
  return sidebar.getBoundingClientRect().right <= 1;
});
check("drawer starts off-canvas", sidebarOffscreen);

const noSideScroll = await page.evaluate(
  () => document.documentElement.scrollWidth <= window.innerWidth + 1
);
check("no horizontal overflow", noSideScroll);

// ---- drawer ----

await page.tap("#mobileMenuButton");
await page.waitForTimeout(350);

const sidebarOnscreen = await page.evaluate(() => {
  const sidebar = document.getElementById("appSidebar");
  return sidebar.getBoundingClientRect().left >= -1;
});
check("drawer opens on tap", sidebarOnscreen);

await page.tap('.nav-button[data-target="filter"]');
await page.waitForTimeout(350);

check(
  "drawer closes after picking a screen",
  await page.evaluate(
    () => !document.getElementById("appSidebar").classList.contains("open")
  )
);
check(
  "screen switched to Filter Lab",
  await page.evaluate(
    () =>
      document
        .querySelector('[data-screen="filter"]')
        ?.classList.contains("screen-active") ?? false
  )
);

// ---- platform bridge ----

check(
  "window.blackboxLab installed without Electron",
  await page.evaluate(() => typeof globalThis.blackboxLab?.readSampleLog)
    === "function"
);

check(
  "sample manifest reachable",
  (await page.evaluate(() => globalThis.blackboxLab.listSampleLogs()))
    .includes("sample-bell-222ut.bbl")
);

// ---- the real work: decode an 8 MB log in the WebView ----

await page.tap("#mobileMenuButton");
await page.waitForTimeout(300);
await page.tap('.nav-button[data-target="home"]');
await page.waitForTimeout(300);

// The welcome panel's button is the visible entry point; the one
// in the log card stays hidden until a log is loaded.
const started = Date.now();
await page.tap("#welcomeSampleButton");

await page.waitForFunction(
  () => {
    const name = document.getElementById("summaryFileName")?.textContent ?? "";
    return name && name !== "---";
  },
  { timeout: 120000 }
);

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`  ok  8 MB sample decoded and analysed in ${seconds}s`);

check(
  "verdict rendered",
  await page.evaluate(
    () => (document.getElementById("verdictCard")?.textContent ?? "").length > 60
  )
);

await page.screenshot({
  path: "smoke-shots/android-home.png",
  fullPage: false
});

await page.tap("#mobileMenuButton");
await page.waitForTimeout(250);
await page.tap('.nav-button[data-target="filter"]');
await page.waitForTimeout(1200);
await page.screenshot({ path: "smoke-shots/android-filter-lab.png" });

// ---- report ----

// ---- desktop layout must survive ----
//
// index.html and index.css are shared with the Electron build,
// so a mobile change that broke the desktop sidebar would ship
// to Windows and macOS too.

const desktop = await browser.newContext({
  viewport: { width: 1280, height: 900 }
});

const desktopPage = await desktop.newPage();
await desktopPage.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
await desktopPage.waitForTimeout(400);

check(
  "desktop: sidebar visible",
  await desktopPage.isVisible("#appSidebar")
);
check(
  "desktop: mobile bar hidden",
  !(await desktopPage.isVisible(".mobile-bar"))
);
check(
  "desktop: sidebar is in normal flow (not a drawer)",
  await desktopPage.evaluate(() => {
    const sidebar = document.getElementById("appSidebar");
    return getComputedStyle(sidebar).position === "static";
  })
);

await browser.close();
server.close();

console.log("");

if (problems.length) {
  console.error(`${problems.length} problem(s):`);
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}

console.log("android smoke test passed — shots in smoke-shots/");
