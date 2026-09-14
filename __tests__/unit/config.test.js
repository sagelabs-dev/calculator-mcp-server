/**
 * Unit tests — src/config.js
 *
 * Contract under test (hierarchy lowest → highest precedence):
 *   1. Code defaults (port 3778, loopback host, http transport)
 *   2. JSON5 config file (path via CALC_MCP_CONFIG, default ./config.json5)
 *   3. Environment variables (CALC_MCP_PORT, CALC_MCP_HOST, CALC_MCP_TRANSPORT)
 *
 * The `transportExplicit` flag tracks whether config file or env chose the
 * transport — entry defaults (http for library, stdio for bin) may only be
 * applied when NOTHING chose one explicitly.
 *
 * @module config.test
 */
import { describe, it, expect } from "vitest";
import {
  loadConfig,
  validateConfig,
  DEFAULTS,
  TRANSPORTS,
} from "../../src/config.js";

describe("config defaults", () => {
  it("defaults to port 3778, loopback host, http transport", async () => {
    const config = await loadConfig({});
    expect(config.port).toBe(3778);
    expect(config.host).toBe("127.0.0.1");
    expect(config.transport).toBe("http");
  });

  it("does not mark transport explicit when only defaults apply", async () => {
    const config = await loadConfig({});
    expect(config.transportExplicit).toBe(false);
  });
});

describe("config file layer", () => {
  it("loads a JSON5 config file at the default path", async () => {
    const config = await loadConfig({
      CALC_MCP_CONFIG: "__tests__/helpers/fixtures/config-http.json5",
    });
    expect(config.transport).toBe("http");
    expect(config.transportExplicit).toBe(true);
  });

  it("loads port and host from a config file", async () => {
    const config = await loadConfig({
      CALC_MCP_CONFIG: "__tests__/helpers/fixtures/config-custom.json5",
    });
    expect(config.port).toBe(4000);
    expect(config.host).toBe("0.0.0.0");
    expect(config.transportExplicit).toBe(false); // file set no transport
  });

  it("returns defaults when the config file is absent", async () => {
    const config = await loadConfig({
      CALC_MCP_CONFIG: "__tests__/helpers/fixtures/absent.json5",
    });
    expect(config.port).toBe(DEFAULTS.port);
    expect(config.transportExplicit).toBe(false);
  });
});

describe("environment layer", () => {
  it("CALC_MCP_PORT overrides the file and defaults", async () => {
    const config = await loadConfig({ CALC_MCP_PORT: "5000" });
    expect(config.port).toBe(5000);
  });

  it("CALC_MCP_HOST overrides the file and defaults", async () => {
    // TEST-NET-1 (RFC 5737) — a neutral fixture, never a real host.
    const config = await loadConfig({ CALC_MCP_HOST: "192.0.2.7" });
    expect(config.host).toBe("192.0.2.7");
  });

  it("CALC_MCP_TRANSPORT overrides the file and marks explicit", async () => {
    const config = await loadConfig({ CALC_MCP_TRANSPORT: "stdio" });
    expect(config.transport).toBe("stdio");
    expect(config.transportExplicit).toBe(true);
  });

  it("env wins over config file for transport", async () => {
    const config = await loadConfig({
      CALC_MCP_CONFIG: "__tests__/helpers/fixtures/config-http.json5",
      CALC_MCP_TRANSPORT: "sse",
    });
    expect(config.transport).toBe("sse");
    expect(config.transportExplicit).toBe(true);
  });

  it("env wins over config file for port", async () => {
    const config = await loadConfig({
      CALC_MCP_CONFIG: "__tests__/helpers/fixtures/config-custom.json5",
      CALC_MCP_PORT: "6000",
    });
    expect(config.port).toBe(6000);
  });
});

describe("validation", () => {
  it("rejects non-integer ports", () => {
    expect(() => validateConfig({ ...DEFAULTS, port: 3778.5 })).toThrow(/port/);
  });

  it("rejects out-of-range ports", () => {
    expect(() => validateConfig({ ...DEFAULTS, port: 0 })).toThrow(/port/);
    expect(() => validateConfig({ ...DEFAULTS, port: 65536 })).toThrow(/port/);
  });

  it("rejects empty hosts", () => {
    expect(() => validateConfig({ ...DEFAULTS, host: "" })).toThrow(/host/);
  });

  it("rejects unknown transports", () => {
    expect(() => validateConfig({ ...DEFAULTS, transport: "grpc" })).toThrow(
      /transport/,
    );
  });

  it("accepts every documented transport", () => {
    for (const t of ["stdio", "http", "sse"]) {
      expect(() => validateConfig({ ...DEFAULTS, transport: t })).not.toThrow();
    }
    expect(TRANSPORTS).toEqual(["stdio", "http", "sse"]);
  });

  it("loadConfig propagates validation errors", async () => {
    await expect(
      loadConfig({ CALC_MCP_PORT: "not-a-number" }),
    ).rejects.toThrow();
  });
});
