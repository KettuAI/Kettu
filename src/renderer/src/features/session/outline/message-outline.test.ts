import {
  act,
  createElement,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import enSession from '@shared/locales/en/session.json'
import zhSession from '@shared/locales/zh-CN/session.json'
import { userText } from '../entries/user-text'
import type { OutlineRow } from './use-outline'

interface CapturedDropdown {
  open: boolean | undefined
  onOpenChange?: (next: boolean, details?: { reason?: string; cancel?: () => void }) => void
  anchor?: { getBoundingClientRect: () => DOMRect } | RefObject<HTMLElement | null> | null
  items: CapturedMenuItem[]
}

interface CapturedMenuItem {
  label: string
  disabled: boolean
  onClick?: (event: { stopPropagation: () => void }) => void
  onContextMenu?: (event: Partial<ReactMouseEvent>) => void
}

interface CapturedHoverCard {
  open: boolean | undefined
  onOpenChange?: (next: boolean, details?: { cancel?: () => void }) => void
  onPointerEnter?: () => void
  onPointerLeave?: () => void
}

interface CapturedOutlineButton {
  label: string
  highlighted: boolean
  onPointerEnter?: () => void
  onClick?: () => void
  onContextMenu?: (event: Partial<ReactMouseEvent>) => void
}

const {
  hostMock,
  toastMock,
  jumpToMock,
  askFindMatchMock,
  writeTextMock,
  stateBag,
  capturedDropdowns,
  capturedHoverCards,
} = vi.hoisted(() => ({
  hostMock: vi.fn(),
  toastMock: vi.fn(),
  jumpToMock: vi.fn().mockResolvedValue(true),
  askFindMatchMock: vi.fn(),
  writeTextMock: vi.fn<(text: string) => Promise<void>>(),
  stateBag: {
    rows: [] as OutlineRow[],
    replicas: {} as Record<
      string,
      { state: { order: string[]; byId: Record<string, ThreadEntry> } }
    >,
  },
  capturedDropdowns: [] as CapturedDropdown[],
  capturedHoverCards: [] as CapturedHoverCard[],
}))

let activeDropdown: CapturedDropdown | null = null

function textContentOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContentOf).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: ReactNode } }).props
    return textContentOf(props?.children)
  }
  return ''
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@renderer/lib/host', () => ({
  host: (...args: unknown[]) => hostMock(...args),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

vi.mock('@renderer/components/ui/toast', () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}))

vi.mock('@renderer/features/shell/glyph', () => ({
  MenuGlyph: () => null,
}))

vi.mock('@renderer/components/glide-highlight', () => ({
  GlideHighlight: () => null,
}))

vi.mock('@renderer/components/ui/spinner', () => ({
  Spinner: () => null,
}))

vi.mock('@renderer/stores/find', () => ({
  askFindMatch: (...args: unknown[]) => askFindMatchMock(...args),
  useFindStore: (selector: (state: { shown: Record<string, undefined> }) => unknown) =>
    selector({ shown: {} }),
}))

vi.mock('@renderer/stores/threads', () => ({
  useThreadsStore: {
    getState: () => ({ replicas: stateBag.replicas }),
  },
}))

vi.mock('./use-jump', () => ({
  useJumpToMessage: () => ({ jumpTo: jumpToMock, waiting: null }),
}))

vi.mock('./use-outline', () => ({
  useOutline: () => ({ rows: stateBag.rows, opened: vi.fn() }),
}))

vi.mock('./use-rail-box', () => ({
  useRailBox: () => ({ height: 800, room: true }),
}))

vi.mock('@renderer/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({
    open,
    onOpenChange,
    children,
  }: {
    open?: boolean
    onOpenChange?: (next: boolean, details?: { reason?: string; cancel?: () => void }) => void
    children?: ReactNode
  }) => {
    const record: CapturedDropdown = { open, onOpenChange, items: [] }
    capturedDropdowns.push(record)
    const previous = activeDropdown
    activeDropdown = record
    try {
      return createElement('div', { 'data-dropdown': open ? 'open' : 'closed' }, children)
    } finally {
      activeDropdown = previous
    }
  },
  DropdownMenuTrigger: ({ className }: { className?: string }) =>
    createElement('button', { type: 'button', className }),
  DropdownMenuContent: ({
    anchor,
    children,
  }: {
    anchor?: CapturedDropdown['anchor']
    children?: ReactNode
  }) => {
    const owner = activeDropdown ?? capturedDropdowns.at(-1) ?? null
    if (owner) owner.anchor = anchor
    return createElement('div', { 'data-dropdown-content': '' }, children)
  },
  DropdownMenuItem: ({
    disabled,
    onClick,
    onContextMenu,
    children,
  }: {
    disabled?: boolean
    onClick?: (event: { stopPropagation: () => void }) => void
    onContextMenu?: (event: Partial<ReactMouseEvent>) => void
    children?: ReactNode
  }) => {
    const owner = activeDropdown ?? capturedDropdowns.at(-1) ?? null
    if (owner) {
      owner.items.push({
        label: textContentOf(children),
        disabled: Boolean(disabled),
        onClick,
        onContextMenu,
      })
    }
    return createElement(
      'button',
      { type: 'button', disabled: Boolean(disabled) },
      textContentOf(children),
    )
  },
}))

vi.mock('@renderer/components/ui/hover-card', () => ({
  HoverCard: ({
    open,
    onOpenChange,
    children,
  }: {
    open?: boolean
    onOpenChange?: (next: boolean, details?: { cancel?: () => void }) => void
    children?: ReactNode
  }) => {
    capturedHoverCards.push({ open, onOpenChange })
    return createElement('div', { 'data-hover-card': open ? 'open' : 'closed' }, children)
  },
  HoverCardContent: ({
    onPointerEnter,
    onPointerLeave,
    children,
  }: {
    onPointerEnter?: () => void
    onPointerLeave?: () => void
    children?: ReactNode
  }) => {
    const current = capturedHoverCards.at(-1)
    if (current) {
      current.onPointerEnter = onPointerEnter
      current.onPointerLeave = onPointerLeave
    }
    return createElement('div', { 'data-hover-card-content': '' }, children)
  },
}))

import { copyOutlinePrompt, hasCopyablePrompt, loadedPromptText } from './copy-prompt'
import { MessageOutline } from './message-outline'

interface FakeElement {
  nodeType: number
  nodeName: string
  tagName: string
  className: string
  id: string
  dataset: Record<string, string>
  attributes: Map<string, string>
  props: Record<string, unknown>
  childNodes: FakeElement[]
  children: FakeElement[]
  parentNode: FakeElement | null
  ownerDocument: FakeDocument | null
  style: Record<string, string>
  clientHeight: number
  offsetHeight: number
  scrollTop: number
  textContent: string
  listeners: Map<string, Set<(event: unknown) => void>>
  addEventListener(type: string, listener: (event: unknown) => void): void
  removeEventListener(type: string, listener: (event: unknown) => void): void
  appendChild(child: FakeElement): FakeElement
  insertBefore(child: FakeElement, ref: FakeElement | null): FakeElement
  removeChild(child: FakeElement): FakeElement
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  getAttribute(name: string): string | null
  getBoundingClientRect(): { left: number; top: number; width: number; height: number }
  querySelector(selector: string): FakeElement | null
}

interface FakeDocument {
  nodeType: number
  nodeName: string
  body: FakeElement
  defaultView: unknown
  elementsById: Map<string, FakeElement>
  createElement(tag: string): FakeElement
  createTextNode(text: string): FakeElement
  createComment(text: string): FakeElement
  getElementById(id: string): FakeElement | null
  addEventListener(): void
  removeEventListener(): void
}

function makeFakeDom() {
  const elementsById = new Map<string, FakeElement>()
  const makeEl = (tag: string, ownerDocument: FakeDocument | null): FakeElement => {
    const el: FakeElement = {
      nodeType: tag === '#text' ? 3 : tag === '#comment' ? 8 : 1,
      nodeName: tag.startsWith('#') ? tag : tag.toUpperCase(),
      tagName: tag.startsWith('#') ? '' : tag.toUpperCase(),
      className: '',
      id: '',
      dataset: {},
      attributes: new Map(),
      props: {},
      childNodes: [],
      children: [],
      parentNode: null,
      ownerDocument,
      style: {},
      clientHeight: 240,
      offsetHeight: 10,
      scrollTop: 0,
      textContent: '',
      listeners: new Map(),
      addEventListener(type, listener) {
        let set = this.listeners.get(type)
        if (!set) this.listeners.set(type, (set = new Set()))
        set.add(listener)
      },
      removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener)
      },
      appendChild(child) {
        child.parentNode = this
        this.childNodes.push(child)
        if (child.nodeType === 1) this.children.push(child)
        return child
      },
      insertBefore(child, ref) {
        child.parentNode = this
        const idx = ref ? this.childNodes.indexOf(ref) : -1
        if (idx >= 0) this.childNodes.splice(idx, 0, child)
        else this.childNodes.push(child)
        if (child.nodeType === 1) {
          const elIdx = ref ? this.children.indexOf(ref) : -1
          if (elIdx >= 0) this.children.splice(elIdx, 0, child)
          else this.children.push(child)
        }
        return child
      },
      removeChild(child) {
        const idx = this.childNodes.indexOf(child)
        if (idx >= 0) this.childNodes.splice(idx, 1)
        const elIdx = this.children.indexOf(child)
        if (elIdx >= 0) this.children.splice(elIdx, 1)
        child.parentNode = null
        return child
      },
      setAttribute(name, value) {
        this.attributes.set(name, value)
        if (name === 'class') this.className = value
        if (name === 'id') {
          if (this.id) elementsById.delete(this.id)
          this.id = value
          if (value) elementsById.set(value, this)
        }
        if (name.startsWith('data-')) {
          const key = name.slice(5).replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())
          this.dataset[key] = value
        }
      },
      removeAttribute(name) {
        this.attributes.delete(name)
        if (name === 'class') this.className = ''
        if (name === 'id') {
          if (this.id) elementsById.delete(this.id)
          this.id = ''
        }
        if (name.startsWith('data-')) {
          const key = name.slice(5).replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())
          delete this.dataset[key]
        }
      },
      getAttribute(name) {
        return this.attributes.get(name) ?? null
      },
      getBoundingClientRect() {
        return { left: 0, top: 200, width: 36, height: 100 }
      },
      querySelector() {
        return null
      },
    }
    return el
  }

  const doc: FakeDocument = {
    nodeType: 9,
    nodeName: '#document',
    body: null as unknown as FakeElement,
    defaultView: null,
    elementsById,
    createElement(tag) {
      return makeEl(tag, doc)
    },
    createTextNode(text) {
      const node = makeEl('#text', doc)
      node.textContent = text
      return node
    },
    createComment() {
      return makeEl('#comment', doc)
    },
    getElementById(id) {
      return elementsById.get(id) ?? null
    },
    addEventListener() {},
    removeEventListener() {},
  }
  doc.body = makeEl('body', doc)
  const StubElement = class {}
  const win = {
    document: doc,
    HTMLElement: StubElement,
    Element: StubElement,
    Node: StubElement,
    Document: StubElement,
    HTMLIFrameElement: StubElement,
    navigator: { clipboard: { writeText: writeTextMock } },
    addEventListener() {},
    removeEventListener() {},
  }
  doc.defaultView = win
  return { doc, win, makeEl }
}

function collectText(el: FakeElement): string {
  if (el.nodeType === 3) return el.textContent
  return el.childNodes.map(collectText).join('')
}

function findReactProps(el: FakeElement): Record<string, unknown> {
  for (const key of Object.keys(el as unknown as Record<string, unknown>)) {
    if (key.startsWith('__reactProps$')) {
      return (el as unknown as Record<string, Record<string, unknown>>)[key] ?? {}
    }
  }
  return {}
}

function findElements(
  root: FakeElement,
  predicate: (el: FakeElement) => boolean,
  out: FakeElement[] = [],
): FakeElement[] {
  if (predicate(root)) out.push(root)
  for (const child of root.childNodes) findElements(child, predicate, out)
  return out
}

function outlineButtons(container: FakeElement): CapturedOutlineButton[] {
  const hoverContent = findElements(container, (el) =>
    el.attributes.has('data-hover-card-content'),
  )[0]
  if (!hoverContent) return []
  return findElements(
    hoverContent,
    (el) => el.tagName === 'BUTTON' && el.className.split(/\s+/).includes('ks-outline__item'),
  ).map((el) => {
    const props = findReactProps(el)
    return {
      label: collectText(el),
      highlighted: el.attributes.has('data-highlighted'),
      onPointerEnter: props.onPointerEnter as (() => void) | undefined,
      onClick: props.onClick as (() => void) | undefined,
      onContextMenu: props.onContextMenu as ((event: Partial<ReactMouseEvent>) => void) | undefined,
    }
  })
}

function railElement(container: FakeElement): FakeElement {
  const rail = findElements(container, (el) => el.className.split(/\s+/).includes('ks-outline'))[0]
  if (!rail) throw new Error('Expected .ks-outline rail element')
  return rail
}

function latestHoverCard(): CapturedHoverCard {
  const card = capturedHoverCards.at(-1)
  if (!card) throw new Error('Expected HoverCard render')
  return card
}

function latestMenus(): { keyboard: CapturedDropdown; context: CapturedDropdown } {
  if (capturedDropdowns.length < 2)
    throw new Error('Expected keyboard and context DropdownMenu renders')
  return {
    keyboard: capturedDropdowns.at(-2)!,
    context: capturedDropdowns.at(-1)!,
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function userEntry(
  id: string,
  content: Extract<ThreadEntry, { kind: 'user' }>['content'],
): ThreadEntry {
  return { kind: 'user', id, content }
}

const roots: Root[] = []

function mountOutline(sessionId = 's-1') {
  const { doc, win, makeEl } = makeFakeDom()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  vi.stubGlobal('HTMLElement', win.HTMLElement)
  vi.stubGlobal('Element', win.Element)
  vi.stubGlobal('Node', win.Node)
  vi.stubGlobal('Document', win.Document)
  vi.stubGlobal('HTMLIFrameElement', win.HTMLIFrameElement)
  vi.stubGlobal('navigator', { clipboard: { writeText: writeTextMock } })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )

  const viewport = { current: makeEl('div', doc) as unknown as HTMLDivElement }
  const content = { current: makeEl('div', doc) as unknown as HTMLDivElement }
  const container = doc.createElement('div')
  const root = createRoot(container as unknown as Element)
  roots.push(root)

  const render = (nextSessionId = sessionId) => {
    act(() => {
      root.render(
        createElement(MessageOutline, {
          sessionId: nextSessionId,
          viewport,
          content,
          jumps: { reveal: vi.fn().mockResolvedValue(undefined), hold: vi.fn() },
        }),
      )
    })
  }
  render(sessionId)

  const openHoverList = () => {
    const rail = railElement(container)
    const railProps = findReactProps(rail)
    const onPointerEnter = railProps.onPointerEnter as
      ((event: Partial<ReactPointerEvent>) => void) | undefined
    act(() => {
      onPointerEnter?.({ clientY: 200 })
      vi.advanceTimersByTime(160)
    })
  }

  return { container, render, openHoverList }
}

beforeEach(() => {
  vi.useFakeTimers()
  hostMock.mockReset()
  toastMock.mockReset()
  jumpToMock.mockReset().mockResolvedValue(true)
  askFindMatchMock.mockReset()
  writeTextMock.mockReset().mockResolvedValue(undefined)
  capturedDropdowns.length = 0
  capturedHoverCards.length = 0
  stateBag.rows = [
    { entryId: 'u1', pos: 0, label: 'Short summary title', titled: true },
    { entryId: 'u2', pos: 4, label: 'Truncated first line...', titled: false },
    { entryId: 'u3', pos: 8, label: '', titled: false },
  ]
  stateBag.replicas = {
    's-1': {
      state: {
        order: ['u1', 'u2', 'u3'],
        byId: {
          u1: userEntry('u1', [
            { type: 'text', text: 'Full prompt line 1\nFull prompt line 2\nWith extra detail' },
            { type: 'ref', ref: { kind: 'link', uri: 'https://kettu.sh/docs', name: 'Docs' } },
          ]),
          u2: userEntry('u2', [
            {
              type: 'text',
              text: 'Truncated first line...\nSecond paragraph that is not in outline',
            },
          ]),
          u3: userEntry('u3', [
            {
              type: 'ref',
              ref: {
                kind: 'image',
                mimeType: 'image/png',
                data: 'abc',
              },
            },
          ]),
        },
      },
    },
  }
  vi.stubGlobal('navigator', { clipboard: { writeText: writeTextMock } })
})

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!
    act(() => root.unmount())
  }
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('copy-prompt helpers', () => {
  it('extracts full text and link URIs matching the user message Copy action', () => {
    expect(
      userText([
        { type: 'text', text: 'First paragraph\nSecond line' },
        { type: 'ref', ref: { kind: 'image', mimeType: 'image/png', data: 'x' } },
        { type: 'ref', ref: { kind: 'link', uri: 'https://example.com', name: 'Example' } },
        { type: 'text', text: 'Closing note' },
      ]),
    ).toBe('First paragraph\nSecond line\nhttps://example.com\nClosing note')
  })

  it('treats empty or whitespace-only prompts as non-copyable', async () => {
    expect(hasCopyablePrompt('')).toBe(false)
    expect(hasCopyablePrompt('   \n\t  ')).toBe(false)
    expect(hasCopyablePrompt('hello')).toBe(true)

    expect(loadedPromptText('s-1', 'u3')).toBe('')
    const copied = await copyOutlinePrompt('s-1', 'u3', 'Prompt copied')
    expect(copied).toBe(false)
    expect(writeTextMock).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('falls back to sessions.entry for unloaded pages and surfaces errors via toast', async () => {
    delete stateBag.replicas['s-1']!.state.byId.u2
    hostMock.mockResolvedValueOnce(
      userEntry('u2', [{ type: 'text', text: 'Loaded from host\nLine 2' }]),
    )

    const ok = await copyOutlinePrompt('s-1', 'u2', 'Prompt copied')
    expect(ok).toBe(true)
    expect(hostMock).toHaveBeenCalledWith('sessions.entry', { sessionId: 's-1', entryId: 'u2' })
    expect(writeTextMock).toHaveBeenCalledWith('Loaded from host\nLine 2')
    expect(toastMock).toHaveBeenCalledWith('Prompt copied')

    hostMock.mockRejectedValueOnce(new Error('Host offline'))
    const failed = await copyOutlinePrompt('s-1', 'u2', 'Prompt copied')
    expect(failed).toBe(false)
    expect(toastMock).toHaveBeenCalledWith('Host offline')
  })
})

describe('MessageOutline right-click copy prompt', () => {
  it('opens the context menu on right-click without jumping and copies the full prompt text', async () => {
    const { container, openHoverList } = mountOutline()
    openHoverList()
    expect(latestHoverCard().open).toBe(true)

    const buttons = outlineButtons(container)
    expect(buttons).toHaveLength(3)

    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    act(() => {
      buttons[0]!.onContextMenu?.({
        clientX: 120,
        clientY: 260,
        preventDefault,
        stopPropagation,
      })
    })

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(stopPropagation).toHaveBeenCalledTimes(1)
    expect(jumpToMock).not.toHaveBeenCalled()
    expect(askFindMatchMock).not.toHaveBeenCalled()

    const { context } = latestMenus()
    expect(context.open).toBe(true)
    expect(
      (context.anchor as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect(),
    ).toMatchObject({ x: 120, y: 260, width: 0, height: 0 })
    expect(context.items).toHaveLength(1)
    expect(context.items[0]!.label).toBe('thread.outline.copyPrompt')
    expect(context.items[0]!.disabled).toBe(false)

    const itemStop = vi.fn()
    act(() => {
      context.items[0]!.onClick?.({ stopPropagation: itemStop })
      context.onOpenChange?.(false, { reason: 'item-press' })
    })
    await flushMicrotasks()

    expect(itemStop).toHaveBeenCalledTimes(1)
    expect(jumpToMock).not.toHaveBeenCalled()
    expect(writeTextMock).toHaveBeenCalledTimes(1)
    expect(writeTextMock).toHaveBeenCalledWith(
      'Full prompt line 1\nFull prompt line 2\nWith extra detail\nhttps://kettu.sh/docs',
    )
    expect(toastMock).toHaveBeenCalledWith('thread.outline.copiedPrompt')
    expect(latestMenus().context.open).toBe(false)
  })

  it('keeps the outline popover open and row highlighted while the context menu is open', () => {
    const { container, openHoverList } = mountOutline()
    openHoverList()
    expect(latestHoverCard().open).toBe(true)

    act(() => {
      latestHoverCard().onPointerEnter?.()
      outlineButtons(container)[0]!.onContextMenu?.({
        clientX: 140,
        clientY: 280,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      })
    })

    // Moving the pointer across another row and out of the hover card + rail must not collapse it.
    const cancelHoverClose = vi.fn()
    act(() => {
      outlineButtons(container)[1]!.onPointerEnter?.()
      latestHoverCard().onPointerLeave?.()
      const railProps = findReactProps(railElement(container))
      ;(railProps.onPointerLeave as (() => void) | undefined)?.()
      latestHoverCard().onOpenChange?.(false, { cancel: cancelHoverClose })
      vi.advanceTimersByTime(1000)
    })

    expect(cancelHoverClose).toHaveBeenCalledTimes(1)
    expect(latestHoverCard().open).toBe(true)
    expect(outlineButtons(container)[0]!.highlighted).toBe(true)
    expect(outlineButtons(container)[1]!.highlighted).toBe(false)

    // Dismissing via outside press when pointer left closes both menus cleanly.
    act(() => {
      latestMenus().context.onOpenChange?.(false, { reason: 'outside-press' })
    })
    expect(latestMenus().context.open).toBe(false)
    expect(latestHoverCard().open).toBe(false)
  })

  it('keeps the popover open after Escape when the pointer is still inside the list', () => {
    const { container, openHoverList } = mountOutline()
    openHoverList()

    act(() => {
      latestHoverCard().onPointerEnter?.()
      outlineButtons(container)[0]!.onContextMenu?.({
        clientX: 100,
        clientY: 240,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      })
    })

    act(() => {
      latestMenus().context.onOpenChange?.(false, { reason: 'escape-key' })
      vi.advanceTimersByTime(1000)
    })

    expect(latestMenus().context.open).toBe(false)
    expect(latestHoverCard().open).toBe(true)
  })

  it('disables Copy prompt for empty or attachment-only items without writing to the clipboard', async () => {
    const { container, openHoverList } = mountOutline()
    openHoverList()

    act(() => {
      outlineButtons(container)[2]!.onContextMenu?.({
        clientX: 110,
        clientY: 320,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      })
    })

    const { context } = latestMenus()
    expect(context.open).toBe(true)
    expect(context.items[0]!.disabled).toBe(true)

    act(() => {
      context.items[0]!.onClick?.({ stopPropagation: vi.fn() })
    })
    await flushMicrotasks()

    expect(writeTextMock).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('prefetches unloaded older entries once via sessions.entry and copies the full text', async () => {
    delete stateBag.replicas['s-1']!.state.byId.u2
    let resolveEntry!: (entry: ThreadEntry) => void
    hostMock.mockImplementationOnce(
      () =>
        new Promise<ThreadEntry>((resolve) => {
          resolveEntry = resolve
        }),
    )

    const { container, openHoverList } = mountOutline()
    openHoverList()

    act(() => {
      outlineButtons(container)[1]!.onContextMenu?.({
        clientX: 130,
        clientY: 300,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      })
    })

    expect(hostMock).toHaveBeenCalledTimes(1)
    expect(hostMock).toHaveBeenCalledWith('sessions.entry', { sessionId: 's-1', entryId: 'u2' })
    expect(latestMenus().context.items[0]!.disabled).toBe(false)

    // Clicking Copy prompt while the prefetch is still in flight reuses the single RPC.
    act(() => {
      latestMenus().context.items[0]!.onClick?.({ stopPropagation: vi.fn() })
      latestMenus().context.onOpenChange?.(false, { reason: 'item-press' })
    })
    expect(hostMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveEntry(userEntry('u2', [{ type: 'text', text: 'Full historical prompt\nLine 2' }]))
      await flushMicrotasks()
    })

    expect(writeTextMock).toHaveBeenCalledWith('Full historical prompt\nLine 2')
    expect(toastMock).toHaveBeenCalledWith('thread.outline.copiedPrompt')
  })

  it('disables Copy prompt for unloaded entries that turn out to have no copyable text', async () => {
    delete stateBag.replicas['s-1']!.state.byId.u2
    hostMock.mockResolvedValueOnce(
      userEntry('u2', [{ type: 'ref', ref: { kind: 'image', mimeType: 'image/png', data: 'x' } }]),
    )

    const { container, openHoverList } = mountOutline()
    openHoverList()

    await act(async () => {
      outlineButtons(container)[1]!.onContextMenu?.({
        clientX: 130,
        clientY: 300,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      })
      await flushMicrotasks()
    })

    expect(latestMenus().context.items[0]!.disabled).toBe(true)
  })

  it('also supports right-clicking items inside the keyboard outline menu', async () => {
    mountOutline()

    act(() => {
      latestMenus().keyboard.onOpenChange?.(true)
    })
    expect(latestMenus().keyboard.open).toBe(true)

    const keyboardItem = latestMenus().keyboard.items[0]!
    const cancelKeyboardClose = vi.fn()
    act(() => {
      keyboardItem.onContextMenu?.({
        clientX: 150,
        clientY: 220,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      })
      latestMenus().keyboard.onOpenChange?.(false, { cancel: cancelKeyboardClose })
    })

    expect(cancelKeyboardClose).toHaveBeenCalledTimes(1)
    expect(latestMenus().keyboard.open).toBe(true)
    expect(latestMenus().context.open).toBe(true)
    expect(jumpToMock).not.toHaveBeenCalled()

    act(() => {
      latestMenus().context.items[0]!.onClick?.({ stopPropagation: vi.fn() })
      latestMenus().context.onOpenChange?.(false, { reason: 'item-press' })
    })
    await flushMicrotasks()

    expect(writeTextMock).toHaveBeenCalledWith(
      'Full prompt line 1\nFull prompt line 2\nWith extra detail\nhttps://kettu.sh/docs',
    )
    expect(toastMock).toHaveBeenCalledWith('thread.outline.copiedPrompt')
  })

  it('closes an open context menu when switching sessions', () => {
    const { container, render, openHoverList } = mountOutline('s-1')
    openHoverList()

    act(() => {
      outlineButtons(container)[0]!.onContextMenu?.({
        clientX: 120,
        clientY: 260,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      })
    })
    expect(latestMenus().context.open).toBe(true)

    render('s-2')
    expect(latestMenus().context.open).toBe(false)
  })

  it('keeps en and zh-CN outline copy locale keys defined and synchronized', () => {
    expect(enSession.thread.outline.copyPrompt).toBe('Copy prompt')
    expect(enSession.thread.outline.copiedPrompt).toBe('Prompt copied')
    expect(zhSession.thread.outline.copyPrompt).toBe('复制提示词')
    expect(zhSession.thread.outline.copiedPrompt).toBe('已复制提示词')
  })
})
