// Integration tests: the session layer, through the host and its port, against the fake agent
// running in-process.

import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { ThreadEntry, ToolEntry } from '@shared/thread'
import { forkCut } from './sessions'
import {
  startTestHost,
  type InProcessLauncher,
  type TestHost,
  type TestPort,
} from './testing/harness'
import type { LogReader } from './usage/model'

let current: TestHost | null = null

afterEach(async () => {
  await current?.stop()
  current = null
})

async function setup(options: Parameters<typeof startTestHost>[0] = {}) {
  current = await startTestHost(options)
  const port = current.connect()
  return { t: current, port }
}

async function newSession(t: TestHost, port: TestPort) {
  const summary = await port.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: t.project,
  })
  await port.open(summary.id)
  return summary.id
}

async function turn(port: TestPort, sessionId: string, text: string) {
  await port.request('sessions.prompt', { sessionId, content: [{ type: 'text', text }] })
}

function tools(port: TestPort, sessionId: string): ToolEntry[] {
  return port.entries(sessionId).filter((entry): entry is ToolEntry => entry.kind === 'tool')
}

describe('the queue', () => {
  const text = (value: string) => [{ type: 'text' as const, text: value }]
  const userTexts = (port: TestPort, sessionId: string) =>
    port
      .entries(sessionId)
      .filter((entry) => entry.kind === 'user')
      .map((entry) =>
        entry.kind === 'user' && entry.content[0]?.type === 'text' ? entry.content[0].text : '',
      )

  it('sends at once when nothing runs', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    const { itemId } = await port.request('sessions.queue', {
      sessionId,
      content: text('Fix the flaky login test'),
    })
    expect(itemId).toBeNull()
    expect(port.summary(sessionId)?.status).toBe('running')
  })

  it('holds a prompt until the running turn ends, then sends it', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/permission')
    await port.untilStatus(sessionId, 'awaiting_permission')
    const { itemId } = await port.request('sessions.queue', {
      sessionId,
      content: text('And the docs'),
    })
    expect(itemId).not.toBeNull()
    await port.until(() => port.thread(sessionId).session.queue[0]?.id === itemId)

    await port.until(() => tools(port, sessionId).some((tool) => tool.permission !== null))
    const tool = tools(port, sessionId).find((entry) => entry.permission)!
    const { requestId, options } = tool.permission!
    await port.request('permissions.respond', { sessionId, requestId, optionId: options[0]!.id })
    await port.until(() => userTexts(port, sessionId).includes('And the docs'))
    await port.until(() => port.thread(sessionId).session.queue.length === 0)
  })

  it('pauses after Stop and goes on when resumed', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/cancel')
    await port.request('sessions.queue', { sessionId, content: text('Then this') })
    await port.request('sessions.cancel', { sessionId })
    await port.untilStatus(sessionId, 'ready')
    await port.until(() => port.thread(sessionId).session.queuePaused)
    expect(port.thread(sessionId).session.queue).toHaveLength(1)

    await port.request('sessions.resumeQueue', { sessionId })
    await port.until(() => userTexts(port, sessionId).at(-1) === 'Then this')
    expect(port.summary(sessionId)?.status).toBe('running')
    expect(port.thread(sessionId).session).toMatchObject({ queue: [], queuePaused: false })
  })

  it('sends at once beside a paused queue', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/cancel')
    await port.request('sessions.queue', { sessionId, content: text('Later') })
    await port.request('sessions.cancel', { sessionId })
    await port.untilStatus(sessionId, 'ready')
    const { itemId } = await port.request('sessions.queue', { sessionId, content: text('Now') })
    expect(itemId).toBeNull()
    await port.until(() => userTexts(port, sessionId).at(-1) === 'Now')
    expect(port.thread(sessionId).session.queue).toHaveLength(1)
  })

  it('removes a queued prompt', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/cancel')
    const { itemId } = await port.request('sessions.queue', { sessionId, content: text('No') })
    await port.request('sessions.unqueue', { sessionId, itemId: itemId! })
    await port.until(() => port.thread(sessionId).session.queue.length === 0)
    await expect(
      port.request('sessions.unqueue', { sessionId, itemId: itemId! }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('steers a queued prompt into the running turn', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/cancel')
    const { itemId } = await port.request('sessions.queue', {
      sessionId,
      content: text('Use the new clock'),
    })
    await port.request('sessions.steer', { sessionId, itemId: itemId! })
    await port.untilEntry(sessionId, (entry) => entry.kind === 'user' && !!entry.steered)
    expect(port.entries(sessionId).find((e) => e.kind === 'user' && e.steered)).toMatchObject({
      content: text('Use the new clock'),
    })
    expect(port.thread(sessionId).session.queue).toEqual([])
    await port.untilEntry(
      sessionId,
      (entry) =>
        entry.kind === 'agent' && entry.markdown.includes('Noted mid-turn: Use the new clock'),
    )
    expect(port.summary(sessionId)?.status).toBe('running')
  })
})

describe('ultracode', () => {
  const sent = async (port: TestPort, method: string) => {
    const bundle = await port.request('diagnostics.collect', undefined)
    const fake = bundle.agents.find((agent) => agent.status.id === 'fake-agent')!
    return fake.traffic
      .filter((r) => r.direction === 'out' && r.method === method)
      .map((r) => (r.message as { params: { _meta?: unknown } }).params._meta)
  }

  it('is a switch that leaves the agent its own setting until it is used', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    expect(port.thread(sessionId).session.config.at(-1)).toMatchObject({
      id: '__ultracode',
      type: 'boolean',
      value: false,
      idleOnly: true,
    })
    expect(await sent(port, 'session/new')).toEqual([undefined])
  })

  it('restarts the session with the new setting between turns', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await port.request('sessions.setConfigOption', {
      sessionId,
      optionId: '__ultracode',
      value: true,
    })
    await port.until(
      () =>
        port.thread(sessionId).session.config.find((o) => o.id === '__ultracode')?.value === true,
    )
    expect(port.summary(sessionId)?.status).toBe('ready')
    expect(await sent(port, 'session/resume')).toEqual([
      { claudeCode: { options: { settings: { ultracode: true } } } },
    ])
  })

  it('waits for the running turn', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/cancel')
    await expect(
      port.request('sessions.setConfigOption', {
        sessionId,
        optionId: '__ultracode',
        value: true,
      }),
    ).rejects.toMatchObject({ code: 'busy' })
  })
})

describe('starting with chosen options', () => {
  const value = (port: TestPort, sessionId: string, id: string) =>
    port.thread(sessionId).session.config.find((o) => o.id === id)?.value

  it('sets the chosen values before the session is ready, and remembers the model', async () => {
    const { t, port } = await setup()
    const summary = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
      options: { thought_level: 'high', mode: 'code', model: 'deep', __ultracode: true },
    })
    expect(summary.status).toBe('ready')
    await port.open(summary.id)
    expect(value(port, summary.id, 'model')).toBe('deep')
    expect(value(port, summary.id, 'thought_level')).toBe('high')
    expect(value(port, summary.id, 'mode')).toBe('code')
    expect(value(port, summary.id, '__ultracode')).toBe(true)
    const [options] = await port.request('agents.options', undefined)
    expect(options).toMatchObject({
      agentId: 'fake-agent',
      remembered: { model: 'deep', thought_level: 'high' },
    })
    // The agent's own defaults stay as they were, so the next session starts from them.
    expect(options?.config.find((o) => o.id === 'model')?.value).toBe('balanced')
    expect(Object.keys(options?.levels ?? {})).toEqual(['balanced', 'deep'])
  })

  it('keeps the agent value for an option the session does not offer', async () => {
    const { t, port } = await setup()
    const summary = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
      options: { model: 'retired', unknown: true },
    })
    expect(summary.status).toBe('ready')
    await port.open(summary.id)
    expect(value(port, summary.id, 'model')).toBe('balanced')
  })

  it("remembers a model chosen in a session for the agent's next one", async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await port.request('sessions.setConfigOption', { sessionId, optionId: 'model', value: 'swift' })
    await port.request('sessions.setConfigOption', { sessionId, optionId: 'mode', value: 'plan' })
    const [options] = await port.request('agents.options', undefined)
    expect(options?.remembered).toEqual({ model: 'swift' })
  })
})

describe('options before a session exists', () => {
  const sent = (t: TestHost, method: string) =>
    t.host.diagnostics
      .agentRecords('fake-agent')
      .traffic.filter((r) => r.direction === 'out' && r.method === method).length
  // The sessions the fake agent itself still lists in the folder hidden sessions run in.
  const leftovers = async (t: TestHost, port: TestPort) =>
    (
      await port.request('agents.listSessions', {
        agentId: 'fake-agent',
        projectPath: path.join(t.dir, 'agent-reports'),
      })
    ).sessions.filter((s) => s.acpSessionId.startsWith('fake-'))

  it('reads the models when the agent starts, in a session left in no list', async () => {
    const { t, port } = await setup()
    expect(await port.request('agents.options', undefined)).toEqual([])
    await port.request('agents.start', { agentId: 'fake-agent' })
    const [options] = await port.request('agents.options', undefined)
    expect(options?.config.find((o) => o.id === 'model')?.value).toBe('balanced')
    expect(options?.config.at(-1)?.id).toBe('__ultracode')
    expect(port.events.some((e) => e.type === 'agent.options')).toBe(true)
    expect(sent(t, 'session/delete')).toBeGreaterThan(0)
    expect(await leftovers(t, port)).toEqual([])
    expect(await port.request('sessions.list', {})).toHaveLength(0)
  })

  it('opens no session to read them once they are known', async () => {
    const { t, port } = await setup()
    await port.request('agents.start', { agentId: 'fake-agent' })
    await port.request('agents.start', { agentId: 'fake-agent' })
    expect(sent(t, 'session/new')).toBe(1)
  })

  it('keeps the options of the plan limits report', async () => {
    const { t, port } = await setup()
    await port.request('agents.refreshLimits', { agentId: 'fake-agent' })
    await port.request('agents.start', { agentId: 'fake-agent' })
    const [options] = await port.request('agents.options', undefined)
    expect(options?.config.find((o) => o.id === 'model')?.value).toBe('balanced')
    expect(sent(t, 'session/new')).toBe(1)
  })

  it("shows a loaded session's model as provisional, and still reads the defaults", async () => {
    const { t, port } = await setup()
    const imported = await port.request('sessions.import', {
      agentId: 'fake-agent',
      projectPath: t.project,
      acpSessionId: 'cli-refactor-router',
    })
    await port.open(imported.id)
    const [opened] = await port.request('agents.options', undefined)
    expect(opened).toMatchObject({ provisional: true })
    expect(opened?.config.find((o) => o.id === 'model')?.value).toBe('balanced')
    expect(opened?.config.some((o) => o.category === 'mode')).toBe(false)
    expect(opened?.config.some((o) => o.id === '__ultracode')).toBe(false)
    await port.request('agents.start', { agentId: 'fake-agent' })
    expect(sent(t, 'session/new')).toBe(1)
    const [options] = await port.request('agents.options', undefined)
    expect(options?.provisional).toBeUndefined()
    expect(options?.config.some((o) => o.category === 'mode')).toBe(true)
  })

  it('opens one hidden session when the limits report and the read run together', async () => {
    const { t, port } = await setup()
    await Promise.all([
      port.request('agents.refreshLimits', { agentId: 'fake-agent' }),
      port.request('agents.start', { agentId: 'fake-agent' }),
    ])
    expect(sent(t, 'session/new')).toBe(1)
    expect(await port.request('agents.options', undefined)).toHaveLength(1)
  })

  it('starts the agent without options when it must sign in first', async () => {
    const { t, port } = await setup({ agentEnv: { FAKE_AGENT_AUTH: 'required' } })
    await port.request('agents.start', { agentId: 'fake-agent' })
    expect(await port.request('agents.options', undefined)).toEqual([])
    const statuses = await port.request('agents.list', undefined)
    expect(statuses.find((s) => s.id === 'fake-agent')?.signIn).toBe('required')
    expect(await leftovers(t, port)).toEqual([])
  })

  it('starts the agent without options when they do not come in time', async () => {
    const { t, port } = await setup({
      agentEnv: { FAKE_AGENT_NEW_SESSION_MS: '300' },
      agentTimings: { optionsMs: 20 },
    })
    await port.request('agents.start', { agentId: 'fake-agent' })
    expect(await port.request('agents.options', undefined)).toEqual([])
    // The late answer opens a session, which goes once it comes.
    const deadline = Date.now() + 5_000
    while (sent(t, 'session/delete') === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(await leftovers(t, port)).toEqual([])
    await port.request('agents.start', { agentId: 'fake-agent' })
    expect(sent(t, 'session/new')).toBe(1)
  })
})

describe('forking', () => {
  it('starts a new session from the history, shown with its entries', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, 'Fix the flaky login test')
    await port.untilEntry(sessionId, (entry) => entry.kind === 'turn_end')
    await port.untilStatus(sessionId, 'ready')

    const fork = await port.request('sessions.fork', { sessionId })
    expect(fork).toMatchObject({
      projectPath: t.project,
      status: 'ready',
      title: 'Fix the flaky login test',
      origin: 'user',
    })
    expect(fork.id).not.toBe(sessionId)
    await port.open(fork.id)
    expect(port.entries(fork.id)).toEqual(port.entries(sessionId))

    await turn(port, fork.id, 'Fix the flaky login test')
    await port.until(
      () => port.entries(fork.id).filter((entry) => entry.kind === 'turn_end').length === 2,
    )
    const ids = port.entries(fork.id).map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(port.entries(sessionId).filter((entry) => entry.kind === 'turn_end')).toHaveLength(1)
  })

  it('refuses while a turn runs', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/cancel')
    await expect(port.request('sessions.fork', { sessionId })).rejects.toMatchObject({
      code: 'busy',
    })
  })

  async function finishTurn(port: TestPort, sessionId: string, text: string) {
    const ends = () => port.entries(sessionId).filter((entry) => entry.kind === 'turn_end').length
    const before = ends()
    await turn(port, sessionId, text)
    await port.until(() => ends() > before)
    await port.untilStatus(sessionId, 'ready')
  }

  /** The entries of each turn, from its user message to the next. */
  function turnsOf(entries: ThreadEntry[]): ThreadEntry[][] {
    const starts = entries.flatMap((entry, i) => (entry.kind === 'user' ? [i] : []))
    return starts.map((start, n) => entries.slice(start, starts[n + 1]))
  }

  const last = (reply: ThreadEntry[]) =>
    reply.findLast((entry) => entry.kind === 'agent') as Extract<ThreadEntry, { kind: 'agent' }>

  it('forks from an earlier reply, up to it in the thread and in the agent', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    for (const text of ['First question', 'Second question', 'Third question']) {
      await finishTurn(port, sessionId, text)
    }
    const source = port.entries(sessionId)
    const turns = turnsOf(source)
    // Every reply ends with the same message, so the agent tells them apart by their place.
    expect(last(turns[0]!).markdown).toBe(last(turns[1]!).markdown)

    for (const [n, said] of [
      [1, 'First question'],
      [2, 'Second question'],
    ] as const) {
      const fork = await port.request('sessions.fork', {
        sessionId,
        entryId: last(turns[n - 1]!).id,
      })
      await port.open(fork.id)
      expect(port.entries(fork.id)).toEqual(turns.slice(0, n).flat())
      expect(port.thread(fork.id).session.usage).toBeNull()
      await finishTurn(port, fork.id, '/recall')
      expect(port.entries(fork.id).at(-2)).toMatchObject({
        kind: 'agent',
        markdown: `Your last message was: ${said}`,
      })
    }
    expect(port.entries(sessionId)).toEqual(source)
  })

  it('forks the whole session from the latest reply', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await finishTurn(port, sessionId, 'First question')
    await finishTurn(port, sessionId, 'Second question')
    const source = port.entries(sessionId)
    const reply = source.findLast((entry) => entry.kind === 'agent')!
    const fork = await port.request('sessions.fork', { sessionId, entryId: reply.id })
    await port.open(fork.id)
    expect(port.entries(fork.id)).toEqual(source)
    expect(port.thread(fork.id).session.usage).toEqual(port.thread(sessionId).session.usage)
  })

  it('refuses to fork at an entry that is not a reply', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await finishTurn(port, sessionId, 'First question')
    await finishTurn(port, sessionId, 'Second question')
    const [first] = turnsOf(port.entries(sessionId))
    const notLast = first!.find((entry) => entry.kind === 'agent')!
    expect(notLast).not.toBe(last(first!))
    for (const entryId of [first![0]!.id, notLast.id, 'm:missing']) {
      await expect(port.request('sessions.fork', { sessionId, entryId })).rejects.toMatchObject({
        code: 'invalid_params',
      })
    }
  })

  it('forks only the latest reply of an agent that cannot fork at a message', async () => {
    const { t, port } = await setup({ agentEnv: { FAKE_AGENT_NAME: 'whole-fork-agent' } })
    const sessionId = await newSession(t, port)
    await finishTurn(port, sessionId, 'First question')
    await finishTurn(port, sessionId, 'Second question')
    const [first, second] = turnsOf(port.entries(sessionId)).map(last)
    await expect(
      port.request('sessions.fork', { sessionId, entryId: first!.id }),
    ).rejects.toMatchObject({ code: 'agent_unavailable' })
    const fork = await port.request('sessions.fork', { sessionId, entryId: second!.id })
    await port.open(fork.id)
    expect(port.entries(fork.id)).toEqual(port.entries(sessionId))
  })

  it('forks a closed session from an earlier reply once it attaches', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await finishTurn(port, sessionId, 'First question')
    await finishTurn(port, sessionId, 'Second question')
    const [first] = turnsOf(port.entries(sessionId))
    await port.request('sessions.close', { sessionId })
    const fork = await port.request('sessions.fork', { sessionId, entryId: last(first!).id })
    await port.open(fork.id)
    expect(port.entries(fork.id)).toEqual(first)
  })

  it('gives way to a turn that starts while a closed session attaches to fork', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await finishTurn(port, sessionId, 'First question')
    await port.request('sessions.close', { sessionId })
    const fork = port.request('sessions.fork', { sessionId })
    await turn(port, sessionId, 'Second question')
    await expect(fork).rejects.toMatchObject({ code: 'busy' })
    expect(await port.request('sessions.list', {})).toHaveLength(1)
  })
})

describe('forking with the source config', () => {
  const chosen = { model: 'deep', thought_level: 'high', fast: true, mode: 'code' }

  const values = (port: TestPort, sessionId: string) =>
    Object.fromEntries(
      port
        .thread(sessionId)
        .session.config.filter((o) => o.id !== '__ultracode')
        .map((o) => [o.id, o.value]),
    )

  /** A source session on non-default values that has had one turn, and its fork, opened. */
  async function forked(
    agentEnv: Record<string, string>,
    beforeFork: (t: TestHost, port: TestPort) => Promise<void> = async () => {},
    choose: Record<string, string | boolean> = chosen,
  ) {
    const { t, port } = await setup({ agentEnv })
    const sessionId = await newSession(t, port)
    for (const [optionId, value] of Object.entries(choose)) {
      await port.request('sessions.setConfigOption', { sessionId, optionId, value })
    }
    await turn(port, sessionId, 'Fix the flaky login test')
    await port.untilEntry(sessionId, (entry) => entry.kind === 'turn_end')
    await port.untilStatus(sessionId, 'ready')
    await beforeFork(t, port)
    const fork = await port.request('sessions.fork', { sessionId })
    await port.open(fork.id)
    return { t, port, sessionId, forkId: fork.id }
  }

  /** The config requests the agent got for a session, by the method that carried them. */
  function settings(t: TestHost, port: TestPort, sessionId: string) {
    const acpSessionId = port.thread(sessionId).session.acpSessionId
    return t.host.diagnostics
      .agentRecords('fake-agent')
      .traffic.filter(
        (r) =>
          r.direction === 'out' &&
          (r.method === 'session/set_config_option' || r.method === 'session/set_mode') &&
          (r.message as { params: { sessionId: string } }).params.sessionId === acpSessionId,
      )
  }

  const configIds = (t: TestHost, port: TestPort, sessionId: string) =>
    settings(t, port, sessionId).map(
      (r) => (r.message as { params: { configId: string } }).params.configId,
    )

  it('sets the source values on a fork that starts at the agent defaults', async () => {
    const { t, port, sessionId, forkId } = await forked(
      { FAKE_AGENT_FORK_CONFIG: 'reset' },
      async (t, port) => {
        // The user's latest choice for the agent, which a fork must not overwrite.
        const other = await newSession(t, port)
        await port.request('sessions.setConfigOption', {
          sessionId: other,
          optionId: 'model',
          value: 'swift',
        })
      },
    )
    expect(values(port, forkId)).toEqual(values(port, sessionId))
    expect(values(port, forkId)).toMatchObject(chosen)
    // The agent lists the level only once the model is set, so the level goes last.
    expect(configIds(t, port, forkId)).toEqual(['model', 'fast', 'mode', 'thought_level'])
    // The fork's values are the source's, not a choice of the user's.
    const [options] = await port.request('agents.options', undefined)
    expect(options?.remembered).toMatchObject({ model: 'swift' })
  })

  it('sets a mode the agent reports as a legacy mode through session/set_mode', async () => {
    const { t, port, sessionId, forkId } = await forked(
      { FAKE_AGENT_FORK_CONFIG: 'reset', FAKE_AGENT_LEGACY_MODES: '1' },
      undefined,
      { __mode: 'plan', model: 'swift' },
    )
    expect(values(port, forkId)).toEqual(values(port, sessionId))
    expect(values(port, forkId)).toMatchObject({ __mode: 'plan', model: 'swift' })
    expect(settings(t, port, forkId).map((r) => r.method)).toEqual([
      'session/set_config_option',
      'session/set_mode',
    ])
  })

  it('sends nothing when the fork already has the source values', async () => {
    const { t, port, sessionId, forkId } = await forked({})
    expect(values(port, forkId)).toEqual(values(port, sessionId))
    expect(values(port, forkId)).toMatchObject(chosen)
    expect(settings(t, port, forkId)).toEqual([])
  })

  it('keeps the fork usable, at its own values, when the agent refuses them', async () => {
    const { t, port, forkId } = await forked({ FAKE_AGENT_FORK_CONFIG: 'locked' })
    expect(values(port, forkId)).toMatchObject({
      model: 'balanced',
      thought_level: 'medium',
      fast: false,
      mode: 'ask',
    })
    expect(
      t.host.diagnostics.logEntries().filter((e) => e.message.includes('refused model = deep')),
    ).toHaveLength(1)
    await turn(port, forkId, 'Fix the flaky login test')
    await port.until(
      () => port.entries(forkId).filter((entry) => entry.kind === 'turn_end').length === 2,
    )
  })

  describe('when a value cannot be kept', () => {
    const notices = (port: TestPort, sessionId: string) =>
      port.entries(sessionId).filter((entry) => entry.kind === 'notice')

    it('names the refused mode in one notice in the fork', async () => {
      const { port, forkId } = await forked({ FAKE_AGENT_FORK_CONFIG: 'locked' }, undefined, {
        mode: 'code',
      })
      expect(values(port, forkId)).toMatchObject({ mode: 'ask' })
      expect(notices(port, forkId)).toEqual([
        {
          kind: 'notice',
          id: expect.any(String),
          severity: 'warning',
          title: 'This fork could not keep all of its settings',
          description: 'Mode is Ask instead of Code.\nYou can change them in the composer.',
        },
      ])
    })

    it('lists the mode first, then the model, the level and the rest', async () => {
      const { port, forkId } = await forked({ FAKE_AGENT_FORK_CONFIG: 'locked' })
      const [notice] = notices(port, forkId)
      expect(notice).toMatchObject({
        description: [
          'Mode is Ask instead of Code.',
          'Model is Fake Balanced instead of Fake Deep.',
          'Fast mode is off instead of on.',
          'Reasoning is Medium instead of High.',
          'You can change them in the composer.',
        ].join('\n'),
      })
    })

    it.each([['keep'], ['reset']])(
      'says nothing when the fork has every value (%s)',
      async (mode) => {
        const { port, forkId } = await forked({ FAKE_AGENT_FORK_CONFIG: mode })
        expect(values(port, forkId)).toMatchObject(chosen)
        expect(notices(port, forkId)).toEqual([])
      },
    )

    it('keeps the notice with the thread across a restart of the host', async () => {
      const first = await startTestHost({ agentEnv: { FAKE_AGENT_FORK_CONFIG: 'locked' } })
      let port = first.connect()
      const sessionId = await newSession(first, port)
      await port.request('sessions.setConfigOption', { sessionId, optionId: 'mode', value: 'code' })
      const fork = await port.request('sessions.fork', { sessionId })
      await port.open(fork.id)
      expect(notices(port, fork.id)).toHaveLength(1)
      await first.host.shutdown()

      current = await startTestHost({ userDataPath: first.dir })
      port = current.connect()
      const snapshot = await port.open(fork.id)
      expect(snapshot.session.status).toBe('closed')
      expect(snapshot.entries.filter((entry) => entry.kind === 'notice')).toMatchObject([
        {
          severity: 'warning',
          description: expect.stringContaining('Mode is Ask instead of Code.'),
        },
      ])
    })
  })

  it('sends the model again to bring up a level the fork lists only after it', async () => {
    const { t, port, sessionId, forkId } = await forked(
      { FAKE_AGENT_FORK_CONFIG: 'reset' },
      undefined,
      { thought_level: 'high' },
    )
    expect(values(port, forkId)).toEqual(values(port, sessionId))
    expect(values(port, forkId)).toMatchObject({ model: 'balanced', thought_level: 'high' })
    expect(configIds(t, port, forkId)).toEqual(['model', 'thought_level'])
  })

  describe('while the values are set', () => {
    /** A fork whose agent takes 200 ms for each value, reported while it is still `starting`. */
    async function forkInFlight() {
      const { t, port } = await setup({
        agentEnv: { FAKE_AGENT_FORK_CONFIG: 'reset', FAKE_AGENT_SET_CONFIG_MS: '200' },
      })
      const sessionId = await newSession(t, port)
      for (const optionId of ['model', 'thought_level']) {
        const value = optionId === 'model' ? 'deep' : 'high'
        await port.request('sessions.setConfigOption', { sessionId, optionId, value })
      }
      const outcome = port.request('sessions.fork', { sessionId }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      const reported = () =>
        port.events.flatMap((e) =>
          e.type === 'session.summary' && e.summary.id !== sessionId ? [e.summary] : [],
        )
      await port.until(() => reported().length > 0)
      return { t, port, sessionId, forkId: reported()[0]!.id, reported, outcome }
    }

    it('shows the fork as starting until the last value is set', async () => {
      const { reported, outcome } = await forkInFlight()
      expect(reported().map((s) => s.status)).toEqual(['starting'])
      expect(await outcome).toMatchObject({ value: { status: 'ready' } })
      const statuses = reported().map((s) => s.status)
      expect(statuses.at(-1)).toBe('ready')
      expect(statuses.indexOf('ready')).toBe(statuses.length - 1)
    })

    it('ends the fork when it is deleted meanwhile', async () => {
      const { port, forkId, outcome } = await forkInFlight()
      await port.request('sessions.delete', { sessionId: forkId })
      expect(await outcome).toMatchObject({ error: { code: 'not_found' } })
      const listed = await port.request('sessions.list', {})
      expect(listed.map((s) => s.id)).not.toContain(forkId)
    })

    it('ends the fork when its project is removed meanwhile', async () => {
      const { t, port, outcome } = await forkInFlight()
      await port.request('projects.remove', { path: t.project })
      expect(await outcome).toMatchObject({ error: { code: 'not_found' } })
      expect(await port.request('sessions.list', {})).toEqual([])
    })

    it('stores the fork closed when the agent exits meanwhile', async () => {
      const { t, port, forkId, outcome } = await forkInFlight()
      ;(t.launcher as InProcessLauncher).crash()
      expect(await outcome).toMatchObject({ value: { id: forkId, status: 'closed' } })
      const listed = await port.request('sessions.list', {})
      expect(listed.find((s) => s.id === forkId)?.status).toBe('closed')
      await port.open(forkId)
      // Its values were not refused, only not set yet, so the thread says nothing.
      expect(port.entries(forkId).filter((entry) => entry.kind === 'notice')).toEqual([])
    })
  })
})

describe('forkCut', () => {
  const agent = (id: string): ThreadEntry => ({
    kind: 'agent',
    id,
    markdown: 'Done',
    attachments: [],
    streaming: false,
  })
  const entries: ThreadEntry[] = [
    { kind: 'user', id: 'e:1', content: [] },
    agent('m:a'),
    { kind: 'user', id: 'e:2', content: [], steered: true },
    { kind: 'turn_end', id: 'e:3', stopReason: 'cancelled', durationMs: 1 },
    { kind: 'user', id: 'e:4', content: [] },
    agent('m:b'),
  ]
  const thread = {
    order: entries.map((e) => e.id),
    byId: Object.fromEntries(entries.map((e) => [e.id, e])),
  }

  it('cuts past a message steered into the turn, at the next turn', () => {
    expect(forkCut(thread, 'm:a')).toEqual({
      entries: entries.slice(0, 4),
      point: { messageId: 'a', text: 'Done', occurrence: 1 },
    })
    expect(forkCut(thread, 'm:b')).toBeNull()
  })
})

describe('reports', () => {
  it('breaks the context down in a fork that leaves the session and the list as they were', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, 'Fix the flaky login test')
    await port.untilStatus(sessionId, 'ready')
    const before = port.entries(sessionId)
    const listed = async () =>
      (await port.request('agents.listSessions', { agentId: 'fake-agent', projectPath: t.project }))
        .sessions.length

    const sessionsBefore = await listed()
    const breakdown = await port.request('sessions.context', { sessionId })
    expect(breakdown).toMatchObject({ model: 'fake-model', size: 200_000 })
    expect(breakdown?.categories.map((category) => category.name)).toContain('Messages')
    expect(breakdown?.lists.map((list) => list.name)).toEqual(['MCP Tools', 'Memory Files'])
    expect(port.entries(sessionId)).toEqual(before)
    expect(await port.request('sessions.list', {})).toHaveLength(1)
    expect(await listed()).toBe(sessionsBefore)
  })

  it('reads every plan limit from /usage, at most once a minute', async () => {
    const { port } = await setup()
    const limits = () =>
      port.events
        .flatMap((event) =>
          event.type === 'agent.status' && event.status.id === 'fake-agent'
            ? [event.status.limits]
            : [],
        )
        .at(-1) ?? []

    await port.request('agents.refreshLimits', { agentId: 'fake-agent' })
    expect(limits()).toEqual([
      expect.objectContaining({ window: 'five_hour', label: '5-hour', usedPercent: 19 }),
      expect.objectContaining({ window: 'seven_day', label: 'Weekly', usedPercent: 32 }),
      expect.objectContaining({ window: 'seven_day_fake', label: 'Weekly · Fake', usedPercent: 7 }),
    ])
    const observed = limits()[0]?.observedAt
    await port.request('agents.refreshLimits', { agentId: 'fake-agent' })
    expect(limits()[0]?.observedAt).toBe(observed)
    expect(await port.request('sessions.list', {})).toHaveLength(0)
  })
})

describe('a prompt turn', () => {
  it("adds each turn's tokens to the session's totals", async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    const turnEnds = () => port.entries(sessionId).filter((e) => e.kind === 'turn_end').length
    for (const [index, text] of ['Fix the flaky login test', 'And the docs'].entries()) {
      await turn(port, sessionId, text)
      await port.until(() => turnEnds() === index + 1)
      await port.untilStatus(sessionId, 'ready')
    }
    expect(port.thread(sessionId).session.usage?.tokens).toEqual({
      total: 6640,
      input: 1800,
      output: 840,
      thought: 160,
      cacheRead: 3600,
      cacheWrite: 400,
    })
  })

  it('notes the context at the start of a running turn, for what the turn adds', async () => {
    const { t, port } = await setup({ agentEnv: { FAKE_AGENT_DELAY_SCALE: '0.05' } })
    const sessionId = await newSession(t, port)
    const view = () => port.thread(sessionId).session
    await turn(port, sessionId, '/cancel')
    // Nothing reported the context before the first turn.
    expect(view()).toMatchObject({ status: 'running', turnStartUsed: null })
    await port.request('sessions.cancel', { sessionId })
    await port.untilStatus(sessionId, 'ready')
    await turn(port, sessionId, 'Fix the flaky login test')
    await port.untilStatus(sessionId, 'ready')
    const used = view().usage!.used
    expect(used).toBeGreaterThan(0)

    await turn(port, sessionId, '/cancel')
    expect(view()).toMatchObject({ status: 'running', turnStartUsed: used })
    await port.request('sessions.cancel', { sessionId })
    await port.untilStatus(sessionId, 'ready')
    expect(view()).toMatchObject({ turnStartedAt: null, turnStartUsed: null })
  })

  it("records each turn's usage per model", async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, 'Fix the flaky login test')
    await port.untilEntry(sessionId, (entry) => entry.kind === 'turn_end')
    await port.untilStatus(sessionId, 'ready')
    const turnEnd = port.entries(sessionId).find((entry) => entry.kind === 'turn_end')!
    const day = (at: number) => new Date(at).setHours(0, 0, 0, 0)
    const today = day(Date.now())
    // As the page does: read again once the host says the figures changed.
    await port.until(() => port.events.some((event) => event.type === 'usage.changed'))
    const summary = await port.request('usage.summary', {
      dayStarts: [today, today + 86_400_000],
      from: today,
      to: today + 86_400_000,
      scope: 'overbench',
    })
    expect(summary.days).toEqual([
      {
        day: 0,
        agentId: 'fake-agent',
        input: 900,
        output: 420,
        reasoning: 0,
        cacheRead: 1200,
        cacheWrite: 200,
      },
    ])
    expect(summary.projects).toEqual([
      expect.objectContaining({ agentId: 'fake-agent', project: t.project, output: 420 }),
    ])
    expect(summary.sources['fake-agent']).toBe('overbench')
    expect(summary.first).toBeGreaterThanOrEqual(today)
    expect(summary.agents).toEqual(['fake-agent'])
    expect(turnEnd.id).toMatch(/^e:/)
    const status = await port.request('usage.status', undefined)
    expect(status).toMatchObject({ fromComputer: false, scanning: null, unavailable: false })
    expect(status.recordSince).not.toBeNull()
  })

  it("reads the agent's logs before the agent deletes a session", async () => {
    let read: () => Promise<number> = async () => 0
    const listedAtScan: number[] = []
    const reader: LogReader = {
      agentId: 'fake-agent',
      locations: () => [],
      scan: async () => {
        listedAtScan.push(await read())
        return true
      },
    }
    const { t, port } = await setup({
      usageReaders: [reader],
      settings: {
        locale: 'en',
        agents: DEFAULT_SETTINGS.agents,
        proxy: DEFAULT_SETTINGS.proxy,
        git: DEFAULT_SETTINGS.git,
        usage: { fromComputer: true },
      },
    })
    read = async () =>
      (
        await port.request('agents.listSessions', { agentId: 'fake-agent', projectPath: t.project })
      ).sessions.filter((session) => session.imported).length
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, 'Fix the flaky login test')
    await port.untilStatus(sessionId, 'ready')
    expect(await read()).toBe(1)

    await port.request('sessions.delete', { sessionId })
    // The scan ran while the agent still had the session and its log.
    expect(listedAtScan).toEqual([1])
    expect(await read()).toBe(0)
  })

  it('streams a whole turn into the watching port', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    expect(port.summary(sessionId)).toMatchObject({ status: 'ready', origin: 'user' })

    await turn(port, sessionId, 'Fix the flaky login test')
    expect(port.summary(sessionId)?.status).toBe('running')
    await port.untilEntry(sessionId, (entry) => entry.kind === 'turn_end')
    await port.untilStatus(sessionId, 'ready')

    const entries = port.entries(sessionId)
    expect(entries[0]).toEqual({
      kind: 'user',
      id: 'e:1',
      content: [{ type: 'text', text: 'Fix the flaky login test' }],
      at: expect.any(Number),
    })
    const agent = entries.find((entry) => entry.kind === 'agent')
    expect(agent).toMatchObject({ streaming: false, at: expect.any(Number) })
    expect(agent?.id.startsWith('m:')).toBe(true)
    expect(tools(port, sessionId).some((tool) => tool.content.some((c) => c.type === 'diff'))).toBe(
      true,
    )
    const end = entries.at(-1)
    expect(end).toMatchObject({ kind: 'turn_end', stopReason: 'end_turn' })
    expect(end?.kind === 'turn_end' && end.durationMs).toBeGreaterThanOrEqual(0)

    const session = port.thread(sessionId).session
    expect(session.title).toBe('Fix the flaky login test')
    expect(session.usage?.tokens?.total).toBeGreaterThan(0)
    expect(session.usage?.size).toBe(200_000)
    expect(session.config.map((option) => option.id)).toEqual([
      'mode',
      'model',
      'thought_level',
      'fast',
      '__ultracode',
    ])
    expect(t.sent).toContainEqual(
      expect.objectContaining({ type: 'host:attention', sessionId, kind: 'turn-ended' }),
    )
  })

  it('puts the account and plan limits on the agent status', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, 'hello')
    await port.untilStatus(sessionId, 'ready')
    const [status] = await port
      .request('agents.check', { agentId: 'fake-agent' })
      .then((all) => all.filter((s) => s.id === 'fake-agent'))
    expect(status).toMatchObject({
      state: 'ready',
      version: '0.1.0',
      signIn: 'signed-in',
      account: { kind: 'account', label: 'Fake Pro', email: 'developer@example.com' },
    })
    const windows = Object.fromEntries(status!.limits.map((limit) => [limit.window, limit]))
    // The fake agent reports 0.12 + 0.07 per turn, as a fraction like Claude Code does.
    expect(windows.five_hour).toMatchObject({ label: '5-hour', usedPercent: 19, state: 'ok' })
    expect(windows.seven_day).toMatchObject({ label: 'Weekly', usedPercent: 32 })
    expect(windows.five_hour!.resetsAt).toBeGreaterThan(Date.now())
  })

  it('rejects a prompt while a turn runs, and on a session that is not open', async () => {
    const { t, port } = await setup({ agentEnv: { FAKE_AGENT_DELAY_SCALE: '0.05' } })
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/cancel')
    await expect(turn(port, sessionId, 'again')).rejects.toMatchObject({ code: 'busy' })
    await port.request('sessions.cancel', { sessionId })
    await port.untilStatus(sessionId, 'ready')
    await expect(
      port.request('sessions.prompt', {
        sessionId: 'no-such-session',
        content: [{ type: 'text', text: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('permissions', () => {
  it.each([
    ['allow-once', 'allow_once'],
    ['allow-always', 'allow_always'],
    ['reject-once', 'reject_once'],
    ['reject-always', 'reject_always'],
  ] as const)('answers with %s', async (optionId, kind) => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/permission')
    await port.untilStatus(sessionId, 'awaiting_permission')
    expect(port.summary(sessionId)).toMatchObject({ attention: 'permission', permissionCount: 1 })
    expect(t.sent).toContainEqual({ type: 'host:badge', count: 1 })
    expect(t.sent).toContainEqual(
      expect.objectContaining({ type: 'host:attention', sessionId, kind: 'permission' }),
    )
    await port.until(() => tools(port, sessionId).some((tool) => tool.permission !== null))
    const tool = tools(port, sessionId).find((entry) => entry.permission)!
    expect(tool.permission!.options.map((option) => option.kind)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
      'reject_always',
    ])
    const { requestId } = tool.permission!

    await expect(
      port.request('permissions.respond', { sessionId, requestId, optionId: 'maybe' }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(
      port.request('permissions.respond', { sessionId, requestId: 'p999', optionId }),
    ).rejects.toMatchObject({ code: 'not_found' })
    // A failed answer changes nothing.
    expect(port.summary(sessionId)?.permissionCount).toBe(1)

    await port.request('permissions.respond', { sessionId, requestId, optionId })
    await port.untilStatus(sessionId, 'ready')
    const answered = tools(port, sessionId).find((entry) => entry.id === tool.id)!
    expect(answered.permission).toBeNull()
    expect(answered.permissionResult).toEqual({ optionId, kind })
    expect(t.sent.filter((m) => m.type === 'host:badge').at(-1)).toEqual({
      type: 'host:badge',
      count: 0,
    })
    const reply = port.entries(sessionId).filter((entry) => entry.kind === 'agent')
    expect(reply.at(-1)?.kind === 'agent' && reply.at(-1)?.markdown).toContain(optionId)
  })

  it('keeps several requests pending at once', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/parallel-permissions')
    await port.until(() => port.summary(sessionId)?.permissionCount === 3)
    expect(t.sent).toContainEqual({ type: 'host:badge', count: 3 })
    const pending = tools(port, sessionId).filter((tool) => tool.permission)
    expect(pending).toHaveLength(3)
    for (const [index, tool] of [...pending].reverse().entries()) {
      await port.request('permissions.respond', {
        sessionId,
        requestId: tool.permission!.requestId,
        optionId: 'allow-once',
      })
      if (index < 2) expect(port.summary(sessionId)?.status).toBe('awaiting_permission')
    }
    await port.untilStatus(sessionId, 'ready')
    expect(port.summary(sessionId)).toMatchObject({ permissionCount: 0 })
    expect(tools(port, sessionId).filter((tool) => tool.permissionResult)).toHaveLength(3)
  })

  it('clears a request the agent withdraws', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/permission --withdraw 1')
    await port.untilStatus(sessionId, 'ready')
    const tool = tools(port, sessionId).find((entry) => entry.permissionResult)!
    expect(tool.permissionResult).toBe('withdrawn')
    expect(port.summary(sessionId)).toMatchObject({ permissionCount: 0 })
  })
})

describe('cancellation', () => {
  it('ends the turn when the agent confirms', async () => {
    const { t, port } = await setup({ agentEnv: { FAKE_AGENT_DELAY_SCALE: '0.05' } })
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/cancel')
    await port.untilEntry(sessionId, (entry) => entry.kind === 'agent')
    await port.request('sessions.cancel', { sessionId })
    await port.untilStatus(sessionId, 'ready')
    expect(port.entries(sessionId).at(-1)).toMatchObject({
      kind: 'turn_end',
      stopReason: 'cancelled',
    })
    expect(port.entries(sessionId).some((entry) => entry.kind === 'notice')).toBe(false)
  })

  it('answers pending requests cancelled at once', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/parallel-permissions')
    await port.until(() => port.summary(sessionId)?.permissionCount === 3)
    await port.request('sessions.cancel', { sessionId })
    expect(port.summary(sessionId)).toMatchObject({ permissionCount: 0 })
    await port.untilStatus(sessionId, 'ready')
    const results = tools(port, sessionId).flatMap((tool) =>
      tool.permissionResult ? [tool.permissionResult] : [],
    )
    expect(results).toEqual(['cancelled', 'cancelled', 'cancelled'])
    expect(port.entries(sessionId).at(-1)).toMatchObject({ stopReason: 'cancelled' })
  })

  it('ends the turn itself when the agent never confirms', async () => {
    const { t, port } = await setup({
      agentEnv: { FAKE_AGENT_DELAY_SCALE: '0.05' },
      sessionTimings: { cancelFallbackMs: 200 },
    })
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/cancel --ignore-cancel')
    await port.untilEntry(sessionId, (entry) => entry.kind === 'agent')
    const started = Date.now()
    await port.request('sessions.cancel', { sessionId })
    expect(port.summary(sessionId)?.status).toBe('running')
    await port.untilStatus(sessionId, 'ready')
    expect(Date.now() - started).toBeGreaterThanOrEqual(190)
    const entries = port.entries(sessionId)
    const notice = entries.find((entry) => entry.kind === 'notice')
    expect(notice).toMatchObject({ severity: 'warning' })
    expect(entries.findLast((entry) => entry.kind === 'turn_end')).toMatchObject({
      stopReason: 'cancelled',
    })
  })
})

describe('opening and recovering', () => {
  it('opens a closed session from its stored thread, without its agent', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, 'Fix the flaky login test')
    await port.untilStatus(sessionId, 'ready')
    const before = port.entries(sessionId)

    await port.request('sessions.close', { sessionId })
    expect(port.summary(sessionId)).toMatchObject({ status: 'closed' })
    const eventsFrom = port.events.length
    const snapshot = await port.request('sessions.open', { sessionId })
    expect(snapshot).toMatchObject({
      session: { status: 'closed', title: 'Fix the flaky login test' },
    })
    expect(snapshot.older).toBeNull()
    expect(snapshot.entries).toEqual(before)
    expect(snapshot.session.config).toEqual(port.thread(sessionId).session.config)
    expect(port.events.slice(eventsFrom).some((e) => e.type === 'session.patches')).toBe(false)
  })

  it('replays a session with no stored thread through session/load, and stores it', async () => {
    const { t, port } = await setup()
    const imported = await port.request('sessions.import', {
      agentId: 'fake-agent',
      projectPath: t.project,
      acpSessionId: 'cli-refactor-router',
    })
    const eventsFrom = port.events.length
    const snapshot = await port.open(imported.id)
    expect(snapshot.session.status).toBe('ready')
    const ops = port.events
      .slice(eventsFrom)
      .flatMap((event) => (event.type === 'session.patches' ? event.batch.patches : []))
      .map((patch) => patch.op)
    expect(ops).toContain('thread.reset')
    expect(snapshot.entries.find((entry) => entry.kind === 'user')).toBeDefined()
    expect(snapshot.entries.every((e) => !('streaming' in e) || e.streaming === false)).toBe(true)
    await t.host.threads!.flush()
    const stored = await t.host.threads!.load(imported.id)
    expect(stored?.entries.map((item) => item.entry)).toEqual(snapshot.entries)
    expect(stored?.head).toEqual({ agentId: 'fake-agent', acpSessionId: 'cli-refactor-router' })
  })

  it('closes the sessions of a crashed agent, and the next send starts it again', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, 'hello')
    await port.untilStatus(sessionId, 'ready')
    await turn(port, sessionId, '/crash --code 9')
    await port.untilStatus(sessionId, 'closed')
    const notice = port.entries(sessionId).find((entry) => entry.kind === 'notice')
    expect(notice).toMatchObject({ severity: 'error' })
    expect(t.sent).toContainEqual(
      expect.objectContaining({ type: 'host:attention', sessionId, kind: 'error' }),
    )
    // Nothing restarts the agent; the thread stays.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(t.launcher).toMatchObject({ launches: 1 })
    const [agent] = (await port.request('agents.list', undefined)).filter(
      (s) => s.id === 'fake-agent',
    )
    expect(agent).toMatchObject({ state: 'available', detail: null })
    expect(port.entries(sessionId).some((entry) => entry.kind === 'user')).toBe(true)

    await turn(port, sessionId, 'still there?')
    expect(t.launcher).toMatchObject({ launches: 2 })
    await port.untilStatus(sessionId, 'ready')
    expect(port.entries(sessionId).at(-1)).toMatchObject({ stopReason: 'end_turn' })
    expect(port.thread(sessionId).session.title).toBe('hello')
  })

  it('marks a failed turn until the session is seen, and keeps its notice', async () => {
    const { t, port } = await setup()
    const created = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
    })
    await turn(port, created.id, '/error')
    await port.until(() => port.summary(created.id)?.attention === 'error')
    await port.open(created.id)
    expect(port.summary(created.id)).toMatchObject({ status: 'ready', attention: 'none' })
    expect(port.thread(created.id).session.error).not.toBeNull()
    expect(port.entries(created.id)).toContainEqual(
      expect.objectContaining({ kind: 'notice', severity: 'error' }),
    )
  })

  it('does not mark a turn that failed in front of the user', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/error')
    await port.untilEntry(sessionId, (entry) => entry.kind === 'notice')
    await port.untilStatus(sessionId, 'ready')
    expect(port.summary(sessionId)?.attention).toBe('none')
  })

  it('ends a crashed turn: running tools stop and the notice marks the cut', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/crash')
    await port.untilStatus(sessionId, 'closed')
    expect(tools(port, sessionId).map((tool) => tool.status)).toEqual(['cancelled'])
    const notices = port.entries(sessionId).filter((entry) => entry.kind === 'notice')
    expect(notices).toEqual([
      {
        kind: 'notice',
        id: expect.any(String),
        severity: 'error',
        cause: 'agent_stopped',
        title: 'Fake agent exited before finishing this turn',
      },
    ])
    // The cut turn is the latest, so it ends the thread.
    expect(port.entries(sessionId).at(-1)).toBe(notices[0])
  })

  it('ends a turn stopped before its agent exited as stopped, not cut short', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/cancel --ignore-cancel')
    await port.untilEntry(sessionId, (entry) => entry.kind === 'agent')
    await port.request('sessions.cancel', { sessionId })
    ;(t.launcher as InProcessLauncher).crash()
    await port.untilStatus(sessionId, 'closed')
    expect(port.entries(sessionId).at(-1)).toMatchObject({
      kind: 'turn_end',
      stopReason: 'cancelled',
    })
    expect(port.entries(sessionId).some((entry) => entry.kind === 'notice')).toBe(false)
  })

  it('marks no other failed turn as cut', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/error')
    await port.untilEntry(sessionId, (entry) => entry.kind === 'notice')
    const notice = port.entries(sessionId).find((entry) => entry.kind === 'notice')
    expect(notice).not.toHaveProperty('cause')
  })

  it('opens a session from the index after a restart of the host', async () => {
    const first = await startTestHost()
    let port = first.connect()
    const created = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: first.project,
    })
    // Not shown: the turn's end leaves it unread.
    await port.request('sessions.prompt', {
      sessionId: created.id,
      content: [{ type: 'text', text: 'Fix it' }],
    })
    await port.untilStatus(created.id, 'ready')
    expect(port.summary(created.id)).toMatchObject({ attention: 'unread' })
    await first.host.shutdown()
    expect(first.sent.at(-1)).toEqual({ type: 'host:stopped' })

    current = await startTestHost({ userDataPath: first.dir })
    port = current.connect()
    const [summary] = await port.request('sessions.list', {})
    expect(summary).toMatchObject({
      id: created.id,
      status: 'closed',
      title: 'Fix it',
      attention: 'unread',
    })
    const snapshot = await port.open(created.id)
    // The thread comes from the store; the agent is not started to show it.
    expect(snapshot.session.status).toBe('closed')
    expect(snapshot.entries.some((entry) => entry.kind === 'turn_end')).toBe(true)
    expect(current.launcher).toMatchObject({ launches: 0 })
    expect(port.summary(created.id)).toMatchObject({ attention: 'none' })
  })
})

describe('sign-in', () => {
  it('retries after a sign-in in a terminal', async () => {
    const marker = path.join(os.tmpdir(), `ob-login-${Date.now()}`)
    const { t, port } = await setup({
      agentEnv: { FAKE_AGENT_AUTH: 'required', FAKE_AGENT_LOGIN_MARKER: marker },
    })
    const summary = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
    })
    expect(summary.status).toBe('auth_required')
    await port.request('sessions.retry', { sessionId: summary.id })
    expect(port.summary(summary.id)?.status).toBe('auth_required')
    // What `main.ts --login` leaves behind once the user signed in.
    await writeFile(marker, '')
    await port.request('sessions.retry', { sessionId: summary.id })
    expect(port.summary(summary.id)?.status).toBe('ready')
  })

  it('asks for sign-in when the agent comes back signed out after a crash', async () => {
    const marker = path.join(os.tmpdir(), `ob-login-${Date.now()}`)
    const { t, port } = await setup({
      agentEnv: { FAKE_AGENT_AUTH: 'required', FAKE_AGENT_LOGIN_MARKER: marker },
    })
    await port.request('agents.authenticate', { agentId: 'fake-agent', methodId: 'fake-login' })
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/crash')
    await port.untilStatus(sessionId, 'closed')
    // The agent the send starts is signed out, so the resume fails.
    await turn(port, sessionId, 'still there?')
    await port.untilStatus(sessionId, 'auth_required')
    await writeFile(marker, '')
    await port.request('sessions.retry', { sessionId })
    await port.untilStatus(sessionId, 'ready')
    expect(port.entries(sessionId).at(-1)).toMatchObject({ stopReason: 'end_turn' })
    const users = port.entries(sessionId).filter((entry) => entry.kind === 'user')
    expect(JSON.stringify(users)).toContain('/crash')
    expect(JSON.stringify(users)).toContain('still there?')
  })

  it('waits in auth_required and continues after authenticate', async () => {
    const { t, port } = await setup({ agentEnv: { FAKE_AGENT_AUTH: 'required' } })
    const summary = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
    })
    expect(summary.status).toBe('auth_required')
    const [status] = (await port.request('agents.list', undefined)).filter(
      (s) => s.id === 'fake-agent',
    )
    expect(status).toMatchObject({ signIn: 'required' })
    expect(status!.authMethods.map((method) => method.type)).toEqual(['agent', 'terminal'])
    const terminal = status!.authMethods.find((method) => method.type === 'terminal')!
    expect(terminal.command).toContain('--login')
    expect(t.sent).toContainEqual({ type: 'host:auth-commands', commands: [terminal.command] })

    await port.request('agents.authenticate', { agentId: 'fake-agent', methodId: 'fake-login' })
    await port.untilStatus(summary.id, 'ready')
    const [after] = (await port.request('agents.list', undefined)).filter(
      (s) => s.id === 'fake-agent',
    )
    expect(after).toMatchObject({ signIn: 'signed-in' })
    // Once session/new succeeded, the session is in the index.
    await port.request('sessions.close', { sessionId: summary.id })
    expect(port.summary(summary.id)).toMatchObject({ status: 'closed' })
  })

  it('turns a prompt that needs sign-in into auth_required', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/auth-required')
    await port.untilStatus(sessionId, 'auth_required')
    const notice = port.entries(sessionId).find((entry) => entry.kind === 'notice')
    expect(notice).toMatchObject({ severity: 'error' })
    const [status] = (await port.request('agents.list', undefined)).filter(
      (s) => s.id === 'fake-agent',
    )
    expect(status).toMatchObject({ signIn: 'required', account: { kind: 'none' } })
    await expect(
      port.request('agents.authenticate', { agentId: 'fake-agent', methodId: 'nope' }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('sends the prompt that needed sign-in again once signed in', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/auth-required')
    await port.untilStatus(sessionId, 'auth_required')
    await port.request('agents.authenticate', { agentId: 'fake-agent', methodId: 'fake-login' })
    await port.untilEntry(sessionId, (entry) => entry.kind === 'agent')
    await port.untilStatus(sessionId, 'ready')
    expect(port.summary(sessionId)?.status).toBe('ready')
    const [status] = (await port.request('agents.list', undefined)).filter(
      (s) => s.id === 'fake-agent',
    )
    expect(status).toMatchObject({ signIn: 'signed-in' })
  })
})

describe('updates', () => {
  it('maps every variant and records the unknown one', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, '/all-updates')
    await port.untilStatus(sessionId, 'ready')
    const kinds = new Set(port.entries(sessionId).map((entry) => entry.kind))
    for (const kind of ['user', 'agent', 'thought', 'tool', 'plan', 'notice', 'compaction']) {
      expect(kinds).toContain(kind)
    }
    const session = port.thread(sessionId).session
    expect(session.commands.length).toBeGreaterThan(0)
    const bundle = await port.request('diagnostics.collect', undefined)
    const fake = bundle.agents.find((agent) => agent.status.id === 'fake-agent')!
    expect(
      fake.events.some((e) => e.event === 'ignored' && e.detail?.includes('future_update')),
    ).toBe(true)
    expect(fake.traffic.length).toBeGreaterThan(0)
    expect(Object.keys(bundle.environment)).toEqual(['PATH', 'SHELL', 'node'])
  })
})

describe('sub-sessions', () => {
  async function runSubagent(t: TestHost, port: TestPort) {
    const parentId = await newSession(t, port)
    await turn(port, parentId, '/subagent')
    await port.until(() =>
      port.events.some((e) => e.type === 'session.summary' && e.summary.parentId === parentId),
    )
    const child = port.events.flatMap((e) =>
      e.type === 'session.summary' && e.summary.parentId === parentId ? [e.summary] : [],
    )[0]!
    return { parentId, childId: child.id }
  }

  it('creates the child, and its permission request reaches the child', async () => {
    const { t, port } = await setup()
    const { parentId, childId } = await runSubagent(t, port)
    expect(port.summary(childId)).toMatchObject({
      origin: 'subagent',
      parentId,
      description: 'Find where the session token is issued and validated',
      title: 'Explore the repository',
    })
    await port.open(childId)
    await port.until(() => port.summary(childId)?.permissionCount === 1)
    expect(port.summary(parentId)?.permissionCount).toBe(0)
    expect(port.summary(childId)?.status).toBe('awaiting_permission')
    await port.untilEntry(parentId, (entry) => entry.kind === 'subagent')
    expect(port.entries(parentId)).toContainEqual({
      kind: 'subagent',
      id: `s:${childId}`,
      sessionId: childId,
    })

    const childEntries = port.entries(childId)
    expect(childEntries[0]).toMatchObject({ kind: 'session_message', senderId: parentId })
    const tool = tools(port, childId).find((entry) => entry.permission)!
    await expect(
      port.request('sessions.prompt', {
        sessionId: childId,
        content: [{ type: 'text', text: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'restricted' })
    await expect(port.request('sessions.close', { sessionId: childId })).rejects.toMatchObject({
      code: 'restricted',
    })

    await port.request('permissions.respond', {
      sessionId: childId,
      requestId: tool.permission!.requestId,
      optionId: 'allow-once',
    })
    await port.untilStatus(parentId, 'ready')
    expect(port.summary(childId)).toMatchObject({ status: 'ready', permissionCount: 0 })
    expect(port.thread(childId).session.subagent).toMatchObject({
      canCancel: true,
      stateKnown: true,
      stopReason: 'end_turn',
    })
    expect(port.thread(childId).session.usage?.tokens?.input).toBe(4800)
    expect(port.entries(childId).at(-1)).toMatchObject({ kind: 'turn_end', stopReason: 'end_turn' })
  })

  it('closes with its parent when the agent crashes', async () => {
    const { t, port } = await setup()
    const { parentId, childId } = await runSubagent(t, port)
    await port.open(childId)
    await port.until(() => port.summary(childId)?.permissionCount === 1)
    const other = await newSession(t, port)
    await turn(port, other, '/crash')
    await port.untilStatus(parentId, 'closed')
    await port.untilStatus(childId, 'closed')
    expect(port.summary(childId)?.permissionCount).toBe(0)
    expect(tools(port, childId).find((tool) => tool.permissionResult)).toMatchObject({
      permissionResult: 'withdrawn',
    })
  })

  it('cancels a child that allows it', async () => {
    const { t, port } = await setup()
    const { parentId, childId } = await runSubagent(t, port)
    await port.until(() => port.summary(childId)?.permissionCount === 1)
    await port.request('sessions.cancel', { sessionId: childId })
    await port.untilStatus(parentId, 'ready')
    expect(port.summary(childId)).toMatchObject({ permissionCount: 0 })
  })

  it('cascades delete to sub-sessions of either origin', async () => {
    const { t, port } = await setup()
    const { parentId, childId } = await runSubagent(t, port)
    await port.until(() => port.summary(childId)?.permissionCount === 1)
    const user = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: t.project,
      parentId,
    })
    expect(user).toMatchObject({ parentId, origin: 'user', status: 'ready' })
    await expect(port.request('sessions.delete', { sessionId: childId })).rejects.toMatchObject({
      code: 'restricted',
    })

    await port.request('sessions.delete', { sessionId: parentId })
    const removed = port.events.flatMap((e) => (e.type === 'session.removed' ? [e.sessionId] : []))
    expect(removed).toEqual(expect.arrayContaining([parentId, childId, user.id]))
    expect(await port.request('sessions.list', {})).toEqual([])
    expect(t.sent.filter((m) => m.type === 'host:badge').at(-1)).toEqual({
      type: 'host:badge',
      count: 0,
    })
  })

  it('keeps a user sub-session in its parent project', async () => {
    const { t, port } = await setup()
    const parentId = await newSession(t, port)
    await expect(
      port.request('sessions.create', {
        agentId: 'fake-agent',
        projectPath: t.dir,
        parentId,
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
  })
})

describe('config options', () => {
  it('sets an option and takes the agent config back', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await port.request('sessions.setConfigOption', { sessionId, optionId: 'model', value: 'deep' })
    await port.until(
      () => port.thread(sessionId).session.config.find((o) => o.id === 'model')?.value === 'deep',
    )
    await port.request('sessions.setConfigOption', { sessionId, optionId: 'fast', value: true })
    await expect(
      port.request('sessions.setConfigOption', { sessionId, optionId: 'model', value: 'huge' }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(
      port.request('sessions.setConfigOption', { sessionId, optionId: 'fast', value: 'yes' }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
    const model = port.thread(sessionId).session.config.find((o) => o.id === 'model')!
    expect(model.choices?.map((c) => c.group)).toEqual(['Fast', 'Smart', 'Smart'])
  })

  it('offers legacy modes as the synthetic __mode option', async () => {
    const { t, port } = await setup({ agentEnv: { FAKE_AGENT_LEGACY_MODES: '1' } })
    const sessionId = await newSession(t, port)
    const mode = () => port.thread(sessionId).session.config.find((o) => o.id === '__mode')
    expect(mode()).toMatchObject({ category: 'mode', type: 'select', value: 'ask' })
    await port.request('sessions.setConfigOption', { sessionId, optionId: '__mode', value: 'code' })
    await port.until(() => mode()?.value === 'code')
  })
})

describe('streaming', () => {
  it('coalesces chunks into batches with consecutive seq numbers', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    const startSeq = port.replicas.get(sessionId)!.seq
    await turn(port, sessionId, '/long-stream --size 40k --rate 100000')
    await port.untilStatus(sessionId, 'ready')
    const batches = port.events.flatMap((e) =>
      e.type === 'session.patches' && e.batch.sessionId === sessionId ? [e.batch] : [],
    )
    // TestPort throws on a gap, so every batch was exactly one after the last.
    expect(batches.map((b) => b.seq)).toEqual(batches.map((_, i) => startSeq + i + 1))
    const appends = batches.flatMap((b) => b.patches.filter((p) => p.op === 'entry.appendText'))
    // 40 KB in 100-character chunks is about 400 updates, merged into far fewer patches.
    expect(appends.length).toBeLessThan(200)
    for (const batch of batches) {
      batch.patches.forEach((patch, i) => {
        const next = batch.patches[i + 1]
        if (patch.op === 'entry.appendText' && next?.op === 'entry.appendText') {
          expect(next.id).not.toBe(patch.id)
        }
      })
    }
    const reply = port.entries(sessionId).find((entry) => entry.kind === 'agent')
    expect(reply?.kind === 'agent' && reply.markdown.length).toBeGreaterThanOrEqual(40 * 1024)
    const snapshot = await port.request('sessions.snapshot', { sessionId })
    expect(snapshot.entries).toEqual(port.entries(sessionId))
  })

  it('sends a session patches before its summary', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, 'hello')
    await port.untilStatus(sessionId, 'ready')
    const events = port.events
    const isSummary = (i: number, status: string) => {
      const e = events[i]!
      return (
        e.type === 'session.summary' && e.summary.id === sessionId && e.summary.status === status
      )
    }
    const running = events.findIndex((_, i) => isSummary(i, 'running'))
    const ready = events.findIndex((_, i) => i > running && isSummary(i, 'ready'))
    const turnEnd = events.findIndex(
      (e) =>
        e.type === 'session.patches' &&
        e.batch.sessionId === sessionId &&
        e.batch.patches.some((p) => p.op === 'entry.add' && p.entry.kind === 'turn_end'),
    )
    expect(running).toBeGreaterThanOrEqual(0)
    expect(turnEnd).toBeGreaterThan(running)
    expect(turnEnd).toBeLessThan(ready)
  })

  it('streams only to ports that watch the session', async () => {
    const { t, port } = await setup()
    const other = t.connect()
    const sessionId = await newSession(t, port)
    await turn(port, sessionId, 'hello')
    await port.untilStatus(sessionId, 'ready')
    await other.untilStatus(sessionId, 'ready')
    expect(other.events.some((e) => e.type === 'session.patches')).toBe(false)
    expect(other.events.some((e) => e.type === 'session.summary')).toBe(true)
  })
})

describe('unread and viewing', () => {
  it('marks a turn that ends out of view as unread, and showing clears it', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await port.request('sessions.show', { sessionId: null })
    await turn(port, sessionId, 'hello')
    await port.untilStatus(sessionId, 'ready')
    expect(port.summary(sessionId)?.attention).toBe('unread')
    await port.request('sessions.show', { sessionId })
    expect(port.summary(sessionId)?.attention).toBe('none')
  })

  it('marks a turn that ends behind another session the port still watches', async () => {
    const { t, port } = await setup()
    const first = await newSession(t, port)
    const second = await newSession(t, port)
    await turn(port, first, 'hello')
    await port.untilStatus(first, 'ready')
    expect(port.entries(first).at(-1)).toMatchObject({ stopReason: 'end_turn' })
    expect(port.summary(first)?.attention).toBe('unread')
    expect(port.summary(second)?.attention).toBe('none')
  })

  it('forgets what a port that closes shows', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    port.disconnect()
    const other = t.connect()
    await other.request('sessions.prompt', { sessionId, content: [{ type: 'text', text: 'hi' }] })
    await other.untilStatus(sessionId, 'ready')
    expect(other.summary(sessionId)?.attention).toBe('unread')
  })
})

describe('the index', () => {
  it('imports a session the agent lists, following nextCursor', async () => {
    const { t, port } = await setup({ agentEnv: { FAKE_AGENT_LIST_PAGE: '1' } })
    const first = await port.request('agents.listSessions', {
      agentId: 'fake-agent',
      projectPath: t.project,
    })
    expect(first.sessions).toHaveLength(1)
    expect(first.nextCursor).toBe('1')
    const second = await port.request('agents.listSessions', {
      agentId: 'fake-agent',
      projectPath: t.project,
      cursor: first.nextCursor!,
    })
    const all = [...first.sessions, ...second.sessions]
    const cli = all.find((s) => s.acpSessionId === 'cli-refactor-router')!
    expect(cli).toMatchObject({ imported: false, title: 'Started in the CLI: refactor the router' })

    const imported = await port.request('sessions.import', {
      agentId: 'fake-agent',
      projectPath: t.project,
      acpSessionId: 'cli-refactor-router',
    })
    expect(imported).toMatchObject({ status: 'closed', title: cli.title, origin: 'user' })
    const again = await port.request('sessions.import', {
      agentId: 'fake-agent',
      projectPath: t.project,
      acpSessionId: 'cli-refactor-router',
    })
    expect(again.id).toBe(imported.id)
    const relisted = await port.request('agents.listSessions', {
      agentId: 'fake-agent',
      projectPath: t.project,
    })
    expect(relisted.sessions[0]).toMatchObject({ imported: true })
    const snapshot = await port.open(imported.id)
    expect(snapshot.session.status).toBe('ready')
  })

  it('removes everything from the index, keeping nothing live', async () => {
    const { t, port } = await setup()
    const a = await newSession(t, port)
    await newSession(t, port)
    await turn(port, a, '/permission')
    await port.until(() => port.summary(a)?.permissionCount === 1)
    await port.request('sessions.removeAll', undefined)
    expect(await port.request('sessions.list', {})).toEqual([])
    expect(t.host.sessions.busy()).toEqual([])
  })

  it('names a session after its first message until the agent sends a title', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    const long = `${'word '.repeat(30)}\nsecond line`
    await port.request('sessions.prompt', {
      sessionId,
      content: [{ type: 'text', text: `/scenario cancel ${long}` }],
    })
    const title =
      port.events.flatMap((e) =>
        e.type === 'session.summary' && e.summary.id === sessionId && e.summary.title
          ? [e.summary.title]
          : [],
      )[0] ?? ''
    expect(title.length).toBeLessThanOrEqual(60)
    expect(title.startsWith('/scenario cancel word')).toBe(true)
    await port.request('sessions.cancel', { sessionId })
    await port.untilStatus(sessionId, 'ready')
  })
})
