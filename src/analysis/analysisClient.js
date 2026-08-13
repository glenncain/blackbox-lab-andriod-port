// ======================================================
// BLACKBOX LAB — ANALYSIS CLIENT
// ======================================================
//
// The main thread's half of the analysis worker. Hands the
// heavy work to a Web Worker when there is one, and does it
// in place when there is not, returning the same shapes
// either way so the renderer cannot tell the difference.
//
// There is not always one. Electron loads the app from
// file://, and Chromium refuses module workers on that
// origin, so the desktop build runs the in-place path — the
// same code on the same thread it has always used. Android
// serves the app over https:// through Capacitor, so the
// phone, where the freeze actually hurts, gets the worker.
//
// Every entry point takes the flight's lines as an argument
// rather than relying on state held here, so if the worker
// dies mid-session the in-place path can pick up the work
// without having to decode the file again.
//
// ======================================================

import { readLogFile } from "./logFileReader.js";
import { buildLogAnalysis } from "./logAnalysisBuilder.js";
import {
  buildDataset,
  attachDatasetAccessors
} from "./datasetBuilder.js";
import { aircraftProfiles } from "../profiles/aircraftProfiles.js";

let worker = null;
let workerFailed = false;
let nextRequestId = 1;

// Module workers cannot be constructed from file://, and the
// failure surfaces as a console error rather than a throw we
// could catch — so do not try.
function workerIsPossible() {
  return (
    typeof Worker === "function" &&
    globalThis.location?.protocol !== "file:"
  );
}

function getWorker() {
  if (worker || workerFailed || !workerIsPossible()) {
    return worker;
  }

  try {
    worker = new Worker(
      new URL("../workers/analysisWorker.js", import.meta.url),
      { type: "module" }
    );

    worker.addEventListener("error", (event) => {
      console.warn("Analysis worker failed, continuing in place:", event.message);
      retireWorker();
    });
  } catch (error) {
    console.warn("Analysis worker unavailable, continuing in place:", error);
    retireWorker();
  }

  return worker;
}

function retireWorker() {
  workerFailed = true;

  if (worker) {
    worker.terminate();
    worker = null;
  }
}

export const usingWorker = () => Boolean(getWorker());

function request(type, payload, onProgress) {
  const active = getWorker();

  if (!active) {
    return null;
  }

  const id = nextRequestId;
  nextRequestId += 1;

  return new Promise((resolve, reject) => {
    const handle = (event) => {
      const message = event.data;

      if (message.id !== id) {
        return;
      }

      if (message.type === "progress") {
        onProgress?.(message.stage);
        return;
      }

      active.removeEventListener("message", handle);

      if (message.type === "error") {
        reject(new Error(message.message));
      } else {
        resolve(message.result);
      }
    };

    active.addEventListener("message", handle);
    active.postMessage({ id, type, ...payload });
  });
}

// Runs a worker request, and on any failure retires the worker
// and does the work in place instead. A pilot with a big log
// should never see an error because a worker died.
async function withFallback(attempt, inPlace) {
  if (usingWorker()) {
    try {
      return await attempt();
    } catch (error) {
      console.warn("Analysis worker failed, continuing in place:", error);
      retireWorker();
    }
  }

  return inPlace();
}

// Undo flightsForTransfer: one joined string back into lines.
function restoreFlights(flights) {
  return flights.map((flight) => ({
    label: flight.label,
    decodeInfo: flight.decodeInfo,
    stats: flight.stats,
    lines: flight.csvText.split("\n")
  }));
}

function analyzeInPlace(lines, fileType, onProgress) {
  onProgress?.("Reading the telemetry…");

  const {
    extraSummary,
    telemetryText,
    filterAnalysis,
    pidAnalysis
  } = buildLogAnalysis({ fileType, lines, aircraftProfiles });

  onProgress?.("Working out what happened…");

  return {
    extraSummary,
    telemetryText,
    filterAnalysis,
    pidAnalysis,
    dataset: buildDataset(lines, pidAnalysis)
  };
}

export async function loadLog(file, onProgress) {
  const logData = await withFallback(
    async () => {
      const result = await request("load", { file }, onProgress);

      if (!result || result.flights.length === 0) {
        return null;
      }

      return {
        file,
        sizeKb: result.sizeKb,
        fileType: result.fileType,
        isBinary: result.isBinary,
        flights: restoreFlights(result.flights)
      };
    },
    async () => {
      onProgress?.("Decoding the log…");
      return readLogFile(file);
    }
  );

  return logData && logData.flights.length > 0 ? logData : null;
}

export async function analyzeFlightData(
  { flightIndex, lines, fileType },
  onProgress
) {
  const analysis = await withFallback(
    () => request("analyze", { flightIndex }, onProgress),
    () => analyzeInPlace(lines, fileType, onProgress)
  );

  if (analysis?.dataset) {
    attachDatasetAccessors(analysis.dataset);
  }

  return analysis;
}

// Compare Flights: a second log, analysed without disturbing
// the one already on screen.
export async function datasetForFile(file, onProgress) {
  const result = await withFallback(
    () => request("dataset", { file }, onProgress),
    async () => {
      const log = await readLogFile(file);
      const flight = log?.flights?.[0];

      if (!flight) {
        return null;
      }

      const { pidAnalysis } = buildLogAnalysis({
        fileType: log.fileType,
        lines: flight.lines,
        aircraftProfiles
      });

      return {
        dataset: buildDataset(flight.lines, pidAnalysis),
        pidAnalysis
      };
    }
  );

  if (result?.dataset) {
    attachDatasetAccessors(result.dataset);
  }

  return result;
}
