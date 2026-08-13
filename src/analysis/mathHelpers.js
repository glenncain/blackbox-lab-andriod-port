// Reads one comma-separated field without splitting the whole
// line. A telemetry row has ~40 columns, so split(",")[i] throws
// away 39 freshly allocated strings every time it is called — and
// on a 134k-frame log, once per row per column read. That is the
// single biggest cost in analysing a large flight.
//
// Returns undefined when the row has fewer fields than asked for,
// exactly as split(",")[i] does, so Number() still yields NaN.
export function fieldAt(line, index) {
  let start = 0;

  for (let i = 0; i < index; i += 1) {
    const next = line.indexOf(",", start);

    if (next < 0) {
      return undefined;
    }

    start = next + 1;
  }

  const end = line.indexOf(",", start);

  return end < 0
    ? line.slice(start)
    : line.slice(start, end);
}

export function getColumnValues(
  lines,
  headerIndex,
  columnName
) {
  if (
    !Array.isArray(lines) ||
    !columnName ||
    headerIndex < 0
  ) {
    return [];
  }

  const headers = lines[headerIndex]
    .split(",")
    .map((header) => header.trim());

  const columnIndex = headers.indexOf(columnName);

  if (columnIndex < 0) {
    return [];
  }

  const values = [];

  for (
    let rowIndex = headerIndex + 1;
    rowIndex < lines.length;
    rowIndex += 1
  ) {
    const value = Number(fieldAt(lines[rowIndex], columnIndex));

    if (Number.isFinite(value)) {
      values.push(value);
    }
  }

  return values;
}

export function getColumnSamples(
  lines,
  headerIndex,
  columnName
) {
  if (
    !Array.isArray(lines) ||
    !columnName ||
    headerIndex < 0
  ) {
    return [];
  }

  const headers = lines[headerIndex]
    .split(",")
    .map((header) => header.trim());

  const columnIndex = headers.indexOf(columnName);

  if (columnIndex < 0) {
    return [];
  }

  const samples = [];

  for (
    let rowIndex = headerIndex + 1;
    rowIndex < lines.length;
    rowIndex += 1
  ) {
    const value = Number(fieldAt(lines[rowIndex], columnIndex));

    if (Number.isFinite(value)) {
      samples.push({
        rowIndex,
        value
      });
    }
  }

  return samples;
}
    


  

export function getColumnAverage(
  lines,
  headerIndex,
  columnName
) {
  const values = getColumnValues(
    lines,
    headerIndex,
    columnName
  );

  if (values.length === 0) {
    return null;
  }

  const total = values.reduce(
    (sum, value) => sum + value,
    0
  );

  return total / values.length;
}
export function getStandardDeviation(values) {
  if (!values || values.length === 0) {
    return null;
  }

  const average =
    values.reduce((sum, value) => sum + value, 0) /
    values.length;

  const variance =
    values.reduce((sum, value) => {
      const difference = value - average;
      return sum + difference * difference;
    }, 0) / values.length;

  return Math.sqrt(variance);
}
export function clampScore(score) {
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function calculateAverageAbsolute(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const total = values.reduce(
  (sum, value) => sum + Math.abs(value),
  0
);

return total / values.length;
}
export function getColumnValuesByRowIndexes(
  lines,
  headerIndex,
  columnName,
  rowIndexes
) {
  if (
    !Array.isArray(lines) ||
    !Array.isArray(rowIndexes) ||
    !columnName ||
    headerIndex < 0
  ) {
    return [];
  }

  const headers = lines[headerIndex]
    .split(",")
    .map((header) => header.trim());

  const columnIndex = headers.indexOf(columnName);

  if (columnIndex < 0) {
    return [];
  }

  return rowIndexes
    .map((rowIndex) => {
      const line = lines[rowIndex];

      if (!line) {
        return null;
      }

      const value = Number(fieldAt(line, columnIndex));

      return Number.isFinite(value)
        ? value
        : null;
    })
    .filter((value) => Number.isFinite(value));
}
  