/**
 * Unit tests — src/engine/solve.js
 *
 * Contract under test:
 *   - Linear and quadratic equations solved SYMBOLICALLY (exact strings,
 *     discriminant handling incl. complex roots).
 *   - Everything else (higher-degree polynomials, transcendental) solved
 *     NUMERICALLY over a deterministic scan window with bisection polish.
 *   - Equation input is 'lhs = rhs' (or bare expression meaning '= 0').
 *     All coefficients must be numeric or scope-resolved for the symbolic
 *     path; numeric path always evaluates audited ASTs.
 *
 * @module solve.test
 */
import { describe, it, expect } from "vitest";
import { solveEquation } from "../../src/engine/solve.js";

describe("symbolic — linear", () => {
  it("solves a simple linear equation", () => {
    expect(solveEquation("2x + 4 = 0", "x")).toEqual({
      variable: "x",
      kind: "symbolic",
      roots: ["-2"],
      equation: "2x + 4 = 0",
    });
  });

  it("solves a non-monic linear equation", () => {
    expect(solveEquation("3x - 6 = 0", "x").roots).toEqual(["2"]);
  });

  it("solves fractional-coefficient linears exactly", () => {
    expect(solveEquation("x / 2 + 1 = 0", "x").roots).toEqual(["-2"]);
  });

  it("solves with scope-resolved coefficients", () => {
    expect(solveEquation("a * x + 2 = 0", "x", { a: 4 }).roots).toEqual([
      "-1 / 2",
    ]);
  });

  it("reports the identity as infinite solutions", () => {
    const r = solveEquation("2x = 2x", "x");
    expect(r.kind).toBe("symbolic");
    expect(r.roots).toEqual(["all values"]);
  });

  it("reports contradictions as no solution", () => {
    const r = solveEquation("x + 1 = x + 2", "x");
    expect(r.roots).toEqual([]);
  });
});

describe("symbolic — quadratic", () => {
  it("solves two distinct real roots", () => {
    const r = solveEquation("x^2 - 5x + 6 = 0", "x");
    expect(r.kind).toBe("symbolic");
    expect(r.roots).toEqual(["2", "3"]);
  });

  it("solves a double root once", () => {
    expect(solveEquation("x^2 - 2x + 1 = 0", "x").roots).toEqual(["1"]);
  });

  it("solves complex conjugate pairs", () => {
    expect(solveEquation("x^2 + 1 = 0", "x").roots).toEqual(["i", "-i"]);
  });

  it("solves irrational roots numerically-exact strings", () => {
    const r = solveEquation("x^2 - 2 = 0", "x");
    expect(r.roots).toHaveLength(2);
    expect(Number(r.roots[0])).toBeCloseTo(-Math.SQRT2, 12);
    expect(Number(r.roots[1])).toBeCloseTo(Math.SQRT2, 12);
  });
});

describe("numeric path", () => {
  it("solves cubics numerically", () => {
    const r = solveEquation("x^3 - 6x^2 + 11x - 6 = 0", "x");
    expect(r.kind).toBe("numeric");
    expect(r.roots.map((v) => Number(Number(v).toFixed(6)))).toEqual([1, 2, 3]);
  });

  it("solves bare expressions as = 0", () => {
    const r = solveEquation("x^2 - 4", "x");
    expect(r.kind).toBe("symbolic");
    expect(r.roots).toEqual(["-2", "2"]);
  });

  it("solves transcendental equations numerically", () => {
    const r = solveEquation("sin(x) - 0.5 = 0", "x");
    expect(r.kind).toBe("numeric");
    // Roots x = pi/6 + 2k*pi and 5pi/6 + 2k*pi in [-100, 100]
    // Count true roots of sin(x) = 1/2 in [-100, 100]: for each base,
    // k ranges over ceil((-100-base)/2pi) .. floor((100-base)/2pi).
    // (pi/6 - 16*2pi = -100.007 falls outside the window.)
    let count = 0;
    for (const base of [Math.PI / 6, (5 * Math.PI) / 6]) {
      const kMin = Math.ceil((-100 - base) / (2 * Math.PI));
      const kMax = Math.floor((100 - base) / (2 * Math.PI));
      count += kMax - kMin + 1;
    }
    expect(r.roots).toHaveLength(count);
    // Spot-check: every reported root satisfies f(root) ≈ 0
    for (const root of r.roots) {
      expect(Math.abs(Math.sin(root) - 0.5)).toBeLessThan(1e-9);
    }
  });

  it("returns no roots for never-zero functions", () => {
    const r = solveEquation("e^x = 0", "x");
    expect(r.kind).toBe("numeric");
    expect(r.roots).toEqual([]);
  });

  it("finds even-multiplicity roots at scan points", () => {
    // x^4 - 2x^2 + 1 = (x-1)^2 (x+1)^2 — touches zero without sign change
    const r = solveEquation("(x - 1)^2 * (x + 1)^2 = 0", "x");
    expect(r.roots.map((v) => Number(Number(v).toFixed(6))).sort()).toEqual([
      -1, 1,
    ]);
  });

  it("uses scope variables in the numeric path", () => {
    const r = solveEquation("x^2 - k = 0", "x", { k: 9 });
    expect(
      r.roots.map((v) => Number(Number(v).toFixed(9))).sort((a, b) => a - b),
    ).toEqual([-3, 3]);
  });
});

describe("input validation", () => {
  it("requires the variable to appear in the equation", () => {
    expect(() => solveEquation("y + 1 = 0", "x")).toThrow(
      /'x' does not appear/,
    );
  });

  it("requires numeric/scope coefficients for the symbolic path", () => {
    expect(() => solveEquation("a * x + 2 = 0", "x")).toThrow(/coefficient/i);
  });

  it("rejects comparison operators", () => {
    expect(() => solveEquation("x == 3", "x")).toThrow();
    expect(() => solveEquation("x < 3", "x")).toThrow();
  });

  it("rejects multiple equals signs", () => {
    expect(() => solveEquation("x = 3 = 3", "x")).toThrow(/one '='/);
  });

  it("rejects security-policy violations on either side", () => {
    expect(() => solveEquation("x = process.exit(1)", "x")).toThrow();
    expect(() => solveEquation('import("fs") = 0', "x")).toThrow();
  });

  it("rejects assignments disguised as equations", () => {
    // 'y = x^2' splits on '=' into y and x^2 — but y as the solved
    // variable must still appear in the expression; solving for x of
    // 'y = x^2' is a valid two-variable equation form → x = ±√y requires
    // numeric y, so this must throw a coefficient error, not hang.
    expect(() => solveEquation("y = x^2", "x")).toThrow(/coefficient/i);
  });
});
