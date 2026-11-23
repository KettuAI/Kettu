// A server Google Antigravity starts, in a whole host: its call keeps running in the thread past the
// turn, the session keeps its agent while it runs, and closing the session ends the call.

import { afterEach, expect, it } from 'vitest'
import type { ToolEntry } from '@shared/thread'
import { startTestHost, type TestHost, type TestPort } from '../testing/harness'

let host: TestHost | null = null

afterEach(async () => {
  await host?.stop()
  host = null
})

const RELEASE_MS = 20

async function agySession(): Promise<{ window: TestPort; id: string }> {
  host = await startTestHost({
    fakeAs: ['antigravity'],
    agentEnv: { FAKE_AGENT_VERSION: '1.5.15' },
    sessionTimings: {
      releaseHiddenMs: RELEASE_MS,
      releaseShownMs: RELEASE_MS,
      releaseUnusedMs: RELEASE_MS,
    },
  })
  const window = host.connect()
  const { id } = await window.request('sessions.create', {
    agentId: 'antigravity',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  return { window, id }
}

/** Starts the server and waits for the turn that started it to end. */
async function serve(
  window: TestPort,
  id: string,
  flags = '',
): Promise<() => ToolEntry | undefined> {
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: `/agy-daemon ${flags}`.trim() }],
  })
  await window.until(
    () =>
      window.entries(id).some((entry) => entry.kind === 'turn_end') &&
      window.summary(id)?.status === 'ready',
  )
  return () =>
    window
      .entries(id)
      .find(
        (entry): entry is ToolEntry =>
          entry.kind === 'tool' && entry.title === 'python3 -m http.server 8765',
      )
}

it('keeps the call of a server agy runs on going past its turn, and the agent until it ends', async () => {
  const { window, id } = await agySession()
  const call = await serve(window, id, '--then 400')

  expect(call()).toMatchObject({ status: 'in_progress' })
  expect(window.thread(id).session.background).toMatchObject([
    {
      kind: 'shell',
      title: 'Start HTTP server',
      command: 'python3 -m http.server 8765',
      status: 'running',
      entryId: call()!.id,
    },
  ])
  // Ending the session's agent would stop it, so archiving or quitting asks first.
  const { sessions } = await window.request('sessions.runningWork', { sessionIds: [id] })
  expect(sessions).toMatchObject([{ sessionId: id, turn: false, commands: ['Start HTTP server'] }])
  // Long past the release delay, the session keeps its agent while the server runs.
  await new Promise((resolve) => setTimeout(resolve, RELEASE_MS * 10))
  expect(window.summary(id)?.status).toBe('ready')

  await window.until(() => call()?.status === 'failed')
  expect(window.thread(id).session.background).toMatchObject([{ status: 'failed' }])
  await window.untilStatus(id, 'closed')
})

it('ends the call when the session is archived, which stops the server', async () => {
  const { window, id } = await agySession()
  const call = await serve(window, id)
  expect(call()).toMatchObject({ status: 'in_progress' })

  await window.request('sessions.archive', { sessionId: id })
  await window.until(() => call()?.status === 'cancelled')
  expect(window.thread(id).session.background).toMatchObject([{ status: 'stopped' }])
})
