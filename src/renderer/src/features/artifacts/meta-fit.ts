import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Fits the card's line in its width: the page count gives way first, then the version; the time
 * never does, and the title is cut on its own line.
 */
export function useMetaFit(): RefObject<HTMLSpanElement | null> {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const head = el?.parentElement
    if (!el || !head) return
    const fit = () => {
      el.dataset.fitting = ''
      for (const drop of ['0', '1', '2']) {
        el.dataset.drop = drop
        if (el.scrollWidth <= el.clientWidth) break
      }
      delete el.dataset.fitting
    }
    fit()
    // The head's width comes from the grid, so a fit never feeds its own observer.
    let width = head.clientWidth
    const observer = new ResizeObserver(() => {
      if (head.clientWidth === width) return
      width = head.clientWidth
      fit()
    })
    observer.observe(head)
    const words = new MutationObserver(fit)
    words.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      words.disconnect()
    }
  }, [])
  return ref
}
