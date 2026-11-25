import { BrowserWindow, Notification } from 'electron'
import type { HostToMain } from '@shared/host-control'
import type { DiscoveryRequestEvent } from '@shared/remote/discovery'
import {
  ATTENTION_SETTING,
  attentionNotice,
  attentionTarget,
  attentionText,
} from '@shared/attention'
import type { HostAttention } from '@shared/remote/host-admin'
import type { SettingsFile } from '@shared/settings'
import { sendCommand, sendEvent } from './events'
import { t } from './i18n'
import { createLogger } from './log'
import { appFocused, currentWindow } from './window'

const log = createLogger('notifications')

type Attention = Extract<HostToMain, { type: 'host:attention' }>

/** Another host whose attention this computer shows, named in its notification. */
export interface AttentionHost {
  id: string
  name: string
}

// Held so a notification is not garbage collected before it is clicked; one per session, or per
// agent of a host for a pause, so a newer notice replaces the older one instead of stacking.
const shown = new Map<string, Notification>()

/**
 * An OS notification for what needs the user, on this computer or on another host, shown only
 * when no window is focused. A request that can be allowed once offers that and Open; clicking
 * it, or Open, opens its session, as does Allow once when the answer cannot be sent. While one of
 * the app's windows is focused, a session's turn goes to that window instead, which shows it
 * unless the session is on screen.
 */
export function notifyAttention(
  message: Attention | HostAttention,
  settings: SettingsFile,
  allowOnce: (sessionId: string, requestId: string, optionId: string) => boolean,
  host: AttentionHost | null = null,
): void {
  const target = attentionTarget(message)
  if (!target) {
    log.warn('Ignored a malformed attention message')
    return
  }
  if (!settings.notifications[ATTENTION_SETTING[message.kind]]) return
  const title = host
    ? t('notifications.onHost', { host: host.name, title: message.title })
    : message.title
  if (BrowserWindow.getFocusedWindow()) {
    const notice = appFocused() ? attentionNotice(message, title) : null
    const window = notice && currentWindow()
    if (notice && window) sendEvent(window.webContents, 'app:attention', notice)
    return
  }
  if (!Notification.isSupported()) return

  const { command } = target
  // Agent ids repeat across hosts, so a pause on one never replaces another's.
  const key = host ? `${host.id}:${target.key}` : target.key
  const answer = message.kind === 'permission' ? validAnswer(message.allowOnce) : null
  shown.get(key)?.close()
  const notification = new Notification({
    ...attentionText({ ...message, title }),
    silent: !settings.notifications.sound,
    ...(answer
      ? {
          actions: [
            { type: 'button' as const, text: t('notifications.allowOnce') },
            { type: 'button' as const, text: t('notifications.open') },
          ],
        }
      : {}),
  })
  const forget = (): void => {
    if (shown.get(key) === notification) shown.delete(key)
  }
  notification.on('click', () => {
    forget()
    sendCommand(command)
  })
  notification.on('action', (details) => {
    forget()
    const allowed =
      details.actionIndex === 0 &&
      answer !== null &&
      message.kind === 'permission' &&
      allowOnce(message.sessionId, answer.requestId, answer.optionId)
    if (!allowed) sendCommand(command)
  })
  notification.on('close', forget)
  notification.on('failed', (_, error) => {
    forget()
    log.warn(`Notification failed: ${error}`)
  })
  shown.set(key, notification)
  notification.show()
}

/** The request a notification may allow once, when the host sent one that reads as one. */
function validAnswer(value: unknown): { requestId: string; optionId: string } | null {
  if (typeof value !== 'object' || value === null) return null
  const { requestId, optionId } = value as Record<string, unknown>
  return typeof requestId === 'string' &&
    typeof optionId === 'string' &&
    requestId.length <= 200 &&
    optionId.length <= 200
    ? { requestId, optionId }
    : null
}

let discovery: { requestId: number; notification: Notification } | null = null
/** The request last notified, which its later events do not notify again. */
let notifiedRequest: number | null = null

/**
 * A device of the account asks to be added: an OS notification while no window is focused, whose
 * click shows the window that asks the owner. It goes once the request ends.
 */
export function notifyDiscovery(
  event: DiscoveryRequestEvent,
  settings: SettingsFile,
  show: () => void,
): void {
  if (event.request.state !== 'confirm') {
    if (discovery?.requestId === event.requestId) {
      discovery.notification.close()
      discovery = null
    }
    return
  }
  // The same request again, now that its device confirmed the code, is no new notice, even when
  // the first one was dismissed or failed.
  if (notifiedRequest === event.requestId) return
  if (BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return
  notifiedRequest = event.requestId
  discovery?.notification.close()
  const notification = new Notification({
    title: t('notifications.discoveryTitle'),
    body: t('notifications.discoveryBody', { name: event.request.device.name }),
    silent: !settings.notifications.sound,
  })
  const forget = (): void => {
    if (discovery?.notification === notification) discovery = null
  }
  notification.on('click', () => {
    forget()
    show()
  })
  notification.on('close', forget)
  notification.on('failed', (_, error) => {
    forget()
    log.warn(`Notification failed: ${error}`)
  })
  discovery = { requestId: event.requestId, notification }
  notification.show()
}

/**
 * A device joined this computer: an OS notification, focused or not, with Remove; Remove and its
 * click both do `ask`, the device's page with its remove confirmation, as removing asks first.
 */
export function notifyJoined(
  device: { id: string; name: string },
  hostName: string,
  settings: SettingsFile,
  ask: () => void,
): void {
  if (!Notification.isSupported()) return
  const key = `joined:${device.id}`
  shown.get(key)?.close()
  const notification = new Notification({
    title: t('notifications.joinedTitle', { name: device.name, host: hostName }),
    body: t('notifications.joinedBody'),
    silent: !settings.notifications.sound,
    actions: [{ type: 'button' as const, text: t('notifications.remove') }],
  })
  const forget = (): void => {
    if (shown.get(key) === notification) shown.delete(key)
  }
  notification.on('click', () => {
    forget()
    ask()
  })
  notification.on('action', () => {
    forget()
    ask()
  })
  notification.on('close', forget)
  notification.on('failed', (_, error) => {
    forget()
    log.warn(`Notification failed: ${error}`)
  })
  shown.set(key, notification)
  notification.show()
}

/**
 * A notice of Kettu's own, such as its update, as an OS notification while no window is focused;
 * a newer one of the same key replaces it, and its click does `open`.
 */
export function notifyNotice(
  key: string,
  words: { title: string; body: string },
  settings: SettingsFile,
  open: () => void,
): void {
  if (BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return
  shown.get(key)?.close()
  const notification = new Notification({ ...words, silent: !settings.notifications.sound })
  const forget = (): void => {
    if (shown.get(key) === notification) shown.delete(key)
  }
  notification.on('click', () => {
    forget()
    open()
  })
  notification.on('close', forget)
  notification.on('failed', (_, error) => {
    forget()
    log.warn(`Notification failed: ${error}`)
  })
  shown.set(key, notification)
  notification.show()
}

/** How long a plan limit notice another host also says counts as the same one. */
const REPEAT_MS = 30 * 60_000

/**
 * Every host signed in to an account says its plan limit notices, and two agents may share an
 * account across hosts; this computer says each window's notice once.
 */
export class RepeatedNotices {
  private readonly seen = new Map<string, number>()

  repeated(message: HostAttention, now = Date.now()): boolean {
    if (message.kind !== 'plan-limit' || typeof message.key !== 'string') return false
    for (const [key, at] of this.seen) if (now - at >= REPEAT_MS) this.seen.delete(key)
    const key = `${message.key}:${message.level}`
    if (this.seen.has(key)) return true
    this.seen.set(key, now)
    return false
  }
}

/** A sample from Settings › Notifications, shown even while a window is focused. */
export function notifyTest(settings: SettingsFile): boolean {
  if (!Notification.isSupported()) return false
  const notification = new Notification({
    title: t('notifications.testTitle'),
    body: t('notifications.testBody'),
    silent: !settings.notifications.sound,
  })
  notification.on('failed', (_, error) => log.warn(`Test notification failed: ${error}`))
  notification.show()
  return true
}
