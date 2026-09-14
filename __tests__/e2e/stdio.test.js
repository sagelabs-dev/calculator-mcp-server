/**
 * E2E Test — Real stdio wire protocol.
 *
 * Spawns `node bin/calculator-mcp-server.js` as a child process and speaks
 * raw JSON-RPC 2.0 over stdin/stdout — the exact wire a real MCP client
 * (or gateway stdio entry) would use. No SDK transport abstraction: the
 * protocol itself is under test.
 *
 * Critical assertions:
 *   1. initialize → tools/list → tools/call round-trip works over stdio
 *   2. stdout carries ONLY protocol frames — zero [CalcMCP] log leakage
 *      (diagnostics go to stderr; stdout is the wire)
 */

import { describe, it, expect, afterAll } from 'vitest'
import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BIN = join(__dirname, '../../bin/calculator-mcp-server.js')

function startServer() {
  const child = spawn(process.execPath, [BIN], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, CALC_MCP_DEBUG: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdoutChunks = []
  const stderrChunks = []
  const pending = []
  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    if (!line.trim()) return
    stdoutChunks.push(line)
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return // non-JSON on stdout = protocol corruption; caught by assertion below
    }
    const idx = pending.findIndex((p) => p.id === msg.id)
    if (idx !== -1) {
      pending.splice(idx, 1)[0].resolve(msg)
    }
  })
  child.stderr.on('data', (d) => stderrChunks.push(d.toString()))

  let nextId = 1
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++
      pending.push({ id, resolve })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })

  return { child, request, stdoutChunks, stderrChunks }
}

describe('E2E: stdio wire protocol (bin entry)', () => {
  const sessions = []

  function spawnServer() {
    const s = startServer()
    sessions.push(s)
    return s
  }

  afterAll(async () => {
    for (const s of sessions) {
      s.child.kill('SIGTERM')
    }
    await new Promise((r) => setTimeout(r, 300))
  })

  it('completes initialize → tools/list → tools/call over raw stdio', async () => {
    const s = spawnServer()
    await new Promise((r) => setTimeout(r, 800)) // boot

    const init = await s.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'wire-test', version: '1.0.0' },
    })
    expect(init.result).toBeDefined()
    expect(init.result.serverInfo.name).toBe('calculator-mcp-server')

    await s.request('notifications/initialized', {})

    const list = await s.request('tools/list', {})
    expect(list.result.tools).toHaveLength(13)
    expect(list.result.tools.map((t) => t.name)).toContain('calculate')

    const call = await s.request('tools/call', {
      name: 'calculate',
      arguments: { expression: '6 * 7' },
    })
    expect(call.result.isError).toBeUndefined()
    const body = JSON.parse(call.result.content[0].text)
    expect(body.success).toBe(true)
    expect(body.numeric).toBe(42)

    const solve = await s.request('tools/call', {
      name: 'solve',
      arguments: { equation: 'x^2 - 5x + 6 = 0', variable: 'x' },
    })
    const solveBody = JSON.parse(solve.result.content[0].text)
    expect(solveBody.kind).toBe('symbolic')
    expect(solveBody.roots).toEqual(['2', '3'])
  })

  it('keeps stdout pure — zero log leakage into the protocol wire', async () => {
    const s = spawnServer()
    await new Promise((r) => setTimeout(r, 800))

    await s.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'wire-test', version: '1.0.0' },
    })
    await s.request('notifications/initialized', {})
    await s.request('tools/list', {})
    await s.request('tools/call', { name: 'calculate', arguments: { expression: '1 + 1' } })

    // Every stdout line must parse as JSON-RPC — any [CalcMCP] diagnostic
    // that leaked would appear here as a corruption.
    for (const line of s.stdoutChunks) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
    // Diagnostics belong on stderr.
    expect(s.stderrChunks.join('')).toContain('[CalcMCP]')
  })

  it('reports engine errors as isError results over the wire', async () => {
    const s = spawnServer()
    await new Promise((r) => setTimeout(r, 800))

    await s.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'wire-test', version: '1.0.0' },
    })
    await s.request('notifications/initialized', {})

    const call = await s.request('tools/call', {
      name: 'calculate',
      arguments: { expression: 'process' },
    })
    expect(call.result.isError).toBe(true)
    const body = JSON.parse(call.result.content[0].text)
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/not permitted/)
  })
})
