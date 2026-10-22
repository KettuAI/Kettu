import { BrowserWindow, Notification } from 'electron'
import type { HostToMain } from '@shared/host-control'
import type { SettingsFile } from '@shared/settings'
import { sendCommand } from './events'
import { t } from './i18n'
import { createLogger } from './log'

const log = createLogger('notifications')

type Attention = Extract<HostToMain, { type: 'host:attention' }>

const SETTING_FOR_KIND = {
  permission: 'permission',
  'turn-ended': 'turnEnded',
  error: 'error',
} as const satisfies Record<Attention['kind'], keyof SettingsFile['notifications']>

const MAX_TITLE = 120
const MAX_BODY = 400

// Held so a notification is not garbage collected before it is clicked; one per session, so a
// newer notice replaces the older one instead of stacking.
const shown = new Map<string, Notification>()

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function isAttention(message: Attention): boolean {
  return (
    typeof message.sessionId === 'string' &&
    message.sessionId.length > 0 &&
    message.sessionId.length <= 200 &&
    message.kind in SETTING_FOR_KIND &&
    typeof message.title === 'string' &&
    typeof message.body === 'string'
  )
}

/** An OS notification for a session that needs the user, shown only when no window is focused. */
export function notifyAttention(message: Attention, settings: SettingsFile): void {
  if (!isAttention(message)) {
    log.warn('Ignored a malformed attention message')
    return
  }
  if (!settings.notifications[SETTING_FOR_KIND[message.kind]]) return
  if (BrowserWindow.getFocusedWindow()) return
  if (!Notification.isSupported()) return

  shown.get(message.sessionId)?.close()
  const notification = new Notification({
    title: clip(message.title, MAX_TITLE),
    body: clip(message.body, MAX_BODY),
    silent: !settings.notifications.sound,
  })
  const forget = (): void => {
    if (shown.get(message.sessionId) === notification) shown.delete(message.sessionId)
  }
  notification.on('click', () => {
    forget()
    sendCommand({ kind: 'open-session', sessionId: message.sessionId })
  })
  notification.on('close', forget)
  notification.on('failed', (_, error) => {
    forget()
    log.warn(`Notification failed: ${error}`)
  })
  shown.set(message.sessionId, notification)
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
