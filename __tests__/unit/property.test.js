/**
 * Property/cross-check tests (deep-review additions).
 *
 * These assert RELATIONSHIPS the per-function suites cannot:
 *   1. Numeric/analytic consistency — Simpson must agree with the exact
 *      polynomial path (guards the extractor + Simpson jointly).
 *   2. Solve round-trip — every reported root satisfies f(root) ≈ 0.
 *   3. Documented precedence — a scope key shadowing a namespace constant
 *      (pi) is ALLOWED by design (scope wins); pinned here so a future
 *      refactor that silently flips it is caught.
 *
 * @module property.test
 */
import { describe, it, expect } from "vitest";
import { integrate, integrateNumeric } from "../../src/engine/integral.js";
import { solveEquation } from "../../src/engine/solve.js";
import { confidenceInterval } from "../../src/engine/statistics.js";
import { evaluateExpression } from "../../src/engine/evaluate.js";

describe("numeric/analytic consistency (integral)", () => {
  const cases = [
    ["3 * x + 1", -2, 3],
    ["x^2 - 4x + 7", -2, 3],
    ["2 * x^3 + x", -2, 3],
    ["x^4 - x^2 + 3", -2, 3],
    ["-5 * x^2 + 2", -2, 3],
  ];

  it("Simpson agrees with the exact polynomial path within 1e-8", () => {
    for (const [expr, a, b] of cases) {
      const exact = integrate(expr, "x", a, b);
      expect(exact.method).toBe("polynomial");
      const num = integrateNumeric(expr, "x", a, b);
      expect(Math.abs(exact.value - num.value)).toBeLessThan(1e-8);
    }
  });
});

describe("solve round-trip", () => {
  it("every numeric root satisfies the original equation", () => {
    const r = solveEquation("x^3 - 6x^2 + 11x - 6 = 0", "x");
    const roots = r.roots.map(Number).sort((a, b) => a - b);
    expect(roots).toHaveLength(3);
    for (const root of roots) {
      const f = root ** 3 - 6 * root ** 2 + 11 * root - 6;
      expect(Math.abs(f)).toBeLessThan(1e-6);
    }
    expect(roots[0]).toBeCloseTo(1, 6);
    expect(roots[1]).toBeCloseTo(2, 6);
    expect(roots[2]).toBeCloseTo(3, 6);
  });
});

describe("statistical sanity", () => {
  it("constant data yields a degenerate (exact) CI", () => {
    const ci = confidenceInterval([10, 10, 10, 10], 0.95);
    expect(ci.sd).toBe(0);
    expect(ci.lower).toBe(10);
    expect(ci.upper).toBe(10);
  });
});

describe("documented precedence (scope shadows namespace constants)", () => {
  it("a scope key wins over a namespace constant — BY DESIGN", () => {
    // mathjs scope semantics: user scope entries override namespace
    // members. User-owned scope keys are strictly validated (finite
    // numbers) before parsing, so shadowing pi with a number is safe.
    // PINNED so a silent semantics flip is caught.
    const r = evaluateExpression("pi", { pi: 999 });
    expect(r.numeric).toBe(999);
  });
});
