import { afterEach, describe, expect, it } from 'vitest'
import type { HostedContext } from '../driver'
import { OpenCodeFolders } from './folders'
import type { RunningServer } from './server'
import { CWD, FakeServer, TestThread } from './testing'

const open: OpenCodeFolders[] = []

afterEach(() => {
  for (const connection of open.splice(0)) connection.close()
})

/** Two OpenCode servers behind one connection, with the environment each was started with. */
async function connect() {
  const started: { env: Record<string, string | undefined>; server: FakeServer }[] = []
  const context = {
    def: { id: 'opencode', name: 'OpenCode' },
    env: { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-test' },
    hooks: { traffic: () => {}, account: () => {}, ignored: () => {}, log: () => {} },
  } as unknown as HostedContext
  const connection = new OpenCodeFolders(context, async (given) => {
    const server = new FakeServer()
    started.push({ env: { ...given.env }, server })
    const running: RunningServer = {
      api: server.api,
      version: '2.4.2',
      exited: new Promise(() => {}),
      stop: () => {},
    }
    return running
  })
  open.push(connection)
  await connection.initialize('0.0.0')
  return { connection, started }
}

const text = (value: string) => [{ type: 'text' as const, text: value }]

describe("OpenCode's project config", () => {
  it('stays off for every session until the folder’s own settings may load', async () => {
    const { connection, started } = await connect()
    expect(started).toHaveLength(1)
    expect(started[0]!.env).toMatchObject({ OPENCODE_DISABLE_PROJECT_CONFIG: '1' })
    expect(started[0]!.env.OPENAI_API_KEY).toBe('sk-test')
    await connection.newSession(CWD, {})
    // Kettu's own hidden sessions never get the folder's config either.
    await connection.newSession(CWD, { hidden: 'options' })
    expect(started).toHaveLength(1)
  })

  it('runs an allowed folder’s sessions on a second server that loads it', async () => {
    const { connection, started } = await connect()
    const held = await connection.newSession(CWD, {})
    const allowed = await connection.newSession(CWD, { projectTrusted: true })
    expect(started).toHaveLength(2)
    expect(started[1]!.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined()
    const [first, second] = started
    const posted = (server: FakeServer) =>
      server.sent.filter((item) => item.method === 'POST' && item.path === '/api/session').length
    expect(posted(first!.server)).toBe(1)
    expect(posted(second!.server)).toBe(1)
    expect(held.sessionId).not.toBe('')
    expect(allowed.sessionId).not.toBe('')
    // One second server serves every allowed folder.
    await connection.newSession(CWD, { projectTrusted: true })
    expect(started).toHaveLength(2)
  })

  it('moves a session to the second server when it attaches again once allowed', async () => {
    const { connection, started } = await connect()
    const { sessionId } = await connection.newSession(CWD, {})
    const thread = new TestThread(sessionId)
    connection.register(sessionId, thread)
    await connection.resumeSession(sessionId, CWD, { projectTrusted: true })
    const second = started[1]!.server
    expect(second.sent.some((item) => item.path === `/api/session/${sessionId}`)).toBe(true)
    void connection.prompt(sessionId, text('Hi')).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(
      second.sent.some(
        (item) => item.method === 'POST' && item.path.startsWith(`/api/session/${sessionId}/`),
      ),
    ).toBe(true)
  })
})
