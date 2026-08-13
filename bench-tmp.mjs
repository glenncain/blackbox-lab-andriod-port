import { readFileSync } from "node:fs";
import { decodeBblFile } from "./src/analysis/bbl/bblDecoder.js";
import { decodedFlightToCsvLines } from "./src/analysis/bbl/csvAdapter.js";

const bytes = new Uint8Array(readFileSync("samples/sample-bell-222ut.bbl"));
console.log("file:", (bytes.length/1048576).toFixed(1), "MB");

let t = performance.now();
const { flights } = decodeBblFile(bytes);
const tDecode = performance.now() - t;
const flight = flights.find(f => f.mainFrames.length > 0);
console.log(`decodeBblFile        ${tDecode.toFixed(0)} ms  (${flight.mainFrames.length} main frames)`);

t = performance.now();
const lines = decodedFlightToCsvLines(flight);
const tCsv = performance.now() - t;
console.log(`decodedFlightToCsvLines ${tCsv.toFixed(0)} ms  (${lines.length} lines)`);

const bytesOfLines = lines.reduce((n,l)=>n+l.length,0);
console.log(`  CSV strings hold     ${(bytesOfLines/1048576).toFixed(1)} MB of text`);
console.log(`  heap used            ${(process.memoryUsage().heapUsed/1048576).toFixed(0)} MB`);
