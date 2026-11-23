// The account's hosts the page does not show get this browser's Web Push subscription too, each
// over the relay for the moment it takes, as clearing reaches them; each once for a subscription
// and the choices it went with, which this browser remembers.

import type { Hello } from '@shared/remote/protocol'
import type { KeyPair } from '@shared/remote/noise'
import { hello, HostLink } from '@shared/remote/link'
import type { SettingsFile } from '@shared/settings'
import { pushEndpoint, pushWish, syncPush } from '../push'
import { relayDial, type HostedHost } from './hosts'
import type { HostedRelay } from './relay-regions'

/** How long one host has to connect and take the subscription. */
const HAND_MS = 15_000

const HANDED_KEY = 'kettu.pushHanded'

function handed(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HANDED_KEY) ?? '{}')
    return typeof value === 'object' && value !== null ? (value as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function keep(record: Record<string, string>): void {
  try {
    localStorage.setItem(HANDED_KEY, JSON.stringify(record))
  } catch {
    // Not remembered, the next page hands it again.
  }
}

function connected(link: HostLink): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), HAND_MS)
    const done = (ok: boolean): void => {
      clearTimeout(timer)
      off()
      resolve(ok)
    }
    const off = link.onState((state) => {
      if (state.kind === 'connected') done(true)
      else if (state.kind === 'stopped') done(false)
    })
    if (link.state.kind === 'connected') done(true)
  })
}

export interface HandOptions {
  shown: HostedHost
  others: HostedHost[]
  relays: HostedRelay
  key: KeyPair
  client: Hello['client']
  settings: SettingsFile
}

let handing = false

/** Hands the subscription to each other host that does not have it as it is now. */
export async function handPushToOthers(options: HandOptions): Promise<void> {
  if (handing) return
  const endpoint = await pushEndpoint()
  if (!endpoint) return
  handing = true
  try {
    const wish = pushWish(endpoint, options.settings)
    const record = handed()
    record[options.shown.relay.id] = wish
    for (const host of options.others) {
      if (record[host.relay.id] === wish) continue
      const link = new HostLink({
        dial: relayDial(
          host.relay,
          () => options.relays.token(),
          () => {},
          options.relays,
        ),
        hostKey: host.hostKey,
        key: options.key,
        hello: hello(options.client),
      })
      link.start()
      try {
        if (!(await connected(link))) continue
        const synced = await syncPush(link, options.settings, host.relay.id)
        if (synced?.subscribed) record[host.relay.id] = wish
      } catch (error) {
        console.warn(`Could not hand ${host.name} this browser's notifications`, error)
      } finally {
        link.stop()
      }
    }
    const known = new Set([options.shown, ...options.others].map((host) => host.relay.id))
    keep(Object.fromEntries(Object.entries(record).filter(([id]) => known.has(id))))
  } finally {
    handing = false
  }
}
