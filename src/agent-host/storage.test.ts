import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentsFile,
  agentUpdatesFile,
  corruptName,
  JsonFile,
  migrate,
  parseAgentsFile,
  parseAgentUpdatesFile,
  parseProjectsFile,
  parseRoutinesFile,
  parseSessionsFile,
  projectsFile,
  routinesFile,
  sessionsFile,
  writeFileAtomic,
  type Migration,
  type SessionRecord,
} from './storage'
import { parseAgentOptionsFile } from './agent-options'
import { Projects } from './projects'

it.each(['default', true, false] as const)(
  'preserves boolean configuration inheritance and metadata for %s',
  (value) => {
    const option = {
      id: 'workflow',
      name: 'Workflow',
      category: 'other',
      type: 'boolean',
      value,
      defaultValue: true,
      idleOnly: true,
      indicator: true,
    }
    const parsed = parseAgentOptionsFile({
      version: 1,
      agents: {
        'claude-code~work': {
          config: [option],
          remembered: {},
          levels: {},
          observedAt: 1,
        },
      },
    })
    expect(typeof parsed).not.toBe('string')
    if (typeof parsed === 'string') throw new Error(parsed)
    expect(parsed.agents['claude-code~work']?.config).toEqual([option])
  },
)

let dir: string
let logs: string[]
const log = (level: string, message: string): void => {
  logs.push(`${level}: ${message}`)
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-storage-'))
  logs = []
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('migrate', () => {
  const migrations: Record<number, Migration> = {
    1: (data) => ({ ...data, items: (data.list as string[]).map((name) => ({ name })) }),
    2: (data) => ({ ...data, list: undefined }),
  }

  it('runs every step from the file version to the current one', () => {
    const result = migrate({ version: 1, list: ['a'] }, 3, migrations)
    expect(result).toEqual({
      kind: 'ok',
      from: 1,
      data: { version: 3, items: [{ name: 'a' }], list: undefined },
    })
  })

  it('leaves current data alone', () => {
    expect(migrate({ version: 3, items: [] }, 3, migrations)).toEqual({
      kind: 'ok',
      from: 3,
      data: { version: 3, items: [] },
    })
  })

  it('reports newer, unversioned and unmigratable files', () => {
    expect(migrate({ version: 4 }, 3, migrations)).toEqual({ kind: 'newer', version: 4 })
    expect(migrate({}, 3, migrations).kind).toBe('invalid')
    expect(migrate([], 3, migrations).kind).toBe('invalid')
    expect(migrate({ version: 1.5 }, 3, migrations).kind).toBe('invalid')
    expect(migrate({ version: 1 }, 3, { 2: migrations[2]! })).toEqual({
      kind: 'invalid',
      reason: 'no migration from version 1',
    })
  })
})

describe('writeFileAtomic', () => {
  it('creates the folder and leaves no temporary file', async () => {
    const file = path.join(dir, 'state', 'x.json')
    await writeFileAtomic(file, '{"a":1}')
    await writeFileAtomic(file, '{"a":2}')
    expect(await readFile(file, 'utf8')).toBe('{"a":2}')
    expect(await readdir(path.join(dir, 'state'))).toEqual(['x.json'])
  })

  it('keeps the previous version when the write cannot complete', async () => {
    const file = path.join(dir, 'x.json')
    await writeFileAtomic(file, 'old')
    // A directory where the temporary file should go makes the write fail before the rename.
    await mkdir(`${file}.tmp`)
    await expect(writeFileAtomic(file, 'new')).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe('old')
  })
})

describe('JsonFile', () => {
  interface Doc {
    version: 1
    value: number
  }
  const make = (file: string, debounceMs = 20): JsonFile<Doc> =>
    new JsonFile<Doc>({
      file,
      version: 1,
      migrations: {},
      parse: (data) =>
        typeof data.value === 'number' ? { version: 1, value: data.value } : 'bad value',
      empty: () => ({ version: 1, value: 0 }),
      log,
      debounceMs,
      now: () => Date.UTC(2026, 9, 20, 12, 0, 0),
    })

  it('starts empty when the file is missing', async () => {
    const store = make(path.join(dir, 'doc.json'))
    expect(await store.load()).toEqual({ version: 1, value: 0 })
    expect(store.status).toBe('missing')
  })

  it('coalesces saves within the debounce window into one write', async () => {
    const file = path.join(dir, 'doc.json')
    const store = make(file, 10_000)
    store.save({ version: 1, value: 1 })
    store.save({ version: 1, value: 2 })
    await expect(readFile(file, 'utf8')).rejects.toThrow()
    await store.flush()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, value: 2 })
    const reloaded = make(file)
    expect(await reloaded.load()).toEqual({ version: 1, value: 2 })
    expect(reloaded.status).toBe('ok')
  })

  it('writes on its own once the debounce window passes', async () => {
    const file = path.join(dir, 'doc.json')
    const store = make(file, 10)
    store.save({ version: 1, value: 7 })
    // The write syncs to disk, which a busy Windows runner can take well over 50 ms to finish.
    await vi.waitFor(async () => expect(JSON.parse(await readFile(file, 'utf8')).value).toBe(7), {
      timeout: 5_000,
      interval: 20,
    })
  })

  it('moves a corrupt file aside, logs it and starts empty', async () => {
    const file = path.join(dir, 'doc.json')
    await writeFile(file, '{ not json')
    const store = make(file)
    expect(await store.load()).toEqual({ version: 1, value: 0 })
    expect(store.status).toBe('corrupt')
    const backup = corruptName(file, Date.UTC(2026, 9, 20, 12, 0, 0))
    expect(store.backupPath).toBe(backup)
    expect(path.basename(backup)).toBe('doc.json.corrupt-2026-10-20T12-00-00-000Z.json')
    expect(await readFile(backup, 'utf8')).toBe('{ not json')
    expect(
      logs.some((line) => line.startsWith('error:') && line.includes('could not be read')),
    ).toBe(true)
  })

  it('treats data that fails validation as corrupt too', async () => {
    const file = path.join(dir, 'doc.json')
    await writeFile(file, JSON.stringify({ version: 1, value: 'x' }))
    const store = make(file)
    await store.load()
    expect(store.status).toBe('corrupt')
  })

  it('says whether the last write reached the disk', async () => {
    const file = path.join(dir, 'doc.json')
    const store = make(file, 10_000)
    store.save({ version: 1, value: 1 })
    expect(await store.flushWritten()).toBe(true)
    await mkdir(`${file}.tmp`)
    store.save({ version: 1, value: 2 })
    expect(await store.flushWritten()).toBe(false)
    expect(await store.flushWritten()).toBe(false)
    await rm(`${file}.tmp`, { recursive: true })
    store.save({ version: 1, value: 3 })
    expect(await store.flushWritten()).toBe(true)
  })

  it('keeps a write that failed and makes it once the file can be written again', async () => {
    const file = path.join(dir, 'doc.json')
    const store = new JsonFile<Doc>({
      file,
      version: 1,
      migrations: {},
      parse: (data) => ({ version: 1, value: Number(data.value) }),
      empty: () => ({ version: 1, value: 0 }),
      log,
      debounceMs: 10,
      retryMs: 20,
    })
    await mkdir(`${file}.tmp`)
    store.save({ version: 1, value: 4 })
    await vi.waitFor(() => expect(logs.some((line) => line.includes('Could not write'))).toBe(true))
    await rm(`${file}.tmp`, { recursive: true })
    await vi.waitFor(async () => expect(JSON.parse(await readFile(file, 'utf8')).value).toBe(4), {
      timeout: 5_000,
      interval: 20,
    })
  })

  it('never writes over a file from a newer version', async () => {
    const file = path.join(dir, 'doc.json')
    const newer = JSON.stringify({ version: 9, value: 1, future: true })
    await writeFile(file, newer)
    const store = make(file)
    expect(await store.load()).toEqual({ version: 1, value: 0 })
    expect(store.readOnly).toBe(true)
    store.save({ version: 1, value: 5 })
    await store.flush()
    expect(await readFile(file, 'utf8')).toBe(newer)
    expect(logs.some((line) => line.includes('newer than this app'))).toBe(true)
  })
})

describe('the host files', () => {
  const session: SessionRecord = {
    id: 's1',
    agentId: 'claude-code',
    acpSessionId: 'acp-1',
    projectPath: '/repo',
    title: null,
    createdAt: 1,
    updatedAt: 2,
    lastViewedAt: null,
    parentId: null,
    origin: 'user',
    description: null,
    branch: 'main',
  }

  it('round-trips the session index', async () => {
    const store = sessionsFile(dir, log)
    store.save({ version: 1, sessions: [session] })
    await store.flush()
    expect(store.file).toBe(path.join(dir, 'state', 'sessions.json'))
    expect(await sessionsFile(dir, log).load()).toEqual({ version: 1, sessions: [session] })
  })

  it('validates every session field', () => {
    expect(parseSessionsFile({ sessions: [session] })).toEqual({ version: 1, sessions: [session] })
    expect(parseSessionsFile({ sessions: [{ ...session, agentId: 'other' }] })).toBe(
      'session 0 is malformed',
    )
    expect(parseSessionsFile({ sessions: [{ ...session, origin: 'x' }] })).toBe(
      'session 0 is malformed',
    )
    expect(parseSessionsFile({ sessions: {} })).toBe('sessions is not a list')
  })

  it('keeps when a limit-stopped session is carried on, and its cancellation', () => {
    const lastTurn = {
      reason: 'limit' as const,
      endedAt: 10,
      limit: { window: 'five_hour', label: '5-hour', account: 'me@example.com', resetsAt: 20 },
    }
    const planned = { ...session, lastTurn: { ...lastTurn, continuesAt: 20 } }
    expect(parseSessionsFile({ sessions: [planned] })).toEqual({ version: 1, sessions: [planned] })
    const cancelled = { ...session, lastTurn: { ...lastTurn, continuesAt: null } }
    expect(parseSessionsFile({ sessions: [cancelled] })).toEqual({
      version: 1,
      sessions: [cancelled],
    })
    const dropped = { ...session, lastTurn: { ...lastTurn, continuesAt: 'soon' } }
    expect(parseSessionsFile({ sessions: [dropped] })).toEqual({
      version: 1,
      sessions: [{ ...session, lastTurn }],
    })
  })

  it("keeps a session's opened pull requests and drops addresses that are not one", () => {
    const pullRequests = [
      'https://github.com/KettuAI/Kettu/pull/1',
      'https://github.com/KettuAI/website/pull/54',
    ]
    expect(parseSessionsFile({ sessions: [{ ...session, pullRequests }] })).toEqual({
      version: 1,
      sessions: [{ ...session, pullRequests }],
    })
    expect(
      parseSessionsFile({
        sessions: [
          {
            ...session,
            pullRequests: [
              pullRequests[0],
              'https://github.com/KettuAI/Kettu/issues/2',
              'file:///etc/passwd',
              7,
              pullRequests[0],
            ],
          },
        ],
      }),
    ).toEqual({ version: 1, sessions: [{ ...session, pullRequests: [pullRequests[0]] }] })
    expect(parseSessionsFile({ sessions: [{ ...session, pullRequests: 'x' }] })).toEqual({
      version: 1,
      sessions: [session],
    })
  })

  it('keeps the sub-sessions a session archived alone left in the list', () => {
    const archived: SessionRecord = { ...session, archivedAt: 3, leftSubSessions: ['c1', 'c2'] }
    expect(parseSessionsFile({ sessions: [archived] })).toEqual({
      version: 1,
      sessions: [archived],
    })
    expect(
      parseSessionsFile({ sessions: [{ ...archived, leftSubSessions: ['c1', '', 4, 'c1'] }] }),
    ).toEqual({ version: 1, sessions: [{ ...archived, leftSubSessions: ['c1'] }] })
    expect(parseSessionsFile({ sessions: [{ ...archived, leftSubSessions: 'c1' }] })).toEqual({
      version: 1,
      sessions: [{ ...session, archivedAt: 3 }],
    })
  })

  it('keeps the agents that had a session before its current one', () => {
    const switched: SessionRecord = {
      ...session,
      agentId: 'codex',
      earlier: [
        { agentId: 'claude-code', acpSessionId: 'acp-0', configDir: '/cfg', endedAt: 'e7' },
        { agentId: 'codex', acpSessionId: '', endedAt: 'e12' },
      ],
      carry: { entryId: 'e20', fromTurn: 3, summarize: true, values: { model: 'gpt-5.5' } },
    }
    expect(parseSessionsFile({ sessions: [switched] })).toEqual({
      version: 1,
      sessions: [switched],
    })
    // A record that does not read drops itself, not the session; none left drops the list.
    const bad = { agentId: 'other', acpSessionId: 'x', endedAt: 'e1' }
    expect(
      parseSessionsFile({ sessions: [{ ...switched, earlier: [bad, ...switched.earlier!] }] }),
    ).toEqual({ version: 1, sessions: [switched] })
    expect(
      parseSessionsFile({
        sessions: [{ ...session, earlier: [{ ...bad, agentId: 'codex', endedAt: '' }] }],
      }),
    ).toEqual({ version: 1, sessions: [session] })
    expect(
      parseSessionsFile({ sessions: [{ ...session, carry: { entryId: 'e1', fromTurn: 0 } }] }),
    ).toEqual({ version: 1, sessions: [session] })
  })

  it('keeps who queued a prompt and whether they asked for no report of its turn', () => {
    const from = { sessionId: 's-parent', title: 'Build login' }
    const item = { id: 'q1', content: [{ type: 'text' as const, text: 'Review it' }], at: 1 }
    const queued: SessionRecord = {
      ...session,
      queue: [
        { ...item, from },
        { ...item, id: 'q2', from: { ...from, report: false } },
      ],
    }
    expect(parseSessionsFile({ sessions: [queued] })).toEqual({ version: 1, sessions: [queued] })
    // Only false is kept: a report is the default.
    expect(
      parseSessionsFile({
        sessions: [{ ...session, queue: [{ ...item, from: { ...from, report: 'no' } }] }],
      }),
    ).toEqual({ version: 1, sessions: [{ ...session, queue: [{ ...item, from }] }] })
  })

  it("keeps a queued message's comment summary, dropping one that does not read", () => {
    const item = { id: 'q1', content: [{ type: 'text' as const, text: '> a\n\nb' }], at: 1 }
    const queued: SessionRecord = {
      ...session,
      queue: [{ ...item, comments: { count: 2, text: 'Looks good' } }],
    }
    expect(parseSessionsFile({ sessions: [queued] })).toEqual({ version: 1, sessions: [queued] })
    expect(
      parseSessionsFile({
        sessions: [{ ...session, queue: [{ ...item, comments: { count: '2', text: 'x' } }] }],
      }),
    ).toEqual({ version: 1, sessions: [{ ...session, queue: [item] }] })
  })

  it("keeps a session's worktree and never lets an unreadable one fall back to the project", () => {
    const worktree = {
      path: '/repo-worktrees/kettu-fix-login-1a2b3c',
      branch: 'kettu/fix-login',
      base: 'main',
      baseOid: 'a'.repeat(40),
    }
    const inWorktree = { ...session, worktree }
    expect(parseSessionsFile({ sessions: [inWorktree] })).toEqual({
      version: 1,
      sessions: [inWorktree],
    })
    const removed = { ...session, worktree: { ...worktree, removed: 'worktree' } }
    expect(parseSessionsFile({ sessions: [removed] })).toEqual({ version: 1, sessions: [removed] })
    const pending = { ...session, worktree: { ...worktree, pending: true } }
    expect(parseSessionsFile({ sessions: [pending] })).toEqual({ version: 1, sessions: [pending] })
    // An older record without the field works in its project's folder, as before.
    expect(parseSessionsFile({ sessions: [session] })).toEqual({ version: 1, sessions: [session] })
    const unreadable = {
      ...session,
      worktree: { path: '', branch: '', base: '', baseOid: '', removed: 'branch' },
    }
    for (const bad of [
      'x',
      null,
      { ...worktree, path: '' },
      { ...worktree, branch: 7 },
      { ...worktree, baseOid: 'HEAD' },
      { ...worktree, removed: 'all' },
    ]) {
      expect(parseSessionsFile({ sessions: [{ ...session, worktree: bad }] })).toEqual({
        version: 1,
        sessions: [unreadable],
      })
    }
  })

  it('keeps the worktree an agent made for a subagent and drops one that does not read', () => {
    const agentWorktree = { path: '/repo/.claude/worktrees/a', branch: 'worktree-a' }
    expect(parseSessionsFile({ sessions: [{ ...session, agentWorktree }] })).toEqual({
      version: 1,
      sessions: [{ ...session, agentWorktree }],
    })
    expect(
      parseSessionsFile({ sessions: [{ ...session, agentWorktree: { path: '/x', branch: 3 } }] }),
    ).toEqual({
      version: 1,
      sessions: [{ ...session, agentWorktree: { path: '/x', branch: null } }],
    })
    expect(parseSessionsFile({ sessions: [{ ...session, agentWorktree: { path: '' } }] })).toEqual({
      version: 1,
      sessions: [session],
    })
  })

  it("keeps which agent session was handed Kettu's memory, and drops one that does not read", () => {
    const sent = { ...session, memorySentTo: 'acp-1' }
    expect(parseSessionsFile({ sessions: [sent] })).toEqual({ version: 1, sessions: [sent] })
    for (const memorySentTo of ['', 3, null]) {
      expect(parseSessionsFile({ sessions: [{ ...session, memorySentTo }] })).toEqual({
        version: 1,
        sessions: [session],
      })
    }
  })

  it("keeps which agent session got Kettu's guide and memory in its system prompt", () => {
    const sent = { ...session, systemPromptSentTo: 'acp-1' }
    expect(parseSessionsFile({ sessions: [sent] })).toEqual({ version: 1, sessions: [sent] })
    for (const systemPromptSentTo of ['', 3, null]) {
      expect(parseSessionsFile({ sessions: [{ ...session, systemPromptSentTo }] })).toEqual({
        version: 1,
        sessions: [session],
      })
    }
  })

  it('keeps how a session last ran outside Kettu, and drops what does not read', () => {
    const taken = {
      ...session,
      outside: { model: 'claude-opus-5-5[1m]', effort: 'xhigh', fast: false, mode: 'auto' },
      instructionsAhead: true,
    }
    expect(parseSessionsFile({ sessions: [taken] })).toEqual({ version: 1, sessions: [taken] })
    expect(
      parseSessionsFile({
        sessions: [
          { ...session, outside: { model: '', effort: 3, fast: 'no' }, instructionsAhead: 1 },
        ],
      }),
    ).toEqual({ version: 1, sessions: [session] })
    expect(
      parseSessionsFile({ sessions: [{ ...session, outside: { effort: 'high', extra: 'x' } }] }),
    ).toEqual({ version: 1, sessions: [{ ...session, outside: { effort: 'high' } }] })
  })

  it('keeps the skills and servers commands added to a session, and drops what does not read', () => {
    const added = { ...session, commandTools: { skills: ['code-review'], mcp: ['github'] } }
    expect(parseSessionsFile({ sessions: [added] })).toEqual({ version: 1, sessions: [added] })
    expect(
      parseSessionsFile({
        sessions: [{ ...session, commandTools: { skills: ['a', '', 3], mcp: 'github' } }],
      }),
    ).toEqual({
      version: 1,
      sessions: [{ ...session, commandTools: { skills: ['a'], mcp: [] } }],
    })
    for (const commandTools of [null, 'x', { skills: [], mcp: [] }]) {
      expect(parseSessionsFile({ sessions: [{ ...session, commandTools }] })).toEqual({
        version: 1,
        sessions: [session],
      })
    }
  })

  it('keeps the role a session started as, whole, and drops what does not read', () => {
    const role = { name: 'reviewer', title: 'Reviewer', instructions: 'Review it.' }
    expect(parseSessionsFile({ sessions: [{ ...session, role }] })).toEqual({
      version: 1,
      sessions: [{ ...session, role }],
    })
    for (const bad of [
      null,
      'x',
      { ...role, name: '' },
      { ...role, instructions: '  ' },
      { ...role, title: 3 },
    ]) {
      expect(parseSessionsFile({ sessions: [{ ...session, role: bad }] })).toEqual({
        version: 1,
        sessions: [session],
      })
    }
  })

  it('keeps the last outside message its thread holds, and drops what does not read', () => {
    const taken = { ...session, outsideTail: 'uuid-1' }
    expect(parseSessionsFile({ sessions: [taken] })).toEqual({ version: 1, sessions: [taken] })
    for (const outsideTail of ['', 3, null]) {
      expect(parseSessionsFile({ sessions: [{ ...session, outsideTail }] })).toEqual({
        version: 1,
        sessions: [session],
      })
    }
  })

  it("keeps a project's worktree settings key by key", () => {
    const project = { path: '/repo', name: 'repo', addedAt: 1, lastOpenedAt: 2 }
    const worktree = {
      branchTemplate: '{type}/{issue}-{slug}',
      copy: ['.env', '.claude/settings.local.json'],
      setup: 'pnpm install',
      waitForSetup: false,
    }
    expect(parseProjectsFile({ projects: [{ ...project, worktree }] })).toEqual({
      version: 1,
      projects: [{ ...project, worktree }],
    })
    expect(
      parseProjectsFile({
        projects: [
          { ...project, worktree: { branchTemplate: 3, copy: ['.env', 4, ''], setup: null } },
        ],
      }),
    ).toEqual({ version: 1, projects: [{ ...project, worktree: { copy: ['.env'], setup: null } }] })
    expect(parseProjectsFile({ projects: [{ ...project, worktree: 'x' }] })).toEqual({
      version: 1,
      projects: [project],
    })
  })

  it('round-trips the routines file', async () => {
    const routine = {
      id: 'r-0123456789ab',
      name: 'Morning briefing',
      prompt: 'Summarize the open pull requests',
      agentId: 'fake-agent' as const,
      projectPath: null,
      options: [],
      trigger: {
        kind: 'schedule' as const,
        schedule: { kind: 'weekly' as const, days: [1], time: '09:00' },
      },
      scope: { level: 'read' as const, web: false },
      timeLimitMinutes: 60 as const,
      keptRunSessions: 50 as const,
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
      checkedThrough: 3,
    }
    const store = routinesFile(dir, log)
    expect(store.file).toBe(path.join(dir, 'state', 'routines.json'))
    store.save({ version: 1, routines: [routine] })
    await store.flush()
    expect(await routinesFile(dir, log).load()).toEqual({ version: 1, routines: [routine] })

    // A routine saved before the setting existed keeps the sessions of its latest 100 runs.
    const older = Object.fromEntries(
      Object.entries(routine).filter(([key]) => key !== 'keptRunSessions'),
    )
    expect(parseRoutinesFile({ routines: [older] })).toEqual({
      version: 1,
      routines: [{ ...routine, keptRunSessions: 100 }],
    })
    expect(parseRoutinesFile({ routines: [{ ...routine, keptRunSessions: 30 }] })).toBe(
      'routine 0 is malformed',
    )
  })

  it('validates projects', async () => {
    const project = { path: '/repo', name: 'repo', addedAt: 1, lastOpenedAt: 2 }
    expect(parseProjectsFile({ projects: [project] })).toEqual({ version: 1, projects: [project] })
    expect(parseProjectsFile({ projects: [{ ...project, addedAt: -1 }] })).toBe(
      'project 0 is malformed',
    )
    const store = projectsFile(dir, log)
    expect(store.file).toBe(path.join(dir, 'state', 'projects.json'))
  })

  it('keeps project pins across loads and ignores invalid stored pin times', async () => {
    const project = { path: '/repo', name: 'repo', addedAt: 1, lastOpenedAt: 2 }
    const file = projectsFile(dir, log)
    file.save({ version: 1, projects: [project] })
    await file.flush()
    const registry = (time: number) =>
      new Projects({
        file: projectsFile(dir, log),
        platform: 'linux',
        now: () => time,
        isDirectory: async () => false,
      })

    const first = registry(3)
    await first.load()
    expect(first.list()).toEqual([
      {
        path: '/repo',
        name: 'repo',
        missing: true,
        lastOpenedAt: 2,
        pinnedAt: null,
        order: null,
      },
    ])
    first.pin(first.match('/repo'), true)
    await first.flush()

    const next = registry(4)
    await next.load()
    next.pin(next.match('/repo'), true)
    next.touch(next.match('/repo'))
    expect(next.list()[0]).toMatchObject({ pinnedAt: 3, lastOpenedAt: 4 })
    next.pin(next.match('/repo'), false)
    await next.flush()
    expect((await projectsFile(dir, log).load()).projects).toEqual([
      { ...project, lastOpenedAt: 4 },
    ])
    expect(parseProjectsFile({ projects: [{ ...project, pinnedAt: -1 }] })).toEqual({
      version: 1,
      projects: [project],
    })
  })

  it('keeps the order the user moved projects into, with later projects at the end', async () => {
    const at = (name: string, lastOpenedAt: number) => ({
      path: `/${name}`,
      name,
      addedAt: 1,
      lastOpenedAt,
    })
    const file = projectsFile(dir, log)
    file.save({ version: 1, projects: [at('a', 2), at('b', 4), at('c', 3)] })
    await file.flush()
    let time = 10
    const registry = () =>
      new Projects({
        file: projectsFile(dir, log),
        platform: 'linux',
        now: () => time,
        realpath: async (value) => value,
        isDirectory: async () => true,
      })
    const paths = (projects: Projects) => projects.list().map((project) => project.path)

    const first = registry()
    await first.load()
    // Until a project is moved, the latest opened comes first, and opening one moves it up.
    expect(paths(first)).toEqual(['/b', '/c', '/a'])
    expect(first.list().every((project) => project.order === null)).toBe(true)
    first.touch(first.match('/a'))
    expect(paths(first)).toEqual(['/a', '/b', '/c'])

    const heard: string[][] = []
    first.onChange((projects) => heard.push(projects.map((project) => project.path)))
    first.move(first.match('/a'), null)
    expect(heard).toEqual([['/b', '/c', '/a']])
    first.move(first.match('/c'), first.match('/b'))
    expect(paths(first)).toEqual(['/c', '/b', '/a'])
    // Once moved, opening a project keeps its place and a new one goes to the end.
    time = 20
    first.touch(first.match('/a'))
    await first.add('/d')
    await first.add('/b')
    expect(paths(first)).toEqual(['/c', '/b', '/a', '/d'])
    expect(first.list().map((project) => project.order)).toEqual([0, 1, 2, 3])
    first.remove(first.match('/b'))
    first.move(first.match('/d'), first.match('/c'))
    await first.flush()

    const next = registry()
    await next.load()
    expect(paths(next)).toEqual(['/d', '/c', '/a'])

    // A path the host does not list, or the project itself as its own neighbour, is refused.
    expect(() => next.move(next.match('/elsewhere'), null)).toThrow(/No project/)
    expect(() => next.move(next.match('/a'), next.match('/elsewhere'))).toThrow(/No project/)
    expect(() => next.move(next.match('/a'), next.match('/a'))).toThrow(/itself/)
    expect(paths(next)).toEqual(['/d', '/c', '/a'])

    // A stored order that is not a whole number at or above zero is dropped.
    for (const order of [-1, 1.5, '1', null]) {
      expect(parseProjectsFile({ projects: [{ ...at('a', 2), order }] })).toEqual({
        version: 1,
        projects: [at('a', 2)],
      })
    }
    expect(parseProjectsFile({ projects: [{ ...at('a', 2), order: 3 }] })).toEqual({
      version: 1,
      projects: [{ ...at('a', 2), order: 3 }],
    })
  })

  it('keeps the No project pin across loads, apart from the projects', async () => {
    const project = { path: '/repo', name: 'repo', addedAt: 1, lastOpenedAt: 2 }
    const file = projectsFile(dir, log)
    file.save({ version: 1, projects: [project] })
    await file.flush()
    const registry = (time: number) =>
      new Projects({
        file: projectsFile(dir, log),
        platform: 'linux',
        now: () => time,
        isDirectory: async () => true,
      })

    const first = registry(3)
    await first.load()
    expect(first.noProject()).toEqual({ pinnedAt: null })
    const heard: unknown[] = []
    first.onChange((_, noProject) => heard.push(noProject))
    first.pinNoProject(true)
    first.pinNoProject(true)
    expect(heard).toEqual([{ pinnedAt: 3 }])
    await first.flush()

    const next = registry(4)
    await next.load()
    expect(next.noProject()).toEqual({ pinnedAt: 3 })
    expect(next.list()[0]).toMatchObject({ path: '/repo', pinnedAt: null })
    next.pinNoProject(false)
    await next.flush()
    expect(await projectsFile(dir, log).load()).toEqual({ version: 1, projects: [project] })
    expect(parseProjectsFile({ projects: [], noProjectPinnedAt: 'soon' })).toEqual({
      version: 1,
      projects: [],
    })
  })

  it('keeps what each agent reported and drops what does not parse, entry by entry', () => {
    const account = { kind: 'account', label: 'Claude Max', email: 'me@example.com' }
    const limit = {
      window: 'five_hour',
      label: '5-hour',
      usedPercent: 42,
      resetsAt: 1_000,
      state: 'ok',
      observedAt: 500,
      amount: { used: 1_240, total: 2_000, unit: 'credits' },
    }
    expect(
      parseAgentsFile({
        agents: {
          'claude-code': { account, limits: [limit, { ...limit, state: 'odd' }] },
          codex: { account: { kind: 'none', label: 'Not signed in', email: null }, limits: [] },
          opencode: 'nothing',
          'unknown-agent': { account, limits: [] },
        },
      }),
    ).toEqual({ version: 1, agents: { 'claude-code': { account, limits: [limit] } } })
    // Extra usage covering a window is kept with it, and only as the flag.
    expect(
      parseAgentsFile({
        agents: {
          'claude-code': {
            account,
            limits: [
              { ...limit, state: 'reached', extraUsage: true },
              { ...limit, window: 'seven_day', extraUsage: 'yes' },
            ],
          },
        },
      }),
    ).toEqual({
      version: 1,
      agents: {
        'claude-code': {
          account,
          limits: [
            { ...limit, state: 'reached', extraUsage: true },
            { ...limit, window: 'seven_day' },
          ],
        },
      },
    })
    expect(
      parseAgentsFile({
        agents: { 'claude-code': { account: { ...account, tier: '5x' }, limits: [] } },
      }),
    ).toEqual({
      version: 1,
      agents: { 'claude-code': { account: { ...account, tier: '5x' }, limits: [] } },
    })
    const init = { version: '0.94.0', capabilities: { forkSession: true, steering: 'yes' } }
    expect(
      parseAgentsFile({
        agents: { 'claude-code': { limits: [], init }, codex: { init: { version: 'next' } } },
      }),
    ).toEqual({
      version: 1,
      agents: {
        'claude-code': {
          account: null,
          limits: [],
          init: { version: '0.94.0', capabilities: { forkSession: true } },
        },
      },
    })
    const prompt = { image: false, audio: false, embeddedContext: true }
    expect(
      parseAgentsFile({
        agents: {
          'claude-code': { limits: [], init: { version: '0.94.0', capabilities: { prompt } } },
          codex: { limits: [], init: { version: '2.2.2', capabilities: { prompt: { image: 1 } } } },
        },
      }),
    ).toEqual({
      version: 1,
      agents: {
        'claude-code': {
          account: null,
          limits: [],
          init: { version: '0.94.0', capabilities: { prompt } },
        },
        codex: { account: null, limits: [], init: { version: '2.2.2', capabilities: {} } },
      },
    })
    expect(parseAgentsFile({ agents: [] })).toBe('agents is not an object')
    expect(agentsFile(dir, log).file).toBe(path.join(dir, 'state', 'agents.json'))
  })

  it('keeps the sign-in an agent’s answers showed, and drops one that is not a method', () => {
    const plan = { kind: 'account', label: 'Google AI Pro', email: null }
    expect(
      parseAgentsFile({
        agents: {
          antigravity: { account: plan, limits: [], signIn: 'oauth-personal' },
          codex: { account: plan, limits: [], signIn: 'Not a method' },
          gemini: { limits: [], signIn: 'oauth-personal' },
        },
      }),
    ).toEqual({
      version: 1,
      agents: {
        antigravity: { account: plan, limits: [], signIn: 'oauth-personal' },
        codex: { account: plan, limits: [] },
        gemini: { account: null, limits: [], signIn: 'oauth-personal' },
      },
    })
  })

  it('drops the time the archived Codex report threads were removed, which nothing runs anymore', () => {
    expect(parseAgentsFile({ agents: {}, codexReportThreadsRemovedAt: 7 })).toEqual({
      version: 1,
      agents: {},
    })
  })

  it('keeps what each update check found and drops what does not parse, entry by entry', () => {
    const latest = { adapterVersion: '2.2.2', cliVersion: '0.160.3' }
    expect(
      parseAgentUpdatesFile({
        agents: {
          codex: { checkedAt: 1_000, latest },
          'claude-code': { checkedAt: -1, latest },
          opencode: { checkedAt: 1_000, latest: { adapterVersion: 2, cliVersion: null } },
          'fake-agent': {
            checkedAt: 1_000,
            latest: { adapterVersion: '../../x', cliVersion: null },
          },
          'unknown-agent': { checkedAt: 1_000, latest },
        },
      }),
    ).toEqual({ version: 1, agents: { codex: { checkedAt: 1_000, attemptedAt: 1_000, latest } } })
    // A check that failed is kept by when it ran, so the next one waits a day from it.
    expect(
      parseAgentUpdatesFile({
        agents: {
          codex: { checkedAt: 1_000, attemptedAt: 5_000, latest },
          'claude-code': { checkedAt: null, attemptedAt: 7_000, latest: null },
          opencode: { attemptedAt: 'soon' },
        },
      }),
    ).toEqual({
      version: 1,
      agents: {
        codex: { checkedAt: 1_000, attemptedAt: 5_000, latest },
        'claude-code': { checkedAt: null, attemptedAt: 7_000, latest: null },
      },
    })
    expect(parseAgentUpdatesFile({ agents: null })).toBe('agents is not an object')
    expect(agentUpdatesFile(dir, log).file).toBe(path.join(dir, 'state', 'agent-updates.json'))
  })

  it('keeps why a version moved, and reads a reason it does not know as none', () => {
    const moved = { from: '1.1.0', to: '1.0.0', at: 9_000, withdrawn: true }
    const parsed = parseAgentUpdatesFile({
      agents: {
        gemini: { attemptedAt: null, moved: { ...moved, reason: 'broken' } },
        kimi: { attemptedAt: null, moved: { ...moved, reason: 'someday' } },
      },
    })
    expect(parsed).toMatchObject({
      agents: { gemini: { moved: { ...moved, reason: 'broken' } }, kimi: { moved } },
    })
    expect(typeof parsed === 'string' ? null : parsed.agents.kimi?.moved).not.toHaveProperty(
      'reason',
    )
  })
})
