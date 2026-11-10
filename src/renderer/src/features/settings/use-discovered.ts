import { useEffect } from 'react'
import type { DiscoveredHosts } from '@shared/remote/discovery'
import { useAccountStore } from '@renderer/stores/account'
import { loadDiscovered, useHostsStore } from '@renderer/stores/hosts'

const SIGNED_OUT: DiscoveredHosts = { state: 'signed_out' }

/**
 * Reads the account's hosts on mount, and again when the paired hosts or the account change.
 * Signed out, there is nothing to ask.
 */
export function useDiscoveredHosts(): DiscoveredHosts | null {
  const hostIds = useHostsStore((s) => s.status?.hosts?.map((h) => h.id).join(' ') ?? '')
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
