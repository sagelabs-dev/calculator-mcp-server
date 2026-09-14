/**
 * Sandboxed expression evaluation — the security-critical core.
 *
 * THREAT MODEL: the expression string is UNTRUSTED agent input. A naive
 * calculator is arbitrary-code-execution-by-default. Defenses, in order:
 *
 *   1. SANDBOXED NAMESPACE — a dedicated mathjs instance whose dangerous
 *      members are replaced with throwing stubs:
 *        - import()     → the JS module loader escape (fs, child_process…)
 *        - evaluate()   → nested string evaluation (re-entry into eval)
 *        - createUnit() → documented abuse surface (global object mutation)
 *      The parser resolves symbols from the namespace at compile time, so
 *      expressions naming these members resolve the STUB and fail closed.
 *      Engine code drives evaluations through the captured raw evaluator
 *      (see rawEvaluateByInstance — the stub replaces math.evaluate too).
 *      The three overrides MUST be applied in ONE math.import call:
 *      overriding `import` replaces math.import itself, so a second call
 *      would invoke the stub.
 *
 *   2. AST SYMBOL ALLOWLIST — before evaluation, the parsed tree is walked
 *      and every SymbolNode name must be EITHER a namespace member
 *      (Object.hasOwn — rejects prototype-chain gadgets like
 *      `constructor`, `toString`, `valueOf`, which resolve on the prototype
 *      but are not own properties) OR a user scope key. Everything else —
 *      `process`, `globalThis`, `eval`, `constructor`, `fetch`, … — is
 *      rejected BEFORE execution with a precise symbol-level error.
 *      AssignmentNode / FunctionAssignmentNode are rejected as policy: a
 *      calculator evaluates, it does not define.
 *
 *   3. STRICT SCOPE TYPING — only finite numbers may be injected; strings,
 *      functions, objects, NaN and Infinity are rejected before parsing.
 *      (Plain scope objects, not null-prototype maps: mathjs typed-function
 *      dispatch introspects scope internals and crashes on null-prototype
 *      objects — and the allowlist in (2) already neutralizes the gadget
 *      class null prototypes were defending against.)
 *
 *   4. LENGTH BOUND — expressions are capped (DoS bound on parse time).
 *
 * Every evaluation in this server (evaluate, numeric root-finding, numeric
 * verification of integrals) MUST go through this module's sandboxed
 * instance — never a raw mathjs import. See tests for the escape-vector
 * suite; if a new vector is discovered, add it THERE.
 *
 * @module engine/evaluate
 */

import { create, all } from 'mathjs'

/** Maximum accepted expression length (characters). */
export const MAX_EXPRESSION_LENGTH = 2000

/** Functions replaced with throwing stubs in the sandbox. */
const DISABLED_FUNCTIONS = ['import', 'evaluate', 'createUnit']

/**
 * Raw evaluators captured before stubbing, keyed by instance (WeakMap =
 * private per-instance state without polluting the mathjs object).
 *
 * WHY: the banned names ARE part of the namespace API surface — overriding
 * `evaluate` replaces math.evaluate itself. The parser resolves symbols
 * from the namespace at compile time, so expressions containing
 * `evaluate("...")` resolve the STUB and fail closed, while engine code
 * drives evaluations through the captured original.
 */
const rawEvaluateByInstance = new WeakMap()

/**
 * Create a fresh sandboxed mathjs instance.
 *
 * Each call yields an INDEPENDENT instance (mathjs `create()` gives the
 * instance its own namespace), so overriding banned functions here cannot
 * affect other instances. Engine modules share one instance via
 * `getSandboxMath()`; tests may create isolated ones.
 *
 * The three overrides MUST be applied in a single math.import call:
 * overriding `import` replaces math.import itself, so a second call would
 * invoke the throwing stub.
 *
 * @returns {object} Sandboxed mathjs instance.
 */
export function createCalculatorMath() {
  const math = create(all, {})
  rawEvaluateByInstance.set(math, math.evaluate)
  const stubs = {}
  for (const name of DISABLED_FUNCTIONS) {
    stubs[name] = () => {
      throw new Error(`'${name}()' is disabled in the calculator sandbox`)
    }
  }
  math.import(stubs, { override: true })
  return math
}

/**
 * Get the captured raw evaluator for a sandboxed instance.
 *
 * @param {object} math - Instance created by createCalculatorMath().
 * @returns {Function} The original mathjs evaluate.
 * @private
 */
function getRawEvaluate(math) {
  const fn = rawEvaluateByInstance.get(math)
  if (!fn) throw new Error('math instance was not created by createCalculatorMath')
  return fn
}

/** Shared sandboxed instance for all engine modules. */
let sharedSandbox = null

/**
 * Get the shared sandboxed mathjs instance (lazily created).
 *
 * @returns {object} The shared sandboxed mathjs instance.
 */
export function getSandboxMath() {
  if (!sharedSandbox) sharedSandbox = createCalculatorMath()
  return sharedSandbox
}

/**
 * Validate and sanitize a user-supplied variable scope.
 *
 * Only finite numbers are accepted; keys must be valid math symbols.
 *
 * @param {object|undefined} [scope] - Map of variable names to numbers.
 * @returns {object|undefined} Plain scope object, or undefined when no
 *   scope was supplied.
 * @throws {Error} On non-object scopes, non-number values, non-finite
 *   values, or malformed keys.
 */
function sanitizeScope(scope) {
  if (scope === undefined || scope === null) return undefined
  if (typeof scope !== 'object' || Array.isArray(scope)) {
    throw new Error('scope must be an object mapping variable names to finite numbers')
  }
  // Plain object (NOT null-prototype): mathjs typed-function dispatch
  // introspects scope internals and crashes on null-prototype maps.
  // Prototype-gadget defense is the AST allowlist's job (see module docs).
  const clean = {}
  for (const [key, value] of Object.entries(scope)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`scope key '${key}' is not a valid variable name`)
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(
        `scope value for '${key}' must be a finite number (got ${typeof value})`,
      )
    }
    clean[key] = value
  }
  return clean
}

/**
 * Evaluate a mathematical expression safely.
 *
 * @param {string} expression - Math expression, e.g. "2 + 3 * sqrt(16)".
 * @param {object} [scope] - Optional variables, e.g. { x: 3 } for "x^2".
 * @returns {{result: string, numeric: number|null, valueType: string}}
 *   `result` is a deterministic formatted string; `numeric` is the plain
 *   JS number when the value is a finite real number (else null);
 *   `valueType` classifies the result ('number', 'complex', 'unit',
 *   'matrix', 'boolean', 'string', 'null', 'other').
 * @throws {Error} On syntax errors, undefined symbols, banned functions,
 *   scope violations, or length violations — all failures close.
 */
export function evaluateExpression(expression, scope) {
  const { math, cleanScope } = parseAndAudit(expression, scope)
  const rawEvaluate = getRawEvaluate(math)
  const value =
    cleanScope === undefined
      ? rawEvaluate.call(math, expression)
      : rawEvaluate.call(math, expression, cleanScope)

  return classifyValue(math, value)
}

/**
 * Parse an expression and enforce the full security policy WITHOUT
 * evaluating. Shared entry point for every AST-consuming engine operation
 * (evaluate, derivative, simplify, solve, integrate) so the sandbox rules
 * are defined exactly once.
 *
 * @param {string} expression - Raw untrusted expression string.
 * @param {object} [scope] - Optional user variables.
 * @returns {{math: object, node: object, cleanScope: object|undefined}}
 *   The sandboxed instance, parsed AST, and sanitized scope.
 * @throws {Error} On type/empty/length violations, scope violations, or
 *   any security-policy violation (forbidden node types, unknown symbols).
 */
export function parseAndAudit(expression, scope, { allowFreeSymbols = false } = {}) {
  if (typeof expression !== 'string') {
    throw new Error('expression must be a string')
  }
  if (expression.trim() === '') {
    throw new Error('expression is empty')
  }
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(
      `expression exceeds maximum length of ${MAX_EXPRESSION_LENGTH} characters`,
    )
  }

  const math = getSandboxMath()
  const cleanScope = sanitizeScope(scope)

  // Parse WITHOUT executing — parse only builds the AST.
  const node = math.parse(expression)

  // Security policy: node types + symbol allowlist (see module docs).
  // Numeric evaluation requires every symbol to be namespace/scope-bound;
  // symbolic operations (derivative, simplify, solve, integral) allow
  // free variables — the security properties (no host objects, no
  // prototype gadgets, no assignments) hold either way, because gadgets
  // like `constructor` are never OWN namespace members.
  for (const violation of auditAst(math, node, cleanScope, allowFreeSymbols)) {
    throw new Error(violation)
  }

  return { math, node, cleanScope }
}

/**
 * Require every symbol in the AST to be bound: a namespace member, a scope
 * variable, or the operation variable itself. Shared by solve and integral
 * — coefficient extraction/evaluation is impossible with unbound symbols,
 * so callers get one precise error naming every offender.
 *
 * @param {object} math - Sandboxed instance.
 * @param {object} node - AST to walk.
 * @param {object|undefined} scope - Sanitized scope.
 * @param {string} variable - The operation variable (allowed free symbol).
 * @throws {Error} On any unbound non-variable symbol.
 */
export function requireBoundSymbols(math, node, scope, variable) {
  const unbound = new Set()
  node.traverse((n) => {
    if (!n.isSymbolNode) return
    const name = n.name
    if (name === variable) return
    if (Object.hasOwn(math, name)) return
    if (scope && Object.hasOwn(scope, name)) return
    unbound.add(name)
  })
  if (unbound.size > 0) {
    const names = [...unbound].sort().map((s) => `'${s}'`).join(', ')
    throw new Error(
      `coefficients must be numeric or resolvable via scope — unresolved symbol(s): ${names}`,
    )
  }
}

/** Node types rejected as policy regardless of content. */
const FORBIDDEN_NODE_TYPES = new Set(['AssignmentNode', 'FunctionAssignmentNode'])

/**
 * Host-environment symbols rejected in EVERY mode, including symbolic
 * mode (allowFreeSymbols). Free MATH variables are fine — 'foo', 't',
 * 'k' — but a free symbol colliding with a JS host global would flow
 * through symbolic transforms (derivative/simplify never evaluate it,
 * but the name would ride along in returned strings and could later be
 * fed back into numeric evaluation contexts). Defense in depth: the
 * namespace-allowlist guards numeric mode; this blocklist guards both.
 */
const HOST_SYMBOL_BLOCKLIST = new Set([
  'process',
  'globalThis',
  'global',
  'constructor',
  'eval',
  'Function',
  'require',
  'module',
  'exports',
  'window',
  'document',
  'Buffer',
  'fetch',
])

/**
 * Audit a parsed AST against the security policy.
 *
 * @param {object} math - Sandboxed instance (namespace membership source).
 * @param {object} root - Parsed mathjs AST root node.
 * @param {object|undefined} scope - Sanitized user scope (allowed symbols).
 * @returns {string[]} Human-readable violations; empty when clean.
 * @private
 */
function auditAst(math, root, scope, allowFreeSymbols) {
  const violations = []
  root.traverse((node) => {
    if (violations.length > 0) return // report first violation only
    if (FORBIDDEN_NODE_TYPES.has(node.type)) {
      violations.push(`assignments are not permitted in calculator expressions (${node.type})`)
      return
    }
    if (node.isSymbolNode) {
      const name = node.name
      const inNamespace = Object.hasOwn(math, name)
      const inScope = scope !== undefined && Object.hasOwn(scope, name)
      if (HOST_SYMBOL_BLOCKLIST.has(name)) {
        violations.push(`symbol '${name}' is not permitted in calculator expressions`)
      } else if (!inNamespace && !inScope && !allowFreeSymbols) {
        violations.push(
          `symbol '${name}' is not a known function, constant, or scope variable`,
        )
      }
    }
  })
  return violations
}

/**
 * Classify and format an evaluation result.
 *
 * @param {object} math - The sandboxed instance (for typeOf/format).
 * @param {*} value - Raw evaluation result.
 * @returns {{result: string, numeric: number|null, valueType: string}}
 * @private
 */
function classifyValue(math, value) {
  const type = math.typeOf(value)
  const formatted = math.format(value, { precision: 14 })

  switch (type) {
    case 'number':
      return {
        result: formatted,
        numeric: Number.isFinite(value) ? value : null,
        valueType: 'number',
      }
    case 'BigNumber':
    case 'Fraction': {
      const n = Number(value)
      return { result: formatted, numeric: Number.isFinite(n) ? n : null, valueType: 'number' }
    }
    case 'Complex':
      return { result: formatted, numeric: null, valueType: 'complex' }
    case 'Unit':
      return { result: formatted, numeric: null, valueType: 'unit' }
    case 'Matrix':
    case 'Array':
    case 'DenseMatrix':
      return { result: formatted, numeric: null, valueType: 'matrix' }
    case 'boolean':
      return { result: formatted, numeric: null, valueType: 'boolean' }
    case 'string':
      return { result: formatted, numeric: null, valueType: 'string' }
    case 'null':
    case 'undefined':
      return { result: formatted, numeric: null, valueType: 'null' }
    default:
      return { result: formatted, numeric: null, valueType: 'other' }
  }
}
