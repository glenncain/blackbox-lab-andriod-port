# Blackbox Lab on Android

Blackbox Lab runs on Android through [Capacitor](https://capacitorjs.com):
the existing app is loaded into a native WebView, with a small
bridge standing in for the things Electron used to provide.

This is a port of the shell, not of the app. The analysis modules
(`src/analysis/**`, ~11,000 lines) and the whole UI layer had no
Node or Electron dependencies to begin with — only `src/index.js`
and `src/preload.js`, 105 lines between them, were desktop-specific.
Those two files are excluded from the Android build and replaced by
`src/platform/bridge.js`.

One codebase serves both targets. The Electron build is unchanged
and `npm start` still runs the desktop app.

---

## Building

You need the Android SDK (platform 35) and a JDK 21. Android Studio
installs both; `ANDROID_HOME` must point at the SDK.

```
npm install
npm run android:sync     # build www/ and copy it into android/
npm run android:open     # open the project in Android Studio
npm run android:run      # build and launch on a connected device
npm run android:build    # assemble a debug APK, no Studio needed
```

The debug APK lands in
`android/app/build/outputs/apk/debug/`.

CI builds it on every push and attaches it as an artifact; see
`.github/workflows/ci.yml`.

### Releasing

Release builds need a signing keystore, which is deliberately not in
this repository — `*.jks`, `*.keystore` and
`android/keystore.properties` are gitignored. Generate one with
`keytool`, reference it from `android/app/build.gradle`, and keep it
somewhere durable: Play Store updates must be signed with the same
key as the original upload, and losing it means losing the ability
to update the listing.

---

## How the pieces fit

### `scripts/build-web.mjs` → `www/`

Blackbox Lab has no bundler; `index.html` loads raw ES modules
straight off disk. So the "build" is a copy: `src/` minus the two
Electron files, plus `samples/` and a generated `manifest.json`.
`www/` is generated and gitignored — never edit it.

### `src/platform/bridge.js`

Installs `window.blackboxLab` with the same three methods Electron's
preload exposes (`readSampleLog`, `listSampleLogs`, `openExternal`).
Under Electron the preload has already run and this module stands
aside, so every call site in `renderer.js` is untouched and the
desktop behaviour is unchanged.

The guards from the Electron main process are preserved: sample
names are still reduced to a basename and must end in `.bbl`, and
`openExternal` still only passes the project's own GitHub URLs.

Capacitor plugins are reached through `window.Capacitor.Plugins`
rather than imported, because there is no bundler to resolve an
`@capacitor/...` specifier.

### `src/platform/mobile.js`

The navigation drawer, and the file-picker widening described below.

---

## What Android needed that the desktop did not

**The viewport meta tag.** Without it Android renders the page at
980 CSS pixels and scales it down; everything is unreadably small.
This is the single change without which nothing else matters.

**A drawer instead of a sidebar.** The desktop layout is a fixed
250px sidebar beside a scrolling workspace. Under 760px the sidebar
becomes an off-canvas drawer behind a top app bar. The content grids
already used `repeat(auto-fit, minmax(...))`, so they only needed
their floors trimmed.

**`100dvh`, not `100vh`.** Android's collapsing URL bar makes `100vh`
taller than the visible screen, which buries the last card.

**A wider file picker.** Android's document picker filters by MIME
type, not by file extension, and there is no MIME mapping for `.bbl`
or `.bfl`. The honest `accept` list therefore greys out exactly the
files this app exists to open. On Android only, the inputs are
widened to `*/*`; the app already identifies logs by content rather
than by name.

**The share sheet instead of a download.** `Blob` + `<a download>` is
silently swallowed by an Android WebView — no file, no error. Reports
now go to cache and out through the share sheet, which is also how
they leave the phone.

**`touch-action: pan-y` on the chart surface.** uPlot binds mouse
events, and Chrome only synthesises those from touch when the browser
is not already consuming the gesture to scroll. `pan-y` hands
horizontal drags (zoom) to the chart and keeps vertical scrolling for
the page.

**`largeHeap`.** Decoding an 8 MB `.bbl` materialises the decoded
flight plus a CSV-shaped copy of it — about 42 MB of strings. The
default per-app heap is not comfortable on mid-range phones.

---

## Performance

Loading the 8 MB `sample-bell-222ut.bbl` originally took **28 seconds**
in a WebView. Profiling showed decoding was almost none of it:

| stage | time |
|---|---|
| `decodeBblFile` | 0.8s |
| `decodedFlightToCsvLines` | 0.7s |
| re-splitting rows to read columns | ~23s |

Analysis reads the log as CSV text. A telemetry row has ~40 columns,
so `split(",")[i]` allocated 40 strings and discarded 39 — once per
row, per column read, over 134,429 rows. Reading a single field
directly instead (`fieldAt` in `mathHelpers.js`) brought the load
down to **10 seconds**.

That figure is from desktop-class hardware; expect a phone to be
slower. Two things would help further, in order of value:

1. **Stop round-tripping frames through CSV text.** `csvAdapter.js`
   exists so the analysis modules did not have to change when native
   `.bbl` decoding arrived — a reasonable trade then, and now the
   dominant remaining cost. Having analysis read frame objects
   directly would remove both the 42 MB of strings and the parsing.
2. **Move the work to a Web Worker.** The load is entirely on the
   main thread, so the UI is frozen while it runs. A worker would not
   make it faster but would let the progress indicator actually move.

Neither is Android-specific; both would speed up the desktop app too.

---

## Testing

```
npm test                 # the existing 62-test suite, unchanged
npm run build:web && node tools/android-smoke.mjs
```

`tools/android-smoke.mjs` drives the `www/` build in Chromium at
Pixel 7 size with touch enabled, and checks the drawer, the platform
bridge, horizontal overflow, and that the 8 MB sample still decodes
and produces a verdict. It then re-checks the same build at 1280×900
to confirm the desktop layout still holds — `index.html` and
`index.css` are shared with the Electron build, so a mobile-only
change can reach Windows and macOS.

Set `PLAYWRIGHT_CHROMIUM` to a Chromium binary if Playwright cannot
find one.

Screenshots land in `smoke-shots/`.

---

## Not done yet

- **Opening `.bbl` files from other apps.** An intent filter would let
  a pilot tap a log in their file manager or a Discord attachment and
  land in Blackbox Lab. This needs `MainActivity` to hand the incoming
  `content://` URI to the WebView.
- **Landscape and tablet layouts.** The breakpoint is a single 760px
  step; a tablet currently gets the desktop layout, which is roughly
  right but untuned.
- **A Play Store listing.** Nothing here assumes one — the debug APK
  sideloads fine.
