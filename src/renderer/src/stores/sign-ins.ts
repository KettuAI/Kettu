import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { BroughtSite, SignInOffer, SignInSource } from '@shared/signins'
import { isWeb } from '@renderer/lib/platform'

/** What the dialog that brings sign-ins shows: every site of a profile, or one site's sign-in. */
export type SignInsDialog =
  | { id: number; mode: 'all' }
  | { id: number; mode: 'one'; offer: SignInOffer; sessionId: string | null }

interface SignInsStore {
  dialog: SignInsDialog | null
  /** The sites brought from other browsers; null until read. */
  brought: BroughtSite[] | null
  /** The browsers found here, as last listed; null until read. */
  sources: SignInSource[] | null
}

export const useSignInsStore = create<SignInsStore>()(() => ({
  dialog: null,
  brought: null,
  sources: null,
}))

let nextId = 1
let listening = false

function listen(): void {
  if (listening || isWeb) return
  listening = true
  window.kettu.signIns.onChanged((brought) => useSignInsStore.setState({ brought }))
}

/** Opens the dialog that brings the sign-ins of the sites the user picks. */
export function openBringSignIns(): void {
  useSignInsStore.setState({ dialog: { id: nextId++, mode: 'all' } })
}

/** Brings one site's sign-in from the browser that offers it, as the address field's chip does. */
export function bringOfferedSignIn(offer: SignInOffer, sessionId: string | null = null): void {
  useSignInsStore.setState({ dialog: { id: nextId++, mode: 'one', offer, sessionId } })
}

/**
 * Brings the sign-in of the site `url` is on from the user's own browser that has one, opening
 * the dialog that asks macOS for it. Resolves to the offer it brings from, or null when no browser
 * has a sign-in Kettu's browser lacks there. A card asking the user to sign in calls this.
 */
export async function bringSiteSignIn(target: {
  url: string
  sessionId?: string | null
}): Promise<SignInOffer | null> {
  if (isWeb) return null
  const offer = await window.kettu.signIns.offer(target.url).catch(() => null)
  if (offer) bringOfferedSignIn(offer, target.sessionId ?? null)
  return offer
}

export function closeSignInsDialog(): void {
  useSignInsStore.setState({ dialog: null })
}

/** Reads the brought sites again, as Settings does each time the Browser page shows. */
export function loadBrought(): void {
  if (isWeb) return
  listen()
  void window.kettu.signIns.brought().then(
    (brought) => useSignInsStore.setState({ brought }),
    () => useSignInsStore.setState((s) => ({ brought: s.brought ?? [] })),
  )
}

let sourcesRead: Promise<SignInSource[]> | null = null

/** The browsers found on this computer, read once a run unless `again`. */
export function loadSources(again = false): Promise<SignInSource[]> {
  if (isWeb) return Promise.resolve([])
  if (!sourcesRead || again) {
    const read = window.kettu.signIns.sources()
    sourcesRead = read
    read.then(
      (sources) => useSignInsStore.setState({ sources }),
      () => {
        if (sourcesRead === read) sourcesRead = null
      },
    )
  }
  return sourcesRead
}

/** A browser whose sign-ins can be brought: listed with a profile and not refused. */
export function bringable(source: SignInSource): boolean {
  return source.unavailable === null && source.profiles.length > 0
}

/**
 * The browser used most on this computer, as far as Kettu can tell: the system's default when it
 * can be brought from, else the one with the most sites. Null when none can.
 */
export function preferredSource(
  sources: readonly SignInSource[],
  defaultBrowser: string | null,
): SignInSource | null {
  const usable = sources.filter(bringable)
  const named = defaultBrowser?.toLowerCase()
  const byDefault = named
    ? usable.find((source) => {
        const name = source.name.toLowerCase()
        return name === named || name.startsWith(named) || named.startsWith(name)
      })
    : undefined
  if (byDefault) return byDefault
  const sites = (source: SignInSource) =>
    source.profiles.reduce((total, profile) => total + profile.sites, 0)
  return [...usable].sort((a, b) => sites(b) - sites(a))[0] ?? null
}

/**
 * The sign-in another browser offers for the site a page shows, asked each time the address
 * changes; null while it is asked and when there is none.
 */
export function useSignInOffer(url: string | null): SignInOffer | null {
  const [answer, setAnswer] = useState<{ url: string; offer: SignInOffer | null } | null>(null)
  const brought = useSignInsStore((s) => s.brought)
  useEffect(() => {
    if (!url || isWeb || !/^https?:/i.test(url)) return
    listen()
    let cancelled = false
    void window.kettu.signIns.offer(url).then(
      (offer) => {
        if (!cancelled) setAnswer({ url, offer })
      },
      () => {
        if (!cancelled) setAnswer({ url, offer: null })
      },
    )
    return () => {
      cancelled = true
    }
    // A site brought or removed may change the answer for the same address.
  }, [url, brought])
  return answer && answer.url === url ? answer.offer : null
}
