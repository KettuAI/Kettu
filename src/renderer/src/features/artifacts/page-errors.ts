// The uncaught errors of the artifact pages this window shows, as their own scripts reported them:
// from main on the desktop, over each frame's port in the web client. Plain text, never markup.

import { useSyncExternalStore } from 'react'
import { PageErrorLog, type PageErrors } from '@shared/artifact-runtime/page-errors'
import { parsePageError, type PageErrorMessage } from '@shared/artifact-runtime/page-messages'
import { isWeb } from '@renderer/lib/platform'

const log = new PageErrorLog()
const listeners = new Set<() => void>()
const shown = new Map<string, PageErrors[]>()
let listening = false

function changed(origin: string): void {
  shown.set(origin, log.of(origin))
  for (const listener of [...listeners]) listener()
}

/** A frame's report, checked already, of a page of the artifact at `origin`. */
export function receivePageError(origin: string, message: PageErrorMessage): void {
  if (log.add(origin, message)) changed(origin)
}

/** Main's reports, from every frame of an origin this window opened. */
export function listenPageErrors(): void {
  if (listening || isWeb) return
  listening = true
  window.kettu.artifacts.onPageError((event) => {
    const message = parsePageError(event.message)
    if (message) receivePageError(event.origin, message)
  })
}

/** Forgets what the artifact's pages reported, as when the viewer reloads them. */
export function clearPageErrors(origin: string, path?: string): void {
  log.clear(origin, path)
  changed(origin)
}

const NONE: PageErrors[] = []

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The errors of the pages of the artifact at `origin`, as its URL without the last slash. */
export function usePageErrors(origin: string | null): PageErrors[] {
  return useSyncExternalStore(subscribe, () => (origin ? (shown.get(origin) ?? NONE) : NONE))
}
