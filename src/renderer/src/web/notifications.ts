// The web client's notifications: what the host would notify its own window about, shown by the
// browser while this page is open and not in front, by this browser's own choices. Browsers give
// them only on https and localhost; reaching a closed page takes push, which is not here.

import { ATTENTION_SETTING, attentionTarget, attentionText } from '@shared/attention'
import type { AppCommand } from '@shared/ipc'
import type { HostAttention } from '@shared/remote/host-admin'
import type { SettingsFile } from '@shared/settings'

/** The browser's notifications, as far as they are used here. */
export type BrowserNotifications = Pick<typeof Notification, 'permission' | 'requestPermission'> &
  (new (title: string, options?: NotificationOptions) => Pick<Notification, 'onclick' | 'close'>)

export interface WebNotifyDeps {
  /** Null where the browser gives none, as on plain http. */
  notifications: BrowserNotifications | null
  settings(): SettingsFile
  /** Whether this page is in front: shown and focused. */
  inFront(): boolean
  /** Brings the page forward and runs what a click opens. */
  open(command: AppCommand): void
}

/** This browser's notifications here: none outside https and localhost. */
export function browserNotifications(): BrowserNotifications | null {
  return window.isSecureContext && 'Notification' in window ? Notification : null
}

/** Why the browser shows no notifications here, if it shows none. */
export function notificationsProblem(
  notifications: BrowserNotifications | null,
): 'insecure' | 'denied' | null {
  if (!notifications) return 'insecure'
  return notifications.permission === 'denied' ? 'denied' : null
}

/** Shows what needs the user when this browser allows it, its switch is on and the page is away. */
export function notifyAttention(attention: HostAttention, deps: WebNotifyDeps): boolean {
  const target = attentionTarget(attention)
  const { notifications } = deps
  if (!target || !notifications || notifications.permission !== 'granted') return false
  const settings = deps.settings()
  if (!settings.notifications[ATTENTION_SETTING[attention.kind]]) return false
  if (deps.inFront()) return false
  const { title, body } = attentionText(attention)
  // The tag makes a newer notice for the same session replace the older one.
  const shown = new notifications(title, {
    body,
    tag: target.key,
    silent: !settings.notifications.sound,
  })
  shown.onclick = () => {
    shown.close()
    deps.open(target.command)
  }
  return true
}

/** Settings > Notifications' sample: asks the browser the first time, then shows it. */
export async function notifyTest(
  deps: Pick<WebNotifyDeps, 'notifications' | 'settings'>,
  text: { title: string; body: string },
): Promise<boolean> {
  const { notifications } = deps
  if (!notifications) return false
  const permission =
    notifications.permission === 'default'
      ? await notifications.requestPermission()
      : notifications.permission
  if (permission !== 'granted') return false
  new notifications(text.title, {
    body: text.body,
    silent: !deps.settings().notifications.sound,
  })
  return true
}
