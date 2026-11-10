import { useEffect } from 'react'
import type { DiscoveredHosts } from '@shared/remote/discovery'
import { useAccountStore } from '@renderer/stores/account'
import { loadDiscovered, useHostsStore } from '@renderer/stores/hosts'

const REREAD_MS = 30_000

const SIGNED_OUT: DiscoveredHosts = { state: 'signed_out' }

/**
 * Reads the account's hosts on mount, and again when the paired hosts or the account change.
 * Signed out, there is nothing to ask.
 */
export function useDiscoveredHosts(): DiscoveredHosts | null {
  // A removed host stays listed under its id, and may be found and paired again.
  const hostIds = useHostsStore(
    (s) => s.status?.hosts?.map((h) => (h.removed ? `${h.id}-removed` : h.id)).join(' ') ?? '',
  )
  const account = useAccountStore((s) =>
    s.status?.state === 'signed-in' ? s.status.account.id : (s.status?.state ?? ''),
  )
  const signedOut = account === 'signed-out'
  useEffect(() => {
    if (!signedOut) void loadDiscovered()
  }, [hostIds, account, signedOut])
  const discovered = useHostsStore((s) => s.discovered)
  return signedOut ? SIGNED_OUT : discovered
}

/**
 * Reads the account's hosts again while the list is on screen: when the window comes back, and
 * every 30 s. A host that goes offline or stops letting devices find it says nothing.
 */
export function useRereadDiscovered(): void {
  const signedOut = useAccountStore((s) => s.status?.state === 'signed-out')
  useEffect(() => {
    if (signedOut) return
    let timer: ReturnType<typeof setInterval> | undefined
    const stop = (): void => {
      clearInterval(timer)
      timer = undefined
    }
    const follow = (): void => {
      if (document.visibilityState !== 'visible') return stop()
      if (timer === undefined) timer = setInterval(() => void loadDiscovered(), REREAD_MS)
    }
    const back = (): void => {
      if (document.visibilityState === 'visible') void loadDiscovered()
      follow()
    }
    follow()
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', back)
    return () => {
      stop()
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', back)
    }
  }, [signedOut])
}
