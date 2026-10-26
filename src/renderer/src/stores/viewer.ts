import { create } from 'zustand'
import type { ViewerItem } from '@renderer/features/session/media/viewer-items'

/** What the media viewer opens on, and whose items it steps through. */
export interface ViewerRequest {
  /** The session whose thread's items it holds; null in New session. */
  sessionId: string | null
  /** The session's folder, which grants its files and holds those Show in Files opens. */
  projectPath: string | null
  /** The composer draft whose images follow the thread's. */
  draft: string | null
  item: ViewerItem
  /** The item's place, which the item grows from; focus returns to what had it before. */
  from: HTMLElement | null
}

interface ViewerStore {
  request: ViewerRequest | null
  /** Asked to close: the item goes back to its place before the viewer goes. */
  closing: boolean
}

export const useViewerStore = create<ViewerStore>()(() => ({ request: null, closing: false }))

export function openViewer(request: ViewerRequest): void {
  useViewerStore.setState({ request, closing: false })
}

export function closeViewer(): void {
  if (useViewerStore.getState().request) useViewerStore.setState({ closing: true })
}

/** Once the closing motion has ended. */
export function closedViewer(): void {
  useViewerStore.setState({ request: null, closing: false })
}
