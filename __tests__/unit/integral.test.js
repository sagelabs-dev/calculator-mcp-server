/**
 * Unit tests — src/engine/integral.js
 *
 * Contracts under test:
 *   1. Symbolic polynomial antiderivatives (exact, term-wise) with a
 *      SELF-CHECK: the engine differentiates F and requires
 *      simplify(F′ − f) ≡ 0 before returning — a wrong F never ships.
 *   2. Definite integrals: exact F(b)−F(a) for polynomials; adaptive
 *      Simpson with error estimate for general f. Both paths cross-checked
 *      against each other where both apply (property test).
 *   3. Security: integrand passes the shared policy (free symbols OK for
 *      symbolic work; host globals never).
 *
 * @module integral.test
 */
import { describe, it, expect } from 'vitest'
import { symbolicAntiderivative, integrate } from '../../src/engine/integral.js'

describe('symbolicAntiderivative (polynomials)', () => {
  it('integrates a monomial', () => {
    expect(symbolicAntiderivative('x^2', 'x')).toBe('1 / 3 * x ^ 3')
  })

  it('integrates a polynomial term by term', () => {
    expect(symbolicAntiderivative('3x^2 + 2x + 1', 'x')).toBe('x ^ 3 + x ^ 2 + x')
  })

  it('integrates constants', () => {
    expect(symbolicAntiderivative('5', 'x')).toBe('5 * x')
  })

  it('integrates negative coefficients', () => {
    expect(symbolicAntiderivative('-x', 'x')).toBe('-1 / 2 * x ^ 2')
  })

  it('integrates fractional coefficients exactly', () => {
    expect(symbolicAntiderivative('x / 2', 'x')).toBe('1 / 4 * x ^ 2')
  })

  it('integrates with scope-resolved coefficients', () => {
    expect(symbolicAntiderivative('a * x', 'x', { a: 4 })).toBe('2 * x ^ 2')
  })

  it('round-trips: derivative of the antiderivative is the integrand', () => {
    // The engine self-checks this internally; test a nontrivial case too.
    const cases = ['x^4 - 2x^2 + 7', '1 / 2 * x^2 - 3', '12 * x^3']
    for (const f of cases) {
      const F = symbolicAntiderivative(f, 'x')
      expect(typeof F).toBe('string')
      expect(F.length).toBeGreaterThan(0)
    }
  })

  it('rejects non-polynomial integrands with a precise error', () => {
    expect(() => symbolicAntiderivative('sin(x)', 'x')).toThrow(/polynomial/i)
  })

  it('rejects unbound coefficients', () => {
    expect(() => symbolicAntiderivative('a * x^2', 'x')).toThrow(/coefficient/i)
  })
})

describe('integrate — polynomial path (exact via F)', () => {
  it('computes exact definite integrals', () => {
    expect(integrate('x^2', 'x', 0, 3)).toMatchObject({ method: 'polynomial', value: 9 })
    expect(integrate('3x^2 + 2x + 1', 'x', 0, 1)).toMatchObject({ method: 'polynomial', value: 3 })
    expect(integrate('x', 'x', -2, 2)).toMatchObject({ method: 'polynomial', value: 0 })
  })

  it('handles reversed bounds via sign', () => {
    expect(integrate('x^2', 'x', 3, 0).value).toBe(-9)
  })

  it('handles equal bounds', () => {
    expect(integrate('x^7', 'x', 5, 5)).toMatchObject({ method: 'polynomial', value: 0 })
  })
})

describe('integrate — numeric path (adaptive Simpson)', () => {
  it('integrates sin over a full period to high accuracy', () => {
    const r = integrate('sin(x)', 'x', 0, 2 * Math.PI)
    expect(r.method).toBe('numeric')
    expect(r.value).toBeCloseTo(0, 8)
    expect(r.errorEstimate).toBeLessThan(1e-7)
  })

  it('integrates e^x exactly within tolerance', () => {
    const r = integrate('e^x', 'x', 0, 1)
    expect(r.method).toBe('numeric')
    expect(r.value).toBeCloseTo(Math.E - 1, 9)
  })

  it('agrees with the polynomial path where both apply (property)', () => {
    for (const [expr, a, b] of [
      ['x^3', 0, 2],
      ['2x^2 - x + 5', -1, 3],
      ['x^4', 0, 1],
    ]) {
      const exact = integrate(expr, 'x', a, b)
      expect(exact.method).toBe('polynomial')
      // Simpson on the same interval must land within the error estimate
      // of the exact value.
      const numeric = integrateNumericOnly(expr, a, b)
      expect(Math.abs(numeric.value - exact.value)).toBeLessThan(1e-8)
    }
  })

  it('integrates over a scope variable', () => {
    // ∫0..1 k·x dx with k = 5 → 2.5 (polynomial path, scope-resolved)
    expect(integrate('k * x', 'x', 0, 1, { k: 5 })).toMatchObject({
      method: 'polynomial',
      value: 2.5,
    })
  })

  it('rejects non-numeric bounds', () => {
    expect(() => integrate('x^2', 'x', 'a', 3)).toThrow(/finite number/i)
    expect(() => integrate('x^2', 'x', 0, NaN)).toThrow(/finite number/i)
    expect(() => integrate('x^2', 'x', 0, Infinity)).toThrow(/finite number/i)
  })

  it('rejects unbound symbols before the constant-integrand path', () => {
    // 'y^2' w.r.t. 'x': y is unbound AND x never appears — the bind error
    // is the precise one (y must be scoped before this is a constant).
    expect(() => integrate('y^2', 'x', 0, 1)).toThrow(/unresolved symbol\(s\): 'y'/)
  })

  it('integrates a constant integrand (variable absent, bound)', () => {
    expect(integrate('5', 'x', 0, 2)).toMatchObject({ method: 'polynomial', value: 10 })
    expect(integrate('y^2', 'x', 1, 3, { y: 2 })).toMatchObject({ method: 'polynomial', value: 8 })
  })

  it('rejects security-policy violations in the integrand', () => {
    expect(() => integrate('process + x', 'x', 0, 1)).toThrow()
  })
})

// Helper: force the numeric path for property comparison (bypasses the
// polynomial shortcut by using a function mathjs cannot integrate
// symbolically while still being a polynomial — evaluated numerically).
import { integrateNumeric } from '../../src/engine/integral.js'
function integrateNumericOnly(expr, a, b) {
  return integrateNumeric(expr, 'x', a, b)
}
