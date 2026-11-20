import { BrowserWindow, Notification } from 'electron'
import type { HostToMain } from '@shared/host-control'
import type { DiscoveryRequestEvent } from '@shared/remote/discovery'
import { ATTENTION_SETTING, attentionTarget, attentionText } from '@shared/attention'
import type { HostAttention } from '@shared/remote/host-admin'
import type { SettingsFile } from '@shared/settings'
import { sendCommand } from './events'
import { t } from './i18n'
import { createLogger } from './log'

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
 * it, or Open, opens its session, as does Allow once when the answer cannot be sent.
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
  if (BrowserWindow.getFocusedWindow()) return
  if (!Notification.isSupported()) return

  const { command } = target
  // Agent ids repeat across hosts, so a pause on one never replaces another's.
  const key = host ? `${host.id}:${target.key}` : target.key
  const answer = message.kind === 'permission' ? validAnswer(message.allowOnce) : null
  const title = host
    ? t('notifications.onHost', { host: host.name, title: message.title })
    : message.title
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
  if (BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return
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
