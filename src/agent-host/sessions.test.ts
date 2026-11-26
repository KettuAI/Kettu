import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentOptionsFile, AgentOptionsStore } from './agent-options'
import type { AgentManager } from './agents'
import { Diagnostics } from './diagnostics'
import type { LastRequest, OutsideReader } from './outside-sessions'
import { preparedFile, PreparedRecords, type PreparedFile } from './prepared'
import type { Projects } from './projects'
import type { ScratchFolders } from './scratch'
import { HostError } from './errors'
import { SessionManager, type SessionEvents } from './sessions'
import { returnedFile, sessionsFile, type SessionRecord, type SessionsFile } from './storage'
import { EMPTY_SESSION, type StoredThread } from './threads/model'
import type { ThreadStore } from './threads/store'
import type { WorktreeInspection } from './worktrees/api'
import type { WorktreeManager } from './worktrees/manager'

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
    settings?: Record<string, unknown>
    options?: AgentOptionsStore
    prepared?: PreparedRecords
    worktrees?: Partial<WorktreeManager>
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
      whileOpening: (_agentId: string, start: Promise<unknown>) => start,
      runtime: () => null,
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
    diagnostics: new Diagnostics(),
    git: () => null,
    events: new Proxy({}, { get: () => () => {} }) as SessionEvents,
    settings: () => ({ startModes: {}, ...extra.settings }) as never,
    ...(extra.options ? { options: extra.options } : {}),
    ...(extra.outside ? { outside: extra.outside } : {}),
    ...(extra.prepared ? { prepared: extra.prepared } : {}),
    ...(extra.worktrees ? { worktrees: extra.worktrees as WorktreeManager } : {}),
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
        listSessions: async (_cwd: string | null, cursor: string | null) => {
          const at = cursor === null ? 0 : Number(cursor)
          return {
            sessions: pages[at].map((sessionId) => ({
              sessionId,
              title: null,
              updatedAt: null,
              cwd: _cwd ?? '/repo',
            })),
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

describe('cross-folder Codex session import into a target project', () => {
  interface FakeCodexSession {
    sessionId: string
    title: string | null
    updatedAt: string
    cwd: string
    history?: { user: string; reply: string }
  }

  function codexAgents(catalog: FakeCodexSession[]) {
    const listCalls: { cwd: string | null; cursor: string | null }[] = []
    const loadedCalls: { sessionId: string; cwd: string }[] = []
    const promptedCalls: { sessionId: string; text: string }[] = []
    const closedCalls: string[] = []
    const targets = new Map<string, { apply: (out: unknown) => void }>()

    const connection = {
      isClosed: false,
      closed: new Promise<void>(() => {}),
      listSessions: async (cwd: string | null, cursor: string | null) => {
        listCalls.push({ cwd, cursor })
        const filtered = cwd === null ? catalog : catalog.filter((item) => item.cwd === cwd)
        return {
          sessions: filtered.map(({ sessionId, title, updatedAt, cwd: itemCwd }) => ({
            sessionId,
            title,
            updatedAt,
            cwd: itemCwd,
          })),
          nextCursor: null,
        }
      },
      register: (sessionId: string, target: { apply: (out: unknown) => void }) => {
        targets.set(sessionId, target)
      },
      unregister: (sessionId: string) => {
        targets.delete(sessionId)
      },
      reopen: () => {},
      closeSession: async (sessionId: string) => {
        closedCalls.push(sessionId)
      },
      loadSession: async (sessionId: string, cwd: string) => {
        loadedCalls.push({ sessionId, cwd })
        const item = catalog.find((s) => s.sessionId === sessionId)
        const target = targets.get(sessionId)
        if (item?.history && target) {
          target.apply({
            patches: [
              {
                op: 'entry.add',
                entry: {
                  kind: 'user',
                  id: 'u-1',
                  content: [{ type: 'text', text: item.history.user }],
                },
              },
              {
                op: 'entry.add',
                entry: {
                  kind: 'agent',
                  id: 'a-1',
                  markdown: item.history.reply,
                  streaming: false,
                },
              },
            ],
            effects: [],
          })
        }
        return { config: [] }
      },
      resumeSession: async (sessionId: string, cwd: string) => {
        loadedCalls.push({ sessionId, cwd })
        return { config: [] }
      },
      prompt: async (sessionId: string, blocks: readonly { type: string; text?: string }[]) => {
        const text = blocks.map((b) => b.text ?? '').join('')
        promptedCalls.push({ sessionId, text })
        const target = targets.get(sessionId)
        target?.apply({
          patches: [
            {
              op: 'entry.add',
              entry: { kind: 'agent', id: 'a-2', markdown: `Continued: ${text}`, streaming: false },
            },
          ],
          effects: [],
        })
        return { stopReason: 'end_turn', tokens: null, models: [] }
      },
    }

    const runtime = {
      init: {
        capabilities: {
          listSessions: true,
          listAllSessions: true,
          loadSession: true,
          resumeSession: true,
          closeSession: true,
          prompt: { image: true, audio: false, embeddedContext: true },
        },
      },
      connection,
    }

    const agents = {
      name: () => 'Codex',
      signedIn: () => {},
      status: () => ({ capabilities: runtime.init.capabilities, limits: [] }),
      runtime: () => runtime,
      ensureReady: async () => runtime,
    }
    return { agents, listCalls, loadedCalls, promptedCalls, closedCalls }
  }

  const catalog: FakeCodexSession[] = [
    {
      sessionId: 'codex-exact',
      title: 'Current project work',
      updatedAt: '2026-11-26T09:00:00.000Z',
      cwd: '/projects/current',
    },
    {
      sessionId: 'codex-moved',
      title: 'Migrated repo conversation',
      updatedAt: '2026-11-26T08:00:00.000Z',
      cwd: '/old/deleted-repo',
      history: { user: 'Original question', reply: 'Original answer' },
    },
    {
      sessionId: 'codex-worktree',
      title: 'Worktree feature branch',
      updatedAt: '2026-11-26T07:00:00.000Z',
      cwd: '/worktrees/feat-import',
    },
  ]

  it('lists exact matches by default and all folders with original cwd when requested', async () => {
    const fake = codexAgents(catalog)
    const { sessions } = manager({}, { agents: fake.agents })
    await sessions.load()

    const exact = await sessions.listImportable('codex', '/projects/current', null, false)
    expect(exact.sessions).toEqual([
      {
        acpSessionId: 'codex-exact',
        title: 'Current project work',
        updatedAt: '2026-11-26T09:00:00.000Z',
        imported: false,
        cwd: '/projects/current',
      },
    ])

    const all = await sessions.listImportable('codex', '/projects/current', null, true)
    expect(all.sessions.map((s) => ({ id: s.acpSessionId, cwd: s.cwd }))).toEqual([
      { id: 'codex-exact', cwd: '/projects/current' },
      { id: 'codex-moved', cwd: '/old/deleted-repo' },
      { id: 'codex-worktree', cwd: '/worktrees/feat-import' },
    ])
    expect(fake.listCalls).toEqual([
      { cwd: '/projects/current', cursor: null },
      { cwd: null, cursor: null },
    ])
  })

  it('batch imports moved and worktree Codex sessions into a chosen target project and rejects unknown ids', async () => {
    const fake = codexAgents(catalog)
    const { sessions, added } = manager({}, { agents: fake.agents })
    await sessions.load()

    await sessions.listImportable('codex', '/projects/current', null, true)
    const first = await sessions.importSession({
      agentId: 'codex',
      projectPath: '/projects/current',
      acpSessionId: 'codex-moved',
    })
    const second = await sessions.importSession({
      agentId: 'codex',
      projectPath: '/projects/current',
      acpSessionId: 'codex-worktree',
    })

    expect(first).toMatchObject({
      agentId: 'codex',
      projectPath: '/projects/current',
      title: 'Migrated repo conversation',
    })
    expect(second).toMatchObject({
      agentId: 'codex',
      projectPath: '/projects/current',
      title: 'Worktree feature branch',
    })
    expect(sessions.list('/projects/current').map((s) => s.id)).toEqual([first.id, second.id])
    expect(added).toContain('/projects/current')

    await expect(
      sessions.importSession({
        agentId: 'codex',
        projectPath: '/projects/current',
        acpSessionId: 'does-not-exist',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })

    const listedAfter = await sessions.listImportable('codex', '/projects/other', null, true)
    expect(listedAfter.sessions.find((s) => s.acpSessionId === 'codex-moved')).toMatchObject({
      imported: true,
      importedProjectPath: '/projects/current',
    })
  })

  it('deduplicates re-imports, restores archived sessions, and updates target project when reassigned', async () => {
    const fake = codexAgents(catalog)
    const { sessions } = manager({}, { agents: fake.agents })
    await sessions.load()

    const imported = await sessions.importSession({
      agentId: 'codex',
      projectPath: '/projects/current',
      acpSessionId: 'codex-moved',
    })

    // Re-importing into the same project reuses the exact record without creating a duplicate.
    const sameAgain = await sessions.importSession({
      agentId: 'codex',
      projectPath: '/projects/current',
      acpSessionId: 'codex-moved',
    })
    expect(sameAgain.id).toBe(imported.id)
    expect(sessions.list('/projects/current')).toHaveLength(1)

    // Archiving then re-importing into another target project reuses the record, restores it, and moves it.
    await sessions.archive(imported.id)
    const reassigned = await sessions.importSession({
      agentId: 'codex',
      projectPath: '/projects/destination',
      acpSessionId: 'codex-moved',
    })
    expect(reassigned.id).toBe(imported.id)
    expect(reassigned.projectPath).toBe('/projects/destination')
    expect(reassigned.archivedAt).toBeNull()
    expect(sessions.list('/projects/current')).toHaveLength(0)
    expect(sessions.list('/projects/destination').map((s) => s.id)).toEqual([imported.id])
    await vi.waitFor(async () => expect((await index())?.sessions).toHaveLength(1))
  })

  it('opens and continues a migrated Codex session cleanly under the target project path', async () => {
    const fake = codexAgents(catalog)
    const { sessions } = manager({}, { agents: fake.agents })
    await sessions.load()

    const imported = await sessions.importSession({
      agentId: 'codex',
      projectPath: '/projects/new-home',
      acpSessionId: 'codex-moved',
    })

    const snap = await sessions.open(imported.id)
    expect(snap.session.status).toBe('ready')
    expect(fake.loadedCalls).toEqual([{ sessionId: 'codex-moved', cwd: '/projects/new-home' }])
    expect(snap.session.projectPath).toBe('/projects/new-home')
    expect(snap.entries).toMatchObject([
      { kind: 'user', content: [{ type: 'text', text: 'Original question' }] },
      { kind: 'agent', markdown: 'Original answer' },
    ])

    await sessions.prompt(imported.id, [{ type: 'text', text: 'Follow up' }])
    await vi.waitFor(() =>
      expect(fake.promptedCalls).toEqual([{ sessionId: 'codex-moved', text: 'Follow up' }]),
    )
    await vi.waitFor(async () => {
      const afterPrompt = await sessions.snapshot(imported.id)
      expect(afterPrompt.entries).toContainEqual(
        expect.objectContaining({
          kind: 'agent',
          markdown: 'Continued: Follow up',
        }),
      )
    })
    await sessions.flush()
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
    setAside: [],
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

describe('starting a session without a prepared one', () => {
  it('starts in the mode the settings name for new sessions, as a prepared one does', async () => {
    const mode = (value: string) => ({
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      value,
      choices: [
        { value: 'default', name: 'Default' },
        { value: 'auto', name: 'Auto' },
      ],
    })
    const setConfigOption = vi.fn(async (_session: string, _id: string, value: string) => [
      mode(value),
    ])
    const agents: Record<string, unknown> = {
      name: () => 'Google Antigravity',
      signedIn: () => {},
      ensureReady: async () => ({
        init: { capabilities: {} },
        connection: {
          newSession: async () => ({ sessionId: 'acp-1', config: [mode('default')] }),
          setConfigOption,
          prompt: () => new Promise(() => {}),
          register: () => {},
          unregister: () => {},
          isClosed: false,
        },
      }),
    }
    const { sessions } = manager({}, { agents, settings: { startModes: { antigravity: 'auto' } } })
    await sessions.load()
    await sessions.create({ agentId: 'antigravity', projectPath: '/repo' })
    await vi.waitFor(() => expect(setConfigOption).toHaveBeenCalledWith('acp-1', 'mode', 'auto'))
    await sessions.flush()
  })
})

describe('preparing and adopting sub-sessions under a worktree parent', () => {
  const BASE_OID = 'a'.repeat(40)

  async function preparedIndex(): Promise<PreparedFile | null> {
    try {
      return JSON.parse(await readFile(path.join(dir, 'state', 'prepared-sessions.json'), 'utf8'))
    } catch {
      return null
    }
  }

  function fakeAgent() {
    let seq = 0
    const newSession = vi.fn<(cwd: string) => Promise<{ sessionId: string; config: unknown[] }>>(
      async () => ({
        sessionId: `acp-${++seq}`,
        config: [],
      }),
    )
    const prompt = vi.fn(async () => ({ stopReason: 'end_turn', tokens: null, models: null }))
    const deleteSession = vi.fn(async () => {})
    const connection = {
      newSession,
      prompt,
      cancel: async () => {},
      deleteSession,
      register: () => {},
      unregister: () => {},
      isClosed: false,
    }
    const runtime = {
      agentId: 'claude-code' as const,
      init: { capabilities: { deleteSession: true } },
      connection,
    }
    return {
      newSession,
      prompt,
      deleteSession,
      agents: {
        name: () => 'Claude Code',
        signedIn: () => {},
        authRequired: () => {},
        status: () => ({
          capabilities: { prompt: { image: false, audio: false, embeddedContext: false } },
          limits: [],
        }),
        runtime: () => runtime,
        ensureReady: async () => runtime,
      },
    }
  }

  const parentRecord = (
    id: string,
    projectPath: string,
    worktree: NonNullable<SessionRecord['worktree']>,
  ): SessionRecord => ({
    id,
    agentId: 'claude-code',
    acpSessionId: `acp-${id}`,
    projectPath,
    worktree,
    title: 'Parent',
    createdAt: 1,
    updatedAt: 2,
    lastViewedAt: null,
    parentId: null,
    origin: 'user',
    description: null,
    branch: null,
  })

  it('opens the prepared session in the parent worktree and preserves it on adoption', async () => {
    const repo = path.join(dir, 'repo')
    const wtPath = path.join(dir, 'wt-0')
    await mkdir(repo, { recursive: true })
    await mkdir(wtPath, { recursive: true })
    const worktree = { path: wtPath, branch: 'kettu/wt-0', base: 'main', baseOid: BASE_OID }

    const store = sessionsFile(dir, log)
    store.save({ version: 1, sessions: [parentRecord('parent', repo, worktree)] })
    await store.flush()

    const prepared = new PreparedRecords(preparedFile(dir, log))
    await prepared.load()
    const agent = fakeAgent()
    const removeWorktree = vi.fn()
    const { sessions } = manager(
      {},
      {
        agents: agent.agents,
        prepared,
        worktrees: { remove: removeWorktree, settings: () => ({ waitForSetup: true }) as never },
      },
    )
    await sessions.load()

    const prep = await sessions.prepare(
      { agentId: 'claude-code', projectPath: repo, parentId: 'parent' },
      'win-1',
    )
    expect(agent.newSession).toHaveBeenCalledTimes(1)
    expect(agent.newSession.mock.calls[0]?.[0]).toBe(wtPath)
    expect(prep.parentId).toBe('parent')
    expect(prep.worktree).toMatchObject({ path: wtPath, branch: 'kettu/wt-0', state: 'ready' })
    await prepared.flush()
    expect((await preparedIndex())?.sessions).toEqual([
      { agentId: 'claude-code', acpSessionId: 'acp-1', cwd: wtPath },
    ])

    const child = await sessions.create({
      agentId: 'claude-code',
      projectPath: repo,
      parentId: 'parent',
      preparedId: prep.id,
      prompt: [{ type: 'text', text: 'Work in the worktree' }],
    })
    expect(child.id).toBe(prep.id)
    expect(child.parentId).toBe('parent')
    expect(child.worktree).toMatchObject({ path: wtPath, branch: 'kettu/wt-0', state: 'ready' })
    expect(agent.newSession).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1))

    await sessions.flush()
    await prepared.flush()
    expect((await preparedIndex())?.sessions).toEqual([])
    const persisted = (await index())?.sessions.find((item) => item.id === child.id)
    expect(persisted?.worktree).toEqual(worktree)

    // Deleting the child leaves the parent's worktree record and folder untouched.
    await sessions.delete(child.id)
    expect(removeWorktree).not.toHaveBeenCalled()
    expect(sessions.summary('parent').worktree).toMatchObject({
      path: wtPath,
      branch: 'kettu/wt-0',
      state: 'ready',
    })
  })

  it('does not mix main-repository and worktree-child prepared sessions in cache or adoption', async () => {
    const repo = path.join(dir, 'repo')
    const wtPath = path.join(dir, 'wt-0')
    await mkdir(repo, { recursive: true })
    await mkdir(wtPath, { recursive: true })
    const worktree = { path: wtPath, branch: 'kettu/wt-0', base: 'main', baseOid: BASE_OID }

    const store = sessionsFile(dir, log)
    store.save({ version: 1, sessions: [parentRecord('parent', repo, worktree)] })
    await store.flush()

    const agent = fakeAgent()
    const { sessions } = manager({}, { agents: agent.agents })
    await sessions.load()

    const mainPrep = await sessions.prepare({ agentId: 'claude-code', projectPath: repo }, 'win-1')
    const childPrep = await sessions.prepare(
      { agentId: 'claude-code', projectPath: repo, parentId: 'parent' },
      'win-1',
    )
    expect(childPrep.id).not.toBe(mainPrep.id)
    expect(agent.newSession.mock.calls.map((call) => call[0])).toEqual([repo, wtPath])

    // Adopting a main-repo prepared session when creating a worktree sub-session is refused.
    const otherMain = await sessions.prepare({ agentId: 'claude-code', projectPath: repo }, 'win-2')
    const child = await sessions.create({
      agentId: 'claude-code',
      projectPath: repo,
      parentId: 'parent',
      preparedId: otherMain.id,
    })
    expect(child.id).not.toBe(otherMain.id)
    expect(child.parentId).toBe('parent')
    expect(child.worktree).toMatchObject({ path: wtPath, branch: 'kettu/wt-0', state: 'ready' })
    expect(agent.newSession.mock.calls.at(-1)?.[0]).toBe(wtPath)
    await sessions.flush()
  })

  it('recreates a missing parent worktree during prepare via cwdOf', async () => {
    const repo = path.join(dir, 'repo')
    const wtPath = path.join(dir, 'wt-missing')
    await mkdir(repo, { recursive: true })
    const worktree = {
      path: wtPath,
      branch: 'kettu/wt-missing',
      base: 'main',
      baseOid: BASE_OID,
      removed: 'worktree' as const,
    }

    const store = sessionsFile(dir, log)
    store.save({ version: 1, sessions: [parentRecord('parent', repo, worktree)] })
    await store.flush()

    const recreate = vi.fn(async (_project: string, record: { path: string }) => {
      await mkdir(record.path, { recursive: true })
    })
    const agent = fakeAgent()
    const { sessions } = manager({}, { agents: agent.agents, worktrees: { recreate } })
    await sessions.load()

    const prep = await sessions.prepare(
      { agentId: 'claude-code', projectPath: repo, parentId: 'parent' },
      'win-1',
    )
    expect(recreate).toHaveBeenCalledTimes(1)
    expect(agent.newSession).toHaveBeenCalledTimes(1)
    expect(agent.newSession.mock.calls[0]?.[0]).toBe(wtPath)
    expect(prep.worktree?.state).toBe('ready')
    expect(sessions.summary('parent').worktree?.state).toBe('ready')
  })

  it('rejects prepare cleanly without falling back to the project folder when the parent branch is gone', async () => {
    const repo = path.join(dir, 'repo')
    const wtPath = path.join(dir, 'wt-gone')
    await mkdir(repo, { recursive: true })
    const worktree = { path: wtPath, branch: 'kettu/wt-gone', base: 'main', baseOid: BASE_OID }

    const store = sessionsFile(dir, log)
    store.save({ version: 1, sessions: [parentRecord('parent', repo, worktree)] })
    await store.flush()

    const recreate = vi.fn(async () => {
      throw new HostError('not_found', 'Branch not found')
    })
    const agent = fakeAgent()
    const { sessions } = manager({}, { agents: agent.agents, worktrees: { recreate } })
    await sessions.load()

    await expect(
      sessions.prepare({ agentId: 'claude-code', projectPath: repo, parentId: 'parent' }, 'win-1'),
    ).rejects.toMatchObject({ code: 'restricted' })
    expect(agent.newSession).not.toHaveBeenCalled()
    expect(sessions.summary('parent').worktree?.state).toBe('gone')
  })

  it('hides prepared sub-sessions from inspectWorktree and drops them on removeWorktree', async () => {
    const repo = path.join(dir, 'repo')
    const wtPath = path.join(dir, 'wt-shared')
    await mkdir(repo, { recursive: true })
    await mkdir(wtPath, { recursive: true })
    const worktree = { path: wtPath, branch: 'kettu/wt-shared', base: 'main', baseOid: BASE_OID }

    const store = sessionsFile(dir, log)
    store.save({
      version: 1,
      sessions: [
        parentRecord('parent', repo, { ...worktree }),
        parentRecord('other', repo, { ...worktree }),
      ],
    })
    await store.flush()

    const inspection: WorktreeInspection = {
      exists: true,
      branchExists: true,
      head: BASE_OID,
      uncommitted: 0,
      unpushed: 0,
      merged: false,
    }
    const prepared = new PreparedRecords(preparedFile(dir, log))
    await prepared.load()
    const agent = fakeAgent()
    const remove = vi.fn(async () => {
      await rm(wtPath, { recursive: true, force: true })
      return { branchDeleted: false }
    })
    const recreate = vi.fn(async (_project: string, record: { path: string }) => {
      await mkdir(record.path, { recursive: true })
    })
    const { sessions } = manager(
      {},
      {
        agents: agent.agents,
        prepared,
        worktrees: {
          inspect: async () => inspection,
          stop: () => {},
          remove,
          recreate,
        },
      },
    )
    await sessions.load()

    const prep = await sessions.prepare(
      { agentId: 'claude-code', projectPath: repo, parentId: 'parent' },
      'win-1',
    )
    const inspected = await sessions.inspectWorktree('other')
    expect(inspected.others).toEqual(['parent'])

    await sessions.removeWorktree('parent', 'keep', inspection)
    await prepared.flush()
    expect((await preparedIndex())?.sessions).toEqual([])

    // Creating with the dropped preparedId falls back to a fresh session and recreates the worktree.
    const child = await sessions.create({
      agentId: 'claude-code',
      projectPath: repo,
      parentId: 'parent',
      preparedId: prep.id,
    })
    expect(child.id).not.toBe(prep.id)
    expect(recreate).toHaveBeenCalledTimes(1)
    expect(child.worktree?.state).toBe('ready')
    expect(agent.newSession.mock.calls.at(-1)?.[0]).toBe(wtPath)
    await sessions.flush()
  })
})

describe('empty-replay guard and recovery of cached empty imported threads', () => {
  function agyConnection(
    onLoad: (sessionId: string, target: { apply: (out: unknown) => void }) => Promise<void>,
  ) {
    const targets = new Map<string, { apply: (out: unknown) => void }>()
    const loadSession = vi.fn(async (sessionId: string) => {
      const target = targets.get(sessionId)
      if (target) await onLoad(sessionId, target)
      return { config: [] }
    })
    const agents = {
      name: () => 'Google Antigravity',
      signedIn: () => {},
      status: () => ({ capabilities: null, limits: [] }),
      refreshLimits: async () => {},
      ensureReady: async () => ({
        agentId: 'antigravity',
        kettu: false,
        init: {
          name: 'Antigravity',
          version: '1.5.18',
          capabilities: {
            loadSession: true,
            listSessions: true,
            resumeSession: true,
            closeSession: true,
            deleteSession: false,
            forkSession: false,
            forkAtMessage: false,
            ownTitles: null,
            logout: false,
            steering: false,
            mcpHttp: true,
            mcpSse: false,
            mcpStdio: true,
            prompt: { image: false, audio: false, embeddedContext: false },
          },
          authMethods: [],
          raw: null,
        },
        connection: {
          closed: new Promise<void>(() => {}),
          isClosed: false,
          close: () => {},
          register: (id: string, target: { apply: (out: unknown) => void }) => {
            targets.set(id, target)
          },
          unregister: (id: string) => {
            targets.delete(id)
          },
          reopen: () => {},
          listSessions: async () => ({
            sessions: [{ sessionId: 'ide-1', title: 'IDE Chat', updatedAt: null, cwd: '/repo' }],
            nextCursor: null,
          }),
          loadSession,
          resumeSession: async () => ({ config: [] }),
          prompt: async (id: string) => {
            targets.get(id)?.apply({
              patches: [
                {
                  op: 'entry.add',
                  entry: {
                    kind: 'agent',
                    id: 'a:1',
                    content: [{ type: 'text', text: 'Reply after empty replay' }],
                    streaming: false,
                  },
                },
              ],
              effects: [],
            })
            return { stopReason: 'end_turn', tokens: null, models: [] }
          },
        },
      }),
    }
    return { agents, loadSession }
  }

  it('does not cache a 0-entry replay to threads.db, and caches once entries later arrive', async () => {
    const writes: unknown[] = []
    const threads: Partial<ThreadStore> = {
      page: vi.fn(async () => null),
      load: vi.fn(async () => null),
      origins: vi.fn(async () => []),
      write: vi.fn(async (_id, change) => {
        writes.push(change)
      }),
    }
    const { agents, loadSession } = agyConnection(async (_id, target) => {
      // Simulate agy emitting only a session_info_update (title) and 0 message entries.
      target.apply({
        patches: [{ op: 'session.update', changes: { title: 'IDE Chat' } }],
        effects: [],
      })
    })
    const { sessions } = manager({}, { agents, threads })
    await sessions.load()

    const imported = await sessions.importSession({
      agentId: 'antigravity',
      projectPath: '/repo',
      acpSessionId: 'ide-1',
    })
    await vi.waitFor(async () =>
      expect((await index())?.sessions[0]).toMatchObject({
        id: imported.id,
        acpSessionId: 'ide-1',
        imported: true,
      }),
    )

    const snapshot = await sessions.open(imported.id)
    expect(loadSession).toHaveBeenCalledTimes(1)
    expect(snapshot.entries).toEqual([])
    expect(writes).toEqual([])

    // Sending a prompt adds entries and lifts the empty-replay guard so the thread persists normally.
    await sessions.prompt(imported.id, [{ type: 'text', text: 'Hello' }])
    await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0))
    await sessions.flush()
  })

  it('re-loads previously cached empty Antigravity imported threads on open and caches the recovered history', async () => {
    const record: SessionRecord = {
      id: 'legacy-ide-session',
      agentId: 'antigravity',
      acpSessionId: 'ide-1',
      projectPath: '/repo',
      title: null,
      createdAt: 1,
      updatedAt: 2,
      lastViewedAt: null,
      parentId: null,
      origin: 'user',
      description: null,
      branch: null,
    }
    const store = sessionsFile(dir, log)
    store.save({ version: 1, sessions: [record] })
    await store.flush()

    const writes: { entries: unknown[] }[] = []
    const threads: Partial<ThreadStore> = {
      // Simulate an empty cached thread persisted by an older Kettu version (next_pos = 0, entries = []).
      page: vi.fn(async () => ({
        head: { agentId: 'antigravity' as const, acpSessionId: 'ide-1' },
        session: EMPTY_SESSION,
        entries: [],
        from: 0,
        older: null,
        plan: null,
      })),
      load: vi.fn(async () => ({
        head: { agentId: 'antigravity' as const, acpSessionId: 'ide-1' },
        session: EMPTY_SESSION,
        entries: [],
        setAside: [],
      })),
      origins: vi.fn(async () => []),
      write: vi.fn(async (_id, change) => {
        writes.push({ entries: change.entries })
      }),
    }
    const { agents, loadSession } = agyConnection(async (_id, target) => {
      target.apply({
        patches: [
          {
            op: 'entry.add',
            entry: { kind: 'user', id: 'u:1', content: [{ type: 'text', text: 'From IDE' }] },
          },
          {
            op: 'entry.add',
            entry: {
              kind: 'agent',
              id: 'a:1',
              content: [{ type: 'text', text: 'Recovered reply' }],
              streaming: false,
            },
          },
        ],
        effects: [],
      })
    })
    const { sessions } = manager({}, { agents, threads })
    await sessions.load()

    const snapshot = await sessions.open(record.id)
    expect(loadSession).toHaveBeenCalledTimes(1)
    expect(snapshot.entries).toHaveLength(2)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.entries).toHaveLength(2)
  })

  it('does not re-load a rewound session whose entries were moved to set_aside', async () => {
    const record: SessionRecord = {
      id: 'rewound-1',
      agentId: 'antigravity',
      acpSessionId: 'ide-1',
      projectPath: '/repo',
      title: 'Edited',
      createdAt: 1,
      updatedAt: 2,
      lastViewedAt: null,
      parentId: null,
      origin: 'user',
      description: null,
      branch: null,
      imported: true,
      rewound: {
        entryId: 'u:1',
        turns: 1,
        draft: [{ type: 'text', text: 'Edited prompt' }],
        used: null,
        point: { ref: null, text: 'Old prompt', occurrence: 1 },
      },
    }
    const store = sessionsFile(dir, log)
    store.save({ version: 1, sessions: [record] })
    await store.flush()

    const threads: Partial<ThreadStore> = {
      page: vi.fn(async () => ({
        head: { agentId: 'antigravity' as const, acpSessionId: 'ide-1' },
        session: { ...EMPTY_SESSION, title: 'Edited' },
        entries: [],
        from: 2,
        older: null,
        plan: null,
      })),
    }
    const { agents, loadSession } = agyConnection(async () => {})
    const { sessions } = manager({}, { agents, threads })
    await sessions.load()

    const snapshot = await sessions.open(record.id)
    expect(loadSession).not.toHaveBeenCalled()
    expect(snapshot.entries).toEqual([])
  })
})

describe('preserving prepared session options when creating a worktree session', () => {
  const BASE_OID = 'b'.repeat(40)

  const makeConfig = (mode = 'default', custom = 'off') => [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode' as const,
      type: 'select' as const,
      value: mode,
      choices: [
        { value: 'default', name: 'Ask' },
        { value: 'acceptEdits', name: 'Accept edits' },
        { value: 'plan', name: 'Plan' },
        { value: 'bypassPermissions', name: 'Full access' },
      ],
    },
    {
      id: 'sandbox_net',
      name: 'Network',
      category: 'other' as const,
      type: 'select' as const,
      value: custom,
      choices: [
        { value: 'off', name: 'Off' },
        { value: 'on', name: 'On' },
      ],
    },
  ]

  function configurableAgent() {
    let seq = 0
    const configs = new Map<string, ReturnType<typeof makeConfig>>()
    const newSession = vi.fn<
      (
        cwd: string,
        options?: { fullAccess?: boolean },
      ) => Promise<{ sessionId: string; config: ReturnType<typeof makeConfig> }>
    >(async () => {
      const sessionId = `acp-${++seq}`
      const config = makeConfig('default', 'off')
      configs.set(sessionId, config)
      return { sessionId, config }
    })
    const setConfigOption = vi.fn(async (sessionId: string, optionId: string, value: string) => {
      const next = (configs.get(sessionId) ?? makeConfig()).map((option) =>
        option.id === optionId ? { ...option, value } : option,
      )
      configs.set(sessionId, next)
      return next
    })
    const deleteSession = vi.fn(async () => {})
    const connection = {
      newSession,
      setConfigOption,
      prompt: vi.fn(async () => ({ stopReason: 'end_turn', tokens: null, models: null })),
      cancel: async () => {},
      deleteSession,
      register: () => {},
      unregister: () => {},
      isClosed: false,
    }
    const runtime = (agentId: 'claude-code' | 'codex') => ({
      agentId,
      init: { capabilities: { deleteSession: true } },
      connection,
    })
    return {
      newSession,
      setConfigOption,
      configs,
      agents: {
        name: (id: string) => (id === 'codex' ? 'Codex' : 'Claude Code'),
        signedIn: () => {},
        authRequired: () => {},
        status: () => ({
          capabilities: { prompt: { image: false, audio: false, embeddedContext: false } },
          limits: [],
        }),
        runtime: (id: 'claude-code' | 'codex') => runtime(id),
        ensureReady: async (id: 'claude-code' | 'codex') => runtime(id),
      },
    }
  }

  it('carries prepared mode and non-remembered options into a new worktree without remembering mode', async () => {
    const repo = path.join(dir, 'repo')
    const wt1 = path.join(dir, 'wt-1')
    const wt2 = path.join(dir, 'wt-2')
    await mkdir(repo, { recursive: true })
    await mkdir(wt1, { recursive: true })
    await mkdir(wt2, { recursive: true })

    let wtCount = 0
    const worktrees: Partial<WorktreeManager> = {
      create: async () => {
        const wtPath = ++wtCount === 1 ? wt1 : wt2
        return {
          path: wtPath,
          branch: `kettu/wt-${wtCount}`,
          base: 'main',
          baseOid: BASE_OID,
        }
      },
      settings: () => ({ waitForSetup: false }) as never,
      prepare: async () => ({ state: 'ready' }),
    }
    const optionsStore = new AgentOptionsStore({
      file: agentOptionsFile(dir, log),
      changed: () => {},
    })
    await optionsStore.load()

    const agent = configurableAgent()
    const { sessions } = manager(
      {},
      {
        agents: agent.agents,
        options: optionsStore,
        settings: { startModes: { 'claude-code': 'acceptEdits' } },
        worktrees,
      },
    )
    await sessions.load()

    const prep = await sessions.prepare({ agentId: 'claude-code', projectPath: repo }, 'win-1')
    await sessions.setConfigOption(prep.id, 'mode', 'bypassPermissions')
    await sessions.setConfigOption(prep.id, 'sandbox_net', 'on')

    const created = await sessions.create(
      {
        agentId: 'claude-code',
        projectPath: repo,
        preparedId: prep.id,
        worktree: { base: 'main' },
      },
      'win-1',
    )
    expect(created.id).not.toBe(prep.id)
    expect(agent.newSession.mock.calls[1]?.[0]).toBe(wt1)
    expect(agent.newSession.mock.calls[1]?.[1]?.fullAccess).toBe(true)
    expect(agent.configs.get('acp-2')?.find((o) => o.id === 'mode')?.value).toBe(
      'bypassPermissions',
    )
    expect(agent.configs.get('acp-2')?.find((o) => o.id === 'sandbox_net')?.value).toBe('on')

    // One-off mode and non-remembered options must not be remembered for subsequent sessions.
    expect(optionsStore.rememberedOf('claude-code')).toEqual({})
    await sessions.discard(prep.id)

    const next = await sessions.create(
      {
        agentId: 'claude-code',
        projectPath: repo,
        worktree: { base: 'main' },
      },
      'win-1',
    )
    expect(next.id).not.toBe(created.id)
    expect(agent.newSession.mock.calls[2]?.[1]?.fullAccess).toBeUndefined()
    expect(agent.configs.get('acp-3')?.find((o) => o.id === 'mode')?.value).toBe('acceptEdits')
    expect(agent.configs.get('acp-3')?.find((o) => o.id === 'sandbox_net')?.value).toBe('off')
    await sessions.flush()
    await optionsStore.flush()
  })

  it('gives explicit create options priority over prepared config and ignores mismatched agents', async () => {
    const repo = path.join(dir, 'repo')
    const wt1 = path.join(dir, 'wt-1')
    const wt2 = path.join(dir, 'wt-2')
    await mkdir(repo, { recursive: true })
    await mkdir(wt1, { recursive: true })
    await mkdir(wt2, { recursive: true })

    let wtCount = 0
    const worktrees: Partial<WorktreeManager> = {
      create: async () => ({
        path: ++wtCount === 1 ? wt1 : wt2,
        branch: `kettu/wt-${wtCount}`,
        base: 'main',
        baseOid: BASE_OID,
      }),
      settings: () => ({ waitForSetup: false }) as never,
      prepare: async () => ({ state: 'ready' }),
    }
    const agent = configurableAgent()
    const { sessions } = manager(
      {},
      {
        agents: agent.agents,
        settings: { startModes: { 'claude-code': 'acceptEdits' } },
        worktrees,
      },
    )
    await sessions.load()

    const prep = await sessions.prepare({ agentId: 'claude-code', projectPath: repo }, 'win-1')
    await sessions.setConfigOption(prep.id, 'mode', 'bypassPermissions')

    // Explicit options override the prepared session's mode.
    await sessions.create(
      {
        agentId: 'claude-code',
        projectPath: repo,
        preparedId: prep.id,
        options: { mode: 'plan' },
        worktree: { base: 'main' },
      },
      'win-1',
    )
    expect(agent.configs.get('acp-2')?.find((o) => o.id === 'mode')?.value).toBe('plan')

    // Passing a Claude preparedId when creating a Codex session must not leak Claude's options.
    await sessions.create(
      {
        agentId: 'codex',
        projectPath: repo,
        preparedId: prep.id,
        worktree: { base: 'main' },
      },
      'win-1',
    )
    expect(agent.configs.get('acp-3')?.find((o) => o.id === 'mode')?.value).toBe('default')
    await sessions.flush()
  })
})
