// ======================================================
// BLACKBOX LAB — ANALYSIS WORKER
// ======================================================
//
// Decoding and analysing a large log takes seconds. On the
// main thread that freezes the app: no spinner, no scrolling,
// nothing. Here it runs beside the UI instead.
//
// Everything this imports is pure computation over the log —
// no DOM — which is what makes the move possible at all.
//
// Protocol (see analysisClient.js for the other half):
//
//   { id, type: "load",    file }        -> { flights, fileType, sizeKb }
//   { id, type: "analyze", flightIndex } -> { extraSummary, ... , dataset }
//   { id, type: "dataset", file }        -> { dataset }        (compare)
//
// plus unsolicited { id, type: "progress", stage } while work
// is in flight.
//
// ======================================================

import { readLogFile } from "../analysis/logFileReader.js";
import { buildLogAnalysis } from "../analysis/logAnalysisBuilder.js";
import { buildDataset } from "../analysis/datasetBuilder.js";
import { aircraftProfiles } from "../profiles/aircraftProfiles.js";

// The decoded log stays here between messages so switching
// flights does not mean decoding the file again.
let loadedLog = null;

function report(id, stage) {
  self.postMessage({ id, type: "progress", stage });
}

// The dataset holds two closures and a 95-column table of about
// 12.7M numbers. The closures cannot be cloned at all, and
// copying the table costs ~430ms. Dropping the closures (the
// client rebuilds them) and moving the columns as transferable
// Float64Array buffers instead brings the whole handover to
// single-digit milliseconds, and leaves only one copy alive.
function packDataset(dataset) {
  if (!dataset) {
    return { dataset: null, buffers: [] };
  }

  const { columnValues, findColumnsIn, columnTable, ...rest } = dataset;
  const columns = new Map();
  const buffers = [];

  for (const [name, values] of columnTable ?? []) {
    const typed = Float64Array.from(values);
    columns.set(name, typed);
    buffers.push(typed.buffer);
  }

  return {
    dataset: { ...rest, columnTable: columns },
    buffers
  };
}

// Lines cross the thread boundary as one joined string, not as
// an array of 134k strings: measured on the 8 MB sample, the
// array costs ~430ms to clone and the single string ~145ms,
// which the receiver splits again in about 20ms.
function flightsForTransfer(log) {
  return log.flights.map((flight) => ({
    label: flight.label,
    decodeInfo: flight.decodeInfo,
    stats: flight.stats,
    csvText: flight.lines.join("\n")
  }));
}

async function load(id, file) {
  report(id, "Decoding the log…");

  loadedLog = await readLogFile(file);

  if (!loadedLog || loadedLog.flights.length === 0) {
    return { flights: [] };
  }

  return {
    flights: flightsForTransfer(loadedLog),
    fileType: loadedLog.fileType,
    sizeKb: loadedLog.sizeKb,
    isBinary: loadedLog.isBinary
  };
}

function analyze(id, flightIndex) {
  const flight = loadedLog?.flights[flightIndex];

  if (!flight) {
    return null;
  }

  report(id, "Reading the telemetry…");

  const {
    extraSummary,
    telemetryText,
    filterAnalysis,
    pidAnalysis
  } = buildLogAnalysis({
    fileType: loadedLog.fileType,
    lines: flight.lines,
    aircraftProfiles
  });

  report(id, "Working out what happened…");

  const { dataset, buffers } = packDataset(
    buildDataset(flight.lines, pidAnalysis)
  );

  return {
    result: {
      extraSummary,
      telemetryText,
      filterAnalysis,
      pidAnalysis,
      dataset
    },
    buffers
  };
}

// Compare Flights loads a second log without disturbing the
// one on screen, so this deliberately does not touch loadedLog.
async function datasetFor(id, file) {
  report(id, "Decoding the other log…");

  const log = await readLogFile(file);
  const flight = log?.flights?.[0];

  if (!flight) {
    return null;
  }

  report(id, "Comparing…");

  const { pidAnalysis } = buildLogAnalysis({
    fileType: log.fileType,
    lines: flight.lines,
    aircraftProfiles
  });

  const { dataset, buffers } = packDataset(
    buildDataset(flight.lines, pidAnalysis)
  );

  return {
    result: { dataset, pidAnalysis },
    buffers
  };
}

self.addEventListener("message", async (event) => {
  const { id, type } = event.data;

  try {
    let result = null;
    let buffers = [];

    if (type === "load") {
      result = await load(id, event.data.file);
    } else if (type === "analyze") {
      ({ result, buffers = [] } = analyze(id, event.data.flightIndex) ?? {});
    } else if (type === "dataset") {
      ({ result, buffers = [] } =
        (await datasetFor(id, event.data.file)) ?? {});
    } else {
      throw new Error(`unknown request: ${type}`);
    }

    self.postMessage({ id, type: "result", result: result ?? null }, buffers);
  } catch (error) {
    self.postMessage({
      id,
      type: "error",
      message: error?.message ?? String(error)
    });
  }
});
