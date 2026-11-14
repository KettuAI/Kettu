// The session router as a process: a session's Kettu MCP service reaches that session's adapter
// process alone, as variables, and never the adapter itself in the request.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'

const ROUTER = path.resolve('src/agent-host/session-router/router.ts')

// An adapter that answers with what it was sent and the service variables it started with.
const CHILD = `
import { createInterface } from 'node:readline'
const env = () => ({
  url: process.env.KETTU_MCP_URL ?? null,
  token: process.env.KETTU_MCP_TOKEN ?? null,
})
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  const seen = { params: message.params, env: env() }
  const result =
    message.method === 'session/new'
      ? { sessionId: 'session-' + process.pid, _meta: seen }
      : message.method === 'initialize'
        ? { protocolVersion: 1, agentCapabilities: {}, _meta: seen }
        : { _meta: seen }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
})
`

interface Seen {
  params: Record<string, unknown>
  env: { url: string | null; token: string | null }
}

const dirs: string[] = []
const routers: ChildProcess[] = []

afterEach(async () => {
  for (const router of routers.splice(0)) {
    router.stdin?.end()
    if (router.exitCode === null) await new Promise((resolve) => router.once('exit', resolve))
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function startRouter() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-router-'))
  dirs.push(dir)
  const child = path.join(dir, 'adapter.mjs')
  await writeFile(child, CHILD)
  const router = spawn(process.execPath, [ROUTER, process.execPath, child], {
    // A service the router itself inherited goes to no child.
    env: { ...process.env, KETTU_MCP_URL: 'http://inherited', KETTU_MCP_TOKEN: 'inherited' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  routers.push(router)
  const waiting = new Map<number, (result: { _meta: Seen }) => void>()
  createInterface({ input: router.stdout! }).on('line', (line) => {
    const message = JSON.parse(line) as { id?: number; result?: { _meta: Seen } }
    if (message.id !== undefined) waiting.get(message.id)?.(message.result!)
  })
  let next = 1
  const request = (method: string, params: unknown) =>
    new Promise<{ sessionId?: string; _meta: Seen }>((resolve) => {
      const id = next++
      waiting.set(id, resolve)
      router.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  return { request }
}

describe('the session router', () => {
  it("gives a session's service to its own process only, out of the request", async () => {
    const { request } = await startRouter()
    const control = await request('initialize', { protocolVersion: 1 })
    expect(control._meta.env).toEqual({ url: null, token: null })

    const service = { url: 'http://127.0.0.1:4100/mcp', token: 'session-token' }
    const opened = await request('session/new', {
      cwd: '/repo',
      mcpServers: [],
      _meta: { 'sh.kettu/mcp': service, other: 1 },
    })
    expect(opened._meta.env).toEqual(service)
    expect(opened._meta.params).toEqual({ cwd: '/repo', mcpServers: [], _meta: { other: 1 } })

    const plain = await request('session/new', { cwd: '/repo', mcpServers: [] })
    expect(plain._meta.env).toEqual({ url: null, token: null })
    expect(plain._meta.params).toEqual({ cwd: '/repo', mcpServers: [] })

    const loaded = await request('session/load', {
      sessionId: 'earlier',
      cwd: '/repo',
      mcpServers: [],
      _meta: { 'sh.kettu/mcp': { url: service.url, token: 'other-token' } },
    })
    expect(loaded._meta.env).toEqual({ url: service.url, token: 'other-token' })
    expect(loaded._meta.params).toEqual({ sessionId: 'earlier', cwd: '/repo', mcpServers: [] })

    // A later request of the first session still reaches its process, which kept its own.
    const later = await request('session/set_mode', { sessionId: opened.sessionId, modeId: 'x' })
    expect(later._meta.env).toEqual(service)
  })

  it('passes no variables for a service it cannot use, and still strips it', async () => {
    const { request } = await startRouter()
    await request('initialize', { protocolVersion: 1 })
    const opened = await request('session/new', {
      cwd: '/repo',
      mcpServers: [],
      _meta: { 'sh.kettu/mcp': { url: 'http://127.0.0.1:1/mcp', token: 'a\nb' } },
    })
    expect(opened._meta.env).toEqual({ url: null, token: null })
    expect(opened._meta.params).toEqual({ cwd: '/repo', mcpServers: [] })
  })
})
