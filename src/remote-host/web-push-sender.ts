// Sends the notifier's alerts to browsers as Web Push, straight to each browser's push service:
// the content as the push gateway's carries it, signed with the host's key and encrypted to the
// subscription. One device at a time, a newer push of the same subject replacing one still
// waiting; a push service that fails or asks to wait is tried again later, and one that says the
// subscription is gone ends it. The log says which device and why, never the content or the
// subscription.

import { logDevicePush } from '@shared/log/requests'
import { MAX_PUSH_BODY_TEXT, MAX_PUSH_TITLE, pushTag, type PushContent } from '@shared/remote/push'
import { decodeRelayBytes, type RelayKey } from '@shared/remote/relay'
import { MAX_WEB_PUSH_PAYLOAD, signWebPush, type StoredWebPush } from '@shared/remote/web-push'
import type { LogFn } from '../agent-host/storage'
import { publicKeyBytes } from './devices'
import type { PushJob } from './notifier'
import { clip, retryAfter, withoutActions, type PushRetry } from './push-sender'
import { encryptWebPush, vapidAuthorization, type WebPushSecrets } from './web-push'

const RETRY: PushRetry = { firstMs: 1000, maxMs: 60_000, attempts: 6 }

/** How long one request to a push service may take. */
const REQUEST_TIMEOUT_MS = 15_000

/** How long a push service keeps a push for a browser that is offline. */
const TTL_S = 24 * 60 * 60

export type WebAlert = Extract<PushJob, { type: 'alert' }>

export interface WebPushDevice {
  /** The device's X25519 public key in base64, which its notifications' tags are made from. */
  publicKey: string
  web: StoredWebPush
  details: boolean
}

export interface WebPushSenderOptions {
  key: RelayKey
  /** The host's id, derived from `key`. */
  hostId: string
  hostName(): string
  /** A device's subscription, or null when it is gone. */
  device(id: string): WebPushDevice | null
  /** The subscription's secrets, or null when they no longer open. */
  secrets(deviceId: string, web: StoredWebPush): WebPushSecrets | null
  /** The push service no longer takes the device's subscription. */
  gone(deviceId: string, endpoint: string): void
  log: LogFn
  fetch?: typeof fetch
  now?: () => number
  retry?: Partial<PushRetry>
}

interface Entry {
  job: WebAlert
  /** 推送入队时刻（毫秒），用于统计从入队到推送服务接收的总耗时。 */
  queuedAt: number
  cancelled: boolean
}

type Failure = { retry: true; afterMs: number | null; reason: string } | { retry: false }

export class WebPushSender {
  private readonly queues = new Map<string, Entry[]>()
  private readonly running = new Set<string>()
  private readonly retry: PushRetry
  private readonly now: () => number
  private readonly fetch: typeof fetch
  private stopped = false
  private readonly timers = new Set<NodeJS.Timeout>()

  constructor(private readonly options: WebPushSenderOptions) {
    this.retry = { ...RETRY, ...options.retry }
    this.now = options.now ?? Date.now
    this.fetch = options.fetch ?? fetch
  }

  send(job: WebAlert): void {
    if (this.stopped || !this.options.device(job.deviceId)) return
    const queue = this.queues.get(job.deviceId) ?? []
    for (const entry of queue) if (entry.job.subject === job.subject) entry.cancelled = true
    queue.push({ job, queuedAt: this.now(), cancelled: false })
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
        const entry = this.queues.get(deviceId)?.shift()
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
      const failure = await this.attempt(deviceId, entry, attempt).catch(
        (error: unknown): Failure => ({
          retry: true,
          afterMs: null,
          reason: (error as Error)?.name === 'TimeoutError' ? 'no answer' : 'unreachable',
        }),
      )
      if (!failure?.retry) return
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

  /** One try: null once the push service took it, or why not. */
  private async attempt(
    deviceId: string,
    entry: Entry,
    attemptNumber: number,
  ): Promise<Failure | null> {
    const { job } = entry
    const device = this.options.device(deviceId)
    const devicePublicKey = device && publicKeyBytes(device.publicKey)
    if (!device || !devicePublicKey) return { retry: false }
    const { web } = device
    const secrets = this.options.secrets(deviceId, web)
    const p256dh = decodeRelayBytes(web.p256dh)
    const vapidKey = decodeRelayBytes(web.vapidKey)
    if (!secrets || !p256dh || !vapidKey) {
      this.options.log('warn', `The Web Push subscription of device ${deviceId} does not open`)
      return { retry: false }
    }
    const tag = await pushTag(devicePublicKey, this.options.hostId, job.subject)
    const payload = await this.payload(job, tag, device.details, p256dh)
    if (!payload) {
      this.options.log('warn', `A notification for device ${deviceId} is too long to send`)
      return { retry: false }
    }
    const body = encryptWebPush(payload, p256dh, secrets.auth)
    const sentAt = this.now()
    const response = await this.fetch(web.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthorization(
          web.endpoint,
          vapidKey,
          secrets.vapidPrivateKey,
          this.now(),
        ),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(TTL_S),
        // A newer push of the same subject replaces this one while it waits at the push service.
        Topic: tag,
        Urgency:
          job.event.kind === 'permission' || job.event.kind === 'device-request'
            ? 'high'
            : 'normal',
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.ok) {
      const acceptedAt = this.now()
      logDevicePush({
        device: deviceId,
        kind: 'web-push',
        ms: Math.max(0, Math.round(acceptedAt - entry.queuedAt)),
        gatewayMs: Math.max(0, Math.round(acceptedAt - sentAt)),
        attempts: attemptNumber,
      })
      return null
    }
    const reason = `status ${response.status}`
    if (response.status === 404 || response.status === 410) {
      this.options.log('info', `The push service no longer takes device ${deviceId}'s subscription`)
      this.options.gone(deviceId, web.endpoint)
      return { retry: false }
    }
    if (response.status === 429 || response.status >= 500) {
      return { retry: true, afterMs: retryAfter(response), reason }
    }
    this.options.log(
      'warn',
      `The push service refused a notification for device ${deviceId}: ${reason}`,
    )
    return { retry: false }
  }

  /** The signed payload; without its text when that makes it too long, null when still too long. */
  private async payload(
    job: WebAlert,
    tag: string,
    details: boolean,
    p256dh: Uint8Array,
  ): Promise<Uint8Array | null> {
    const base = {
      v: 1 as const,
      host: this.options.hostId,
      hostName: this.options.hostName(),
      at: this.now(),
      tag,
    }
    const event = details ? job.event : withoutActions(job.event)
    const text = details
      ? { title: clip(job.title, MAX_PUSH_TITLE), body: clip(job.body, MAX_PUSH_BODY_TEXT) }
      : {}
    for (const content of [
      { ...base, ...text, ...event },
      { ...base, ...event },
    ] as PushContent[]) {
      const payload = await signWebPush(content, p256dh, this.options.key)
      if (payload.length <= MAX_WEB_PUSH_PAYLOAD) return payload
    }
    return null
  }
}
