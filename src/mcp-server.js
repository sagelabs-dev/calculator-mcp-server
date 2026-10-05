/**
 * Calculator MCP Server — Exposes the math engines as MCP tools.
 *
 * Twelve stateless tools across four engines:
 *   - calculate / derivative / simplify / solve / integral  (calculus core)
 *   - stats_describe / stats_correlation / stats_regression /
 *     stats_confidence_interval                              (statistics)
 *   - matrix_add / matrix_multiply / matrix_transpose         (matrices)
 *
 * Stateless by design: the caller (agent) is the brain; the server is
 * pure math. Tool descriptions embed worked examples (design decision
 * D7) so an LLM caller learns each tool from the tool itself.
 *
 * Security: every expression-bearing parameter flows through the shared
 * sandbox (parseAndAudit) inside the engine modules — the MCP layer adds
 * zod shape validation; the engines own the security policy.
 *
 * @module mcp-server
 */

import { createRequire } from "node:module";
import { createSimpleServer } from "@sagelabs/mcp-ai/simple-server/index.js";
import { z } from "zod";
import {
  evaluateExpression,
  MAX_EXPRESSION_LENGTH,
} from "./engine/evaluate.js";
import { symbolicDerivative, symbolicSimplify } from "./engine/calculus.js";
import { solveEquation } from "./engine/solve.js";
import { symbolicAntiderivative, integrate } from "./engine/integral.js";
import {
  describeData,
  correlation,
  linearRegression,
  confidenceInterval,
} from "./engine/statistics.js";
import { matrixAdd, matrixMultiply, matrixTranspose } from "./engine/matrix.js";

// ──────────────────────────────────────────────────────────────────────────
// Error Handling Wrapper (matrix-mcp-server pattern, dice-proven)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Run an async tool body with standardized error handling: engine throws
 * become isError MCP results carrying the engine's human-readable message.
 * (Zod-schema violations never reach here — the SDK rejects them earlier.)
 *
 * @param {Function} fn - Async function returning an MCP result object.
 * @returns {Promise<object>} The tool result, or an isError result on throw.
 */
async function withErrorHandling(fn) {
  try {
    return await fn();
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: false, error: error.message }),
        },
      ],
      isError: true,
    };
  }
}

/**
 * Create a success MCP result.
 *
 * @param {object} data - Data to include in the result.
 * @returns {object} MCP CallToolResult.
 */
function success(data) {
  return {
    content: [
      { type: "text", text: JSON.stringify({ success: true, ...data }) },
    ],
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Shared Zod Schemas (raw shapes — NOT z.object, per mcp-ai contract)
// ──────────────────────────────────────────────────────────────────────────

const schemas = {
  expression: z
    .string()
    .min(1)
    .max(MAX_EXPRESSION_LENGTH)
    .describe(
      'Math expression, e.g. "2 + 3 * sqrt(16)", "sin(pi/2)", "x^2 + 1"',
    ),
  variable: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
    .describe('Variable name, e.g. "x"'),
  scope: z
    .record(z.number().finite())
    .optional()
    .describe('Optional variable values, e.g. {"a": 2, "k": 5}'),
  data: z
    .array(z.number().finite())
    .min(1)
    .max(1_000_000)
    .describe("Numeric dataset, e.g. [1, 2, 3, 4, 5]"),
  xs: z
    .array(z.number().finite())
    .min(1)
    .max(1_000_000)
    .describe("x values, e.g. [1, 2, 3]"),
  ys: z
    .array(z.number().finite())
    .min(1)
    .max(1_000_000)
    .describe("y values (same length as xs), e.g. [2, 4, 6]"),
  matrix: z
    .array(z.array(z.number().finite()).min(1).max(400))
    .min(1)
    .max(400)
    .describe("Matrix as nested arrays, e.g. [[1, 2], [3, 4]]"),
};

/**
 * Build the array of MCP tool definitions.
 *
 * Exported separately as `getTools` for unit testing — allows testing tool
 * execution without starting a server.
 *
 * @returns {Array} Tool definition objects.
 */
export function getTools() {
  return [
    // ── Numeric evaluation ─────────────────────────────────────────
    {
      name: "calculate",
      description:
        "Evaluate a mathematical expression safely: arithmetic, powers (2^3^2=512 right-assoc), " +
        "functions (sqrt, sin, cos, tan, log, ln, exp, abs, round, floor, ceil, min, max, factorial), " +
        'constants (pi, e), and variables via scope. Examples: "2 + 3 * 4" → 14; "sqrt(16)" → 4; ' +
        'expression "x^2 + 1" with scope {"x": 3} → 10. Returns result (formatted string), numeric ' +
        "(plain number when finite real), and valueType (number|complex|unit|matrix|boolean|other). " +
        "Complex results (sqrt(-4) → 2i) come back as valueType complex. Sandboxed: no code execution.",
      inputSchema: {
        expression: schemas.expression,
        scope: schemas.scope,
      },
      execute: async ({ expression, scope }) =>
        withErrorHandling(async () => {
          const result = evaluateExpression(expression, scope);
          return success(result);
        }),
    },

    {
      name: "derivative",
      description:
        "Symbolic derivative d/dv of an expression (v must appear in the expression or scope). " +
        "Handles polynomials, trig, exponentials, logs, chain/product/quotient rules. " +
        'Examples: derivative("2x^2 + 3x + 4", "x") → "4 * x + 3"; derivative("sin(2x)", "x") → ' +
        '"2 * cos(2 x)"; derivative("a * x^2", "x", scope {"a": 2}) → "4 * x". Returns the ' +
        "simplified derivative as a string.",
      inputSchema: {
        expression: schemas.expression,
        variable: schemas.variable,
        scope: schemas.scope,
      },
      execute: async ({ expression, variable, scope }) =>
        withErrorHandling(async () => {
          const result = symbolicDerivative(expression, variable, scope);
          return success({ derivative: result, variable });
        }),
    },

    {
      name: "simplify",
      description:
        "Symbolically simplify an expression: collect like terms, cancel factors, reduce " +
        'rationals. Examples: simplify("2x + 3x") → "5 * x"; simplify("3 + 2 / 4") → "7 / 2"; ' +
        'simplify("x * y * -x / (x ^ 2)") → "-y". With scope, substitutes values: ' +
        'simplify("2x + x", scope {"x": 4}) → "12". Returns the simplified expression string.',
      inputSchema: {
        expression: schemas.expression,
        scope: schemas.scope,
      },
      execute: async ({ expression, scope }) =>
        withErrorHandling(async () => {
          const result = symbolicSimplify(expression, scope);
          return success({ simplified: result });
        }),
    },

    {
      name: "solve",
      description:
        'Solve an equation for a variable. Input: "lhs = rhs" (exactly one =), or a bare ' +
        'expression meaning "= 0". Linear and quadratic equations are solved SYMBOLICALLY with ' +
        'exact roots (rationals as fractions "3 / 2", complex pairs "1 + 2i"); anything else ' +
        "(cubics, transcendental) is solved NUMERICALLY by deterministic scan of [-100, 100] " +
        'with bisection polish. Examples: solve("2x + 4 = 0", "x") → ["-2"]; ' +
        'solve("x^2 - 5x + 6 = 0", "x") → ["2", "3"]; solve("x^2 + 1 = 0", "x") → ["i", "-i"]; ' +
        'solve("sin(x) - 0.5 = 0", "x") → all roots in [-100, 100]; solve("x^2 = k", "x", ' +
        'scope {"k": 9}) → ["-3", "3"]. Identity ("2x = 2x") → ["all values"]; contradiction ' +
        "→ []. Coefficients must be numbers or scope-resolvable. kind field reports which path ran.",
      inputSchema: {
        equation: z
          .string()
          .min(1)
          .max(MAX_EXPRESSION_LENGTH * 2)
          .describe(
            'Equation with exactly one = (or bare expression for = 0), e.g. "x^2 - 5x + 6 = 0"',
          ),
        variable: schemas.variable,
        scope: schemas.scope,
      },
      execute: async ({ equation, variable, scope }) =>
        withErrorHandling(async () => {
          const result = solveEquation(equation, variable, scope);
          return success(result);
        }),
    },

    {
      name: "integral",
      description:
        "Definite integral of f from a to b. Polynomial integrands (degree ≤ 4, self-checked: " +
        "dF/dx ≡ f verified before returning) give EXACT values via the antiderivative; " +
        "everything else uses adaptive Simpson with an error estimate. Examples: " +
        'integral("x^2", "x", 0, 3) → 9 (exact); integral("sin(x)", "x", 0, 2*pi) → ~0 ' +
        '(numeric, errorEstimate ~1e-17); integral("e^x", "x", 0, 1) → 1.718281828…; ' +
        'integral("k * x", "x", 0, 1, scope {"k": 5}) → 2.5 (exact). method field reports ' +
        '"polynomial" (exact) or "numeric". Bounds must be finite numbers; equal bounds → 0.',
      inputSchema: {
        expression: schemas.expression,
        variable: schemas.variable,
        a: z.number().finite().describe("Lower bound, e.g. 0"),
        b: z.number().finite().describe("Upper bound, e.g. 3"),
        scope: schemas.scope,
      },
      execute: async ({ expression, variable, a, b, scope }) =>
        withErrorHandling(async () => {
          const result = integrate(expression, variable, a, b, scope);
          return success({ ...result, variable });
        }),
    },

    {
      name: "symbolic_integral",
      description:
        "Symbolic antiderivative (indefinite integral, C = 0) of a POLYNOMIAL in the variable " +
        "(degree ≤ 4). Exact term-wise result, self-checked by verifying dF/dx ≡ f. " +
        'Examples: symbolic_integral("x^2", "x") → "1 / 3 * x ^ 3"; ' +
        'symbolic_integral("3x^2 + 2x + 1", "x") → "x ^ 3 + x ^ 2 + x"; ' +
        'symbolic_integral("a * x", "x", scope {"a": 4}) → "2 * x ^ 2". Non-polynomial ' +
        "integrand (sin(x), e^x...) → error suggesting integral() for numeric definite integrals.",
      inputSchema: {
        expression: schemas.expression,
        variable: schemas.variable,
        scope: schemas.scope,
      },
      execute: async ({ expression, variable, scope }) =>
        withErrorHandling(async () => {
          const result = symbolicAntiderivative(expression, variable, scope);
          return success({ antiderivative: result, variable });
        }),
    },

    // ── Statistics ─────────────────────────────────────────────────
    {
      name: "stats_describe",
      description:
        "Descriptive statistics for a dataset: n, mean, median, mode (all tied modes, [] when " +
        "no value repeats), variance and standard deviation (BOTH sample n-1 and population n), " +
        "min, max, quartiles q1/q3 (linear interpolation, R type 7), iqr. Example: " +
        "stats_describe([1, 2, 3, 4, 5]) → mean 3, median 3, sdSample √2.5, mode []. " +
        "Use sample fields for inferential work, population fields for complete datasets.",
      inputSchema: {
        data: schemas.data,
      },
      execute: async ({ data }) =>
        withErrorHandling(async () => {
          const result = describeData(data);
          return success(result);
        }),
    },

    {
      name: "stats_correlation",
      description:
        "Pearson correlation coefficient r between two paired series (same length, ≥ 2 points). " +
        "r ∈ [-1, 1]: +1 perfect positive, -1 perfect negative linear relationship. " +
        "Example: stats_correlation([1, 2, 3], [2, 4, 6]) → 1. Errors on mismatched lengths or " +
        "constant series (correlation undefined when a series has zero variance).",
      inputSchema: {
        xs: schemas.xs,
        ys: schemas.ys,
      },
      execute: async ({ xs, ys }) =>
        withErrorHandling(async () => {
          const r = correlation(xs, ys);
          return success({ r, n: xs.length });
        }),
    },

    {
      name: "stats_regression",
      description:
        "Ordinary least squares linear regression y = slope·x + intercept. Returns slope, " +
        "intercept, r2 (coefficient of determination), rmse (root mean squared error), n, and " +
        "a worked example. Example: stats_regression([1, 2, 3, 4], [2, 4, 6, 8]) → slope 2, " +
        "intercept 0, r2 1. Errors on mismatched lengths, < 2 points, or constant x.",
      inputSchema: {
        xs: schemas.xs,
        ys: schemas.ys,
      },
      execute: async ({ xs, ys }) =>
        withErrorHandling(async () => {
          const result = linearRegression(xs, ys);
          return success({
            slope: result.slope,
            intercept: result.intercept,
            r2: result.r2,
            rmse: result.rmse,
            n: result.n,
          });
        }),
    },

    {
      name: "stats_confidence_interval",
      description:
        "Two-sided t-based confidence interval for the mean. Returns mean, lower, upper bounds, " +
        "df (degrees of freedom), tCritical (t quantile via continued-fraction incomplete beta, " +
        "verified against R), sd, se, n. Example: stats_confidence_interval([27.5, 27.2, 26.5, " +
        "26.7, 27.1, 26.8, 26.5], 0.95) → mean 26.9, CI [26.550, 27.250], df 6. Default level " +
        "0.95; accepts any level strictly between 0 and 1.",
      inputSchema: {
        data: schemas.data
          .min(2)
          .describe("Sample data, at least 2 values, e.g. [27.5, 27.2, 26.5]"),
        confidenceLevel: z
          .number()
          .finite()
          .gt(0)
          .lt(1)
          .optional()
          .describe("Confidence level in (0, 1), default 0.95"),
      },
      execute: async ({ data, confidenceLevel }) =>
        withErrorHandling(async () => {
          const result = confidenceInterval(data, confidenceLevel);
          return success(result);
        }),
    },

    // ── Matrices ───────────────────────────────────────────────────
    {
      name: "matrix_add",
      description:
        "Element-wise matrix addition. Both matrices must have IDENTICAL shapes (rows×cols), " +
        "max 400×400, finite numeric entries. Matrices are nested arrays: [[1, 2], [3, 4]]. " +
        "Example: matrix_add([[1, 2], [3, 4]], [[5, 6], [7, 8]]) → [[6, 8], [10, 12]].",
      inputSchema: {
        a: schemas.matrix,
        b: schemas.matrix,
      },
      execute: async ({ a, b }) =>
        withErrorHandling(async () => {
          const result = matrixAdd(a, b);
          return success({ result });
        }),
    },

    {
      name: "matrix_multiply",
      description:
        "Matrix multiplication A·B. Requires a's columns === b's rows (m×k times k×n → m×n), " +
        "max 400 per dimension, finite numeric entries. Matrices are nested arrays. " +
        "Example: matrix_multiply([[1, 2], [3, 4]], [[5, 6], [7, 8]]) → [[19, 22], [43, 50]]; " +
        "matrix_multiply([[1, 2, 3]], [[4], [5], [6]]) → [[32]].",
      inputSchema: {
        a: schemas.matrix,
        b: schemas.matrix,
      },
      execute: async ({ a, b }) =>
        withErrorHandling(async () => {
          const result = matrixMultiply(a, b);
          return success({ result });
        }),
    },

    {
      name: "matrix_transpose",
      description:
        "Matrix transposition: rows become columns (rows×cols → cols×rows), max 400 per " +
        "dimension. Example: matrix_transpose([[1, 2, 3], [4, 5, 6]]) → [[1, 4], [2, 5], [3, 6]].",
      inputSchema: {
        m: schemas.matrix,
      },
      execute: async ({ m }) =>
        withErrorHandling(async () => {
          const result = matrixTranspose(m);
          return success({ result });
        }),
    },
  ];
}

/**
 * Create the calculator MCP server.
 *
 * @param {object} [config] - { transport, port, host } from loadConfig.
 * @returns {object} Started-ready SimpleServer instance (start/stop).
 * @throws {Error} On invalid transport.
 */
export function createCalculatorMcpServer(config = {}) {
  const transport =
    config.transport || process.env.CALC_MCP_TRANSPORT || "http";
  if (!["stdio", "http", "sse"].includes(transport)) {
    throw new Error(
      `invalid transport "${transport}" — must be one of stdio, http, sse`,
    );
  }
  const port = config.port || 3778;
  const host = config.host || "127.0.0.1";
  const tools = getTools();

  const serverConfig = {
    name: "calculator-mcp-server",
    // Single source of truth: package.json version (never hand-synced).
    version: createRequire(import.meta.url)("../package.json").version,
    server: {
      connection:
        transport === "stdio"
          ? { type: "cli" }
          : { type: transport, port, host },
    },
    tools,
  };

  const server = createSimpleServer(serverConfig);

  // ALL diagnostics go to stderr: in stdio mode stdout IS the protocol
  // wire — a single stray log line corrupts the MCP stream.
  console.error(
    `[CalcMCP] Server configured (transport: ${transport}${transport === "stdio" ? "" : `, ${host}:${port}`})`,
  );
  console.error(`[CalcMCP] ${tools.length} tools registered`);

  return server;
}
