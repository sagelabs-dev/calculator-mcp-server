#!/usr/bin/env node
/**
 * calculator-mcp-server — stdio entry point (npm bin).
 *
 * The `npx calculator-mcp-server` / gateway-spawn path. Runs the server
 * over stdio (stdin/stdout = MCP protocol wire) with the entry default
 * transport 'stdio' — an explicit config file or env var still wins.
 *
 * ALL diagnostics go to stderr. stdout is the protocol wire.
 *
 * @module bin/calculator-mcp-server
 */

import { runMain } from "../src/index.js";

runMain({ transportDefault: "stdio" }).catch((error) => {
  console.error("[CalcMCP] Fatal error:", error);
  process.exit(1);
});
