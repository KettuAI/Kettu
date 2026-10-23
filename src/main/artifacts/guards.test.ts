import { EventEmitter } from 'node:events'
import type { Input, WebContents, WebFrameMain } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactBlockedEvent, ArtifactStoppedEvent, ForwardedKey } from '@shared/ipc'
import {
  forwardedKey,
  guardArtifactFrames,
  mayNavigate,
  mayOpenWindow,
  requestingArtifact,
} from './guards'

const HOST = '0123456789abcdef0123456789'
const ORIGIN = `overbench-artifact://${HOST}`

interface FakeFrame {
  parent: FakeFrame | null
  origin: string
  frames: FakeFrame[]
  frameTreeNodeId: number
  processId: number
  routingId: number
  detached: boolean
}

function frame(parent: FakeFrame | null, origin: string, id: number): FakeFrame {
  return {
    parent,
    origin,
    frames: [],
    frameTreeNodeId: id,
    processId: 1,
    routingId: id,
    detached: false,
  }
}

const main = frame(null, 'file://', 1)
const page = frame(main, ORIGIN, 2)
const inner = frame(page, 'null', 3)
const asFrame = (f: FakeFrame) => f as unknown as WebFrameMain

describe('requestingArtifact', () => {
  it("names the artifact of the frame that asks, or of its nearest artifact's frame", () => {
    expect(requestingArtifact({ frame: asFrame(page) })).toBe(HOST)
    expect(requestingArtifact({ frame: asFrame(inner) })).toBe(HOST)
  })

  it("names a shared worker's artifact by its initiator, since it has no frame", () => {
    expect(requestingArtifact({ initiatorOrigin: ORIGIN, frame: null })).toBe(HOST)
  })

  it("is null for the app's own requests, its frame's first navigation included", () => {
    expect(requestingArtifact({ initiatorOrigin: 'file://', frame: asFrame(main) })).toBeNull()
    const fresh = frame(main, 'file://', 4)
    expect(requestingArtifact({ initiatorOrigin: 'file://', frame: asFrame(fresh) })).toBeNull()
    expect(requestingArtifact({})).toBeNull()
  })

  it('is null for a frame whose document went away', () => {
    const gone = {
      get origin(): string {
        throw new Error('Render frame was disposed')
      },
    }
    expect(requestingArtifact({ frame: gone as unknown as WebFrameMain })).toBeNull()
  })
})

describe('mayNavigate', () => {
  it('keeps a frame on its own origin', () => {
    expect(mayNavigate(HOST, `${ORIGIN}/?v=2`, true)).toBe(true)
    expect(mayNavigate(HOST, 'https://example.com/', true)).toBe(false)
    expect(mayNavigate(HOST, 'overbench-artifact://ffffffffffffffffffffffffff/', false)).toBe(false)
    expect(mayNavigate(HOST, 'data:text/html,x', false)).toBe(false)
  })

  it("lets only the page's own frames take an empty document", () => {
    expect(mayNavigate(HOST, 'about:blank', false)).toBe(true)
    expect(mayNavigate(HOST, 'about:srcdoc', false)).toBe(true)
    expect(mayNavigate(HOST, 'about:blank', true)).toBe(false)
  })
})

function input(key: string, code: string, modifiers: Partial<Input> = {}): Input {
  return {
    type: 'keyDown',
    key,
    code,
    isAutoRepeat: false,
    isComposing: false,
    shift: false,
    control: false,
    alt: false,
    meta: false,
    location: 0,
    modifiers: [],
    ...modifiers,
  } as Input
}

describe('forwardedKey', () => {
  it('passes the shortcut table on Windows and Linux', () => {
    for (const platform of ['win32', 'linux'] as const) {
      for (const [key, code] of [
        ['o', 'KeyO'],
        ['n', 'KeyN'],
        ['b', 'KeyB'],
        [',', 'Comma'],
        ['l', 'KeyL'],
        ['=', 'Equal'],
        ['-', 'Minus'],
        ['0', 'Digit0'],
      ] as const) {
        expect(forwardedKey(input(key, code, { control: true }), platform)).toMatchObject({ key })
      }
      expect(
        forwardedKey(input('{', 'BracketLeft', { control: true, shift: true }), platform),
      ).not.toBeNull()
    }
  })

  it('leaves the menu accelerators to the menu on macOS', () => {
    expect(forwardedKey(input('b', 'KeyB', { meta: true }), 'darwin')).toBeNull()
    expect(forwardedKey(input('=', 'Equal', { meta: true }), 'darwin')).toBeNull()
    expect(forwardedKey(input('l', 'KeyL', { meta: true }), 'darwin')).toMatchObject({ key: 'l' })
    expect(
      forwardedKey(input('}', 'BracketRight', { meta: true, shift: true }), 'darwin'),
    ).not.toBeNull()
  })

  it('passes the terminal toggle on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(forwardedKey(input('`', 'Backquote', { control: true }), platform)).toMatchObject({
        code: 'Backquote',
        ctrlKey: true,
      })
    }
  })

  it("keeps the page's own keys in the page", () => {
    expect(forwardedKey(input('c', 'KeyC', { control: true }), 'win32')).toBeNull()
    expect(forwardedKey(input('b', 'KeyB'), 'win32')).toBeNull()
    expect(forwardedKey(input('b', 'KeyB', { control: true, alt: true }), 'win32')).toBeNull()
    expect(forwardedKey(input('b', 'KeyB', { meta: true }), 'win32')).toBeNull()
    expect(forwardedKey(input('Escape', 'Escape'), 'darwin')).toBeNull()
    expect(forwardedKey(input('b', 'KeyB', { control: true, type: 'keyUp' }), 'win32')).toBeNull()
  })
})

class FakeContents extends EventEmitter {
  mainFrame = frame(null, 'file://', 1)
  focusedFrame: FakeFrame | null = this.mainFrame

  isDestroyed(): boolean {
    return false
  }
}

function guarded(platform: NodeJS.Platform = 'win32') {
  const contents = new FakeContents()
  const blocked: ArtifactBlockedEvent[] = []
  const stopped: ArtifactStoppedEvent[] = []
  const keys: ForwardedKey[] = []
  guardArtifactFrames(contents as unknown as WebContents, {
    platform,
    blocked: (event) => blocked.push(event),
    stopped: (event) => stopped.push(event),
    shortcut: (key) => keys.push(key),
  })
  const child = frame(contents.mainFrame, ORIGIN, 2)
  contents.mainFrame.frames.push(child)
  return { contents, child, blocked, stopped, keys }
}

function navigate(contents: FakeContents, at: FakeFrame, url: string) {
  const preventDefault = vi.fn()
  const details = { url, isMainFrame: at.parent === null, isSameDocument: false, frame: at }
  contents.emit('did-start-navigation', details)
  contents.emit('will-frame-navigate', { ...details, preventDefault })
  return preventDefault
}

afterEach(() => {
  vi.useRealTimers()
})

describe('guardArtifactFrames', () => {
  it('cancels a navigation off its origin and tells the page about an http(s) one', () => {
    const { contents, child, blocked } = guarded()
    expect(navigate(contents, child, `${ORIGIN}/?v=2`)).not.toHaveBeenCalled()
    expect(navigate(contents, child, 'https://example.com/a')).toHaveBeenCalled()
    expect(
      navigate(contents, child, 'overbench-artifact://ffffffffffffffffffffffffff/'),
    ).toHaveBeenCalled()
    expect(navigate(contents, child, 'data:text/html,x')).toHaveBeenCalled()
    const own = frame(child, 'null', 6)
    expect(navigate(contents, own, 'http://example.com/b')).toHaveBeenCalled()
    expect(navigate(contents, own, 'about:blank')).not.toHaveBeenCalled()
    expect(blocked).toEqual([
      { origin: ORIGIN, url: 'https://example.com/a', reload: true },
      { origin: ORIGIN, url: 'http://example.com/b', reload: false },
    ])
  })

  it("leaves the app's own frames and its frame's first navigation alone", () => {
    const { contents } = guarded()
    const fresh = frame(contents.mainFrame, 'file://', 5)
    expect(navigate(contents, fresh, `${ORIGIN}/`)).not.toHaveBeenCalled()
    expect(navigate(contents, contents.mainFrame, 'https://example.com/')).not.toHaveBeenCalled()
  })

  it('passes app shortcuts typed in a page to the app, and nothing else', () => {
    const { contents, child, keys } = guarded('win32')
    const press = (key: string, code: string, modifiers: Partial<Input>) => {
      const event = { preventDefault: vi.fn() }
      contents.emit('before-input-event', event, input(key, code, modifiers))
      return event.preventDefault
    }
    expect(press('b', 'KeyB', { control: true })).not.toHaveBeenCalled()
    contents.focusedFrame = child
    expect(press('b', 'KeyB', { control: true })).toHaveBeenCalled()
    expect(press('c', 'KeyC', { control: true })).not.toHaveBeenCalled()
    expect(keys).toEqual([
      { key: 'b', code: 'KeyB', shiftKey: false, ctrlKey: true, metaKey: false },
    ])
  })

  it('tells the page when the process of a frame it shows stops', () => {
    vi.useFakeTimers()
    const { contents, child, stopped } = guarded()
    contents.emit('did-frame-navigate', {}, `${ORIGIN}/`, 200, 'OK', false, 1, 2)
    vi.advanceTimersByTime(1_000)
    expect(stopped).toEqual([])
    child.detached = true
    vi.advanceTimersByTime(1_000)
    expect(stopped).toEqual([{ origin: ORIGIN }])
    vi.advanceTimersByTime(5_000)
    expect(stopped).toHaveLength(1)
  })

  it('says nothing for a frame the page removed', () => {
    vi.useFakeTimers()
    const { contents, stopped } = guarded()
    contents.emit('did-frame-navigate', {}, `${ORIGIN}/`, 200, 'OK', false, 1, 2)
    contents.mainFrame.frames = []
    vi.advanceTimersByTime(2_000)
    expect(stopped).toEqual([])
  })
})

describe('mayOpenWindow', () => {
  it('opens nothing while a page has focus, and never an artifact', () => {
    const contents = new FakeContents()
    const web = contents as unknown as WebContents
    expect(mayOpenWindow(web, 'https://github.com/')).toBe(true)
    expect(mayOpenWindow(web, `${ORIGIN}/`)).toBe(false)
    contents.focusedFrame = frame(contents.mainFrame, ORIGIN, 2)
    expect(mayOpenWindow(web, 'https://github.com/')).toBe(false)
  })
})
