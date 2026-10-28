// What keeps an artifact's page in its frame, beyond its own policy: main's request filter, the
// navigation guard, forwarded shortcuts and the watch for a page whose process stopped.

import type { Input, Session, WebContents, WebFrameMain } from 'electron'
import type { ArtifactBlockedEvent, ArtifactStoppedEvent, ForwardedKey } from '@shared/ipc'
import { ARTIFACT_SCHEME, artifactHost } from './origins'
import { refuseRequests } from '../request-filter'
import { mayRequest } from './policy'

/** How often main looks for an artifact frame whose process stopped; Electron reports none. */
const STOPPED_POLL_MS = 1_000

/** The artifact a frame belongs to: its own origin's, or the nearest ancestor's that is one. */
export function frameArtifact(frame: WebFrameMain | null | undefined): string | null {
  try {
    for (let at = frame ?? null; at; at = at.parent) {
      const host = artifactHost(at.origin)
      if (host) return host
    }
  } catch {
    // A frame whose document went away mid-walk.
  }
  return null
}

/** Whether the frame is one the main frame holds, not a frame inside another. */
function isBranch(frame: WebFrameMain): boolean {
  return frame.parent !== null && frame.parent.parent === null
}

export interface RequestSource {
  initiatorOrigin?: string
  frame?: WebFrameMain | null
}

/**
 * The artifact origin a request comes from, or null when no artifact made it. A shared worker's
 * requests have no frame, but carry the worker's origin as their initiator.
 */
export function requestingArtifact(source: RequestSource): string | null {
  return artifactHost(source.initiatorOrigin) ?? frameArtifact(source.frame)
}

/** Cancels every request an artifact makes for anything but its own origin, `data:`, `blob:` or a CDN. */
export function filterArtifactRequests(session: Session): void {
  refuseRequests(session, (details) => {
    const host = requestingArtifact(details)
    return host !== null && !mayRequest(host, details.url)
  })
}

/**
 * Where a frame inside an artifact may navigate: its own origin, and, for a frame of the page's
 * own, the empty documents that inherit it. The frame the app holds commits nothing else, or the
 * frame guard would revoke the app's access.
 */
export function mayNavigate(host: string, url: string, branch: boolean): boolean {
  if (artifactHost(url) === host) return true
  return !branch && (url === 'about:blank' || url === 'about:srcdoc')
}

/** Whether a key in a page's frame is an app shortcut main passes on to the app's page. */
export function forwardedKey(input: Input, platform: NodeJS.Platform): ForwardedKey | null {
  if (input.type !== 'keyDown' || input.alt || input.isComposing) return null
  const key: ForwardedKey = {
    key: input.key,
    code: input.code,
    shiftKey: input.shift,
    ctrlKey: input.control,
    metaKey: input.meta,
  }
  if (input.code === 'Backquote' && input.control && !input.meta) return key
  const mac = platform === 'darwin'
  if (mac ? !input.meta || input.control : !input.control || input.meta) return null
  const lower = input.key.toLowerCase()
  if (lower === 'l' && !input.shift) return key
  if (input.shift && (input.code === 'BracketLeft' || input.code === 'BracketRight')) return key
  // The shortcuts dialog's key has no menu item, so it passes on macOS too.
  if (input.key === '/') return key
  // Focus a pane of the split view, which has no menu item either.
  if (/^[1-9]$/.test(input.key)) return key
  // On macOS the app menu's accelerators take the rest.
  if (mac) return null
  if (['=', '+', '-', '_', '0'].includes(input.key)) return key
  return !input.shift && ['o', 'n', 'b', ','].includes(lower) ? key : null
}

export interface ArtifactFrameDeps {
  platform: NodeJS.Platform
  blocked(event: ArtifactBlockedEvent): void
  stopped(event: ArtifactStoppedEvent): void
  shortcut(key: ForwardedKey): void
}

/**
 * Keeps the artifacts in a window's frames on their own origins and tells the app's page what it
 * cannot see: a navigation main cancelled, a page whose process stopped, and app shortcuts typed
 * in a page.
 */
export function guardArtifactFrames(contents: WebContents, deps: ArtifactFrameDeps): void {
  // The app's policy refuses a page's own navigation to anything but an artifact before this
  // event, and a page's policy its frames'; this cancels what they let through, as another
  // artifact's origin, which would otherwise commit.
  contents.on('will-frame-navigate', (details) => {
    const frame = details.frame
    if (details.isMainFrame || details.isSameDocument || !frame) return
    const host = frameArtifact(frame)
    if (host !== null && !mayNavigate(host, details.url, isBranch(frame))) details.preventDefault()
  })
  // Every navigation off the page's origin fails, so an http(s) one is offered to the user.
  contents.on('did-start-navigation', (details) => {
    const frame = details.frame
    if (details.isMainFrame || details.isSameDocument || !frame) return
    const host = frameArtifact(frame)
    if (host === null || mayNavigate(host, details.url, isBranch(frame))) return
    const protocol = URL.parse(details.url)?.protocol
    if (protocol !== 'http:' && protocol !== 'https:') return
    deps.blocked({
      origin: `${ARTIFACT_SCHEME}://${host}`,
      url: details.url,
      reload: isBranch(frame),
    })
  })

  contents.on('before-input-event', (event, input) => {
    if (frameArtifact(contents.focusedFrame) === null) return
    const key = forwardedKey(input, deps.platform)
    if (!key) return
    event.preventDefault()
    deps.shortcut(key)
  })

  // A stopped frame's process sends no event; its frame stays in the page, detached.
  const shown = new Map<number, string>()
  let poll: NodeJS.Timeout | null = null
  const check = (): void => {
    if (contents.isDestroyed()) return
    for (const [id, origin] of shown) {
      const frame = contents.mainFrame.frames.find((f) => f.frameTreeNodeId === id)
      if (frame && !frame.detached) continue
      shown.delete(id)
      if (frame) deps.stopped({ origin })
    }
    if (shown.size === 0 && poll) {
      clearInterval(poll)
      poll = null
    }
  }
  contents.on(
    'did-frame-navigate',
    (_, _url, _code, _status, isMainFrame, processId, routingId) => {
      if (isMainFrame) return shown.clear()
      // Only the frames the app's page holds; a page's own frames share its process.
      const frame = contents.mainFrame.frames.find(
        (f) => f.processId === processId && f.routingId === routingId,
      )
      if (!frame) return
      const host = frameArtifact(frame)
      if (!host) return void shown.delete(frame.frameTreeNodeId)
      shown.set(frame.frameTreeNodeId, `${ARTIFACT_SCHEME}://${host}`)
      poll ??= setInterval(check, STOPPED_POLL_MS)
    },
  )
  contents.once('destroyed', () => {
    if (poll) clearInterval(poll)
  })
}

/** Whether a window may open `url`: never while a page's frame has focus, nor an artifact's URL. */
export function mayOpenWindow(contents: WebContents, url: string): boolean {
  return artifactHost(url) === null && frameArtifact(contents.focusedFrame) === null
}
