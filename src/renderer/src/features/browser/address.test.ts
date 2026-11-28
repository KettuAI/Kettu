import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addressText, copiedAddress, normalizeAddress } from './address'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@renderer/features/shell/panel-button', () => ({
  PaneIcon: () => createElement('span', { 'data-icon': 'true' }),
}))

import { AddressField } from './address-field'

interface FakeEvent {
  type: string
  target?: FakeNode
  currentTarget?: FakeNode
  bubbles?: boolean
  defaultPrevented: boolean
  clipboardData?: { setData: (type: string, value: string) => void }
  preventDefault(): void
  stopPropagation(): void
}

interface FakeNode {
  nodeType: number
  nodeName: string
  tagName?: string
  namespaceURI?: string
  nodeValue?: string
  value: string
  defaultValue: string
  selectionStart: number | null
  selectionEnd: number | null
  scrollLeft: number
  childNodes: FakeNode[]
  parentNode: FakeNode | null
  ownerDocument: FakeDocument | null
  style: Record<string, string>
  attributes: Map<string, string>
  listeners: Map<string, Set<(event: FakeEvent) => void>>
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  getAttribute(name: string): string | null
  appendChild(child: FakeNode): FakeNode
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode
  removeChild(child: FakeNode): FakeNode
  addEventListener(type: string, fn: (event: FakeEvent) => void): void
  removeEventListener(type: string, fn: (event: FakeEvent) => void): void
  dispatchEvent(event: FakeEvent): boolean
  select(): void
  blur(): void
  readonly firstChild: FakeNode | null
  readonly lastChild: FakeNode | null
  [key: string]: unknown
}

interface FakeDocument {
  nodeType: number
  nodeName: string
  documentElement: FakeNode
  body: FakeNode
  defaultView: FakeWindow
  createElement(tag: string): FakeNode
  createElementNS(ns: string, tag: string): FakeNode
  createTextNode(text: string): FakeNode
  createComment(text: string): FakeNode
  addEventListener(type: string, fn: (event: FakeEvent) => void): void
  removeEventListener(type: string, fn: (event: FakeEvent) => void): void
}

interface FakeWindow {
  document: FakeDocument
  navigator: { userAgent: string }
  HTMLElement: typeof FakeElementBase
  SVGElement: typeof FakeElementBase
  Element: typeof FakeElementBase
  Node: typeof FakeNodeBase
  Document: typeof FakeDocumentBase
  HTMLIFrameElement: typeof FakeElementBase
  addEventListener(type: string, fn: (event: FakeEvent) => void): void
  removeEventListener(type: string, fn: (event: FakeEvent) => void): void
}

class FakeNodeBase {
  static ELEMENT_NODE = 1
  static TEXT_NODE = 3
  static COMMENT_NODE = 8
  static DOCUMENT_NODE = 9
}
class FakeElementBase extends FakeNodeBase {}
class FakeDocumentBase extends FakeNodeBase {}

function createFakeDom(): { window: FakeWindow; document: FakeDocument; container: FakeNode } {
  const makeNode = (
    nodeType: number,
    nodeName: string,
    owner: FakeDocument | null,
    tagName?: string,
    namespaceURI?: string,
  ): FakeNode => {
    const childNodes: FakeNode[] = []
    const attributes = new Map<string, string>()
    const listeners = new Map<string, Set<(event: FakeEvent) => void>>()
    const node: FakeNode = {
      nodeType,
      nodeName,
      ...(tagName ? { tagName } : {}),
      ...(namespaceURI ? { namespaceURI } : {}),
      value: '',
      defaultValue: '',
      selectionStart: 0,
      selectionEnd: 0,
      scrollLeft: 0,
      childNodes,
      parentNode: null,
      ownerDocument: owner,
      style: {},
      attributes,
      listeners,
      setAttribute(name, value) {
        attributes.set(name, String(value))
      },
      removeAttribute(name) {
        attributes.delete(name)
      },
      getAttribute(name) {
        return attributes.get(name) ?? null
      },
      appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child)
        child.parentNode = node
        childNodes.push(child)
        return child
      },
      insertBefore(child, ref) {
        if (child.parentNode) child.parentNode.removeChild(child)
        child.parentNode = node
        if (!ref) {
          childNodes.push(child)
          return child
        }
        const idx = childNodes.indexOf(ref)
        if (idx >= 0) childNodes.splice(idx, 0, child)
        else childNodes.push(child)
        return child
      },
      removeChild(child) {
        const idx = childNodes.indexOf(child)
        if (idx >= 0) {
          childNodes.splice(idx, 1)
          child.parentNode = null
        }
        return child
      },
      addEventListener(type, fn) {
        let set = listeners.get(type)
        if (!set) {
          set = new Set()
          listeners.set(type, set)
        }
        set.add(fn)
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn)
      },
      dispatchEvent(event) {
        event.target = node
        let current: FakeNode | null = node
        let stopped = false
        const baseStop = event.stopPropagation
        event.stopPropagation = () => {
          stopped = true
          baseStop()
        }
        while (current && !stopped) {
          event.currentTarget = current
          for (const listener of current.listeners.get(event.type) ?? []) {
            listener(event)
          }
          if (!event.bubbles) break
          current = current.parentNode
        }
        return !event.defaultPrevented
      },
      select() {
        node.selectionStart = 0
        node.selectionEnd = node.value.length
      },
      blur() {},
      get firstChild() {
        return childNodes[0] ?? null
      },
      get lastChild() {
        return childNodes[childNodes.length - 1] ?? null
      },
    }
    return node
  }

  const fakeDoc: FakeDocument = {
    nodeType: 9,
    nodeName: '#document',
    documentElement: null as unknown as FakeNode,
    body: null as unknown as FakeNode,
    defaultView: null as unknown as FakeWindow,
    createElement(tag) {
      return makeNode(
        1,
        tag.toUpperCase(),
        fakeDoc,
        tag.toUpperCase(),
        'http://www.w3.org/1999/xhtml',
      )
    },
    createElementNS(ns, tag) {
      return makeNode(1, tag, fakeDoc, tag, ns)
    },
    createTextNode(text) {
      const t = makeNode(3, '#text', fakeDoc)
      t.nodeValue = text
      return t
    },
    createComment(text) {
      const c = makeNode(8, '#comment', fakeDoc)
      c.nodeValue = text
      return c
    },
    addEventListener() {},
    removeEventListener() {},
  }

  const fakeWin: FakeWindow = {
    document: fakeDoc,
    navigator: { userAgent: 'vitest-node' },
    HTMLElement: FakeElementBase,
    SVGElement: FakeElementBase,
    Element: FakeElementBase,
    Node: FakeNodeBase,
    Document: FakeDocumentBase,
    HTMLIFrameElement: FakeElementBase,
    addEventListener() {},
    removeEventListener() {},
  }

  fakeDoc.defaultView = fakeWin
  fakeDoc.documentElement = fakeDoc.createElement('html')
  fakeDoc.body = fakeDoc.createElement('body')
  fakeDoc.documentElement.appendChild(fakeDoc.body)
  const container = fakeDoc.createElement('div')
  fakeDoc.body.appendChild(container)
  return { window: fakeWin, document: fakeDoc, container }
}

function findInput(root: FakeNode): FakeNode | null {
  if (root.tagName === 'INPUT') return root
  for (const child of root.childNodes) {
    const found = findInput(child)
    if (found) return found
  }
  return null
}

function dispatchCopy(input: FakeNode): { copied: string | undefined; defaultPrevented: boolean } {
  const data = new Map<string, string>()
  const event: FakeEvent = {
    type: 'copy',
    bubbles: true,
    defaultPrevented: false,
    clipboardData: {
      setData: (type, value) => data.set(type, value),
    },
    preventDefault() {
      event.defaultPrevented = true
    },
    stopPropagation() {},
  }
  input.dispatchEvent(event)
  return { copied: data.get('text/plain'), defaultPrevented: event.defaultPrevented }
}

describe('copiedAddress', () => {
  it('restores https:// on full selection of an https page', () => {
    const pageUrl = 'https://github.com/KettuAI/Kettu/issues?page=2#top'
    const shown = addressText(pageUrl)!
    expect(copiedAddress(shown, 0, shown.length, pageUrl)).toBe(pageUrl)

    const rootUrl = 'https://example.com/'
    const rootShown = addressText(rootUrl)!
    expect(rootShown).toBe('example.com/')
    expect(copiedAddress(rootShown, 0, rootShown.length, rootUrl)).toBe('https://example.com/')
  })

  it('preserves http:// for explicit http public and local pages', () => {
    const publicHttp = 'http://example.com/docs/guide?a=1#s2'
    const publicShown = addressText(publicHttp)!
    expect(copiedAddress(publicShown, 0, publicShown.length, publicHttp)).toBe(publicHttp)

    const localHttp = 'http://localhost:5173/foo'
    const localShown = addressText(localHttp)!
    expect(copiedAddress(localShown, 0, localShown.length, localHttp)).toBe(localHttp)

    const localRoot = 'http://localhost:5173'
    const localRootShown = addressText(localRoot)!
    expect(localRootShown).toBe('localhost:5173/')
    expect(copiedAddress(localRootShown, 0, localRootShown.length, localRoot)).toBe(
      'http://localhost:5173/',
    )

    const ipv6Local = 'http://[::1]:5173/status'
    const ipv6Shown = addressText(ipv6Local)!
    expect(copiedAddress(ipv6Shown, 0, ipv6Shown.length, ipv6Local)).toBe(ipv6Local)
  })

  it('preserves https:// for local dev hosts served over https', () => {
    const localHttps = 'https://localhost:8443/app'
    const shown = addressText(localHttps)!
    expect(copiedAddress(shown, 0, shown.length, localHttps)).toBe(localHttps)
  })

  it('restores the page scheme when selecting a prefix from index 0 that includes the full host', () => {
    const pageUrl = 'https://github.com/KettuAI/Kettu/issues'
    const shown = addressText(pageUrl)!

    expect(copiedAddress(shown, 0, 'github.com'.length, pageUrl)).toBe('https://github.com')
    expect(copiedAddress(shown, 0, 'github.com/'.length, pageUrl)).toBe('https://github.com/')
    expect(copiedAddress(shown, 0, 'github.com/KettuAI'.length, pageUrl)).toBe(
      'https://github.com/KettuAI',
    )
    expect(copiedAddress(shown, 0, 'github.com/KettuAI/'.length, pageUrl)).toBe(
      'https://github.com/KettuAI/',
    )

    const httpUrl = 'http://example.com/docs/api?a=1&b=2'
    const httpShown = addressText(httpUrl)!
    expect(copiedAddress(httpShown, 0, 'example.com/docs'.length, httpUrl)).toBe(
      'http://example.com/docs',
    )
    expect(copiedAddress(httpShown, 0, 'example.com/docs/api?a=1'.length, httpUrl)).toBe(
      'http://example.com/docs/api?a=1',
    )

    const localUrl = 'http://localhost:5173/foo/bar'
    const localShown = addressText(localUrl)!
    expect(copiedAddress(localShown, 0, 'localhost:5173'.length, localUrl)).toBe(
      'http://localhost:5173',
    )
  })

  it('leaves native copy untouched for partial host, middle, tail, or empty selections', () => {
    const pageUrl = 'https://github.com/KettuAI/Kettu/issues'
    const shown = addressText(pageUrl)!

    expect(copiedAddress(shown, 0, 0, pageUrl)).toBeNull()
    expect(copiedAddress(shown, 0, 'github'.length, pageUrl)).toBeNull()
    expect(copiedAddress(shown, 0, 'github.c'.length, pageUrl)).toBeNull()
    expect(copiedAddress(shown, 'github.com'.length, shown.length, pageUrl)).toBeNull()
    expect(copiedAddress(shown, 'github.com/KettuAI'.length, shown.length, pageUrl)).toBeNull()
    expect(copiedAddress(shown, 7, 10, pageUrl)).toBeNull()

    const localUrl = 'http://localhost:5173/foo'
    const localShown = addressText(localUrl)!
    expect(copiedAddress(localShown, 0, 'localhost'.length, localUrl)).toBeNull()
    expect(copiedAddress(localShown, 0, 'localhost:51'.length, localUrl)).toBeNull()
  })

  it('leaves native copy untouched when the selected text already has a scheme', () => {
    for (const text of [
      'https://foo.com/bar',
      'http://localhost:5173/foo',
      'about:blank',
      'file:///etc/hosts',
      'mailto:user@example.com',
      'javascript:void(0)',
    ]) {
      expect(
        copiedAddress(text, 0, text.length, 'https://github.com/KettuAI/Kettu'),
        text,
      ).toBeNull()
    }
  })

  it('restores scheme for manually edited scheme-less URLs when fully selected', () => {
    expect(copiedAddress('example.com/docs', 0, 16, 'http://localhost:5173/')).toBe(
      'https://example.com/docs',
    )
    expect(copiedAddress('example.com', 0, 11, null)).toBe('https://example.com/')
    expect(copiedAddress('localhost:5173/dev', 0, 18, 'https://github.com/')).toBe(
      'http://localhost:5173/dev',
    )
    expect(copiedAddress('localhost:5173', 0, 14, null)).toBe('http://localhost:5173/')
    expect(copiedAddress('127.0.0.1:8080/health', 0, 21, null)).toBe('http://127.0.0.1:8080/health')
    expect(copiedAddress('[::1]:5173/api', 0, 14, null)).toBe('http://[::1]:5173/api')
    expect(copiedAddress('app.localhost:3000/v1', 0, 21, null)).toBe('http://app.localhost:3000/v1')
    expect(copiedAddress('192.168.1.20:4173/status', 0, 24, null)).toBe(
      normalizeAddress('192.168.1.20:4173/status'),
    )
    expect(copiedAddress('en.wikipedia.org/wiki/Help:Contents', 0, 35, null)).toBe(
      'https://en.wikipedia.org/wiki/Help:Contents',
    )
    expect(copiedAddress('example.com/b', 0, 13, 'http://example.com/a')).toBe(
      'http://example.com/b',
    )
    expect(copiedAddress('localhost:8443/b', 0, 16, 'https://localhost:8443/a')).toBe(
      'https://localhost:8443/b',
    )
  })

  it('does not rewrite partial selections, search queries, plain words, or non-URLs when edited', () => {
    const edited = 'example.com/docs'
    expect(copiedAddress(edited, 0, 'example.com'.length, 'https://github.com/')).toBeNull()

    for (const text of [
      '',
      '   ',
      'github',
      'hello world',
      'foo/bar',
      '/Users/dev/project',
      '//example.com/foo',
      './local',
      '12345',
      '3.14',
      '1.2.3',
      'v1.2.3',
      '01.2.3.4:80',
      'user@example.com',
      'example.',
      '.example.com',
      'example.com ',
      'example.com:',
      'about:blank',
    ]) {
      expect(copiedAddress(text, 0, text.length, 'https://github.com/'), text).toBeNull()
    }

    expect(copiedAddress('', 0, 0, 'about:blank')).toBeNull()
    expect(copiedAddress('', 0, 0, '')).toBeNull()
    expect(copiedAddress('', 0, 0, null)).toBeNull()
  })
})

describe('AddressField onCopy', () => {
  let root: Root | null = null
  let container: FakeNode

  beforeEach(() => {
    const dom = createFakeDom()
    container = dom.container
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.document)
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
    vi.stubGlobal('SVGElement', dom.window.SVGElement)
    vi.stubGlobal('Element', dom.window.Element)
    vi.stubGlobal('Node', dom.window.Node)
  })

  afterEach(async () => {
    if (root) {
      const mounted = root
      flushSync(() => mounted.unmount())
      root = null
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    vi.unstubAllGlobals()
  })

  it('writes the full URL with its actual scheme to clipboardData on focus-and-copy', () => {
    const url = 'http://localhost:5173/dashboard?tab=logs'
    root = createRoot(container as unknown as Element)
    flushSync(() => {
      root!.render(createElement(AddressField, { url, onNavigate: vi.fn() }))
    })

    const input = findInput(container)!
    expect(input.value).toBe('localhost:5173/dashboard?tab=logs')

    const focusEvent: FakeEvent = {
      type: 'focusin',
      bubbles: true,
      defaultPrevented: false,
      preventDefault() {
        focusEvent.defaultPrevented = true
      },
      stopPropagation() {},
    }
    flushSync(() => {
      input.dispatchEvent(focusEvent)
    })
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)

    expect(dispatchCopy(input)).toEqual({
      copied: url,
      defaultPrevented: true,
    })

    input.selectionStart = 0
    input.selectionEnd = 'localhost:5173'.length
    expect(dispatchCopy(input)).toEqual({
      copied: 'http://localhost:5173',
      defaultPrevented: true,
    })
  })

  it('preserves explicit https:// and http:// schemes for public URLs on copy', () => {
    root = createRoot(container as unknown as Element)
    const httpsUrl = 'https://github.com/KettuAI/Kettu/issues'
    flushSync(() => {
      root!.render(createElement(AddressField, { url: httpsUrl, onNavigate: vi.fn() }))
    })
    let input = findInput(container)!
    input.select()
    expect(dispatchCopy(input)).toEqual({
      copied: httpsUrl,
      defaultPrevented: true,
    })

    const httpUrl = 'http://example.com/docs'
    flushSync(() => {
      root!.render(createElement(AddressField, { url: httpUrl, onNavigate: vi.fn() }))
    })
    input = findInput(container)!
    input.select()
    expect(dispatchCopy(input)).toEqual({
      copied: httpUrl,
      defaultPrevented: true,
    })
  })

  it('does not intercept copy when selection does not cover the full host', () => {
    const url = 'https://github.com/KettuAI/Kettu/issues'
    root = createRoot(container as unknown as Element)
    flushSync(() => {
      root!.render(createElement(AddressField, { url, onNavigate: vi.fn() }))
    })

    const input = findInput(container)!
    input.selectionStart = 0
    input.selectionEnd = 'github'.length
    expect(dispatchCopy(input)).toEqual({
      copied: undefined,
      defaultPrevented: false,
    })

    input.selectionStart = 'github.com'.length
    input.selectionEnd = input.value.length
    expect(dispatchCopy(input)).toEqual({
      copied: undefined,
      defaultPrevented: false,
    })
  })
})
