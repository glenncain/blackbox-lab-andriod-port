// ======================================================
// BLACKBOX LAB — LOAD PROFILER
// ======================================================
//
// CPU-profiles opening a log in the web build and prints the
// functions that actually cost time, by self-time.
//
// This is the tool the Android port's performance work was
// done with, kept so the numbers in
// Documentation/ANDROID-PORT-LOG.md can be re-derived rather
// than taken on trust — and so the next person optimising
// this does not start by guessing.
//
// Run:
//   npm run build:web
//   node tools/profile-load.mjs [sample-name.bbl]
//
// Set PLAYWRIGHT_CHROMIUM if Playwright cannot find a browser.
//
// Note it profiles the MAIN thread. Since analysis moved into
// a worker the interesting costs mostly moved with it, so pass
// --no-worker to profile the in-place path (which is also the
// path Electron takes).
//
// ======================================================

import { chromium, devices } from "playwright-core";
import { serveWww } from "./lib/serveWww.mjs";

const PORT = 4310;
const args = process.argv.slice(2);
const noWorker = args.includes("--no-worker");
const sample =
  args.find((value) => value.endsWith(".bbl")) ?? "sample-bell-222ut.bbl";

const server = await serveWww(
  new URL("../www/", import.meta.url).pathname,
  PORT
);

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined
});

const context = await browser.newContext({ ...devices["Pixel 7"] });
const page = await context.newPage();

if (noWorker) {
  await page.addInitScript(() => {
    delete globalThis.Worker;
  });
}

await page.goto(`${server.origin}/`, { waitUntil: "load" });
await page.waitForTimeout(500);

if (await page.isVisible("#contributeAsk")) {
  await page.click("#askNo");
}

const cdp = await context.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
await cdp.send("Profiler.start");

const started = Date.now();

// Load the sample straight through the platform bridge, so the
// profile covers the same path a pilot's own log would take.
await page.evaluate(async (name) => {
  const bytes = await globalThis.blackboxLab.readSampleLog(name);
  const file = new File([new Uint8Array(bytes)], name);

  // loadFromFile is not exported; the file input is the seam.
  const input = document.getElementById("logFileInput");
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change"));
}, sample);

await page.waitForFunction(
  () => {
    const name = document.getElementById("summaryFileName")?.textContent ?? "";
    return name && name !== "---";
  },
  undefined,
  { timeout: 300000 }
);

const seconds = ((Date.now() - started) / 1000).toFixed(1);
const { profile } = await cdp.send("Profiler.stop");

// Self time per function: the sample count attributed to a node
// is time spent in that function itself, not its callees.
const selfTime = new Map();
const nodesById = new Map(profile.nodes.map((node) => [node.id, node]));

for (let i = 0; i < profile.samples.length; i += 1) {
  const node = nodesById.get(profile.samples[i]);

  if (!node) {
    continue;
  }

  const frame = node.callFrame;
  const file = (frame.url || "").split("/").slice(-1)[0];
  const key = `${frame.functionName || "(anonymous)"}  ${file}:${frame.lineNumber + 1}`;

  selfTime.set(key, (selfTime.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0));
}

console.log(
  `\n${sample} loaded in ${seconds}s ` +
    `(${noWorker ? "in place" : "worker"}), main-thread self time:\n`
);

for (const [key, micros] of [...selfTime.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)) {
  console.log(`  ${(micros / 1e6).toFixed(2)}s  ${key}`);
}

await browser.close();
server.close();
