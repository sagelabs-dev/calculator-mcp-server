/**
 * Unit tests — src/engine/statistics.js
 *
 * Contracts under test:
 *   - stats_describe: n/mean/median/mode/variance/sd (sample+population),
 *     min/max/quartiles, on finite numeric arrays.
 *   - stats_correlation: Pearson r; errors on length/constant variance.
 *   - stats_regression: OLS slope/intercept, r^2, RMSE, predict().
 *   - stats_confidence_interval: t-based CI via the Lentz continued
 *     fraction incomplete beta function; VERIFIED against known t
 *     quantiles (t0.975, df=10 = 2.228139) and R's t.test output.
 *
 * @module statistics.test
 */
import { describe, it, expect } from 'vitest'
import { describeData, correlation, linearRegression, confidenceInterval } from '../../src/engine/statistics.js'

describe('describeData', () => {
  it('computes summary statistics for a simple dataset', () => {
    const d = describeData([1, 2, 3, 4, 5])
    expect(d.n).toBe(5)
    expect(d.mean).toBe(3)
    expect(d.median).toBe(3)
    expect(d.min).toBe(1)
    expect(d.max).toBe(5)
    expect(d.varianceSample).toBeCloseTo(2.5, 12)
    expect(d.sdSample).toBeCloseTo(Math.sqrt(2.5), 12)
    expect(d.variancePopulation).toBe(2)
    expect(d.sdPopulation).toBeCloseTo(Math.sqrt(2), 12)
  })

  it('computes modes with ties (multimodal)', () => {
    expect(describeData([1, 2, 2, 3, 3, 4]).mode).toEqual([2, 3])
    expect(describeData([1, 1, 1, 2]).mode).toEqual([1])
    // Uniform data: every value ties → no informative mode.
    expect(describeData([1, 2, 3, 4]).mode).toEqual([])
  })

  it('computes an interpolated median for even n', () => {
    expect(describeData([1, 2, 3, 4]).median).toBe(2.5)
  })

  it('computes quartiles (linear interpolation, type 7)', () => {
    const d = describeData([6, 7, 15, 36, 39, 40, 41, 42, 43, 47, 49])
    // Hand-derived type-7 values: n=11, h(q1)=2.5 → 15 + 0.5·(36−15)
    expect(d.q1).toBeCloseTo(25.5, 6)
    expect(d.median).toBeCloseTo(40, 6)
    expect(d.q3).toBeCloseTo(42.5, 6)
  })

  it('handles single-element data', () => {
    const d = describeData([42])
    expect(d.n).toBe(1)
    expect(d.mean).toBe(42)
    expect(d.sdSample).toBe(0)
  })

  it('rejects empty, non-array, and non-finite data', () => {
    expect(() => describeData([])).toThrow(/empty/i)
    expect(() => describeData('nope')).toThrow(/array/i)
    expect(() => describeData([1, NaN, 3])).toThrow(/finite/)
    expect(() => describeData([1, Infinity, 3])).toThrow(/finite/)
    expect(() => describeData([1, '2', 3])).toThrow(/number/i)
  })

  it('enforces the data length cap', () => {
    const big = new Array(1_000_001).fill(1)
    expect(() => describeData(big)).toThrow(/length/i)
  })
})

describe('correlation (Pearson r)', () => {
  it('detects perfect positive correlation', () => {
    expect(correlation([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12)
  })

  it('detects perfect negative correlation', () => {
    expect(correlation([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 12)
  })

  it('computes a known mid-range correlation', () => {
    // Hand-derived: sxy=8, sxx=syy=10 → r = 8/10
    const r = correlation([1, 2, 3, 4, 5], [2, 1, 4, 3, 5])
    expect(r).toBeCloseTo(0.8, 6)
  })

  it('rejects length mismatches', () => {
    expect(() => correlation([1, 2], [1, 2, 3])).toThrow(/same length/)
  })

  it('rejects constant series (undefined correlation)', () => {
    expect(() => correlation([1, 1, 1], [1, 2, 3])).toThrow(/constant|variance/i)
  })

  it('requires at least two points', () => {
    expect(() => correlation([1], [2])).toThrow(/at least 2/)
  })
})

describe('linearRegression (OLS)', () => {
  it('fits a perfect line exactly', () => {
    const r = linearRegression([1, 2, 3, 4], [2, 4, 6, 8])
    expect(r.slope).toBeCloseTo(2, 12)
    expect(r.intercept).toBeCloseTo(0, 12)
    expect(r.r2).toBeCloseTo(1, 12)
    expect(r.rmse).toBeCloseTo(0, 12)
    expect(r.predict(10)).toBeCloseTo(20, 12)
  })

  it('fits a known noisy dataset', () => {
    // Hand-derived OLS: sxy=4.8, sxx=10 → slope 0.48; intercept
    // my − slope·mx = 2.02 − 0.96 = 1.06.
    const xs = [0, 1, 2, 3, 4]
    const ys = [1.1, 1.4, 2.2, 2.4, 3.0]
    const r = linearRegression(xs, ys)
    expect(r.slope).toBeCloseTo(0.48, 12)
    expect(r.intercept).toBeCloseTo(1.06, 12)
    expect(r.r2).toBeGreaterThan(0.9)
  })

  it('predicts outside the fitted range', () => {
    const r = linearRegression([0, 1, 2], [1, 3, 5]) // y = 1 + 2x
    expect(r.predict(100)).toBeCloseTo(201, 9)
  })

  it('rejects mismatched, short, or degenerate inputs', () => {
    expect(() => linearRegression([1, 2], [1])).toThrow(/same length/)
    expect(() => linearRegression([1], [1])).toThrow(/at least 2/)
    expect(() => linearRegression([2, 2, 2], [1, 2, 3])).toThrow(/constant|variance/i)
  })
})

describe('confidenceInterval (t-based)', () => {
  it('t-quantile matches known values (Lentz incomplete beta)', () => {
    // Reference: R qt(0.975, 10) = 2.228138852; scipy t.ppf same.
    const r = confidenceInterval([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 0.95)
    // n = 11, df = 10
    const df = 10
    const mean = 6
    const sd = Math.sqrt(11) // sample variance of 1..11 = 11
    const half = 2.2281388519649385 * (sd / Math.sqrt(11))
    expect(r.lower).toBeCloseTo(mean - half, 6)
    expect(r.upper).toBeCloseTo(mean + half, 6)
    expect(r.df).toBe(df)
    void df
  })

  it('matches R t.test on a classic dataset', () => {
    // Hand-derived: mean 188.3/7 = 26.9; ss = 0.86; sample var 0.86/6;
    // sd = 0.37859; se = 0.143056; t(0.975, df=6) = 2.446912
    // → half-width 0.350055 → CI [26.549945, 27.250055].
    const r = confidenceInterval([27.5, 27.2, 26.5, 26.7, 27.1, 26.8, 26.5], 0.95)
    expect(r.mean).toBeCloseTo(26.9, 6)
    expect(r.lower).toBeCloseTo(26.5499, 3)
    expect(r.upper).toBeCloseTo(27.2501, 3)
    expect(r.df).toBe(6)
    expect(r.tCritical).toBeCloseTo(2.446912, 5)
  })

  it('supports 90% and 99% levels', () => {
    const data = [2, 4, 6, 8, 10]
    const c90 = confidenceInterval(data, 0.9)
    const c99 = confidenceInterval(data, 0.99)
    expect(c99.upper - c99.lower).toBeGreaterThan(c90.upper - c90.lower)
  })

  it('rejects bad confidence levels and short data', () => {
    expect(() => confidenceInterval([1, 2, 3], 0)).toThrow(/confidence level/i)
    expect(() => confidenceInterval([1, 2, 3], 1.0)).toThrow(/confidence level/i)
    expect(() => confidenceInterval([1, 2, 3], 1.5)).toThrow(/confidence level/i)
    expect(() => confidenceInterval([1], 0.95)).toThrow(/at least 2/)
  })
})
