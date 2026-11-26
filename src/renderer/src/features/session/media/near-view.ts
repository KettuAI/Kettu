import { useEffect, useState, type RefObject } from 'react'

/** Media asks for its file once it is within one viewport of the visible part of its scroller. */
const MARGIN = '100% 0px'

interface RootObserver {
  observer: IntersectionObserver
  count: number
}

const watched = new Map<Element, () => void>()
const observers = new Map<Element | null, RootObserver>()

function onIntersections(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) if (entry.isIntersecting) watched.get(entry.target)?.()
}

function acquireObserver(root: Element | null): IntersectionObserver {
  let entry = observers.get(root)
  if (!entry) {
    entry = {
      observer: new IntersectionObserver(onIntersections, { root, rootMargin: MARGIN }),
      count: 0,
    }
    observers.set(root, entry)
  }
  entry.count++
  return entry.observer
}

function releaseObserver(root: Element | null, observer: IntersectionObserver): void {
  const entry = observers.get(root)
  if (!entry || entry.observer !== observer) return
  entry.count--
  if (entry.count <= 0) {
    observer.disconnect()
    observers.delete(root)
  }
}

/** Subscribes `element` under `root`'s shared observer and disconnects `root`'s observer once empty. */
export function observeNearView(
  element: Element,
  root: Element | null,
  onNear: () => void,
): () => void {
  const observer = acquireObserver(root)
  watched.set(element, onNear)
  observer.observe(element)
  return () => {
    watched.delete(element)
    observer.unobserve(element)
    releaseObserver(root, observer)
  }
}

/**
 * Whether the element has come near the view, through one observer per scroller: the margin
 * applies to the scroller's visible part only when the scroller is the root. Once near, it stays
 * so, and the media it holds keeps its source. `scroller` finds the scroller from the element.
 */
export function useNearView(
  ref: RefObject<Element | null>,
  enabled = true,
  scroller = '[data-slot="message-scroller-viewport"]',
): boolean {
  const [near, setNear] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element || !enabled || near) return
    const root = element.closest(scroller)
    return observeNearView(element, root, () => setNear(true))
  }, [ref, enabled, near, scroller])
  return near
}

/** Test-only helper to verify observers do not retain detached scroller roots. */
export const _nearViewObserversCountForTests = (): number => observers.size
