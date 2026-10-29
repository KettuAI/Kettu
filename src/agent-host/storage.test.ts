import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Routine } from '@shared/routines'
import {
  agentsFile,
  agentUpdatesFile,
  corruptName,
  JsonFile,
  migrate,
  parseAgentsFile,
  parseAgentUpdatesFile,
  parseProjectsFile,
  parseReturnedFile,
  parseRoutinesFile,
  parseSessionsFile,
  projectsFile,
  routinesFile,
  returnedFile,
  sessionsFile,
  writeFileAtomic,
  type Migration,
  type SessionRecord,
} from './storage'

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

  it('keeps a saved queue and drops one that does not parse', () => {
    const queue = [{ id: 'q1', content: [{ type: 'text', text: 'Then this' }], at: 5 }]
    expect(parseSessionsFile({ sessions: [{ ...session, queue }] })).toEqual({
      version: 1,
      sessions: [{ ...session, queue }],
    })
    expect(
      parseSessionsFile({ sessions: [{ ...session, queue: [{ id: 'q1', content: 'x', at: 5 }] }] }),
    ).toEqual({ version: 1, sessions: [session] })
    // A prompt another session's agent sent keeps whose it is, and drops a from that does not parse.
    const from = { sessionId: 's0', title: 'From another agent' }
    expect(
      parseSessionsFile({
        sessions: [{ ...session, queue: [{ id: 'q1', content: [], at: 5, from }] }],
      }),
    ).toEqual({
      version: 1,
      sessions: [{ ...session, queue: [{ id: 'q1', content: [], at: 5, from }] }],
    })
    expect(
      parseSessionsFile({
        sessions: [{ ...session, queue: [{ id: 'q1', content: [], at: 5, from: { title: 1 } }] }],
      }),
    ).toEqual({ version: 1, sessions: [{ ...session, queue: [{ id: 'q1', content: [], at: 5 }] }] })
  })

  it('keeps the session an agent started, and drops one that does not parse', () => {
    expect(parseSessionsFile({ sessions: [{ ...session, startedBy: 's0' }] })).toEqual({
      version: 1,
      sessions: [{ ...session, startedBy: 's0' }],
    })
    expect(parseSessionsFile({ sessions: [{ ...session, startedBy: 7 }] })).toEqual({
      version: 1,
      sessions: [session],
    })
  })

  it('keeps the configuration folder a session started with, and drops one that does not parse', () => {
    const picked = { ...session, configDir: '/srv/claude' }
    expect(parseSessionsFile({ sessions: [picked] })).toEqual({ version: 1, sessions: [picked] })
    for (const configDir of ['', 7]) {
      expect(parseSessionsFile({ sessions: [{ ...session, configDir }] })).toEqual({
        version: 1,
        sessions: [session],
      })
    }
  })

  it('keeps when sessions with no message were removed, and drops a time that does not parse', () => {
    expect(parseSessionsFile({ sessions: [session], emptySessionsRemovedAt: 7 })).toEqual({
      version: 1,
      sessions: [session],
      emptySessionsRemovedAt: 7,
    })
    expect(parseSessionsFile({ sessions: [session], emptySessionsRemovedAt: 'x' })).toEqual({
      version: 1,
      sessions: [session],
    })
  })

  it('keeps the returned messages that validate and drops the rest', async () => {
    const kept = {
      sessionId: null,
      content: [{ type: 'text' as const, text: 'Fix the build' }],
      at: 3,
    }
    expect(
      parseReturnedFile({
        messages: [
          kept,
          { sessionId: 's1', content: [{ type: 'text', text: 7 }], at: 4 },
          { sessionId: 's1', content: 'Fix the build', at: 5 },
        ],
      }),
    ).toEqual({ version: 1, messages: [kept] })
    expect(parseReturnedFile({ messages: {} })).toBe('messages is not a list')
    const store = returnedFile(dir, log)
    expect(store.file).toBe(path.join(dir, 'state', 'returned.json'))
    store.save({ version: 1, messages: [kept] })
    await store.flush()
    expect(await returnedFile(dir, log).load()).toEqual({ version: 1, messages: [kept] })
  })

  it("keeps a session's routine, and drops a reference that does not parse", () => {
    const routine = {
      routineId: 'r-0123456789ab',
      runId: 'run-1',
      trigger: 'manual' as const,
      scheduledFor: null,
    }
    const record = { ...session, origin: 'routine' as const, routine }
    expect(parseSessionsFile({ sessions: [record] })).toEqual({ version: 1, sessions: [record] })
    expect(
      parseSessionsFile({ sessions: [{ ...record, routine: { ...routine, trigger: 'later' } }] }),
    ).toEqual({ version: 1, sessions: [{ ...session, origin: 'routine' }] })
    expect(
      parseSessionsFile({ sessions: [{ ...record, routine: { ...routine, scheduledFor: 7 } }] }),
    ).toEqual({ version: 1, sessions: [{ ...record, routine: { ...routine, scheduledFor: 7 } }] })
  })

  it('validates routines, failing the file on one that is malformed', () => {
    const routine: Routine = {
      id: 'r-0123456789ab',
      name: 'Morning briefing',
      prompt: 'Summarize the open pull requests',
      agentId: 'claude-code',
      projectPath: '/repo',
      options: [{ id: 'model', value: 'fable' }],
      trigger: {
        kind: 'schedule',
        schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' },
      },
      scope: { level: 'read', web: false },
      timeLimitMinutes: 60,
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
      checkedThrough: 3,
    }
    expect(parseRoutinesFile({ routines: [routine] })).toEqual({ version: 1, routines: [routine] })
    expect(parseRoutinesFile({ routines: {} })).toBe('routines is not a list')
    for (const broken of [
      { ...routine, id: 'routine-1' },
      { ...routine, name: 'x'.repeat(121) },
      { ...routine, prompt: '' },
      { ...routine, agentId: 'unknown-agent' },
      { ...routine, projectPath: 7 },
      { ...routine, options: [{ id: '', value: true }] },
      { ...routine, options: [{ id: 'model', value: 'x'.repeat(201) }] },
      {
        ...routine,
        trigger: { kind: 'schedule', schedule: { kind: 'weekly', days: [], time: '09:00' } },
      },
      {
        ...routine,
        trigger: { kind: 'schedule', schedule: { kind: 'weekly', days: [1], time: '25:00' } },
      },
      { ...routine, scope: { level: 'all', web: false } },
      { ...routine, timeLimitMinutes: 45 },
      { ...routine, enabled: 'yes' },
      { ...routine, createdAt: -1 },
    ]) {
      expect(parseRoutinesFile({ routines: [routine, broken] })).toBe('routine 1 is malformed')
    }
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

  it('keeps what each agent reported and drops what does not parse, entry by entry', () => {
    const account = { kind: 'account', label: 'Claude Max', email: 'me@example.com' }
    const limit = {
      window: 'five_hour',
      label: '5-hour',
      usedPercent: 42,
      resetsAt: 1_000,
      state: 'ok',
      observedAt: 500,
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

  it('keeps when the archived Codex report threads were removed, and drops a time that does not parse', () => {
    expect(parseAgentsFile({ agents: {}, codexReportThreadsRemovedAt: 7 })).toEqual({
      version: 1,
      agents: {},
      codexReportThreadsRemovedAt: 7,
    })
    expect(parseAgentsFile({ agents: {}, codexReportThreadsRemovedAt: 'x' })).toEqual({
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
})
