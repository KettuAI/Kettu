// A host's notifications to its devices: what each device set over the channel, kept with it in
// the device file, what the agent host reports through the host's parent, and the notifier and the
// sender between them. Only a host with its Ed25519 key has them, since every push is signed.

import { addLogSecret } from '@shared/log/process-log'
import {
  DEFAULT_CHOICES,
  encodeSealed,
  type DevicePush,
  type NotificationsState,
  type NotificationsUpdate,
  type PushActions,
} from '@shared/remote/push'
import type { RelayKey } from '@shared/remote/relay'
import type { LogFn } from '../agent-host/storage'
import type { DeviceStore } from './devices'
import { Notifier, type Attention, type AttentionKind, type NotifierDevice } from './notifier'
import { PushSender, type PushSenderOptions, type PushTokenKind } from './push-sender'

export interface DeviceNotificationsOptions {
  devices: DeviceStore
  key: RelayKey
  hostId: string
  /** The push gateway's origin. */
  url: string
  hostName(): string
  token(): string | null
  /** Whether the device shows the session in front now. */
  showing(deviceId: string, sessionId: string): boolean
  log: LogFn
  fetch?: typeof fetch
  mergeMs?: number
  retry?: PushSenderOptions['retry']
}

const KINDS: readonly string[] = [
  'permission',
  'turn-ended',
  'error',
  'routine-ended',
  'routine-paused',
] satisfies AttentionKind[]

const MAX_TEXT = 4000
const MAX_FRONT_DEVICES = 1000

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200

function parseAnswer(value: unknown): { optionId: string; label: string } | null {
  if (typeof value !== 'object' || value === null) return null
  const { optionId, name } = value as Record<string, unknown>
  return isId(optionId) && typeof name === 'string' && name.length > 0 && name.length <= 200
    ? { optionId, label: name }
    : null
}

/**
 * An attention message from the host's parent, as the remote host reads it; null when it is not
 * one. The parent passes on the agent host's, so it is checked like any message across processes.
 */
export function parseAttention(value: unknown): Attention | null {
  if (typeof value !== 'object' || value === null) return null
  const { kind, sessionId, agentId, title, body, request, front } = value as Record<string, unknown>
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return null
  if (typeof title !== 'string' || typeof body !== 'string') return null
  if (title.length > MAX_TEXT || body.length > MAX_TEXT) return null
  const attention: Attention = {
    kind: kind as AttentionKind,
    title,
    body,
    inFront: false,
    devices: [],
  }
  if (kind === 'routine-paused') {
    if (!isId(agentId)) return null
    attention.agentId = agentId
  } else {
    if (!isId(sessionId)) return null
    attention.sessionId = sessionId
  }
  if (kind === 'permission' && typeof request === 'object' && request !== null) {
    const { id, allow, deny } = request as Record<string, unknown>
    if (isId(id)) {
      attention.requestId = id
      const allowed = parseAnswer(allow)
      if (allowed) {
        const denied = parseAnswer(deny)
        const actions: PushActions = { allow: allowed, ...(denied ? { deny: denied } : {}) }
        attention.actions = actions
      }
    }
  }
  if (typeof front === 'object' && front !== null) {
    const { any, devices } = front as Record<string, unknown>
    attention.inFront = any === true
    if (Array.isArray(devices)) {
      attention.devices = devices.slice(0, MAX_FRONT_DEVICES).filter(isId)
    }
  }
  return attention
}

/** What waits for an answer by session, as the parent passes it on; null when it is not that. */
export function parseWaiting(value: unknown): Record<string, string[]> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const waiting: Record<string, string[]> = {}
  for (const [sessionId, ids] of Object.entries(value)) {
    if (!isId(sessionId) || !Array.isArray(ids) || !ids.every(isId)) return null
    waiting[sessionId] = ids
  }
  return waiting
}

export class DeviceNotifications {
  private readonly notifier: Notifier
  private readonly sender: PushSender
  private readonly publicKey: string

  constructor(private readonly options: DeviceNotificationsOptions) {
    const { devices } = options
    this.publicKey = encodeSealed(options.key.publicKey)
    this.sender = new PushSender({
      url: options.url,
      key: options.key,
      hostId: options.hostId,
      hostName: options.hostName,
      token: options.token,
      device: (id) => {
        const device = devices.get(id)
        const push = devices.push(id)
        return device && push ? { publicKey: device.publicKey, push } : null
      },
      unregistered: (deviceId, token) => void this.unregistered(deviceId, token),
      log: options.log,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.retry ? { retry: options.retry } : {}),
    })
    this.notifier = new Notifier({
      devices: () =>
        devices.list().flatMap((device): NotifierDevice[] => {
          const push = devices.push(device.id)
          return push ? [{ id: device.id, push }] : []
        }),
      showing: options.showing,
      send: (job) => {
        this.sender.send(job)
        // An ended activity's token is spent; the next activity brings its own.
        if (job.type === 'activity' && job.action === 'end') {
          void this.dropActivityToken(job.deviceId)
        }
      },
      ...(options.mergeMs === undefined ? {} : { mergeMs: options.mergeMs }),
    })
  }

  /** What `notifications.get` answers the device. */
  state(deviceId: string): NotificationsState {
    const push = this.options.devices.push(deviceId)
    const target = push?.target
    return {
      choices: push?.choices ?? DEFAULT_CHOICES,
      target: {
        apns: Boolean(target),
        activityStart: Boolean(target?.activity?.start),
        activityUpdate: Boolean(target?.activity?.update),
      },
      signedIn: this.options.token() !== null,
      host: { id: this.options.hostId, key: this.publicKey },
    }
  }

  /** `notifications.set`: the device's new target or choices, kept with it; null when it is gone. */
  async update(deviceId: string, update: NotificationsUpdate): Promise<NotificationsState | null> {
    const { devices } = this.options
    const before = devices.push(deviceId)
    const target = update.target === undefined ? (before?.target ?? null) : update.target
    for (const token of [target?.apns.token, target?.activity?.start, target?.activity?.update]) {
      if (token) addLogSecret(token)
    }
    const next: DevicePush = {
      target,
      choices: { ...(before?.choices ?? DEFAULT_CHOICES), ...update.choices },
    }
    if (!(await devices.setPush(deviceId, next))) return null
    this.notifier.deviceChanged()
    return this.state(deviceId)
  }

  attention(attention: Attention): void {
    this.notifier.attention(attention)
  }

  setWaiting(sessions: Record<string, string[]>): void {
    this.notifier.setWaiting(sessions)
  }

  seen(sessionId: string): void {
    this.notifier.seen(sessionId)
  }

  setPresent(present: boolean): void {
    this.notifier.setPresent(present)
  }

  /** A device was removed, and its notifications with it. */
  forget(deviceId: string): void {
    this.notifier.forget(deviceId)
  }

  stop(): void {
    this.notifier.stop()
    this.sender.stop()
  }

  private async unregistered(deviceId: string, token: PushTokenKind): Promise<void> {
    const { devices } = this.options
    const push = devices.push(deviceId)
    if (!push?.target) return
    // A dead device token ends every push to it; a dead activity token only that activity's.
    const target =
      token === 'device'
        ? null
        : withoutEmptyActivity({
            ...push.target,
            activity: {
              ...push.target.activity,
              ...(token === 'activity-start' ? { start: undefined } : { update: undefined }),
            },
          })
    await devices.setPush(deviceId, { ...push, target })
    this.notifier.deviceChanged()
  }

  private async dropActivityToken(deviceId: string): Promise<void> {
    const { devices } = this.options
    const push = devices.push(deviceId)
    if (!push?.target?.activity?.update) return
    const target = withoutEmptyActivity({
      ...push.target,
      activity: { ...push.target.activity, update: undefined },
    })
    await devices.setPush(deviceId, { ...push, target })
  }
}

/** A target without the Live Activity tokens that are gone, and without the object when none is left. */
function withoutEmptyActivity(target: NonNullable<DevicePush['target']>): DevicePush['target'] {
  const start = target.activity?.start
  const update = target.activity?.update
  const { apns } = target
  if (!start && !update) return { apns }
  return {
    apns,
    activity: { ...(start ? { start } : {}), ...(update ? { update } : {}) },
  }
}
