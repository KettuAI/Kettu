import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionUiView, SessionSnapshot } from '@shared/thread'
import enSession from '@shared/locales/en/session.json'

const { hostMock } = vi.hoisted(() => {
  const hostMock = vi.fn()
  return { hostMock }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'extensionUi.statusLabel') return enSession.extensionUi.statusLabel
      if (key === 'extensionUi.widgetsLabel') return enSession.extensionUi.widgetsLabel
      return key
    },
  }),
}))

vi.mock('@renderer/lib/host', () => ({
  host: (...args: unknown[]) => hostMock(...args),
  sessionHost: () => null,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

interface FakeNode {
  nodeType: number
  nodeName: string
  tagName?: string
  nodeValue?: string
  childNodes: FakeNode[]
  parentNode: FakeNode | null
  ownerDocument: FakeDocument | null
  style: Record<string, string>
  dataset: Record<string, string>
  attributes: Map<string, string>
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  getAttribute(name: string): string | null
  appendChild(child: FakeNode): FakeNode
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode
  removeChild(child: FakeNode): FakeNode
  addEventListener(): void
  removeEventListener(): void
  readonly firstChild: FakeNode | null
  readonly lastChild: FakeNode | null
  textContent: string
  [key: string]: unknown
}

class FakeDomBase {}

interface FakeWindow {
  document: FakeDocument
  navigator: { userAgent: string }
  HTMLElement: typeof FakeDomBase
  SVGElement: typeof FakeDomBase
  Element: typeof FakeDomBase
  Node: typeof FakeDomBase
  Document: typeof FakeDomBase
  HTMLIFrameElement: typeof FakeDomBase
  ShadowRoot: typeof FakeDomBase
  setTimeout: typeof globalThis.setTimeout
  clearTimeout: typeof globalThis.clearTimeout
  addEventListener(): void
  removeEventListener(): void
}

interface FakeDocument {
  nodeType: number
  nodeName: string
  documentElement: FakeNode
  body: FakeNode
  defaultView: FakeWindow
  createElement(tag: string): FakeNode
  createElementNS(_ns: string, tag: string): FakeNode
  createTextNode(text: string): FakeNode
  createComment(text: string): FakeNode
  addEventListener(): void
  removeEventListener(): void
}

function createFakeDom(): { document: FakeDocument; rootElement: FakeNode } {
  const makeNode = (
    nodeType: number,
    nodeName: string,
    ownerDocument: FakeDocument | null,
  ): FakeNode => {
    const childNodes: FakeNode[] = []
    const attributes = new Map<string, string>()
    const dataset: Record<string, string> = {}
    const node: FakeNode = {
      nodeType,
      nodeName,
      ...(nodeType === 1 ? { tagName: nodeName } : {}),
      childNodes,
      parentNode: null,
      ownerDocument,
      style: {},
      dataset,
      attributes,
      setAttribute(name: string, value: string) {
        attributes.set(name, String(value))
        if (name.startsWith('data-')) {
          const camel = name.slice(5).replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())
          dataset[camel] = String(value)
        }
      },
      removeAttribute(name: string) {
        attributes.delete(name)
      },
      getAttribute(name: string) {
        return attributes.get(name) ?? null
      },
      appendChild(child: FakeNode) {
        if (child.parentNode) child.parentNode.removeChild(child)
        child.parentNode = node
        childNodes.push(child)
        return child
      },
      insertBefore(child: FakeNode, ref: FakeNode | null) {
        if (child.parentNode) child.parentNode.removeChild(child)
        child.parentNode = node
        if (!ref) {
          childNodes.push(child)
          return child
        }
        const at = childNodes.indexOf(ref)
        if (at < 0) childNodes.push(child)
        else childNodes.splice(at, 0, child)
        return child
      },
      removeChild(child: FakeNode) {
        const at = childNodes.indexOf(child)
        if (at >= 0) childNodes.splice(at, 1)
        child.parentNode = null
        return child
      },
      addEventListener() {},
      removeEventListener() {},
      get firstChild() {
        return childNodes[0] ?? null
      },
      get lastChild() {
        return childNodes[childNodes.length - 1] ?? null
      },
      get textContent(): string {
        if (nodeType === 3) return node.nodeValue ?? ''
        return childNodes.map((child) => child.textContent).join('')
      },
      set textContent(value: string) {
        if (nodeType === 3) {
          node.nodeValue = String(value)
          return
        }
        childNodes.length = 0
        if (value !== '') {
          const text = makeNode(3, '#text', ownerDocument)
          text.nodeValue = String(value)
          text.parentNode = node
          childNodes.push(text)
        }
      },
    }
    return node
  }

  const document: FakeDocument = {
    nodeType: 9,
    nodeName: '#document',
    documentElement: null as unknown as FakeNode,
    body: null as unknown as FakeNode,
    defaultView: null as unknown as FakeDocument['defaultView'],
    createElement(tag: string) {
      return makeNode(1, tag.toUpperCase(), document)
    },
    createElementNS(_ns: string, tag: string) {
      return makeNode(1, tag.toUpperCase(), document)
    },
    createTextNode(text: string) {
      const node = makeNode(3, '#text', document)
      node.nodeValue = String(text)
      return node
    },
    createComment(text: string) {
      const node = makeNode(8, '#comment', document)
      node.nodeValue = String(text)
      return node
    },
    addEventListener() {},
    removeEventListener() {},
  }
  document.documentElement = makeNode(1, 'HTML', document)
  document.body = makeNode(1, 'BODY', document)
  document.documentElement.appendChild(document.body)
  document.defaultView = {
    document,
    navigator: { userAgent: 'node' },
    HTMLElement: FakeDomBase,
    SVGElement: FakeDomBase,
    Element: FakeDomBase,
    Node: FakeDomBase,
    Document: FakeDomBase,
    HTMLIFrameElement: FakeDomBase,
    ShadowRoot: FakeDomBase,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  }
  const rootElement = document.createElement('div')
  document.body.appendChild(rootElement)
  return { document, rootElement }
}

function collectElements(node: FakeNode, predicate: (el: FakeNode) => boolean): FakeNode[] {
  const found: FakeNode[] = []
  const visit = (cur: FakeNode): void => {
    if (cur.nodeType === 1 && predicate(cur)) found.push(cur)
    for (const child of cur.childNodes) visit(child)
  }
  visit(node)
  return found
}

function makeSnapshot(id: string, seq = 1, extensionUi?: ExtensionUiView | null): SessionSnapshot {
  return {
    seq,
    older: null,
    plan: null,
    entries: [],
    session: {
      id,
      agentId: 'pi',
      projectPath: '/repo',
      acpSessionId: `pi-${id}`,
      status: 'ready',
      title: id,
      config: [],
      commands: [],
      usage: null,
      error: null,
      turnStartedAt: null,
      turnStartUsed: null,
      createdAt: 1,
      updatedAt: 1,
      parentId: null,
      origin: 'user',
      subagent: null,
      routine: null,
      queue: [],
      queuePaused: false,
      ...(extensionUi !== undefined ? { extensionUi } : {}),
    },
  }
}

describe('ExtensionWidgets and ExtensionStatusBar (#1837)', () => {
  const rafQueue: FrameRequestCallback[] = []
  let root: Root | null = null
  let container: FakeNode

  const flushRaf = () => {
    for (const cb of rafQueue.splice(0)) cb(performance.now())
  }

  beforeEach(() => {
    hostMock.mockReset()
    rafQueue.length = 0
    const dom = createFakeDom()
    container = dom.rootElement
    vi.stubGlobal('document', dom.document)
    vi.stubGlobal('window', dom.document.defaultView)
    vi.stubGlobal('HTMLElement', FakeDomBase)
    vi.stubGlobal('Element', FakeDomBase)
    vi.stubGlobal('Node', FakeDomBase)
    vi.stubGlobal('Document', FakeDomBase)
    vi.stubGlobal('HTMLIFrameElement', FakeDomBase)
    vi.stubGlobal('ShadowRoot', FakeDomBase)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb)
      return rafQueue.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })

  afterEach(async () => {
    if (root) {
      flushSync(() => root!.unmount())
      root = null
    }
    await new Promise((resolve) => setImmediate(resolve))
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('renders zero DOM when empty, updates and clears live, isolates sessions A -> B -> A, and resyncs on reconnect', async () => {
    const snapshots = new Map<string, SessionSnapshot>([
      ['sA', makeSnapshot('sA', 1)],
      ['sB', makeSnapshot('sB', 1)],
    ])
    hostMock.mockImplementation((method: string, params?: { sessionId?: string }) => {
      if (method === 'sessions.watch') return Promise.resolve()
      if (method === 'sessions.open' || method === 'sessions.snapshot') {
        const snap = snapshots.get(params?.sessionId ?? '')
        return Promise.resolve(snap ?? makeSnapshot(params?.sessionId ?? 'unknown', 1))
      }
      return Promise.resolve()
    })

    const { focusSession, receiveBatch, rewatchAll } = await import('@renderer/stores/threads')
    const { ExtensionStatusBar, ExtensionWidgets } = await import('./extension-ui')

    const Harness = ({ sessionId, enabled = true }: { sessionId: string; enabled?: boolean }) =>
      createElement(
        'div',
        null,
        createElement(ExtensionWidgets, { sessionId, placement: 'aboveEditor', enabled }),
        createElement(ExtensionWidgets, { sessionId, placement: 'belowEditor', enabled }),
        createElement(ExtensionStatusBar, { sessionId, enabled }),
      )

    await focusSession('sA')
    await focusSession('sB')

    root = createRoot(container as unknown as Element)
    flushSync(() => root!.render(createElement(Harness, { sessionId: 'sA' })))

    // Zero DOM footprint when no extension statuses or widgets exist.
    expect(
      collectElements(container, (el) => el.getAttribute('data-extension-status') !== null),
    ).toHaveLength(0)
    expect(
      collectElements(container, (el) => el.getAttribute('data-extension-widget') !== null),
    ).toHaveLength(0)

    // Live patch delivers statuses and widgets for both placements to session A.
    const liveA: ExtensionUiView = {
      statuses: [
        { key: 'branch', text: 'feat/1837' },
        { key: 'tests', text: '14 passed' },
      ],
      widgets: [
        { key: 'progress', lines: ['Indexing', '42% complete'], placement: 'aboveEditor' },
        { key: 'hint', lines: ['Press Esc to stop'], placement: 'belowEditor' },
      ],
    }
    receiveBatch({
      sessionId: 'sA',
      seq: 2,
      patches: [{ op: 'session.update', changes: { extensionUi: liveA } }],
    })
    flushSync(flushRaf)

    const statusPills = collectElements(
      container,
      (el) => el.getAttribute('data-extension-status') !== null,
    )
    expect(
      statusPills.map((el) => [el.getAttribute('data-extension-status'), el.textContent]),
    ).toEqual([
      ['branch', 'feat/1837'],
      ['tests', '14 passed'],
    ])

    const aboveRegion = collectElements(
      container,
      (el) => el.getAttribute('data-extension-widgets') === 'aboveEditor',
    )
    const belowRegion = collectElements(
      container,
      (el) => el.getAttribute('data-extension-widgets') === 'belowEditor',
    )
    expect(aboveRegion).toHaveLength(1)
    expect(belowRegion).toHaveLength(1)
    expect(aboveRegion[0]!.textContent).toContain('Indexing')
    expect(aboveRegion[0]!.textContent).toContain('42% complete')
    expect(belowRegion[0]!.textContent).toContain('Press Esc to stop')

    // Switching to session B must never leak session A's statuses or widgets.
    flushSync(() => root!.render(createElement(Harness, { sessionId: 'sB' })))
    expect(
      collectElements(container, (el) => el.getAttribute('data-extension-status') !== null),
    ).toHaveLength(0)
    expect(
      collectElements(container, (el) => el.getAttribute('data-extension-widget') !== null),
    ).toHaveLength(0)

    // Switching back to session A immediately restores A's active statuses and widgets.
    flushSync(() => root!.render(createElement(Harness, { sessionId: 'sA' })))
    expect(
      collectElements(container, (el) => el.getAttribute('data-extension-status') !== null).map(
        (el) => el.textContent,
      ),
    ).toEqual(['feat/1837', '14 passed'])
    expect(
      collectElements(container, (el) => el.getAttribute('data-extension-widget') !== null).map(
        (el) => el.getAttribute('data-extension-widget'),
      ),
    ).toEqual(['progress', 'hint'])

    // Disabled state (for example archived or offline) hides extension UI cleanly.
    flushSync(() => root!.render(createElement(Harness, { sessionId: 'sA', enabled: false })))
    expect(
      collectElements(container, (el) => el.getAttribute('data-extension-status') !== null),
    ).toHaveLength(0)
    expect(
      collectElements(container, (el) => el.getAttribute('data-extension-widget') !== null),
    ).toHaveLength(0)
    flushSync(() => root!.render(createElement(Harness, { sessionId: 'sA', enabled: true })))

    // Live clearing returns to zero DOM.
    receiveBatch({
      sessionId: 'sA',
      seq: 3,
      patches: [{ op: 'session.update', changes: { extensionUi: null } }],
    })
    flushSync(flushRaf)
    expect(
      collectElements(container, (el) => el.getAttribute('data-extension-status') !== null),
    ).toHaveLength(0)
    expect(
      collectElements(container, (el) => el.getAttribute('data-extension-widget') !== null),
    ).toHaveLength(0)

    // Reconnect (rewatchAll -> sessions.snapshot) resyncs active extension UI from the host.
    snapshots.set(
      'sA',
      makeSnapshot('sA', 8, {
        statuses: [{ key: 'reconnected', text: 'Synced after reconnect' }],
        widgets: [{ key: 'w-sync', lines: ['Restored widget'], placement: 'aboveEditor' }],
      }),
    )
    rewatchAll()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    flushSync(() => root!.render(createElement(Harness, { sessionId: 'sA' })))

    expect(
      collectElements(container, (el) => el.getAttribute('data-extension-status') !== null).map(
        (el) => el.textContent,
      ),
    ).toEqual(['Synced after reconnect'])
    expect(
      collectElements(container, (el) => el.getAttribute('data-extension-widget') !== null).map(
        (el) => el.textContent,
      ),
    ).toEqual(['Restored widget'])
  })
})
