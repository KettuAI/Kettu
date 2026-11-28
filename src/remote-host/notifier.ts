// When the host notifies its devices through the push gateway, decided from what the agent host
// reports: a request starts waiting, a turn ends out of view, a turn or a routine fails, a
// routine's run ends. Each device's choices decide what it hears; one that shows the session in
// front hears nothing of it; while the user is at the desktop app, its own notifications tell them
// and devices that want it only while the user is away wait until they leave. A session's
// notifications merge into one, and one that no longer applies, a request answered elsewhere or a
// turn seen since, is withdrawn. Requests that wait also drive each device's Live Activity.
// Devices joining the host are notices of their own: a device of the account that asks to be
// added, until it is answered, and a device that joined, to every device that is not in front.

import type { HostActivitySnapshot } from '@shared/host-control'
import type {
  DevicePush,
  LiveActivityPlan,
  LiveQuickOptions,
  NotificationChoices,
  PushActions,
  PushEvent,
} from '@shared/remote/push'

/** 推送到移动端灵动岛与锁屏实时活动的 5 态语义负载。 */
export type LiveActivityPayload =
  | {
      kind: 'waiting'
      count: number
      sessionId: string | null
      title: string | null
      body?: string
      agentId?: string
      requestId?: string
      actions?: PushActions
      since?: number
      actionKind?: 'execute' | 'edit' | 'review' | 'question'
      quickOptions?: LiveQuickOptions
    }
  | {
      kind: 'error'
      sessionId: string
      title: string | null
      body?: string
      agentId?: string
      project?: string
    }
  | {
      kind: 'running'
      sessionId: string
      title: string | null
      body?: string
      agentId?: string
      turnStartedAt?: number
      phase?: string
      activityKind?: string
      runningCount?: number
      plan?: LiveActivityPlan
      project?: string
    }
  | {
      kind: 'turn-ended'
      sessionId: string
      title: string | null
      body?: string
      agentId?: string
      project?: string
    }
  | {
      kind: 'limit'
      agentId: string
      label?: string
      planLabel?: string
      resetsAt?: number
      pausedSessions?: number
    }

export type AttentionKind =
  'permission' | 'turn-ended' | 'error' | 'routine-ended' | 'routine-paused' | 'plan-limit'

/** What the agent host says needs the user, as the remote host hears it from its parent. */
export interface Attention {
  kind: AttentionKind
  /** Every kind except `routine-paused` and `plan-limit`, which name their agent instead. */
  sessionId?: string
  agentId?: string
  /** 回合完成时改动的文件数量，供移动端锁屏通知副标题呈现。 */
  changedFiles?: number
  /** 套餐额度通知的告警级别与去重键。 */
  limitLevel?: 'warning' | 'reached' | 'reset'
  limitKey?: string
  title: string
  body: string
  /** The request that waits, which the waiting list names until it is answered or withdrawn. */
  requestId?: string
  /** The one-time answers a notification may offer, when the request fits in one. */
  actions?: PushActions
  /** 移动端实时活动与锁屏通知的请求语义分类与 2–3 项快捷选项。 */
  actionKind?: 'execute' | 'edit' | 'review' | 'question'
  quickOptions?: LiveQuickOptions
  /** The session was in front of a window or a device when this happened. */
  inFront: boolean
  /** The devices that had it in front then. */
  devices: string[]
}

/** A push for the sender to seal, sign and send. */
export type PushJob = {
  deviceId: string
  /** What the notification's tag is made of: a session's id, `routines:<agent>` or `activity`. */
  subject: string
} & (
  | { type: 'alert'; event: PushEvent; title: string; body: string }
  | { type: 'background'; event: PushEvent }
  | {
      type: 'activity'
      action: 'start' | 'update' | 'end'
      count: number
      sessionId: string | null
      title: string | null
      payload?: LiveActivityPayload
    }
)

export interface NotifierDevice {
  id: string
  push: DevicePush
}

export interface NotifierOptions {
  /** The paired devices that set notifications. */
  devices(): NotifierDevice[]
  /** Whether the device shows the session in front now. */
  showing(deviceId: string, sessionId: string): boolean
  /**
   * Whether the device shows the host's notifications itself now, as a browser's page does while
   * it is connected: it is pushed nothing meanwhile.
   */
  notifiesItself?(deviceId: string): boolean
  /** Whether the device is connected and in front, so it shows a notice in the app instead. */
  foreground?(deviceId: string): boolean
  send(job: PushJob): void
  /** How long a device's notifications of one subject wait to merge into one. */
  mergeMs?: number
}

/** The subject of the Live Activity's tag. */
export const ACTIVITY_SUBJECT = 'activity'

/** The subject of the notice of a device of the account that asks to be added. */
export const DEVICE_REQUEST_SUBJECT = 'device-request'

/** A notice about devices, which goes out at once to each device that wants it. */
export interface DeviceNotice {
  subject: string
  event: PushEvent
  title: string
  body: string
}

const MERGE_MS = 1000
const ERROR_ACTIVITY_MS = 15 * 60_000
const ENDED_ACTIVITY_MS = 2 * 60_000
/** Node.js setTimeout caps delays at 2^31 - 1 ms (~24.8 days); chain longer waits. */
const MAX_ACTIVITY_TIMER_MS = 2_147_483_647

/**
 * Only active in-flight states may push-to-start a new Live Activity.
 * Settled states (`turn-ended`, `error`, `limit`) only update an already-active
 * Live Activity until it expires or is dismissed.
 */
function canStartActivity(payload: LiveActivityPayload): boolean {
  return payload.kind === 'waiting' || payload.kind === 'running'
}

/** What a device's notification of a subject is about now. */
interface Told {
  kind: AttentionKind
  requestId: string | undefined
}

interface Activity {
  running: boolean
  fingerprint: string
}

/** Whether a push reaches the device: through APNs or Web Push. */
const reachable = (push: DevicePush): boolean => push.target !== null || push.web !== undefined

const subjectOf = (attention: Attention): string => {
  if (attention.kind === 'routine-paused') return `routines:${attention.agentId}`
  if (attention.kind === 'plan-limit') return `limit:${attention.limitKey ?? attention.agentId}`
  return attention.sessionId!
}

function wants(choices: NotificationChoices, kind: AttentionKind): boolean {
  switch (kind) {
    case 'permission':
      return choices.permission
    case 'turn-ended':
      return choices.turnEnded
    case 'error':
      return choices.errors
    case 'routine-ended':
    case 'routine-paused':
      return choices.routines
    case 'plan-limit':
      return choices.planLimits === true
  }
}

function pushEvent(attention: Attention): PushEvent {
  switch (attention.kind) {
    case 'permission':
      return {
        kind: 'permission',
        sessionId: attention.sessionId!,
        ...(attention.agentId ? { agentId: attention.agentId } : {}),
        ...(attention.requestId ? { requestId: attention.requestId } : {}),
        ...(attention.actions ? { actions: attention.actions } : {}),
        ...(attention.actionKind ? { actionKind: attention.actionKind } : {}),
        ...(attention.quickOptions ? { quickOptions: attention.quickOptions } : {}),
      }
    case 'turn-ended':
      return {
        kind: 'turn-ended',
        sessionId: attention.sessionId!,
        ...(attention.agentId ? { agentId: attention.agentId } : {}),
        ...(attention.changedFiles ? { changedFiles: attention.changedFiles } : {}),
      }
    case 'error':
      return {
        kind: 'error',
        sessionId: attention.sessionId!,
        ...(attention.agentId ? { agentId: attention.agentId } : {}),
      }
    case 'routine-ended':
      return {
        kind: 'routine-ended',
        sessionId: attention.sessionId!,
        ...(attention.agentId ? { agentId: attention.agentId } : {}),
      }
    case 'routine-paused':
      return { kind: 'routine-paused', agentId: attention.agentId! }
    case 'plan-limit':
      return {
        kind: 'plan-limit',
        agentId: attention.agentId!,
        ...(attention.limitLevel ? { limitLevel: attention.limitLevel } : {}),
      }
  }
}

export class Notifier {
  /** Whether the user is at the desktop app; null where the host cannot tell, as the daemon. */
  private present: boolean | null = null
  /** What waits for an answer, by session: the ids the agent host listed. */
  private waiting = new Map<string, Set<string>>()
  /** Sessions by when a request in them last started waiting, the newest last. */
  private order: string[] = []
  /** Per subject, what a device may still need to hear: a request that waits or a turn not seen. */
  private readonly open = new Map<string, Attention>()
  /** Per device, what its notification of each subject is about. */
  private readonly told = new Map<string, Map<string, Told>>()
  /** Per device and subject, the notification waiting to merge with a newer one. */
  private readonly queued = new Map<string, { attention: Attention; timer: NodeJS.Timeout }>()
  private readonly activities = new Map<string, Activity>()
  private readonly activityTimers = new Map<string, NodeJS.Timeout>()
  /** Re-evaluates Live Activities when the earliest timed state (error / ended / limit) expires. */
  private activityExpiryTimer: NodeJS.Timeout | null = null
  /** Per device, the subjects of the device notices it was sent. */
  private readonly noticed = new Map<string, Set<string>>()
  /** Latest host session, error, completion, and limit snapshot driving Live Activities. */
  private hostActivity: HostActivitySnapshot | null = null
  private readonly mergeMs: number

  constructor(private readonly options: NotifierOptions) {
    this.mergeMs = options.mergeMs ?? MERGE_MS
  }

  /** Something needs the user. */
  attention(attention: Attention): void {
    const agentScoped = attention.kind === 'routine-paused' || attention.kind === 'plan-limit'
    if (agentScoped ? !attention.agentId : !attention.sessionId) return
    // A turn that ended in front of someone was seen there.
    if (attention.kind === 'turn-ended' && attention.inFront) return
    const subject = subjectOf(attention)
    if (!agentScoped) this.open.set(subject, attention)
    if (attention.kind === 'permission') {
      this.order = [...this.order.filter((id) => id !== subject), subject]
    }
    for (const device of this.options.devices()) this.consider(device, subject, attention)
    if (attention.kind === 'permission') this.activitiesChanged()
  }

  /** What waits for an answer now, by session; requests answered or withdrawn are gone from it. */
  setWaiting(sessions: Record<string, string[]>): void {
    this.waiting = new Map(
      Object.entries(sessions)
        .filter(([, ids]) => ids.length > 0)
        .map(([sessionId, ids]) => [sessionId, new Set(ids)]),
    )
    this.order = this.order.filter((sessionId) => this.waiting.has(sessionId))
    for (const [subject, attention] of this.open) {
      if (attention.kind === 'permission' && !this.stillWaiting(attention))
        this.open.delete(subject)
    }
    for (const [key, queued] of this.queued) {
      if (queued.attention.kind === 'permission' && !this.stillWaiting(queued.attention)) {
        clearTimeout(queued.timer)
        this.queued.delete(key)
      }
    }
    for (const [deviceId, told] of this.told) {
      for (const [subject, what] of told) {
        // Another request of the session may still wait, whose answer finds out it was answered.
        if (what.kind === 'permission' && !this.waiting.has(subject)) {
          this.withdraw(deviceId, subject, told)
        }
      }
    }
    this.activitiesChanged()
  }

  /** A session was seen: its turn's notifications no longer apply. */
  seen(sessionId: string): void {
    const attention = this.open.get(sessionId)
    if (attention && attention.kind !== 'permission') this.open.delete(sessionId)
    for (const [key, queued] of this.queued) {
      if (subjectOf(queued.attention) === sessionId && queued.attention.kind !== 'permission') {
        clearTimeout(queued.timer)
        this.queued.delete(key)
      }
    }
    for (const [deviceId, told] of this.told) {
      const what = told.get(sessionId)
      if (what && what.kind !== 'permission') this.withdraw(deviceId, sessionId, told)
    }
  }

  /**
   * Whether the user is at the desktop app now. Once they leave, what still waits and the turns
   * not seen reach the devices that held them back.
   */
  setPresent(present: boolean): void {
    const was = this.present
    this.present = present
    if (present || was !== true) return
    for (const device of this.options.devices()) {
      for (const [subject, attention] of this.open) {
        const what = this.told.get(device.id)?.get(subject)
        if (what?.kind === attention.kind && what.requestId === attention.requestId) continue
        this.consider(device, subject, attention)
      }
    }
    this.activitiesChanged()
  }

  /** Tells every device that wants notices about devices, but `except`. */
  deviceNotice(notice: DeviceNotice, except?: string): void {
    for (const device of this.options.devices()) {
      if (device.id === except) continue
      const { push } = device
      if (!reachable(push) || !push.choices.device || this.held(push.choices)) continue
      if (this.options.notifiesItself?.(device.id)) continue
      if (this.options.foreground?.(device.id)) continue
      const { subject, event, title, body } = notice
      // Only a request is withdrawn later; a device that joined stays told.
      if (subject === DEVICE_REQUEST_SUBJECT) {
        const noticed = this.noticed.get(device.id) ?? new Set<string>()
        noticed.add(subject)
        this.noticed.set(device.id, noticed)
      }
      this.options.send({ deviceId: device.id, subject, type: 'alert', event, title, body })
    }
  }

  /** A device notice no longer applies, as a request answered elsewhere: it is withdrawn. */
  withdrawNotice(subject: string): void {
    for (const [deviceId, noticed] of this.noticed) {
      if (!noticed.delete(subject)) continue
      this.options.send({ deviceId, subject, type: 'background', event: { kind: 'withdraw' } })
    }
  }

  /** A device changed its target or choices: its Live Activity follows. */
  deviceChanged(): void {
    this.activitiesChanged()
  }

  /** Syncs device Live Activities when the host's running, error, ended, or limit snapshot changes. */
  setActivity(activity: HostActivitySnapshot): void {
    this.hostActivity = activity
    this.scheduleActivityExpiry()
    this.activitiesChanged()
  }

  /** A device was removed: nothing more goes to it. */
  forget(deviceId: string): void {
    this.told.delete(deviceId)
    this.noticed.delete(deviceId)
    this.activities.delete(deviceId)
    const timer = this.activityTimers.get(deviceId)
    if (timer) clearTimeout(timer)
    this.activityTimers.delete(deviceId)
    for (const [key, queued] of this.queued) {
      if (key.startsWith(`${deviceId}\n`)) {
        clearTimeout(queued.timer)
        this.queued.delete(key)
      }
    }
  }

  stop(): void {
    for (const queued of this.queued.values()) clearTimeout(queued.timer)
    this.queued.clear()
    for (const timer of this.activityTimers.values()) clearTimeout(timer)
    this.activityTimers.clear()
    this.clearActivityExpiry()
  }

  private held(choices: NotificationChoices): boolean {
    return choices.onlyAway && this.present === true
  }

  /** Queues the attention for a device that wants it now. */
  private consider(device: NotifierDevice, subject: string, attention: Attention): void {
    const { choices } = device.push
    if (!reachable(device.push) || !wants(choices, attention.kind) || this.held(choices)) return
    if (this.options.notifiesItself?.(device.id)) return
    const { sessionId } = attention
    if (sessionId !== undefined) {
      if (choices.muted.includes(sessionId)) return
      if (attention.devices.includes(device.id)) return
      if (this.options.showing(device.id, sessionId)) return
    }
    const key = `${device.id}\n${subject}`
    const queued = this.queued.get(key)
    if (queued) clearTimeout(queued.timer)
    const timer = setTimeout(() => {
      this.queued.delete(key)
      this.deliver(device.id, subject, attention)
    }, this.mergeMs)
    timer.unref?.()
    this.queued.set(key, { attention, timer })
  }

  private deliver(deviceId: string, subject: string, attention: Attention): void {
    const device = this.options.devices().find((entry) => entry.id === deviceId)
    if (!device || !reachable(device.push) || this.held(device.push.choices)) return
    if (this.options.notifiesItself?.(deviceId)) return
    if (attention.sessionId !== undefined && this.options.showing(deviceId, attention.sessionId)) {
      return
    }
    if (!this.applies(subject, attention)) return
    let told = this.told.get(deviceId)
    if (!told) {
      told = new Map()
      this.told.set(deviceId, told)
    }
    told.set(subject, { kind: attention.kind, requestId: attention.requestId })
    this.options.send({
      deviceId,
      subject,
      type: 'alert',
      event: pushEvent(attention),
      title: attention.title,
      body: attention.body,
    })
  }

  /** Whether the attention still needs the user: its request waits, or its turn was not seen. */
  private applies(subject: string, attention: Attention): boolean {
    if (attention.kind === 'routine-paused' || attention.kind === 'plan-limit') return true
    if (attention.kind === 'permission') return this.stillWaiting(attention)
    return this.open.get(subject) === attention
  }

  private stillWaiting(attention: Attention): boolean {
    const ids = this.waiting.get(attention.sessionId!)
    if (!ids) return false
    // A routine's request names none: its session waiting is enough.
    return attention.requestId === undefined || ids.has(attention.requestId)
  }

  private withdraw(deviceId: string, subject: string, told: Map<string, Told>): void {
    told.delete(subject)
    const event: PushEvent = subject.startsWith('routines:')
      ? { kind: 'withdraw' }
      : { kind: 'withdraw', sessionId: subject }
    this.options.send({ deviceId, subject, type: 'background', event })
  }

  private clearActivityExpiry(): void {
    if (!this.activityExpiryTimer) return
    clearTimeout(this.activityExpiryTimer)
    this.activityExpiryTimer = null
  }

  /** Earliest future timestamp at which a timed activity entry expires, or null if none remain. */
  private nextActivityExpiry(now: number): number | null {
    const snap = this.hostActivity
    if (!snap) return null
    let earliest: number | null = null
    const consider = (at: number): void => {
      if (!Number.isFinite(at) || at <= now) return
      if (earliest === null || at < earliest) earliest = at
    }
    for (const item of snap.error) consider(item.endedAt + ERROR_ACTIVITY_MS)
    for (const item of snap.ended) consider(item.endedAt + ENDED_ACTIVITY_MS)
    if (snap.limit?.resetsAt !== undefined) consider(snap.limit.resetsAt)
    return earliest
  }

  /** Schedules a single timer for the earliest upcoming expiry so idle hosts still end activities. */
  private scheduleActivityExpiry(): void {
    this.clearActivityExpiry()
    const now = Date.now()
    const earliest = this.nextActivityExpiry(now)
    if (earliest === null) return
    const delay = Math.min(earliest - now, MAX_ACTIVITY_TIMER_MS)
    const timer = setTimeout(() => {
      this.activityExpiryTimer = null
      if (Date.now() < earliest) {
        this.scheduleActivityExpiry()
        return
      }
      this.activitiesChanged()
      this.scheduleActivityExpiry()
    }, delay)
    timer.unref?.()
    this.activityExpiryTimer = timer
  }

  /** Each device's Live Activity catches up after a moment, so a burst sends one update. */
  private activitiesChanged(): void {
    for (const device of this.options.devices()) {
      if (this.activityTimers.has(device.id)) continue
      const timer = setTimeout(() => {
        this.activityTimers.delete(device.id)
        this.updateActivity(device.id)
      }, this.mergeMs)
      timer.unref?.()
      this.activityTimers.set(device.id, timer)
    }
  }

  private pickActivityPayload(choices: NotificationChoices): LiveActivityPayload | null {
    const snap = this.hostActivity
    const now = Date.now()
    const isMuted = (sessionId: string): boolean => choices.muted.includes(sessionId)

    // P1：等待审批请求（优先级最高）
    if (choices.permission) {
      let count = 0
      for (const [sessionId, ids] of this.waiting) {
        if (!isMuted(sessionId)) count += ids.size
      }
      if (count > 0) {
        const latest =
          this.order.findLast((sessionId) => !isMuted(sessionId)) ??
          [...this.waiting.keys()].find((sessionId) => !isMuted(sessionId)) ??
          null
        const att = latest ? this.open.get(latest) : undefined
        const meta = latest ? snap?.waitingMeta[latest] : undefined
        const body = att?.body
        const actionKind: 'execute' | 'edit' | 'review' | 'question' | undefined =
          att?.actionKind ??
          (body === undefined
            ? undefined
            : /^(?:Wants to run|Run)\b/i.test(body)
              ? 'execute'
              : /^(?:Wants to (?:edit|delete|move)|Edit)\b/i.test(body)
                ? 'edit'
                : 'review')
        return {
          kind: 'waiting',
          count,
          sessionId: latest,
          title: att?.title ?? meta?.title ?? null,
          ...(body ? { body } : {}),
          ...(meta?.agentId ? { agentId: meta.agentId } : {}),
          ...(att?.requestId ? { requestId: att.requestId } : {}),
          ...(att?.actions ? { actions: att.actions } : {}),
          ...(meta?.since ? { since: meta.since } : {}),
          ...(actionKind ? { actionKind } : {}),
          ...(att?.quickOptions ? { quickOptions: att.quickOptions } : {}),
        }
      }
    }

    if (!snap) return null

    // P2: recent unread error session within the 15-minute window
    if (choices.errors) {
      const err = snap.error.find(
        (item) => !isMuted(item.sessionId) && now - item.endedAt < ERROR_ACTIVITY_MS,
      )
      if (err) {
        return {
          kind: 'error',
          sessionId: err.sessionId,
          title: err.title,
          agentId: err.agentId,
          ...(err.body ? { body: err.body } : {}),
          ...(err.project ? { project: err.project } : {}),
        }
      }
    }

    // P3: running session (prefer top-level session over subagent)
    const activeRunning = snap.running.filter((item) => !isMuted(item.sessionId))
    if (activeRunning.length > 0) {
      const top = activeRunning.find((item) => !item.parentId) ?? activeRunning[0]!
      return {
        kind: 'running',
        sessionId: top.sessionId,
        title: top.title,
        agentId: top.agentId,
        turnStartedAt: top.turnStartedAt,
        runningCount: activeRunning.length,
        ...(top.body ? { body: top.body } : {}),
        ...(top.phase ? { phase: top.phase } : {}),
        ...(top.activityKind ? { activityKind: top.activityKind } : {}),
        ...(top.plan ? { plan: top.plan } : {}),
        ...(top.project ? { project: top.project } : {}),
      }
    }

    // P4: reached plan limit that has not reset yet
    if (snap.limit && (snap.limit.resetsAt === undefined || snap.limit.resetsAt > now)) {
      return {
        kind: 'limit',
        agentId: snap.limit.agentId,
        label: snap.limit.label,
        ...(snap.limit.planLabel ? { planLabel: snap.limit.planLabel } : {}),
        ...(snap.limit.resetsAt !== undefined ? { resetsAt: snap.limit.resetsAt } : {}),
        ...(snap.limit.pausedSessions ? { pausedSessions: snap.limit.pausedSessions } : {}),
      }
    }

    // P5: recently finished unread turn within the 2-minute window
    if (choices.turnEnded) {
      const done = snap.ended.find(
        (item) => !isMuted(item.sessionId) && now - item.endedAt < ENDED_ACTIVITY_MS,
      )
      if (done) {
        return {
          kind: 'turn-ended',
          sessionId: done.sessionId,
          title: done.title,
          agentId: done.agentId,
          ...(done.body ? { body: done.body } : {}),
          ...(done.project ? { project: done.project } : {}),
        }
      }
    }

    return null
  }

  private updateActivity(deviceId: string): void {
    const device = this.options.devices().find((entry) => entry.id === deviceId)
    const state = this.activities.get(deviceId) ?? { running: false, fingerprint: '' }
    const target = device?.push.target
    const tokens = target?.activity
    const choices = device?.push.choices
    const enabled = Boolean(target && choices && (tokens?.start || tokens?.update))
    const payload = enabled && choices ? this.pickActivityPayload(choices) : null
    // Once a device reports an update token (e.g., started locally before backgrounding),
    // the host takes over subsequent updates and dismissal.
    const hasLiveActivity = state.running || Boolean(tokens?.update)

    const send = (action: 'start' | 'update' | 'end', next: LiveActivityPayload | null): void =>
      this.options.send({
        deviceId,
        subject: ACTIVITY_SUBJECT,
        type: 'activity',
        action,
        count: next?.kind === 'waiting' ? next.count : 0,
        sessionId: next && 'sessionId' in next ? (next.sessionId ?? null) : null,
        title: next && 'title' in next ? (next.title ?? null) : null,
        ...(next ? { payload: next } : {}),
      })

    if (payload) {
      const fingerprint = JSON.stringify(payload)
      if (!hasLiveActivity) {
        if (
          !tokens?.start ||
          !canStartActivity(payload) ||
          this.held(choices!) ||
          this.options.foreground?.(deviceId)
        ) {
          return
        }
        send('start', payload)
      } else {
        if (state.running && fingerprint === state.fingerprint) return
        if (!tokens?.update) return
        send('update', payload)
      }
      this.activities.set(deviceId, { running: true, fingerprint })
      return
    }

    if (!hasLiveActivity) return
    if (tokens?.update) send('end', null)
    this.activities.delete(deviceId)
  }
}
