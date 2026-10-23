import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { recentLogRecords } from './log'
import { hasSubframe, watchSubframes } from './subframes'

interface FakeFrame {
  parent: FakeFrame | null
  url: string
  frames: FakeFrame[]
}

let nextId = 1

class FakeContents extends EventEmitter {
  id = nextId++
  mainFrame: FakeFrame = { parent: null, url: 'file:///app/index.html', frames: [] }

  createFrame(frame: FakeFrame | null): void {
    this.emit('frame-created', {}, { frame })
  }

  addSubframe(url = ''): FakeFrame {
    const frame = { parent: this.mainFrame, url, frames: [] }
    this.mainFrame.frames.push(frame)
    this.createFrame(frame)
    return frame
  }

  loadNewDocument(frames: FakeFrame[] = []): void {
    this.mainFrame = { parent: null, url: 'file:///app/index.html', frames }
    this.emit('did-navigate', {}, this.mainFrame.url, -1, '')
  }
}

function watched(): { contents: FakeContents; found: ReturnType<typeof vi.fn>; has(): boolean } {
  const contents = new FakeContents()
  const found = vi.fn()
  watchSubframes(contents as unknown as WebContents, found)
  return { contents, found, has: () => hasSubframe(contents as unknown as WebContents) }
}

describe('watchSubframes', () => {
  it('trusts a page that has only its main frame', () => {
    const { contents, found, has } = watched()
    contents.createFrame(contents.mainFrame)
    contents.emit('did-frame-navigate', {}, contents.mainFrame.url, -1, '', true, 1, 1)
    contents.loadNewDocument()
    expect(has()).toBe(false)
    expect(found).not.toHaveBeenCalled()
  })

  it('stops trusting a page once it creates a subframe, and reports it once', () => {
    const { contents, found, has } = watched()
    const before = recentLogRecords().length
    contents.addSubframe()
    contents.addSubframe('about:srcdoc')
    expect(has()).toBe(true)
    expect(found).toHaveBeenCalledTimes(1)
    const logged = recentLogRecords()
      .slice(before)
      .filter((record) => record.message.includes(`window ${contents.id}`))
    expect(logged).toHaveLength(1)
    expect(logged[0]?.level).toBe('warn')
    expect(logged[0]?.message).toContain('about:blank')
  })

  it('keeps refusing after the subframe is removed and after in-page navigation', () => {
    const { contents, has } = watched()
    contents.addSubframe()
    contents.mainFrame.frames = []
    contents.emit('did-navigate-in-page', {}, 'file:///app/index.html#/x', true, 1, 1)
    expect(has()).toBe(true)
  })

  it('trusts the page again once the main frame loads a new document', () => {
    const { contents, found, has } = watched()
    contents.addSubframe()
    contents.loadNewDocument()
    expect(has()).toBe(false)
    contents.addSubframe()
    expect(has()).toBe(true)
    expect(found).toHaveBeenCalledTimes(2)
  })

  it('does not trust a new document that already has a subframe', () => {
    const { contents, has } = watched()
    contents.addSubframe()
    contents.loadNewDocument([{ parent: null, url: 'about:blank', frames: [] }])
    expect(has()).toBe(true)
  })

  it('counts a subframe navigation and a frame it cannot see as a subframe', () => {
    const navigated = watched()
    navigated.contents.emit('did-frame-navigate', {}, 'file:///x.html', -1, '', false, 1, 2)
    expect(navigated.has()).toBe(true)
    const unknown = watched()
    unknown.contents.createFrame(null)
    expect(unknown.has()).toBe(true)
  })

  it('keeps windows apart', () => {
    const framed = watched()
    const plain = watched()
    framed.contents.addSubframe()
    expect(framed.has()).toBe(true)
    expect(plain.has()).toBe(false)
  })

  it('trusts a window it does not watch', () => {
    expect(hasSubframe(new FakeContents() as unknown as WebContents)).toBe(false)
  })
})
