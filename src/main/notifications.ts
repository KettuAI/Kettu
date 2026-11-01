import { BrowserWindow, Notification } from 'electron'
import type { HostToMain } from '@shared/host-control'
import { ATTENTION_SETTING, attentionTarget, attentionText } from '@shared/attention'
import type { SettingsFile } from '@shared/settings'
import { sendCommand } from './events'
import { t } from './i18n'
import { createLogger } from './log'

const log = createLogger('notifications')

type Attention = Extract<HostToMain, { type: 'host:attention' }>

// Held so a notification is not garbage collected before it is clicked; one per session, or per
// agent for a pause, so a newer notice replaces the older one instead of stacking.
const shown = new Map<string, Notification>()

/** An OS notification for what needs the user, shown only when no window is focused. */
export function notifyAttention(message: Attention, settings: SettingsFile): void {
  const target = attentionTarget(message)
  if (!target) {
    log.warn('Ignored a malformed attention message')
    return
  }
  if (!settings.notifications[ATTENTION_SETTING[message.kind]]) return
  if (BrowserWindow.getFocusedWindow()) return
  if (!Notification.isSupported()) return

  const { key, command } = target
  shown.get(key)?.close()
  const notification = new Notification({
    ...attentionText(message),
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
