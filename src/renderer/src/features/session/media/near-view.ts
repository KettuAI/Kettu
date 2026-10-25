import { useEffect, useState, type RefObject } from 'react'

/** Media asks for its file once it is within one viewport of the visible part of its scroller. */
const MARGIN = '100% 0px'

const watched = new Map<Element, () => void>()
const observers = new Map<Element | null, IntersectionObserver>()

function observerFor(root: Element | null): IntersectionObserver {
  let observer = observers.get(root)
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) watched.get(entry.target)?.()
      },
      { root, rootMargin: MARGIN },
    )
    observers.set(root, observer)
  }
  return observer
}

/**
 * Whether the element has come near the view, through one observer per scroller: the margin
 * applies to the scroller's visible part only when the scroller is the root. Once near, it stays
 * so, and the media it holds keeps its source.
 */
export function useNearView(ref: RefObject<Element | null>, enabled = true): boolean {
  const [near, setNear] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element || !enabled || near) return
    const root = element.closest('[data-slot="message-scroller-viewport"]')
    const observer = observerFor(root)
    watched.set(element, () => setNear(true))
    observer.observe(element)
    return () => {
      watched.delete(element)
      observer.unobserve(element)
    }
  }, [ref, enabled, near])
  return near
}
