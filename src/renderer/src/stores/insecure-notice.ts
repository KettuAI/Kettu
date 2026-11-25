import { create } from 'zustand'
import { readJson, writeJson } from '@renderer/lib/storage'
import { isWeb } from '@renderer/lib/platform'
import { useWebHostStore } from './web-host'

// The pages of the web client this browser hid its insecure notice on, by host and address, in
// localStorage: the same host at another address, or another host at this one, shows it again.

const KEY = 'kettu.insecure-hidden'

/** How many pages are remembered; the oldest is forgotten past it. */
const MAX_PAGES = 50

const unprotected = isWeb && !window.isSecureContext

function load(): string[] {
  const kept = readJson<unknown>(KEY, [])
  return Array.isArray(kept) ? kept.filter((page) => typeof page === 'string') : []
}

export const useInsecureNotice = create<{ hidden: string[] }>()(() => ({ hidden: load() }))

const pageOf = (hostId: string): string => `${hostId} ${location.origin}`

/** Whether this page's notice shows or is hidden; null on a page that is protected. */
export function useInsecureState(): 'shown' | 'hidden' | null {
  const hostId = useWebHostStore((s) => s.host?.id ?? null)
  const hidden = useInsecureNotice((s) => hostId !== null && s.hidden.includes(pageOf(hostId)))
  if (!unprotected) return null
  return hidden ? 'hidden' : 'shown'
}

/** Hides this page's notice, or shows it again. */
export function setInsecureHidden(hidden: boolean): void {
  const hostId = useWebHostStore.getState().host?.id
  if (!hostId) return
  const page = pageOf(hostId)
  const pages = useInsecureNotice.getState().hidden.filter((kept) => kept !== page)
  if (hidden) pages.push(page)
  const next = pages.slice(-MAX_PAGES)
  useInsecureNotice.setState({ hidden: next })
  writeJson(KEY, next)
}
