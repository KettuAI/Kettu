// Integration tests: threads stored by the session layer, read back a page at a time, and
// sessions that attach to their agent only when used.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { TrafficRecord } from '@shared/agent-host'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import type { ThreadEntry } from '@shared/thread'
import { processLauncher } from './agents'
import { processControl, type ProcessControl } from './process-tree'
import {
  startTestHost,
  type InProcessLauncher,
  type TestHost,
  type TestPort,
} from './testing/harness'

let hosts: TestHost[] = []

afterEach(async () => {
  // A restarted host goes first: the first one removes the folder, whose database Windows
  // will not delete while the other has it open.
  for (const host of hosts.reverse()) await host.stop()
  hosts = []
})

async function setup(options: Parameters<typeof startTestHost>[0] = {}) {
  const t = await startTestHost(options)
  hosts.push(t)
  return { t, port: t.connect() }
}

/** A second host on the same data folder, as after a restart of the app. */
async function restart(first: TestHost, options: Parameters<typeof startTestHost>[0] = {}) {
  await first.host.shutdown()
  return setup({ ...options, userDataPath: first.dir })
}

async function newSession(t: TestHost, port: TestPort) {
  const summary = await port.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: t.project,
  })
  await port.open(summary.id)
  return summary.id
}

const text = (value: string) => [{ type: 'text' as const, text: value }]

async function finishTurn(port: TestPort, sessionId: string, prompt: string) {
  const ends = port.entries(sessionId).filter((entry) => entry.kind === 'turn_end').length
  await port.request('sessions.queue', { sessionId, content: text(prompt) })
  await port.until(
    () => port.entries(sessionId).filter((entry) => entry.kind === 'turn_end').length > ends,
  )
  await port.untilStatus(sessionId, 'ready')
}

async function stored(t: TestHost, sessionId: string): Promise<ThreadEntry[] | null> {
  await t.host.threads!.flush()
  const thread = await t.host.threads!.load(sessionId)
  return thread ? thread.entries.map((item) => item.entry) : null
}

/** Every entry, walking back from the snapshot one page at a time. */
async function walkBack(
  port: TestPort,
  sessionId: string,
  first: { entries: ThreadEntry[]; older: number | null },
): Promise<{ entries: ThreadEntry[]; pages: number[] }> {
  let entries = first.entries
  const pages = [first.entries.length]
  let older = first.older
  while (older !== null) {
    const page = await port.request('sessions.page', { sessionId, before: older })
    entries = [...page.entries, ...entries]
    pages.push(page.entries.length)
    older = page.older
  }
  return { entries, pages }
}

describe('checkpoints', () => {
  it('stores a turn as it runs and as it ends', async () => {
    const { t, port } = await setup({ sessionTimings: { checkpointMs: 10 } })
    const sessionId = await newSession(t, port)
    await port.request('sessions.prompt', { sessionId, content: text('/permission') })
    await port.until(() => port.summary(sessionId)?.permissionCount === 1)
    await vi.waitFor(async () => {
      const entries = await stored(t, sessionId)
      expect(entries?.find((entry) => entry.kind === 'tool')).toMatchObject({
        permission: { options: expect.any(Array) },
      })
    })

    const tool = port.entries(sessionId).find((entry) => entry.kind === 'tool')!
    if (tool.kind !== 'tool' || !tool.permission) throw new Error('No permission request')
    await port.request('permissions.respond', {
      sessionId,
      requestId: tool.permission.requestId,
      optionId: tool.permission.options[0]!.id,
    })
    await port.untilEntry(sessionId, (entry) => entry.kind === 'turn_end')
    expect(await stored(t, sessionId)).toEqual(port.entries(sessionId))
  })

  it('settles a thread stored mid-turn when it opens again', async () => {
    const { t: first, port: before } = await setup()
    const sessionId = await newSession(first, before)
    await before.request('sessions.prompt', { sessionId, content: text('/permission') })
    await before.until(() => before.summary(sessionId)?.permissionCount === 1)

    const { t, port } = await restart(first)
    const snapshot = await port.open(sessionId)
    expect(snapshot.session.status).toBe('closed')
    expect(snapshot.entries.find((entry) => entry.kind === 'tool')).toMatchObject({
      status: 'cancelled',
      permission: null,
      permissionResult: 'withdrawn',
    })
    expect(snapshot.entries.every((e) => !('streaming' in e) || e.streaming === false)).toBe(true)
    expect(t.launcher).toMatchObject({ launches: 0 })
  })

  it('removes the stored thread with the session', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await finishTurn(port, sessionId, 'hello')
    expect(await stored(t, sessionId)).not.toBeNull()
    await port.request('sessions.delete', { sessionId })
    expect(await stored(t, sessionId)).toBeNull()
  })
})

describe('a first message the app stops before it goes', () => {
  /**
   * A listing that, for the quit, lets the agent answer `session/new` and lists once the answer
   * has come: after the quit began and before the stop closes stdin.
   */
  function gatedListing(gate: string, traffic: () => TrafficRecord[]): ProcessControl {
    const control = processControl(process.platform)
    const answered = (): boolean => {
      const records = traffic()
      const asked = records.find((r) => r.direction === 'out' && r.method === 'session/new')
      if (!asked) return false
      const { id } = asked.message as { id: unknown }
      return records.some((r) => {
        const message = r.message as { id?: unknown }
        return r.direction === 'in' && message.id === id && 'result' in message
      })
    }
    return {
      ...control,
      list: async (options) => {
        if (options?.quitting) {
          await writeFile(gate, '')
          await vi.waitFor(() => expect(answered()).toBe(true), { timeout: 10_000 })
        }
        return control.list(options)
      },
    }
  }

  it('waits in the paused queue at the next launch, and the thread says so', async () => {
    const { t: first, port: before } = await setup({
      agentEnv: { FAKE_AGENT_SET_CONFIG_MS: '1000' },
    })
    const creating = before
      .request('sessions.create', {
        agentId: 'fake-agent',
        projectPath: first.project,
        options: { model: 'deep' },
        prompt: text('Fix the flaky login test'),
      })
      .catch(() => null)
    const sets = () =>
      first.host.diagnostics
        .agentRecords('fake-agent')
        .traffic.filter((r) => r.direction === 'out' && r.method === 'session/set_config_option')
    // In the index, still setting its start values.
    await vi.waitFor(() => expect(sets()).toHaveLength(1))
    const sessionId = before.events.flatMap((e) =>
      e.type === 'session.summary' ? [e.summary.id] : [],
    )[0]!
    const { port } = await restart(first)
    await creating
    const snapshot = await port.open(sessionId)
    expect(snapshot.entries).toEqual([
      expect.objectContaining({ kind: 'user', content: text('Fix the flaky login test') }),
      expect.objectContaining({
        kind: 'notice',
        title: 'The session closed before your message was sent',
      }),
    ])
    expect(snapshot.session).toMatchObject({
      status: 'closed',
      queue: [{ content: text('Fix the flaky login test') }],
      queuePaused: true,
    })
  })

  it('keeps the message when session/new answers as the quit stops the agent', async () => {
    const gates = await mkdtemp(path.join(os.tmpdir(), 'kettu-gate-'))
    onTestFinished(() => rm(gates, { recursive: true, force: true }))
    const gate = path.join(gates, 'session-new')
    const traffic = () => first.host.diagnostics.agentRecords('fake-agent').traffic
    const { t: first, port: before } = await setup({
      launcher: processLauncher(process.platform),
      processControl: gatedListing(gate, traffic),
      agentEnv: {
        FAKE_AGENT_DELAY_SCALE: '0',
        FAKE_AGENT_NEW_SESSION_GATE: gate,
        FAKE_AGENT_IGNORE_EOF: '1',
      },
    })
    const creating = before
      .request('sessions.create', {
        agentId: 'fake-agent',
        projectPath: first.project,
        options: { model: 'deep' },
        prompt: text('Fix the flaky login test'),
      })
      .catch(() => null)
    // Spawning the agent's process can take seconds on a loaded runner.
    await vi.waitFor(
      () =>
        expect(
          traffic().filter((r) => r.direction === 'out' && r.method === 'session/new'),
        ).toHaveLength(1),
      { timeout: 10_000 },
    )
    const sessionId = before.events.flatMap((e) =>
      e.type === 'session.summary' ? [e.summary.id] : [],
    )[0]!
    const { port } = await restart(first)
    await creating
    const snapshot = await port.open(sessionId)
    expect(snapshot.entries).toEqual([
      expect.objectContaining({ kind: 'user', content: text('Fix the flaky login test') }),
      expect.objectContaining({
        kind: 'notice',
        title: 'The session closed before your message was sent',
      }),
    ])
    expect(snapshot.session).toMatchObject({
      status: 'closed',
      queue: [{ content: text('Fix the flaky login test') }],
      queuePaused: true,
    })
    expect(snapshot.session.config.find((option) => option.id === 'model')?.value).toBe('deep')
  })
})

describe('pages', () => {
  async function largeSession() {
    const { t, port } = await setup({ agentEnv: { FAKE_AGENT_HISTORY_ENTRIES: '200' } })
    const imported = await port.request('sessions.import', {
      agentId: 'fake-agent',
      projectPath: t.project,
      acpSessionId: 'large-history-1',
    })
    return { t, port, sessionId: imported.id }
  }

  it('opens on the latest page and reads back to the start, from memory and from the store', async () => {
    const { t, port, sessionId } = await largeSession()
    const live = await port.open(sessionId)
    expect(live.session.status).toBe('ready')
    // 60 entries back, then on to the start of their turn: four entries a turn here.
    expect(live.entries).toHaveLength(60)
    expect(live.entries[0]).toMatchObject({ kind: 'user' })
    expect(live.older).toBe(140)
    const fromMemory = await walkBack(port, sessionId, live)
    expect(fromMemory.pages).toEqual([60, 60, 60, 20])
    const all = await stored(t, sessionId)
    expect(fromMemory.entries).toEqual(all)

    await port.request('sessions.close', { sessionId })
    const closed = await port.open(sessionId)
    expect(closed.session.status).toBe('closed')
    expect(closed.entries).toEqual(live.entries)
    expect(closed.older).toBe(140)
    const fromStore = await walkBack(port, sessionId, closed)
    expect(fromStore).toEqual(fromMemory)
  })

  it('reads a snapshot from a position, for a replica that holds older pages', async () => {
    const { port, sessionId } = await largeSession()
    await port.open(sessionId)
    const live = await port.request('sessions.snapshot', { sessionId, from: 80 })
    expect(live.entries).toHaveLength(120)
    expect(live.older).toBe(80)
    await port.request('sessions.close', { sessionId })
    const closed = await port.request('sessions.snapshot', { sessionId, from: 80 })
    expect(closed.entries).toEqual(live.entries)
    expect(closed.older).toBe(80)
    const all = await port.request('sessions.snapshot', { sessionId, from: 0 })
    expect(all.entries).toHaveLength(200)
    expect(all.older).toBeNull()
  })

  it('pins the latest plan when it lies before the page', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await finishTurn(port, sessionId, '/plan')
    await finishTurn(port, sessionId, '/tool-storm --count 80')
    const live = await port.request('sessions.snapshot', { sessionId })
    expect(live.entries[0]).toMatchObject({ kind: 'user' })
    expect(live.entries.some((entry) => entry.kind === 'plan')).toBe(false)
    expect(live.plan).toMatchObject({ kind: 'plan' })
    await port.request('sessions.close', { sessionId })
    const closed = await port.open(sessionId)
    expect(closed.plan).toEqual(live.plan)
  })
})

describe('attaching on use', () => {
  it('sends from a closed session: the message shows at once and the agent attaches', async () => {
    const { t: first, port: before } = await setup()
    const sessionId = await newSession(first, before)
    await finishTurn(before, sessionId, 'hello')
    const { t, port } = await restart(first)
    await port.open(sessionId)
    expect(t.launcher).toMatchObject({ launches: 0 })

    const { itemId } = await port.request('sessions.queue', {
      sessionId,
      content: text('and again'),
    })
    expect(itemId).toBeNull()
    await port.untilEntry(
      sessionId,
      (entry) =>
        entry.kind === 'user' &&
        entry.content[0]?.type === 'text' &&
        entry.content[0].text === 'and again',
    )
    await port.untilStatus(sessionId, 'running', 'ready')
    await port.until(
      () => port.entries(sessionId).filter((entry) => entry.kind === 'turn_end').length === 2,
    )
    await port.untilStatus(sessionId, 'ready')
    expect(t.launcher).toMatchObject({ launches: 1 })
    const ids = port.entries(sessionId).map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(await stored(t, sessionId)).toEqual(port.entries(sessionId))
  })

  it('queues the second of two prompts sent at once to a closed session', async () => {
    const { t: first, port: before } = await setup()
    const sessionId = await newSession(first, before)
    await finishTurn(before, sessionId, 'hello')
    const { port } = await restart(first)
    await port.open(sessionId)
    const [a, b] = await Promise.all([
      port.request('sessions.queue', { sessionId, content: text('first') }),
      port.request('sessions.queue', { sessionId, content: text('second') }),
    ])
    expect(a.itemId).toBeNull()
    expect(b.itemId).not.toBeNull()
    await port.until(
      () => port.entries(sessionId).filter((entry) => entry.kind === 'turn_end').length === 3,
    )
    await port.untilStatus(sessionId, 'ready')
  })

  it('ends a turn cancelled while the session attaches', async () => {
    const { t: first, port: before } = await setup()
    const sessionId = await newSession(first, before)
    await finishTurn(before, sessionId, 'hello')
    const { port } = await restart(first, { agentEnv: { FAKE_AGENT_SLOW_START_MS: '300' } })
    await port.open(sessionId)
    await port.request('sessions.queue', { sessionId, content: text('never mind') })
    expect(port.summary(sessionId)?.status).toBe('running')
    await port.request('sessions.cancel', { sessionId })
    await port.untilStatus(sessionId, 'ready')
    expect(port.entries(sessionId).at(-1)).toMatchObject({
      kind: 'turn_end',
      stopReason: 'cancelled',
    })
  })

  it('starts over a session its agent never answered and cannot resume', async () => {
    const { t: first, port: before } = await setup()
    const sessionId = await newSession(first, before)
    const acpSessionId = before.thread(sessionId).session.acpSessionId
    const { t, port } = await restart(first, { agentEnv: { FAKE_AGENT_RESUME_UNKNOWN: 'fail' } })
    const snapshot = await port.open(sessionId)
    expect(snapshot).toMatchObject({ session: { status: 'closed' }, entries: [] })

    await finishTurn(port, sessionId, 'first words')
    const renewed = port.thread(sessionId).session.acpSessionId
    expect(renewed).not.toBe(acpSessionId)
    const thread = await t.host.threads!.load(sessionId)
    expect(thread?.head.acpSessionId).toBe(renewed)
  })

  it('starts over a Codex-like session with no rollout, for a prompt or a setting', async () => {
    const agentEnv = { FAKE_AGENT_RESUME_UNKNOWN: 'no-rollout' }
    for (const use of ['prompt', 'setting', 'after a refused prompt'] as const) {
      const { t: first, port: before } = await setup()
      const sessionId = await newSession(first, before)
      if (use === 'after a refused prompt') {
        // The agent answers the first prompt with an error and nothing else.
        await before.request('sessions.prompt', { sessionId, content: text('/error --silent') })
        await before.untilEntry(sessionId, (entry) => entry.kind === 'notice')
        await before.untilStatus(sessionId, 'ready')
      }
      const acpSessionId = before.thread(sessionId).session.acpSessionId
      const { t, port } = await restart(first, { agentEnv, sessionTimings: { checkpointMs: 10 } })
      await port.open(sessionId)
      if (use === 'prompt') {
        await finishTurn(port, sessionId, 'first words')
      } else {
        await port.request('sessions.setConfigOption', {
          sessionId,
          optionId: 'thought_level',
          value: 'high',
        })
      }
      const renewed = port.thread(sessionId).session.acpSessionId
      expect(renewed).not.toBe(acpSessionId)
      expect(port.thread(sessionId).session.status).toBe('ready')
      const level = () =>
        port.thread(sessionId).session.config.find((o) => o.id === 'thought_level')?.value
      if (use !== 'prompt') await port.until(() => level() === 'high')
      await vi.waitFor(async () => {
        const thread = await t.host.threads!.load(sessionId)
        expect(thread?.head.acpSessionId).toBe(renewed)
        if (use !== 'prompt') {
          const stored = thread?.session.config.find((o) => o.id === 'thought_level')
          expect(stored?.value).toBe('high')
        }
      })
      // The thread stays as it was, the refused prompt and its notice included.
      if (use === 'after a refused prompt') {
        expect(port.entries(sessionId).map((entry) => entry.kind)).toEqual(['user', 'notice'])
      }
    }
  })

  it('fails a turn whose session cannot attach, keeping the prompt for Retry', async () => {
    const { t: first, port: before } = await setup()
    const sessionId = await newSession(first, before)
    await finishTurn(before, sessionId, 'hello')
    const { port } = await restart(first, { agentEnv: { FAKE_AGENT_RESUME_UNKNOWN: 'fail' } })
    await port.open(sessionId)
    await port.request('sessions.queue', { sessionId, content: text('still there?') })
    await port.untilStatus(sessionId, 'failed')
    expect(port.thread(sessionId).session.error?.message).toBeTruthy()
    await port.request('sessions.retry', { sessionId })
    await port.untilStatus(sessionId, 'failed')
    const users = port.entries(sessionId).filter((entry) => entry.kind === 'user')
    expect(users).toHaveLength(2)
  })

  describe('started under another configuration folder', () => {
    const shellFolder = path.join(os.tmpdir(), 'kettu-shell-claude')
    const settings = (configDir?: string): HostSettings => ({
      locale: 'en',
      agents: configDir ? { 'claude-code': { configDir } } : {},
      proxy: DEFAULT_SETTINGS.proxy,
      git: DEFAULT_SETTINGS.git,
      mcp: DEFAULT_SETTINGS.mcp,
      usage: { fromComputer: false },
      sessionTitles: true,
    })
    const message = (folder: string) =>
      `This session was started with the configuration folder ${folder}. Switch back to it in Settings › Agents to continue it.`

    async function claudeSession(first: TestHost, port: TestPort) {
      const summary = await port.request('sessions.create', {
        agentId: 'claude-code',
        projectPath: first.project,
      })
      await port.open(summary.id)
      await finishTurn(port, summary.id, 'hello')
      return summary.id
    }

    async function failedAttach(from: string | undefined, to: string | undefined) {
      const agentEnv = { CLAUDE_CONFIG_DIR: shellFolder }
      const { t: first, port: before } = await setup({
        fakeAs: ['claude-code'],
        agentEnv,
        settings: settings(from),
      })
      const sessionId = await claudeSession(first, before)
      const { port } = await restart(first, {
        fakeAs: ['claude-code'],
        agentEnv: { ...agentEnv, FAKE_AGENT_RESUME_UNKNOWN: 'fail' },
        settings: settings(to),
      })
      await port.open(sessionId)
      await port.request('sessions.queue', { sessionId, content: text('still there?') })
      await port.untilStatus(sessionId, 'failed')
      return port.thread(sessionId).session.error?.message
    }

    it('names the picked folder once the agent runs with the environment again', async () => {
      const picked = path.join(os.tmpdir(), 'kettu-picked-claude')
      expect(await failedAttach(picked, undefined)).toBe(message(picked))
    })

    it("names the environment's folder once the agent runs with a picked one", async () => {
      const picked = path.join(os.tmpdir(), 'kettu-picked-claude')
      expect(await failedAttach(undefined, picked)).toBe(message(shellFolder))
    })

    it("keeps the agent's own error while the folder is the same", async () => {
      const failure = await failedAttach(undefined, undefined)
      expect(failure).toBeTruthy()
      expect(failure).not.toContain('configuration folder')
    })
  })

  it('changes a setting of a closed session by attaching it', async () => {
    const { t: first, port: before } = await setup()
    const sessionId = await newSession(first, before)
    await finishTurn(before, sessionId, 'hello')
    const { t, port } = await restart(first)
    const snapshot = await port.open(sessionId)
    const mode = snapshot.session.config.find((option) => option.id === 'mode')!
    const other = mode.choices!.find((choice) => choice.value !== mode.value)!
    await port.request('sessions.setConfigOption', {
      sessionId,
      optionId: 'mode',
      value: other.value,
    })
    await port.until(
      () =>
        port.thread(sessionId).session.config.find((o) => o.id === 'mode')?.value === other.value,
    )
    expect(port.summary(sessionId)?.status).toBe('ready')
    expect(t.launcher).toMatchObject({ launches: 1 })
  })

  it('switches ultracode on a closed session without attaching it', async () => {
    const { t: first, port: before } = await setup()
    const sessionId = await newSession(first, before)
    await finishTurn(before, sessionId, 'hello')
    const { t, port } = await restart(first)
    await port.open(sessionId)
    await port.request('sessions.setConfigOption', {
      sessionId,
      optionId: '__ultracode',
      value: true,
    })
    await port.until(
      () =>
        port.thread(sessionId).session.config.find((o) => o.id === '__ultracode')?.value === true,
    )
    expect(port.summary(sessionId)?.status).toBe('closed')
    expect(t.launcher).toMatchObject({ launches: 0 })
  })

  it('forks a closed session once it attaches', async () => {
    const { t: first, port: before } = await setup()
    const sessionId = await newSession(first, before)
    await finishTurn(before, sessionId, 'hello')
    const { port } = await restart(first)
    const source = await port.open(sessionId)
    const fork = await port.request('sessions.fork', { sessionId })
    expect(fork.status).toBe('ready')
    expect(port.summary(sessionId)?.status).toBe('ready')
    const forked = await port.open(fork.id)
    expect(forked.entries).toEqual(source.entries)
  })
})

describe('prompt cache', () => {
  it('keeps when the cache was last used, and how long it lasts, across a restart', async () => {
    const reads: string[] = []
    const cacheTtl = async (agentId: string, projectPath: string, acpSessionId: string) => {
      reads.push(`${agentId} ${projectPath} ${acpSessionId}`)
      return 3_600_000
    }
    const { t: first, port: before } = await setup({ cacheTtl, sessionTimings: { cacheReadMs: 0 } })
    const sessionId = await newSession(first, before)
    const started = Date.now()
    await finishTurn(before, sessionId, 'hello')
    await before.until(() => before.thread(sessionId).session.usage?.cache?.ttl === 3_600_000)
    const cache = before.thread(sessionId).session.usage!.cache!
    expect(cache.lastRequestAt).toBeGreaterThanOrEqual(started)
    const acpSessionId = before.thread(sessionId).session.acpSessionId
    expect(reads).toEqual([`fake-agent ${first.project} ${acpSessionId}`])

    const { t, port } = await restart(first)
    const snapshot = await port.open(sessionId)
    expect(snapshot.session.usage?.cache).toEqual(cache)
    expect(t.launcher).toMatchObject({ launches: 0 })
  })

  it("gives the sidebar a session's cache and model, also before it opens after a restart", async () => {
    const cacheTtl = async () => 3_600_000
    const { t: first, port: before } = await setup({ cacheTtl, sessionTimings: { cacheReadMs: 0 } })
    const sessionId = await newSession(first, before)
    expect(before.summary(sessionId)?.cache).toBeNull()
    await finishTurn(before, sessionId, 'hello')
    await before.until(() => before.summary(sessionId)?.cache?.ttl === 3_600_000)
    const cache = before.thread(sessionId).session.usage!.cache!
    expect(before.summary(sessionId)).toMatchObject({ cache, model: 'balanced' })

    const { port } = await restart(first)
    const listed = await port.request('sessions.list', {})
    expect(listed.find((s) => s.id === sessionId)).toMatchObject({ cache, model: 'balanced' })
  })

  it('keeps the lifetime it knew when the transcript says nothing', async () => {
    let ttl: number | null = 300_000
    let reads = 0
    const cacheTtl = async () => {
      reads++
      return ttl
    }
    const { t, port } = await setup({ cacheTtl, sessionTimings: { cacheReadMs: 0 } })
    const sessionId = await newSession(t, port)
    await finishTurn(port, sessionId, 'hello')
    await port.until(() => port.thread(sessionId).session.usage?.cache?.ttl === 300_000)
    ttl = null
    await finishTurn(port, sessionId, 'again')
    await vi.waitFor(() => expect(reads).toBe(2))
    await t.host.threads!.flush()
    expect(port.thread(sessionId).session.usage?.cache?.ttl).toBe(300_000)
  })

  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const lastRequestAt = (port: TestPort, sessionId: string) =>
    port.thread(sessionId).session.usage?.cache?.lastRequestAt

  /** Starts `/requests` and waits until the request's usage has arrived, before the hold ends. */
  async function requested(port: TestPort, sessionId: string, flags: string) {
    await port.request('sessions.prompt', { sessionId, content: text(`/requests ${flags}`) })
    await port.until(() => lastRequestAt(port, sessionId) !== undefined)
    // Both of the request's updates, as its message starts and as it ends.
    await pause(50)
    return lastRequestAt(port, sessionId)!
  }

  it('keeps the time of the last request when a turn is cancelled after a pause', async () => {
    const { t, port } = await setup({ cacheTtl: async () => 300_000 })
    const sessionId = await newSession(t, port)
    const at = await requested(port, sessionId, '--hold 10000')
    await pause(300)
    const totals = port.thread(sessionId).session.usage?.tokens?.total ?? 0
    await port.request('sessions.cancel', { sessionId })
    await port.untilStatus(sessionId, 'ready')
    const usage = port.thread(sessionId).session.usage!
    expect(port.entries(sessionId).at(-1)).toMatchObject({ stopReason: 'cancelled' })
    // The cancelled turn's tokens still count; only the stamp stays where the request left it.
    expect(usage.tokens!.total).toBeGreaterThan(totals)
    expect(usage.cache?.lastRequestAt).toBe(at)
  })

  it('does not take the usage an agent sends after a cancel as a request', async () => {
    // As OpenCode does: one update as the turn ends, also when it was stopped.
    const { t, port } = await setup({ cacheTtl: async () => 300_000 })
    const sessionId = await newSession(t, port)
    await finishTurn(port, sessionId, '/requests --at-end')
    const at = lastRequestAt(port, sessionId)!
    const used = port.thread(sessionId).session.usage!.used
    await port.request('sessions.prompt', {
      sessionId,
      content: text('/requests --at-end --hold 10000'),
    })
    await port.untilStatus(sessionId, 'running')
    await pause(300)
    await port.request('sessions.cancel', { sessionId })
    await port.untilStatus(sessionId, 'ready')
    const usage = port.thread(sessionId).session.usage!
    expect(usage.used).toBeGreaterThan(used)
    expect(usage.cache?.lastRequestAt).toBe(at)
  })

  it("does not stamp a turn's end again once the agent reported its requests", async () => {
    const { t, port } = await setup({ cacheTtl: async () => 300_000 })
    const sessionId = await newSession(t, port)
    const at = await requested(port, sessionId, '--hold 300')
    await port.untilStatus(sessionId, 'ready')
    const session = port.thread(sessionId).session
    expect(session.updatedAt - at).toBeGreaterThanOrEqual(200)
    expect(session.usage?.cache?.lastRequestAt).toBe(at)
  })

  it('takes a request between turns, and reads the transcript once for a burst of them', async () => {
    let reads = 0
    const cacheTtl = async () => {
      reads++
      return 300_000
    }
    const { t, port } = await setup({ cacheTtl, sessionTimings: { cacheReadMs: 100 } })
    const sessionId = await newSession(t, port)
    await finishTurn(port, sessionId, '/requests --then 400')
    const turnRequest = lastRequestAt(port, sessionId)!
    await vi.waitFor(() => expect(reads).toBe(1))
    // The agent answers by itself: two requests, as the message starts and ends, then the result.
    await port.until(() => lastRequestAt(port, sessionId)! > turnRequest)
    expect(port.thread(sessionId).session.status).toBe('ready')
    await vi.waitFor(() => expect(reads).toBe(2))
    await pause(250)
    expect(reads).toBe(2)
  })
})

describe('releasing', () => {
  const quick = { checkpointMs: 10, releaseHiddenMs: 60, releaseShownMs: 800, releaseUnusedMs: 60 }
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const events = (t: TestHost) =>
    t.host.diagnostics.agentRecords('fake-agent').events.map((e) => `${e.event} ${e.detail ?? ''}`)

  it('lets an idle session out of view go, and attaches it again when used', async () => {
    const { t, port } = await setup({ sessionTimings: quick })
    const sessionId = await newSession(t, port)
    await finishTurn(port, sessionId, 'hello')
    await port.request('sessions.show', { sessionIds: [] })
    await port.untilStatus(sessionId, 'closed')
    await port.until(() => port.thread(sessionId).session.status === 'closed')
    expect(events(t)).toContain(`session released ${sessionId}`)
    expect(await stored(t, sessionId)).toEqual(port.entries(sessionId))

    await finishTurn(port, sessionId, 'and again')
    expect(port.entries(sessionId).filter((entry) => entry.kind === 'turn_end')).toHaveLength(2)
  })

  it('keeps the session in front until it has been idle there longer', async () => {
    const { t, port } = await setup({ sessionTimings: quick })
    const sessionId = await newSession(t, port)
    await finishTurn(port, sessionId, 'hello')
    await pause(300)
    expect(port.summary(sessionId)?.status).toBe('ready')
    await port.untilStatus(sessionId, 'closed')
    expect(events(t)).toContain(`session released ${sessionId}`)
  })

  it('lets a session opened only to read go soon, even in front', async () => {
    const { t, port } = await setup({ sessionTimings: quick })
    const imported = await port.request('sessions.import', {
      agentId: 'fake-agent',
      projectPath: t.project,
      acpSessionId: 'cli-refactor-router',
    })
    const snapshot = await port.open(imported.id)
    expect(snapshot.session.status).toBe('ready')
    await port.untilStatus(imported.id, 'closed')
  })

  it('keeps a session with work in the background or waiting for the user', async () => {
    const { t, port } = await setup({ sessionTimings: quick })
    const background = await newSession(t, port)
    await finishTurn(port, background, '/background')
    const waiting = await newSession(t, port)
    await port.request('sessions.prompt', { sessionId: waiting, content: text('/permission') })
    await port.until(() => port.summary(waiting)?.permissionCount === 1)
    await port.request('sessions.show', { sessionIds: [] })
    await pause(300)
    expect(port.summary(background)?.status).toBe('ready')
    expect(port.summary(waiting)?.status).toBe('awaiting_permission')
    expect(events(t).some((event) => event.startsWith('session released'))).toBe(false)
  })

  it('stops the agent once no session holds it', async () => {
    const { t, port } = await setup({ sessionTimings: quick, agentTimings: { idleMs: 50 } })
    const sessionId = await newSession(t, port)
    await finishTurn(port, sessionId, 'hello')
    await port.request('sessions.show', { sessionIds: [] })
    await port.untilStatus(sessionId, 'closed')
    await vi.waitFor(() => expect(events(t)).toContain('idle stop '))
  })
})

describe('keeping the config across an attach', () => {
  const quick = { checkpointMs: 10, releaseHiddenMs: 60, releaseShownMs: 800, releaseUnusedMs: 60 }
  const chosen = { model: 'deep', thought_level: 'high', fast: true, mode: 'code' }
  const defaults = { model: 'balanced', thought_level: 'medium', fast: false, mode: 'ask' }

  const values = (port: TestPort, sessionId: string) =>
    Object.fromEntries(
      port
        .thread(sessionId)
        .session.config.filter((o) => o.id !== '__ultracode')
        .map((o) => [o.id, o.value]),
    )

  /** The host's requests about a session, with each option's id, since the agent last closed it. */
  function requests(t: TestHost, port: TestPort, sessionId: string, sinceClose = true): string[] {
    const acpSessionId = port.thread(sessionId).session.acpSessionId
    const out = t.host.diagnostics
      .agentRecords('fake-agent')
      .traffic.filter(
        (r) =>
          r.direction === 'out' &&
          r.method !== null &&
          (r.message as { params?: { sessionId?: unknown } }).params?.sessionId === acpSessionId,
      )
    const since = sinceClose ? out.findLastIndex((r) => r.method === 'session/close') + 1 : 0
    return out.slice(since).map((r) => {
      const { configId } = (r.message as { params: { configId?: string } }).params
      return configId ? `${r.method} ${configId}` : r.method!
    })
  }

  /** A session set to `choose` that has had one turn. */
  async function chosenSession(
    t: TestHost,
    port: TestPort,
    choose: Record<string, string | boolean> = chosen,
  ) {
    const sessionId = await newSession(t, port)
    for (const [optionId, value] of Object.entries(choose)) {
      await port.request('sessions.setConfigOption', { sessionId, optionId, value })
    }
    await finishTurn(port, sessionId, 'hello')
    return sessionId
  }

  async function release(port: TestPort, sessionId: string) {
    await port.request('sessions.show', { sessionIds: [] })
    await port.untilStatus(sessionId, 'closed')
    await port.until(() => port.thread(sessionId).session.status === 'closed')
  }

  /** Stores another mode value, as an agent that no longer offers it would leave it. */
  async function storeMode(t: TestHost, sessionId: string, value: string) {
    const thread = await t.host.threads!.load(sessionId)
    if (!thread) throw new Error(`No stored thread for ${sessionId}`)
    await t.host.threads!.write(sessionId, {
      head: thread.head,
      session: {
        ...thread.session,
        config: thread.session.config.map((option) =>
          option.category === 'mode' ? { ...option, value } : option,
        ),
      },
      entries: [],
    })
  }

  const restored = ['model', 'fast', 'thought_level', 'mode'].map(
    (id) => `session/set_config_option ${id}`,
  )

  it('sets a released session values again before its next prompt runs', async () => {
    const { t, port } = await setup({
      sessionTimings: quick,
      agentEnv: { FAKE_AGENT_RESUME_CONFIG: 'reset' },
    })
    const sessionId = await chosenSession(t, port)
    // The user's latest choice for the agent's next session, which this must not overwrite.
    const other = await newSession(t, port)
    await port.request('sessions.setConfigOption', {
      sessionId: other,
      optionId: 'model',
      value: 'swift',
    })
    await release(port, sessionId)
    expect(values(port, sessionId)).toMatchObject(chosen)

    await finishTurn(port, sessionId, 'and again')
    expect(values(port, sessionId)).toMatchObject(chosen)
    expect(requests(t, port, sessionId)).toEqual(['session/resume', ...restored, 'session/prompt'])
    const [options] = await port.request('agents.options', undefined)
    expect(options?.remembered).toMatchObject({ model: 'swift' })
  })

  it('sets them again after a restart, when a setting attaches the session', async () => {
    const { t: first, port: before } = await setup()
    const sessionId = await chosenSession(first, before)
    const { port } = await restart(first)
    await port.open(sessionId)
    await port.request('sessions.setConfigOption', {
      sessionId,
      optionId: 'thought_level',
      value: 'low',
    })
    await vi.waitFor(() =>
      expect(values(port, sessionId)).toEqual({ ...chosen, thought_level: 'low' }),
    )
  })

  it('sets them again through session/load after a restart, before the prompt', async () => {
    const agentEnv = { FAKE_AGENT_WITHOUT: 'resume' }
    const { t: first, port: before } = await setup({ agentEnv })
    const sessionId = await chosenSession(first, before)
    const { t, port } = await restart(first, { agentEnv })
    await port.open(sessionId)
    await finishTurn(port, sessionId, 'and again')
    expect(values(port, sessionId)).toMatchObject(chosen)
    expect(requests(t, port, sessionId)).toEqual(['session/load', ...restored, 'session/prompt'])
  })

  it('sets a mode the agent reports as a legacy mode through session/set_mode', async () => {
    const { t, port } = await setup({
      sessionTimings: quick,
      agentEnv: { FAKE_AGENT_RESUME_CONFIG: 'reset', FAKE_AGENT_LEGACY_MODES: '1' },
    })
    const sessionId = await chosenSession(t, port, { __mode: 'plan', model: 'swift' })
    await release(port, sessionId)
    await finishTurn(port, sessionId, 'and again')
    expect(values(port, sessionId)).toMatchObject({ __mode: 'plan', model: 'swift' })
    expect(requests(t, port, sessionId)).toEqual([
      'session/resume',
      'session/set_config_option model',
      'session/set_mode',
      'session/prompt',
    ])
  })

  it('sets a mode the agent now reports as a legacy mode', async () => {
    const { t: first, port: before } = await setup()
    const sessionId = await chosenSession(first, before, { mode: 'code' })
    const { t, port } = await restart(first, { agentEnv: { FAKE_AGENT_LEGACY_MODES: '1' } })
    await port.open(sessionId)
    await finishTurn(port, sessionId, 'and again')
    expect(values(port, sessionId)).toMatchObject({ __mode: 'code' })
    expect(requests(t, port, sessionId)).toEqual([
      'session/resume',
      'session/set_mode',
      'session/prompt',
    ])
    expect(port.entries(sessionId).filter((entry) => entry.kind === 'notice')).toEqual([])
  })

  it('sets a legacy mode the agent now reports as a config option', async () => {
    const { t: first, port: before } = await setup({
      agentEnv: { FAKE_AGENT_LEGACY_MODES: '1' },
    })
    const sessionId = await chosenSession(first, before, { __mode: 'code' })
    const { t, port } = await restart(first)
    await port.open(sessionId)
    await finishTurn(port, sessionId, 'and again')
    expect(values(port, sessionId)).toMatchObject({ mode: 'code' })
    expect(requests(t, port, sessionId)).toEqual([
      'session/resume',
      'session/set_config_option mode',
      'session/prompt',
    ])
    expect(port.entries(sessionId).filter((entry) => entry.kind === 'notice')).toEqual([])
  })

  it('adds no notice when a setting attaches a session whose mode moved to legacy modes', async () => {
    const { t: first, port: before } = await setup()
    const sessionId = await chosenSession(first, before, { mode: 'code' })
    const { port } = await restart(first, { agentEnv: { FAKE_AGENT_LEGACY_MODES: '1' } })
    await port.open(sessionId)
    await port.request('sessions.setConfigOption', { sessionId, optionId: 'model', value: 'deep' })
    await port.until(() => values(port, sessionId).model === 'deep')
    expect(values(port, sessionId)).toMatchObject({ __mode: 'code', model: 'deep' })
    expect(port.entries(sessionId).filter((entry) => entry.kind === 'notice')).toEqual([])
    expect(port.thread(sessionId).session).toMatchObject({ status: 'ready', error: null })
  })

  it('keeps what the agent sends between its answer and the attach', async () => {
    const { t, port } = await setup({
      sessionTimings: quick,
      agentEnv: { FAKE_AGENT_RESUME_CONFIG: 'reset', FAKE_AGENT_SET_CONFIG_MS: '50' },
    })
    const sessionId = await chosenSession(t, port)
    await release(port, sessionId)
    const from = port.events.length
    // The fake agent announces its commands just after it answers session/resume.
    await port.request('sessions.setConfigOption', {
      sessionId,
      optionId: 'thought_level',
      value: 'low',
    })
    await port.until(
      () =>
        port.events
          .slice(from)
          .some(
            (e) =>
              e.type === 'session.patches' &&
              e.batch.sessionId === sessionId &&
              e.batch.patches.some((p) => p.op === 'session.update' && 'commands' in p.changes),
          ),
      2_000,
    )
    const acpSessionId = port.thread(sessionId).session.acpSessionId!
    const ignored = t.host.diagnostics
      .agentRecords('fake-agent')
      .events.filter((e) => e.event === 'ignored' && e.detail?.includes(acpSessionId))
    expect(ignored).toEqual([])
  })

  it('sends nothing more when the agent kept the values itself', async () => {
    const { t, port } = await setup({ sessionTimings: quick })
    const sessionId = await chosenSession(t, port)
    await release(port, sessionId)
    await finishTurn(port, sessionId, 'and again')
    expect(values(port, sessionId)).toMatchObject(chosen)
    expect(requests(t, port, sessionId)).toEqual(['session/resume', 'session/prompt'])
  })

  it('keeps the session usable, at the agent values, when the agent refuses them', async () => {
    const { t, port } = await setup({
      sessionTimings: quick,
      agentEnv: { FAKE_AGENT_RESUME_CONFIG: 'locked' },
    })
    // The mode is the agent's own, so only values that leave the prompt alone are refused.
    const kept = { model: chosen.model, thought_level: chosen.thought_level, fast: chosen.fast }
    const sessionId = await chosenSession(t, port, kept)
    await release(port, sessionId)
    await finishTurn(port, sessionId, 'and again')
    expect(port.entries(sessionId).filter((entry) => entry.kind === 'turn_end')).toHaveLength(2)
    expect(port.entries(sessionId).filter((entry) => entry.kind === 'notice')).toEqual([])
    expect(values(port, sessionId)).toEqual(defaults)
    const refused = t.host.diagnostics
      .logEntries()
      .filter((e) => e.level === 'warn' && e.message.includes(`session ${sessionId} refused`))
    expect(refused.map((e) => e.message.split(' refused ')[1]!.split(':')[0])).toEqual([
      'model = deep',
      'fast = true',
      'thought_level = high',
    ])
  })

  it("keeps the source's values for a fork the app stopped while they were set", async () => {
    const agentEnv = { FAKE_AGENT_FORK_CONFIG: 'reset', FAKE_AGENT_SET_CONFIG_MS: '200' }
    const { t: first, port: before } = await setup({ agentEnv })
    const sessionId = await chosenSession(first, before)
    const sets = () =>
      first.host.diagnostics
        .agentRecords('fake-agent')
        .traffic.filter((r) => r.direction === 'out' && r.method === 'session/set_config_option')
        .length
    const own = sets()
    void before.request('sessions.fork', { sessionId }).catch(() => {})
    await vi.waitFor(() => expect(sets()).toBeGreaterThan(own))
    const forkId = before.events.flatMap((e) =>
      e.type === 'session.summary' && e.summary.id !== sessionId ? [e.summary.id] : [],
    )[0]!

    const { port } = await restart(first, { agentEnv })
    const listed = await port.request('sessions.list', {})
    expect(listed.find((s) => s.id === forkId)?.status).toBe('closed')
    await port.open(forkId)
    expect(values(port, forkId)).toMatchObject(chosen)
  })

  describe('when the mode cannot be set again', () => {
    const notSent = 'Your message was not sent. It waits in the queue until you resume it.'

    it('holds back the prompt, keeps it in the queue and says so in the thread', async () => {
      const { t, port } = await setup({
        sessionTimings: quick,
        agentEnv: { FAKE_AGENT_RESUME_CONFIG: 'locked' },
      })
      const sessionId = await chosenSession(t, port)
      await release(port, sessionId)
      await port.request('sessions.queue', { sessionId, content: text('Delete the build folder') })
      await port.until(() => port.thread(sessionId).session.queue.length === 1)
      await port.untilStatus(sessionId, 'ready')
      expect(requests(t, port, sessionId)).not.toContain('session/prompt')
      expect(port.thread(sessionId).session).toMatchObject({
        queue: [{ content: text('Delete the build folder') }],
        queuePaused: true,
        error: { message: 'This session could not keep all of its settings' },
        turnStartedAt: null,
      })
      expect(port.summary(sessionId)?.attention).toBe('error')
      expect(port.entries(sessionId).slice(-2)).toEqual([
        expect.objectContaining({ kind: 'user', content: text('Delete the build folder') }),
        expect.objectContaining({
          kind: 'notice',
          severity: 'warning',
          title: 'This session could not keep all of its settings',
          description: [
            'Mode is Ask instead of Code.',
            'Model is Fake Balanced instead of Fake Deep.',
            'Fast mode is off instead of on.',
            'Reasoning is Medium instead of High.',
            'You can change them in the composer.',
            notSent,
          ].join('\n'),
        }),
      ])
      expect(port.entries(sessionId).filter((entry) => entry.kind === 'turn_end')).toHaveLength(1)
      expect(await stored(t, sessionId)).toEqual(port.entries(sessionId))

      // Resumed, it goes out with the agent's values, which the session now shows.
      await port.request('sessions.resumeQueue', { sessionId })
      await port.until(
        () => port.entries(sessionId).filter((entry) => entry.kind === 'turn_end').length === 2,
      )
      await port.untilStatus(sessionId, 'ready')
      expect(port.thread(sessionId).session).toMatchObject({ queue: [], error: null })
      expect(requests(t, port, sessionId).filter((r) => r === 'session/prompt')).toHaveLength(1)
    })

    it('opens the tiles of a held-back message once its copy is sent', async () => {
      const { t, port } = await setup({
        sessionTimings: quick,
        agentEnv: { FAKE_AGENT_RESUME_CONFIG: 'locked' },
      })
      const sessionId = await chosenSession(t, port)
      await release(port, sessionId)
      const added = await port.request('attachments.add', {
        source: { bytes: new Uint8Array([1, 2, 3]).buffer, mimeType: 'image/png', name: 'Image 1' },
        thumb: null,
      })
      const ref = { type: 'ref' as const, ref: { kind: 'attachment' as const, attachment: added } }
      await port.request('sessions.queue', { sessionId, content: [...text('Look'), ref] })
      await port.until(() => port.thread(sessionId).session.queue.length === 1)
      await port.untilStatus(sessionId, 'ready')
      const sentOf = (entry: ThreadEntry) =>
        entry.kind === 'user' &&
        entry.content[1]?.type === 'ref' &&
        entry.content[1].ref.kind === 'attachment'
          ? entry.content[1].ref.attachment
          : null
      const tiles = () => port.entries(sessionId).flatMap((entry) => sentOf(entry) ?? [])
      expect(tiles()).toEqual([expect.objectContaining({ id: added.id, sent: null, blob: null })])

      await port.request('sessions.resumeQueue', { sessionId })
      await port.until(() => tiles().length === 2 && tiles().every((tile) => tile.sent === 'image'))
      const [held, copy] = tiles()
      expect(held).toEqual(copy)
      await port.untilStatus(sessionId, 'ready')
      const blob = await port.request('sessions.blob', { sessionId, hash: held!.blob! })
      expect(new Uint8Array(blob.bytes)).toEqual(new Uint8Array([1, 2, 3]))
    })

    it('lets the agent go once the prompt is held back in a session out of view', async () => {
      const { t, port } = await setup({
        sessionTimings: quick,
        agentEnv: { FAKE_AGENT_RESUME_CONFIG: 'locked' },
      })
      const sessionId = await chosenSession(t, port)
      await release(port, sessionId)
      await port.request('sessions.queue', { sessionId, content: text('and again') })
      await port.until(() => port.thread(sessionId).session.queue.length === 1)
      await port.untilStatus(sessionId, 'closed')
      expect(port.thread(sessionId).session).toMatchObject({ queuePaused: true })
    })

    it('holds back the prompt when the mode the session had is not offered now', async () => {
      const { t: first, port: before } = await setup()
      const sessionId = await chosenSession(first, before, { mode: 'code' })
      const { t, port } = await restart(first, { agentEnv: { FAKE_AGENT_LEGACY_MODES: '1' } })
      await storeMode(t, sessionId, 'retired')
      await port.open(sessionId)
      await port.request('sessions.queue', { sessionId, content: text('and again') })
      await port.until(() => port.thread(sessionId).session.queue.length === 1)
      await port.untilStatus(sessionId, 'ready')
      expect(requests(t, port, sessionId)).not.toContain('session/prompt')
      expect(port.entries(sessionId).at(-1)).toMatchObject({
        kind: 'notice',
        description: [
          'This session has no Mode option, so retired is not available.',
          'You can change them in the composer.',
          notSent,
        ].join('\n'),
      })
    })

    it('says so when a setting attaches the session, with nothing to hold back', async () => {
      const { t: first, port: before } = await setup()
      const sessionId = await chosenSession(first, before, { mode: 'code' })
      const { t, port } = await restart(first, { agentEnv: { FAKE_AGENT_LEGACY_MODES: '1' } })
      await storeMode(t, sessionId, 'retired')
      await port.open(sessionId)
      await port.request('sessions.setConfigOption', {
        sessionId,
        optionId: 'model',
        value: 'deep',
      })
      await port.untilEntry(sessionId, (entry) => entry.kind === 'notice')
      expect(port.entries(sessionId).at(-1)).toMatchObject({
        kind: 'notice',
        title: 'This session could not keep all of its settings',
        description: [
          'This session has no Mode option, so retired is not available.',
          'You can change them in the composer.',
        ].join('\n'),
      })
      expect(port.thread(sessionId).session).toMatchObject({ status: 'ready', error: null })
    })
  })

  describe('while the values are set', () => {
    /** A session restored after a restart, whose agent takes 200 ms for each value. */
    async function slowAttach() {
      const { t: first, port: before } = await setup()
      const sessionId = await chosenSession(first, before)
      const { t, port } = await restart(first, { agentEnv: { FAKE_AGENT_SET_CONFIG_MS: '200' } })
      await port.open(sessionId)
      return { t, port, sessionId }
    }

    it('lets the agent go after a turn cancelled meanwhile in a session out of view', async () => {
      const { t, port } = await setup({
        sessionTimings: quick,
        agentEnv: { FAKE_AGENT_SET_CONFIG_MS: '200', FAKE_AGENT_RESUME_CONFIG: 'reset' },
      })
      const sessionId = await chosenSession(t, port)
      await release(port, sessionId)
      await port.request('sessions.queue', { sessionId, content: text('never mind') })
      await vi.waitFor(() => expect(requests(t, port, sessionId)).toContain(restored[0]))
      await port.request('sessions.cancel', { sessionId })
      await port.untilStatus(sessionId, 'ready')
      await port.untilStatus(sessionId, 'closed')
    })

    it('ends a turn cancelled meanwhile without sending it', async () => {
      const { t, port, sessionId } = await slowAttach()
      await port.request('sessions.queue', { sessionId, content: text('never mind') })
      await vi.waitFor(() => expect(requests(t, port, sessionId)).toContain(restored[0]))
      await port.request('sessions.cancel', { sessionId })
      await port.untilStatus(sessionId, 'ready')
      expect(port.entries(sessionId).at(-1)).toMatchObject({
        kind: 'turn_end',
        stopReason: 'cancelled',
      })
      // The next prompt waits for the values too, and is the only one the agent gets.
      await finishTurn(port, sessionId, 'this instead')
      expect(values(port, sessionId)).toEqual(chosen)
      expect(requests(t, port, sessionId)).toEqual([
        'session/resume',
        ...restored,
        'session/prompt',
      ])
    })

    it('fails a turn whose agent exits before it was sent, and Retry sends it', async () => {
      const { t, port, sessionId } = await slowAttach()
      await port.request('sessions.queue', { sessionId, content: text('Fix the flaky login test') })
      await vi.waitFor(() => expect(requests(t, port, sessionId)).toContain(restored[0]))
      ;(t.launcher as InProcessLauncher).crash()
      await port.untilStatus(sessionId, 'failed')
      // Nothing reached the agent, so the turn was not cut short: no line offers to resume it.
      expect(port.entries(sessionId).filter((entry) => entry.kind === 'notice')).toEqual([])

      await port.request('sessions.retry', { sessionId })
      await port.until(() => port.entries(sessionId).at(-1)?.kind === 'turn_end')
      const users = port.entries(sessionId).filter((entry) => entry.kind === 'user')
      expect(users.at(-1)).toMatchObject({ content: text('Fix the flaky login test') })
      expect(users).toHaveLength(2)
      expect(requests(t, port, sessionId)).toContain('session/prompt')
    })

    it('leaves the agent session to an attach that started after a close meanwhile', async () => {
      const { t, port, sessionId } = await slowAttach()
      await port.request('sessions.queue', { sessionId, content: text('first') })
      await vi.waitFor(() => expect(requests(t, port, sessionId)).toContain(restored[0]))
      await port.request('sessions.close', { sessionId })
      await port.request('sessions.queue', { sessionId, content: text('second') })
      await port.until(() => {
        const entries = port.entries(sessionId)
        const sent = entries.findLastIndex(
          (entry) => entry.kind === 'user' && entry.content[0]?.type === 'text',
        )
        return entries.slice(sent).some((entry) => entry.kind === 'turn_end')
      })
      await port.untilStatus(sessionId, 'ready')
      const sent = requests(t, port, sessionId, false)
      expect(sent.filter((r) => r === 'session/resume')).toHaveLength(2)
      expect(sent.slice(sent.lastIndexOf('session/resume'))).not.toContain('session/close')
      expect(sent.at(-1)).toBe('session/prompt')
      expect(port.entries(sessionId).at(-1)).toMatchObject({
        kind: 'turn_end',
        stopReason: 'end_turn',
      })
    })

    it('still closes the agent session when the session came back meanwhile without attaching', async () => {
      const { t, port, sessionId } = await slowAttach()
      await port.request('sessions.queue', { sessionId, content: text('first') })
      await vi.waitFor(() => expect(requests(t, port, sessionId)).toContain(restored[0]))
      await port.request('sessions.close', { sessionId })
      // Brings the session back from its stored thread, with nothing to send.
      await port.request('sessions.resumeQueue', { sessionId })
      await vi.waitFor(() => expect(requests(t, port, sessionId, false)).toContain('session/close'))
      expect(requests(t, port, sessionId, false)).toEqual([
        'session/resume',
        restored[0],
        'session/close',
      ])
    })

    it('stops when the session is closed meanwhile, and keeps it in the list', async () => {
      const { t, port, sessionId } = await slowAttach()
      const setting = port
        .request('sessions.setConfigOption', { sessionId, optionId: 'thought_level', value: 'low' })
        .then(
          () => null,
          (error: unknown) => error,
        )
      await vi.waitFor(() => expect(requests(t, port, sessionId)).toContain(restored[0]))
      await port.request('sessions.close', { sessionId })
      expect(await setting).toMatchObject({ code: 'busy' })
      expect(requests(t, port, sessionId, false)).toEqual([
        'session/resume',
        restored[0],
        'session/close',
      ])
      expect(port.summary(sessionId)?.status).toBe('closed')
      const listed = await port.request('sessions.list', {})
      expect(listed.map((s) => s.id)).toContain(sessionId)
    })
  })
})
