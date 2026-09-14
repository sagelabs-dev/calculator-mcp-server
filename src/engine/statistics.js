/**
 * Statistics — descriptive stats, Pearson correlation, OLS linear
 * regression, and t-based confidence intervals.
 *
 * Pure deterministic functions over finite numeric arrays. No mathjs
 * dependency (plain arithmetic only) — but the same fail-closed input
 * validation discipline as the rest of the engine.
 *
 * The t-quantile uses the Lentz continued-fraction incomplete beta
 * function (Numerical Recipes betacf/betai + Lanczos log-gamma),
 * inverted by bisection — verified in tests against R's qt() and
 * t.test() reference values.
 *
 * @module engine/statistics
 */

/** Maximum accepted data length (DoS bound for O(n) operations). */
const MAX_DATA_LENGTH = 1_000_000

/**
 * Validate a numeric data array.
 *
 * @param {*} data - Candidate array.
 * @param {string} label - Name used in error messages.
 * @returns {number[]} The validated array (same reference).
 * @throws {Error} On non-arrays, empty arrays, over-length arrays, or
 *   non-finite / non-number elements.
 * @private
 */
function requireData(data, label) {
  if (!Array.isArray(data)) {
    throw new Error(`${label} must be an array of numbers`)
  }
  if (data.length === 0) {
    throw new Error(`${label} must not be empty`)
  }
  if (data.length > MAX_DATA_LENGTH) {
    throw new Error(`${label} exceeds maximum length of ${MAX_DATA_LENGTH}`)
  }
  for (const v of data) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`${label} must contain only finite numbers (got ${JSON.stringify(v)})`)
    }
  }
  return data
}

/**
 * Require two paired numeric series of equal length (≥ minN).
 *
 * @param {*} xs - First series.
 * @param {*} ys - Second series.
 * @param {number} minN - Minimum length.
 * @param {string} opLabel - Operation name for errors.
 * @returns {{xs: number[], ys: number[], n: number}}
 * @private
 */
function requirePairedData(xs, ys, minN, opLabel) {
  requireData(xs, 'x values')
  requireData(ys, 'y values')
  if (xs.length !== ys.length) {
    throw new Error(`${opLabel} requires x and y arrays of the same length`)
  }
  if (xs.length < minN) {
    throw new Error(`${opLabel} requires at least ${minN} data points`)
  }
  return { xs, ys, n: xs.length }
}

/**
 * Mean of an array.
 *
 * @param {number[]} data - Validated finite numbers.
 * @returns {number} Arithmetic mean.
 * @private
 */
function mean(data) {
  let sum = 0
  for (const v of data) sum += v
  return sum / data.length
}

/**
 * Quantile via linear interpolation (R's type 7 / numpy 'linear').
 *
 * @param {number[]} sorted - Pre-sorted array.
 * @param {number} p - Quantile in [0, 1].
 * @returns {number} Interpolated quantile.
 * @private
 */
function quantileType7(sorted, p) {
  const h = (sorted.length - 1) * p
  const lo = Math.floor(h)
  const hi = Math.ceil(h)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo])
}

/**
 * Descriptive statistics for a dataset.
 *
 * @param {number[]} data - Finite numeric array (1..1,000,000 items).
 * @returns {{n: number, mean: number, median: number, mode: number[],
 *   varianceSample: number, sdSample: number, variancePopulation: number,
 *   sdPopulation: number, min: number, max: number, q1: number, q3: number,
 *   iqr: number}} `mode` lists all tied modes ([] when no value repeats);
 *   sample variance uses n-1 denominator (undefined→0 for n=1); quartiles
 *   use linear interpolation (R type 7).
 * @throws {Error} On invalid data.
 */
export function describeData(data) {
  requireData(data, 'data')
  const n = data.length
  const sorted = [...data].sort((a, b) => a - b)
  const mu = mean(data)

  // Median (interpolated for even n).
  const median = quantileType7(sorted, 0.5)

  // Mode: all values achieving the max frequency; [] when none repeats.
  const counts = new Map()
  let maxCount = 1
  for (const v of data) counts.set(v, (counts.get(v) ?? 0) + 1)
  for (const c of counts.values()) if (c > maxCount) maxCount = c
  const mode = []
  if (maxCount > 1) {
    for (const [v, c] of counts) if (c === maxCount) mode.push(v)
    mode.sort((a, b) => a - b)
  }

  // Variances (sample n-1, population n).
  let ss = 0
  for (const v of data) ss += (v - mu) * (v - mu)
  const varianceSample = n > 1 ? ss / (n - 1) : 0
  const variancePopulation = ss / n

  const q1 = quantileType7(sorted, 0.25)
  const q3 = quantileType7(sorted, 0.75)

  return {
    n,
    mean: mu,
    median,
    mode,
    varianceSample,
    sdSample: Math.sqrt(varianceSample),
    variancePopulation,
    sdPopulation: Math.sqrt(variancePopulation),
    min: sorted[0],
    max: sorted[n - 1],
    q1,
    q3,
    iqr: q3 - q1,
  }
}

/**
 * Pearson correlation coefficient.
 *
 * @param {number[]} xs - First series.
 * @param {number[]} ys - Second series.
 * @returns {number} r in [-1, 1].
 * @throws {Error} On invalid/mismatched data, < 2 points, or a constant
 *   series (correlation undefined).
 */
export function correlation(xs, ys) {
  const { n } = requirePairedData(xs, ys, 2, 'correlation')
  const mx = mean(xs)
  const my = mean(ys)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (sxx === 0 || syy === 0) {
    throw new Error('correlation is undefined for a constant series (zero variance)')
  }
  return sxy / Math.sqrt(sxx * syy)
}

/**
 * Ordinary least squares linear regression y = slope·x + intercept.
 *
 * @param {number[]} xs - Predictor values.
 * @param {number[]} ys - Response values.
 * @returns {{slope: number, intercept: number, r2: number, rmse: number,
 *   n: number, predict: (x: number) => number}} r2 = coefficient of
 *   determination; rmse = root mean squared error of residuals;
 *   predict(x) extrapolates the fitted line.
 * @throws {Error} On invalid/mismatched data, < 2 points, or constant x.
 */
export function linearRegression(xs, ys) {
  const { n } = requirePairedData(xs, ys, 2, 'linear regression')
  const mx = mean(xs)
  const my = mean(ys)
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) * (xs[i] - mx)
  }
  if (sxx === 0) {
    throw new Error('linear regression is undefined for constant x (zero variance)')
  }
  const slope = sxy / sxx
  const intercept = my - slope * mx

  // Goodness of fit.
  let ssRes = 0
  let ssTot = 0
  for (let i = 0; i < n; i++) {
    const residual = ys[i] - (slope * xs[i] + intercept)
    ssRes += residual * residual
    ssTot += (ys[i] - my) * (ys[i] - my)
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot
  const rmse = Math.sqrt(ssRes / n)

  return {
    slope,
    intercept,
    r2,
    rmse,
    n,
    predict: (x) => slope * x + intercept,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// t-distribution quantile — Lentz continued fraction incomplete beta.
// Numerical Recipes §6.4 (betacf / betai) + Lanczos log-gamma.
// ──────────────────────────────────────────────────────────────────────────

/** Lanczos g coefficient for log-gamma (g=7, n=9 coefficients). */
const LANCZOS_G = 7

/** Lanczos series coefficients (g = 7). */
const LANCZOS_COEFFS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
]

/**
 * Natural log of the gamma function (Lanczos approximation).
 * Valid for real x > 0.
 *
 * @param {number} x - Argument (> 0).
 * @returns {number} ln Γ(x).
 * @private
 */
function logGamma(x) {
  if (x < 0.5) {
    // Reflection formula: Γ(x)·Γ(1−x) = π / sin(πx)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
  }
  const z = x - 1
  let a = LANCZOS_COEFFS[0]
  const t = z + LANCZOS_G + 0.5
  for (let i = 1; i < LANCZOS_COEFFS.length; i++) {
    a += LANCZOS_COEFFS[i] / (z + i)
  }
  // Lanczos: Γ(z+1) = √(2π)·t^(z+½)·e^(−t)·A(z) — the exponent is
  // z + ½ (= x − ½), NOT z + g + ½. Verified against Γ(0.5)=√π and
  // Γ(5.5)=52.3428 in the test suite.
  return (
    0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a)
  )
}

/**
 * Continued fraction for the incomplete beta function (Lentz's method,
 * modified to avoid division by zero) — Numerical Recipes betacf.
 *
 * @param {number} a - Shape parameter a > 0.
 * @param {number} b - Shape parameter b > 0.
 * @param {number} x - Argument in [0, 1].
 * @returns {number} betacf(a, b, x).
 * @private
 */
function betaCf(a, b, x) {
  const MAX_IT = 200
  const EPS = 3e-14
  const FPMIN = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= MAX_IT; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}

/**
 * Regularized incomplete beta function I_x(a, b).
 *
 * @param {number} a - Shape a > 0.
 * @param {number} b - Shape b > 0.
 * @param {number} x - Argument in [0, 1].
 * @returns {number} I_x(a, b).
 * @private
 */
function incompleteBeta(a, b, x) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const lnBetaAb =
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  const front = Math.exp(lnBetaAb)
  // Symmetry switch for convergence: use I_x(a,b) directly when
  // x < (a+1)/(a+b+2); otherwise 1 − I_{1−x}(b,a).
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaCf(a, b, x)) / a
  }
  return 1 - (front * betaCf(b, a, 1 - x)) / b
}

/**
 * CDF of the Student t distribution with df degrees of freedom.
 *
 * @param {number} t - Statistic value.
 * @param {number} df - Degrees of freedom (> 0).
 * @returns {number} P(T ≤ t).
 * @private
 */
function studentTCdf(t, df) {
  const x = df / (df + t * t)
  const p = 0.5 * incompleteBeta(df / 2, 0.5, x)
  return t > 0 ? 1 - p : p
}

/**
 * Two-sided t quantile: t such that P(|T| > t) = alpha, i.e.
 * P(T ≤ t) = 1 − alpha/2. Bisection over [0, 1000] (the t CDF is
 * monotone in t; 60 iterations exceed double precision).
 *
 * @param {number} alpha - Two-sided tail mass, in (0, 1).
 * @param {number} df - Degrees of freedom (> 0).
 * @returns {number} Positive critical value t_{1−alpha/2, df}.
 * @private
 */
function studentTQuantile(alpha, df) {
  let lo = 0
  let hi = 1000
  const target = 1 - alpha / 2
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (studentTCdf(mid, df) < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * Two-sided t-based confidence interval for the mean.
 *
 * @param {number[]} data - Sample (≥ 2 finite numbers).
 * @param {number} [confidenceLevel=0.95] - In (0, 1), exclusive.
 * @returns {{mean: number, lower: number, upper: number, df: number,
 *   tCritical: number, sd: number, se: number, n: number}} lower/upper are
 *   mean ± t_{1−α/2, df} · sd/√n; sd is the sample standard deviation;
 *   se the standard error.
 * @throws {Error} On invalid data or a confidence level outside (0, 1).
 */
export function confidenceInterval(data, confidenceLevel = 0.95) {
  if (typeof confidenceLevel !== 'number' || !Number.isFinite(confidenceLevel) || confidenceLevel <= 0 || confidenceLevel >= 1) {
    throw new Error(`confidence level must be strictly between 0 and 1 (got ${confidenceLevel})`)
  }
  requireData(data, 'data')
  if (data.length < 2) {
    throw new Error('confidence interval requires at least 2 data points')
  }

  const n = data.length
  const df = n - 1
  const mu = mean(data)
  let ss = 0
  for (const v of data) ss += (v - mu) * (v - mu)
  const sd = Math.sqrt(ss / df)
  const se = sd / Math.sqrt(n)
  const tCritical = studentTQuantile(1 - confidenceLevel, df)
  const half = tCritical * se

  return {
    mean: mu,
    lower: mu - half,
    upper: mu + half,
    df,
    tCritical,
    sd,
    se,
    n,
  }
}
