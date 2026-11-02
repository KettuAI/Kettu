/**
 * A control-row popup's side offset that clears the whole composer box, `gap` px above it, rather
 * than the trigger under the box. Read on each placement, so a box that grew is cleared too.
 */
export function aboveBox(trigger: Element | null, gap = 6): () => number {
  return () => {
    const box = trigger?.closest('[data-composer]')?.querySelector('[data-slot=input-group]')
    if (!trigger || !box) return gap
    return trigger.getBoundingClientRect().top - box.getBoundingClientRect().top + gap
  }
}
