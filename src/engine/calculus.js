/**
 * Symbolic calculus — derivative and simplification.
 *
 * Thin, security-aware wrappers over mathjs AST operations. ALL input
 * passes through parseAndAudit (the shared sandbox policy in
 * engine/evaluate.js) before any mathjs operation runs — this module
 * never parses raw strings itself.
 *
 * Design decision (tool ergonomics): results are STRINGS. Agents read
 * strings; they do not walk ASTs. Every function here returns a
 * deterministic, human/agent-readable expression string.
 *
 * @module engine/calculus
 */

import { parseAndAudit, getSandboxMath } from "./evaluate.js";

/**
 * Validate a calculus variable name.
 *
 * @param {string} name - Variable to validate.
 * @param {string} role - Description used in error messages.
 * @returns {string} The validated name.
 * @throws {Error} When the name is not a valid math symbol.
 * @private
 */
function requireSymbolName(name, role) {
  if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `${role} must be a valid variable name (got ${JSON.stringify(name)})`,
    );
  }
  return name;
}

/**
 * Verify a differentiation variable actually appears in the expression
 * (or is provided via scope). d/dz of x^2 is mathematically 0, but for a
 * TOOL the caller almost certainly mistyped the variable — fail loudly
 * instead of silently returning zero.
 *
 * @param {object} node - Parsed AST.
 * @param {object|undefined} scope - Sanitized scope.
 * @param {string} variable - Differentiation variable.
 * @throws {Error} When the variable is absent from both AST and scope.
 * @private
 */
function requireVariablePresent(node, scope, variable) {
  let found = false;
  node.traverse((n) => {
    if (n.isSymbolNode && n.name === variable) found = true;
  });
  if (!found && !(scope && Object.hasOwn(scope, variable))) {
    throw new Error(
      `differentiation variable '${variable}' does not appear in the expression or scope`,
    );
  }
}

/**
 * Compute a symbolic derivative.
 *
 * @param {string|object} expression - Expression string (or parsed AST).
 * @param {string} variable - Differentiation variable, e.g. 'x'.
 * @param {object} [scope] - Optional variables, e.g. { a: 2 } for 'a*x^2'.
 * @returns {string} Simplified derivative as a string, e.g. '4 * x + 3'.
 * @throws {Error} On security-policy violations, invalid variable names,
 *   or a differentiation variable absent from expression and scope.
 */
export function symbolicDerivative(expression, variable, scope) {
  requireSymbolName(variable, "differentiation variable");
  const { math, node, cleanScope } =
    typeof expression === "string"
      ? parseAndAudit(expression, scope, { allowFreeSymbols: true })
      : { math: getSandboxMath(), node: expression, cleanScope: undefined };

  requireVariablePresent(node, cleanScope, variable);

  const derivative = math.derivative(node, variable);
  const simplified = math.simplify(derivative, cleanScope ?? {});
  return simplified.toString();
}

/**
 * Symbolically simplify an expression.
 *
 * @param {string|object} expression - Expression string (or parsed AST).
 * @param {object} [scope] - Optional variables, e.g. { x: 4 } substitutes
 *   numeric values during simplification.
 * @returns {string} Simplified expression as a string.
 * @throws {Error} On security-policy violations.
 */
export function symbolicSimplify(expression, scope) {
  const { math, node, cleanScope } =
    typeof expression === "string"
      ? parseAndAudit(expression, scope, { allowFreeSymbols: true })
      : { math: getSandboxMath(), node: expression, cleanScope: undefined };

  const simplified = math.simplify(node, cleanScope ?? {});
  return simplified.toString();
}
