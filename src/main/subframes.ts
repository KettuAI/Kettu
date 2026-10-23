import type { WebContents, WebFrameMain } from 'electron'
import { createLogger } from './log'

const log = createLogger('window')

/** How long a new frame may take to commit its first document. */
const COMMIT_TIMEOUT_MS = 5_000
/** How often main looks for pending frames the page removed before they committed. */
const REMOVED_POLL_MS = 100

export interface SubframeOptions {
  /** Whether `origin` is an artifact origin the page opened with `artifact:open`. */
  isOpenedArtifact(origin: string): boolean
  /** Runs once each time the page loses its access. */
  onRevoked(): void
  commitTimeoutMs?: number
}

interface Guard {
  revoked: boolean
  /** Frames of the main frame that have not committed a document yet, by frame tree node. */
  pending: Map<number, NodeJS.Timeout>
  /** Frames of the main frame whose document is on an artifact origin the page opened. */
  artifacts: Set<number>
  waiters: (() => void)[]
  poll: NodeJS.Timeout | null
}

const guards = new WeakMap<WebContents, Guard>()

function originOf(frame: WebFrameMain): string {
  try {
    return frame.origin
  } catch {
    // Its document is gone already.
    return 'null'
  }
}

/** The frame of `frame`'s branch that the main frame holds: itself, or the ancestor that is. */
function branchOf(frame: WebFrameMain): WebFrameMain {
  let branch = frame
  while (branch.parent && branch.parent.parent !== null) branch = branch.parent
  return branch
}

/**
 * The app's page creates no frame of its own, so main trusts a page with a frame only while every
 * frame holds an artifact the page opened: a new frame is pending until its first document
 * commits, and `isRevoked` turns true for a document on any other origin, for a frame that does not
 * commit within 5 s, and for one main cannot see. Frames inside an artifact's frame are the
 * artifact's own. The page is trusted again once its main frame loads a new document with no frames.
 */
export function watchSubframes(contents: WebContents, options: SubframeOptions): void {
  const guard: Guard = {
    revoked: false,
    pending: new Map(),
    artifacts: new Set(),
    waiters: [],
    poll: null,
  }
  guards.set(contents, guard)
  const timeoutMs = options.commitTimeoutMs ?? COMMIT_TIMEOUT_MS

  const settle = (): void => {
    if (guard.pending.size > 0) return
    if (guard.poll) clearInterval(guard.poll)
    guard.poll = null
    const waiters = guard.waiters
    guard.waiters = []
    for (const resolve of waiters) resolve()
  }
  const release = (id: number): void => {
    clearTimeout(guard.pending.get(id))
    guard.pending.delete(id)
    settle()
  }
  const forget = (): void => {
    for (const timer of guard.pending.values()) clearTimeout(timer)
    guard.pending.clear()
    guard.artifacts.clear()
    settle()
  }
  const revoke = (cause: string): void => {
    if (!guard.revoked) {
      guard.revoked = true
      log.warn(`Refusing IPC and permissions from window ${contents.id} until it reloads: ${cause}`)
      options.onRevoked()
    }
    forget()
  }
  const isInPage = (id: number): boolean =>
    !contents.isDestroyed() && contents.mainFrame.frames.some((f) => f.frameTreeNodeId === id)
  const hold = (id: number): void => {
    if (guard.pending.has(id)) return
    guard.pending.set(
      id,
      setTimeout(() => {
        if (isInPage(id)) revoke(`a frame did not load within ${timeoutMs} ms`)
        else release(id)
      }, timeoutMs),
    )
    guard.poll ??= setInterval(() => {
      for (const pending of [...guard.pending.keys()]) if (!isInPage(pending)) release(pending)
    }, REMOVED_POLL_MS)
  }

  contents.on('frame-created', (_, { frame }) => {
    // A frame that is already gone cannot be told apart from a subframe.
    if (frame?.parent === null) return
    if (!frame) return revoke('it created a frame (about:blank)')
    if (guard.revoked) return
    const branch = branchOf(frame)
    if (branch === frame) return hold(frame.frameTreeNodeId)
    if (!guard.artifacts.has(branch.frameTreeNodeId)) revoke('it created a frame in a frame')
  })
  contents.on('did-frame-navigate', (_, url, _code, _status, isMainFrame, processId, routingId) => {
    if (isMainFrame || guard.revoked) return
    const frame = contents.mainFrame.framesInSubtree.find(
      (f) => f.processId === processId && f.routingId === routingId,
    )
    if (!frame) return revoke(`it created a frame (${url || 'about:blank'})`)
    const branch = branchOf(frame)
    const id = branch.frameTreeNodeId
    if (branch !== frame) {
      if (!guard.artifacts.has(id)) revoke(`it created a frame (${url || 'about:blank'})`)
      return
    }
    // By origin, not URL: a page that empties itself with about:blank stays on its own origin.
    if (!options.isOpenedArtifact(originOf(frame))) {
      return revoke(`it created a frame (${url || 'about:blank'})`)
    }
    guard.artifacts.add(id)
    release(id)
  })
  // A new document replaces the frames of the old one; one that still has frames stays refused.
  contents.on('did-navigate', () => {
    if (contents.mainFrame.frames.length > 0) return
    guard.revoked = false
    forget()
  })
  contents.once('destroyed', forget)
}

/** Whether the page in `contents` lost its access through a frame since its main frame loaded. */
export function isRevoked(contents: WebContents): boolean {
  return guards.get(contents)?.revoked ?? false
}

/** Whether a frame of the page has not committed its first document yet. */
export function hasPendingFrame(contents: WebContents): boolean {
  return (guards.get(contents)?.pending.size ?? 0) > 0
}

/** Resolves once no frame of the page is pending, or null when none is now. */
export function framesSettled(contents: WebContents): Promise<void> | null {
  const guard = guards.get(contents)
  if (!guard || guard.pending.size === 0) return null
  return new Promise((resolve) => guard.waiters.push(resolve))
}
