import { BrowserWindow, Notification } from 'electron'
import type { HostToMain } from '@shared/host-control'
import type { AppCommand } from '@shared/ipc'
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
  'routine-ended': 'routines',
  'routine-paused': 'routines',
} as const satisfies Record<Attention['kind'], keyof SettingsFile['notifications']>

const MAX_TITLE = 120
const MAX_BODY = 400

// Held so a notification is not garbage collected before it is clicked; one per session, or per
// agent for a pause, so a newer notice replaces the older one instead of stacking.
const shown = new Map<string, Notification>()

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/**
 * What a well-formed attention message stands for, which a newer one of the same replaces, and
 * what a click opens: its session, or the Routines page for a pause. Null for a malformed one.
 */
export function attentionTarget(message: Attention): { key: string; command: AppCommand } | null {
  if (!(message.kind in SETTING_FOR_KIND)) return null
  if (typeof message.title !== 'string' || typeof message.body !== 'string') return null
  if (message.kind === 'routine-paused') {
    return isId(message.agentId)
      ? { key: `routines:${message.agentId}`, command: { kind: 'open-routines' } }
      : null
  }
  return isId(message.sessionId)
    ? { key: message.sessionId, command: { kind: 'open-session', sessionId: message.sessionId } }
    : null
}

/** An OS notification for what needs the user, shown only when no window is focused. */
export function notifyAttention(message: Attention, settings: SettingsFile): void {
  const target = attentionTarget(message)
  if (!target) {
    log.warn('Ignored a malformed attention message')
    return
  }
  if (!settings.notifications[SETTING_FOR_KIND[message.kind]]) return
  if (BrowserWindow.getFocusedWindow()) return
  if (!Notification.isSupported()) return

  const { key, command } = target
  shown.get(key)?.close()
  const notification = new Notification({
    title: clip(message.title, MAX_TITLE),
    body: clip(message.body, MAX_BODY),
    silent: !settings.notifications.sound,
  })
  const forget = (): void => {
    if (shown.get(key) === notification) shown.delete(key)
  }
  notification.on('click', () => {
    forget()
    sendCommand(command)
  })
  notification.on('close', forget)
  notification.on('failed', (_, error) => {
    forget()
    log.warn(`Notification failed: ${error}`)
  })
  shown.set(key, notification)
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
