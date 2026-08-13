// ======================================================
// BLACKBOX LAB — SERIES PALETTE
// ======================================================
//
// Its own module so the analysis worker can label series
// with the right colour without importing charts.js, which
// pulls in uPlot and needs a DOM.
//
// ======================================================

// Colorblind-safe series palette tuned for dark surfaces.
export const CHART_COLORS = [
  "#3987e5", // blue
  "#d95926", // orange
  "#199e70", // green-aqua
  "#c98500", // amber
  "#d55181", // magenta
  "#9085e9" // violet
];
