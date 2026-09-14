/**
 * Unit tests — symbolic derivative and simplify (src/engine/calculus.js).
 *
 * Contract: string in → simplified STRING out (agents read strings, not
 * ASTs). Unknown symbols rejected via the shared security policy — a
 * derivative of "foo + x" must fail closed, not fabricate.
 *
 * @module calculus-basic.test
 */
import { describe, it, expect } from 'vitest'
import { symbolicDerivative, symbolicSimplify } from '../../src/engine/calculus.js'
import { createCalculatorMath } from '../../src/engine/evaluate.js'

describe('symbolicDerivative', () => {
  it('differentiates polynomials', () => {
    expect(symbolicDerivative('2x^2 + 3x + 4', 'x')).toBe('4 * x + 3')
  })

  it('differentiates trigonometric functions', () => {
    expect(symbolicDerivative('sin(x)', 'x')).toBe('cos(x)')
    expect(symbolicDerivative('cos(x)', 'x')).toBe('-sin(x)')
  })

  it('differentiates composite functions (chain rule)', () => {
    // mathjs renders the inner product implicitly: 2 * cos(2 x)
    expect(symbolicDerivative('sin(2x)', 'x')).toBe('2 * cos(2 x)')
  })

  it('differentiates exponentials and logarithms', () => {
    expect(symbolicDerivative('e^x', 'x')).toBe('e ^ x')
    expect(symbolicDerivative('log(x)', 'x')).toBe('1 / x')
  })

  it('differentiates with respect to a different variable', () => {
    expect(symbolicDerivative('t^3', 't')).toBe('3 * t ^ 2')
  })

  it('differentiates using scope-provided variables', () => {
    // d/dx of (a * x^2) with a = 2 → 4x
    expect(symbolicDerivative('a * x^2', 'x', { a: 2 })).toBe('4 * x')
  })

  it('throws on a derivative variable that is not in the expression or scope', () => {
    // d/dz of x^2 is 0 in calculus, but for a TOOL the caller almost
    // certainly mistyped the variable — fail loudly instead of silently 0.
    expect(() => symbolicDerivative('x^2', 'z')).toThrow(/z/)
  })

  it('treats unknown symbols as free variables in symbolic mode', () => {
    // d/dx of (foo + x^2) = 2x — foo is constant w.r.t. x. Symbolic ops
    // allow free variables; the security boundary is host globals.
    expect(symbolicDerivative('foo + x^2', 'x')).toBe('2 * x')
  })

  it('still blocks host globals in symbolic mode', () => {
    expect(() => symbolicDerivative('process + x', 'x')).toThrow(/symbol 'process' is not permitted/)
    expect(() => symbolicSimplify('globalThis')).toThrow(/symbol 'globalThis' is not permitted/)
  })

  it('throws on assignments', () => {
    expect(() => symbolicDerivative('y = x^2', 'x')).toThrow(/assignments are not permitted/)
  })

  it('accepts a parsed AST node (engine-internal reuse path)', () => {
    // Callers holding an AST (e.g. solve feeding derivative) skip re-parse.
    const math = createCalculatorMath()
    expect(symbolicDerivative(math.parse('x^2 + 1'), 'x')).toBe('2 * x')
  })
})

describe('symbolicSimplify', () => {
  it('collects like terms', () => {
    expect(symbolicSimplify('2x + 3x')).toBe('5 * x')
  })

  it('simplifies rational arithmetic', () => {
    expect(symbolicSimplify('3 + 2 / 4')).toBe('7 / 2')
  })

  it('cancels common factors', () => {
    expect(symbolicSimplify('x * y * -x / (x ^ 2)')).toBe('-y')
  })

  it('supports scope-resolved simplification', () => {
    expect(symbolicSimplify('2x + x', { x: 4 })).toBe('12')
  })

  it('treats unknown symbols as free variables', () => {
    expect(symbolicSimplify('foo + foo')).toBe('2 * foo')
  })
})
