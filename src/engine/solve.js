/**
 * Equation solving — symbolic linear/quadratic + numeric general fallback.
 *
 * STRATEGY (design decision D-solve):
 *   1. Parse both sides of 'lhs = rhs' (or a bare expression meaning '= 0')
 *      through the shared security policy (parseAndAudit).
 *   2. Build f(x) = lhs - rhs as an AST.
 *   3. Attempt SYMBOLIC extraction of polynomial coefficients (degree ≤ 2)
 *      by sampling f at deterministic points and VERIFying the sampled
 *      quadratic at additional points — a genuine degree-≤2 polynomial
 *      matches everywhere; a cubic/quartic/transcendental fails
 *      verification and falls through to the numeric path. Roots are then
 *      exact: rationals formatted as fractions, complex pairs as 'a + b*i'.
 *   4. Otherwise solve NUMERICALLY: deterministic scan over [-100, 100]
 *      (20001 samples), exact-zero samples and sign changes polished by
 *      bisection (80 iterations → machine precision). Documented
 *      limitation: even-multiplicity roots are found only when they land
 *      on the 0.01 scan grid; roots outside the window are not found.
 *
 * Security: all ASTs are audited (no assignments, no host globals, no
 * prototype gadgets). The numeric path evaluates the AUDITED AST only.
 *
 * @module engine/solve
 */

import { parseAndAudit, getSandboxMath } from './evaluate.js'

/** Numeric scan window: roots are searched in [-WINDOW, WINDOW]. */
const NUMERIC_WINDOW = 100

/** Number of scan intervals (20001 samples, step 0.01). */
const NUMERIC_INTERVALS = 20000

/** Bisection iterations per bracket (2^-80 interval reduction). */
const BISECT_ITERATIONS = 80

/** Max denominator for exact fraction formatting of roots. */
const FRACTION_DENOMINATOR_CAP = 1000

/**
 * Validate a solve variable name.
 *
 * @param {string} name - Variable to solve for.
 * @returns {string} The validated name.
 * @throws {Error} When the name is not a valid math symbol.
 * @private
 */
function requireSolveVariable(name) {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`solve variable must be a valid variable name (got ${JSON.stringify(name)})`)
  }
  return name
}

/**
 * Evaluate the audited AST at a specific variable value.
 *
 * @param {object} math - Sandboxed mathjs instance.
 * @param {object} fNode - Audited AST for f.
 * @param {string} variable - The solve variable.
 * @param {object|undefined} scope - Sanitized user scope.
 * @param {number} x - Value to substitute.
 * @returns {*} The raw evaluation result (may be non-number).
 * @private
 */
function evalAstAt(math, fNode, variable, scope, x) {
  const localScope = { ...(scope ?? {}) }
  localScope[variable] = x
  return fNode.evaluate(localScope)
}

/**
 * Check every symbol in the AST is bound: a namespace member, a scope
 * variable, or the solve variable itself. Unbound symbols would make
 * coefficient evaluation impossible — the caller gets a precise error.
 *
 * @param {object} math - Sandboxed instance.
 * @param {object} node - AST to walk.
 * @param {object|undefined} scope - Sanitized scope.
 * @param {string} variable - The solve variable (allowed free symbol).
 * @throws {Error} On any unbound non-variable symbol.
 * @private
 */
function requireBoundSymbols(math, node, scope, variable) {
  const unbound = new Set()
  node.traverse((n) => {
    if (!n.isSymbolNode) return
    const name = n.name
    if (name === variable) return
    if (Object.hasOwn(math, name)) return
    if (scope && Object.hasOwn(scope, name)) return
    unbound.add(name)
  })
  if (unbound.size > 0) {
    const names = [...unbound].sort().map((s) => `'${s}'`).join(', ')
    throw new Error(
      `coefficients must be numeric or resolvable via scope — unresolved symbol(s): ${names}`,
    )
  }
}

/**
 * Verify the variable actually appears in the equation AST.
 *
 * @param {object} node - AST to walk.
 * @param {string} variable - The solve variable.
 * @throws {Error} When the variable is absent.
 * @private
 */
function requireVariableAppears(node, variable) {
  let found = false
  node.traverse((n) => {
    if (n.isSymbolNode && n.name === variable) found = true
  })
  if (!found) {
    throw new Error(`variable '${variable}' does not appear in the equation`)
  }
}

/**
 * Attempt to extract polynomial coefficients (degree ≤ 2) from f by
 * 3-point sampling with independent verification points.
 *
 * Sampling identity: for f(x) = c2·x² + c1·x + c0,
 *   c0 = f(0), c1 = (f(1) − f(−1))/2, c2 = (f(1) + f(−1))/2 − c0.
 * A non-polynomial (or degree ≥ 3) function fails verification at
 * x ∈ {2, −2, 3} and is rejected.
 *
 * @param {object} math - Sandboxed instance.
 * @param {object} fNode - Audited AST for f.
 * @param {string} variable - The solve variable.
 * @param {object|undefined} scope - Sanitized scope.
 * @returns {{c0: number, c1: number, c2: number}|null} Coefficients, or
 *   null when f is not a degree-≤2 polynomial in the variable.
 * @private
 */
function tryExtractQuadratic(math, fNode, variable, scope) {
  const at = (x) => evalAstAt(math, fNode, variable, scope, x)
  const f0 = at(0)
  const f1 = at(1)
  const fm1 = at(-1)
  if (![f0, f1, fm1].every((v) => typeof v === 'number' && Number.isFinite(v))) return null

  const c0 = f0
  const c1 = (f1 - fm1) / 2
  const c2 = (f1 + fm1) / 2 - c0

  // Verification: the sampled quadratic must match f at independent
  // points. Tolerance is relative to the value scale (float round-off in
  // the sampling arithmetic must not reject genuine quadratics).
  for (const x of [2, -2, 3]) {
    const actual = at(x)
    if (typeof actual !== 'number' || !Number.isFinite(actual)) return null
    const predicted = c0 + c1 * x + c2 * x * x
    const scale = Math.max(1, Math.abs(actual), Math.abs(predicted))
    if (Math.abs(actual - predicted) > 1e-9 * scale) return null
  }
  return { c0, c1, c2 }
}

/**
 * Format a real root: integers plain, exact rationals as 'n / d'
 * fractions (capped denominator), otherwise 14 significant digits.
 *
 * @param {object} math - Sandboxed instance (fraction + format).
 * @param {number} x - Root value.
 * @returns {string} Formatted root.
 * @private
 */
function formatRealRoot(math, x) {
  if (x === 0) return '0'
  if (Number.isInteger(x)) return String(x)
  try {
    const frac = math.fraction(x)
    if (frac.d > 0 && frac.d <= FRACTION_DENOMINATOR_CAP && Number(frac) === x) {
      const sign = frac.s < 0 ? '-' : ''
      return frac.d === 1 ? `${sign}${frac.n}` : `${sign}${frac.n} / ${frac.d}`
    }
  } catch {
    // Fraction conversion failed — decimal fallback below.
  }
  return math.format(x, { precision: 14 })
}

/**
 * Solve a verified degree-≤2 polynomial symbolically.
 *
 * @param {object} math - Sandboxed instance.
 * @param {{c0: number, c1: number, c2: number}} c - Coefficients.
 * @returns {string[]} Roots (ascending for real roots; complex pairs
 *   listed +imag then −imag). 'all values' is never returned here —
 *   identity handling lives in solveEquation.
 * @private
 */
function solveQuadraticCoeffs(math, { c0, c1, c2 }) {
  const SCALE = Math.max(1, Math.abs(c0), Math.abs(c1), Math.abs(c2))

  if (Math.abs(c2) < 1e-15 * SCALE) {
    // Linear: c1·x + c0 = 0
    if (Math.abs(c1) < 1e-15 * SCALE) return [] // constant ≠ 0: no solution
    return [formatRealRoot(math, -c0 / c1)]
  }

  // Quadratic: c2·x² + c1·x + c0 = 0
  const disc = c1 * c1 - 4 * c2 * c0
  const discTol = 1e-12 * SCALE * SCALE

  if (disc > discTol) {
    const sq = Math.sqrt(disc)
    const r1 = (-c1 + sq) / (2 * c2)
    const r2 = (-c1 - sq) / (2 * c2)
    const roots = [r1, r2].sort((a, b) => a - b)
    // Collapse numerically-identical double roots.
    if (Math.abs(roots[0] - roots[1]) <= 1e-12 * Math.max(1, Math.abs(roots[0]))) {
      return [formatRealRoot(math, roots[0])]
    }
    return roots.map((r) => formatRealRoot(math, r))
  }

  if (disc < -discTol) {
    // Complex conjugate pair: re ± i·|im|
    const re = -c1 / (2 * c2)
    const im = Math.sqrt(-disc) / (2 * c2)
    const plus = math.complex(re, Math.abs(im))
    const minus = math.complex(re, -Math.abs(im))
    return [math.format(plus, { precision: 14 }), math.format(minus, { precision: 14 })]
  }

  // Double root.
  return [formatRealRoot(math, -c1 / (2 * c2))]
}

/**
 * Bisect a sign-change bracket to machine precision.
 *
 * @param {Function} evalF - f(x) evaluator returning finite numbers.
 * @param {number} a - Bracket low (f(a) finite, sign ≠ f(b)).
 * @param {number} b - Bracket high.
 * @param {number} fa - f(a).
 * @returns {number} Approximate root.
 * @private
 */
function bisect(evalF, a, b, fa) {
  let lo = a
  let hi = b
  let flo = fa
  for (let i = 0; i < BISECT_ITERATIONS; i++) {
    const mid = lo + (hi - lo) / 2
    if (mid === lo || mid === hi) break // interval collapsed
    const fm = evalF(mid)
    if (typeof fm !== 'number' || !Number.isFinite(fm)) break
    if (fm === 0) return mid
    if (flo * fm < 0) {
      hi = mid
    } else {
      lo = mid
      flo = fm
    }
  }
  return lo + (hi - lo) / 2
}

/**
 * Numeric root-finding over the deterministic scan window.
 *
 * @param {object} math - Sandboxed instance.
 * @param {object} fNode - Audited AST for f.
 * @param {string} variable - The solve variable.
 * @param {object|undefined} scope - Sanitized scope.
 * @returns {{kind: 'numeric', roots: string[]}} Formatted roots ascending.
 * @throws {Error} When f never evaluates to a real number on the scan.
 * @private
 */
function solveNumeric(math, fNode, variable, scope) {
  const evalF = (x) => {
    const v = evalAstAt(math, fNode, variable, scope, x)
    return typeof v === 'number' ? v : NaN
  }

  const rawRoots = []
  let prevX = null
  let prevF = null
  let sawRealValue = false

  for (let i = 0; i <= NUMERIC_INTERVALS; i++) {
    const x = -NUMERIC_WINDOW + (2 * NUMERIC_WINDOW * i) / NUMERIC_INTERVALS
    const f = evalF(x)
    if (!Number.isFinite(f)) {
      prevX = null
      prevF = null
      continue
    }
    sawRealValue = true
    if (f === 0) {
      rawRoots.push(x)
    } else if (prevF !== null && prevF * f < 0) {
      rawRoots.push(bisect(evalF, prevX, x, prevF))
    }
    prevX = x
    prevF = f
  }

  if (!sawRealValue) {
    throw new Error(
      `expression did not evaluate to a real-valued function of '${variable}' on the scan window`,
    )
  }

  // Sort ascending and dedupe near-identical roots.
  rawRoots.sort((a, b) => a - b)
  const roots = []
  for (const r of rawRoots) {
    const prev = roots[roots.length - 1]
    if (prev === undefined || Math.abs(r - prev) > 1e-8 * Math.max(1, Math.abs(r))) {
      roots.push(r)
    }
  }
  return { kind: 'numeric', roots: roots.map((r) => math.format(r, { precision: 14 })) }
}

/**
 * Solve an equation for a variable.
 *
 * @param {string} equation - 'lhs = rhs', or a bare expression meaning
 *   '= 0'. Exactly one '=' is required when present.
 * @param {string} variable - Variable to solve for, e.g. 'x'.
 * @param {object} [scope] - Optional coefficient values, e.g. { a: 4 }.
 * @returns {{variable: string, kind: 'symbolic'|'numeric', roots: string[],
 *   equation: string}} `roots` holds exact strings for the symbolic path
 *   (rationals as fractions, complex pairs as 'a + b*i') and 14-digit
 *   decimals for the numeric path. Identity equations report
 *   `['all values']`; contradictions report `[]`.
 * @throws {Error} On security-policy violations, malformed equations,
 *   unbound coefficients, or a missing solve variable.
 */
export function solveEquation(equation, variable, scope) {
  requireSolveVariable(variable)

  if (typeof equation !== 'string' || equation.trim() === '') {
    throw new Error('equation must be a non-empty string')
  }

  // Split into lhs / rhs (a bare expression means '= 0').
  let lhsStr
  let rhsStr
  if (equation.includes('=')) {
    const parts = equation.split('=')
    if (parts.length !== 2) {
      throw new Error("equation must contain exactly one '=' (use '==' never; this is not a comparison)")
    }
    lhsStr = parts[0]
    rhsStr = parts[1]
  } else {
    lhsStr = equation
    rhsStr = '0'
  }

  // Parse both sides under the shared security policy. Free symbols are
  // allowed at parse time; binding is enforced just below.
  const lhs = parseAndAudit(lhsStr, scope, { allowFreeSymbols: true })
  const rhs = parseAndAudit(rhsStr, scope, { allowFreeSymbols: true })
  const math = getSandboxMath()

  // An equation is an EQUALITY. Comparison operators are caller errors —
  // without this check mathjs coerces their boolean results to numbers
  // and the numeric scanner would report the step function's zeros.
  const COMPARISON_OPS = new Set(['smaller', 'smallerEq', 'larger', 'largerEq', 'equal', 'unequal'])
  for (const side of [lhs.node, rhs.node]) {
    side.traverse((n) => {
      if (n.isOperatorNode && COMPARISON_OPS.has(n.fn?.name ?? n.fn)) {
        throw new Error(
          `comparison operator '${n.op}' is not valid in an equation — use '=' for equality`,
        )
      }
    })
  }

  // f = lhs - rhs. The OperatorNode's second argument MUST be the
  // namespace function name ('subtract') — evaluation resolves operators
  // through typed functions in the instance namespace.
  const fNode = new math.OperatorNode('-', 'subtract', [lhs.node, rhs.node])

  requireVariableAppears(fNode, variable)
  requireBoundSymbols(math, fNode, scope, variable)

  const equationLabel = equation.trim()

  // Symbolic attempt: degree ≤ 2 polynomial in the variable.
  const coeffs = tryExtractQuadratic(math, fNode, variable, scope)
  if (coeffs) {
    const { c0, c1, c2 } = coeffs
    const SCALE = Math.max(1, Math.abs(c0), Math.abs(c1), Math.abs(c2))
    const isZero = (v) => Math.abs(v) < 1e-15 * SCALE

    // Identity: 0 = 0 → every value of the variable solves it.
    if (isZero(c0) && isZero(c1) && isZero(c2)) {
      return { variable, kind: 'symbolic', roots: ['all values'], equation: equationLabel }
    }
    return {
      variable,
      kind: 'symbolic',
      roots: solveQuadraticCoeffs(math, coeffs),
      equation: equationLabel,
    }
  }

  // Numeric fallback for higher-degree polynomials and transcendental f.
  return { variable, ...solveNumeric(math, fNode, variable, scope), equation: equationLabel }
}
