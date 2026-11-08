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
  type ApnsEnvironment,
  type GatewayPush,
  type DevicePush,
  type PushContent,
  type PushEvent,
  type PushRefusal,
} from '@shared/remote/push'
import type { RelayKey } from '@shared/remote/relay'
import type { LogFn } from '../agent-host/storage'
import { publicKeyBytes } from './devices'
import type { PushJob } from './notifier'

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
  unregistered(deviceId: string, token: PushTokenKind): void
  log: LogFn
  fetch?: typeof fetch
  now?: () => number
  retry?: Partial<PushRetry>
}

interface Entry {
  job: PushJob
  /** What a newer push replaces: the subject's notification, or the Live Activity. */
  key: string
  token: { kind: PushTokenKind; token: string; environment: ApnsEnvironment }
  cancelled: boolean
}

/** Why a try failed: to try again, maybe after a wait the gateway asked for, or to give up. */
type Failure = { retry: true; afterMs: number | null; reason: string } | { retry: false }

function clip(text: string, max: number): string {
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
    if (this.stopped) return
    const device = this.options.device(job.deviceId)
    const token = device && tokenOf(device.push, job)
    if (!token) return
    if (!this.options.token()) {
      if (!this.signedOutLogged) {
        this.options.log(
          'info',
          'Not signed in to a Kettu account, so devices get no notifications',
        )
        this.signedOutLogged = true
      }
      return
    }
    this.signedOutLogged = false
    const key = job.type === 'activity' ? 'activity' : `tag:${job.subject}`
    const queue = this.queues.get(job.deviceId) ?? []
    for (const entry of queue) if (entry.key === key) entry.cancelled = true
    queue.push({ job, key, token, cancelled: false })
    this.queues.set(job.deviceId, queue)
    void this.run(job.deviceId)
  }

  /** Ends every wait; what is queued is dropped. */
  stop(): void {
    this.stopped = true
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
    for (let attempt = 1; ; attempt++) {
      if (entry.cancelled || this.stopped) return
      const failure = await this.attempt(deviceId, entry).catch((error: unknown): Failure => ({
        retry: true,
        afterMs: null,
        reason: (error as Error)?.name === 'TimeoutError' ? 'no answer' : 'unreachable',
      }))
      if (!failure) return
      if (!failure.retry) return
      if (attempt >= this.retry.attempts) {
        this.options.log(
          'warn',
          `Gave up a notification for device ${deviceId} after ${attempt} tries: ${failure.reason}`,
        )
        return
      }
      const backoff = Math.min(this.retry.maxMs, this.retry.firstMs * 2 ** (attempt - 1))
      await this.wait(Math.min(this.retry.maxMs, failure.afterMs ?? backoff))
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        resolve()
      }, ms)
      timer.unref?.()
      this.timers.add(timer)
    })
  }

  /** One try: null once the gateway took it, or why not. */
  private async attempt(deviceId: string, entry: Entry): Promise<Failure | null> {
    const device = this.options.device(deviceId)
    const accessToken = this.options.token()
    if (!device || !accessToken) return { retry: false }
    const devicePublicKey = publicKeyBytes(device.publicKey)
    if (!devicePublicKey) return { retry: false }
    const push = await this.gatewayPush(entry.job, device.push, devicePublicKey)
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
    const response = await this.fetch(`${url}${PUSH_PATH}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.ok) return null
    const refusal = await refusalOf(response)
    if (response.status === 410 || refusal === 'unregistered') {
      this.options.log('info', `Apple no longer takes a push token of device ${deviceId}`)
      this.options.unregistered(deviceId, entry.token.kind)
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
  ): Promise<GatewayPush | null> {
    const { hostId, key } = this.options
    const details = push.choices.details
    const tag = await pushTag(devicePublicKey, hostId, job.subject)
    const base = {
      v: 1 as const,
      host: hostId,
      hostName: this.options.hostName(),
      at: this.now(),
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
        const state: PushContent = {
          ...base,
          ...(details && job.title ? { title: clip(job.title, MAX_PUSH_TITLE) } : {}),
          kind: 'waiting',
          count: job.count,
          ...(job.sessionId ? { sessionId: job.sessionId } : {}),
        }
        const sealed = await seal(state)
        if (!sealed) return null
        if (job.action !== 'start') return { type: 'liveactivity', event: job.action, sealed }
        const attributes = await seal({ ...base, kind: 'activity' })
        return attributes ? { type: 'liveactivity', event: 'start', sealed, attributes } : null
      }
    }
  }
}

function withoutActions(event: PushEvent): PushEvent {
  if (event.kind !== 'permission' || !event.actions) return event
  const { kind, sessionId, requestId } = event
  return { kind, sessionId, ...(requestId === undefined ? {} : { requestId }) }
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
function retryAfter(response: Response): number | null {
  const value = Number(response.headers.get('Retry-After'))
  return Number.isFinite(value) && value > 0 ? value * 1000 : null
}
