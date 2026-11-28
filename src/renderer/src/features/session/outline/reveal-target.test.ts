import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadEntry, ThreadState } from '@shared/thread'

const { scrollToMessageMock, loadThroughMock } = vi.hoisted(() => {
  if (typeof globalThis.window === 'undefined') {
    Object.assign(globalThis, {
      window: {
        kettu: { platform: 'darwin' },
        addEventListener() {},
        removeEventListener() {},
      },
    })
  }
  if (typeof globalThis.CSS === 'undefined') {
    Object.assign(globalThis, { CSS: { escape: (value: string) => value } })
  }
  return {
    scrollToMessageMock: vi.fn(),
    loadThroughMock: vi.fn<(sessionId: string, pos: number) => Promise<boolean>>(),
  }
})

vi.mock('@renderer/components/ui/message-scroller', () => ({
  useMessageScroller: () => ({ scrollToMessage: scrollToMessageMock }),
}))

vi.mock('@renderer/stores/settings', () => ({
  prefersReducedMotion: () => true,
}))

vi.mock('@renderer/stores/threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/stores/threads')>()
  return {
    ...actual,
    loadThrough: (sessionId: string, pos: number) => loadThroughMock(sessionId, pos),
  }
})

import { revealMessage, useRevealStore } from '@renderer/stores/reveal'
import { useThreadsStore } from '@renderer/stores/threads'
import { RevealTarget } from './reveal-target'

interface FakeElement {
  nodeType: number
  nodeName: string
  tagName: string
  dataset: Record<string, string>
  childNodes: FakeElement[]
  parentNode: FakeElement | null
  ownerDocument: FakeDocument | null
  style: Record<string, string>
  addEventListener(): void
  removeEventListener(): void
  appendChild(child: FakeElement): FakeElement
  insertBefore(child: FakeElement, ref: FakeElement | null): FakeElement
  removeChild(child: FakeElement): FakeElement
  setAttribute(): void
  removeAttribute(): void
  getBoundingClientRect(): { top: number }
  querySelector(selector: string): FakeElement | null
}

interface FakeDocument {
  nodeType: number
  nodeName: string
  body: FakeElement
  defaultView: unknown
  createElement(tag: string): FakeElement
  createTextNode(text: string): FakeElement
  createComment(text: string): FakeElement
  addEventListener(): void
  removeEventListener(): void
}

function makeFakeDom() {
  const elementsByMessageId = new Map<string, FakeElement>()
  const makeEl = (tag: string, ownerDocument: FakeDocument | null): FakeElement => ({
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    dataset: {},
    childNodes: [],
    parentNode: null,
    ownerDocument,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      child.parentNode = this
      this.childNodes.push(child)
      return child
    },
    insertBefore(child, ref) {
      child.parentNode = this
      if (!ref) this.childNodes.push(child)
      else {
        const idx = this.childNodes.indexOf(ref)
        if (idx < 0) this.childNodes.push(child)
        else this.childNodes.splice(idx, 0, child)
      }
      return child
    },
    removeChild(child) {
      const idx = this.childNodes.indexOf(child)
      if (idx >= 0) this.childNodes.splice(idx, 1)
      child.parentNode = null
      return child
    },
    setAttribute() {},
    removeAttribute() {},
    getBoundingClientRect: () => ({ top: 0 }),
    querySelector(selector: string) {
      const match = /\[data-message-id="([^"]+)"\]/.exec(selector)
      return match ? (elementsByMessageId.get(match[1]!) ?? null) : null
    },
  })

  const doc: FakeDocument = {
    nodeType: 9,
    nodeName: '#document',
    body: null as unknown as FakeElement,
    defaultView: null,
    createElement(tag: string) {
      return makeEl(tag, doc)
    },
    createTextNode() {
      return makeEl('#text', doc)
    },
    createComment() {
      return makeEl('#comment', doc)
    },
    addEventListener() {},
    removeEventListener() {},
  }
  doc.body = makeEl('body', doc)
  const win = {
    document: doc,
    navigator: { userAgent: 'vitest-node' },
    HTMLElement: FakeElementStub,
    Element: FakeElementStub,
    Node: FakeElementStub,
    Document: FakeElementStub,
    HTMLIFrameElement: FakeElementStub,
    getComputedStyle: () => ({ paddingTop: '0' }),
    addEventListener() {},
    removeEventListener() {},
    kettu: { platform: 'darwin' },
  }
  doc.defaultView = win
  return { doc, win, elementsByMessageId, makeEl }
}

function installDom(doc: FakeDocument, win: Record<string, unknown>): void {
  Object.assign(globalThis, {
    window: win,
    document: doc,
    getComputedStyle: win.getComputedStyle,
    HTMLElement: FakeElementStub,
    Element: FakeElementStub,
    Node: FakeElementStub,
    Document: FakeElementStub,
    HTMLIFrameElement: FakeElementStub,
  })
}

function makeThreadState(entryIds: string[]): ThreadState {
  const byId: Record<string, ThreadEntry> = {}
  for (const id of entryIds) {
    byId[id] = { kind: 'user', id, content: [{ type: 'text', text: id }] }
  }
  return {
    session: {} as ThreadState['session'],
    order: entryIds,
    byId,
  }
}

async function flushEffects(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10))
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

class FakeElementStub {}

const savedGlobals: Record<string, unknown> = {}
const GLOBAL_KEYS = [
  'window',
  'document',
  'getComputedStyle',
  'HTMLElement',
  'Element',
  'Node',
  'Document',
  'HTMLIFrameElement',
] as const
const roots: Root[] = []

beforeEach(() => {
  scrollToMessageMock.mockReset()
  loadThroughMock.mockReset()
  useRevealStore.setState({ target: null })
  useThreadsStore.setState({ replicas: {} })
  for (const key of GLOBAL_KEYS) {
    savedGlobals[key] = (globalThis as Record<string, unknown>)[key]
  }
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    flushSync(() => root.unmount())
  }
  for (const key of GLOBAL_KEYS) {
    const prev = savedGlobals[key]
    if (prev === undefined) delete (globalThis as Record<string, unknown>)[key]
    else (globalThis as Record<string, unknown>)[key] = prev
  }
})

describe('RevealTarget direct round jump', () => {
  it('waits until an async child thread loads, then reveals, scrolls, and marks the target round', async () => {
    const { doc, win, elementsByMessageId, makeEl } = makeFakeDom()
    installDom(doc, win)
    const messageEl = makeEl('div', doc)
    elementsByMessageId.set('e5', messageEl)

    const viewport = { current: makeEl('div', doc) as unknown as HTMLDivElement }
    const content = { current: makeEl('div', doc) as unknown as HTMLDivElement }
    const revealSpy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const holdSpy = vi.fn()

    // Child session has not finished loading its initial snapshot yet.
    useThreadsStore.setState({
      replicas: {
        'child-1': {
          state: null,
          seq: 0,
          status: 'loading',
          error: null,
          older: null,
          loadingOlder: false,
          olderFailure: null,
          plan: null,
        },
      },
    })
    revealMessage({ sessionId: 'child-1', entryId: 'e5', pos: 4 })

    const container = doc.createElement('div')
    const root = createRoot(container as unknown as Element)
    roots.push(root)
    flushSync(() => {
      root.render(
        createElement(RevealTarget, {
          sessionId: 'child-1',
          viewport,
          content,
          jumps: { reveal: revealSpy, hold: holdSpy },
        }),
      )
    })

    // Still loading: target stays pending and no jump runs yet.
    expect(revealSpy).not.toHaveBeenCalled()
    expect(useRevealStore.getState().target?.entryId).toBe('e5')

    // Initial snapshot arrives with the target round entry.
    flushSync(() => {
      useThreadsStore.setState({
        replicas: {
          'child-1': {
            state: makeThreadState(['e1', 'e5']),
            seq: 1,
            status: 'ready',
            error: null,
            older: null,
            loadingOlder: false,
            olderFailure: null,
            plan: null,
          },
        },
      })
    })
    await flushEffects()

    expect(useRevealStore.getState().target).toBeNull()
    expect(loadThroughMock).not.toHaveBeenCalled()
    expect(revealSpy).toHaveBeenCalledWith('e5')
    expect(scrollToMessageMock).toHaveBeenCalledWith('e5', { align: 'start', behavior: 'auto' })
    expect(messageEl.dataset.found).toBe('')
  })

  it('loads older pages back to pos (and falls back to 0 if shifted) before revealing the round', async () => {
    const { doc, win, elementsByMessageId, makeEl } = makeFakeDom()
    installDom(doc, win)
    const messageEl = makeEl('div', doc)
    elementsByMessageId.set('e1', messageEl)

    const viewport = { current: makeEl('div', doc) as unknown as HTMLDivElement }
    const content = { current: makeEl('div', doc) as unknown as HTMLDivElement }
    const revealSpy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const holdSpy = vi.fn()

    // Initial page holds only newer round `e9`; `e1` lies earlier than the recorded pos `4`.
    useThreadsStore.setState({
      replicas: {
        'child-1': {
          state: makeThreadState(['e9']),
          seq: 1,
          status: 'ready',
          error: null,
          older: 8,
          loadingOlder: false,
          olderFailure: null,
          plan: null,
        },
      },
    })
    loadThroughMock.mockImplementation(async (sessionId, pos) => {
      if (pos === 4) {
        useThreadsStore.setState({
          replicas: {
            [sessionId]: {
              state: makeThreadState(['e5', 'e9']),
              seq: 1,
              status: 'ready',
              error: null,
              older: 4,
              loadingOlder: false,
              olderFailure: null,
              plan: null,
            },
          },
        })
        return true
      }
      if (pos === 0) {
        useThreadsStore.setState({
          replicas: {
            [sessionId]: {
              state: makeThreadState(['e1', 'e5', 'e9']),
              seq: 1,
              status: 'ready',
              error: null,
              older: null,
              loadingOlder: false,
              olderFailure: null,
              plan: null,
            },
          },
        })
        return true
      }
      return false
    })

    revealMessage({ sessionId: 'child-1', entryId: 'e1', pos: 4 })

    const container = doc.createElement('div')
    const root = createRoot(container as unknown as Element)
    roots.push(root)
    flushSync(() => {
      root.render(
        createElement(RevealTarget, {
          sessionId: 'child-1',
          viewport,
          content,
          jumps: { reveal: revealSpy, hold: holdSpy },
        }),
      )
    })
    await flushEffects()

    expect(loadThroughMock.mock.calls).toEqual([
      ['child-1', 4],
      ['child-1', 0],
    ])
    expect(revealSpy).toHaveBeenCalledWith('e1')
    expect(scrollToMessageMock).toHaveBeenCalledWith('e1', { align: 'start', behavior: 'auto' })
    expect(messageEl.dataset.found).toBe('')
  })

  it('falls back cleanly without hanging reveal when the target round entry no longer exists', async () => {
    const { doc, win, makeEl } = makeFakeDom()
    installDom(doc, win)

    const viewport = { current: makeEl('div', doc) as unknown as HTMLDivElement }
    const content = { current: makeEl('div', doc) as unknown as HTMLDivElement }
    const revealSpy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const holdSpy = vi.fn()

    useThreadsStore.setState({
      replicas: {
        'child-1': {
          state: makeThreadState(['e1']),
          seq: 1,
          status: 'ready',
          error: null,
          older: null,
          loadingOlder: false,
          olderFailure: null,
          plan: null,
        },
      },
    })
    loadThroughMock.mockResolvedValue(true)
    revealMessage({ sessionId: 'child-1', entryId: 'e99', pos: 12 })

    const container = doc.createElement('div')
    const root = createRoot(container as unknown as Element)
    roots.push(root)
    flushSync(() => {
      root.render(
        createElement(RevealTarget, {
          sessionId: 'child-1',
          viewport,
          content,
          jumps: { reveal: revealSpy, hold: holdSpy },
        }),
      )
    })
    await flushEffects()

    expect(revealSpy).not.toHaveBeenCalled()
    expect(scrollToMessageMock).not.toHaveBeenCalled()
    expect(holdSpy).not.toHaveBeenCalled()
  })
})
