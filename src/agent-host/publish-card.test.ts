import { afterEach, expect, it, vi } from 'vitest'
import type { MarketPublishAsk } from '@shared/thread'
import type { MarketAnswer } from './marketplace/publish-tools'
import { FakeAppServer, turn } from './testing/fake-app-server'
import { startTestHost, type TestHost } from './testing/harness'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const PROMPT = 'publish the changelog skill'

const ASK: MarketPublishAsk = {
  action: 'publish',
  item: {
    name: 'Changelog writer',
    slug: 'changelog-writer',
    kind: 'skill',
    harness: null,
    description: 'One line per change.',
  },
  listingId: null,
  version: '1.0.0',
  previous: null,
  installs: 0,
  visibility: 'public',
  notes: null,
  adds: [],
  runs: [],
  manifest: 'SKILL.md',
  folder: 'skills/changelog-writer',
  files: [{ path: 'SKILL.md', size: 80 }],
  bytes: 80,
  changes: null,
  publisher: null,
}

/** A Codex session with a turn that runs until the test ends it. */
async function runningSession() {
  const server = new FakeAppServer()
  // The session also starts a hidden thread to title itself, so a turn is found by its text.
  const turns = new Map<string, { threadId: string; turnId: string }>()
  server.on('turn/start', (params, self) => {
    const turnId = self.nextTurnId()
    const input = params.input as { text?: string }[]
    turns.set(input[0]?.text ?? '', { threadId: params.threadId as string, turnId })
    return { turn: turn(turnId) }
  })
  const host = await startTestHost({ fakeAppServer: server })
  hosts.push(host)
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'codex',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  void window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: PROMPT }],
  })
  await vi.waitFor(() => expect(turns.has(PROMPT)).toBe(true))
  const end = (text: string) => {
    const { threadId, turnId } = turns.get(text)!
    server.notify('turn/completed', { threadId, turn: turn(turnId, 'completed') })
  }
  return { host, window, id, turns, end }
}

it('keeps a publish card waiting past the turn that opened it, for the user to answer', async () => {
  const { host, window, id, end } = await runningSession()
  const asked = host.host.sessions.marketAsked(id, ASK, 10 * 60_000)!
  let answer: MarketAnswer | null = null
  void asked.answer.then((given) => (answer = given))
  await window.untilStatus(id, 'awaiting_permission')

  end(PROMPT)
  // The card waits on, and the user can still write while it does.
  await window.untilStatus(id, 'ready')
  const card = () => window.thread(id).byId[asked.entryId]
  expect(card()).toMatchObject({ kind: 'market_publish', outcome: null })
  expect(answer).toBeNull()

  await host.host.sessions.answerMarket(id, asked.entryId, { decision: 'later' }, async () => {})
  await vi.waitFor(() => expect(answer).toEqual({ decision: 'later' }))
  await vi.waitFor(() => expect(card()).toMatchObject({ outcome: { kind: 'later' } }))
  expect(window.summary(id)?.status).toBe('ready')
})

it('lets a later turn go on once its own card is answered, while an earlier one waits', async () => {
  const { host, window, id, turns, end } = await runningSession()
  const early = host.host.sessions.marketAsked(id, ASK, 10 * 60_000)!
  end(PROMPT)
  await window.untilStatus(id, 'ready')

  void window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: 'and the other one' }],
  })
  await vi.waitFor(() => expect(turns.has('and the other one')).toBe(true))
  const late = host.host.sessions.marketAsked(id, { ...ASK, version: '1.0.1' }, 10 * 60_000)!
  await window.untilStatus(id, 'awaiting_permission')
  await host.host.sessions.answerMarket(id, late.entryId, { decision: 'later' }, async () => {})
  await window.untilStatus(id, 'running')
  expect(window.thread(id).byId[early.entryId]).toMatchObject({ outcome: null })
})
