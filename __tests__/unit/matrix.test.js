/**
 * Unit tests — src/engine/matrix.js
 *
 * Contract: matrices are plain nested arrays (JSON-native — agents
 * produce/consume them without a mathjs format step). Dimension errors
 * are precise (shape spelled out). Security: entries must be finite
 * numbers (anything else is a caller error, not an eval surface).
 *
 * @module matrix.test
 */
import { describe, it, expect } from 'vitest'
import { matrixAdd, matrixMultiply, matrixTranspose } from '../../src/engine/matrix.js'

describe('matrixAdd', () => {
  it('adds two matrices element-wise', () => {
    expect(matrixAdd([[1, 2], [3, 4]], [[5, 6], [7, 8]])).toEqual([[6, 8], [10, 12]])
  })

  it('handles non-square matrices', () => {
    expect(matrixAdd([[1, 2, 3]], [[4, 5, 6]])).toEqual([[5, 7, 9]])
  })

  it('rejects shape mismatch with precise dimensions', () => {
    expect(() => matrixAdd([[1, 2]], [[1, 2], [3, 4]])).toThrow(/1x2.*2x2/)
  })

  it('rejects ragged rows', () => {
    expect(() => matrixAdd([[1, 2], [3]], [[1, 2], [3, 4]])).toThrow(/ragged|same length/i)
  })

  it('rejects empty matrices', () => {
    expect(() => matrixAdd([], [])).toThrow(/empty/i)
  })

  it('rejects non-finite entries', () => {
    expect(() => matrixAdd([[1, NaN]], [[1, 2]])).toThrow(/finite/)
  })
})

describe('matrixMultiply', () => {
  it('multiplies two 2x2 matrices', () => {
    expect(matrixMultiply([[1, 2], [3, 4]], [[5, 6], [7, 8]])).toEqual([[19, 22], [43, 50]])
  })

  it('multiplies non-square compatible shapes (1x3 * 3x1)', () => {
    expect(matrixMultiply([[1, 2, 3]], [[4], [5], [6]])).toEqual([[32]])
  })

  it('multiplies 3x1 * 1x3 into 3x3', () => {
    const r = matrixMultiply([[1], [2], [3]], [[4, 5, 6]])
    expect(r).toEqual([[4, 5, 6], [8, 10, 12], [12, 15, 18]])
  })

  it('satisfies identity property A·I = A', () => {
    const a = [[3, 1], [2, 5]]
    const id = [[1, 0], [0, 1]]
    expect(matrixMultiply(a, id)).toEqual(a)
  })

  it('satisfies distributive shape for known values', () => {
    // (A+B)C = AC + BC spot check with a shared C
    const a = [[1, 0], [0, 1]]
    const b = [[2, 0], [0, 2]]
    const c = [[3, 4], [5, 6]]
    const left = matrixMultiply(matrixAdd(a, b), c)
    const right = matrixAdd(matrixMultiply(a, c), matrixMultiply(b, c))
    expect(left).toEqual(right)
  })

  it('rejects incompatible inner dimensions', () => {
    expect(() => matrixMultiply([[1, 2]], [[1, 2]])).toThrow(/2.*2|inner dimension/i)
  })

  it('rejects ragged input', () => {
    expect(() => matrixMultiply([[1, 2], [3]], [[1], [2]])).toThrow(/ragged|same length/i)
  })
})

describe('matrixTranspose', () => {
  it('transposes a 2x2', () => {
    expect(matrixTranspose([[1, 2], [3, 4]])).toEqual([[1, 3], [2, 4]])
  })

  it('transposes non-square shapes (2x3 → 3x2)', () => {
    expect(matrixTranspose([[1, 2, 3], [4, 5, 6]])).toEqual([[1, 4], [2, 5], [3, 6]])
  })

  it('involution: (A^T)^T = A', () => {
    const a = [[1, 2], [3, 4], [5, 6]]
    expect(matrixTranspose(matrixTranspose(a))).toEqual(a)
  })

  it('rejects empty and ragged matrices', () => {
    expect(() => matrixTranspose([])).toThrow(/empty/i)
    expect(() => matrixTranspose([[1, 2], [3]])).toThrow(/ragged|same length/i)
  })
})
