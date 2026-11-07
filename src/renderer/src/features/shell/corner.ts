import { hasBand } from '@renderer/lib/platform'
import { useViewStore } from '@renderer/stores/view'
import { useNarrowWindow } from './narrow'

/**
 * Whether the main area's top left corner holds the corner's controls: on macOS, with the sidebar
 * hidden, or in a narrow window, whose sidebar is a drawer. A head there starts after them.
 */
export function useCornered(): boolean {
  const collapsed = useViewStore((s) => s.sidebarCollapsed)
  const narrow = useNarrowWindow()
  return (collapsed || narrow) && !hasBand
}
