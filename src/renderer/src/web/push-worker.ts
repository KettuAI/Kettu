// The service worker's part in Web Push: it shows a push only once its signature checks out
// against the key of the host it names, which the page learned over the channel to that host, and
// a click hands what the notification names to a page of the client, opening one if none is.

import type { AppCommand } from '@shared/ipc'
import { openWebPush, type WebPushContent } from '@shared/remote/web-push'
import { keepClick, loadPushRecord, type PushClick } from './push-store'

// The DOM library has no service worker types, and the WebWorker one clashes with it; these are
// the parts push uses.
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void
}
interface PushEvent extends ExtendableEvent {
  readonly data: { arrayBuffer(): ArrayBuffer } | null
}
interface NotificationEvent extends ExtendableEvent {
  readonly notification: Notification
}
interface WindowClient {
  readonly focused: boolean
  focus(): Promise<WindowClient>
  postMessage(message: unknown): void
}
export interface PushWorkerScope {
  readonly registration: ServiceWorkerRegistration
  readonly clients: {
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClient[]>
    openWindow(url: string): Promise<WindowClient | null>
  }
  addEventListener(type: 'push', listener: (event: PushEvent) => void): void
  addEventListener(type: 'notificationclick', listener: (event: NotificationEvent) => void): void
}

function commandOf(content: WebPushContent): AppCommand {
  return content.kind === 'routine-paused'
    ? { kind: 'open-routines' }
    : { kind: 'open-session', sessionId: content.sessionId }
}

async function show(worker: PushWorkerScope, event: PushEvent): Promise<void> {
  const payload = event.data ? new Uint8Array(event.data.arrayBuffer()) : null
  const [subscription, record] = await Promise.all([
    worker.registration.pushManager.getSubscription(),
    loadPushRecord().catch(() => null),
  ])
  const p256dh = subscription?.getKey('p256dh')
  if (!payload || !p256dh || !record) return
  const content = await openWebPush(
    payload,
    new Uint8Array(p256dh),
    (id) => record.hosts[id] ?? null,
  )
  // Not from a host this browser paired with, or not what it sent: never shown.
  if (!content) return
  const click: PushClick = {
    type: 'kettu-notification-click',
    host: content.host,
    command: commandOf(content),
  }
  await worker.registration.showNotification(content.title ?? content.hostName, {
    ...(content.title && content.body ? { body: content.body } : {}),
    tag: content.tag,
    data: click,
    silent: !record.sound,
  })
}

async function open(worker: PushWorkerScope, event: NotificationEvent): Promise<void> {
  event.notification.close()
  const click = event.notification.data as PushClick | null
  if (click?.type !== 'kettu-notification-click') return
  const pages = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const page = pages.find((client) => client.focused) ?? pages[0]
  if (page) {
    await page.focus()
    page.postMessage(click)
    return
  }
  await keepClick(click)
  await worker.clients.openWindow('/')
}

export function handlePush(worker: PushWorkerScope): void {
  worker.addEventListener('push', (event) => event.waitUntil(show(worker, event)))
  worker.addEventListener('notificationclick', (event) => event.waitUntil(open(worker, event)))
}
