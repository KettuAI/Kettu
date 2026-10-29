import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recentLogRecords } from './log'
import { framesSettled, hasPendingFrame, isRevoked, watchSubframes } from './subframes'

const ARTIFACT = 'kettu-artifact://0123456789abcdef0123456789/'
const OTHER = 'kettu-artifact://ffffffffffffffffffffffffff/'

let nextId = 1

class FakeFrame {
  frames: FakeFrame[] = []
  /** The committed document's origin, as Chromium reports it; an empty document inherits one. */
  origin = 'null'
  readonly frameTreeNodeId = nextId++
  readonly processId = 1
  readonly routingId = this.frameTreeNodeId

  constructor(
    readonly parent: FakeFrame | null,
    public url = '',
  ) {}

  get framesInSubtree(): FakeFrame[] {
    return [this, ...this.frames.flatMap((child) => child.framesInSubtree)]
  }
}

class FakeContents extends EventEmitter {
  id = nextId++
  mainFrame = new FakeFrame(null, 'file:///app/index.html')

  isDestroyed(): boolean {
    return false
  }

  /** A frame the page adds, which Electron reports before its first document commits. */
  addFrame(parent: FakeFrame = this.mainFrame): FakeFrame {
    const added = new FakeFrame(parent)
    parent.frames.push(added)
    this.emit('frame-created', {}, { frame: added })
    return added
  }

  commit(at: FakeFrame, url: string, origin = originFor(url)): void {
    at.url = url
    at.origin = origin
    this.emit('did-frame-navigate', {}, url, 200, 'OK', false, at.processId, at.routingId)
  }

  remove(at: FakeFrame): void {
    if (at.parent) at.parent.frames = at.parent.frames.filter((f) => f !== at)
  }

  loadNewDocument(frames: FakeFrame[] = []): void {
    this.mainFrame = new FakeFrame(null, 'file:///app/index.html')
    this.mainFrame.frames = frames
    this.emit('did-navigate', {}, this.mainFrame.url, -1, '')
  }
}

function originFor(url: string): string {
  if (url.startsWith('kettu-artifact://')) return url.slice(0, url.indexOf('/', 21))
  if (url.startsWith('file:') || url.startsWith('about:')) return 'file://'
  return URL.parse(url)?.origin ?? 'null'
}

function watched(opened: string[] = [ARTIFACT], commitTimeoutMs = 5_000) {
  const contents = new FakeContents()
  const revoked = vi.fn()
  const web = contents as unknown as WebContents
  watchSubframes(web, {
    isOpenedArtifact: (origin) => opened.some((url) => url.startsWith(origin) && origin !== ''),
    onRevoked: revoked,
    commitTimeoutMs,
  })
  return {
    contents,
    revoked,
    isRevoked: () => isRevoked(web),
    pending: () => hasPendingFrame(web),
    settled: () => framesSettled(web),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('watchSubframes', () => {
  it('trusts a page that has only its main frame', () => {
    const page = watched()
    page.contents.emit('frame-created', {}, { frame: page.contents.mainFrame })
    page.contents.emit('did-frame-navigate', {}, 'file:///app/index.html', 200, '', true, 1, 1)
    page.contents.loadNewDocument()
    expect(page.isRevoked()).toBe(false)
    expect(page.pending()).toBe(false)
    expect(page.settled()).toBeNull()
    expect(page.revoked).not.toHaveBeenCalled()
  })

  it('holds a new frame as pending, then keeps trusting one that commits on an opened artifact', async () => {
    const page = watched()
    const added = page.contents.addFrame()
    expect(page.pending()).toBe(true)
    const settled = page.settled()
    expect(settled).not.toBeNull()
    page.contents.commit(added, `${ARTIFACT}?page=1.2`)
    await settled
    expect(page.pending()).toBe(false)
    expect(page.isRevoked()).toBe(false)
    expect(page.revoked).not.toHaveBeenCalled()
  })

  it("lets an artifact's frame make frames of its own and navigate them", () => {
    const page = watched()
    const added = page.contents.addFrame()
    page.contents.commit(added, ARTIFACT)
    const inner = page.contents.addFrame(added)
    page.contents.commit(inner, 'about:srcdoc')
    page.contents.commit(added, `${ARTIFACT}?v=2`)
    expect(page.isRevoked()).toBe(false)
  })

  it.each([
    ["the app's own origin", 'file:///app/index.html'],
    ['about:srcdoc', 'about:srcdoc'],
    ['about:blank', 'about:blank'],
    ['blob:', 'blob:file:///7d1c'],
    ['data:', 'data:text/html,hi'],
    ['an artifact origin main did not open', OTHER],
  ])('revokes the page for a frame whose first document is on %s, once', async (_, url) => {
    const page = watched()
    const before = recentLogRecords().length
    const added = page.contents.addFrame()
    const settled = page.settled()
    page.contents.commit(added, url)
    await settled
    expect(page.isRevoked()).toBe(true)
    expect(page.revoked).toHaveBeenCalledTimes(1)
    page.contents.commit(page.contents.addFrame(), ARTIFACT)
    expect(page.revoked).toHaveBeenCalledTimes(1)
    const logged = recentLogRecords()
      .slice(before)
      .filter((record) => record.message.includes(`window ${page.contents.id}`))
    expect(logged).toHaveLength(1)
    expect(logged[0]?.level).toBe('warn')
  })

  it('keeps trusting an artifact that empties itself, since its document keeps its origin', () => {
    const page = watched()
    const added = page.contents.addFrame()
    page.contents.commit(added, ARTIFACT)
    page.contents.commit(added, 'about:blank', ARTIFACT.slice(0, -1))
    expect(page.isRevoked()).toBe(false)
  })

  it("revokes the page when an artifact's frame commits on any other origin", () => {
    const page = watched()
    const added = page.contents.addFrame()
    page.contents.commit(added, ARTIFACT)
    page.contents.commit(added, 'https://example.com/')
    expect(page.isRevoked()).toBe(true)
  })

  it('revokes the page for a frame inside a frame that is not an artifact', () => {
    const page = watched()
    const added = page.contents.addFrame()
    page.contents.addFrame(added)
    expect(page.isRevoked()).toBe(true)
  })

  it('revokes the page for a frame that does not commit in time, and lets the held calls go', async () => {
    vi.useFakeTimers()
    const page = watched([ARTIFACT], 5_000)
    page.contents.addFrame()
    const settled = page.settled()
    vi.advanceTimersByTime(4_999)
    expect(page.isRevoked()).toBe(false)
    vi.advanceTimersByTime(1)
    await settled
    expect(page.isRevoked()).toBe(true)
    expect(page.pending()).toBe(false)
  })

  it('forgets a pending frame the page removed before it committed', async () => {
    vi.useFakeTimers()
    const page = watched()
    const added = page.contents.addFrame()
    const settled = page.settled()
    page.contents.remove(added)
    vi.advanceTimersByTime(100)
    await settled
    expect(page.pending()).toBe(false)
    expect(page.isRevoked()).toBe(false)
  })

  it('stops trusting a frame once its origin is closed', () => {
    const opened = [ARTIFACT]
    const page = watched(opened)
    const added = page.contents.addFrame()
    page.contents.commit(added, ARTIFACT)
    opened.length = 0
    page.contents.commit(added, ARTIFACT)
    expect(page.isRevoked()).toBe(true)
  })

  it('counts a frame it cannot see as a subframe', () => {
    const unknown = watched()
    unknown.contents.emit('frame-created', {}, { frame: null })
    expect(unknown.isRevoked()).toBe(true)
    const unseen = watched()
    unseen.contents.emit('did-frame-navigate', {}, 'file:///x.html', 200, '', false, 9, 999)
    expect(unseen.isRevoked()).toBe(true)
  })

  it('keeps refusing after the subframe is removed and after in-page navigation', () => {
    const page = watched()
    const added = page.contents.addFrame()
    page.contents.commit(added, 'about:srcdoc')
    page.contents.remove(added)
    page.contents.emit('did-navigate-in-page', {}, 'file:///app/index.html#/x', true, 1, 1)
    expect(page.isRevoked()).toBe(true)
  })

  it('trusts the page again once the main frame loads a new document', () => {
    const page = watched()
    page.contents.commit(page.contents.addFrame(), 'about:srcdoc')
    page.contents.loadNewDocument()
    expect(page.isRevoked()).toBe(false)
    page.contents.commit(page.contents.addFrame(), 'about:srcdoc')
    expect(page.isRevoked()).toBe(true)
    expect(page.revoked).toHaveBeenCalledTimes(2)
  })

  it('does not trust a new document that already has a subframe', () => {
    const page = watched()
    page.contents.commit(page.contents.addFrame(), 'about:srcdoc')
    page.contents.loadNewDocument([new FakeFrame(null, 'about:blank')])
    expect(page.isRevoked()).toBe(true)
  })

  it('keeps windows apart', () => {
    const framed = watched()
    const plain = watched()
    framed.contents.commit(framed.contents.addFrame(), 'about:srcdoc')
    expect(framed.isRevoked()).toBe(true)
    expect(plain.isRevoked()).toBe(false)
  })

  it('trusts a window it does not watch', () => {
    const web = new FakeContents() as unknown as WebContents
    expect(isRevoked(web)).toBe(false)
    expect(framesSettled(web)).toBeNull()
  })
})
