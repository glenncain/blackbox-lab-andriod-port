// ======================================================
// BLACKBOX LAB — DATASET BUILDER
// ======================================================
//
// Turns a flight's CSV lines into the dataset every screen
// draws from: decimated series, spectra, lab results and
// the verdict.
//
// This was section 04 of renderer.js. It moved out intact,
// unchanged, because it is pure computation over the log —
// no DOM — which is exactly what lets it run inside a Web
// Worker (src/workers/analysisWorker.js) and keep the main
// thread free while a big log is analysed.
//
// ======================================================

import { CHART_COLORS } from "../ui/chartColors.js";
import { getColumnValues, fieldAt } from "./mathHelpers.js";
import { findTelemetryHeaderIndex } from "./telemetryHeader.js";
import {
  computeNoiseSpectrum,
  estimateSampleRate
} from "./dsp/fft.js";
import { detectStableFlightPhase } from "./flightPhase.js";
import { buildFlightVerdict } from "./flightVerdict.js";
import { assessLogQuality } from "./logQuality.js";
import { adviseFilters } from "./filterAdvisor.js";
import { analyzeGovernorLab } from "./governorLabAnalysis.js";
import { analyzeEscLab } from "./escLabAnalysis.js";
import { analyzeBatteryLab } from "./batteryLabAnalysis.js";
import { analyzeProfileResponse } from "./profilePidBreakdown.js";
import {
  sliceWindow,
  windowStats,
  findHighestLoadEvents,
  explainLoadEvent,
  isCollectiveDriven,
  groupByGovernorTarget,
  longestConsecutiveRun
} from "./evidenceViews.js";

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
function buildColumnTable(lines, headerIndex) {
 const names = lines[headerIndex]
  .split(",")
  .map((name) =>
    name
      .trim()
      .replace(/^"|"$/g, "")
  );
  const table = new Map(names.map((name) => [name, []]));
  const columns = names.map((name) => table.get(name));

  for (let row = headerIndex + 1; row < lines.length; row += 1) {
    const parts = lines[row].split(",");

    for (let i = 0; i < columns.length; i += 1) {
      const value = Number(parts[i]);

      if (Number.isFinite(value)) {
        columns[i].push(value);
      }
    }
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
  // Unlike columnTable, this keeps row alignment: a blank or
  // unparseable cell becomes null rather than vanishing, so
  // indexes still line up across columns. Memoized because
  // several labs ask for the same column.
  const alignedCache = new Map();

  const alignedColumnValues = (columnName) => {
  if (!columnName) {
    return [];
  }

  if (alignedCache.has(columnName)) {
    return alignedCache.get(columnName);
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
    alignedCache.set(columnName, []);
    return [];
  }

  const values = [];

  for (
    let rowIndex = headerIndex + 1;
    rowIndex < lines.length;
    rowIndex += 1
  ) {
    const rawValue =
      fieldAt(lines[rowIndex], columnIndex)
        ?.trim()
        .replace(/^"|"$/g, "") ?? "";

    if (rawValue === "") {
      values.push(null);
      continue;
    }

    const value = Number(rawValue);

    values.push(
      Number.isFinite(value)
        ? value
        : null
    );
  }

  alignedCache.set(columnName, values);

  return values;
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
  const governorTarget = firstColumn([/governorTarget/i, /govTarget/i, /governor/i]);
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

const longestSpectrumSegment =
  spectrumFlightPhase.segments
    .filter(
      (segment) =>
        Number.isInteger(
          segment.startIndex
        ) &&
        segment.sampleCount >=
          fftWindowSize
    )
    .sort(
      (first, second) =>
        second.sampleCount -
        first.sampleCount
    )[0] ?? null;

const spectrumWindowStart =
  longestSpectrumSegment
    ? longestSpectrumSegment.startIndex +
      Math.floor(
        (
          longestSpectrumSegment.sampleCount -
          fftWindowSize
        ) / 2
      )
    : null;

const buildStableSpectrumSamples =
  (columnName) => {
    if (
      !Number.isInteger(
        spectrumWindowStart
      )
    ) {
      return [];
    }

    const values =
      alignedColumnValues(columnName)
        .slice(
          spectrumWindowStart,
          spectrumWindowStart +
            fftWindowSize
        );

    return (
      values.length === fftWindowSize &&
      values.every(Number.isFinite)
    )
      ? values
      : [];
  };

const spectra = [];

if (
  sampleRate &&
  longestSpectrumSegment
) {
  gyroColumnNames.forEach(
    (name, index) => {
      const spectrum =
        computeNoiseSpectrum(
          buildStableSpectrumSamples(name),
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

 

  const governedHeadspeed = headspeed
    ? averageOf(headspeed.slice(-Math.floor(headspeed.length / 3)))
    : null;

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
    let peak = 0;

    for (const value of entry.spectrum.magnitudes) {
      if (value > peak) {
        peak = value;
      }
    }

    if (peak > strongestValue) {
      strongestValue = peak;
      strongestIndex = index;
    }
  });

  const filteredName =
    filteredColumns[strongestIndex] ??
    filteredColumns[0];

  filteredSpectrumStrongest =
    computeNoiseSpectrum(
      buildStableSpectrumSamples(
        filteredName
      ),
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
        Math.max(...entry.spectrum.magnitudes) >
        Math.max(...strongest.spectrum.magnitudes)
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

    const bankWindowSamples = (columnName, startIndex) => {
      if (!columnName) {
        return [];
      }

      const values = alignedColumnValues(columnName).slice(
        startIndex,
        startIndex + fftWindowSize
      );

      return values.length === fftWindowSize &&
        values.every(Number.isFinite)
        ? values
        : [];
    };

    return banks.map((bank) => {
      const run = longestConsecutiveRun(bank.indexes);

      if (!run || run.length < fftWindowSize) {
        return {
          targetRpm: bank.targetRpm,
          stableSampleCount: bank.indexes.length,
          insufficient: true
        };
      }

      const windowStart =
        run.startIndex +
        Math.floor((run.length - fftWindowSize) / 2);

      const unfilteredSpectrum = computeNoiseSpectrum(
        bankWindowSamples(unfilteredName, windowStart),
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
        ? computeNoiseSpectrum(
            bankWindowSamples(filteredName, windowStart),
            sampleRate,
            { segmentSize: fftWindowSize }
          )
        : null;

      const bankHeadspeed = windowStats(
        alignedHeadspeed,
        windowStart,
        windowStart + fftWindowSize - 1
      );

      const bankRpm = bankHeadspeed
        ? bankHeadspeed.average
        : bank.targetRpm;

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

  // ---- labs + verdict ----
  const labs = {
    governor: analyzeGovernorLab({ timeSeconds, headspeed, governorTarget }),
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

  const verdict = buildFlightVerdict({
  spectra,
  headspeed,
  governorTarget,
  vbat,
  pidAnalysis,
  labs
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
    pidScore: Number.isFinite(pidAnalysis?.score) ? pidAnalysis.score : null,
    batterySagPercent: labs.battery ? labs.battery.sagPercent : null,
    filterAdvice,
    sampleRateHz: sampleRate,
    columnPresence: {
      hasUnfilteredGyro: unfilteredColumns.length > 0,
      hasFilteredGyro: filteredColumns.length > 0,
      hasHeadspeed: Boolean(headspeed),
      hasGovernorTarget: Boolean(governorTarget),
      hasVbat: Boolean(vbat),
      hasAmperage: Boolean(amperage)
    },
    headerLine,
    // Carried so the dataset can cross a worker boundary:
    // columnValues and findColumnsIn are closures and cannot be
    // cloned, but they can be rebuilt from these two on the
    // other side. See attachDatasetAccessors below.
    columnTable,
    timeSeconds,
    columnValues,
    findColumnsIn: (patterns) => findColumns(headerLine, patterns),
    headspeed,
    governorTarget,
    vbat,
    amperage,
    spectra,
    markers,
    perBankFilter,
    labs,
    verdict
  };
}

// Puts back the two accessors that structured clone drops.
// A dataset that arrives from the analysis worker has its
// columnTable and headerLine but no functions; this makes it
// indistinguishable from one built in place.
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

export function spectrumPeakValue(spectrum) {
  let peak = 0;

  for (const value of spectrum.magnitudes) {
    if (value > peak) {
      peak = value;
    }
  }

  return peak;
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

    if (headspeedRpm && headspeedRpm > 300) {
      const ratio = peak.hz / (headspeedRpm / 60);

      if (Math.abs(ratio - 1) < 0.15) name = `main rotor 1/rev · ${name}`;
      else if (Math.abs(ratio - 2) < 0.2) name = `main rotor 2/rev · ${name}`;
      else if (ratio > 3.5 && ratio < 6.5) name = `tail region · ${name}`;
    }

    return { hz: peak.hz, label: name };
  });
}
