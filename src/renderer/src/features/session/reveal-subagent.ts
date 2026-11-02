import { useEffect, useEffectEvent, useSyncExternalStore } from 'react'
import { useSessionsStore } from '@renderer/stores/sessions'
import { loadThrough, useThreadsStore, type Replica } from '@renderer/stores/threads'
import { openSession, shownLayoutSessions, useViewStore } from '@renderer/stores/view'

/** A sub-agent's block to bring into view; the block takes it once it renders. */
export interface RevealRequest {
  entryId: string
  /** Tells one request from the next for the same block. */
  nonce: number
}

// A request nothing took by then, as a block whose entry never arrives, is dropped.
const REQUEST_MS = 10_000

let request: RevealRequest | null = null
let nonce = 0
let expiry: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

function setRequest(next: RevealRequest | null): void {
  request = next
  clearTimeout(expiry)
  if (next) expiry = setTimeout(() => takeReveal(next), REQUEST_MS)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The thread entry of a sub-agent's block in its parent's thread. */
export const subagentEntryId = (childId: string): string => `s:${childId}`

/**
 * Shows the parent session if no pane in view shows it, then scrolls its thread to the
 * sub-agent's block and highlights it briefly.
 */
export function revealSubagent(parentId: string, childId: string): void {
  const parent = useSessionsStore.getState().byId[parentId]
  if (!parent) return
  if (!shownLayoutSessions(useViewStore.getState()).includes(parentId)) {
    openSession(parentId, parent.projectPath)
  }
  const entryId = subagentEntryId(childId)
  setRequest({ entryId, nonce: ++nonce })
  void loadEntry(parentId, entryId)
}

/** The standing request, if any. */
export function revealRequest(): RevealRequest | null {
  return request
}

/** The request for a block, while it stands. */
export function useRevealRequest(entryId: string): RevealRequest | null {
  return useSyncExternalStore(subscribe, () => (request?.entryId === entryId ? request : null))
}

/** Ends a request once its block took it. */
export function takeReveal(taken: RevealRequest): void {
  if (request === taken) setRequest(null)
}

/** The parent's replica once ready, or null when it does not get there in time. */
function readyReplica(sessionId: string): Promise<Replica | null> {
  const ready = (): Replica | null => {
    const replica = useThreadsStore.getState().replicas[sessionId]
    return replica?.status === 'ready' && replica.state ? replica : null
  }
  const now = ready()
  if (now) return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = (replica: Replica | null): void => {
      clearTimeout(timer)
      unsubscribe()
      resolve(replica)
    }
    const timer = setTimeout(() => done(null), REQUEST_MS)
    const unsubscribe = useThreadsStore.subscribe(() => {
      const replica = ready()
      if (replica) done(replica)
    })
  })
}

/** Loads the parent's older pages when the block lies before the loaded ones. */
async function loadEntry(parentId: string, entryId: string): Promise<void> {
  const replica = await readyReplica(parentId)
  if (!replica?.state || replica.state.byId[entryId] || replica.older === null) return
  // Nothing tells which page holds it, so the thread loads back to its start, as a jump there does.
  await loadThrough(parentId, 0)
}

/** Whether reduce-motion is on, from the system or from Settings › Appearance. */
export function reducedMotion(): boolean {
  return (
    document.documentElement.dataset.reduceMotion === 'always' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

// A scroll that sends no scrollend, as one already in place, counts as ended after this.
const SCROLL_END_MS = 1000

function scrollEnd(view: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      view.removeEventListener('scrollend', done)
      resolve()
    }
    const timer = setTimeout(done, SCROLL_END_MS)
    view.addEventListener('scrollend', done)
  })
}

/**
 * Scrolls to a block and keeps it there: items above it keep an estimated height until they
 * render, so a smooth scroll can land off and is set right once it ends. The reader's own scroll
 * ends it.
 */
export function useRevealScroll(
  target: RevealRequest | null,
  element: () => HTMLElement | null,
  place: (behavior: ScrollBehavior) => void,
  onRevealed: () => void,
): void {
  const reveal = useEffectEvent((taken: RevealRequest): (() => void) | undefined => {
    takeReveal(taken)
    const view = element()?.closest<HTMLElement>('[data-slot="message-scroller-viewport"]')
    if (!view) return
    let stopped = false
    const stop = (): void => {
      stopped = true
    }
    const events = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const
    const release = (): void => {
      for (const name of events) view.removeEventListener(name, stop)
    }
    for (const name of events) view.addEventListener(name, stop, { passive: true })
    void (async () => {
      place(reducedMotion() ? 'auto' : 'smooth')
      onRevealed()
      for (let pass = 0; pass < 2 && !stopped; pass++) {
        await scrollEnd(view)
        if (!stopped) place('auto')
      }
      release()
    })()
    return () => {
      stopped = true
      release()
    }
  })
  useEffect(() => (target ? reveal(target) : undefined), [target])
}
