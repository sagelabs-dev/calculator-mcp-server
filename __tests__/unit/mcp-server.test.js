/**
 * Unit tests — src/mcp-server.js getTools()
 *
 * Contracts under test:
 *   - Tool registry: exactly 12 tools, unique names, every tool has
 *     description + inputSchema + execute.
 *   - Execution: each tool returns the success envelope with correct
 *     values (end-to-end through the MCP-shaped layer, engine up).
 *   - Error mapping: engine throws → isError result with the engine's
 *     message (never a raw stack, never a crash).
 *   - D7: descriptions embed worked examples (non-trivial length).
 *
 * @module mcp-server.test
 */
import { describe, it, expect } from "vitest";
import { getTools } from "../../src/mcp-server.js";

const EXPECTED_TOOLS = [
  "calculate",
  "derivative",
  "simplify",
  "solve",
  "integral",
  "symbolic_integral",
  "stats_describe",
  "stats_correlation",
  "stats_regression",
  "stats_confidence_interval",
  "matrix_add",
  "matrix_multiply",
  "matrix_transpose",
];

function getTool(name) {
  const tools = getTools();
  return tools.find((t) => t.name === name);
}

describe("tool registry", () => {
  it("registers exactly the expected 13 tools", () => {
    const tools = getTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("gives every tool a description, schema, and execute", () => {
    for (const tool of getTools()) {
      expect(tool.description.length).toBeGreaterThan(80);
      expect(tool.inputSchema).toBeTypeOf("object");
      expect(tool.execute).toBeTypeOf("function");
    }
  });

  it("uses unique tool names", () => {
    const names = getTools().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("embeds worked examples in descriptions (D7)", () => {
    for (const tool of getTools()) {
      expect(tool.description).toMatch(/→|→|e\.g\.|Example/i);
    }
  });
});

describe("tool execution — calculus", () => {
  it("calculate evaluates with scope", async () => {
    const r = await getTool("calculate").execute({
      expression: "x^2 + 1",
      scope: { x: 3 },
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.success).toBe(true);
    expect(body.numeric).toBe(10);
  });

  it("derivative returns simplified string", async () => {
    const r = await getTool("derivative").execute({
      expression: "2x^2 + 3x + 4",
      variable: "x",
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.derivative).toBe("4 * x + 3");
  });

  it("simplify collects like terms", async () => {
    const r = await getTool("simplify").execute({ expression: "2x + 3x" });
    const body = JSON.parse(r.content[0].text);
    expect(body.simplified).toBe("5 * x");
  });

  it("solve returns symbolic roots", async () => {
    const r = await getTool("solve").execute({
      equation: "x^2 - 5x + 6 = 0",
      variable: "x",
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.kind).toBe("symbolic");
    expect(body.roots).toEqual(["2", "3"]);
  });

  it("integral computes exact polynomial values", async () => {
    const r = await getTool("integral").execute({
      expression: "x^2",
      variable: "x",
      a: 0,
      b: 3,
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.method).toBe("polynomial");
    expect(body.value).toBe(9);
  });

  it("symbolic_integral returns exact antiderivative", async () => {
    const r = await getTool("symbolic_integral").execute({
      expression: "x^2",
      variable: "x",
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.antiderivative).toBe("1 / 3 * x ^ 3");
  });
});

describe("tool execution — statistics", () => {
  it("stats_describe returns full summary", async () => {
    const r = await getTool("stats_describe").execute({
      data: [1, 2, 3, 4, 5],
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.mean).toBe(3);
    expect(body.n).toBe(5);
    expect(body.sdSample).toBeCloseTo(Math.sqrt(2.5), 10);
  });

  it("stats_correlation detects perfect correlation", async () => {
    const r = await getTool("stats_correlation").execute({
      xs: [1, 2, 3],
      ys: [2, 4, 6],
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.r).toBeCloseTo(1, 10);
  });

  it("stats_regression fits exactly", async () => {
    const r = await getTool("stats_regression").execute({
      xs: [1, 2, 3, 4],
      ys: [2, 4, 6, 8],
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.slope).toBeCloseTo(2, 10);
    expect(body.intercept).toBeCloseTo(0, 10);
  });

  it("stats_confidence_interval matches hand-derived CI", async () => {
    const r = await getTool("stats_confidence_interval").execute({
      data: [27.5, 27.2, 26.5, 26.7, 27.1, 26.8, 26.5],
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.mean).toBeCloseTo(26.9, 6);
    expect(body.lower).toBeCloseTo(26.5499, 3);
    expect(body.upper).toBeCloseTo(27.2501, 3);
  });
});

describe("tool execution — matrices", () => {
  it("matrix_add sums element-wise", async () => {
    const r = await getTool("matrix_add").execute({
      a: [
        [1, 2],
        [3, 4],
      ],
      b: [
        [5, 6],
        [7, 8],
      ],
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.result).toEqual([
      [6, 8],
      [10, 12],
    ]);
  });

  it("matrix_multiply multiplies", async () => {
    const r = await getTool("matrix_multiply").execute({
      a: [
        [1, 2],
        [3, 4],
      ],
      b: [
        [5, 6],
        [7, 8],
      ],
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.result).toEqual([
      [19, 22],
      [43, 50],
    ]);
  });

  it("matrix_transpose transposes", async () => {
    const r = await getTool("matrix_transpose").execute({
      m: [
        [1, 2, 3],
        [4, 5, 6],
      ],
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.result).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
  });
});

describe("error mapping (isError envelope)", () => {
  it("engine throws become isError results with messages", async () => {
    const r = await getTool("calculate").execute({ expression: "process" });
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/not permitted/);
  });

  it("solve errors map cleanly", async () => {
    const r = await getTool("solve").execute({
      equation: "x == 3",
      variable: "x",
    });
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    // 'x == 3' splits into 3 parts on '=' — caught by the one-= validation.
    expect(body.error).toMatch(/exactly one '='/);
  });

  it("matrix shape errors map cleanly", async () => {
    const r = await getTool("matrix_add").execute({
      a: [[1, 2]],
      b: [
        [1, 2],
        [3, 4],
      ],
    });
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toMatch(/1x2/);
  });

  it("statistics validation errors map cleanly", async () => {
    const r = await getTool("stats_correlation").execute({
      xs: [1, 2],
      ys: [1, 2, 3],
    });
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toMatch(/same length/);
  });
});
