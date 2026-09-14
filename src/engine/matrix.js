/**
 * Matrix operations — add, multiply, transpose over plain nested arrays.
 *
 * Design decisions:
 *   - Matrices are PLAIN ARRAYS OF ARRAYS (JSON-native): agents produce
 *     and consume them without a mathjs format round-trip. Internal
 *     mathjs Matrix types never leak into results.
 *   - Validation is strict and precise: rectangularity (no ragged rows),
 *     non-empty, finite numeric entries, exact shape compatibility for
 *     each operation — with dimensions spelled out in every error.
 *   - Hand-rolled arithmetic (O(n³) triple loop for multiply): the
 *     matrices that flow through an MCP tool are small; clarity and
 *     JSON-native I/O beat mathjs dispatch overhead here. No mathjs
 *     dependency in this module at all.
 *
 * @module engine/matrix
 */

/** Maximum dimension per axis (400×400 = 64M multiply ops at worst). */
const MAX_DIMENSION = 400;

/**
 * Validate a matrix: rectangular nested array of finite numbers.
 *
 * @param {*} m - Candidate matrix.
 * @param {string} label - Name used in error messages.
 * @returns {{rows: number, cols: number}} Validated shape.
 * @throws {Error} On non-array, empty, ragged, over-dimension, or
 *   non-finite-entry input.
 * @private
 */
function requireMatrix(m, label) {
  if (!Array.isArray(m) || m.length === 0) {
    throw new Error(`${label} must be a non-empty array of rows`);
  }
  if (m.length > MAX_DIMENSION) {
    throw new Error(
      `${label} exceeds maximum dimension of ${MAX_DIMENSION} rows`,
    );
  }
  if (!Array.isArray(m[0])) {
    throw new Error(`${label} must be an array of arrays (rows of numbers)`);
  }
  const cols = m[0].length;
  if (cols === 0) {
    throw new Error(`${label} must not contain empty rows`);
  }
  if (cols > MAX_DIMENSION) {
    throw new Error(
      `${label} exceeds maximum dimension of ${MAX_DIMENSION} columns`,
    );
  }
  for (let i = 0; i < m.length; i++) {
    const row = m[i];
    if (!Array.isArray(row)) {
      throw new Error(`${label} row ${i} is not an array (ragged input)`);
    }
    if (row.length !== cols) {
      throw new Error(
        `${label} is ragged: row 0 has ${cols} columns but row ${i} has ${row.length}`,
      );
    }
    for (let j = 0; j < row.length; j++) {
      if (typeof row[j] !== "number" || !Number.isFinite(row[j])) {
        throw new Error(
          `${label}[${i}][${j}] must be a finite number (got ${JSON.stringify(row[j])})`,
        );
      }
    }
  }
  return { rows: m.length, cols };
}

/**
 * Element-wise matrix addition. Shapes must match exactly.
 *
 * @param {number[][]} a - Left matrix (rows×cols).
 * @param {number[][]} b - Right matrix (rows×cols).
 * @returns {number[][]} Sum (rows×cols).
 * @throws {Error} On invalid matrices or shape mismatch.
 */
export function matrixAdd(a, b) {
  const shapeA = requireMatrix(a, "matrix a");
  const shapeB = requireMatrix(b, "matrix b");
  if (shapeA.rows !== shapeB.rows || shapeA.cols !== shapeB.cols) {
    throw new Error(
      `matrix addition requires identical shapes — a is ${shapeA.rows}x${shapeA.cols}, b is ${shapeB.rows}x${shapeB.cols}`,
    );
  }
  const out = new Array(shapeA.rows);
  for (let i = 0; i < shapeA.rows; i++) {
    const row = new Array(shapeA.cols);
    for (let j = 0; j < shapeA.cols; j++) {
      row[j] = a[i][j] + b[i][j];
    }
    out[i] = row;
  }
  return out;
}

/**
 * Matrix multiplication A·B. Inner dimensions must agree
 * (aCols === bRows).
 *
 * @param {number[][]} a - Left matrix (m×k).
 * @param {number[][]} b - Right matrix (k×n).
 * @returns {number[][]} Product (m×n).
 * @throws {Error} On invalid matrices or incompatible inner dimensions.
 */
export function matrixMultiply(a, b) {
  const shapeA = requireMatrix(a, "matrix a");
  const shapeB = requireMatrix(b, "matrix b");
  if (shapeA.cols !== shapeB.rows) {
    throw new Error(
      `matrix multiplication requires a's columns to equal b's rows — a is ${shapeA.rows}x${shapeA.cols}, b is ${shapeB.rows}x${shapeB.cols}`,
    );
  }
  const out = new Array(shapeA.rows);
  for (let i = 0; i < shapeA.rows; i++) {
    const row = new Array(shapeB.cols);
    for (let j = 0; j < shapeB.cols; j++) {
      let sum = 0;
      for (let k = 0; k < shapeA.cols; k++) {
        sum += a[i][k] * b[k][j];
      }
      row[j] = sum;
    }
    out[i] = row;
  }
  return out;
}

/**
 * Matrix transposition (rows become columns).
 *
 * @param {number[][]} m - Input matrix (rows×cols).
 * @returns {number[][]} Transpose (cols×rows).
 * @throws {Error} On invalid matrices.
 */
export function matrixTranspose(m) {
  const shape = requireMatrix(m, "matrix");
  const out = new Array(shape.cols);
  for (let j = 0; j < shape.cols; j++) {
    const row = new Array(shape.rows);
    for (let i = 0; i < shape.rows; i++) {
      row[i] = m[i][j];
    }
    out[j] = row;
  }
  return out;
}
