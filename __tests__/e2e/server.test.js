/**
 * E2E Test — Starts the Calculator MCP server on a test port and connects
 * via MCP StreamableHTTPClientTransport to verify the full round-trip:
 * initialize → listTools → callTool across the tool families.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createCalculatorMcpServer } from '../../src/mcp-server.js'

const TEST_PORT = 3779
const TEST_URL = `http://127.0.0.1:${TEST_PORT}/`

describe('E2E: Calculator MCP Server (HTTP)', () => {
  let server, client

  beforeAll(async () => {
    server = createCalculatorMcpServer({ port: TEST_PORT, host: '127.0.0.1' })
    await server.start()
    await new Promise((resolve) => setTimeout(resolve, 500))

    client = new Client({ name: 'test-client', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(TEST_URL))
    await client.connect(transport)
  })

  afterAll(async () => {
    if (client) await client.close()
    if (server) await server.stop()
  })

  it('lists exactly 13 tools', async () => {
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(13)
    const names = tools.map((t) => t.name)
    for (const expected of [
      'calculate',
      'derivative',
      'simplify',
      'solve',
      'integral',
      'symbolic_integral',
      'stats_describe',
      'stats_correlation',
      'stats_regression',
      'stats_confidence_interval',
      'matrix_add',
      'matrix_multiply',
      'matrix_transpose',
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('evaluates an expression over HTTP', async () => {
    const result = await client.callTool({
      name: 'calculate',
      arguments: { expression: 'sqrt(2) ^ 2' },
    })
    const body = JSON.parse(result.content[0].text)
    expect(body.success).toBe(true)
    expect(body.numeric).toBeCloseTo(2, 10)
  })

  it('differentiates symbolically over HTTP', async () => {
    const result = await client.callTool({
      name: 'derivative',
      arguments: { expression: 'x^3 - 2x', variable: 'x' },
    })
    const body = JSON.parse(result.content[0].text)
    expect(body.derivative).toBe('3 * x ^ 2 - 2')
  })

  it('solves numerically over HTTP (transcendental)', async () => {
    const result = await client.callTool({
      name: 'solve',
      arguments: { equation: 'e^x = 5', variable: 'x' },
    })
    const body = JSON.parse(result.content[0].text)
    expect(body.kind).toBe('numeric')
    expect(body.roots).toHaveLength(1)
    expect(Number(body.roots[0])).toBeCloseTo(Math.log(5), 6)
  })

  it('computes statistics over HTTP', async () => {
    const result = await client.callTool({
      name: 'stats_confidence_interval',
      arguments: { data: [2, 4, 6, 8, 10], confidenceLevel: 0.9 },
    })
    const body = JSON.parse(result.content[0].text)
    expect(body.mean).toBe(6)
    expect(body.upper).toBeGreaterThan(body.lower)
  })

  it('multiplies matrices over HTTP', async () => {
    const result = await client.callTool({
      name: 'matrix_multiply',
      arguments: { a: [[1, 2], [3, 4]], b: [[0, 1], [1, 0]] },
    })
    const body = JSON.parse(result.content[0].text)
    expect(body.result).toEqual([[2, 1], [4, 3]])
  })

  it('surfaces engine errors as isError over HTTP', async () => {
    const result = await client.callTool({
      name: 'calculate',
      arguments: { expression: 'import("fs")' },
    })
    expect(result.isError).toBe(true)
    const body = JSON.parse(result.content[0].text)
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/disabled/)
  })
})
