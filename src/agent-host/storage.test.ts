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
  parseSessionsFile,
  projectsFile,
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
  dir = await mkdtemp(path.join(tmpdir(), 'overbench-storage-'))
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
          gemini: { account, limits: [] },
        },
      }),
    ).toEqual({ version: 1, agents: { 'claude-code': { account, limits: [limit] } } })
    expect(parseAgentsFile({ agents: [] })).toBe('agents is not an object')
    expect(agentsFile(dir, log).file).toBe(path.join(dir, 'state', 'agents.json'))
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
          gemini: { checkedAt: 1_000, latest },
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
