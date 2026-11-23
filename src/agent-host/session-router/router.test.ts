// The session router as a process: each session gets an adapter process of its own, started where
// and with what the session asks.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'

const ROUTER = path.resolve('src/agent-host/session-router/router.ts')

// An adapter that answers with what it was sent, its arguments and where it started; with
// \`--help\` it prints \`AGENT_HELP\` and exits.
const CHILD = `
import { createInterface } from 'node:readline'
if (process.argv.includes('--help')) {
  process.stdout.write(process.env.AGENT_HELP ?? '')
  process.exit(0)
}
const where = () => ({
  cwd: process.cwd(),
  electron: process.env.ELECTRON_RUN_AS_NODE ?? null,
  pid: process.pid,
})
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  const seen = { params: message.params, args: process.argv.slice(2), ...where() }
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
  args: string[]
  cwd: string
  electron: string | null
  pid: number
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

async function startRouter(
  options: { folderPerSession?: boolean; sessionFlag?: string; help?: string } = {},
) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kettu-router-')))
  dirs.push(dir)
  const child = path.join(dir, 'adapter.mjs')
  await writeFile(child, CHILD)
  // A copy of the runtime under another name stands for a program of another kind.
  const program = path.join(dir, 'program')
  await writeFile(program, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 })
  const words = options.folderPerSession
    ? ['--folder-per-session', program, child]
    : [process.execPath, child]
  if (options.sessionFlag) words.unshift(`--session-flag=${options.sessionFlag}`)
  const router = spawn(process.execPath, [ROUTER, ...words], {
    cwd: dir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      AGENT_HELP: options.help ?? '',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  routers.push(router)
  const waiting = new Map<number, (result: { _meta: Seen }) => void>()
  createInterface({ input: router.stdout! }).on('line', (line) => {
    const message = JSON.parse(line) as {
      id?: number
      result?: { _meta: Seen }
      error?: { message: string }
    }
    if (message.error) {
      waiting.get(message.id!)?.({ _meta: { error: message.error } } as never)
      return
    }
    if (message.id === undefined) return
    waiting.get(message.id)?.(message.result ?? { _meta: { error: message.error } as never })
  })
  let next = 1
  const request = (method: string, params: unknown) =>
    new Promise<{ sessionId?: string; _meta: Seen }>((resolve) => {
      const id = next++
      waiting.set(id, resolve)
      router.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  return { request, dir }
}

describe('the session router', () => {
  it.skipIf(process.platform === 'win32')(
    "starts each session's process in its folder, for new, load and resume",
    async () => {
      const { request, dir } = await startRouter({ folderPerSession: true })
      const control = await request('initialize', { protocolVersion: 1 })
      expect(control._meta.cwd).toBe(dir)
      const first = path.join(dir, 'first')
      const second = path.join(dir, 'second')
      await mkdir(first)
      await mkdir(second)

      const opened = await request('session/new', { cwd: first, mcpServers: [] })
      expect(opened._meta.cwd).toBe(first)
      // The runtime's switch to Node.js is not passed on to a program of another kind.
      expect(opened._meta.electron).toBeNull()
      const later = await request('session/prompt', { sessionId: opened.sessionId, prompt: [] })
      expect(later._meta.cwd).toBe(first)

      const loaded = await request('session/load', { sessionId: 'a', cwd: second, mcpServers: [] })
      expect(loaded._meta.cwd).toBe(second)
      const resumed = await request('session/resume', { sessionId: 'b', cwd: second })
      expect(resumed._meta.cwd).toBe(second)
      expect(resumed._meta.params).toEqual({ sessionId: 'b', cwd: second })
      const afterResume = await request('session/prompt', { sessionId: 'b', prompt: [] })
      expect(afterResume._meta.cwd).toBe(second)

      const missing = await request('session/new', {
        cwd: path.join(dir, 'gone'),
        mcpServers: [],
      })
      expect(missing.sessionId).toBeUndefined()
      // The failed request ended nothing else.
      const still = await request('session/prompt', { sessionId: opened.sessionId, prompt: [] })
      expect(still._meta.cwd).toBe(first)
    },
  )

  it("starts a session's process with the session flag when asked, once its help lists it", async () => {
    const help = 'Usage: agent acp [flags]\n  --dangerously-skip-permissions   Auto-approve all\n'
    const { request } = await startRouter({ sessionFlag: '--dangerously-skip-permissions', help })
    const control = await request('initialize', { protocolVersion: 1 })
    expect(
      (control as unknown as { _meta: Record<string, unknown> })._meta['sh.kettu/session-flag'],
    ).toBe('--dangerously-skip-permissions')
    expect(control._meta.args).not.toContain('--dangerously-skip-permissions')

    const opened = await request('session/new', { cwd: '/repo', mcpServers: [] })
    expect(opened._meta.args).not.toContain('--dangerously-skip-permissions')
    const sessionId = opened.sessionId!

    const flagged = await request('session/resume', {
      sessionId,
      cwd: '/repo',
      mcpServers: [],
      _meta: { 'sh.kettu/session-flag': true, other: 1 },
    })
    expect(flagged._meta.args).toContain('--dangerously-skip-permissions')
    expect(flagged._meta.params).toEqual({
      sessionId,
      cwd: '/repo',
      mcpServers: [],
      _meta: { other: 1 },
    })
    const prompt = await request('session/prompt', { sessionId, prompt: [] })
    expect(prompt._meta.args).toContain('--dangerously-skip-permissions')

    const plain = await request('session/resume', { sessionId, cwd: '/repo', mcpServers: [] })
    expect(plain._meta.args).not.toContain('--dangerously-skip-permissions')
  })

  it('refuses the session flag when its help does not list it or it was given none', async () => {
    const unlisted = await startRouter({
      sessionFlag: '--dangerously-skip-permissions',
      help: 'Usage: agent acp\n  --dangerously-skip-permissions-later   Something else\n',
    })
    const control = await unlisted.request('initialize', { protocolVersion: 1 })
    expect(
      (control as unknown as { _meta: Record<string, unknown> })._meta['sh.kettu/session-flag'],
    ).toBe(undefined)
    const refused = await unlisted.request('session/resume', {
      sessionId: 'a',
      cwd: '/repo',
      _meta: { 'sh.kettu/session-flag': true },
    })
    expect((refused._meta as unknown as { error?: unknown }).error).toBeDefined()

    const none = await startRouter()
    await none.request('initialize', { protocolVersion: 1 })
    const alsoRefused = await none.request('session/new', {
      cwd: '/repo',
      mcpServers: [],
      _meta: { 'sh.kettu/session-flag': true },
    })
    expect((alsoRefused._meta as unknown as { error?: unknown }).error).toBeDefined()
    expect(alsoRefused.sessionId).toBeUndefined()
  })

  it("loads a sub-agent in its parent's process, which keeps it until the parent goes", async () => {
    const { request } = await startRouter()
    await request('initialize', { protocolVersion: 1 })
    const parent = await request('session/new', { cwd: '/repo', mcpServers: [] })
    const other = await request('session/new', { cwd: '/repo', mcpServers: [] })
    const parentId = parent.sessionId!
    const asParent = { _meta: { 'sh.kettu/parent-session': parentId, other: 1 } }

    const loaded = await request('session/load', {
      sessionId: 'child',
      cwd: '/repo',
      mcpServers: [],
      ...asParent,
    })
    expect(loaded._meta.pid).toBe(parent._meta.pid)
    expect(loaded._meta.params).toEqual({
      sessionId: 'child',
      cwd: '/repo',
      mcpServers: [],
      _meta: { other: 1 },
    })
    const prompted = await request('session/prompt', { sessionId: 'child', prompt: [] })
    expect(prompted._meta.pid).toBe(parent._meta.pid)
    // A sub-agent of the sub-agent lives in the same process.
    const nested = await request('session/load', {
      sessionId: 'grandchild',
      cwd: '/repo',
      mcpServers: [],
      _meta: { 'sh.kettu/parent-session': 'child' },
    })
    expect(nested._meta.pid).toBe(parent._meta.pid)

    // Closing the sub-agent leaves the parent's process running.
    await request('session/close', { sessionId: 'child' })
    const still = await request('session/prompt', { sessionId: parentId, prompt: [] })
    expect(still._meta.pid).toBe(parent._meta.pid)
    const gone = await request('session/prompt', { sessionId: 'child', prompt: [] })
    expect((gone._meta as unknown as { error?: unknown }).error).toBeDefined()

    // The parent's process going takes its sub-agents with it, and leaves the other session's.
    await request('session/close', { sessionId: parentId })
    const orphan = await request('session/prompt', { sessionId: 'grandchild', prompt: [] })
    expect((orphan._meta as unknown as { error?: unknown }).error).toBeDefined()
    const unrelated = await request('session/prompt', { sessionId: other.sessionId, prompt: [] })
    expect(unrelated._meta.pid).toBe(other._meta.pid)

    const unknown = await request('session/load', {
      sessionId: 'lost',
      cwd: '/repo',
      mcpServers: [],
      _meta: { 'sh.kettu/parent-session': 'nobody' },
    })
    expect((unknown._meta as unknown as { error?: unknown }).error).toBeDefined()
  })

  it('keeps the runtime switch for a child that is the runtime itself', async () => {
    const { request } = await startRouter()
    await request('initialize', { protocolVersion: 1 })
    const opened = await request('session/new', { cwd: '/repo', mcpServers: [] })
    expect(opened._meta.electron).toBe('1')
  })
})
