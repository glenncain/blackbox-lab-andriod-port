# Blackbox Lab — Android port

Rotorflight blackbox log analysis. This fork adds an **Android
build** to the existing Electron desktop app. One codebase, two
targets; the desktop build must keep working.

Upstream is `hillbilly1975/Blackbox_Lab`. This branch is based on
upstream history, so `git merge upstream/main` works:

```
git remote add upstream https://github.com/hillbilly1975/blackbox_lab
git fetch upstream
```

**Read `Documentation/ANDROID-PORT-LOG.md` before changing anything
in the port.** It records what was measured, what was tried, and
which obvious-looking approaches are already known to be wrong.
`Documentation/ANDROID.md` is the reference for how the port works.

---

## Commands

```
npm install
npm start                # Electron desktop app
npm test                 # 65 tests, node --test

npm run build:web        # src/ + samples/ -> www/  (generated, gitignored)
npm run android:sync     # build:web, then copy into android/
npm run android:build    # assemble a debug APK
npm run android:open     # open in Android Studio

node tools/android-smoke.mjs    # needs build:web first
node tools/profile-load.mjs     # CPU profile of opening a log
```

`npm run android:build` needs the Android SDK (platform 35) and JDK
21. CI builds the APK on every push and uploads it as an artifact,
so a machine without the SDK can still get one.

The smoke test and profiler need a Chromium; set
`PLAYWRIGHT_CHROMIUM` if Playwright cannot find one. `playwright-core`
does not download browsers.

---

## Layout

```
src/
  index.js, preload.js     Electron only — excluded from the Android build
  index.html               All screens (one <section data-screen> each)
  index.css                Styling, incl. the mobile drawer at <=760px
  renderer.js              Wiring: file -> analysis -> draw. DOM lives here.
  platform/
    bridge.js              window.blackboxLab when Electron's preload has not run
    mobile.js              Nav drawer, Android file-picker widening
  workers/
    analysisWorker.js      Decode + analysis off the main thread
  analysis/
    analysisClient.js      Main thread's half of the worker, with in-place fallback
    datasetBuilder.js      Was section 04 of renderer.js. Pure. Builds the dataset.
    mathHelpers.js         fieldAt lives here — read its comment before touching it
    bbl/                   Native .bbl decoder
    dsp/fft.js             FFT + Welch noise spectrum
  ui/
    charts.js              uPlot wrappers (needs a DOM)
    chartColors.js         Palette, split out so the worker can use it
scripts/build-web.mjs      src/ -> www/
tools/                     Smoke tests and the load profiler
android/                   Capacitor project (committed; www/ inside it is not)
```

---

## Things that will bite you

**`www/` is generated.** Edit `src/`. Anything written to `www/` is
destroyed by the next `build:web`.

**No bundler.** `index.html` loads raw ES modules off disk. There is
no build step resolving bare specifiers, so `import { X } from
"@capacitor/browser"` will not work — Capacitor plugins are reached
through `globalThis.Capacitor.Plugins` instead. Vendored deps live in
`src/vendor/`.

**`index.html` and `index.css` are shared with the desktop build.** A
mobile-only CSS change ships to Windows and macOS too. The smoke test
checks the desktop layout for this reason.

**Electron does not get the worker.** It loads from `file://`, where
Chromium refuses module workers. `analysisClient` detects that and
runs in place. Both paths must keep working; CI exercises both. If
you add analysis work, put it behind `analysisClient`, not directly
in `renderer.js`.

**Anything the worker imports must not touch the DOM.** That is why
`datasetBuilder.js` and `chartColors.js` are separate modules. Import
`ui/charts.js` from analysis code and the worker dies at load.

**Worker results must survive structured clone.** No functions. The
dataset carries `columnTable` and `headerLine` so `attachDatasetAccessors`
can rebuild its two closures on the far side. Large numeric arrays
should cross as transferable `Float64Array` buffers, not plain arrays
— see the log for the measurements.

**Performance work belongs in `analysis/`, not the renderer.** The
dominant remaining cost is that decoded frames are rendered to
CSV-shaped text (`bbl/csvAdapter.js`) and every consumer parses it
back. Profile before optimising: `node tools/profile-load.mjs`.

---

## Conventions

Match the surrounding code — it has a distinct voice and it is
deliberate.

- Comments explain **why**, not what, and are written in prose for a
  human maintainer. Several load-bearing decisions are only recorded
  in comments; do not strip them.
- Section banners (`// ==== 04. DATASET ====`) organise the long
  files. Keep them accurate when moving code.
- Two-space indent, double quotes, semicolons. No linter is
  configured (`npm run lint` is a stub), so nothing will catch drift
  but review.
- User-facing strings are plain English, calm, and never alarmist —
  "could not be measured" rather than a fake number. The app tells a
  pilot what happened and what to do about it.

## Before you claim something works

`npm test` covers the analysis modules. It does **not** cover the
renderer, the layout, the platform bridge, or the worker — only
`tools/android-smoke.mjs` does, and it needs `npm run build:web`
first. Run both.

Neither runs on a real phone. One tablet run confirmed a ~4s load
and a responsive UI, but memory under a long log, the file picker,
and everything at phone size are still unverified; see the end of
the port log.
