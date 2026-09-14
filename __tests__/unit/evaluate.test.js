/**
 * Unit tests — src/engine/evaluate.js
 *
 * Two contracts under test:
 *   1. Correctness: standard math evaluation with deterministic formatting.
 *   2. Security: the sandboxed namespace must make JS-escape and
 *      file-access payloads FAIL CLOSED (throw or return inert values),
 *      never execute. These tests are the reason evaluate exists as its
 *      own module rather than raw math.evaluate in the tool layer.
 *
 * @module evaluate.test
 */
import { describe, it, expect } from 'vitest'
import { evaluateExpression, createCalculatorMath, MAX_EXPRESSION_LENGTH } from '../../src/engine/evaluate.js'

describe('basic evaluation', () => {
  it('evaluates arithmetic with correct precedence', () => {
    expect(evaluateExpression('2 + 3 * 4').numeric).toBe(14)
  })

  it('evaluates parentheses', () => {
    expect(evaluateExpression('(2 + 3) * 4').numeric).toBe(20)
  })

  it('evaluates powers (right-associative)', () => {
    expect(evaluateExpression('2^3^2').numeric).toBe(512)
  })

  it('supports math functions', () => {
    const r = evaluateExpression('sqrt(16)')
    expect(r.numeric).toBe(4)
    expect(evaluateExpression('sin(pi / 2)').numeric).toBeCloseTo(1, 12)
  })

  it('supports constants pi and e', () => {
    expect(evaluateExpression('pi').numeric).toBeCloseTo(Math.PI, 12)
    expect(evaluateExpression('e').numeric).toBeCloseTo(Math.E, 12)
  })

  it('supports user scope variables (finite numbers only)', () => {
    expect(evaluateExpression('x^2 + 1', { x: 3 }).numeric).toBe(10)
  })

  it('formats plain numbers with bounded precision', () => {
    expect(evaluateExpression('1 / 3').result).toBe('0.33333333333333')
  })

  it('reports value types for non-plain results', () => {
    expect(evaluateExpression('sqrt(-4)').valueType).toBe('complex')
    expect(evaluateExpression('sqrt(-4)').result).toContain('2i')
  })

  it('handles very large and infinite values', () => {
    expect(evaluateExpression('10^308').valueType).toBe('number')
    expect(evaluateExpression('10^400').numeric).toBeNull() // Infinity → null numeric
  })
})

describe('error handling (fail closed)', () => {
  it('throws on syntax errors with position info', () => {
    expect(() => evaluateExpression('2 +')).toThrow()
  })

  it('throws on unknown symbols', () => {
    expect(() => evaluateExpression('foo + 1')).toThrow(/foo|Undefined/)
  })

  it('rejects empty expressions', () => {
    expect(() => evaluateExpression('   ')).toThrow(/empty/i)
  })

  it('rejects non-string expressions', () => {
    expect(() => evaluateExpression(42)).toThrow(/string/i)
  })

  it('rejects over-long expressions (DoS bound)', () => {
    const long = '1+'.repeat(MAX_EXPRESSION_LENGTH)
    expect(() => evaluateExpression(long)).toThrow(/length/i)
  })

  it('rejects non-numeric scope values', () => {
    expect(() => evaluateExpression('x', { x: 'process.exit(1)' })).toThrow(/scope/i)
    expect(() => evaluateExpression('x', { x: { nested: true } })).toThrow(/scope/i)
    expect(() => evaluateExpression('x', { x: NaN })).toThrow(/scope/i)
    expect(() => evaluateExpression('x', { x: Infinity })).toThrow(/scope/i)
  })

  it('rejects function-typed scope values', () => {
    expect(() => evaluateExpression('x', { x: () => 1 })).toThrow(/scope/i)
  })
})

describe('security — JS escape vectors must fail closed', () => {
  // These payloads mirror the documented mathjs sandbox test suite plus
  // standard JS gadget probes. Successful execution would be observable
  // (a number leaks, or no throw occurs); the safe outcome is a throw.

  it('blocks import() — the file/JS-module escape', () => {
    expect(() => evaluateExpression("import('fs')")).toThrow()
  })

  it('blocks nested evaluate', () => {
    expect(() => evaluateExpression("evaluate('2+2')")).toThrow()
  })

  it('blocks constructor.constructor gadget', () => {
    // If the JS escape worked, this would evaluate to 4.
    let threw = false
    try {
      const r = evaluateExpression('constructor.constructor("return 2+2")()')
      if (r && (r.numeric === 4 || r.result === '4')) threw = false
      else threw = true
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  it('blocks process access', () => {
    expect(() => evaluateExpression('process')).toThrow()
  })

  it('blocks globalThis access', () => {
    expect(() => evaluateExpression('globalThis')).toThrow()
  })

  it('blocks eval call', () => {
    expect(() => evaluateExpression('eval("1")')).toThrow()
  })

  it('blocks createUnit abuse surface', () => {
    expect(() => evaluateExpression('createUnit("x")')).toThrow()
  })

  it('rejects assignments by policy (AST node type)', () => {
    expect(() => evaluateExpression('x = 3')).toThrow(/assignments are not permitted/)
    expect(() => evaluateExpression('f(t) = t^2')).toThrow(/assignments are not permitted/)
  })

  it('gives symbol-level errors for host globals (allowlist, not runtime)', () => {
    expect(() => evaluateExpression('eval')).toThrow(/symbol 'eval' is not a known/)
    expect(() => evaluateExpression('fetch')).toThrow(/symbol 'fetch' is not a known/)
  })

  it('sandboxed instance has no working import even after reuse', () => {
    const math = createCalculatorMath()
    // Shared sandbox contract: repeated calls cannot re-enable escapes.
    expect(() => math.evaluate('import("fs")')).toThrow()
    expect(() => math.evaluate('import("fs")')).toThrow()
  })
})
