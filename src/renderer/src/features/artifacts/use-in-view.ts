import { useEffect, useState, type RefObject } from 'react'

/** Whether an element is in view, so a card asks for its thumbnail once it scrolls there. */
const watched = new Map<Element, (inView: boolean) => void>()
let observer: IntersectionObserver | null = null

// Keep the callback at module scope so V8 never retains the first mounted element via a shared
// hook closure context.
function getObserver(): IntersectionObserver {
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) watched.get(entry.target)?.(entry.isIntersecting)
  })
  return observer
}

/** Subscribes `element` to the shared IntersectionObserver and disconnects it when unused. */
export function observeInView(element: Element, onChange: (inView: boolean) => void): () => void {
  const active = getObserver()
  watched.set(element, onChange)
  active.observe(element)
  return () => {
    watched.delete(element)
    active.unobserve(element)
    if (watched.size === 0 && observer === active) {
      observer.disconnect()
      observer = null
    }
  }
}

export function useInView(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    return observeInView(element, setInView)
  }, [ref])
  return inView
}
