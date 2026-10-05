/**
 * Configuration loading — pure module, independently testable.
 *
 * Hierarchy (lowest → highest precedence):
 *   1. Code defaults (port 3778, loopback-informed host, http transport)
 *   2. JSON5 config file (default: ./config.json5, path via CALC_MCP_CONFIG)
 *   3. Environment variables (CALC_MCP_PORT, CALC_MCP_HOST, CALC_MCP_TRANSPORT)
 *
 * The `host` field is honored by @sagelabs/mcp-ai 1.6.7-guan.0 —
 * SimpleServer's express listen() binds only the configured interface.
 * Loopback-only deployment layers (systemd IPAddressDeny/Allow + UFW
 * default-deny) remain as defense-in-depth.
 *
 * @module config
 */

import JSON5 from "json5";
import { readFile } from "fs/promises";

/** Code defaults. */
export const DEFAULTS = Object.freeze({
  port: 3778,
  host: "127.0.0.1",
  transport: "http",
});

/**
 * Transports accepted by createCalculatorMcpServer. 'stdio' is the
 * caller-facing name and maps to SimpleServer's 'cli' connection type
 * (see src/index.js).
 */
export const TRANSPORTS = Object.freeze(["stdio", "http", "sse"]);

/**
 * Validate merged configuration.
 *
 * @param {{port: number, host: string, transport: string}} config
 * @throws {Error} On invalid port, host, or transport.
 */
export function validateConfig(config) {
  if (
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535
  ) {
    throw new Error(
      `invalid port ${config.port} — must be an integer in 1..65535`,
    );
  }
  if (typeof config.host !== "string" || config.host === "") {
    throw new Error(
      `invalid host ${JSON.stringify(config.host)} — must be a non-empty string`,
    );
  }
  if (!config.transport || !TRANSPORTS.includes(config.transport)) {
    throw new Error(
      `invalid transport ${JSON.stringify(config.transport)} — must be one of ${TRANSPORTS.join(", ")}`,
    );
  }
}

/**
 * Load configuration: defaults ← JSON5 file ← environment overrides.
 *
 * @param {object} [env] - Environment-like object (defaults to process.env;
 *   injectable for tests).
 * @returns {Promise<{port: number, host: string, transport: string,
 *   configPath: string, transportExplicit: boolean}>} Merged configuration,
 *   the config path used (for diagnostics), and whether the transport was
 *   explicitly set by config file or env (entry defaults may not override it).
 */
export async function loadConfig(env = process.env) {
  let config = { ...DEFAULTS };
  let transportExplicit = false;

  // Layer 2: JSON5 config file (optional).
  const configPath = env.CALC_MCP_CONFIG || "./config.json5";
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON5.parse(raw);
    if (parsed.transport !== undefined) transportExplicit = true;
    config = { ...config, ...parsed };
  } catch {
    // Config file is optional — defaults + env are sufficient.
    if (env.CALC_MCP_DEBUG) {
      console.info(
        "[CalcMCP] No config file at",
        configPath,
        "— using defaults + env",
      );
    }
  }

  // Layer 3: environment overrides.
  if (env.CALC_MCP_PORT !== undefined) {
    config.port = parseInt(env.CALC_MCP_PORT, 10);
  }
  if (env.CALC_MCP_HOST !== undefined) {
    config.host = env.CALC_MCP_HOST;
  }
  if (env.CALC_MCP_TRANSPORT !== undefined) {
    config.transport = env.CALC_MCP_TRANSPORT;
    transportExplicit = true;
  }

  validateConfig(config);

  return { ...config, configPath, transportExplicit };
}
