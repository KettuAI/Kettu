import { describe, expect, it, vi } from 'vitest'
import type { HostActivitySnapshot } from '@shared/host-control'
import { DEFAULT_CHOICES, type DevicePush } from '@shared/remote/push'
import { Notifier, type PushJob } from './notifier'

const TOKEN = 'a1'.repeat(32)
const START_TOKEN = 'b2'.repeat(32)
const UPDATE_TOKEN = 'c3'.repeat(32)

function makeDevice(
  overrides: Partial<DevicePush> = {},
  id = 'phone',
): { id: string; push: DevicePush } {
  return {
    id,
    push: {
      target: {
        apns: { token: TOKEN, environment: 'sandbox' },
        activity: { start: START_TOKEN, update: UPDATE_TOKEN },
      },
      choices: { ...DEFAULT_CHOICES, onlyAway: false },
      ...overrides,
    },
  }
}

describe('Notifier Live Activity 全状态调度', () => {
  it('按 waiting > error > running > limit > turn-ended 优先级推进并在空闲时自动结束', async () => {
    vi.useFakeTimers()
    try {
      const device = makeDevice({
        target: {
          apns: { token: TOKEN, environment: 'sandbox' },
          activity: { start: START_TOKEN },
        },
      })
      const jobs: PushJob[] = []
      const notifier = new Notifier({
        devices: () => [device],
        showing: () => false,
        send: (job) => jobs.push(job),
        mergeMs: 10,
      })

      const now = Date.now()
      const empty: HostActivitySnapshot = {
        running: [],
        error: [],
        ended: [],
        limit: null,
        waitingMeta: {},
      }

      // 1. 仅有运行中会话时主动 start，优先顶层主会话
      notifier.setActivity({
        ...empty,
        running: [
          {
            sessionId: 'sub-1',
            agentId: 'codex',
            title: 'Child job',
            turnStartedAt: now - 10_000,
            parentId: 'main-1',
          },
          {
            sessionId: 'main-1',
            agentId: 'claude-code',
            title: 'Build island',
            turnStartedAt: now - 30_000,
            project: 'Kettu',
            plan: { done: 2, total: 5, current: 'Run tests' },
            parentId: null,
          },
        ],
      })
      vi.advanceTimersByTime(20)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]).toMatchObject({
        type: 'activity',
        action: 'start',
        payload: {
          kind: 'running',
          sessionId: 'main-1',
          agentId: 'claude-code',
          title: 'Build island',
          plan: { done: 2, total: 5, current: 'Run tests' },
        },
      })

      // 模拟设备回传 activityUpdate token 后，更高优先级的 waiting 覆盖 running
      device.push.target!.activity = { start: START_TOKEN, update: UPDATE_TOKEN }
      notifier.attention({
        kind: 'permission',
        sessionId: 'main-1',
        title: 'Build island',
        body: 'Wants to run pnpm test',
        requestId: 'req-1',
        actions: { allow: { optionId: 'allow', label: 'Allow' } },
        inFront: false,
        devices: [],
      })
      notifier.setWaiting({ 'main-1': ['req-1'] })
      vi.advanceTimersByTime(20)
      const waitJob = jobs.find(
        (j) => j.type === 'activity' && j.action === 'update' && j.payload?.kind === 'waiting',
      )
      expect(waitJob).toMatchObject({
        type: 'activity',
        action: 'update',
        count: 1,
        payload: {
          kind: 'waiting',
          count: 1,
          sessionId: 'main-1',
          actionKind: 'execute',
          requestId: 'req-1',
        },
      })

      // 3. 审批解除且无运行中会话，但有最近报错 -> 切到 error
      notifier.setWaiting({})
      notifier.setActivity({
        ...empty,
        error: [
          {
            sessionId: 'main-1',
            agentId: 'codex',
            title: 'Sync job',
            body: 'Command exited with code 1',
            endedAt: now - 5_000,
            project: 'kettu-cloud',
          },
        ],
      })
      vi.advanceTimersByTime(20)
      const errJob = jobs.at(-1)
      expect(errJob).toMatchObject({
        type: 'activity',
        action: 'update',
        payload: { kind: 'error', sessionId: 'main-1', body: 'Command exited with code 1' },
      })

      // 4. 全部空闲后自动发送 end 关闭灵动岛
      notifier.setActivity(empty)
      vi.advanceTimersByTime(20)
      expect(jobs.at(-1)).toMatchObject({ type: 'activity', action: 'end' })
      notifier.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('当 iPhone 本地已启动灵动岛并上报 update token 时，主机即使在电脑前也能持续 update 与 end', () => {
    vi.useFakeTimers()
    try {
      const device = makeDevice({
        choices: { ...DEFAULT_CHOICES, onlyAway: true },
        target: {
          apns: { token: TOKEN, environment: 'sandbox' },
          activity: { start: START_TOKEN, update: UPDATE_TOKEN },
        },
      })
      const jobs: PushJob[] = []
      const notifier = new Notifier({
        devices: () => [device],
        showing: () => false,
        send: (job) => jobs.push(job),
        mergeMs: 10,
      })
      notifier.setPresent(true)
      const now = Date.now()
      notifier.setActivity({
        running: [
          {
            sessionId: 's-1',
            agentId: 'claude-code',
            title: 'Refactor widgets',
            turnStartedAt: now - 15_000,
            parentId: null,
          },
        ],
        error: [],
        ended: [],
        limit: null,
        waitingMeta: {},
      })
      vi.advanceTimersByTime(20)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]).toMatchObject({
        type: 'activity',
        action: 'update',
        payload: { kind: 'running', sessionId: 's-1' },
      })
      notifier.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
