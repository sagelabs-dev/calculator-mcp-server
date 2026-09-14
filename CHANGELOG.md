# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-13

### Added
- Initial release: 13 MCP tools for agentic mathematics.
  - Core evaluation: `calculate` (sandboxed, AST-audited expression
    evaluation with scope support and typed results).
  - Symbolic calculus: `derivative`, `simplify`, `solve` (exact
    linear/quadratic + numeric general fallback), `integral` (exact
    polynomial + adaptive Simpson), `symbolic_integral` (self-checked
    polynomial antiderivatives).
  - Statistics: `stats_describe`, `stats_correlation`,
    `stats_regression`, `stats_confidence_interval` (t-quantile verified
    against R reference values).
  - Matrices: `matrix_add`, `matrix_multiply`, `matrix_transpose`
    (JSON-native nested arrays).
- Transports: stdio, HTTP, SSE with config precedence
  (defaults ← JSON5 file ← env).
- Security: AST symbol allowlist, host-symbol blocklist (all modes),
  assignment rejection, sandboxed namespace stubs, DoS bounds,
  escape-vector test suite.
- Tests: 169 (unit + e2e over raw stdio wire and HTTP SDK round-trip).
