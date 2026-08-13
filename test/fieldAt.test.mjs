// ======================================================
// BLACKBOX LAB — fieldAt EQUIVALENCE
// ======================================================
//
// fieldAt replaced split(",")[i] throughout the analysis
// modules and cut the load of a large log from 28s to 10s
// (see Documentation/ANDROID-PORT-LOG.md).
//
// That is only a safe trade if it is a drop-in replacement,
// including the ugly cases: a row shorter than the column
// asked for must yield undefined, not "", or Number() turns
// missing telemetry into a real zero and the analysis quietly
// reports on data that was never logged.
//
// ======================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fieldAt } from "../src/analysis/mathHelpers.js";
import { decodeBblFile } from "../src/analysis/bbl/bblDecoder.js";
import { decodedFlightToCsvLines } from "../src/analysis/bbl/csvAdapter.js";

const SAMPLE = new URL("../samples/sample-clean-tuned.bbl", import.meta.url);

test("fieldAt matches split(\",\")[i] on awkward rows", () => {
  const rows = [
    "",
    ",",
    ",,",
    "a",
    "a,",
    ",a",
    "a,,b",
    "a,b,c",
    " a , b ",
    '"quoted",b',
    "1e-3,NaN,Infinity",
    "-0,0.0,"
  ];

  for (const row of rows) {
    const cells = row.split(",");

    // Deliberately past the end: that is where a naive
    // implementation returns "" and changes the meaning.
    for (let column = 0; column < cells.length + 3; column += 1) {
      assert.equal(
        fieldAt(row, column),
        cells[column],
        `row ${JSON.stringify(row)} column ${column}`
      );
    }
  }
});

test("fieldAt returns undefined past the end, so Number() is NaN", () => {
  assert.equal(fieldAt("a,b", 5), undefined);
  assert.ok(Number.isNaN(Number(fieldAt("a,b", 5))));

  // The trap: "" would become 0 and pass Number.isFinite.
  assert.notEqual(fieldAt("a,b", 5), "");
});

test("fieldAt matches split on every column of a real flight", () => {
  const bytes = new Uint8Array(readFileSync(SAMPLE));
  const { flights } = decodeBblFile(bytes);
  const flight = flights.find((entry) => entry.mainFrames.length > 0);

  assert.ok(flight, "sample should decode to at least one flight");

  const lines = decodedFlightToCsvLines(flight);
  const widest = Math.max(
    ...lines.slice(0, 500).map((line) => line.split(",").length)
  );

  let compared = 0;

  // Strided rather than exhaustive: this runs in the normal
  // test suite, and every 37th row still crosses the metadata
  // block, the header and the frame rows.
  for (let row = 0; row < lines.length; row += 37) {
    const cells = lines[row].split(",");

    for (let column = 0; column < widest + 2; column += 1) {
      assert.equal(
        fieldAt(lines[row], column),
        cells[column],
        `row ${row} column ${column}`
      );
      compared += 1;
    }
  }

  assert.ok(compared > 10000, `expected a broad sweep, compared ${compared}`);
});
