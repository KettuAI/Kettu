import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionListDelta, SessionSummary } from '@shared/agent-host'
import type { AgentManager } from './agents'
import { Diagnostics } from './diagnostics'
import type { Projects } from './projects'
import type { ScratchFolders } from './scratch'
import { SessionManager, type SessionEvents } from './sessions'
import { returnedFile, sessionsFile, type SessionRecord } from './storage'
import { startTestHost, type TestHost } from './testing/harness'
import { SessionTitles } from '../remote-host/titles'

let dir: string
const managers: SessionManager[] = []
const hosts: TestHost[] = []

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-list-delta-'))
})

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
  const created = managers.splice(0)
  for (const sessions of created) sessions.shutdown()
  await Promise.all(created.map((sessions) => sessions.flush()))
  await rm(dir, { recursive: true, force: true })
})

const log = () => {}

function record(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    agentId: 'claude-code',
    acpSessionId: `acp-${id}`,
    projectPath: '/repo-a',
    title: `Session ${id}`,
    createdAt: 1,
    updatedAt: 10,
    lastViewedAt: null,
    parentId: null,
    origin: 'user',
    description: null,
    branch: null,
    ...overrides,
  }
}

async function createManager(
  records: SessionRecord[],
  options: {
    listTombstoneLimit?: number
    events?: Partial<SessionEvents>
  } = {},
) {
  const store = sessionsFile(dir, log)
  store.save({ version: 1, sessions: records })
  await store.flush()

  const summaryEvents: { summary: SessionSummary; rev?: number }[] = []
  const removedEvents: { sessionId: string; rev?: number }[] = []

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
    } as unknown as AgentManager,
    projects: {
      list: () => [],
      resolveDirectory: async (folder: string) => folder,
      add: async () => {},
    } as unknown as Projects,
    scratch: { contains: () => false } as unknown as ScratchFolders,
    file: sessionsFile(dir, log),
    returned: returnedFile(dir, log),
    portOpen: () => false,
    threads: null,
    reportsDir: path.join(dir, 'reports'),
    diagnostics: new Diagnostics(),
    git: () => null,
    events: new Proxy(
      {
        summary: (summary: SessionSummary, _portIds?: readonly string[], rev?: number) => {
          summaryEvents.push({ summary, ...(rev !== undefined ? { rev } : {}) })
        },
        removed: (sessionId: string, _portIds?: readonly string[], rev?: number) => {
          removedEvents.push({ sessionId, ...(rev !== undefined ? { rev } : {}) })
        },
        ...options.events,
      },
      {
        get: (target, prop) => Reflect.get(target, prop) ?? (() => {}),
      },
    ) as SessionEvents,
    settings: () => ({ startModes: {} }) as never,
    ...(options.listTombstoneLimit !== undefined
      ? { listTombstoneLimit: options.listTombstoneLimit }
      : {}),
  } satisfies ConstructorParameters<typeof SessionManager>[0]

  const sessions = new SessionManager(deps)
  managers.push(sessions)
  await sessions.load()
  return { sessions, summaryEvents, removedEvents }
}

describe('SessionManager.listDelta 修订号与墓碑增量同步', () => {
  it('首次 since=0 返回全量公开列表（含归档与子 Agent，排除 routine/task），后续仅返回增量变更与删除', async () => {
    const { sessions, summaryEvents, removedEvents } = await createManager([
      record('s1', { projectPath: '/repo-a', updatedAt: 30 }),
      record('s2', { projectPath: '/repo-a', archivedAt: 20, updatedAt: 20 }),
      record('sub1', { projectPath: '/repo-a', parentId: 's1', origin: 'subagent', updatedAt: 25 }),
      record('s3', { projectPath: '/repo-b', updatedAt: 15 }),
      record('r1', { projectPath: '/repo-a', origin: 'routine', updatedAt: 40 }),
      record('t1', { projectPath: '/repo-a', origin: 'task', updatedAt: 50 }),
    ])

    // 首次同步：full = true，包含归档会话与子 Agent，不包含 routine / task
    const initial = sessions.listDelta(0)
    expect(initial.full).toBe(true)
    expect(initial.revision).toBe(1)
    expect(initial.removed).toEqual([])
    expect(initial.changed.map((item) => item.id)).toEqual(['s1', 'sub1', 's2', 's3'])

    // 无变更时增量为空
    expect(sessions.listDelta(initial.revision)).toEqual({
      revision: initial.revision,
      full: false,
      changed: [],
      removed: [],
    })

    // 重命名、取消归档、归档均推进修订号并在实时事件附带递增 rev
    sessions.rename('s1', 'Renamed s1')
    await sessions.unarchive('s2')
    await sessions.delete('s3')

    expect(summaryEvents.map((e) => [e.summary.id, e.rev])).toEqual([
      ['s1', 2],
      ['s2', 3],
    ])
    expect(removedEvents).toEqual([{ sessionId: 's3', rev: 4 }])

    // 从 rev=1 拉增量，仅含 s1/s2 变更与 s3 删除
    const delta = sessions.listDelta(1)
    expect(delta.full).toBe(false)
    expect(delta.revision).toBe(4)
    expect(delta.changed.map((item) => item.id).sort()).toEqual(['s1', 's2'])
    expect(delta.changed.find((item) => item.id === 's1')?.title).toBe('Renamed s1')
    expect(delta.changed.find((item) => item.id === 's2')?.archivedAt).toBeNull()
    expect(delta.removed).toEqual(['s3'])

    // 按 projectPath 过滤增量变更与删除
    const repoADelta = sessions.listDelta(1, '/repo-a')
    expect(repoADelta.full).toBe(false)
    expect(repoADelta.changed.map((item) => item.id).sort()).toEqual(['s1', 's2'])
    expect(repoADelta.removed).toEqual([])

    const repoBDelta = sessions.listDelta(1, '/repo-b')
    expect(repoBDelta.full).toBe(false)
    expect(repoBDelta.changed).toEqual([])
    expect(repoBDelta.removed).toEqual(['s3'])

    // 游标大于当前修订号（例如主机重启后客户端残留旧游标）自动回退全量
    const restarted = sessions.listDelta(999)
    expect(restarted.full).toBe(true)
    expect(restarted.revision).toBe(4)
    expect(restarted.changed.map((item) => item.id).sort()).toEqual(['s1', 's2', 'sub1'])
    expect(restarted.removed).toEqual([])
  })

  it('删除数量超出墓碑保留窗口时，落后客户端回退 full=true，未落后客户端继续走增量', async () => {
    const { sessions, removedEvents } = await createManager(
      [record('a'), record('b'), record('c'), record('keep')],
      { listTombstoneLimit: 2 },
    )

    const rev0 = sessions.listDelta(0).revision
    expect(rev0).toBe(1)

    // 连续删除 3 个会话（墓碑上限为 2），a 的删除（rev=2）被淘汰，tombstoneFloorRev 变为 2
    await sessions.delete('a')
    await sessions.delete('b')
    await sessions.delete('c')
    expect(removedEvents.map((e) => [e.sessionId, e.rev])).toEqual([
      ['a', 2],
      ['b', 3],
      ['c', 4],
    ])

    // 客户端停在 rev=1（早于被淘汰的 a=2）：无法保证不错过 a 的删除，必须回退 full=true
    const stale = sessions.listDelta(1)
    expect(stale.full).toBe(true)
    expect(stale.revision).toBe(4)
    expect(stale.changed.map((item) => item.id)).toEqual(['keep'])
    expect(stale.removed).toEqual([])

    // 客户端已跟上到 rev=2（已收到 a 的删除）：b=3 与 c=4 均在窗口内，可继续增量
    const fresh = sessions.listDelta(2)
    expect(fresh.full).toBe(false)
    expect(fresh.revision).toBe(4)
    expect(fresh.changed).toEqual([])
    expect(fresh.removed).toEqual(['b', 'c'])
  })
})

describe('AgentHost sessions.list 增量 RPC 与实时事件 rev', () => {
  it('省略 since 保持返回数组，传入 since 返回 SessionListDelta 并与实时事件 rev 连续衔接', async () => {
    const host = await startTestHost()
    hosts.push(host)
    const port = host.connect()

    // 旧式调用省略 since，保持返回 SessionSummary[]
    const emptyList = await port.request('sessions.list', {})
    expect(Array.isArray(emptyList)).toBe(true)
    expect(emptyList).toEqual([])

    const created = await port.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: host.project,
    })
    await port.untilStatus(created.id, 'ready')

    const fullDelta = (await port.request('sessions.list', {
      since: 0,
    })) as unknown as SessionListDelta
    expect(fullDelta.full).toBe(true)
    expect(fullDelta.revision).toBeGreaterThan(0)
    expect(fullDelta.changed.map((s) => s.id)).toEqual([created.id])
    expect(fullDelta.removed).toEqual([])

    // 重命名后增量拉取只返回变更会话，且实时事件携带匹配的 rev
    const beforeRenameRev = fullDelta.revision
    await port.request('sessions.rename', { sessionId: created.id, title: 'Updated title' })
    const summaryEvent = [...port.events]
      .reverse()
      .find(
        (event) =>
          event.type === 'session.summary' &&
          event.summary.id === created.id &&
          event.summary.title === 'Updated title',
      )
    expect(summaryEvent?.type === 'session.summary' && summaryEvent.rev).toBeGreaterThan(
      beforeRenameRev,
    )

    const incDelta = (await port.request('sessions.list', {
      since: beforeRenameRev,
    })) as unknown as SessionListDelta
    expect(incDelta.full).toBe(false)
    expect(incDelta.changed.map((s) => s.title)).toEqual(['Updated title'])
    expect(incDelta.removed).toEqual([])

    // 删除后增量拉取在 removed 返回已删会话，且实时 session.removed 事件附带 rev
    const beforeDeleteRev = incDelta.revision
    await port.request('sessions.delete', { sessionId: created.id })
    const removedEvent = port.events.find(
      (event) => event.type === 'session.removed' && event.sessionId === created.id,
    )
    expect(removedEvent?.type === 'session.removed' && removedEvent.rev).toBeGreaterThan(
      beforeDeleteRev,
    )

    const afterDelete = (await port.request('sessions.list', {
      since: beforeDeleteRev,
    })) as unknown as SessionListDelta
    expect(afterDelete.full).toBe(false)
    expect(afterDelete.changed).toEqual([])
    expect(afterDelete.removed).toEqual([created.id])
  })
})

describe('SessionTitles 兼容 sessions.list 增量响应', () => {
  it('从 full 与 delta 响应中同步维护会话标题与删除项', () => {
    const titles = new SessionTitles()
    titles.request(1, 'sessions.list')
    titles.received({
      type: 'response',
      id: 1,
      result: {
        revision: 1,
        full: true,
        changed: [
          { id: 's1', title: 'Alpha' },
          { id: 's2', title: 'Beta' },
        ],
        removed: [],
      },
    })
    expect(titles.get('s1')).toBe('Alpha')
    expect(titles.get('s2')).toBe('Beta')

    titles.request(2, 'sessions.list')
    titles.received({
      type: 'response',
      id: 2,
      result: {
        revision: 3,
        full: false,
        changed: [{ id: 's1', title: 'Alpha v2' }],
        removed: ['s2'],
      },
    })
    expect(titles.get('s1')).toBe('Alpha v2')
    expect(titles.get('s2')).toBeUndefined()
  })
})
