import type { WebContents } from 'electron'
import { createLogger } from './log'

const log = createLogger('window')

const framed = new WeakSet<WebContents>()

/**
 * The app's page never creates a frame, so a page that has one is not trusted any more: from the
 * first subframe until the main frame loads a new document, `hasSubframe` is true, and `onFound`
 * runs once.
 */
export function watchSubframes(contents: WebContents, onFound: () => void): void {
  const found = (url: string): void => {
    if (framed.has(contents)) return
    framed.add(contents)
    log.warn(
      `Refusing IPC and permissions from window ${contents.id} until it reloads: ` +
        `it created a frame (${url || 'about:blank'})`,
    )
    onFound()
  }
  contents.on('frame-created', (_, { frame }) => {
    // A frame that is already gone cannot be told apart from a subframe.
    if (frame?.parent === null) return
    found(frame?.url ?? '')
  })
  contents.on('did-frame-navigate', (_, url, _code, _status, isMainFrame) => {
    if (!isMainFrame) found(url)
  })
  // A new document replaces the frames of the old one; one that still has frames stays refused.
  contents.on('did-navigate', () => {
    if (contents.mainFrame.frames.length === 0) framed.delete(contents)
  })
}

/** Whether the page in `contents` has had a subframe since its main frame last loaded. */
export function hasSubframe(contents: WebContents): boolean {
  return framed.has(contents)
}
