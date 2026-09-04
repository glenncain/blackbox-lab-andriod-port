// ======================================================
// BLACKBOX LAB — DATASET BUILDER
// ======================================================
//
// Turns a flight's CSV lines into the dataset every screen
// draws from: decimated series, spectra, lab results and
// the verdict.
//
// This is section 04 of renderer.js. It lives out here
// because it is pure computation over the log — no DOM —
// which is exactly what lets it run inside a Web Worker
// (src/workers/analysisWorker.js) and keep the main thread
// free while a big log is analysed.
//
// Keep it that way. One document reference in here and the
// worker dies at load, on the phone only, with a message
// that will not obviously point back at this file. The
// palette comes from ui/chartColors.js rather than
// ui/charts.js for exactly that reason: charts.js pulls in
// uPlot, which needs a DOM.
//
// ======================================================

import { CHART_COLORS } from "../ui/chartColors.js";
import {
  columnTableFor,
  finiteColumnValues,
  alignedColumnValues as alignedColumnValuesFromTable
} from "./columnTable.js";
import {
  computeNoiseSpectrumOverRuns,
  estimateSampleRate,
  peakMagnitudeAbove
} from "./dsp/fft.js";
import {
  allConsecutiveRuns,
  groupByGovernorTarget,
  longestConsecutiveRun
} from "./evidenceViews.js";
import {
  detectStableFlightPhase,
  isUsableGovernorTarget
} from "./flightPhase.js";
import { assessLogQuality, columnCarriesData } from "./logQuality.js";
import { getMetadataValue } from "./metadataReader.js";
import { findTelemetryHeaderIndex } from "./telemetryHeader.js";
import { buildFlightVerdict } from "./flightVerdict.js";
import { adviseFilters } from "./filterAdvisor.js";
import { analyzeGovernorLab } from "./governorLabAnalysis.js";
import { analyzeEscLab } from "./escLabAnalysis.js";
import {
  analyzeBatteryLab,
  chooseVoltageSource
} from "./batteryLabAnalysis.js";
import { analyzeSignalLab } from "./signalLabAnalysis.js";
import { analyzeBecLab } from "./becLabAnalysis.js";
import { analyzeServoLimits } from "./servoLimitAnalysis.js";
import { analyzePrecomp } from "./precompAnalysis.js";
import { detectGovernorEvents } from "./governorEvents.js";
import { buildFlightEvents } from "./flightEvents.js";

// 04. DATASET
// ======================================================

const UNFILTERED_GYRO_PATTERNS = [/^gyroUnfilt/i, /^gyroRAW/i];

function hasOwnUnfiltered(headerLine) {
  return findColumns(headerLine, UNFILTERED_GYRO_PATTERNS).length > 0;
}

function findColumns(headerLine, patterns) {
  const names = headerLine
    .split(",")
    .map((name) =>
      name
        .trim()
        .replace(/^"|"$/g, "")
    );

  return names.filter((name) =>
    patterns.some((pattern) =>
      pattern.test(name)
    )
  );
}

export function decimate(values, maximumPoints = 60000) {
  if (values.length <= maximumPoints) {
    return values;
  }

  const stride = Math.ceil(values.length / maximumPoints);
  const output = [];

  for (let i = 0; i < values.length; i += stride) {
    output.push(values[i]);
  }

  return output;
}

function averageOf(values) {
  let sum = 0;

  for (const value of values) {
    sum += value;
  }

  return values.length ? sum / values.length : null;
}

// Parse every data row exactly once. On big logs (100k+
// frames) splitting the lines per column read costs seconds;
// this table makes each column access instant.
// Per-column finite values by (normalized) header name, read from
// the shared column table — one parse for the engine, the labs and
// this dataset. Same contents as the old per-row split loop: every
// finite cell in row order, blanks (Number("") = 0) included.
function buildColumnTable(lines, headerIndex) {
  const names = lines[headerIndex]
    .split(",")
    .map((name) =>
      name
        .trim()
        .replace(/^"|"$/g, "")
    );
  const table = new Map();
  const indexesByName = new Map();
  names.forEach((name, index) => {
    if (!indexesByName.has(name)) indexesByName.set(name, []);
    indexesByName.get(name).push(index);
  });

  for (const [name, indexes] of indexesByName) {
    if (indexes.length === 1) {
      table.set(name, finiteColumnValues(lines, headerIndex, indexes[0]));
      continue;
    }
    // A duplicated header name (never in Rotorflight logs, possible
    // in a hand-edited CSV): the old loop pushed every duplicate's
    // finite cells into one array, row by row — kept verbatim.
    const columnTable = columnTableFor(lines, headerIndex);
    const columns = indexes.map((index) => columnTable.column(index));
    const merged = [];
    for (let row = headerIndex + 1; row < lines.length; row += 1) {
      for (const column of columns) {
        const value = column[row];
        if (Number.isFinite(value)) merged.push(value);
      }
    }
    table.set(name, merged);
  }

  return table;
}

export function buildDataset(lines, pidAnalysis) {
  const headerIndex = findTelemetryHeaderIndex(lines);

  if (headerIndex < 0) {
    return null;
  }

  const headerLine = lines[headerIndex];
  const columnTable = buildColumnTable(lines, headerIndex);
  const columnValues = (name) => columnTable.get(name) ?? [];
  const alignedColumnValues = (columnName) => {
  if (!columnName) {
    return [];
  }

  const headers = headerLine
    .split(",")
    .map((header) =>
      header
        .trim()
        .replace(/^"|"$/g, "")
    );

  const normalizedColumnName =
    String(columnName)
      .trim()
      .replace(/^"|"$/g, "");

  const columnIndex =
    headers.indexOf(normalizedColumnName);

  if (columnIndex < 0) {
    return [];
  }

  // One value per row, null where the cell was blank or not numeric
  // — from the shared table, not another pass over the text.
  return alignedColumnValuesFromTable(lines, headerIndex, columnIndex);
};
  const firstColumn = (patterns) => {
    const matches = findColumns(headerLine, patterns);

    if (!matches.length) {
      return null;
    }

    const values = columnValues(matches[0]);
    return values.length > 0 ? values : null;
  };

  const timeColumnName = findColumns(headerLine, [/time/i])[0];

  if (!timeColumnName) {
    return null;
  }

  const timeMicroseconds = columnValues(timeColumnName);
  const startTime = timeMicroseconds[0] ?? 0;
  const timeSeconds = timeMicroseconds.map(
    (value) => (value - startTime) / 1_000_000
  );

  const headspeed = firstColumn([/headspeed/i, /^rpm/i]);
  const governorTargetRaw = firstColumn([/governorTarget/i, /govTarget/i, /governor/i]);
  // DIRECT-mode / passthrough targets are not rotor-speed targets —
  // treat them as absent so every consumer (labs, events, precomp,
  // phase detection, verdict) falls back to headspeed-only reads.
  // The Log Viewer still charts the raw column as recorded.
  const governorTarget = isUsableGovernorTarget(
    headspeed,
    governorTargetRaw
  )
    ? governorTargetRaw
    : [];
  const vbat = firstColumn([/^vbat/i]);
const escVoltage = firstColumn([/^EscV$/i]);
const amperage = firstColumn([/^amperage/i, /^Ibat/i, /^current/i]);
const escCurrent = firstColumn([/^EscI$/i]);
const escThrottle = firstColumn([/^EscThr$/i]);
 const motor = firstColumn([/^motor\[0\]/i]);

  // ---- spectra + labelled peaks ----
  // Analyze the governed part of the flight only: during
  // spool-up the rotor frequency sweeps, which smears the
  // vibration peaks across the spectrum.
  const sampleRate = estimateSampleRate(timeMicroseconds);
  // Noise lives in the UNFILTERED gyro. findColumns keeps
  // header order, so ask for unfiltered explicitly first
  // and fall back to the filtered trace only if a log has
  // nothing better.
  const unfilteredColumns = findColumns(headerLine, UNFILTERED_GYRO_PATTERNS);
  const gyroColumnNames = (
    unfilteredColumns.length > 0
      ? unfilteredColumns
      : findColumns(headerLine, [/^gyroADC/i])
  ).slice(0, 3);

  const fftWindowSize = 4096;

const headspeedColumnName =
  findColumns(
    headerLine,
    [/headspeed/i, /^rpm$/i]
  )[0] ?? null;

const governorTargetColumnName =
  findColumns(
    headerLine,
    [
      /governorTarget/i,
      /govTarget/i,
      /governor/i
    ]
  )[0] ?? null;

const alignedTimeMicroseconds =
  alignedColumnValues(timeColumnName);

const alignedHeadspeed =
  alignedColumnValues(headspeedColumnName);

const alignedGovernorTarget =
  alignedColumnValues(
    governorTargetColumnName
  );

const firstAlignedTime =
  alignedTimeMicroseconds.find(
    Number.isFinite
  ) ?? 0;

const alignedTimeSeconds =
  alignedTimeMicroseconds.map((value) =>
    Number.isFinite(value)
      ? (
          value -
          firstAlignedTime
        ) / 1_000_000
      : Number.NaN
  );

const spectrumFlightPhase =
  detectStableFlightPhase({
    timeSeconds: alignedTimeSeconds,
    headspeed: alignedHeadspeed,
    governorTarget:
      alignedGovernorTarget
  });

// The noise picture is averaged across EVERY stable run of the
// flight, not read from one slice. A single window makes the
// spectrum hostage to where the slice happens to land: an
// intermittent shake scores very differently between two flights
// of the same machine purely by window luck.
const minimumSpectrumRun = 1024;

const stableSpectrumRuns = (columnName) => {
  if (!columnName) {
    return [];
  }

  const values = alignedColumnValues(columnName);
  const runs = [];

  for (const segment of spectrumFlightPhase.segments ?? []) {
    if (
      !Number.isInteger(segment.startIndex) ||
      segment.sampleCount < minimumSpectrumRun
    ) {
      continue;
    }

    const run = values.slice(
      segment.startIndex,
      segment.startIndex + segment.sampleCount
    );

    if (run.every(Number.isFinite)) {
      runs.push(run);
    }
  }

  return runs;
};

const hasSpectrumRuns = (
  spectrumFlightPhase.segments ?? []
).some(
  (segment) =>
    Number.isInteger(segment.startIndex) &&
    segment.sampleCount >= minimumSpectrumRun
);

const spectra = [];

// When the chart cannot be drawn, the empty state must name the
// actual gate that failed — telling a pilot with 300k gyro samples
// that there is "not enough gyro data" contradicts the verdict
// sitting right above the chart.
let spectraUnavailableReason = null;

if (gyroColumnNames.length === 0) {
  spectraUnavailableReason = "no-gyro";
} else if (!sampleRate) {
  spectraUnavailableReason = "no-rate";
} else if (!hasSpectrumRuns) {
  spectraUnavailableReason = "no-stable-run";
}

if (sampleRate && hasSpectrumRuns) {
  gyroColumnNames.forEach(
    (name, index) => {
      const spectrum =
        computeNoiseSpectrumOverRuns(
          stableSpectrumRuns(name),
          sampleRate,
          {
            segmentSize: fftWindowSize
          }
        );

      if (spectrum) {
        spectra.push({
          label: name,
          spectrum,
          color:
            CHART_COLORS[
              index %
                CHART_COLORS.length
            ]
        });
      }
    }
  );
}

 

  // Anchor rotor-harmonic classification to the rotor speed the
  // machine actually flew at. The stable-flight samples are the
  // authority; the tail-of-log average is only a fallback for logs
  // with no detectable stable phase, because ground idle and
  // spool-down in the tail drag that average away from flight rpm
  // and shift every harmonic ratio with it.
  const stableMeanHeadspeed = (() => {
    const indexes = spectrumFlightPhase.stableIndexes ?? [];

    if (!alignedHeadspeed || indexes.length < 100) {
      return null;
    }

    let sum = 0;
    let count = 0;

    for (const index of indexes) {
      const value = alignedHeadspeed[index];

      if (Number.isFinite(value) && value > 0) {
        sum += value;
        count += 1;
      }
    }

    return count >= 100 ? sum / count : null;
  })();

  const governedHeadspeed =
    stableMeanHeadspeed ??
    (headspeed
      ? averageOf(headspeed.slice(-Math.floor(headspeed.length / 3)))
      : null);

  if (spectra.length === 0 && spectraUnavailableReason === null) {
    spectraUnavailableReason = "no-stable-run";
  }

  const markers = buildSpectrumMarkers(spectra, governedHeadspeed);

  // ---- filter advisor: unfiltered vs filtered gyro ----
  const filteredColumns = findColumns(headerLine, [/^gyroADC/i]).slice(0, 3);
  let filteredSpectrumStrongest = null;

  if (
  sampleRate &&
  unfilteredColumns.length > 0 &&
  filteredColumns.length > 0
) {
  // Match the axis of the strongest unfiltered spectrum
  // so attenuation is measured apples-to-apples.
  let strongestIndex = 0;
  let strongestValue = 0;

  spectra.forEach((entry, index) => {
    const peak = spectrumPeakValue(entry.spectrum);

    if (peak > strongestValue) {
      strongestValue = peak;
      strongestIndex = index;
    }
  });

  const filteredName =
    filteredColumns[strongestIndex] ??
    filteredColumns[0];

  filteredSpectrumStrongest =
    computeNoiseSpectrumOverRuns(
      stableSpectrumRuns(filteredName),
      sampleRate,
      {
        segmentSize: fftWindowSize
      }
    );
}
  const unfilteredSpectrumStrongest = (() => {
    if (spectra.length === 0) {
      return null;
    }

    let strongest = spectra[0];

    for (const entry of spectra) {
      if (
        spectrumPeakValue(entry.spectrum) >
        spectrumPeakValue(strongest.spectrum)
      ) {
        strongest = entry;
      }
    }

    return strongest.spectrum;
  })();

  const filterAdvice = adviseFilters({
    unfilteredSpectrum: unfilteredSpectrumStrongest,
    filteredSpectrum: hasOwnUnfiltered(headerLine)
      ? filteredSpectrumStrongest
      : null,
    headspeedRpm: governedHeadspeed
  });

  // ---- filter behavior per headspeed bank ----
  // Rotor harmonics move with rpm, so each bank gets its own
  // spectrum and its own advice — computed only from that
  // bank's longest unbroken stable stretch. Evidence only.
  const perBankFilter = (() => {
    const banks = groupByGovernorTarget({
      governorTarget: alignedGovernorTarget,
      sampleIndexes: spectrumFlightPhase.stableIndexes ?? []
    });

    if (banks.length < 2 || !sampleRate) {
      return [];
    }

    let strongestAxisIndex = 0;
    let strongestPeak = 0;

    spectra.forEach((entry, index) => {
      for (const value of entry.spectrum.magnitudes) {
        if (value > strongestPeak) {
          strongestPeak = value;
          strongestAxisIndex = index;
        }
      }
    });

    const unfilteredName =
      gyroColumnNames[strongestAxisIndex] ?? gyroColumnNames[0];
    const filteredName =
      filteredColumns[strongestAxisIndex] ?? filteredColumns[0];

    // A bank's spectrum averages across all of its stable runs,
    // matching the flight-wide spectra: one slice per bank made
    // the per-bank story hostage to where that slice landed.
    const bankRunSamples = (columnName, runs) => {
      if (!columnName) {
        return [];
      }

      const values = alignedColumnValues(columnName);

      return runs
        .filter((run) => run.length >= minimumSpectrumRun)
        .map((run) =>
          values.slice(run.startIndex, run.startIndex + run.length)
        )
        .filter((run) => run.every(Number.isFinite));
    };

    return banks.map((bank) => {
      const runs = allConsecutiveRuns(bank.indexes);
      const longestRun = longestConsecutiveRun(bank.indexes);

      if (!longestRun || longestRun.length < minimumSpectrumRun) {
        return {
          targetRpm: bank.targetRpm,
          stableSampleCount: bank.indexes.length,
          insufficient: true
        };
      }

      const unfilteredSpectrum = computeNoiseSpectrumOverRuns(
        bankRunSamples(unfilteredName, runs),
        sampleRate,
        { segmentSize: fftWindowSize }
      );

      if (!unfilteredSpectrum) {
        return {
          targetRpm: bank.targetRpm,
          stableSampleCount: bank.indexes.length,
          insufficient: true
        };
      }

      const filteredSpectrum = hasOwnUnfiltered(headerLine)
        ? computeNoiseSpectrumOverRuns(
            bankRunSamples(filteredName, runs),
            sampleRate,
            { segmentSize: fftWindowSize }
          )
        : null;

      // The bank's rpm is read over its whole stable set, not a
      // single window, to match the spectra.
      const bankRpm = (() => {
        let sum = 0;
        let count = 0;

        for (const index of bank.indexes) {
          const value = Number(alignedHeadspeed[index]);

          if (Number.isFinite(value) && value > 0) {
            sum += value;
            count += 1;
          }
        }

        return count > 0 ? sum / count : bank.targetRpm;
      })();

      return {
        targetRpm: bank.targetRpm,
        actualRpm: Math.round(bankRpm),
        stableSampleCount: bank.indexes.length,
        insufficient: false,
        spectra: [
          {
            label: `${unfilteredName} (raw)`,
            spectrum: unfilteredSpectrum,
            color: CHART_COLORS[1]
          },
          ...(filteredSpectrum
            ? [
                {
                  label: `${filteredName} (filtered)`,
                  spectrum: filteredSpectrum,
                  color: CHART_COLORS[0]
                }
              ]
            : [])
        ],
        advice: adviseFilters({
          unfilteredSpectrum,
          filteredSpectrum,
          headspeedRpm: bankRpm
        })
      };
    });
  })();

  // One voltage-source decision for every chart and readout: the
  // same cross-check the Labs use (FC's calibrated reading wins on
  // real disagreement), so a chart never contradicts the story
  // beside it.
  const voltagePatterns =
    chooseVoltageSource(escVoltage, vbat).selected === escVoltage
      ? [/^EscV$/i, /^vbatLatest$/i]
      : [/^vbat/i, /^vbatLatest$/i];

  // ---- labs + verdict ----
  const motorOutputForGovernor =
    Array.isArray(escThrottle) &&
    escThrottle.some((value) => Number(value) > 0)
      ? escThrottle
      : motor;

  const collective = firstColumn([/^setpoint\[3\]$/i]);

  const labs = {
    governor: analyzeGovernorLab({
      timeSeconds,
      headspeed,
      governorTarget,
      // Output context for the worst-droop event: a dip with the
      // throttle at its ceiling is a power limit, not a gain issue.
      motorOutput: motorOutputForGovernor
    }),
   esc: analyzeEscLab({
  timeSeconds,
  motor,
  escThrottle,
  amperage,
  escCurrent,
  vbat,
  escVoltage,
  headspeed,
  governorTarget
}),
    battery: analyzeBatteryLab({
  timeSeconds,
  vbat,
  escVoltage,
  amperage,
  escCurrent,
  headspeed,
  governorTarget
})
  };

  // Radio-link and receiver-power health, computed before the
  // verdict so Home can carry their cards. The BEC lab reads the
  // Signal lab's conclusion: a "brownout" on the voltage trace
  // while the receiver demonstrably kept flying is a
  // measurement-path story, not a power-loss story.
  const servoColumnsForLabs = findColumns(headerLine, [
    /^servo\[\d\]$/i
  ]).map((name) => ({ name, values: columnValues(name) }));

  const signalLab = analyzeSignalLab({
    timeSeconds,
    rssi: firstColumn([/^rssi$/i]),
    failsafePhase: firstColumn([/^failsafePhase$/i]),
    rxSignalReceived: firstColumn([/^rxSignalReceived$/i]),
    rxFlightChannelsValid: firstColumn([/^rxFlightChannelsValid$/i]),
    headspeed
  });

  const becLab = analyzeBecLab({
    timeSeconds,
    vbec: firstColumn([/^Vbec$/i]),
    servos: servoColumnsForLabs,
    headspeed,
    receiverStayedAlive: signalLab
      ? signalLab.counts.failsafe === 0 &&
        signalLab.counts.linkLoss === 0
      : null
  });

  // What this log can and cannot tell — decided ONCE, here, and
  // read by the verdict cards, the first steps and the quality
  // chips alike. A missing or dead channel is a fact every surface
  // states; none of them re-derives it.
  const columnPresence = {
    hasUnfilteredGyro: unfilteredColumns.length > 0,
    hasFilteredGyro: filteredColumns.length > 0,
    hasHeadspeed: columnCarriesData(headspeed),
    hasGovernorTarget: columnCarriesData(governorTarget),
    hasVbat: columnCarriesData(vbat) || columnCarriesData(escVoltage),
    hasAmperage:
      columnCarriesData(amperage) || columnCarriesData(escCurrent),
    // The labs already decided what their telemetry supports —
    // the chips repeat that decision, never re-derive it.
    hasRssi: signalLab?.capability === "full",
    hasLinkFlags: Boolean(signalLab),
    hasVbec: Boolean(becLab)
  };

  const quality = assessLogQuality({
    sampleRateHz: sampleRate,
    durationSeconds: timeSeconds[timeSeconds.length - 1],
    ...columnPresence
  });

  const verdict = buildFlightVerdict({
  spectra,
  headspeed,
  governorTarget,
  vbat,
  pidAnalysis,
  labs,
  anchorHeadspeedRpm: governedHeadspeed,
  filterAdvice,
  signalLab,
  becLab,
  capabilities: quality.capabilities
});

  // Evidence that zooms to the moment: attach a focus
  // window (chart + x-range) to the cards that have one.
  for (const card of verdict.cards) {
    if (card.key === "vibration" && markers.length > 0) {
      card.focus = {
        chartId: "chartSpectrum",
        min: Math.max(0, markers[0].hz - 30),
        max: markers[0].hz + 30
      };
    }

    if (card.key === "rotor" && labs.governor) {
      card.focus = {
        chartId: "chartGovernor",
        min: Math.max(0, labs.governor.droopTimeSeconds - 3),
        max: labs.governor.droopTimeSeconds + 3
      };
    }
  }

  return {
    // Which helicopter this flight came from. A before/after
    // comparison is only a before/after when both are the same
    // machine; otherwise the difference is the aircraft.
    craftName: getMetadataValue(lines, "Craft name"),
    pidScore: Number.isFinite(pidAnalysis?.score) ? pidAnalysis.score : null,
    // Carried so a comparison can say how much each side's score rests
    // on. Two tracking numbers are only worth subtracting when both
    // were measured from enough clean responses to mean anything.
    pidConfidence: pidAnalysis?.confidence ?? null,
    // Per-axis commanded-rate magnitudes: the stick demand a flight
    // asked for, so Compare can match flights on what they asked.
    demandRates:
      pidAnalysis?.technicalSummary?.demand?.axisSetpointMagnitudes ?? null,
    // Clean command-response counts per axis — a comparison is only a
    // comparison where both flights interrogated the same axes (#32).
    axisEvidence: Object.fromEntries(
      (pidAnalysis?.detectedColumns?.trackingAnalysis?.commandEvents ?? []).map(
        (axisResult) => [
          axisResult.axis,
          (axisResult.events ?? []).filter((event) =>
            Number.isFinite(event.responsePeak)
          ).length
        ]
      )
    ),
    batterySagPercent: labs.battery ? labs.battery.sagPercent : null,
    filterAdvice,
    sampleRateHz: sampleRate,
    // "Present" means CARRIES DATA: a headspeed column logged as
    // constant zero (RPM wire unplugged) must not promise governor
    // analysis, title a chart "vs Target", or mark a craft
    // electric. 16 % of contributed flights carry at least one
    // such dead column.
    columnPresence,
    quality,
    headerLine,
    // Carried for the worker: structured clone drops the two
    // closures below, and attachDatasetAccessors rebuilds them
    // from this Map and headerLine on the far side.
    columnTable,
    timeSeconds,
    columnValues,
    findColumnsIn: (patterns) => findColumns(headerLine, patterns),
    headspeed,
    governorTarget,
    collective,
    vbat,
    voltagePatterns,
    amperage,
    spectra,
    spectraUnavailableReason,
    markers,
    perBankFilter,
    labs,
    // The Governor Lab's event layer: sustained over/under-target
    // excursions with their context, measured by the analysis
    // module on the same arrays the lab charts read.
    governorEvents: detectGovernorEvents({
      timeSeconds,
      headspeed,
      governorTarget,
      motorOutput: motorOutputForGovernor,
      collective
    }),
    // How the anticipation worked: collective transients against
    // headspeed error (governor precomp) and yaw error (tail
    // torque precomp).
    precomp: analyzePrecomp({
      timeSeconds,
      headspeed,
      governorTarget,
      collective,
      yawSetpoint: firstColumn([/^setpoint\[2\]$/i]),
      yawGyro: firstColumn([/^gyroADC\[2\]$/i])
    }),
    signalLab,
    becLab,
    // Servo commands frozen at their own travel edge — the
    // second layer that confirms whether a saturation condition
    // reached the actual servo command.
    servoLimits: analyzeServoLimits({
      timeSeconds,
      headspeed,
      servos: findColumns(headerLine, [/^servo\[\d\]$/i]).map(
        (name) => ({ name, values: columnValues(name) })
      )
    }),
    // The stick-command event layer lives ON the dataset so every
    // consumer — the PID page, Compare Flights, contributions —
    // reads the same list.
    flightEvents: buildFlightEvents({
      trackingAnalysis:
        pidAnalysis?.detectedColumns?.trackingAnalysis,
      timeSeconds,
      dataRowOffset: headerIndex + 1
    }),
    verdict
  };
}

// "Strongest" always means strongest ABOVE the vibration floor:
// a plain max is dominated by near-DC maneuver energy and elects
// the most-flown axis, while the verdict names its peak from the
// most-shaking one — and the two must never disagree.
export function spectrumPeakValue(spectrum) {
  return peakMagnitudeAbove(spectrum);
}

export function buildSpectrumMarkers(spectra, headspeedRpm) {
  if (!spectra.length) {
    return [];
  }

  // Strongest axis carries the story.
  let strongest = spectra[0];

  for (const entry of spectra) {
    if (spectrumPeakValue(entry.spectrum) > spectrumPeakValue(strongest.spectrum)) {
      strongest = entry;
    }
  }

  const { frequencies, magnitudes } = strongest.spectrum;
  const peaks = [];

  for (let i = 2; i < frequencies.length - 2; i += 1) {
    if (
      frequencies[i] > 10 &&
      magnitudes[i] > magnitudes[i - 1] &&
      magnitudes[i] > magnitudes[i + 1]
    ) {
      peaks.push({ hz: frequencies[i], magnitude: magnitudes[i] });
    }
  }

  peaks.sort((a, b) => b.magnitude - a.magnitude);

  const chosen = [];

  for (const peak of peaks) {
    if (chosen.every((other) => Math.abs(other.hz - peak.hz) > 8)) {
      chosen.push(peak);
    }

    if (chosen.length === 3) {
      break;
    }
  }

  return chosen.map((peak) => {
    let name = `${peak.hz.toFixed(0)} Hz`;
    let classification = "unclassified";

    if (headspeedRpm && headspeedRpm > 300) {
      const ratio = peak.hz / (headspeedRpm / 60);

      if (Math.abs(ratio - 1) < 0.15) {
        name = `main rotor 1/rev · ${name}`;
        classification = "main_rotor_1rev";
      } else if (Math.abs(ratio - 2) < 0.2) {
        name = `main rotor 2/rev · ${name}`;
        classification = "main_rotor_2rev";
      } else if (ratio > 3.5 && ratio < 6.5) {
        name = `tail region · ${name}`;
        classification = "tail_region";
      }
    }

    return {
      hz: peak.hz,
      label: name,
      magnitude: peak.magnitude,
      classification
    };
  });
}

// ======================================================

// ======================================================
// STRUCTURED CLONE REPAIR
// ======================================================
//
// A dataset that crosses back from the worker has lost its
// two closures — structured clone carries data, not
// functions. columnTable (a Map) and headerLine do survive,
// so both are rebuilt here from the same values they closed
// over, and every consumer sees the dataset it expects
// whether the analysis ran in the worker or in place.
//
// ======================================================

export function attachDatasetAccessors(dataset) {
  if (!dataset || typeof dataset.columnValues === "function") {
    return dataset;
  }

  const table = dataset.columnTable ?? new Map();
  const headerLine = dataset.headerLine ?? "";

  dataset.columnValues = (name) => table.get(name) ?? [];
  dataset.findColumnsIn = (patterns) => findColumns(headerLine, patterns);

  return dataset;
}
