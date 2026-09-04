# Android port — working log

How the port was actually arrived at: what was measured, what the
measurements changed, and which reasonable-looking ideas turned out
to be wrong. `ANDROID.md` describes the result; this describes the
route, so the next person does not have to rediscover it.

Every number here is reproducible. Where a figure appears, the
command that produced it is next to it.

---

## 1. Establishing that this was a shell problem, not a port

The first question was how much of the app was actually tied to
Electron. Counting imports rather than assuming:

```
grep -rn "require(" src/ --include=*.js | grep -E "electron|node:"
```

Two files, 105 lines: `src/index.js` (main process) and
`src/preload.js`. Everything else — the ~11,000 lines of analysis and
the ~4,000 of UI — was already plain ES modules with no Node or
Electron dependency. State was `localStorage`, file input was
`FileReader`, networking was `fetch`.

That reframed the job. The app did not need porting; it needed a
different shell around it. Capacitor, keeping one codebase and both
targets, rather than React Native or a rewrite.

The whole Electron surface was three IPC handlers:
`list-sample-logs`, `read-sample-log`, `open-external`. So
`src/platform/bridge.js` provides the same three methods and stands
aside when Electron's preload has already run — which is why no call
site in `renderer.js` changed.

---

## 2. What a phone needed that the desktop did not

Mostly predictable, and confirmed in the browser at Pixel 7 size:

- **The viewport meta tag.** Without it Android lays the page out at
  980px and scales down. Nothing else matters until this is right.
- **A drawer.** The fixed 250px sidebar becomes off-canvas below
  760px. The content grids already used
  `repeat(auto-fit, minmax(...))` and only needed their floors
  trimmed — worth checking before writing new CSS.
- **`100dvh`, not `100vh`.** Android's collapsing URL bar makes
  `100vh` taller than the screen and buries the last card.
- **`accept="*/*"` on Android.** The document picker filters by MIME
  type, and there is no MIME mapping for `.bbl` — the honest accept
  list greys out precisely the files the app exists to open.
- **The share sheet.** `Blob` + `<a download>` is swallowed silently
  by a WebView: no file, no error.
- **`touch-action: pan-y` on `.u-over`.** uPlot binds mouse events;
  Chrome only synthesises those from touch when it is not already
  using the gesture to scroll.

Two smaller things surfaced only by running it: a `favicon.ico` 404,
and the update check failing against `api.github.com` behind a proxy.
The second is environmental, so the smoke test ignores console errors
from `github.com` rather than pretending the app is broken.

---

## 3. The performance work

### The prediction was wrong

Going in, the expectation was that decoding an 8 MB `.bbl` would be
the bottleneck — it materialises the flight plus a CSV-shaped copy,
about 42 MB of strings. Loading the sample took **28 seconds**, which
seemed to confirm it.

Profiling said otherwise:

```
npm run build:web && node tools/profile-load.mjs
```

| stage | time |
|---|---|
| `decodeBblFile` | 0.8s |
| `decodedFlightToCsvLines` | 0.7s |
| everything else | ~26s |

Decoding was 5% of the problem. The cost was in *reading* the CSV
afterwards.

### The actual cause

Analysis consumes the log as CSV text. A telemetry row has ~40
columns (95 in this sample), so `split(",")[i]` allocates a string
per column and discards all but one — once per row, per column read,
across 134,429 rows. Roughly 90 million throwaway allocations.

`fieldAt(line, index)` in `mathHelpers.js` scans to the requested
comma and slices once.

**The subtle part, and the reason for `test/fieldAt.test.mjs`:** a
naive implementation returns `""` for a column past the end of the
row. `split(",")[i]` returns `undefined`. That difference is not
cosmetic — `Number("")` is `0` and passes `Number.isFinite`, so
missing telemetry would silently become a real zero and the analysis
would report on data that was never logged. `fieldAt` returns
`undefined`, and the test asserts equivalence across 352,740 field
reads on a real flight plus the awkward rows.

**28s → 10s.**

> **Superseded upstream, and rightly.** `fieldAt` shipped in this
> fork at v0.3.7. Upstream reached the same measurement independently
> and fixed it a level deeper: `analysis/columnTable.js` splits each
> line **once** into a `Float64Array` per column, cached per lines
> array in a `WeakMap` so the engine, the labs and the renderer share
> one parse. `fieldAt` only made each read cheaper — it still rescanned
> the row on every access. Upstream's header records the same profile
> this log does ("decode 0.85 s, engine 25 s"), which is a useful
> reassurance that both of us were looking at a real effect rather
> than at our own instrumentation.
>
> The v1.8.0 merge therefore deletes `fieldAt` and
> `test/fieldAt.test.mjs` and takes `columnTable.js` wholesale. The
> section below is kept because the reasoning still holds and the
> `""` vs `undefined` trap it describes is a live hazard for anyone
> touching CSV field reads here — `columnTable` documents the same
> distinction in its own header, having hit it too.

A detail worth knowing: `buildColumnTable` in the renderer already
existed to solve exactly this, with a comment saying so — but
`alignedColumnValues`, immediately below it, bypassed it and
re-split every row. The optimisation was there; one caller just
wasn't using it.

### Then: it was still ten seconds of frozen app

Ten seconds is ten seconds, and on the main thread the UI is dead for
all of it — no spinner, no scrolling. So decode and analysis moved
into `src/workers/analysisWorker.js`.

This does not make it faster. It makes the app keep running:
**hundreds of animation frames drawn during the load** (246 on
v1.8.0), where before the whole thing was one unbroken stall. The
smoke test asserts the longest frame gap, so a regression back onto
the main thread fails CI.

What made it possible was that section 04 of `renderer.js` was pure
computation with zero DOM references — verified before moving it, not
assumed. It moves out to `analysis/datasetBuilder.js` unchanged, and
is re-extracted on each upstream merge rather than merged, because it
is upstream's code living in a different file. After v1.8.0 it is
~880 lines, and the extraction is checked line-for-line against their
section 04: the only differences should be the four `export` keywords
and the added `columnTable` field.

**Moving analysis off the thread stopped being sufficient at
v1.8.0.** Drawing the answer — replay, pack cards, the health record,
several more labs — blocked the main thread for 3.2s on its own,
while the worker sat idle. Two `requestAnimationFrame` yields in
`analyzeFlight` break that into paintable pieces: longest stall
3190ms → 1460ms, and the verdict appears at 4.2s instead of 9.2s
because it is no longer trapped behind the labs in a single task.

---

## 4. Things that did not work

Recorded because each cost time and none is obvious from the diff.

**The dataset could not be cloned.** It carries two closures,
`columnValues` and `findColumnsIn`, and `postMessage` rejects
functions outright. `buildDataset` now also carries the `columnTable`
and `headerLine` they close over, and `attachDatasetAccessors`
rebuilds them on arrival. Anything added to the dataset must survive
structured clone.

**The first fallback was broken, and hid the bug above.** When the
worker failed after a successful load, the in-place path had no
decoded log to work from, so it returned `null` and the UI just
stopped — swallowing the real error. Every entry point now takes the
flight's lines as an argument instead of relying on client-held
state, and failures log instead of vanishing. If a worker path ever
appears to do nothing, suspect a swallowed error first.

**`CHART_COLORS` dragged uPlot into the worker.** The extracted
dataset code imported it from `ui/charts.js`, which needs a DOM. Hence
`ui/chartColors.js`. Any import from analysis into `ui/` is a bug
waiting to happen.

**Playwright's `waitForFunction` signature is `(fn, arg, options)`.**
The timeout was being passed as `arg` and silently ignored. It
appeared to work only because the load finished inside the 30s
default.

**A 21s smoke-test result was measurement noise**, from a concurrent
`build:web` competing for CPU. Re-running gave 8–9s. Take a single
timing on a loaded machine with suspicion.

---

## 5. Getting results back across the thread boundary

The naive handover was expensive enough to matter, so it was measured
rather than guessed:

| payload | cost |
|---|---|
| lines as an array of 134k strings | ~430ms |
| lines as one joined string | ~145ms (+20ms to split back) |
| 95-column table (12.7M numbers) as plain arrays | ~434ms |
| same as `Float64Array`, copied | ~920ms |
| same as `Float64Array`, **transferred** | **3ms** |

So: lines cross as one joined string, and the column table as
transferable `Float64Array` buffers, which move rather than copy.
Transfer also leaves only one copy alive, which matters more on a
phone than the milliseconds do.

`Float64Array` is a safe substitute here because every consumer uses
`for...of`, `.map`, `.length` or indexing, all of which typed arrays
support — checked before relying on it. It holds only finite numbers;
the null-preserving aligned columns are internal to `buildDataset`
and never exposed.

---

## 6. What is verified, and what is not

Verified in the sandbox and on a GitHub runner:

- 475 tests pass (upstream's suite, after the v1.8.0 merge).
- 18 smoke checks at Pixel 7 size: drawer, bridge, no horizontal
  overflow, an 8 MB log decoding to a rendered verdict, Compare
  Flights, and the UI staying responsive throughout.
- The **in-place path** (Electron's, reproduced by deleting
  `window.Worker`) still produces a verdict.
- The desktop layout at 1280×900 still holds.
- The APK assembles. CI does this on every push.

### On a real device

First run on physical hardware — an Android tablet, debug APK from
CI, landscape:

- **~4s from opening a log to the first chart.** Faster than the
  ~6–10s the sandbox predicted, which is the expected direction:
  the profiler's budget is dominated by parse work, and a real ARM
  device with a warm WebView does not pay the sandbox's startup tax.
- **The UI stayed interactive while the log loaded.** This is the
  worker earning its place. On the in-place path — which is what
  Electron runs — the same work blocks the thread; on device it did
  not. It is the one behaviour that could not be proven anywhere but
  on hardware.
- The app rendered a verdict from a real flight: vibration and rotor
  speed findings, with their "what to do" lines intact.

The tablet is wider than the 760px breakpoint, so it exercised the
**desktop sidebar layout, not the mobile drawer** — the drawer is
still unverified on hardware.

Still unknown:

- Whether memory survives — 41 MB of lines per thread plus 97 MB of
  columns — even with `largeHeap`. A single successful load is not
  evidence about the ceiling; a long log on a smaller phone is the
  test that matters.
- Whether the file picker surfaces `.bbl` files through a real SAF
  provider. Unknown because the run above did not establish which
  path opened the log.
- Whether touch zoom and the share sheet behave as documented.
- Anything at phone size, on a phone.

If memory is the thing that breaks, the fix is structural and half
done. Upstream's `columnTable.js` removed the repeated parsing; what
remains is the round-trip itself, where decoded frames are rendered
to CSV text (`bbl/csvAdapter.js`) for every consumer to parse back.
Removing that would drop the 42 MB of strings as well, and would
speed up the desktop app too.

---

## 7. Retracing this

Commits are ordered so each is reviewable on its own:

| commit | what | after v1.8.0 |
|---|---|---|
| `5d1fa23` | Capacitor shell, mobile layout, platform bridge | kept |
| `5b2f3cb` | `fieldAt` — 28s → 10s | **dropped** — see above |
| `4092771` | CI, APK build, `ANDROID.md` | kept |
| `123b663` | The analysis worker | kept, plus render yields |

The merge into upstream v1.8.0 is `e0e1fed`. Two of the five commits
did not survive it, which is the honest outcome of a fork sitting
still for 293 upstream commits.

To rebuild any point in the history:

```
git checkout <commit>
npm ci
npm run android:build        # needs the Android SDK
```

CI artifacts expire after 90 days; rebuilding from a commit does not.

To re-derive the performance numbers:

```
npm run build:web
node tools/profile-load.mjs               # worker path
node tools/profile-load.mjs --no-worker   # in-place path, as Electron runs it
```

The `--no-worker` profile is the interesting one for optimisation
work, since it shows the analysis costs on the thread being profiled.
