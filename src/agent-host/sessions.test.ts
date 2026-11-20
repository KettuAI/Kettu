import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentManager } from './agents'
import type { Diagnostics } from './diagnostics'
import type { LastRequest, OutsideReader } from './outside-sessions'
import type { Projects } from './projects'
import type { ScratchFolders } from './scratch'
import { HostError } from './errors'
import { SessionManager, type SessionEvents } from './sessions'
import { returnedFile, sessionsFile, type SessionRecord, type SessionsFile } from './storage'
import type { StoredThread } from './threads/model'
import type { ThreadStore } from './threads/store'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-sessions-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const log = () => {}

/** A manager over real index files in `dir`, with no agent, git or thread store behind it. */
function manager(
  projects: Partial<Projects> = {},
  extra: {
    agents?: Record<string, unknown>
    outside?: OutsideReader
    threads?: Partial<ThreadStore>
  } = {},
) {
  const added: string[] = []
  const deps = {
    platform: 'darwin',
    agents: {
      has: () => true,
      assertEnabled: () => {},
      runningConfig: () => null,
      sessionsChanged: () => {},
      restoreConfig: (_agentId: string, config: unknown[]) => config,
      status: () => ({ capabilities: null }),
      ...extra.agents,
    } as unknown as AgentManager,
    projects: {
      list: () => [],
      resolveDirectory: async (folder: string) => folder,
      add: async (folder: string) => {
        added.push(folder)
      },
      ...projects,
    } as unknown as Projects,
    scratch: { contains: () => false } as unknown as ScratchFolders,
    file: sessionsFile(dir, log),
    returned: returnedFile(dir, log),
    portOpen: () => false,
    threads: (extra.threads ?? null) as ThreadStore | null,
    reportsDir: path.join(dir, 'reports'),
    diagnostics: { log: () => {} } as unknown as Diagnostics,
    git: () => null,
    events: new Proxy({}, { get: () => () => {} }) as SessionEvents,
    settings: () => ({}) as never,
    ...(extra.outside ? { outside: extra.outside } : {}),
  } satisfies ConstructorParameters<typeof SessionManager>[0]
  return { sessions: new SessionManager(deps), added, agents: deps.agents }
}

/** An agent that lists `pages` of session ids for any folder, one page per call. */
function lists(...pages: string[][]): Record<string, unknown> {
  return {
    name: () => 'Agent',
    ensureReady: async () => ({
      init: { capabilities: { listSessions: true } },
      connection: {
        listSessions: async (_cwd: string, cursor: string | null) => {
          const at = cursor === null ? 0 : Number(cursor)
          return {
            sessions: pages[at].map((sessionId) => ({ sessionId, title: null, updatedAt: null })),
            nextCursor: at + 1 < pages.length ? String(at + 1) : null,
          }
        },
      },
    }),
  }
}

async function index(): Promise<SessionsFile | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, 'state', 'sessions.json'), 'utf8'))
  } catch {
    return null
  }
}

describe('the session index', () => {
  it('writes a session that first enters it at once, before a crash can lose it', async () => {
    const { sessions } = manager({}, { agents: lists(['acp-1']) })
    await sessions.load()
    const summary = await sessions.importSession({
      agentId: 'claude-code',
      projectPath: '/repo',
      acpSessionId: 'acp-1',
    })
    await vi.waitFor(async () =>
      expect((await index())?.sessions.map((record) => record.id)).toEqual([summary.id]),
    )
  })
})

describe('importing a session from a terminal', () => {
  const last: LastRequest = {
    at: Date.parse('2026-11-16T10:00:00Z'),
    ttl: 60 * 60_000,
    model: 'claude-opus-5-5[1m]',
    effort: 'xhigh',
    fast: false,
    mode: 'auto',
    context: 120_000,
  }
  const reader = (held: boolean, asked: string[] = []): OutsideReader => ({
    lastRequest: async (_agent, _cwd, id) => {
      asked.push(id)
      return last
    },
    holder: async () => (held ? { pid: 42, entrypoint: 'cli', busy: false } : null),
    tail: async () => null,
  })

  it('refuses one a terminal still has open, and keeps nothing of it', async () => {
    const { sessions } = manager({}, { outside: reader(true), agents: lists(['cli-1']) })
    await sessions.load()
    await expect(
      sessions.importSession({
        agentId: 'claude-code',
        projectPath: '/repo',
        acpSessionId: 'cli-1',
      }),
    ).rejects.toMatchObject({ code: 'busy' })
    expect(sessions.list('/repo')).toEqual([])
  })

  it('keeps how its last request ran and its cache, and sends the guide ahead', async () => {
    const { sessions } = manager({}, { outside: reader(false), agents: lists(['cli-1']) })
    await sessions.load()
    const summary = await sessions.importSession({
      agentId: 'claude-code',
      projectPath: '/repo',
      acpSessionId: 'cli-1',
    })
    expect(summary.cache).toEqual({ lastRequestAt: last.at, ttl: last.ttl })
    await vi.waitFor(async () =>
      expect((await index())?.sessions[0]).toMatchObject({
        acpSessionId: 'cli-1',
        cache: { lastRequestAt: last.at, ttl: last.ttl },
        outside: { model: 'claude-opus-5-5[1m]', effort: 'xhigh', fast: false, mode: 'auto' },
        instructionsAhead: true,
      }),
    )
  })

  it('refuses a session id its agent does not list for the folder, and keeps nothing of it', async () => {
    const { sessions, added } = manager({}, { outside: reader(false), agents: lists(['cli-1']) })
    await sessions.load()
    await expect(
      sessions.importSession({
        agentId: 'claude-code',
        projectPath: '/repo',
        acpSessionId: 'made-up',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(sessions.list('/repo')).toEqual([])
    expect(added).toEqual([])
    expect(await index()).toBeNull()
  })

  it('looks through every page its agent lists', async () => {
    const { sessions } = manager({}, { agents: lists(['a'], ['b'], ['cli-1']) })
    await sessions.load()
    await sessions.importSession({
      agentId: 'claude-code',
      projectPath: '/repo',
      acpSessionId: 'cli-1',
    })
    expect(sessions.list('/repo')).toHaveLength(1)
    await vi.waitFor(async () => expect((await index())?.sessions).toHaveLength(1))
  })

  it('stops looking at a cursor its agent gives twice', async () => {
    const { sessions } = manager(
      {},
      {
        agents: {
          name: () => 'Agent',
          ensureReady: async () => ({
            init: { capabilities: { listSessions: true } },
            connection: {
              listSessions: async () => ({ sessions: [], nextCursor: 'same' }),
            },
          }),
        },
      },
    )
    await sessions.load()
    await expect(
      sessions.importSession({
        agentId: 'claude-code',
        projectPath: '/repo',
        acpSessionId: 'cli-1',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses an agent that cannot list its sessions, which it cannot check', async () => {
    const { sessions } = manager(
      {},
      {
        agents: {
          name: () => 'Agent',
          ensureReady: async () => ({ init: { capabilities: { listSessions: false } } }),
        },
      },
    )
    await sessions.load()
    await expect(
      sessions.importSession({ agentId: 'claude-code', projectPath: '/repo', acpSessionId: 'x' }),
    ).rejects.toMatchObject({ code: 'agent_unavailable' })
  })

  it('copies one a terminal has open when asked to fork, with the settings of the original', async () => {
    const asked: string[] = []
    const copied: string[] = []
    const { sessions } = manager(
      {},
      {
        outside: reader(true, asked),
        agents: {
          ensureReady: async () => ({
            connection: {
              copySession: async (id: string) => {
                copied.push(id)
                return 'copy-1'
              },
            },
          }),
        },
      },
    )
    await sessions.load()
    await sessions.importSession({
      agentId: 'claude-code',
      projectPath: '/repo',
      acpSessionId: 'cli-1',
      fork: true,
    })
    expect(copied).toEqual(['cli-1'])
    expect(asked).toEqual(['cli-1'])
    await vi.waitFor(async () =>
      expect((await index())?.sessions[0]).toMatchObject({ acpSessionId: 'copy-1' }),
    )
  })
})

describe('restoring an archived session', () => {
  const archived: SessionRecord = {
    id: 's1',
    agentId: 'claude-code',
    acpSessionId: 'acp-1',
    projectPath: '/repo',
    title: 'Fix the build',
    createdAt: 1,
    updatedAt: 2,
    lastViewedAt: null,
    parentId: null,
    origin: 'user',
    description: null,
    branch: null,
    archivedAt: 3,
  }

  it('puts its project back in the list, which the sidebar shows it under', async () => {
    const store = sessionsFile(dir, log)
    store.save({ version: 1, sessions: [archived] })
    await store.flush()
    const { sessions, added } = manager()
    await sessions.load()
    await sessions.unarchive('s1')
    expect(added).toEqual(['/repo'])
  })
})

describe('archiving a session without its sub-sessions', () => {
  const record = (id: string, parentId: string | null, extra: Partial<SessionRecord> = {}) =>
    ({
      id,
      agentId: 'claude-code',
      acpSessionId: `acp-${id}`,
      projectPath: '/repo',
      title: id,
      createdAt: 1,
      updatedAt: 2,
      lastViewedAt: null,
      parentId,
      origin: 'user',
      description: null,
      branch: null,
      ...extra,
    }) satisfies SessionRecord

  async function loaded(records: SessionRecord[]) {
    const store = sessionsFile(dir, log)
    store.save({ version: 1, sessions: records })
    await store.flush()
    const { sessions } = manager()
    await sessions.load()
    return sessions
  }

  const tree = () => [
    record('p', null, { pinnedAt: 1 }),
    // A subagent of the session, and a sub-session under it, which is the session's too.
    record('a', 'p', { origin: 'subagent' }),
    record('c1', 'p'),
    record('c2', 'a'),
    record('g', 'c1'),
    record('gone', 'p', { archivedAt: 1 }),
  ]

  it('leaves its sub-sessions in the list on their own, and its subagents with it', async () => {
    const sessions = await loaded(tree())
    await sessions.archive('p', false)
    expect(sessions.summary('p')).toMatchObject({ archivedAt: expect.any(Number), pinnedAt: null })
    expect(sessions.summary('a').parentId).toBe('p')
    expect(sessions.summary('c1')).toMatchObject({ parentId: null, archivedAt: null })
    expect(sessions.summary('c2')).toMatchObject({ parentId: null, archivedAt: null })
    expect(sessions.summary('g').parentId).toBe('c1')
    expect(sessions.summary('gone').parentId).toBe('p')
    await sessions.flush()
    const left = (await index())?.sessions.find((item) => item.id === 'p')?.leftSubSessions
    expect(left?.toSorted()).toEqual(['c1', 'c2'])
  })

  it('puts them back under it when restored after a restart, unpinned, unless gone', async () => {
    const before = await loaded(tree())
    await before.archive('p', false)
    before.pin('c1', true)
    await before.delete('c2')
    await before.flush()
    const { sessions } = manager()
    await sessions.load()
    await sessions.unarchive('p')
    expect(sessions.summary('p').archivedAt).toBeNull()
    expect(sessions.summary('c1')).toMatchObject({ parentId: 'p', pinnedAt: null })
    expect(sessions.has('c2')).toBe(false)
    await sessions.flush()
    expect(
      (await index())?.sessions.find((item) => item.id === 'p')?.leftSubSessions,
    ).toBeUndefined()
  })

  it('archives the whole tree by default', async () => {
    const sessions = await loaded(tree())
    await sessions.archive('p')
    expect(sessions.summary('c1').parentId).toBe('p')
    expect(sessions.summary('c2').parentId).toBe('a')
    await sessions.flush()
    expect(
      (await index())?.sessions.find((item) => item.id === 'p')?.leftSubSessions,
    ).toBeUndefined()
  })
})

describe('answering a problem report', () => {
  const record: SessionRecord = {
    id: 's1',
    agentId: 'claude-code',
    acpSessionId: 'acp-1',
    projectPath: '/repo',
    title: 'Fix the build',
    createdAt: 1,
    updatedAt: 2,
    lastViewedAt: null,
    parentId: null,
    origin: 'user',
    description: null,
    branch: null,
  }
  const stored: StoredThread = {
    head: { agentId: 'claude-code', acpSessionId: 'acp-1' },
    session: {
      title: null,
      config: [],
      commands: [],
      usage: null,
      subagent: null,
      context: null,
      sideChat: null,
    },
    entries: [
      {
        pos: 0,
        entry: {
          kind: 'problem_report',
          id: 'e:1',
          title: 'Crash',
          details: 'It crashed',
          error: null,
          at: 1,
          outcome: null,
          after: null,
        },
      },
    ],
  }

  it('revives a session that was released, so its card still takes the answer', async () => {
    const store = sessionsFile(dir, log)
    store.save({ version: 1, sessions: [record] })
    await store.flush()
    const { sessions } = manager(
      {},
      { threads: { load: async () => stored, write: async () => undefined } },
    )
    await sessions.load()
    await sessions.answerReport('s1', 'e:1', { kind: 'skipped' })
    const snapshot = await sessions.snapshot('s1')
    expect(snapshot.entries.find((entry) => entry.id === 'e:1')).toMatchObject({
      outcome: { kind: 'skipped' },
    })
  })
})

describe('signing in', () => {
  it('settles the notice that asked for it once the agent reports it is signed in', async () => {
    let starts = 0
    const agents: Record<string, unknown> = {
      name: () => 'Agent',
      authRequired: () => {},
      ensureReady: async () => ({
        init: { capabilities: {} },
        connection: {
          newSession: () => {
            starts++
            // The retry after the sign-in is left starting.
            if (starts > 1) return new Promise(() => {})
            return Promise.reject(new HostError('auth_required', 'Run the login command'))
          },
        },
      }),
    }
    const { sessions, agents: hooked } = manager({}, { agents })
    await sessions.load()
    const summary = await sessions.create({
      agentId: 'cline',
      projectPath: '/repo',
      prompt: [{ type: 'text', text: 'Hello' }],
    })
    const notices = async () =>
      (await sessions.open(summary.id)).entries.filter((entry) => entry.kind === 'notice')
    expect(await notices()).toMatchObject([
      { severity: 'error', description: 'Run the login command' },
    ])
    hooked.hooks.signedIn('cline')

    await vi.waitFor(() => expect(starts).toBe(2))
    const [notice, ...rest] = await notices()
    expect(rest).toEqual([])
    expect(notice).toMatchObject({ severity: 'info' })
    expect(notice).not.toMatchObject({ description: 'Run the login command' })
  })
})
