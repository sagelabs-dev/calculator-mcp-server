/**
 * Calculator MCP Server — Entry Point (bootstrap only).
 *
 * Configuration lives in src/config.js (pure, testable). This module
 * wires it to the server and handles lifecycle. Stateless server:
 * nothing to persist, nothing to restore.
 *
 * NOTE: stdout is the MCP protocol wire in stdio mode — ALL diagnostics
 * go to stderr (console.error). Load-bearing invariant; do not "fix".
 *
 * @module index
 */

import { loadConfig } from "./config.js";
import { createCalculatorMcpServer } from "./mcp-server.js";

/**
 * Initialize and start the calculator MCP server.
 *
 * @param {object} [options]
 * @param {string} [options.transportDefault] - Transport assumed when the
 *   config/env do not specify one ('http' for the library entry, 'stdio'
 *   for the bin entry). Precedence: explicit config/env > this default.
 * @returns {Promise<{server: object}>} The started server (for tests).
 */
export async function runMain({ transportDefault = "http" } = {}) {
  const config = await loadConfig();
  if (!config.transportExplicit && transportDefault !== config.transport) {
    // Neither config file nor env chose a transport — apply the entry's
    // default (bin entry: stdio; library entry: http). An EXPLICIT
    // choice always wins over the entry default.
    config.transport = transportDefault;
  }
  const server = createCalculatorMcpServer(config);

  await server.start();
  if (config.transport === "stdio") {
    console.error("[CalcMCP] Listening on stdio (stdin/stdout pipes)");
  } else {
    console.error(
      `[CalcMCP] Listening on ${config.host}:${config.port} (config: ${config.configPath})`,
    );
  }

  // Graceful shutdown — stateless, so nothing to persist.
  async function shutdown() {
    console.error("[CalcMCP] Shutting down...");
    await server.stop();
    console.error("[CalcMCP] Stopped");
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { server, config };
}

// Entry module runs main on import only when executed directly
// (bin reuses runMain instead of importing this module).
if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("/").pop())
) {
  runMain().catch((error) => {
    console.error("[CalcMCP] Fatal error:", error);
    process.exit(1);
  });
}
