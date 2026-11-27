import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigOption, StopReason } from '@shared/thread'
import { agentOptionsFile, AgentOptionsStore } from './agent-options'
import type { AgentManager } from './agents'
import { CLAUDE_CODE } from './catalog'
import { claudeSdkDriver } from './claude/driver'
import type { SdkMessage } from './claude/sdk'
import type { OwnTitles, SessionOptions, SessionTarget } from './connection'
import { Diagnostics } from './diagnostics'
import type { LastRequest, OutsideReader } from './outside-sessions'
import { preparedFile, PreparedRecords, type PreparedFile } from './prepared'
import { Projects } from './projects'
import type { ScratchFolders } from './scratch'
import { HostError } from './errors'
import {
  SessionManager,
  type SessionEvents,
  type SessionManagerDeps,
  type SessionTimings,
} from './sessions'
import {
  projectsFile,
  returnedFile,
  sessionsFile,
  type SessionRecord,
  type SessionsFile,
} from './storage'
import { FakeChild, FakeClaudeSdk } from './testing/fake-claude-sdk'
import { EMPTY_SESSION, type StoredThread } from './threads/model'
import type { ThreadStore } from './threads/store'
import type { WorktreeInspection } from './worktrees/api'
import type { WorktreeManager } from './worktrees/manager'

let dir: string
const managers: SessionManager[] = []

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-sessions-'))
})

afterEach(async () => {
  const created = managers.splice(0)
  for (const sessions of created) sessions.shutdown()
  await Promise.all(created.map((sessions) => sessions.flush()))
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
    timings?: Partial<SessionTimings>
    settingsTargets?: SessionManagerDeps['settingsTargets']
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
    projects: (projects instanceof Projects
      ? projects
      : {
          list: () => [],
          resolveDirectory: async (folder: string) => folder,
          add: async (folder: string) => {
            added.push(folder)
          },
          ...projects,
        }) as unknown as Projects,
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
    ...(extra.timings ? { timings: extra.timings } : {}),
    ...(extra.settingsTargets ? { settingsTargets: extra.settingsTargets } : {}),
  } satisfies ConstructorParameters<typeof SessionManager>[0]
  const sessions = new SessionManager(deps)
  managers.push(sessions)
  return { sessions, added, agents: deps.agents }
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
    await sessions.flush()
    expect((await index())?.sessions).toMatchObject([
      { id: imported.id, projectPath: '/projects/destination' },
    ])
    expect((await index())?.sessions[0]?.archivedAt).toBeUndefined()
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

  it('unarchives the owning project when restoring one of its archived sessions', async () => {
    const store = sessionsFile(dir, log)
    store.save({ version: 1, sessions: [archived] })
    await store.flush()
    const registry = new Projects({
      file: projectsFile(dir, log),
      platform: 'darwin',
      now: () => 50,
      realpath: async (value) => value,
      isDirectory: async () => true,
    })
    await registry.load()
    await registry.add('/repo')
    registry.archive(registry.matchPrimary('/repo'))
    expect(registry.list()[0]?.archivedAt).toBe(50)

    const { sessions } = manager(registry as unknown as Partial<Projects>)
    await sessions.load()
    await sessions.unarchive('s1')
    expect(registry.list()[0]?.archivedAt).toBeNull()
    expect(sessions.summary('s1').archivedAt).toBeNull()
  })
})

describe('archiving a project while preserving session history', () => {
  it('keeps active and archived session records intact and blocks prompts until unarchived', async () => {
    const activeRecord: SessionRecord = {
      id: 'active-1',
      agentId: 'claude-code',
      acpSessionId: 'acp-active-1',
      projectPath: '/work/repo',
      title: 'Active thread',
      createdAt: 1,
      updatedAt: 20,
      lastViewedAt: null,
      parentId: null,
      origin: 'user',
      description: null,
      branch: 'main',
    }
    const extraFolderRecord: SessionRecord = {
      id: 'extra-1',
      agentId: 'claude-code',
      acpSessionId: 'acp-extra-1',
      projectPath: '/work/repo-docs',
      projectOwner: '/work/repo',
      title: 'Docs thread',
      createdAt: 2,
      updatedAt: 25,
      lastViewedAt: null,
      parentId: null,
      origin: 'user',
      description: null,
      branch: null,
    }
    const previouslyArchived: SessionRecord = {
      id: 'old-archived',
      agentId: 'claude-code',
      acpSessionId: 'acp-old',
      projectPath: '/work/repo',
      title: 'Old archived thread',
      createdAt: 3,
      updatedAt: 10,
      lastViewedAt: null,
      parentId: null,
      origin: 'user',
      description: null,
      branch: null,
      archivedAt: 15,
    }
    const otherProject: SessionRecord = {
      id: 'other-1',
      agentId: 'claude-code',
      acpSessionId: 'acp-other',
      projectPath: '/work/other',
      title: 'Other project thread',
      createdAt: 4,
      updatedAt: 30,
      lastViewedAt: null,
      parentId: null,
      origin: 'user',
      description: null,
      branch: null,
    }

    const store = sessionsFile(dir, log)
    store.save({
      version: 1,
      sessions: [activeRecord, extraFolderRecord, previouslyArchived, otherProject],
    })
    await store.flush()

    const registry = new Projects({
      file: projectsFile(dir, log),
      platform: 'darwin',
      now: () => 100,
      realpath: async (value) => value,
      isDirectory: async () => true,
    })
    await registry.load()
    await registry.add('/work/repo')
    await registry.update(registry.matchPrimary('/work/repo'), {
      folders: ['/work/repo', '/work/repo-docs'],
    })
    await registry.add('/work/other')

    const { sessions } = manager(registry as unknown as Partial<Projects>)
    await sessions.load()

    const projectRecord = registry.matchPrimary('/work/repo')
    await sessions.archiveProject(projectRecord.path, projectRecord.folders)
    registry.archive(projectRecord)

    // All historical sessions stay in the index with their original per-session archive states.
    expect(sessions.has('active-1')).toBe(true)
    expect(sessions.has('extra-1')).toBe(true)
    expect(sessions.has('old-archived')).toBe(true)
    expect(sessions.has('other-1')).toBe(true)
    expect(sessions.summary('active-1').archivedAt).toBeNull()
    expect(sessions.summary('extra-1').archivedAt).toBeNull()
    expect(sessions.summary('old-archived').archivedAt).toBe(15)

    // Sending a prompt to a session inside an archived project is refused until restored.
    await expect(sessions.prompt('active-1', [{ type: 'text', text: 'hi' }])).rejects.toMatchObject(
      { code: 'restricted' },
    )
    await expect(sessions.prompt('extra-1', [{ type: 'text', text: 'hi' }])).rejects.toMatchObject({
      code: 'restricted',
    })

    // Unarchiving the project restores its state without unarchiving individually archived sessions.
    registry.unarchive(projectRecord)
    expect(registry.matchPrimary('/work/repo').archivedAt).toBeUndefined()
    expect(sessions.summary('active-1').archivedAt).toBeNull()
    expect(sessions.summary('old-archived').archivedAt).toBe(15)
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

describe('agent-given session titles', () => {
  function titleAgent(opts: {
    ownTitles: OwnTitles | null
    listedTitle?: string | null
    writtenTitle?: string
    onPrompt?: (acpId: string, target: SessionTarget) => void | Promise<void>
    onLoad?: (acpId: string, target: SessionTarget) => void | Promise<void>
    holdWrite?: () => Promise<string>
  }) {
    let seq = 0
    const targets = new Map<string, SessionTarget>()
    const defaultConfig = () => [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode' as const,
        type: 'select' as const,
        value: 'default',
        choices: [{ value: 'default', name: 'Default' }],
      },
    ]
    const newSession = vi.fn(async (_cwd: string, options?: SessionOptions) => ({
      sessionId: `${options?.hidden ? 'hidden' : 'acp'}-${++seq}`,
      config: defaultConfig(),
    }))
    const collect = vi.fn(async () => {
      const title = opts.holdWrite ? await opts.holdWrite() : (opts.writtenTitle ?? 'Written title')
      return [JSON.stringify({ '0': title })]
    })
    const listSessions = vi.fn(async () => ({
      sessions: [...targets.keys()].map((sessionId) => ({
        sessionId,
        title: opts.listedTitle ?? 'Listed title',
        updatedAt: null,
        cwd: '/repo',
      })),
      nextCursor: null,
    }))
    const prompt = vi.fn(async (id: string) => {
      const target = targets.get(id)
      if (target && opts.onPrompt) await opts.onPrompt(id, target)
      return { stopReason: 'end_turn' as const, tokens: null, models: [] }
    })
    const connection = {
      closed: new Promise<void>(() => {}),
      isClosed: false,
      hiddenSessions: true,
      close: () => {},
      register: (id: string, target: SessionTarget) => {
        targets.set(id, target)
      },
      unregister: (id: string) => {
        targets.delete(id)
      },
      reopen: () => {},
      newSession,
      setConfigOption: async () => defaultConfig(),
      loadSession: async (id: string) => {
        const target = targets.get(id)
        if (target && opts.onLoad) await opts.onLoad(id, target)
        return { config: defaultConfig() }
      },
      resumeSession: async () => ({ config: defaultConfig() }),
      listSessions,
      collect,
      removeHidden: async () => {},
      cancel: async () => {},
      prompt,
    }
    const runtime = {
      agentId: 'claude-code' as const,
      kettu: false,
      init: {
        name: 'Agent',
        version: '1.0.0',
        capabilities: {
          loadSession: true,
          listSessions: true,
          resumeSession: true,
          closeSession: false,
          deleteSession: false,
          forkSession: false,
          forkAtMessage: false,
          ownTitles: opts.ownTitles,
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
      connection,
    }
    const agents = {
      name: () => 'Agent',
      signedIn: () => {},
      status: () => ({ capabilities: runtime.init.capabilities, limits: [] }),
      hasContext: () => false,
      refreshLimits: async () => {},
      runtime: () => runtime,
      ensureReady: async () => runtime,
    }
    return { agents, targets, newSession, collect, listSessions, prompt }
  }

  const titleSettings = { sessionTitles: true, lightModel: { mode: 'small' as const } }

  it('keeps an explicit start_session title against agent title updates and allows user rename', async () => {
    const agent = titleAgent({
      ownTitles: 'sent',
      onPrompt: (_id, target) => {
        // Agent emits a model-written title update and then a null title clear during the turn.
        target.apply({
          patches: [
            {
              op: 'session.update',
              changes: { title: 'KETTU_USER_DATA and debug port isolation', updatedAt: 999_999 },
            },
          ],
          effects: [{ kind: 'title', title: 'KETTU_USER_DATA and debug port isolation' }],
        })
        target.apply({
          patches: [{ op: 'session.update', changes: { title: null } }],
          effects: [{ kind: 'title', title: null }],
        })
      },
    })
    const { sessions } = manager({}, { agents: agent.agents, settings: titleSettings })
    await sessions.load()

    const caller = await sessions.create({ agentId: 'claude-code', projectPath: '/repo' })
    const startedId = await sessions.startFromTool(caller.id, {
      prompt: 'Check KETTU_USER_DATA and debug port isolation across windows',
      title: 'Keep this title',
      options: {},
      report: false,
    })
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(sessions.summary(startedId).status).toBe('ready'))

    expect(agent.newSession.mock.calls[1]?.[1]?.titled).toBe(true)
    expect(sessions.title(startedId)).toBe('Keep this title')
    expect(sessions.summary(startedId).title).toBe('Keep this title')
    expect(sessions.sessionInfo(startedId)?.title).toBe('Keep this title')

    // Post-turn updates keep non-title fields (like updatedAt) while stripping generated titles.
    const target = agent.targets.get('acp-2')!
    target.apply({
      patches: [
        {
          op: 'session.update',
          changes: { title: 'Late generated title', updatedAt: 999_999 },
        },
      ],
      effects: [{ kind: 'title', title: 'Late generated title' }],
    })
    expect(sessions.summary(startedId).title).toBe('Keep this title')
    expect(sessions.summary(startedId).updatedAt).toBe(999_999)

    await sessions.flush()
    const saved = (await index())?.sessions.find((record) => record.id === startedId)
    expect(saved?.title).toBe('Keep this title')
    expect(saved?.titleSource).toBe('given')

    // An explicit agent rename updates the given title and stays protected from generated updates.
    sessions.renameByAgent(startedId, 'Agent renamed')
    expect(sessions.summary(startedId).title).toBe('Agent renamed')
    target.apply({
      patches: [{ op: 'session.update', changes: { title: 'Another generated title' } }],
      effects: [{ kind: 'title', title: 'Another generated title' }],
    })
    expect(sessions.summary(startedId).title).toBe('Agent renamed')

    // Explicit user rename overrides the given title and stays over subsequent agent renames.
    sessions.rename(startedId, 'User title')
    expect(sessions.title(startedId)).toBe('User title')
    expect(sessions.summary(startedId).title).toBe('User title')
    sessions.renameByAgent(startedId, 'Should not override user')
    expect(sessions.summary(startedId).title).toBe('User title')

    // Clearing the user's custom title reveals the preserved given title, not a generated one.
    sessions.rename(startedId, null)
    expect(sessions.summary(startedId).title).toBe('Agent renamed')
    await sessions.flush()
  })

  it('skips Kettu auto-titling and listed-title reads when start_session gives a title', async () => {
    const written = titleAgent({ ownTitles: null, writtenTitle: 'Auto written title' })
    const { sessions: s1 } = manager({}, { agents: written.agents, settings: titleSettings })
    await s1.load()
    const caller1 = await s1.create({ agentId: 'claude-code', projectPath: '/repo' })
    const started1 = await s1.startFromTool(caller1.id, {
      prompt: 'Investigate startup timing across multiple host windows',
      title: 'Startup timing',
      options: {},
      report: false,
    })
    await vi.waitFor(() => expect(written.prompt).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(s1.summary(started1).status).toBe('ready'))
    expect(written.collect).not.toHaveBeenCalled()
    expect(s1.summary(started1).title).toBe('Startup timing')
    await s1.flush()

    const listed = titleAgent({ ownTitles: 'listed', listedTitle: 'Listed replacement' })
    const { sessions: s2 } = manager({}, { agents: listed.agents, settings: titleSettings })
    await s2.load()
    const caller2 = await s2.create({ agentId: 'claude-code', projectPath: '/repo' })
    const started2 = await s2.startFromTool(caller2.id, {
      prompt: 'Check listed titles on OpenCode sessions',
      title: 'Explicit listed title',
      options: {},
      report: false,
    })
    await vi.waitFor(() => expect(listed.prompt).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(s2.summary(started2).status).toBe('ready'))
    expect(listed.listSessions).not.toHaveBeenCalled()
    expect(s2.summary(started2).title).toBe('Explicit listed title')
    await s2.flush()
  })

  it('still auto-titles start_session without a title, unless renamed by the agent first', async () => {
    const sent = titleAgent({
      ownTitles: 'sent',
      onPrompt: (_id, target) => {
        target.apply({
          patches: [{ op: 'session.update', changes: { title: 'Agent generated title' } }],
          effects: [{ kind: 'title', title: 'Agent generated title' }],
        })
      },
    })
    const { sessions: s1 } = manager({}, { agents: sent.agents, settings: titleSettings })
    await s1.load()
    const caller1 = await s1.create({ agentId: 'claude-code', projectPath: '/repo' })
    const untitled1 = await s1.startFromTool(caller1.id, {
      prompt: 'Please audit our login retry behavior',
      options: {},
      report: false,
    })
    await vi.waitFor(() => expect(s1.summary(untitled1).title).toBe('Agent generated title'))
    expect(sent.newSession.mock.calls[1]?.[1]?.titled).toBeUndefined()
    await s1.flush()

    const written = titleAgent({ ownTitles: null, writtenTitle: 'Login retry audit' })
    const { sessions: s2 } = manager({}, { agents: written.agents, settings: titleSettings })
    await s2.load()
    const caller2 = await s2.create({ agentId: 'claude-code', projectPath: '/repo' })
    const untitled2 = await s2.startFromTool(caller2.id, {
      prompt: 'Please audit our login retry behavior',
      options: {},
      report: false,
    })
    await vi.waitFor(() => expect(s2.summary(untitled2).title).toBe('Login retry audit'))
    expect(written.collect).toHaveBeenCalledTimes(1)
    await s2.flush()

    // An explicit rename_session while auto-titling is in flight blocks the late written title.
    let releaseTitle!: (title: string) => void
    const delayed = titleAgent({
      ownTitles: null,
      holdWrite: () => new Promise<string>((resolve) => (releaseTitle = resolve)),
    })
    const { sessions: s3 } = manager({}, { agents: delayed.agents, settings: titleSettings })
    await s3.load()
    const caller3 = await s3.create({ agentId: 'claude-code', projectPath: '/repo' })
    const untitled3 = await s3.startFromTool(caller3.id, {
      prompt: 'Please audit our login retry behavior',
      options: {},
      report: false,
    })
    await vi.waitFor(() => expect(delayed.collect).toHaveBeenCalledTimes(1))
    s3.renameByAgent(untitled3, 'Chosen mid-flight')
    releaseTitle('Late generated title')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(s3.summary(untitled3).title).toBe('Chosen mid-flight')
    await s3.flush()
  })

  it('preserves a given title across reload when replay emits a generated title', async () => {
    const firstAgent = titleAgent({ ownTitles: 'sent' })
    const first = manager({}, { agents: firstAgent.agents })
    await first.sessions.load()
    const caller = await first.sessions.create({ agentId: 'claude-code', projectPath: '/repo' })
    const startedId = await first.sessions.startFromTool(caller.id, {
      prompt: 'Check persistence across restarts',
      title: 'Persisted title',
      options: {},
      report: false,
    })
    await vi.waitFor(() => expect(first.sessions.summary(startedId).status).toBe('ready'))
    await first.sessions.flush()

    const replayAgent = titleAgent({
      ownTitles: 'sent',
      onLoad: (_id, target) => {
        target.apply({
          patches: [{ op: 'session.update', changes: { title: 'Replayed generated title' } }],
          effects: [{ kind: 'title', title: 'Replayed generated title' }],
        })
      },
    })
    const reloaded = manager({}, { agents: replayAgent.agents })
    await reloaded.sessions.load()
    await reloaded.sessions.open(startedId)
    expect(reloaded.sessions.summary(startedId).title).toBe('Persisted title')
    await reloaded.sessions.flush()
  })

  it('keeps an explicit start_session title on a real Claude Code connection', async () => {
    const sdkDir = await mkdtemp(path.join(dir, 'claude-sdk-'))
    const entry = path.join(sdkDir, 'sdk.mjs')
    await writeFile(path.join(sdkDir, 'package.json'), JSON.stringify({ version: '0.3.314' }))
    const sdk = new FakeClaudeSdk()
    sdk.generatedTitle = 'Debug port isolation'
    sdk.script = (query) => {
      query.running()
      query.finish()
    }
    const connection = claudeSdkDriver(async () => sdk).connect({
      def: CLAUDE_CODE,
      hooks: {
        traffic: () => {},
        account: () => {},
        ignored: () => {},
        log: () => {},
      },
      spec: {
        command: entry,
        args: [],
        env: { CLAUDE_CODE_EXECUTABLE: '/opt/claude/bin/claude' },
        shell: false,
        display: { command: entry, args: [], env: {} },
      },
      env: { PATH: '/usr/bin', HOME: dir },
      claudeSettingsDir: path.join(sdkDir, 'settings'),
      spawn: () => new FakeChild() as never,
    })
    const init = await connection.initialize('1.0.0')
    const runtime = { agentId: 'claude-code' as const, kettu: false, init, connection }
    const agents = {
      name: () => 'Claude Code',
      signedIn: () => {},
      status: () => ({ capabilities: init.capabilities, limits: [] }),
      hasContext: () => false,
      refreshLimits: async () => {},
      runtime: () => runtime,
      ensureReady: async () => runtime,
    }
    const { sessions } = manager({}, { agents, settings: titleSettings })
    await sessions.load()

    try {
      const caller = await sessions.create({ agentId: 'claude-code', projectPath: '/repo' })
      const titledId = await sessions.startFromTool(caller.id, {
        prompt: 'Check KETTU_USER_DATA and debug port isolation',
        title: 'Given Claude title',
        options: {},
        report: false,
      })
      await vi.waitFor(() => expect(sdk.last.inputs).toHaveLength(1))
      await vi.waitFor(() => expect(sessions.summary(titledId).status).toBe('ready'))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(sessions.summary(titledId).title).toBe('Given Claude title')
      const titledQuery = sdk.last
      expect(titledQuery.calls.some((call) => call.method === 'generateSessionTitle')).toBe(false)
      expect(titledQuery.calls.some((call) => call.method === 'renameSession')).toBe(false)

      const untitledId = await sessions.startFromTool(caller.id, {
        prompt: 'Check KETTU_USER_DATA and debug port isolation',
        options: {},
        report: false,
      })
      await vi.waitFor(() =>
        expect(sessions.summary(untitledId).title).toBe('Debug port isolation'),
      )
      expect(sdk.last.calls.some((call) => call.method === 'generateSessionTitle')).toBe(true)

      sessions.rename(titledId, 'Renamed by user')
      expect(sessions.summary(titledId).title).toBe('Renamed by user')
      await sessions.flush()
    } finally {
      connection.close()
    }
  })
})

describe('agent-started turns and empty turn_end deduplication', () => {
  async function claudeSetup() {
    const sdkDir = await mkdtemp(path.join(dir, 'claude-sdk-turn-end-'))
    const entry = path.join(sdkDir, 'sdk.mjs')
    await writeFile(path.join(sdkDir, 'package.json'), JSON.stringify({ version: '0.3.314' }))
    const sdk = new FakeClaudeSdk()
    const connection = claudeSdkDriver(async () => sdk).connect({
      def: CLAUDE_CODE,
      hooks: {
        traffic: () => {},
        account: () => {},
        ignored: () => {},
        log: () => {},
      },
      spec: {
        command: entry,
        args: [],
        env: { CLAUDE_CODE_EXECUTABLE: '/opt/claude/bin/claude' },
        shell: false,
        display: { command: entry, args: [], env: {} },
      },
      env: { PATH: '/usr/bin', HOME: dir },
      claudeSettingsDir: path.join(sdkDir, 'settings'),
      spawn: () => new FakeChild() as never,
    })
    const init = await connection.initialize('1.0.0')
    const runtime = { agentId: 'claude-code' as const, kettu: false, init, connection }
    const agents = {
      name: () => 'Claude Code',
      isDisabled: () => false,
      signedIn: () => {},
      status: () => ({ capabilities: init.capabilities, limits: [] }),
      hasContext: () => false,
      refreshLimits: async () => {},
      runtime: () => runtime,
      ensureReady: async () => runtime,
    }
    const { sessions } = manager({}, { agents })
    await sessions.load()
    return { sdk, connection, sessions }
  }

  function fakeAgentHarness() {
    const targets = new Map<string, SessionTarget>()
    let nextId = 0
    const connection = {
      isClosed: false,
      closed: new Promise<void>(() => {}),
      close: () => {},
      register: (id: string, target: SessionTarget) => {
        targets.set(id, target)
      },
      unregister: (id: string) => {
        targets.delete(id)
      },
      reopen: () => {},
      newSession: async () => ({ sessionId: `acp-${++nextId}`, config: [] }),
      setConfigOption: async () => [],
      loadSession: async () => ({ config: [] }),
      resumeSession: async () => ({ config: [] }),
      listSessions: async () => ({ sessions: [], nextCursor: null }),
      cancel: async () => {},
      prompt: async () => ({ stopReason: 'end_turn' as StopReason, tokens: null, models: [] }),
    }
    const runtime = {
      agentId: 'claude-code' as const,
      kettu: false,
      init: {
        name: 'Agent',
        version: '1.0.0',
        capabilities: {
          loadSession: true,
          listSessions: true,
          resumeSession: true,
          closeSession: false,
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
      connection,
    }
    const agents = {
      name: () => 'Agent',
      isDisabled: () => false,
      signedIn: () => {},
      status: () => ({ capabilities: runtime.init.capabilities, limits: [] }),
      hasContext: () => false,
      refreshLimits: async () => {},
      runtime: () => runtime,
      ensureReady: async () => runtime,
    }
    return { agents, targets }
  }

  it('omits turn_end for empty background Claude Code agentTurns while settling state, draining queue, and reporting real turns', async () => {
    const { sdk, connection, sessions } = await claudeSetup()
    const taskId = 'bg-subagent-1'
    const system = (sessionId: string, fields: Record<string, unknown>): SdkMessage =>
      ({ type: 'system', session_id: sessionId, ...fields }) as SdkMessage
    const assistant = (sessionId: string, id: string, text: string): SdkMessage =>
      ({
        type: 'assistant',
        uuid: `uuid-${id}`,
        parent_tool_use_id: null,
        session_id: sessionId,
        message: { id, role: 'assistant', content: [{ type: 'text', text }] },
      }) as SdkMessage
    const result = (sessionId: string): SdkMessage =>
      ({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '',
        stop_reason: 'end_turn',
        terminal_reason: 'completed',
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {},
        session_id: sessionId,
      }) as SdkMessage
    const taskNotificationUser = (sessionId: string): SdkMessage =>
      ({
        type: 'user',
        message: { role: 'user', content: '<task-notification>waiting</task-notification>' },
        parent_tool_use_id: null,
        origin: { kind: 'task-notification' },
        isReplay: true,
        session_id: sessionId,
      }) as SdkMessage

    let promptCount = 0
    sdk.script = (q) => {
      promptCount++
      if (promptCount === 1) {
        q.running()
        q.emit(
          system(q.sessionId, { subtype: 'init' }),
          system(q.sessionId, {
            subtype: 'task_started',
            task_id: taskId,
            tool_use_id: 'toolu_bg',
            description: 'Inspect code',
            subagent_type: 'general-purpose',
            is_backgrounded: true,
            task_type: 'local_agent',
          }),
          assistant(q.sessionId, 'msg_1', 'Started background work.'),
          result(q.sessionId),
        )
        return
      }
      q.emit(
        system(q.sessionId, { subtype: 'init' }),
        assistant(q.sessionId, `msg_q_${promptCount}`, 'Handled queued follow-up.'),
        result(q.sessionId),
      )
    }

    try {
      const created = await sessions.create({ agentId: 'claude-code', projectPath: '/repo' })
      await sessions.prompt(created.id, [{ type: 'text', text: 'Investigate in background' }])
      await vi.waitFor(() => expect(sessions.summary(created.id).status).toBe('ready'))

      const turnEnds = async () =>
        (await sessions.open(created.id)).entries.filter((entry) => entry.kind === 'turn_end')

      expect(await turnEnds()).toHaveLength(1)
      expect(sessions.summary(created.id).stillRunning).toEqual({
        commands: 0,
        subagents: 1,
        reportsBack: true,
      })

      // Two empty background <task-notification> agentTurns settle cleanly with no stacked turn_end.
      const query = sdk.last
      for (let i = 0; i < 2; i++) {
        query.emit(
          system(query.sessionId, { subtype: 'init' }),
          taskNotificationUser(query.sessionId),
        )
        await vi.waitFor(() => expect(sessions.summary(created.id).status).toBe('running'))
        query.emit(result(query.sessionId))
        await vi.waitFor(() => expect(sessions.summary(created.id).status).toBe('ready'))
      }

      expect(await turnEnds()).toHaveLength(1)
      expect(sessions.summary(created.id).stillRunning).toEqual({
        commands: 0,
        subagents: 1,
        reportsBack: true,
      })

      // A user prompt queued during an empty agentTurn drains once the empty turn finishes.
      query.emit(
        system(query.sessionId, { subtype: 'init' }),
        taskNotificationUser(query.sessionId),
      )
      await vi.waitFor(() => expect(sessions.summary(created.id).status).toBe('running'))
      await sessions.queue(created.id, [{ type: 'text', text: 'Queued question' }])
      query.emit(result(query.sessionId))
      await vi.waitFor(() => expect(promptCount).toBe(2))
      await vi.waitFor(() => expect(sessions.summary(created.id).status).toBe('ready'))
      expect(await turnEnds()).toHaveLength(2)

      // When the background subagent finishes and Claude Code reports back with text, turn_end is written.
      query.emit(
        system(query.sessionId, {
          subtype: 'task_notification',
          task_id: taskId,
          status: 'completed',
        }),
        system(query.sessionId, { subtype: 'init' }),
        assistant(query.sessionId, 'msg_done', 'Background work finished.'),
      )
      await vi.waitFor(() => expect(sessions.summary(created.id).status).toBe('running'))
      query.finish()
      await vi.waitFor(() => expect(sessions.summary(created.id).status).toBe('ready'))

      expect(await turnEnds()).toHaveLength(3)
      expect(sessions.summary(created.id).stillRunning).toBeNull()
      await sessions.flush()
    } finally {
      connection.close()
    }
  })

  it('writes turn_end for agentTurns with thought/tool output, non-end_turn stop reasons, and user-initiated empty turns', async () => {
    const harness = fakeAgentHarness()
    const { sessions } = manager({}, { agents: harness.agents })
    await sessions.load()

    const created = await sessions.create({ agentId: 'claude-code', projectPath: '/repo' })
    const turnEnds = async () =>
      (await sessions.open(created.id)).entries.filter((entry) => entry.kind === 'turn_end')

    // 1. User-initiated turn with zero agent output still records turn_end.
    await sessions.prompt(created.id, [{ type: 'text', text: 'Ping' }])
    await vi.waitFor(() => expect(sessions.summary(created.id).status).toBe('ready'))
    expect(await turnEnds()).toHaveLength(1)

    const target = harness.targets.get('acp-1')!

    // 2. Empty agentTurn ending normally produces no turn_end.
    target.apply({ patches: [], effects: [{ kind: 'agentTurn', phase: 'started' }] })
    expect(sessions.summary(created.id).status).toBe('running')
    target.apply({
      patches: [],
      effects: [
        {
          kind: 'agentTurn',
          phase: 'ended',
          result: { stopReason: 'end_turn', tokens: null, models: [] },
        },
      ],
    })
    expect(sessions.summary(created.id).status).toBe('ready')
    expect(await turnEnds()).toHaveLength(1)

    // 3. agentTurn with a thought still records turn_end.
    target.apply({ patches: [], effects: [{ kind: 'agentTurn', phase: 'started' }] })
    target.apply({
      patches: [
        {
          op: 'entry.add',
          entry: { kind: 'thought', id: 'th-1', markdown: 'Checking status', streaming: false },
        },
      ],
      effects: [],
    })
    target.apply({
      patches: [],
      effects: [
        {
          kind: 'agentTurn',
          phase: 'ended',
          result: { stopReason: 'end_turn', tokens: null, models: [] },
        },
      ],
    })
    expect(await turnEnds()).toHaveLength(2)

    // 4. agentTurn with a tool call still records turn_end.
    target.apply({ patches: [], effects: [{ kind: 'agentTurn', phase: 'started' }] })
    target.apply({
      patches: [
        {
          op: 'entry.add',
          entry: {
            kind: 'tool',
            id: 'tool-1',
            title: 'Read file',
            toolKind: 'read',
            status: 'completed',
            content: [],
            locations: [],
            permission: null,
            permissionResult: null,
          },
        },
      ],
      effects: [],
    })
    target.apply({
      patches: [],
      effects: [
        {
          kind: 'agentTurn',
          phase: 'ended',
          result: { stopReason: 'end_turn', tokens: null, models: [] },
        },
      ],
    })
    expect(await turnEnds()).toHaveLength(3)

    // 5. Empty agentTurn with non-end_turn stop reasons still records turn_end.
    for (const reason of ['cancelled', 'max_tokens', 'refusal'] as const) {
      target.apply({ patches: [], effects: [{ kind: 'agentTurn', phase: 'started' }] })
      target.apply({
        patches: [],
        effects: [
          {
            kind: 'agentTurn',
            phase: 'ended',
            result: { stopReason: reason, tokens: null, models: [] },
          },
        ],
      })
    }
    const ends = await turnEnds()
    expect(ends).toHaveLength(6)
    expect(ends.slice(3).map((entry) => entry.stopReason)).toEqual([
      'cancelled',
      'max_tokens',
      'refusal',
    ])

    // 6. Empty agentTurn that fails still records an error notice and settles cleanly.
    target.apply({ patches: [], effects: [{ kind: 'agentTurn', phase: 'started' }] })
    target.apply({
      patches: [],
      effects: [{ kind: 'agentTurn', phase: 'failed', error: new Error('boom') }],
    })
    expect(sessions.summary(created.id).status).toBe('ready')
    const notices = (await sessions.open(created.id)).entries.filter(
      (entry) => entry.kind === 'notice' && entry.severity === 'error',
    )
    expect(notices).toHaveLength(1)
    await sessions.flush()
  })
})

describe('session manager shutdown and flush cleanup', () => {
  it('cancels pending listed-title retries and prepared settings watchers on shutdown', async () => {
    const repo = path.join(dir, 'repo')
    await mkdir(repo, { recursive: true })

    let seq = 0
    let firstListed!: () => void
    const listedOnce = new Promise<void>((resolve) => (firstListed = resolve))
    const newSession = vi.fn(async () => ({ sessionId: `acp-${++seq}`, config: [] }))
    const listSessions = vi.fn(async () => {
      firstListed()
      return {
        sessions: [{ sessionId: 'acp-2', title: null, updatedAt: null, cwd: repo }],
        nextCursor: null,
      }
    })
    const prompt = vi.fn(async () => ({
      stopReason: 'end_turn' as StopReason,
      tokens: null,
      models: [],
    }))
    const connection = {
      isClosed: false,
      closed: new Promise<void>(() => {}),
      register: () => {},
      unregister: () => {},
      reopen: () => {},
      newSession,
      setConfigOption: async () => [],
      listSessions,
      prompt,
      cancel: async () => {},
      deleteSession: async () => {},
    }
    const runtime = {
      agentId: 'claude-code' as const,
      init: {
        capabilities: {
          listSessions: true,
          ownTitles: 'listed' as const,
          deleteSession: true,
          prompt: { image: false, audio: false, embeddedContext: false },
        },
      },
      connection,
    }
    const agents = {
      name: () => 'Agent',
      isDisabled: () => false,
      signedIn: () => {},
      authRequired: () => {},
      status: () => ({ capabilities: runtime.init.capabilities, limits: [] }),
      hasContext: () => false,
      refreshLimits: async () => {},
      runtime: () => runtime,
      ensureReady: async () => runtime,
    }

    const { sessions } = manager(
      {},
      {
        agents,
        timings: { listedTitleRetryMs: 100, settingsDelayMs: 20 },
        settingsTargets: () => [{ dir: repo, names: ['settings.json'] }],
      },
    )
    await sessions.load()

    await sessions.prepare({ agentId: 'claude-code', projectPath: repo }, 'win-1')
    const created = await sessions.create({ agentId: 'claude-code', projectPath: repo })
    expect(newSession).toHaveBeenCalledTimes(2)

    await sessions.prompt(created.id, [{ type: 'text', text: 'First turn' }])
    await listedOnce
    // Let readListedTitle resume from await listSessions and arm live.listedTitleTimer.
    await new Promise((resolve) => setImmediate(resolve))

    sessions.shutdown()
    await writeFile(path.join(repo, 'settings.json'), '{"changed":true}')
    await new Promise((resolve) => setTimeout(resolve, 140))

    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(newSession).toHaveBeenCalledTimes(2)
  })

  it('flushes session index, prepared records, and agent options together', async () => {
    const repo = path.join(dir, 'repo')
    await mkdir(repo, { recursive: true })

    const prepared = new PreparedRecords(preparedFile(dir, log))
    await prepared.load()
    const options = new AgentOptionsStore({
      file: agentOptionsFile(dir, log),
      changed: () => {},
    })
    await options.load()

    const config = [
      {
        id: 'model',
        name: 'Model',
        category: 'model' as const,
        type: 'select' as const,
        value: 'default',
        choices: [{ value: 'default', name: 'Default' }],
      },
    ]
    const connection = {
      isClosed: false,
      closed: new Promise<void>(() => {}),
      register: () => {},
      unregister: () => {},
      reopen: () => {},
      newSession: async () => ({ sessionId: 'acp-prep', config }),
      setConfigOption: async () => config,
      listSessions: async () => ({
        sessions: [{ sessionId: 'acp-imported', title: 'Imported', updatedAt: null, cwd: repo }],
        nextCursor: null,
      }),
      deleteSession: async () => {},
    }
    const runtime = {
      agentId: 'claude-code' as const,
      init: {
        capabilities: {
          listSessions: true,
          deleteSession: true,
          prompt: { image: false, audio: false, embeddedContext: false },
        },
      },
      connection,
    }
    const agents = {
      name: () => 'Claude Code',
      signedIn: () => {},
      authRequired: () => {},
      status: () => ({ capabilities: runtime.init.capabilities, limits: [] }),
      runtime: () => runtime,
      ensureReady: async () => runtime,
    }

    const { sessions } = manager({}, { agents, prepared, options })
    await sessions.load()

    await sessions.prepare({ agentId: 'claude-code', projectPath: repo }, 'win-1')
    const imported = await sessions.importSession({
      agentId: 'claude-code',
      projectPath: repo,
      acpSessionId: 'acp-imported',
    })
    await sessions.archive(imported.id)

    sessions.shutdown()
    await sessions.flush()

    const savedSessions = await index()
    expect(savedSessions?.sessions).toMatchObject([
      { id: imported.id, archivedAt: expect.any(Number) },
    ])
    const savedPrepared = JSON.parse(
      await readFile(path.join(dir, 'state', 'prepared-sessions.json'), 'utf8'),
    ) as PreparedFile
    expect(savedPrepared.sessions).toEqual([
      { agentId: 'claude-code', acpSessionId: 'acp-prep', cwd: repo },
    ])
    const savedOptions = JSON.parse(
      await readFile(path.join(dir, 'state', 'agent-options.json'), 'utf8'),
    ) as { agents: Record<string, unknown> }
    expect(savedOptions.agents['claude-code']).toBeDefined()
  })
})

describe('openNew start option guards', () => {
  it('holds the first prompt when a new session omits a cached model option, without blocking on dropped thought_level', async () => {
    const repo = path.join(dir, 'repo')
    await mkdir(repo, { recursive: true })

    const cachedModel = {
      id: 'model',
      name: 'Model',
      category: 'model' as const,
      type: 'select' as const,
      value: 'custom-provider/my-model',
      choices: [
        { value: 'opencode/default', name: 'opencode/Default' },
        { value: 'custom-provider/my-model', name: 'custom-provider/My Model' },
      ],
    }
    const cachedEffort = {
      id: 'effort',
      name: 'Reasoning',
      category: 'thought_level' as const,
      type: 'select' as const,
      value: 'high',
      choices: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
        { value: 'default', name: 'Default' },
      ],
    }
    const modeOnly = [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode' as const,
        type: 'select' as const,
        value: 'build',
        choices: [{ value: 'build', name: 'Build' }],
      },
    ]

    const options = new AgentOptionsStore({
      file: agentOptionsFile(dir, log),
      changed: () => {},
    })
    await options.load()
    options.started('opencode', [cachedModel, cachedEffort, ...modeOnly], repo)

    let sessionConfig: ConfigOption[] = modeOnly
    const prompt = vi.fn(async () => ({
      stopReason: 'end_turn' as StopReason,
      tokens: null,
      models: [],
    }))
    let seq = 0
    const connection = {
      isClosed: false,
      closed: new Promise<void>(() => {}),
      register: () => {},
      unregister: () => {},
      reopen: () => {},
      newSession: async () => ({ sessionId: `ses_${++seq}`, config: sessionConfig }),
      setConfigOption: async (_sessionId: string, optionId: string, value: string | boolean) =>
        sessionConfig.map((item) => (item.id === optionId ? { ...item, value } : item)),
      prompt,
      cancel: async () => {},
    }
    const runtime = {
      agentId: 'opencode' as const,
      init: {
        capabilities: {
          prompt: { image: false, audio: false, embeddedContext: false },
        },
      },
      connection,
    }
    const agents = {
      name: () => 'OpenCode',
      signedIn: () => {},
      authRequired: () => {},
      status: () => ({ capabilities: runtime.init.capabilities, limits: [] }),
      hasContext: () => false,
      refreshLimits: async () => {},
      runtime: () => runtime,
      ensureReady: async () => runtime,
    }

    const { sessions } = manager({}, { agents, options })
    await sessions.load()

    // Case 1: agent omits the entire `model` option; first prompt must be held in a paused queue.
    const held = await sessions.create({
      agentId: 'opencode',
      projectPath: repo,
      options: { model: 'custom-provider/my-model' },
      prompt: [{ type: 'text', text: 'Do not fall back silently' }],
    })
    await vi.waitFor(async () => {
      const snap = await sessions.snapshot(held.id)
      expect(snap?.session.status).toBe('ready')
      expect(snap?.session.queuePaused).toBe(true)
    })
    const heldSnap = await sessions.snapshot(held.id)
    expect(prompt).not.toHaveBeenCalled()
    expect(heldSnap?.session.queue).toHaveLength(1)
    expect(heldSnap?.entries.some((entry) => entry.kind === 'notice')).toBe(true)

    // Case 2: cached options include `thought_level`, but the chosen model has no effort variants;
    // the prompt still sends on the custom model without a false hold.
    options.started('opencode', [cachedModel, cachedEffort, ...modeOnly], repo)
    sessionConfig = [{ ...cachedModel, value: 'opencode/default' }, ...modeOnly]
    const sent = await sessions.create({
      agentId: 'opencode',
      projectPath: repo,
      options: { model: 'custom-provider/my-model', effort: 'high' },
      prompt: [{ type: 'text', text: 'Run on custom model' }],
    })
    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(1)
    })
    const sentSnap = await sessions.snapshot(sent.id)
    expect(sentSnap?.session.queuePaused).toBe(false)
    expect(sentSnap?.session.config.find((item) => item.id === 'model')?.value).toBe(
      'custom-provider/my-model',
    )
  })
})
