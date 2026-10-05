# @sagelabs/calculator-mcp-server

[![npm version](https://img.shields.io/npm/v/@sagelabs/calculator-mcp-server.svg)](https://www.npmjs.com/package/@sagelabs/calculator-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A **scientific calculator MCP tool server** for AI agents — safe expression
evaluation, symbolic calculus (derivatives, simplification, equation
solving, integration), statistics, and matrix operations, over the
[Model Context Protocol](https://modelcontextprotocol.io).

Stateless pure math. The agent is the brain; the server is the calculator.

## Tools (13)

| Tool | What it does | Example |
|---|---|---|
| `calculate` | Safe expression evaluation | `"2 + 3 * 4"` → `14`; `"x^2 + 1"` + scope `{"x": 3}` → `10` |
| `derivative` | Symbolic differentiation | `d/dx "2x^2 + 3x + 4"` → `"4 * x + 3"` |
| `simplify` | Algebraic simplification | `"2x + 3x"` → `"5 * x"` |
| `solve` | Equation solving | `"x^2 - 5x + 6 = 0"` → `["2", "3"]` |
| `integral` | Definite integrals | `"x^2"` from 0 to 3 → `9` (exact) |
| `symbolic_integral` | Polynomial antiderivatives | `"x^2"` → `"1 / 3 * x ^ 3"` |
| `stats_describe` | Summary statistics | mean/median/mode/variance/quartiles |
| `stats_correlation` | Pearson correlation | `r ∈ [-1, 1]` |
| `stats_regression` | OLS linear regression | slope/intercept/r²/rmse |
| `stats_confidence_interval` | t-based CI for the mean | verified against R |
| `matrix_add` | Element-wise sum | `[[1,2],[3,4]] + [[5,6],[7,8]]` |
| `matrix_multiply` | Matrix product | `m×k · k×n → m×n` |
| `matrix_transpose` | Transpose | rows become columns |

Every tool description embeds worked examples — an LLM caller learns each
tool from the tool itself.

## Highlights

- **Sandboxed by design.** Expressions are parsed to ASTs and audited
  *before* evaluation: a symbol allowlist (namespace members + your scope
  variables), a host-global blocklist enforced in every mode, assignment
  rejection, and throwing stubs on `import`/`evaluate`/`createUnit`.
  Escape-vector tests (`constructor.constructor`, `import("fs")`,
  `process`, `globalThis`) are first-class and must stay green.
- **Exact where possible.** Linear/quadratic equations are solved
  symbolically (rationals as fractions, complex pairs as `1 + 2i`);
  polynomial definite integrals (degree ≤ 4) are exact via antiderivatives
  that are *self-checked* (`dF/dx ≡ f` verified before returning).
- **Numeric where not.** Transcendental equations: deterministic scan of
  [-100, 100] with bisection polish. General integrals: adaptive Simpson
  with an error estimate.
- **Statistics you can trust.** The t-quantile (continued-fraction
  incomplete beta + Lanczos log-gamma) matches R's `qt()` to 15 digits —
  verified in the test suite against reference values.
- **JSON-native matrices.** Plain nested arrays in, plain nested arrays
  out. No library types leak across the wire.
- **All transports.** stdio (default for the bin entry), HTTP, and SSE —
  see [Configuration](#configuration).

## Install

```bash
npm install @sagelabs/calculator-mcp-server
# or run directly:
npx calculator-mcp-server
```

Requires Node.js ≥ 22.

## Usage with MCP clients

### stdio (Claude Desktop, most clients)

```json
{
  "mcpServers": {
    "calculator": {
      "command": "npx",
      "args": ["-y", "@sagelabs/calculator-mcp-server"]
    }
  }
}
```

### HTTP / SSE

```bash
npx calculator-mcp-server          # stdio (bin default)
CALC_MCP_TRANSPORT=http npx calculator-mcp-server   # HTTP on 127.0.0.1:3778
CALC_MCP_TRANSPORT=sse  npx calculator-mcp-server   # SSE
```

Library use:

```js
import { createCalculatorMcpServer } from '@sagelabs/calculator-mcp-server'

const server = createCalculatorMcpServer({ transport: 'http', port: 3778, host: '127.0.0.1' })
await server.start()
```

## Configuration

Precedence: **code defaults ← JSON5 config file ← environment variables.**

| Setting | Default | Config key | Env var |
|---|---|---|---|
| Transport | `http` (library) / `stdio` (bin) | `transport` | `CALC_MCP_TRANSPORT` |
| Port | `3778` | `port` | `CALC_MCP_PORT` |
| Host | `127.0.0.1` | `host` | `CALC_MCP_HOST` |

Config file path defaults to `./config.json5` (override with
`CALC_MCP_CONFIG`). See `config.example.json5`. An explicitly chosen
transport always wins over entry defaults.

## Security notes

- Expressions are untrusted input. The engine evaluates them in a
  sandboxed mathjs namespace with an audited AST pipeline — see
  `src/engine/evaluate.js` for the threat model and defense layers.
- Scope values must be finite numbers; nothing else crosses the boundary.
- DoS bounds: expression length ≤ 2000 chars, datasets ≤ 1M values,
  matrix dimensions ≤ 400×400.
- Bind loopback-only deployments unless you explicitly need otherwise;
  layer firewall rules for anything network-reachable.

## Development

```bash
npm install
npm test        # vitest: 169 unit + e2e tests
npm run lint    # eslint
npm run format:check
```

## License

[MIT](LICENSE)

---

Crafted with ❤️ by [Sage Labs](https://sagelabs.dev)
