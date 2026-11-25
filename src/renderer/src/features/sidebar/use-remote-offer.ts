import { useEffect, useState } from 'react'
import type { RemoteOffer } from '@shared/remote/discovery'

/** The offer main makes now to let another client of the account in, kept current. */
export function useRemoteOffer(): RemoteOffer | null {
  const [offer, setOffer] = useState<RemoteOffer | null>(null)
  useEffect(() => {
    let live = true
    const off = window.kettu.remote.onOffer(setOffer)
    window.kettu.remote
      .offer()
      .then((current) => {
        if (live) setOffer(current)
      })
      .catch((error: unknown) => console.error('Could not read the remote access offer', error))
    return () => {
      live = false
      off()
    }
  }, [])
  return offer
}
