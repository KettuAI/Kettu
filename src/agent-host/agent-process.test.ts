// Process tests: the real spawn and stop code against the fake agent on stdio.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyPatches, threadFromSnapshot, type ThreadState } from '@shared/thread'
import { AgentConnection, type ConnectionHooks, type SessionTarget } from './acp/connection'
import { newTurnScope } from './acp/mapper'
import { spawnAgent, spawnArguments } from './agent-process'
import { processLauncher } from './agents'
import type { LaunchSpec } from './catalog'
import { startTestHost } from './testing/harness'

const FAKE_AGENT = path.resolve('tools/fake-agent/main.ts')

function spec(env: Record<string, string> = {}): LaunchSpec {
  return {
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_AGENT_DELAY_SCALE: '0', ...env },
    shell: false,
    display: { command: 'node', args: [FAKE_AGENT], env: {} },
  }
}

const hooks: ConnectionHooks = {
  traffic: () => {},
  account: () => {},
  ignored: () => {},
  log: () => {},
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

function start(env: Record<string, string> = {}, timings = { eofMs: 2_000, termMs: 3_000 }) {
  let stderr = ''
  const events: string[] = []
  const agent = spawnAgent(spec(env), {
    platform: process.platform,
    env: process.env,
    cwd: process.cwd(),
    onStderr: (text) => (stderr += text),
    onEvent: (event) => events.push(event),
    timings,
  })
  return { agent, stderr: () => stderr, events }
}

describe('spawnAgent', () => {
  it('speaks ACP over stdio and stops cleanly on EOF', async () => {
    const { agent, stderr, events } = start()
    const connection = AgentConnection.connect(agent.transport, hooks)
    const init = await connection.initialize('0.0.0-test')
    expect(init).toMatchObject({ protocolVersion: 1, version: '0.1.0', name: 'Fake agent' })
    expect(init.capabilities).toMatchObject({ loadSession: true, listSessions: true, logout: true })

    const { acpSessionId } = await connection.newSession(process.cwd())
    let thread: ThreadState = threadFromSnapshot({
      session: {
        id: 's',
        agentId: 'fake-agent',
        projectPath: process.cwd(),
        acpSessionId,
        status: 'running',
        title: null,
        config: [],
        commands: [],
        usage: null,
        error: null,
        turnStartedAt: null,
        createdAt: 0,
        updatedAt: 0,
        parentId: null,
        origin: 'user',
        subagent: null,
      },
      entries: [],
      seq: 0,
    })
    let n = 0
    const scope = newTurnScope()
    const target: SessionTarget = {
      context: () => ({
        thread,
        replaying: false,
        scope,
        now: Date.now(),
        nextId: () => `e:${++n}`,
        sessionIdFor: () => null,
      }),
      apply: (output) => {
        thread = applyPatches(thread, output.patches)
      },
      requestPermission: async () => 'cancelled',
    }
    connection.register(acpSessionId, target)
    const result = await connection.prompt(acpSessionId, [{ type: 'text', text: 'Hello there' }])
    expect(result.stopReason).toBe('end_turn')
    expect(result.tokens?.total).toBeGreaterThan(0)
    expect(thread.session.title).toBe('Hello there')
    expect(Object.values(thread.byId).some((entry) => entry.kind === 'tool')).toBe(true)

    const started = Date.now()
    const exit = await agent.stop()
    expect(exit.code).toBe(0)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(events).not.toContain('SIGTERM')
    expect(stderr()).toContain('fake-agent: ready')
  })

  it('reports a crash with its exit code', async () => {
    const { agent } = start()
    const connection = AgentConnection.connect(agent.transport, hooks)
    await connection.initialize('0.0.0-test')
    const { acpSessionId } = await connection.newSession(process.cwd())
    const prompt = connection.prompt(acpSessionId, [{ type: 'text', text: '/crash --code 7' }])
    await expect(prompt).rejects.toMatchObject({ kind: 'closed' })
    expect(await agent.exited).toMatchObject({ code: 7 })
    expect(agent.hasExited).toBe(true)
  })

  it('reports a program that cannot be started', async () => {
    const agent = spawnAgent(
      { ...spec(), command: path.resolve('does-not-exist-overbench') },
      { platform: process.platform, env: process.env, cwd: process.cwd(), onStderr: () => {} },
    )
    const exit = await agent.exited
    expect(exit.error).toBeTruthy()
    expect(agent.pid).toBeNull()
  })

  it('stops a process tree that ignores EOF', async () => {
    const { agent, stderr, events } = start(
      { FAKE_AGENT_IGNORE_EOF: '1', FAKE_AGENT_SPAWN_CHILD: '1' },
      { eofMs: 300, termMs: 2_000 },
    )
    expect(await until(() => /child pid (\d+)/.test(stderr()), 10_000)).toBe(true)
    const childPid = Number(/child pid (\d+)/.exec(stderr())![1])
    expect(alive(childPid)).toBe(true)
    await agent.stop()
    expect(agent.hasExited).toBe(true)
    expect(await until(() => !alive(childPid), 3_000)).toBe(true)
    expect(events).toContain(process.platform === 'win32' ? 'taskkill' : 'SIGTERM')
  })

  // Windows has no SIGTERM to ignore: taskkill /F always ends the tree.
  it.skipIf(process.platform === 'win32')(
    'escalates to SIGKILL when SIGTERM is ignored',
    async () => {
      const { agent, stderr, events } = start(
        { FAKE_AGENT_IGNORE_EOF: '1', FAKE_AGENT_IGNORE_SIGTERM: '1', FAKE_AGENT_SPAWN_CHILD: '1' },
        { eofMs: 200, termMs: 500 },
      )
      expect(await until(() => /child pid (\d+)/.test(stderr()), 10_000)).toBe(true)
      const childPid = Number(/child pid (\d+)/.exec(stderr())![1])
      await agent.stop()
      expect(events).toEqual(expect.arrayContaining(['SIGTERM', 'SIGKILL']))
      expect(await until(() => !alive(childPid), 3_000)).toBe(true)
    },
  )
})

describe('spawnArguments', () => {
  it('passes catalog words straight through, without a shell', () => {
    expect(spawnArguments(spec())).toEqual({
      file: process.execPath,
      args: [FAKE_AGENT],
      shell: false,
    })
  })

  it('joins a .cmd shim into one quoted cmd.exe line', () => {
    expect(
      spawnArguments({
        command: 'C:\\Program Files\\nodejs\\npx.cmd',
        args: ['-y', '@agentclientprotocol/codex-acp@2.2.2'],
        env: {},
        shell: true,
        display: { command: 'npx', args: [], env: {} },
      }),
    ).toEqual({
      file: '"C:\\Program Files\\nodejs\\npx.cmd" -y @agentclientprotocol/codex-acp@2.2.2',
      args: [],
      shell: true,
    })
  })
})

describe('a crashed agent process', () => {
  it('is restarted and its sessions resume', async () => {
    const t = await startTestHost({
      launcher: processLauncher(process.platform),
      agentEnv: { FAKE_AGENT_DELAY_SCALE: '0' },
    })
    try {
      const port = t.connect()
      const created = await port.request('sessions.create', {
        agentId: 'fake-agent',
        projectPath: t.project,
      })
      await port.open(created.id)
      const pids = () =>
        t.sent.flatMap((m) => (m.type === 'host:agent-processes' ? [m.processes] : []))
      const firstPid = pids().at(-1)?.[0]?.pid
      expect(firstPid).toBeGreaterThan(0)

      await port.request('sessions.prompt', {
        sessionId: created.id,
        content: [{ type: 'text', text: '/crash --code 5' }],
      })
      await port.untilStatus(created.id, 'disconnected')
      await port.untilStatus(created.id, 'ready')
      const exit = t.host.diagnostics
        .agentRecords('fake-agent')
        .events.find((e) => e.event === 'exit')
      expect(exit?.detail).toBe('exited with code 5')
      expect(pids()).toContainEqual([])
      const secondPid = pids().at(-1)?.[0]?.pid
      expect(secondPid).toBeGreaterThan(0)
      expect(secondPid).not.toBe(firstPid)

      await port.request('sessions.prompt', {
        sessionId: created.id,
        content: [{ type: 'text', text: 'hello again' }],
      })
      await port.untilStatus(created.id, 'ready')
      expect(port.entries(created.id).at(-1)).toMatchObject({ stopReason: 'end_turn' })
    } finally {
      await t.stop()
    }
    expect(t.sent.at(-1)).toEqual({ type: 'host:stopped' })
    const last = t.sent.filter((m) => m.type === 'host:agent-processes').at(-1)
    expect(last).toEqual({ type: 'host:agent-processes', processes: [] })
  })
})
