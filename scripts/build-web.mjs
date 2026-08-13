// ======================================================
// BLACKBOX LAB — WEB BUILD
// ======================================================
//
// Copies the app into www/ for the Android (Capacitor)
// build.
//
// Blackbox Lab has no bundler: index.html loads raw ES
// modules straight off disk. So "building" is a copy,
// minus the two Electron-only files, plus the sample
// flights (the desktop app reads those over IPC from
// samples/; on Android they ship as web assets).
//
// ======================================================

import { cp, mkdir, rm, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = join(projectRoot, "src");
const samplesDirectory = join(projectRoot, "samples");
const outputDirectory = join(projectRoot, "www");

// Electron's main process and preload have no meaning in a
// WebView — window.blackboxLab is installed by
// src/platform/bootstrap.js instead.
const ELECTRON_ONLY = new Set(["index.js", "preload.js"]);

async function copyApp() {
  await cp(sourceDirectory, outputDirectory, {
    recursive: true,
    filter: (source) => {
      const relative = source.slice(sourceDirectory.length + 1);

      // Only ever filter top-level files: a nested "index.js"
      // deeper in the tree is real application code.
      return !ELECTRON_ONLY.has(relative);
    }
  });
}

// The desktop app asks the main process which samples exist.
// In a WebView there is no directory listing, so the manifest
// is baked at build time and fetched at runtime.
async function copySamples() {
  const target = join(outputDirectory, "samples");
  await mkdir(target, { recursive: true });

  const names = (await readdir(samplesDirectory))
    .filter((name) => name.toLowerCase().endsWith(".bbl"))
    .sort();

  for (const name of names) {
    await cp(join(samplesDirectory, name), join(target, name));
  }

  await writeFile(
    join(target, "manifest.json"),
    JSON.stringify(names, null, 2) + "\n"
  );

  return names;
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await copyApp();
const samples = await copySamples();

console.log(`www/ built — ${samples.length} sample flights bundled.`);
