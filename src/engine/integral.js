/**
 * Integration — symbolic polynomial antiderivatives + numeric adaptive
 * Simpson for general functions.
 *
 * STRATEGY (design decision D-integral):
 *   1. Symbolic antiderivative for POLYNOMIALS in the variable (degree ≤ 3
 *      extraction window): coefficients fitted exactly via a Vandermonde
 *      solve at deterministic points, verified at independent points, and
 *      the antiderivative SELF-CHECKED by requiring dF/dx − f ≡ 0
 *      numerically at probe points before returning — a wrong F never
 *      ships.
 *   2. Definite integrals: exact F(b) − F(a) on the polynomial path;
 *      otherwise ADAPTIVE SIMPSON on the audited AST with an error
 *      estimate (documented limits: endpoint/interior singularities,
 *      highly oscillatory integrands, huge magnitudes may exhaust the
 *      tolerance budget at the depth cap).
 *
 * Security: integrand passes parseAndAudit; the numeric path evaluates
 * the audited AST only.
 *
 * @module engine/integral
 */

import { parseAndAudit, getSandboxMath, requireBoundSymbols } from './evaluate.js'

/** Max denominators for exact fraction formatting of coefficients. */
const FRACTION_DENOMINATOR_CAP = 1000

/** Adaptive Simpson: recursion depth cap and base tolerance. */
const SIMPSON_DEPTH_CAP = 24
const SIMPSON_TOLERANCE = 1e-10

/**
 * Evaluate the audited AST at a point.
 *
 * @param {object} fNode - Audited AST.
 * @param {string} variable - Operation variable.
 * @param {object|undefined} scope - Sanitized scope.
 * @param {number} x - Point.
 * @returns {*} Raw evaluation result.
 * @private
 */
function evalAstAt(fNode, variable, scope, x) {
  const localScope = { ...(scope ?? {}) }
  localScope[variable] = x
  return fNode.evaluate(localScope)
}

/**
 * Fit polynomial coefficients of f (degree ≤ 4) at deterministic sample
 * points via Gaussian elimination on the Vandermonde system, and verify
 * the fit at independent points.
 *
 * @param {object} fNode - Audited AST.
 * @param {string} variable - Variable.
 * @param {object|undefined} scope - Sanitized scope.
 * @returns {number[]|null} Coefficients [c0..c4] with trailing zeros
 *   trimmed, or null when f is not a polynomial of degree ≤ 4.
 * @private
 */
function fitPolynomial(fNode, variable, scope) {
  const pts = [0, 1, -1, 2, -2]
  const values = pts.map((x) => evalAstAt(fNode, variable, scope, x))
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) return null

  const n = 5
  const A = pts.map((p, i) => {
    const row = []
    for (let k = 0; k < n; k++) row.push(Math.pow(p, k))
    row.push(values[i])
    return row
  })

  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r
    }
    if (Math.abs(A[pivot][col]) < 1e-14) return null
    const tmp = A[col]
    A[col] = A[pivot]
    A[pivot] = tmp
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const factor = A[r][col] / A[col][col]
      for (let k = col; k <= n; k++) A[r][k] -= factor * A[col][k]
      if (!Number.isFinite(A[r][n])) return null
    }
  }
  const coeffs = []
  for (let k = 0; k < n; k++) coeffs.push(A[k][n] / A[k][k])

  // Verify at independent points (never among the sample set).
  for (const x of [-0.5, 1.5, 3]) {
    const actual = evalAstAt(fNode, variable, scope, x)
    if (typeof actual !== 'number' || !Number.isFinite(actual)) return null
    let predicted = 0
    for (let k = 0; k < coeffs.length; k++) predicted += coeffs[k] * Math.pow(x, k)
    const scale = Math.max(1, Math.abs(actual), Math.abs(predicted))
    if (Math.abs(actual - predicted) > 1e-9 * scale) return null
  }

  while (coeffs.length > 1 && Math.abs(coeffs[coeffs.length - 1]) < 1e-14) coeffs.pop()
  return coeffs
}

/**
 * Format a coefficient exactly when it is an integer or small fraction.
 *
 * @param {object} math - Sandboxed instance.
 * @param {number} c - Coefficient value.
 * @returns {string} Formatted coefficient.
 * @private
 */
function formatCoeff(math, c) {
  if (Number.isInteger(c)) return String(c)
  try {
    const frac = math.fraction(c)
    if (frac.d > 0 && frac.d <= FRACTION_DENOMINATOR_CAP && Number(frac) === c) {
      const sign = frac.s < 0 ? '-' : ''
      if (frac.d === 1) return `${sign}${frac.n}`
      return `${sign}${frac.n} / ${frac.d}`
    }
  } catch {
    // fall through to decimal formatting
  }
  return math.format(c, { precision: 14 })
}

/**
 * Build the antiderivative expression from polynomial coefficients
 * (highest power first, exact fractions where possible, C = 0).
 *
 * @param {object} math - Sandboxed instance.
 * @param {number[]} coeffs - [c0, c1, ..., cD].
 * @param {string} variable - Variable name.
 * @returns {string} Antiderivative string, '0' when f ≡ 0.
 * @private
 */
function buildAntiderivative(math, coeffs, variable) {
  const parts = []
  for (let k = coeffs.length - 1; k >= 0; k--) {
    const c = coeffs[k]
    if (Math.abs(c) < 1e-14) continue
    const power = k + 1
    let coeffStr = formatCoeff(math, c / (k + 1))
    // Elide unit coefficients: 'x ^ 3' not '1 * x ^ 3'; '-x ^ 2' not
    // '-1 * x ^ 2'. Non-unit coefficients keep the explicit form.
    let term
    if (coeffStr === '1') {
      term = power === 1 ? variable : `${variable} ^ ${power}`
    } else if (coeffStr === '-1') {
      term = power === 1 ? `-${variable}` : `-${variable} ^ ${power}`
    } else {
      term = power === 1 ? `${coeffStr} * ${variable}` : `${coeffStr} * ${variable} ^ ${power}`
    }
    parts.push(term)
  }
  if (parts.length === 0) return '0'
  return parts.join(' + ').replace(/\+ -/g, '- ')
}

/**
 * Self-check: differentiate F and require the difference from f to be
 * numerically zero at probe points.
 *
 * @param {object} math - Sandboxed instance.
 * @param {object} fNode - Original integrand AST.
 * @param {string} FStr - Antiderivative candidate string.
 * @param {string} variable - Variable.
 * @param {object|undefined} scope - Sanitized scope.
 * @returns {boolean} True when F′ ≡ f at the probes.
 * @private
 */
function verifyAntiderivative(math, fNode, FStr, variable, scope) {
  try {
    const FNode = math.parse(FStr)
    const dF = math.derivative(FNode, variable)
    const difference = new math.OperatorNode('-', 'subtract', [dF, fNode])
    for (const p of [0.1, 0.7, 1.3, 2.1, -0.9]) {
      const localScope = { ...(scope ?? {}) }
      localScope[variable] = p
      const d = difference.evaluate(localScope)
      if (typeof d !== 'number' || !Number.isFinite(d)) return false
      if (Math.abs(d) > 1e-9) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Symbolic antiderivative of a polynomial in the variable.
 *
 * @param {string|object} expression - Integrand string (or parsed AST).
 * @param {string} variable - Integration variable.
 * @param {object} [scope] - Optional coefficient values, e.g. { a: 2 }.
 * @returns {string} Exact antiderivative (C = 0).
 * @throws {Error} When the integrand is not a polynomial (degree ≤ 3)
 *   with scope-resolvable coefficients, or on security violations.
 */
export function symbolicAntiderivative(expression, variable, scope) {
  if (typeof variable !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(variable)) {
    throw new Error(
      `integration variable must be a valid variable name (got ${JSON.stringify(variable)})`,
    )
  }
  let math
  let node
  let cleanScope
  if (typeof expression === 'string') {
    const parsed = parseAndAudit(expression, scope, { allowFreeSymbols: true })
    math = parsed.math
    node = parsed.node
    cleanScope = parsed.cleanScope
  } else {
    math = getSandboxMath()
    node = expression
    cleanScope = undefined
  }
  requireBoundSymbols(math, node, cleanScope, variable)

  const coeffs = fitPolynomial(node, variable, cleanScope)
  if (!coeffs) {
    throw new Error(
      'symbolic antiderivative requires a polynomial integrand (degree ≤ 4) — use integrate() for numeric definite integrals',
    )
  }

  const F = buildAntiderivative(math, coeffs, variable)
  if (!verifyAntiderivative(math, node, F, variable, cleanScope)) {
    throw new Error('internal error: antiderivative failed self-check (F-prime differs from f)')
  }
  return F
}

/**
 * Single-panel Simpson rule.
 *
 * @param {Function} evalF - Evaluator returning finite numbers.
 * @param {number} a - Left edge.
 * @param {number} b - Right edge.
 * @param {number} fa - f(a).
 * @param {number} fb - f(b).
 * @param {number} fm - f((a + b) / 2).
 * @returns {number} Simpson estimate for the panel.
 * @private
 */
function simpsonPanel(evalF, a, b, fa, fb, fm) {
  return ((b - a) / 6) * (fa + 4 * fm + fb)
}

/**
 * Recursive adaptive Simpson step (Richardson-extrapolated form): split
 * the panel, compare the two halves against the whole, and either
 * correct by delta / 15 or recurse with half the tolerance budget.
 *
 * @param {Function} evalF - Evaluator returning finite numbers.
 * @param {number} a - Panel left edge.
 * @param {number} b - Panel right edge.
 * @param {number} fa - f(a).
 * @param {number} fb - f(b).
 * @param {number} whole - Simpson estimate for the full panel.
 * @param {number} tol - Tolerance budget for this panel.
 * @param {number} depth - Remaining recursion depth.
 * @returns {{value: number, errorEstimate: number}}
 * @private
 */
function simpsonRecurse(evalF, a, b, fa, fb, whole, tol, depth) {
  const m = (a + b) / 2
  const flm = evalF((a + m) / 2)
  const frm = evalF((m + b) / 2)
  if (!Number.isFinite(flm) || !Number.isFinite(frm)) {
    throw new Error('integrand is not finite inside the integration interval')
  }
  const fm = evalF(m)
  const left = simpsonPanel(evalF, a, m, fa, fm, flm)
  const right = simpsonPanel(evalF, m, b, fm, fb, frm)
  const delta = left + right - whole
  if (depth <= 0 || Math.abs(delta) <= 15 * tol) {
    return { value: left + right + delta / 15, errorEstimate: Math.abs(delta) / 15 }
  }
  const l = simpsonRecurse(evalF, a, m, fa, fm, left, tol / 2, depth - 1)
  const r = simpsonRecurse(evalF, m, b, fm, fb, right, tol / 2, depth - 1)
  return {
    value: l.value + r.value,
    errorEstimate: Math.hypot(l.errorEstimate, r.errorEstimate),
  }
}

/**
 * Adaptive Simpson integration of the audited AST between bounds.
 *
 * @param {object} fNode - Audited integrand AST.
 * @param {string} variable - Variable.
 * @param {object|undefined} scope - Sanitized scope.
 * @param {number} a - Lower bound.
 * @param {number} b - Upper bound.
 * @returns {{value: number, errorEstimate: number}}
 * @throws {Error} When the integrand is non-finite at the bounds or
 *   inside the interval.
 * @private
 */
function adaptiveSimpson(fNode, variable, scope, a, b) {
  const evalF = (x) => {
    const v = evalAstAt(fNode, variable, scope, x)
    return typeof v === 'number' ? v : NaN
  }
  const fa = evalF(a)
  const fb = evalF(b)
  if (!Number.isFinite(fa) || !Number.isFinite(fb)) {
    throw new Error('integrand is not finite at the integration bounds')
  }
  const fm = evalF((a + b) / 2)
  if (!Number.isFinite(fm)) {
    throw new Error('integrand is not finite at the interval midpoint')
  }
  const whole = simpsonPanel(evalF, a, b, fa, fb, fm)
  return simpsonRecurse(evalF, a, b, fa, fb, whole, SIMPSON_TOLERANCE, SIMPSON_DEPTH_CAP)
}

/**
 * Force the numeric path (exported for tests and cross-checks).
 *
 * @param {string|object} expression - Integrand string (or parsed AST).
 * @param {string} variable - Integration variable.
 * @param {number} a - Lower bound (finite).
 * @param {number} b - Upper bound (finite).
 * @param {object} [scope] - Optional coefficient values.
 * @returns {{method: 'numeric', value: number, errorEstimate: number}}
 * @throws {Error} Same as integrate(); always takes the numeric path.
 */
export function integrateNumeric(expression, variable, a, b, scope) {
  let node
  let cleanScope
  if (typeof expression === 'string') {
    const parsed = parseAndAudit(expression, scope, { allowFreeSymbols: true })
    node = parsed.node
    cleanScope = parsed.cleanScope
  } else {
    node = expression
    cleanScope = undefined
  }
  const math = getSandboxMath()
  requireBoundSymbols(math, node, cleanScope, variable)
  const { value, errorEstimate } = adaptiveSimpson(node, variable, cleanScope, a, b)
  return { method: 'numeric', value, errorEstimate }
}

/**
 * Definite integral of f from a to b.
 *
 * @param {string|object} expression - Integrand f(x), e.g. 'x^2' or
 *   'sin(x)'.
 * @param {string} variable - Integration variable.
 * @param {number} a - Lower bound (finite number).
 * @param {number} b - Upper bound (finite number).
 * @param {object} [scope] - Optional coefficient values, e.g. { k: 5 }.
 * @returns {{method: 'polynomial'|'numeric', value: number,
 *   errorEstimate?: number}} Exact value on the polynomial path (no
 *   errorEstimate); adaptive Simpson with error estimate otherwise.
 * @throws {Error} On security violations, non-finite bounds, a missing
 *   variable with a non-constant integrand, non-finite integrand values,
 *   or a failed antiderivative self-check on the polynomial path.
 */
export function integrate(expression, variable, a, b, scope) {
  // Bounds validation before any parsing (fail fast on caller errors).
  for (const [label, bound] of [
    ['lower', a],
    ['upper', b],
  ]) {
    if (typeof bound !== 'number' || !Number.isFinite(bound)) {
      throw new Error(`${label} bound must be a finite number (got ${bound})`)
    }
  }
  if (typeof variable !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(variable)) {
    throw new Error(
      `integration variable must be a valid variable name (got ${JSON.stringify(variable)})`,
    )
  }

  let math
  let node
  let cleanScope
  if (typeof expression === 'string') {
    const parsed = parseAndAudit(expression, scope, { allowFreeSymbols: true })
    math = parsed.math
    node = parsed.node
    cleanScope = parsed.cleanScope
  } else {
    math = getSandboxMath()
    node = expression
    cleanScope = undefined
  }
  // Equal bounds: the integral is exactly 0 for any integrable f.
  if (a === b) return { method: 'polynomial', value: 0 }

  requireBoundSymbols(math, node, cleanScope, variable)

  // Constant integrand (variable absent): c·(b − a). Evaluated WITHOUT
  // the variable bound — 'y^2' w.r.t. 'x' is a valid constant integrand.
  let appears = false
  node.traverse((n) => {
    if (n.isSymbolNode && n.name === variable) appears = true
  })
  if (!appears) {
    const c = node.evaluate({ ...(cleanScope ?? {}) })
    if (typeof c !== 'number' || !Number.isFinite(c)) {
      throw new Error(
        `variable '${variable}' does not appear in the integrand and the integrand is not a finite constant`,
      )
    }
    return { method: 'polynomial', value: c * (b - a) }
  }

  // Polynomial path: exact F(b) − F(a) with self-check.
  const coeffs = fitPolynomial(node, variable, cleanScope)
  if (coeffs) {
    const F = buildAntiderivative(math, coeffs, variable)
    if (verifyAntiderivative(math, node, F, variable, cleanScope)) {
      const FNode = math.parse(F)
      const Fa = evalAstAt(FNode, variable, cleanScope, a)
      const Fb = evalAstAt(FNode, variable, cleanScope, b)
      const value = Fb - Fa
      if (Number.isFinite(value)) return { method: 'polynomial', value }
    }
  }

  // Numeric path: adaptive Simpson.
  const { value, errorEstimate } = adaptiveSimpson(node, variable, cleanScope, a, b)
  return { method: 'numeric', value, errorEstimate }
}
