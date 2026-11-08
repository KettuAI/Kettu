// When the host notifies its devices through the push gateway, decided from what the agent host
// reports: a request starts waiting, a turn ends out of view, a turn or a routine fails, a
// routine's run ends. Each device's choices decide what it hears; one that shows the session in
// front hears nothing of it; while the user is at the desktop app, its own notifications tell them
// and devices that want it only while the user is away wait until they leave. A session's
// notifications merge into one, and one that no longer applies, a request answered elsewhere or a
// turn seen since, is withdrawn. Requests that wait also drive each device's Live Activity.

import type { DevicePush, NotificationChoices, PushActions, PushEvent } from '@shared/remote/push'

export type AttentionKind =
  'permission' | 'turn-ended' | 'error' | 'routine-ended' | 'routine-paused'

/** What the agent host says needs the user, as the remote host hears it from its parent. */
export interface Attention {
  kind: AttentionKind
  /** Every kind but `routine-paused`, which names its agent instead. */
  sessionId?: string
  agentId?: string
  title: string
  body: string
  /** The request that waits, which the waiting list names until it is answered or withdrawn. */
  requestId?: string
  /** The one-time answers a notification may offer, when the request fits in one. */
  actions?: PushActions
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
  send(job: PushJob): void
  /** How long a device's notifications of one subject wait to merge into one. */
  mergeMs?: number
}

/** The subject of the Live Activity's tag. */
export const ACTIVITY_SUBJECT = 'activity'

const MERGE_MS = 1000

/** What a device's notification of a subject is about now. */
interface Told {
  kind: AttentionKind
  requestId: string | undefined
}

interface Activity {
  running: boolean
  count: number
  sessionId: string | null
}

const subjectOf = (attention: Attention): string =>
  attention.kind === 'routine-paused' ? `routines:${attention.agentId}` : attention.sessionId!

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
  }
}

function pushEvent(attention: Attention): PushEvent {
  switch (attention.kind) {
    case 'permission':
      return {
        kind: 'permission',
        sessionId: attention.sessionId!,
        ...(attention.requestId ? { requestId: attention.requestId } : {}),
        ...(attention.actions ? { actions: attention.actions } : {}),
      }
    case 'routine-paused':
      return { kind: 'routine-paused', agentId: attention.agentId! }
    default:
      return { kind: attention.kind, sessionId: attention.sessionId! }
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
  private readonly mergeMs: number

  constructor(private readonly options: NotifierOptions) {
    this.mergeMs = options.mergeMs ?? MERGE_MS
  }

  /** Something needs the user. */
  attention(attention: Attention): void {
    if (attention.kind === 'routine-paused' ? !attention.agentId : !attention.sessionId) return
    // A turn that ended in front of someone was seen there.
    if (attention.kind === 'turn-ended' && attention.inFront) return
    const subject = subjectOf(attention)
    if (attention.kind !== 'routine-paused') this.open.set(subject, attention)
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

  /** A device changed its target or choices: its Live Activity follows. */
  deviceChanged(): void {
    this.activitiesChanged()
  }

  /** A device was removed: nothing more goes to it. */
  forget(deviceId: string): void {
    this.told.delete(deviceId)
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
  }

  private held(choices: NotificationChoices): boolean {
    return choices.onlyAway && this.present === true
  }

  /** Queues the attention for a device that wants it now. */
  private consider(device: NotifierDevice, subject: string, attention: Attention): void {
    const { target, choices } = device.push
    if (!target || !wants(choices, attention.kind) || this.held(choices)) return
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
    if (!device?.push.target || this.held(device.push.choices)) return
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
    if (attention.kind === 'routine-paused') return true
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

  private updateActivity(deviceId: string): void {
    const device = this.options.devices().find((entry) => entry.id === deviceId)
    const state = this.activities.get(deviceId) ?? { running: false, count: 0, sessionId: null }
    const target = device?.push.target
    const tokens = target?.activity
    const choices = device?.push.choices
    const enabled = Boolean(target && choices?.permission && (tokens?.start || tokens?.update))
    let count = 0
    let latest: string | null = null
    if (enabled && choices) {
      for (const [sessionId, ids] of this.waiting) {
        if (!choices.muted.includes(sessionId)) count += ids.size
      }
      latest = this.order.findLast((sessionId) => !choices.muted.includes(sessionId)) ?? null
    }
    const title = latest ? (this.open.get(latest)?.title ?? null) : null
    const send = (action: 'start' | 'update' | 'end'): void =>
      this.options.send({
        deviceId,
        subject: ACTIVITY_SUBJECT,
        type: 'activity',
        action,
        count,
        sessionId: latest,
        title,
      })
    if (count > 0) {
      if (!state.running) {
        if (!tokens?.start || this.held(choices!)) return
        send('start')
      } else {
        if (count === state.count && latest === state.sessionId) return
        // The activity's own token comes from the device after it starts; the update waits for it.
        if (!tokens?.update) return
        send('update')
      }
      this.activities.set(deviceId, { running: true, count, sessionId: latest })
      return
    }
    if (!state.running) return
    // Without the activity's own token it cannot be ended by push; the app ends it when it opens.
    if (tokens?.update) send('end')
    this.activities.delete(deviceId)
  }
}
