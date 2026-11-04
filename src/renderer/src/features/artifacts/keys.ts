/** Whether a key typed at `target` belongs to a field rather than to the page around it. */
export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}

/** The mode a key picks, V for select and C for comment, typed without a modifier; or null. */
export function isModeKey(event: KeyboardEvent): 'select' | 'comment' | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing) {
    return null
  }
  if (event.code === 'KeyV') return 'select'
  if (event.code === 'KeyC') return 'comment'
  return null
}
