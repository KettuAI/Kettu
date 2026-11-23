// The web client's Web Push. Once this browser allows notifications, it subscribes with a VAPID
// pair of its own and hands the subscription with the pair's private key to each host it
// connects to, along with what Settings > Notifications asks for; each host keeps the key it signs
// its pushes with in this browser for the service worker to check them by. While a page is in
// view the host tells it what needs the user and the page notifies itself; a page in the
// background or closed gets pushes instead, and a page in the background leaves them to the push.
// A notification the host withdraws, which no push can do, the page closes: those it withdrew
// while the page was away as it connects, the rest as the host says.

import type { AppCommand } from '@shared/ipc'
import type { HostLink } from '@shared/remote/link'
import {
  NOTIFICATIONS_GET,
  NOTIFICATIONS_SET,
  type NotificationChoices,
  type NotificationsState,
} from '@shared/remote/push'
import { decodeRelayBytes, encodeRelayBytes, relayHostId } from '@shared/remote/relay'
import { parseWithdrawn, WEB_PUSH_FEATURE, type WebPushSubscription } from '@shared/remote/web-push'
import type { SettingsFile } from '@shared/settings'
import {
  keepClick,
  loadPushRecord,
  savePushRecord,
  takeClick,
  type PushClick,
  type PushRecord,
} from './push-store'

/** Why closed pages of this browser get no notifications. */
export type PushProblem = 'insecure' | 'home-screen' | 'unsupported' | 'denied'

/** How long the page waits for its service worker before it subscribes without one: not at all. */
const WORKER_WAIT_MS = 10_000

function isAppleMobile(): boolean {
  // iPadOS asks for desktop pages, so it tells itself apart only by its touch points.
  return (
    /\b(iPhone|iPad|iPod)\b/.test(navigator.userAgent) ||
    (/\bMacintosh\b/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  )
}

function standalone(): boolean {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    matchMedia('(display-mode: standalone)').matches
  )
}

/** Why a closed page gets nothing here, or null when this browser can get pushes. */
export function pushProblem(): PushProblem | null {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return 'insecure'
  // Safari on iPhone and iPad gives push only to a page opened from the Home Screen.
  if (isAppleMobile() && !standalone()) return 'home-screen'
  if (!('PushManager' in window) || !('Notification' in window)) return 'unsupported'
  return Notification.permission === 'denied' ? 'denied' : null
}

/**
 * What a host that has the subscription at `endpoint` and this browser's choices was handed, to
 * tell whether another must be handed them again.
 */
export function pushWish(endpoint: string, settings: SettingsFile): string {
  return JSON.stringify([endpoint, choicesOf(settings)])
}

/** The endpoint of this browser's subscription, if it has one. */
export async function pushEndpoint(): Promise<string | null> {
  if (!window.isSecureContext) return null
  const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined)
  const subscription = await registration?.pushManager?.getSubscription().catch(() => null)
  return subscription?.endpoint ?? null
}

/** What a host is asked to push, from this browser's own switches. */
function choicesOf(settings: SettingsFile): Partial<NotificationChoices> {
  const { permission, turnEnded, error, routines } = settings.notifications
  return { permission, turnEnded, errors: error, routines }
}

function sameChoices(host: NotificationChoices, wanted: Partial<NotificationChoices>): boolean {
  return Object.entries(wanted).every(
    ([key, value]) => host[key as keyof NotificationChoices] === value,
  )
}

const bufferOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

function sameKey(given: ArrayBuffer | null, key: Uint8Array): boolean {
  if (!given || given.byteLength !== key.length) return false
  const bytes = new Uint8Array(given)
  return bytes.every((byte, index) => byte === key[index])
}

async function newVapidPair(): Promise<PushRecord['vapid']> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey)
  if (!d) throw new Error('The VAPID key has no private part')
  return { publicKey: encodeRelayBytes(publicKey), privateKey: d }
}

function serviceWorker(): Promise<ServiceWorkerRegistration | null> {
  const container = navigator.serviceWorker
  if (!container) return Promise.resolve(null)
  return Promise.race([
    container.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), WORKER_WAIT_MS)),
  ])
}

/** This browser's subscription with its own VAPID key, made the first time. */
async function subscribe(record: PushRecord): Promise<PushSubscription | null> {
  const registration = await serviceWorker()
  if (!registration) return null
  const key = decodeRelayBytes(record.vapid.publicKey)!
  const current = await registration.pushManager.getSubscription()
  if (current && sameKey(current.options.applicationServerKey, key)) return current
  // One made with another key cannot be signed for with this one.
  await current?.unsubscribe().catch(() => false)
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: bufferOf(key),
  })
}

function subscriptionOf(subscription: PushSubscription, record: PushRecord): WebPushSubscription {
  const key = (name: PushEncryptionKeyName): string => {
    const value = subscription.getKey(name)
    if (!value) throw new Error(`The subscription has no ${name} key`)
    return encodeRelayBytes(new Uint8Array(value))
  }
  return {
    endpoint: subscription.endpoint,
    p256dh: key('p256dh'),
    auth: key('auth'),
    vapid: record.vapid,
  }
}

/** Closes this browser's notifications of these tags, which their host withdrew. */
export async function closeNotifications(tags: readonly string[]): Promise<void> {
  if (tags.length === 0 || !window.isSecureContext) return
  const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined)
  for (const shown of (await registration?.getNotifications().catch(() => [])) ?? []) {
    if (tags.includes(shown.tag)) shown.close()
  }
}

/** Ends this browser's subscription, as clearing it does; every host then hears it is gone. */
export async function unsubscribePush(): Promise<void> {
  if (!window.isSecureContext) return
  const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined)
  const subscription = await registration?.pushManager?.getSubscription().catch(() => null)
  await subscription?.unsubscribe().catch(() => false)
}

/**
 * Hands this browser's subscription and choices to the host on `link`, once connected, and keeps
 * its signing key; returns the host's id, or null when the host takes no Web Push. `expected` is
 * the id the browser paired with, which the host's key must give.
 */
export async function syncPush(
  link: HostLink,
  settings: SettingsFile,
  expected: string | null,
): Promise<{ hostId: string; withdrawn: string[]; subscribed: boolean } | null> {
  const { state } = link
  if (state.kind !== 'connected' || !state.welcome.features.includes(WEB_PUSH_FEATURE)) {
    return null
  }
  const told = (await link.request(NOTIFICATIONS_GET, undefined)) as NotificationsState
  const key = decodeRelayBytes(told.host.key)
  const id = key ? await relayHostId(key) : null
  if (!key || id !== told.host.id || (expected !== null && id !== expected)) {
    console.warn("The host's push key is not its own; its pushes are not shown")
    return null
  }
  const withdrawn = told.web?.withdrawn ?? []
  const unsubscribed = { hostId: id, withdrawn, subscribed: false }
  if (pushProblem() || Notification.permission !== 'granted') return unsubscribed
  const kept = await loadPushRecord()
  const record: PushRecord = {
    vapid: kept?.vapid ?? (await newVapidPair()),
    hosts: { ...kept?.hosts, [id]: key },
    sound: settings.notifications.sound,
  }
  // Kept before the host has the subscription, so its first push already checks out.
  await savePushRecord(record)
  const subscription = await subscribe(record)
  if (!subscription) return unsubscribed
  const choices = choicesOf(settings)
  if (told.web?.endpoint !== subscription.endpoint || !sameChoices(told.choices, choices)) {
    await link.request(NOTIFICATIONS_SET, { web: subscriptionOf(subscription, record), choices })
  }
  return { hostId: id, withdrawn, subscribed: true }
}

export interface WebPushOptions {
  link: HostLink
  settings(): SettingsFile
  onSettingsChanged(listener: (settings: SettingsFile) => void): () => void
  /** The host's id on the relay as this browser paired with it; null where it may not know it. */
  hostId: string | null
  /** The account's other hosts, which the hosted page opens for a click on one's notification. */
  others?: { has(hostId: string): boolean; open(hostId: string): void }
  /** Each time the subscription went to the host: the hosted page hands it to the others too. */
  synced?(): void
}

export class WebPush {
  private hostId: string | null = null
  private subscribed = false
  private running: Promise<void> = Promise.resolve()
  private readonly opens = new Set<(command: AppCommand) => void>()
  /** A click that came before the host's id was known. */
  private held: PushClick | null = null
  private wanted = ''

  constructor(private readonly options: WebPushOptions) {}

  /** Follows the link, the settings and the service worker's clicks from now on. */
  start(): void {
    const { link } = this.options
    link.onState((state) => {
      if (state.kind === 'connected') void this.sync()
    })
    link.onMessage((message) => {
      const tags = parseWithdrawn(message)
      if (tags) void closeNotifications(tags)
    })
    this.wanted = this.wish(this.options.settings())
    this.options.onSettingsChanged((settings) => {
      const wish = this.wish(settings)
      if (wish === this.wanted) return
      this.wanted = wish
      void this.sync()
    })
    if (window.isSecureContext) {
      navigator.serviceWorker?.addEventListener('message', (event: MessageEvent) => {
        const click = event.data as PushClick | null
        if (click?.type === 'kettu-notification-click') this.clicked(click)
      })
    }
    void takeClick()
      .then((click) => click && this.clicked(click))
      .catch(() => {})
    if (link.state.kind === 'connected') void this.sync()
  }

  /** Whether the host has this browser's subscription, to push to while the page is away. */
  get active(): boolean {
    return this.subscribed
  }

  /** The browser forgets the host: pushes it still sends are no longer shown. */
  async forget(): Promise<void> {
    const id = this.hostId ?? this.options.hostId
    const record = id ? await loadPushRecord().catch(() => null) : null
    if (!id || !record?.hosts[id]) return
    const hosts = Object.fromEntries(Object.entries(record.hosts).filter(([host]) => host !== id))
    await savePushRecord({ ...record, hosts }).catch(() => {})
  }

  /** What a notification's click opens on this page's host. */
  onOpen(listener: (command: AppCommand) => void): () => void {
    this.opens.add(listener)
    return () => this.opens.delete(listener)
  }

  /** Hands the host the subscription again, as when notifications were just allowed. */
  sync(): Promise<void> {
    this.running = this.running.then(async () => {
      try {
        const synced = await syncPush(
          this.options.link,
          this.options.settings(),
          this.options.hostId,
        )
        if (!synced) return
        this.hostId = synced.hostId
        this.subscribed = synced.subscribed
        await closeNotifications(synced.withdrawn)
        if (synced.subscribed) this.options.synced?.()
        const held = this.held
        this.held = null
        if (held) this.clicked(held)
      } catch (error) {
        console.warn("Could not hand this browser's notifications to the host", error)
      }
    })
    return this.running
  }

  private wish(settings: SettingsFile): string {
    return JSON.stringify([choicesOf(settings), settings.notifications.sound])
  }

  private clicked(click: PushClick): void {
    if (this.hostId === null) {
      this.held = click
      return
    }
    if (click.host === this.hostId) {
      for (const listener of this.opens) listener(click.command)
      return
    }
    const { others } = this.options
    if (!others?.has(click.host)) return
    // The page opens the other host anew, which takes the click once connected.
    void keepClick(click).then(() => others.open(click.host))
  }
}
