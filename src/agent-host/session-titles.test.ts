// Integration tests: the titles Kettu writes for a session whose agent writes none, and the
// titles OpenCode lists, through the host with the fake agent.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'

let hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.reverse()) await host.stop()
  hosts = []
})

async function setup(options: Parameters<typeof startTestHost>[0] = {}) {
  const t = await startTestHost(options)
  hosts.push(t)
  return { t, port: t.connect() }
}

/** An agent that titles nothing, under a name no own-titles row knows. */
const OTHER = { FAKE_AGENT_NAME: 'plain-agent', FAKE_AGENT_TITLES: 'none' }
const OPENCODE = {
  FAKE_AGENT_NAME: 'OpenCode',
  FAKE_AGENT_VERSION: '2.0.32',
  FAKE_AGENT_TITLES: 'listed',
}

const MESSAGE = 'Improve the session list with pinned and archived groups and keyboard shortcuts'
const CUT = 'Improve the session list with pinned and archived groups and'
const WRITTEN = 'Improve the session'

const waitFor = async (check: () => boolean, timeoutMs = 5000): Promise<void> => {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out: ${check.toString()}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const who = (sessionId: string) => `session ${sessionId}`
const warnings = (t: TestHost): string[] =>
  t.host.diagnostics
    .logEntries()
    .filter((entry) => entry.level === 'warn' && entry.message.includes('could not title session'))
    .map((entry) => entry.message)

function settings(sessionTitles: boolean): HostSettings {
  return {
    locale: 'en',
    agents: DEFAULT_SETTINGS.agents,
    addedAgents: [],
    proxy: DEFAULT_SETTINGS.proxy,
    git: DEFAULT_SETTINGS.git,
    mcp: DEFAULT_SETTINGS.mcp,
    usage: { fromComputer: false },
    sessionTitles,
  }
}

async function newSession(t: TestHost, port: TestPort): Promise<string> {
  const summary = await port.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: t.project,
  })
  await port.open(summary.id)
  return summary.id
}

async function send(port: TestPort, sessionId: string, text: string): Promise<void> {
  const ends = port.entries(sessionId).filter((entry) => entry.kind === 'turn_end').length
  await port.request('sessions.prompt', { sessionId, content: [{ type: 'text', text }] })
  await waitFor(
    () => port.entries(sessionId).filter((entry) => entry.kind === 'turn_end').length > ends,
  )
  await waitFor(() => port.summary(sessionId)?.status === 'ready')
}

/** The titles the port was sent for a session, in the order they changed. */
function seenTitles(port: TestPort, sessionId: string): string[] {
  return port.events.flatMap((event) =>
    event.type === 'session.summary' && event.summary.id === sessionId && event.summary.title
      ? [event.summary.title]
      : [],
  )
}

/** The fake agent's sessions that ran in the reports folder, where hidden sessions live. */
async function reportsSessions(t: TestHost, port: TestPort) {
  const listed = await port.request('agents.listSessions', {
    agentId: 'fake-agent',
    projectPath: path.join(t.dir, 'agent-reports'),
  })
  return listed.sessions.filter((session) => session.acpSessionId.startsWith('fake-'))
}

describe('a title written for a session whose agent titles none', () => {
  it('writes it once from the first message, in a hidden session it removes', async () => {
    const env = OTHER
    const { t, port } = await setup({ agentEnv: env })
    const sessionId = await newSession(t, port)
    await send(port, sessionId, MESSAGE)
    // The first line, cut to 60, until the title comes.
    expect(seenTitles(port, sessionId)).toContain(CUT)
    await waitFor(() => port.summary(sessionId)?.title === WRITTEN)
    expect(await reportsSessions(t, port)).toEqual([])

    // A second message writes no other.
    await send(port, sessionId, 'Now do the same for the archive')
    await sleep(50)
    expect(port.summary(sessionId)?.title).toBe(WRITTEN)
    expect(await reportsSessions(t, port)).toEqual([])

    // The index keeps it across a restart.
    await t.host.shutdown()
    const again = await startTestHost({ userDataPath: t.dir })
    hosts.push(again)
    const port2 = again.connect()
    const [summary] = await port2.request('sessions.list', {})
    expect(summary).toMatchObject({ id: sessionId, status: 'closed', title: WRITTEN })
  })

  it('writes none while the setting is off', async () => {
    const { t, port } = await setup({ agentEnv: OTHER, settings: settings(false) })
    const sessionId = await newSession(t, port)
    await send(port, sessionId, MESSAGE)
    await sleep(100)
    expect(port.summary(sessionId)?.title).toBe(CUT)
    expect(warnings(t)).toEqual([])
  })

  it('logs a reply with no title, and asks nothing more at the next message', async () => {
    const { t, port } = await setup({ agentEnv: OTHER })
    const sessionId = await newSession(t, port)
    const message = `/garbage ${MESSAGE}`
    await send(port, sessionId, message)
    await waitFor(() => warnings(t).length === 1)
    expect(warnings(t)[0]).toContain(who(sessionId))
    expect(port.summary(sessionId)?.title).toBe(message.slice(0, 60))

    await send(port, sessionId, 'A second message at once')
    await sleep(100)
    expect(warnings(t)).toHaveLength(1)
  })

  it('writes none when the hidden session cannot be removed without a trace', async () => {
    const { t, port } = await setup({
      agentEnv: { ...OTHER, FAKE_AGENT_WITHOUT: 'delete' },
    })
    const sessionId = await newSession(t, port)
    await send(port, sessionId, MESSAGE)
    await waitFor(() => warnings(t).length === 1)
    expect(port.summary(sessionId)?.title).toBe(CUT)
  })

  it('writes none for a routine run', async () => {
    const { t, port } = await setup({ agentEnv: OTHER })
    const routine = await port.request('routines.create', {
      name: 'Session titles',
      prompt: MESSAGE,
      agentId: 'fake-agent',
      projectPath: null,
      options: [],
      trigger: { kind: 'schedule', schedule: { kind: 'weekly', days: [1], time: '09:00' } },
      scope: { level: 'read', web: false },
      timeLimitMinutes: 15,
    })
    const run = await port.request('routines.runNow', { routineId: routine.id })
    await waitFor(() => {
      const events = port.events.flatMap((event) =>
        event.type === 'routine.run' && event.run.id === run.id ? [event.run] : [],
      )
      return events.at(-1)?.status === 'succeeded'
    })
    const runs = await port.request('routines.runs', { routineId: routine.id })
    expect(runs.runs[0]?.session?.title).toBe(CUT)
    await sleep(100)
    const later = await port.request('routines.runs', { routineId: routine.id })
    expect(later.runs[0]?.session?.title).toBe(CUT)
    expect(warnings(t)).toEqual([])
  })

  it('keeps a title the user gives while one is written, and shows it after', async () => {
    const { t, port } = await setup({
      agentEnv: { ...OTHER, FAKE_AGENT_NEW_SESSION_MS: '150' },
    })
    const sessionId = await newSession(t, port)
    await port.request('sessions.prompt', {
      sessionId,
      content: [{ type: 'text', text: MESSAGE }],
    })
    await port.request('sessions.rename', { sessionId, title: 'My own title' })
    expect(port.summary(sessionId)?.title).toBe('My own title')
    // The written title still lands under it.
    await sleep(400)
    expect(port.summary(sessionId)?.title).toBe('My own title')
    await port.request('sessions.rename', { sessionId, title: null })
    await waitFor(() => port.summary(sessionId)?.title === WRITTEN)
  })

  it("keeps the agent's own title and drops the one written after it", async () => {
    const first = 'Improve the session list with pinned and archived groups and shortcuts'
    const agentTitle = first.slice(0, 50)
    const { t, port } = await setup({
      agentEnv: { FAKE_AGENT_NAME: 'plain-agent', FAKE_AGENT_NEW_SESSION_MS: '150' },
    })
    const sessionId = await newSession(t, port)
    await send(port, sessionId, first)
    expect(port.summary(sessionId)?.title).toBe(agentTitle)
    await sleep(400)
    expect(port.summary(sessionId)?.title).toBe(agentTitle)
    expect(port.summary(sessionId)?.title).not.toBe(WRITTEN)
  })

  it('never shows a title that is only the first message again', async () => {
    const message = `${'Improve the session list with pinned and archived groups '.repeat(3)}now`
    const { t, port } = await setup({ agentEnv: { FAKE_AGENT_TITLES: 'message' } })
    const sessionId = await newSession(t, port)
    await send(port, sessionId, message)
    expect(seenTitles(port, sessionId)).not.toContain(message)
    await waitFor(() => port.summary(sessionId)?.title === WRITTEN)
  })

  it('writes none for a fork, which starts with its source title', async () => {
    const { t, port } = await setup({ agentEnv: OTHER })
    const sessionId = await newSession(t, port)
    await send(port, sessionId, MESSAGE)
    await waitFor(() => port.summary(sessionId)?.title === WRITTEN)
    const forked = await port.request('sessions.fork', { sessionId })
    await port.open(forked.id)
    expect(forked.title).toBe(WRITTEN)
    await send(port, forked.id, 'Now the archive page')
    await sleep(100)
    expect(port.summary(forked.id)?.title).toBe(WRITTEN)
    expect(await reportsSessions(t, port)).toEqual([])
  })
})

describe('an agent that titles its own sessions', () => {
  it('shows its title and opens no hidden session for one', async () => {
    const { t, port } = await setup()
    const sessionId = await newSession(t, port)
    await send(port, sessionId, MESSAGE)
    // The fake agent titles its session as Claude Code's adapter does, cut to 50 characters.
    expect(port.summary(sessionId)?.title).toBe(MESSAGE.slice(0, 50))
    await sleep(100)
    expect(port.summary(sessionId)?.title).toBe(MESSAGE.slice(0, 50))
    // No hidden session was opened: the reports folder is made by the first one.
    expect(existsSync(path.join(t.dir, 'agent-reports'))).toBe(false)
  })
})

describe("OpenCode's listed titles", () => {
  it("takes OpenCode's title when the first turn ends", async () => {
    const { t, port } = await setup({ agentEnv: OPENCODE })
    const sessionId = await newSession(t, port)
    await send(port, sessionId, MESSAGE)
    await waitFor(() => port.summary(sessionId)?.title === WRITTEN)
  })

  it('reads the list once more when OpenCode holds the title past the end of the turn', async () => {
    const { t, port } = await setup({
      agentEnv: { ...OPENCODE, FAKE_AGENT_LIST_TITLE_MS: '1000' },
      sessionTimings: { listedTitleRetryMs: 1500 },
    })
    const sessionId = await newSession(t, port)
    await send(port, sessionId, MESSAGE)
    expect(port.summary(sessionId)?.title).toBe(CUT)
    await waitFor(() => port.summary(sessionId)?.title === WRITTEN)
  })

  it('lists a session this build reads at a later turn, whose end takes its title', async () => {
    const { t, port } = await setup({
      agentEnv: { ...OPENCODE, FAKE_AGENT_LIST_TITLE_MS: '1000' },
      sessionTimings: { listedTitleRetryMs: 600_000 },
    })
    const sessionId = await newSession(t, port)
    await send(port, sessionId, MESSAGE)
    // The second read is held far off, so the next turn's end is what reads the title.
    expect(port.summary(sessionId)?.title).toBe(CUT)
    await sleep(1100)
    await send(port, sessionId, 'A second message')
    await waitFor(() => port.summary(sessionId)?.title === WRITTEN)
  })

  it("leaves a title the agent renamed alone at the next turn's end", async () => {
    const { t, port } = await setup({ agentEnv: OPENCODE })
    const sessionId = await newSession(t, port)
    await send(port, sessionId, MESSAGE)
    await waitFor(() => port.summary(sessionId)?.title === WRITTEN)
    t.host.sessions.renameByAgent(sessionId, 'Agent rename')
    await send(port, sessionId, 'A second message')
    await sleep(100)
    expect(port.summary(sessionId)?.title).toBe('Agent rename')
  })
})
