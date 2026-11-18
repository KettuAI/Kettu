import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentManager } from './agents'
import type { Diagnostics } from './diagnostics'
import type { LastRequest, OutsideReader } from './outside-sessions'
import type { Projects } from './projects'
import type { ScratchFolders } from './scratch'
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
  return { sessions: new SessionManager(deps), added }
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
    const { sessions } = manager()
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
    const { sessions } = manager({}, { outside: reader(true) })
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
    const { sessions } = manager({}, { outside: reader(false) })
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
