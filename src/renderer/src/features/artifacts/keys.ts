import type { ViewerMode } from '@renderer/stores/artifact-viewer'

/** Whether a key typed at `target` belongs to a field rather than to the page around it. */
export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}

/** The mode a key picks, V, C or E typed without a modifier; or null. */
export function modeKey(event: KeyboardEvent): ViewerMode | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing) {
    return null
  }
  if (event.code === 'KeyV') return 'view'
  if (event.code === 'KeyC') return 'comment'
  if (event.code === 'KeyE') return 'edit'
  return null
}
