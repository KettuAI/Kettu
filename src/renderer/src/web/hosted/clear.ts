// Signing out and clearing the browser, for a shared computer: each host this browser can reach now
// removes it first, so its key is gone on both sides; then the sign-in is revoked and everything the
// web client keeps in this browser is deleted. A host that does not answer in a moment keeps the
// device until its owner removes it or it goes unseen.

import type { KeyPair } from '@shared/remote/noise'
import type { Hello } from '@shared/remote/protocol'
import { hello, HostLink } from '@shared/remote/link'
import { clearAll } from '../storage'
import type { HostedAccount } from './account'
import { relayDial, type HostedHost } from './hosts'

/** How long one host has to connect and remove this browser. */
const REMOVE_MS = 8000

export interface ClearOptions {
  /** The link to the host shown, if any. */
  link: HostLink | null
  /** The account's other hosts, reached each for the moment it takes. */
  others: HostedHost[]
  account: HostedAccount
  key: KeyPair
  client: Hello['client']
}

function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    work.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ])
}

/** Asks the host on `link` to remove this browser once the link is connected. */
async function removeOver(link: HostLink, ms: number): Promise<void> {
  const connected = new Promise<string>((resolve) => {
    const check = (): boolean => {
      if (link.state.kind !== 'connected') return false
      resolve(link.state.welcome.device.id)
      return true
    }
    if (check()) return
    const off = link.onState(() => {
      if (check()) off()
    })
  })
  // The host closes the connection as it removes the device, maybe before it answers.
  await within(
    connected.then((id) => link.request('remote.removeDevice', { id })),
    ms,
  )
}

export async function clearBrowser(options: ClearOptions): Promise<void> {
  const { account, key, client } = options
  const others = options.others.map(async (host) => {
    const link = new HostLink({
      dial: relayDial(
        host.relay,
        () => account.accessToken(),
        () => {},
      ),
      hostKey: host.hostKey,
      key,
      hello: hello(client),
    })
    link.start()
    try {
      await removeOver(link, REMOVE_MS)
    } finally {
      link.stop()
    }
  })
  await Promise.all([...(options.link ? [removeOver(options.link, REMOVE_MS)] : []), ...others])
  await account.signOut()
  await clearAll().catch((error: unknown) => console.error('Could not clear IndexedDB', error))
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch {
    // Storage the page cannot reach holds nothing of it.
  }
  const workers = (await navigator.serviceWorker?.getRegistrations?.().catch(() => [])) ?? []
  await Promise.all(workers.map((worker) => worker.unregister()))
}
