// Process tests: the real spawn and stop code against the fake agent on stdio.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyPatches, threadFromSnapshot, type ThreadState } from '@shared/thread'
import { AgentConnection, type ConnectionHooks, type SessionTarget } from './acp/connection'
import { newTurnScope } from './acp/mapper'
import { spawnAgent, spawnArguments } from './agent-process'
import { processLauncher } from './agents'
import type { LaunchSpec } from './catalog'
import { processControl, runTool, type ProcessControl } from './process-tree'
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
        queue: [],
        queuePaused: false,
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

describe('a process tool that times out', () => {
  it('leaves the tree to the reap when taskkill times out, without waiting for an exit', async () => {
    // The Windows stop, through a control whose taskkill times out, on every platform.
    const events: string[] = []
    const control: ProcessControl = {
      platform: 'win32',
      list: async () => [],
      kill: () => {},
      taskkill: () =>
        Promise.reject(
          Object.assign(new Error('taskkill did not finish within 50 ms'), { code: 'ETIMEDOUT' }),
        ),
      delay: () => Promise.resolve(),
    }
    let stderr = ''
    const agent = spawnAgent(spec({ FAKE_AGENT_IGNORE_EOF: '1' }), {
      platform: 'win32',
      env: process.env,
      cwd: process.cwd(),
      onStderr: (text) => (stderr += text),
      onEvent: (event) => events.push(event),
      timings: { eofMs: 300, termMs: 10_000 },
      control,
    })
    try {
      expect(await until(() => stderr.includes('ready'), 10_000)).toBe(true)
      const started = Date.now()
      expect(await agent.stop()).toMatchObject({ error: expect.any(String) })
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(events).toEqual(expect.arrayContaining(['taskkill', 'taskkill failed']))
    } finally {
      if (agent.pid && alive(agent.pid)) process.kill(agent.pid, 'SIGKILL')
    }
  })

  it('stops cleanly on quit while every listing hangs, leaving the agent to the next host', async () => {
    // Each listing runs a process that never answers, until its limit kills it.
    const control = processControl(process.platform, {
      limits: { listMs: 50, backgroundListMs: 50, taskkillMs: 50 },
      run: (_file, _args, timeoutMs) =>
        runTool(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], timeoutMs, {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
        }),
    })
    const t = await startTestHost({
      launcher: processLauncher(process.platform),
      agentEnv: { FAKE_AGENT_DELAY_SCALE: '0' },
      processControl: control,
    })
    try {
      const port = t.connect()
      await port.request('sessions.create', { agentId: 'fake-agent', projectPath: t.project })
      const [agent] = t.host.agents.processes()
      expect(agent).toBeDefined()
      const started = Date.now()
      await t.host.shutdown()
      // Main kills a host that has not stopped 6 s after host:shutdown.
      expect(Date.now() - started).toBeLessThan(6_000)
      expect(t.sent.at(-1)).toEqual({ type: 'host:stopped' })
      const file = path.join(t.dir, 'state', 'agent-processes.json')
      const recorded = JSON.parse(readFileSync(file, 'utf8')) as { processes: { pid: number }[] }
      expect(recorded.processes.map((entry) => entry.pid)).toContain(agent!.pid)
      const warnings = t.host.diagnostics
        .logEntries()
        .filter((entry) => entry.level === 'warn' && entry.message.includes('within 50 ms'))
      expect(warnings.length).toBeGreaterThan(0)
    } finally {
      await t.stop()
    }
  })
})

describe('what an agent leaves behind', () => {
  async function hostWith(child: 'detached' | 'nested') {
    const t = await startTestHost({
      launcher: processLauncher(process.platform),
      agentEnv: { FAKE_AGENT_DELAY_SCALE: '0', FAKE_AGENT_SPAWN_CHILD: child },
      treeNoteMs: 100,
    })
    const port = t.connect()
    const created = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
    })
    const stderr = () => t.host.diagnostics.agentRecords('fake-agent').stderr
    const pattern = child === 'nested' ? /grandchild pid (\d+)/ : /child pid (\d+)/
    expect(await until(() => pattern.test(stderr()), 10_000)).toBe(true)
    const pids = [...stderr().matchAll(/child pid (\d+)/g)].map((match) => Number(match[1]))
    expect(pids.every(alive)).toBe(true)
    const cleanUp = async () => {
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
      await t.stop()
    }
    return { t, port, sessionId: created.id, pids, cleanUp }
  }

  it('stops a child in a process group of its own when the agent stops', async () => {
    const { t, pids, cleanUp } = await hostWith('detached')
    try {
      await t.host.agents.stop('fake-agent')
      expect(await until(() => !pids.some(alive), 5_000)).toBe(true)
    } finally {
      await cleanUp()
    }
  })

  it('stops what is left under its group when the agent crashes', async () => {
    const { t, port, sessionId, pids, cleanUp } = await hostWith('nested')
    const file = path.join(t.dir, 'state', 'agent-processes.json')
    const recorded = (): number[] =>
      (JSON.parse(readFileSync(file, 'utf8')) as { processes: { pid: number }[] }).processes.map(
        (entry) => entry.pid,
      )
    try {
      expect(pids).toHaveLength(2)
      // On Windows the child ends with the agent, so only a listing taken while the agent ran
      // leads to the grandchild; the turn's traffic brings one.
      await port.request('sessions.prompt', {
        sessionId,
        content: [{ type: 'text', text: 'hello' }],
      })
      await port.untilStatus(sessionId, 'ready')
      expect(await until(() => pids.every((pid) => recorded().includes(pid)), 10_000)).toBe(true)
      await port.request('sessions.prompt', {
        sessionId,
        content: [{ type: 'text', text: '/crash' }],
      })
      await port.untilStatus(sessionId, 'closed')
      expect(await until(() => !pids.some(alive), 5_000)).toBe(true)
    } finally {
      await cleanUp()
    }
  })
})

describe('leftovers of the last run', () => {
  it('stops the agent trees a host left running, and not a process that took a pid', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'overbench-leftovers-'))
    const keep = (script: string) =>
      spawn(process.execPath, ['-e', script], {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
    // An agent left running, with a command it started in a group of its own.
    const agent = keep(
      "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); process.stdout.write(String(c.pid)); setInterval(() => {}, 1000)",
    )
    const agentStartedAt = Date.now()
    const command = await new Promise<number>((resolve) =>
      agent.stdout.once('data', (data: Buffer) => resolve(Number(String(data)))),
    )
    // Its pid is in the file with another start time: someone else's process now.
    const other = keep('setInterval(() => {}, 1000)')
    const pids = [agent.pid!, command, other.pid!]
    try {
      await mkdir(path.join(dir, 'state'), { recursive: true })
      await writeFile(
        path.join(dir, 'state', 'agent-processes.json'),
        JSON.stringify({
          version: 1,
          processes: [
            { pid: agent.pid, startedAt: agentStartedAt },
            { pid: other.pid, startedAt: agentStartedAt - 3_600_000 },
          ],
        }),
      )
      const file = path.join(dir, 'state', 'agent-processes.json')
      const t = await startTestHost({ userDataPath: dir })
      try {
        expect(await until(() => !alive(agent.pid!) && !alive(command), 8_000)).toBe(true)
        expect(alive(other.pid!)).toBe(true)
        // Forgotten once the grace for what ignored SIGTERM is over.
        expect(
          await until(() => JSON.parse(readFileSync(file, 'utf8')).processes.length === 0, 8_000),
        ).toBe(true)
      } finally {
        await t.stop()
      }
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
      await rm(dir, { recursive: true, force: true })
    }
  })
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
  it('closes its sessions, and the next send starts a new process', async () => {
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
      await port.untilStatus(created.id, 'closed')
      const exit = t.host.diagnostics
        .agentRecords('fake-agent')
        .events.find((e) => e.event === 'exit')
      expect(exit?.detail).toBe('exited with code 5')
      expect(pids().at(-1)).toEqual([])

      await port.request('sessions.prompt', {
        sessionId: created.id,
        content: [{ type: 'text', text: 'hello again' }],
      })
      await port.untilStatus(created.id, 'ready')
      const secondPid = pids().at(-1)?.[0]?.pid
      expect(secondPid).toBeGreaterThan(0)
      expect(secondPid).not.toBe(firstPid)
      expect(port.entries(created.id).at(-1)).toMatchObject({ stopReason: 'end_turn' })
    } finally {
      await t.stop()
    }
    expect(t.sent.at(-1)).toEqual({ type: 'host:stopped' })
    const last = t.sent.filter((m) => m.type === 'host:agent-processes').at(-1)
    expect(last).toEqual({ type: 'host:agent-processes', processes: [] })
  })
})
