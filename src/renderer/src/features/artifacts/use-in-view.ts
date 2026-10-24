import { useEffect, useState, type RefObject } from 'react'

/** Whether an element is in view, so a card asks for its thumbnail once it scrolls there. */
const watched = new Map<Element, (inView: boolean) => void>()
let observer: IntersectionObserver | null = null

export function useInView(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) watched.get(entry.target)?.(entry.isIntersecting)
    })
    watched.set(element, setInView)
    observer.observe(element)
    return () => {
      watched.delete(element)
      observer?.unobserve(element)
    }
  }, [ref])
  return inView
}
