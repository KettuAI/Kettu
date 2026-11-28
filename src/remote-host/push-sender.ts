// Sends what the notifier decides through the push gateway: each push sealed to its device and
// signed with the host's key, posted with the account's access token, one device at a time so a
// withdrawal never overtakes the notification it withdraws. A newer push of the same subject
// replaces one still waiting; a gateway or network that fails is tried again later. The log says
// which device and why, never the content, the tokens or the target.

import {
  MAX_PUSH_BODY_TEXT,
  MAX_PUSH_TITLE,
  MAX_SEALED,
  PUSH_PATH,
  encodeSealed,
  pushRequestHeaders,
  pushTag,
  sealPush,
  supportsRichLiveActivity,
  type ApnsEnvironment,
  type GatewayPush,
  type DevicePush,
  type PushContent,
  type PushEvent,
  type PushRefusal,
} from '@shared/remote/push'
import { logDevicePush } from '@shared/log/requests'
import type { RelayKey } from '@shared/remote/relay'
import type { LogFn } from '../agent-host/storage'
import { publicKeyBytes } from './devices'
import { ACTIVITY_SUBJECT, type PushJob } from './notifier'

export interface PushRetry {
  /** The first wait after a failure, doubling up to `maxMs`. */
  firstMs: number
  maxMs: number
  /** Tries of one push before it is given up. */
  attempts: number
}

const RETRY: PushRetry = { firstMs: 1000, maxMs: 60_000, attempts: 6 }

/** How long one request to the gateway may take. */
const REQUEST_TIMEOUT_MS = 15_000
/** 灵动岛非结束类推送（start/update）超过该时长仍未送达网关则放弃重试，防止延迟回弹旧状态。 */
const MAX_TRANSIENT_ACTIVITY_AGE_MS = 45_000

/** Which of a device's tokens a push went to, which Apple may say is gone. */
export type PushTokenKind = 'device' | 'activity-start' | 'activity-update'

export interface PushSenderOptions {
  /** The gateway's origin. */
  url: string
  key: RelayKey
  /** The host's id, derived from `key`. */
  hostId: string
  hostName(): string
  /** The account's access token, or null while the host is not signed in. */
  token(): string | null
  /** A device's key and notifications, or null when it is gone. */
  device(id: string): { publicKey: string; push: DevicePush } | null
  /** Apple no longer takes one of the device's tokens. */
  unregistered(deviceId: string, token: PushTokenKind, tokenValue?: string): void
  /** Re-validates a job right before sending or retrying; returning false drops it. */
  shouldSend?(job: PushJob, ageMs: number): boolean
  /** Called when a Live Activity `start` job is dropped or cancelled before reaching APNs. */
  activityStartNotSent?(job: PushJob): void
  log: LogFn
  fetch?: typeof fetch
  now?: () => number
  retry?: Partial<PushRetry>
}

interface Entry {
  job: PushJob
  /**
   * Cancellation key: notification subject tag, transient Live Activity (`activity`), or a
   * token-scoped Live Activity end (`activity-end:<token>`), which is never cancelled by newer
   * starts/updates.
   */
  key: string
  token: { kind: PushTokenKind; token: string; environment: ApnsEnvironment }
  /** Enqueue timestamp in ms, kept as the sealed content's `at` and latency baseline. */
  queuedAt: number
  cancelled: boolean
  /** True once the gateway accepted this entry with a 2xx response. */
  delivered: boolean
  /** True while a gateway fetch is in flight or terminated without a definitive HTTP refusal. */
  uncertainDelivery: boolean
  /** Ensures `activityStartNotSent` is invoked at most once for an entry. */
  notifiedNotSent: boolean
  /** Aborts an in-flight request or retry backoff when superseded or explicitly cancelled. */
  abort: AbortController
}

const activityEndKey = (token: string): string => `activity-end:${token}`

function isUnsupportedRichActivity(job: PushJob, push: DevicePush): boolean {
  return (
    job.type === 'activity' &&
    job.action !== 'end' &&
    job.payload !== undefined &&
    job.payload.kind !== 'waiting' &&
    !supportsRichLiveActivity(push)
  )
}

/** Why a try failed: to try again, maybe after a wait the gateway asked for, or to give up. */
type Failure = { retry: true; afterMs: number | null; reason: string } | { retry: false }

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const REFUSALS: readonly string[] = [
  'malformed',
  'unauthorized',
  'signed_out',
  'unregistered',
  'too_big',
  'too_many',
  'apns',
  'unavailable',
] satisfies PushRefusal[]

export class PushSender {
  private readonly queues = new Map<string, Entry[]>()
  /** 每台设备当前正在发送或退避重试中的在途条目，支持被同键新推送立即中止。 */
  private readonly active = new Map<string, Entry>()
  private readonly running = new Set<string>()
  private readonly retry: PushRetry
  private readonly now: () => number
  private readonly fetch: typeof fetch
  private signedOutLogged = false
  private stopped = false
  private readonly timers = new Set<NodeJS.Timeout>()

  constructor(private readonly options: PushSenderOptions) {
    this.retry = { ...RETRY, ...options.retry }
    this.now = options.now ?? Date.now
    this.fetch = options.fetch ?? fetch
  }

  /** Queues a push for its device; the token it goes to is the one the device has now. */
  send(job: PushJob): void {
    const notifyStartNotSent = (): void => {
      if (job.type === 'activity' && job.action === 'start') {
        this.options.activityStartNotSent?.(job)
      }
    }
    if (this.stopped) {
      notifyStartNotSent()
      return
    }
    const device = this.options.device(job.deviceId)
    const token = device && tokenOf(device.push, job)
    if (!device || !token || isUnsupportedRichActivity(job, device.push)) {
      notifyStartNotSent()
      return
    }
    if (!this.options.token()) {
      if (!this.signedOutLogged) {
        this.options.log(
          'info',
          'Not signed in to a Kettu account, so devices get no notifications',
        )
        this.signedOutLogged = true
      }
      notifyStartNotSent()
      return
    }
    this.signedOutLogged = false
    let key: string
    if (job.type === 'activity') {
      if (job.action === 'end') {
        // An end supersedes pending transient activity pushes, but never aborts an earlier end.
        this.cancel(job.deviceId, ACTIVITY_SUBJECT)
        key = activityEndKey(token.token)
        if (this.hasPendingKey(job.deviceId, key)) return
      } else {
        // Newer start/update replaces older transient activity pushes without touching in-flight ends.
        key = ACTIVITY_SUBJECT
        this.cancel(job.deviceId, ACTIVITY_SUBJECT)
      }
    } else {
      key = `tag:${job.subject}`
      this.cancel(job.deviceId, key)
    }
    const queue = this.queues.get(job.deviceId) ?? []
    queue.push({
      job,
      key,
      token,
      queuedAt: this.now(),
      cancelled: false,
      delivered: false,
      uncertainDelivery: false,
      notifiedNotSent: false,
      abort: new AbortController(),
    })
    this.queues.set(job.deviceId, queue)
    void this.run(job.deviceId)
  }

  /** Immediately cancels queued and in-flight entries matching `key` for a device. */
  cancel(deviceId: string, key: string): void {
    const queue = this.queues.get(deviceId)
    if (queue) {
      for (const entry of queue) {
        if (entry.key === key && !entry.cancelled) {
          entry.cancelled = true
          entry.abort.abort()
          // Queued entries have never started a gateway request, so unsent starts can be cleared now.
          if (
            entry.job.type === 'activity' &&
            entry.job.action === 'start' &&
            !entry.notifiedNotSent
          ) {
            entry.notifiedNotSent = true
            this.options.activityStartNotSent?.(entry.job)
          }
        }
      }
    }
    const current = this.active.get(deviceId)
    if (current?.key === key && !current.cancelled) {
      current.cancelled = true
      current.abort.abort()
    }
  }

  private hasPendingKey(deviceId: string, key: string): boolean {
    const current = this.active.get(deviceId)
    if (current && !current.cancelled && current.key === key) return true
    const queue = this.queues.get(deviceId)
    return Boolean(queue?.some((entry) => !entry.cancelled && entry.key === key))
  }

  /** Ends every wait; what is queued is dropped. */
  stop(): void {
    this.stopped = true
    for (const entry of this.active.values()) {
      entry.cancelled = true
      entry.abort.abort()
    }
    this.active.clear()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.queues.clear()
  }

  private async run(deviceId: string): Promise<void> {
    if (this.running.has(deviceId)) return
    this.running.add(deviceId)
    try {
      for (;;) {
        const queue = this.queues.get(deviceId)
        const entry = queue?.shift()
        if (!entry) break
        if (!entry.cancelled) await this.deliver(deviceId, entry)
      }
    } finally {
      this.running.delete(deviceId)
      if (this.queues.get(deviceId)?.length === 0) this.queues.delete(deviceId)
    }
  }

  private async deliver(deviceId: string, entry: Entry): Promise<void> {
    this.active.set(deviceId, entry)
    try {
      for (let attempt = 1; ; attempt++) {
        if (entry.cancelled || this.stopped) return
        const ageMs = Math.max(0, this.now() - entry.queuedAt)
        // 瞬时灵动岛推送（start/update）若在重试期已明显过时，直接放弃以免回弹旧卡片。
        if (
          entry.job.type === 'activity' &&
          entry.job.action !== 'end' &&
          ageMs > MAX_TRANSIENT_ACTIVITY_AGE_MS
        ) {
          return
        }
        if (this.options.shouldSend && !this.options.shouldSend(entry.job, ageMs)) return
        const failure = await this.attempt(deviceId, entry, attempt).catch(
          (error: unknown): Failure => {
            if (entry.cancelled || this.stopped || entry.abort.signal.aborted) {
              return { retry: false }
            }
            return {
              retry: true,
              afterMs: null,
              reason: (error as Error)?.name === 'TimeoutError' ? 'no answer' : 'unreachable',
            }
          },
        )
        if (!failure) return
        if (!failure.retry || entry.cancelled || this.stopped) return
        if (attempt >= this.retry.attempts) {
          this.options.log(
            'warn',
            `Gave up a notification for device ${deviceId} after ${attempt} tries: ${failure.reason}`,
          )
          return
        }
        const backoff = Math.min(this.retry.maxMs, this.retry.firstMs * 2 ** (attempt - 1))
        await this.wait(Math.min(this.retry.maxMs, failure.afterMs ?? backoff), entry.abort.signal)
      }
    } finally {
      if (this.active.get(deviceId) === entry) this.active.delete(deviceId)
      if (
        !this.stopped &&
        entry.job.type === 'activity' &&
        entry.job.action === 'start' &&
        !entry.delivered &&
        !entry.uncertainDelivery &&
        !entry.notifiedNotSent
      ) {
        entry.notifiedNotSent = true
        this.options.activityStartNotSent?.(entry.job)
      }
    }
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.timers.delete(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      timer.unref?.()
      this.timers.add(timer)
      signal.addEventListener('abort', done, { once: true })
    })
  }

  /** One try: null once the gateway took it, or why not. */
  private async attempt(
    deviceId: string,
    entry: Entry,
    attemptNumber: number,
  ): Promise<Failure | null> {
    const device = this.options.device(deviceId)
    const accessToken = this.options.token()
    if (!device || !accessToken || isUnsupportedRichActivity(entry.job, device.push)) {
      return { retry: false }
    }
    const devicePublicKey = publicKeyBytes(device.publicKey)
    if (!devicePublicKey) return { retry: false }
    const push = await this.gatewayPush(entry.job, device.push, devicePublicKey, entry.queuedAt)
    if (entry.cancelled || this.stopped) return { retry: false }
    if (!push) {
      this.options.log('warn', `A notification for device ${deviceId} is too long to send`)
      return { retry: false }
    }
    const { url, key, hostId } = this.options
    const body = JSON.stringify({
      time: this.now(),
      token: entry.token.token,
      environment: entry.token.environment,
      push,
    })
    const headers = await pushRequestHeaders(key, url, hostId, body, accessToken)
    if (entry.cancelled || this.stopped) return { retry: false }
    const sentAt = this.now()
    entry.uncertainDelivery = true
    const response = await this.fetch(`${url}${PUSH_PATH}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), entry.abort.signal]),
    })
    if (response.ok) {
      entry.delivered = true
      entry.uncertainDelivery = false
      const acceptedAt = this.now()
      logDevicePush({
        device: deviceId,
        kind: entry.job.type,
        ms: Math.max(0, Math.round(acceptedAt - entry.queuedAt)),
        gatewayMs: Math.max(0, Math.round(acceptedAt - sentAt)),
        attempts: attemptNumber,
      })
      return null
    }
    entry.uncertainDelivery = false
    const refusal = await refusalOf(response)
    if (response.status === 410 || refusal === 'unregistered') {
      this.options.log('info', `Apple no longer takes a push token of device ${deviceId}`)
      this.options.unregistered(deviceId, entry.token.kind, entry.token.token)
      return { retry: false }
    }
    const reason = refusal ?? `status ${response.status}`
    if (response.status === 429 || response.status >= 500) {
      return { retry: true, afterMs: retryAfter(response), reason }
    }
    this.options.log(
      'warn',
      `The push gateway refused a notification for device ${deviceId}: ${reason}`,
    )
    return { retry: false }
  }

  /** The push as the gateway takes it, its content sealed to the device; null when too long. */
  private async gatewayPush(
    job: PushJob,
    push: DevicePush,
    devicePublicKey: Uint8Array,
    at: number,
  ): Promise<GatewayPush | null> {
    const { hostId, key } = this.options
    const details = push.choices.details
    const tag = await pushTag(devicePublicKey, hostId, job.subject)
    const base = {
      v: 1 as const,
      host: hostId,
      hostName: this.options.hostName(),
      at,
      tag,
    }
    const seal = async (content: PushContent): Promise<string | null> => {
      const sealed = encodeSealed(await sealPush(content, devicePublicKey, key))
      return sealed.length <= MAX_SEALED ? sealed : null
    }
    switch (job.type) {
      case 'alert': {
        // Answering from a notification asks to see what it answers.
        const event = details ? job.event : withoutActions(job.event)
        const text = details
          ? { title: clip(job.title, MAX_PUSH_TITLE), body: clip(job.body, MAX_PUSH_BODY_TEXT) }
          : {}
        // A text too long once sealed goes without it, as with details off.
        const sealed =
          (await seal({ ...base, ...text, ...event })) ?? (await seal({ ...base, ...event }))
        return sealed ? { type: 'alert', sealed, collapse: tag } : null
      }
      case 'background': {
        const sealed = await seal({ ...base, ...job.event })
        return sealed ? { type: 'background', sealed } : null
      }
      case 'activity': {
        if (job.action === 'end') {
          // APNs requires a content-state on `event: 'end'` alongside `dismissal-date`.
          // `{ kind: 'waiting', count: 0 }` is decoded as having no content by both older and
          // newer clients without falling back to an undecodable waiting state, and strips any
          // stale fields from the job.
          const sealed = await seal({ ...base, kind: 'waiting', count: 0 })
          return sealed ? { type: 'liveactivity', event: 'end', sealed } : null
        }
        const buildState = (compact: boolean): PushContent => {
          const p = job.payload
          if (!p) {
            return {
              ...base,
              ...(details && job.title ? { title: clip(job.title, MAX_PUSH_TITLE) } : {}),
              kind: 'waiting',
              count: job.count,
              ...(job.sessionId ? { sessionId: job.sessionId } : {}),
            }
          }
          switch (p.kind) {
            case 'waiting':
              return {
                ...base,
                kind: 'waiting',
                count: p.count,
                ...(details && p.sessionId ? { sessionId: p.sessionId } : {}),
                ...(details && p.title ? { title: clip(p.title, MAX_PUSH_TITLE) } : {}),
                ...(details && !compact && p.body
                  ? { body: clip(p.body, MAX_PUSH_BODY_TEXT) }
                  : {}),
                ...(details && p.agentId ? { agentId: p.agentId } : {}),
                ...(details && !compact && p.requestId ? { requestId: p.requestId } : {}),
                ...(details && !compact && p.actions ? { actions: p.actions } : {}),
                ...(details && p.since !== undefined ? { since: p.since } : {}),
                ...(details && !compact && p.actionKind ? { actionKind: p.actionKind } : {}),
                ...(details && !compact && p.quickOptions ? { quickOptions: p.quickOptions } : {}),
              }
            case 'running':
              return {
                ...base,
                kind: 'running',
                sessionId: p.sessionId,
                ...(details && p.title ? { title: clip(p.title, MAX_PUSH_TITLE) } : {}),
                ...(details && !compact && p.body
                  ? { body: clip(p.body, MAX_PUSH_BODY_TEXT) }
                  : {}),
                ...(details && p.agentId ? { agentId: p.agentId } : {}),
                ...(p.turnStartedAt !== undefined ? { turnStartedAt: p.turnStartedAt } : {}),
                ...(p.runningCount !== undefined ? { runningCount: p.runningCount } : {}),
                ...(details && p.phase ? { phase: p.phase } : {}),
                ...(details && !compact && p.activityKind ? { activityKind: p.activityKind } : {}),
                ...(details && p.plan
                  ? {
                      plan: compact
                        ? { done: p.plan.done, total: p.plan.total }
                        : {
                            done: p.plan.done,
                            total: p.plan.total,
                            ...(p.plan.current ? { current: clip(p.plan.current, 120) } : {}),
                            ...(p.plan.lastCompleted
                              ? { lastCompleted: clip(p.plan.lastCompleted, 120) }
                              : {}),
                          },
                    }
                  : {}),
                ...(details && !compact && p.project ? { project: clip(p.project, 80) } : {}),
              }
            case 'error':
              return {
                ...base,
                kind: 'error',
                sessionId: p.sessionId,
                ...(details && p.title ? { title: clip(p.title, MAX_PUSH_TITLE) } : {}),
                ...(details && !compact && p.body
                  ? { body: clip(p.body, MAX_PUSH_BODY_TEXT) }
                  : {}),
                ...(details && p.agentId ? { agentId: p.agentId } : {}),
                ...(details && !compact && p.project ? { project: clip(p.project, 80) } : {}),
              }
            case 'turn-ended':
              return {
                ...base,
                kind: 'turn-ended',
                sessionId: p.sessionId,
                ...(details && p.title ? { title: clip(p.title, MAX_PUSH_TITLE) } : {}),
                ...(details && !compact && p.body
                  ? { body: clip(p.body, MAX_PUSH_BODY_TEXT) }
                  : {}),
                ...(details && p.agentId ? { agentId: p.agentId } : {}),
                ...(details && !compact && p.project ? { project: clip(p.project, 80) } : {}),
              }
            case 'limit':
              return {
                ...base,
                kind: 'limit',
                agentId: p.agentId,
                ...(p.label ? { label: clip(p.label, 40) } : {}),
                ...(details && p.planLabel ? { planLabel: clip(p.planLabel, 60) } : {}),
                ...(p.resetsAt !== undefined ? { resetsAt: p.resetsAt } : {}),
                ...(p.pausedSessions ? { pausedSessions: p.pausedSessions } : {}),
              }
          }
        }
        // 先封装完整状态；若密文超限自动降级裁剪次要文本，保证实时活动必达。
        const sealed = (await seal(buildState(false))) ?? (await seal(buildState(true)))
        if (!sealed) return null
        if (job.action !== 'start') return { type: 'liveactivity', event: job.action, sealed }
        const attributes = await seal({ ...base, kind: 'activity' })
        return attributes ? { type: 'liveactivity', event: 'start', sealed, attributes } : null
      }
    }
  }
}

/** The event without details/answers that require showing content on the Lock Screen. */
export function withoutActions(event: PushEvent): PushEvent {
  switch (event.kind) {
    case 'permission': {
      const { kind, sessionId, requestId, actionKind } = event
      return {
        kind,
        sessionId,
        ...(requestId === undefined ? {} : { requestId }),
        // 仅保留提问类别标记以在隐私模式区分「等待审批」与「Agent 提问」，不暴露任何内容。
        ...(actionKind === 'question' ? { actionKind } : {}),
      }
    }
    case 'turn-ended':
      return { kind: 'turn-ended', sessionId: event.sessionId }
    case 'error':
      return { kind: 'error', sessionId: event.sessionId }
    case 'routine-ended':
      return { kind: 'routine-ended', sessionId: event.sessionId }
    default:
      return event
  }
}

/** The token a push goes to: the device's, or its Live Activity's; null when it has none. */
function tokenOf(push: DevicePush, job: PushJob): Entry['token'] | null {
  const target = push.target
  if (!target) return null
  const { environment } = target.apns
  if (job.type !== 'activity') return { kind: 'device', token: target.apns.token, environment }
  const token = job.action === 'start' ? target.activity?.start : target.activity?.update
  if (!token) return null
  return { kind: job.action === 'start' ? 'activity-start' : 'activity-update', token, environment }
}

async function refusalOf(response: Response): Promise<PushRefusal | null> {
  try {
    const { error } = (await response.json()) as { error?: unknown }
    return typeof error === 'string' && REFUSALS.includes(error) ? (error as PushRefusal) : null
  } catch {
    return null
  }
}

/** The wait a 429 or 503 asks for in seconds, as milliseconds; null when it asks none. */
export function retryAfter(response: Response): number | null {
  const value = Number(response.headers.get('Retry-After'))
  return Number.isFinite(value) && value > 0 ? value * 1000 : null
}
