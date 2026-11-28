import { describe, expect, it, vi } from 'vitest'
import type { HostActivitySnapshot } from '@shared/host-control'
import { DEFAULT_CHOICES, LIVE_ACTIVITY_V2, type DevicePush } from '@shared/remote/push'
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
        activity: { start: START_TOKEN, update: UPDATE_TOKEN, version: LIVE_ACTIVITY_V2 },
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
          activity: { start: START_TOKEN, version: LIVE_ACTIVITY_V2 },
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
      device.push.target!.activity = {
        start: START_TOKEN,
        update: UPDATE_TOKEN,
        version: LIVE_ACTIVITY_V2,
      }
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

  it('开启 onlyAway 且人在电脑前时停止远程更新并收尾后台灵动岛；关闭 onlyAway 则始终实时推送', () => {
    vi.useFakeTimers()
    try {
      const device = makeDevice({
        choices: { ...DEFAULT_CHOICES, onlyAway: true },
        target: {
          apns: { token: TOKEN, environment: 'sandbox' },
          activity: { start: START_TOKEN, update: UPDATE_TOKEN, version: LIVE_ACTIVITY_V2 },
        },
      })
      const jobs: PushJob[] = []
      const notifier = new Notifier({
        devices: () => [device],
        showing: () => false,
        foreground: () => false,
        send: (job) => jobs.push(job),
        mergeMs: 10,
      })
      notifier.setPresent(true)
      const now = Date.now()
      const runningSnap: HostActivitySnapshot = {
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
      }
      notifier.setActivity(runningSnap)
      vi.advanceTimersByTime(20)
      // 人在电脑前且开启 onlyAway，后台残留的灵动岛直接发 end 收尾，不推新的远程更新。
      expect(jobs).toHaveLength(1)
      expect(jobs[0]).toMatchObject({ type: 'activity', action: 'end', count: 0 })

      // 模拟结束发送后释放旧 token，再有审批请求也不会推给后台手机。
      device.push.target!.activity = { start: START_TOKEN }
      notifier.attention({
        kind: 'permission',
        sessionId: 's-1',
        title: 'Refactor widgets',
        body: 'Wants to run pnpm test',
        requestId: 'req-1',
        inFront: false,
        devices: [],
      })
      notifier.setWaiting({ 's-1': ['req-1'] })
      vi.advanceTimersByTime(20)
      expect(jobs).toHaveLength(1)

      // 用户关掉 onlyAway（始终实时推送）后，即便人在电脑前也会立刻推 start。
      device.push.choices = { ...device.push.choices, onlyAway: false }
      notifier.deviceChanged()
      vi.advanceTimersByTime(20)
      expect(jobs).toHaveLength(2)
      expect(jobs[1]).toMatchObject({
        type: 'activity',
        action: 'start',
        count: 1,
        payload: { kind: 'waiting', sessionId: 's-1', requestId: 'req-1' },
      })
      notifier.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('发出 push-to-start 尚未收到 updateToken 前请求已解决时，立即取消在途 start 并在回传 token 后补发 end', () => {
    vi.useFakeTimers()
    try {
      const device = makeDevice({
        choices: { ...DEFAULT_CHOICES, onlyAway: false },
        target: {
          apns: { token: TOKEN, environment: 'sandbox' },
          activity: { start: START_TOKEN },
        },
      })
      const jobs: PushJob[] = []
      const cancelled: { deviceId: string; key: string }[] = []
      const notifier = new Notifier({
        devices: () => [device],
        showing: () => false,
        foreground: () => false,
        send: (job) => jobs.push(job),
        cancel: (deviceId, key) => cancelled.push({ deviceId, key }),
        mergeMs: 10,
      })

      notifier.attention({
        kind: 'permission',
        sessionId: 's-fast',
        title: 'Quick confirm',
        body: 'Wants to run ls',
        requestId: 'req-fast',
        inFront: false,
        devices: [],
      })
      notifier.setWaiting({ 's-fast': ['req-fast'] })
      vi.advanceTimersByTime(20)
      expect(jobs.filter((j) => j.type === 'activity')).toHaveLength(1)
      expect(jobs.find((j) => j.type === 'activity')).toMatchObject({ action: 'start' })

      // 桌面端立刻选完卡片，但此时 iPhone 尚未上报 updateToken。
      notifier.setWaiting({})
      vi.advanceTimersByTime(20)
      expect(cancelled).toContainEqual({ deviceId: 'phone', key: 'activity' })
      // 尚未收到 updateToken 时发不出 end，也不应丢失 pendingEnd 状态。
      expect(jobs.filter((j) => j.type === 'activity')).toHaveLength(1)
      expect(notifier.isJobValid(jobs.find((j) => j.type === 'activity')!)).toBe(false)

      // 几秒后 iPhone 收到刚才已飞出的 push-to-start 并回传 updateToken，主机立即补发 end 清理孤儿岛。
      device.push.target!.activity = { start: START_TOKEN, update: UPDATE_TOKEN }
      notifier.deviceChanged()
      vi.advanceTimersByTime(20)
      const activityJobs = jobs.filter((j) => j.type === 'activity')
      expect(activityJobs).toHaveLength(2)
      expect(activityJobs[1]).toMatchObject({ type: 'activity', action: 'end', count: 0 })
      notifier.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
