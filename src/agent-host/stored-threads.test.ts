// Integration tests: threads stored by the session layer, read back a page at a time, and
// sessions that attach to their agent only when used.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'

let hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts) await host.stop()
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

describe('releasing', () => {
  const quick = { checkpointMs: 10, releaseHiddenMs: 60, releaseShownMs: 800, releaseUnusedMs: 60 }
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const events = (t: TestHost) =>
    t.host.diagnostics.agentRecords('fake-agent').events.map((e) => `${e.event} ${e.detail ?? ''}`)

  it('lets an idle session out of view go, and attaches it again when used', async () => {
    const { t, port } = await setup({ sessionTimings: quick })
    const sessionId = await newSession(t, port)
    await finishTurn(port, sessionId, 'hello')
    await port.request('sessions.show', { sessionId: null })
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
    await port.request('sessions.show', { sessionId: null })
    await pause(300)
    expect(port.summary(background)?.status).toBe('ready')
    expect(port.summary(waiting)?.status).toBe('awaiting_permission')
    expect(events(t).some((event) => event.startsWith('session released'))).toBe(false)
  })

  it('stops the agent once no session holds it', async () => {
    const { t, port } = await setup({ sessionTimings: quick, agentTimings: { idleMs: 50 } })
    const sessionId = await newSession(t, port)
    await finishTurn(port, sessionId, 'hello')
    await port.request('sessions.show', { sessionId: null })
    await port.untilStatus(sessionId, 'closed')
    await vi.waitFor(() => expect(events(t)).toContain('idle stop '))
  })
})
