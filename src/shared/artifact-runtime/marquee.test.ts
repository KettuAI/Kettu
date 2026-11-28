import { describe, expect, it } from 'vitest'
import {
  findMarqueeElements,
  MARQUEE_MAX,
  selectMarqueeCandidates,
  unionPageBoxes,
  type MarqueeCandidate,
  type MarqueeComputedStyle,
  type MarqueeDomElement,
} from './marquee'

const VIEWPORT = { width: 1200, height: 800 }

interface MockNode extends MarqueeDomElement {
  id: string
  tag: string
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number }
  parentElement: MockNode | null
  children: MockNode[]
  childNodes: Array<{ nodeType: number; nodeValue?: string }>
  readonly childElementCount: number
  localName: string
  style: MarqueeComputedStyle
  getBoundingClientRect: () => MockNode['rect']
}

function makeNode(
  id: string,
  tag: string,
  box: { x: number; y: number; width: number; height: number },
  options: {
    parent?: MockNode | null
    text?: string
    style?: MarqueeComputedStyle
  } = {},
): MockNode {
  const children: MockNode[] = []
  const rect = {
    left: box.x,
    top: box.y,
    right: box.x + box.width,
    bottom: box.y + box.height,
    width: box.width,
    height: box.height,
  }
  const node: MockNode = {
    id,
    tag,
    localName: tag,
    rect,
    parentElement: options.parent ?? null,
    children,
    childNodes: options.text ? [{ nodeType: 3, nodeValue: options.text }] : [],
    get childElementCount() {
      return children.length
    },
    style: options.style ?? {},
    getBoundingClientRect: () => rect,
  }
  if (options.parent) options.parent.children.push(node)
  return node
}

describe('unionPageBoxes', () => {
  it('returns null for empty or zero-sized lists and computes exact union bounds otherwise', () => {
    expect(unionPageBoxes([])).toBeNull()
    expect(unionPageBoxes([{ x: 10, y: 10, width: 0, height: 0 }])).toBeNull()
    expect(
      unionPageBoxes([
        { x: 100, y: 120, width: 160, height: 80 },
        { x: 280, y: 90, width: 140, height: 200 },
      ]),
    ).toEqual({ x: 100, y: 90, width: 320, height: 200 })
  })
})

describe('selectMarqueeCandidates', () => {
  it('selects enclosed cards without selecting outer main/grid containers or splitting card internals', () => {
    const candidates: MarqueeCandidate<string>[] = [
      {
        item: 'main',
        tag: 'main',
        rect: { x: 0, y: 0, width: 1000, height: 700 },
        parentIndex: -1,
        hasChildren: true,
        hasDirectText: false,
        hasVisualSurface: false,
        isAtomic: false,
        order: 0,
      },
      {
        item: 'grid',
        tag: 'section',
        rect: { x: 40, y: 40, width: 920, height: 220 },
        parentIndex: 0,
        hasChildren: true,
        hasDirectText: false,
        hasVisualSurface: false,
        isAtomic: false,
        order: 1,
      },
      {
        item: 'card-1',
        tag: 'article',
        rect: { x: 40, y: 40, width: 280, height: 200 },
        parentIndex: 1,
        hasChildren: true,
        hasDirectText: false,
        hasVisualSurface: true,
        isAtomic: false,
        order: 2,
      },
      {
        item: 'card-1-h3',
        tag: 'h3',
        rect: { x: 60, y: 60, width: 200, height: 28 },
        parentIndex: 2,
        hasChildren: false,
        hasDirectText: true,
        hasVisualSurface: false,
        isAtomic: false,
        order: 3,
      },
      {
        item: 'card-1-btn',
        tag: 'button',
        rect: { x: 60, y: 160, width: 100, height: 36 },
        parentIndex: 2,
        hasChildren: false,
        hasDirectText: true,
        hasVisualSurface: true,
        isAtomic: true,
        order: 4,
      },
      {
        item: 'card-2',
        tag: 'article',
        rect: { x: 340, y: 40, width: 280, height: 200 },
        parentIndex: 1,
        hasChildren: true,
        hasDirectText: false,
        hasVisualSurface: true,
        isAtomic: false,
        order: 5,
      },
      {
        item: 'card-2-h3',
        tag: 'h3',
        rect: { x: 360, y: 60, width: 200, height: 28 },
        parentIndex: 5,
        hasChildren: false,
        hasDirectText: true,
        hasVisualSurface: false,
        isAtomic: false,
        order: 6,
      },
      {
        item: 'card-3',
        tag: 'article',
        rect: { x: 640, y: 40, width: 280, height: 200 },
        parentIndex: 1,
        hasChildren: true,
        hasDirectText: false,
        hasVisualSurface: true,
        isAtomic: false,
        order: 7,
      },
    ]

    // Sweep across cards 1 and 2 only.
    expect(
      selectMarqueeCandidates(candidates, { x: 30, y: 30, width: 600, height: 220 }, VIEWPORT),
    ).toEqual(['card-1', 'card-2'])

    // Sweep across all 3 cards: still yields the 3 cards rather than the enclosing section/main.
    expect(
      selectMarqueeCandidates(candidates, { x: 20, y: 20, width: 960, height: 250 }, VIEWPORT),
    ).toEqual(['card-1', 'card-2', 'card-3'])

    // Sweep inside card-1 around its heading and button: drills into card-1 and picks its inner children.
    expect(
      selectMarqueeCandidates(candidates, { x: 52, y: 52, width: 220, height: 150 }, VIEWPORT),
    ).toEqual(['card-1-h3', 'card-1-btn'])
  })

  it('drills through styled peer containers like toolbars and unwraps transparent layout divs', () => {
    const candidates: MarqueeCandidate<string>[] = [
      {
        item: 'toolbar',
        tag: 'div',
        rect: { x: 100, y: 100, width: 320, height: 48 },
        parentIndex: -1,
        hasChildren: true,
        hasDirectText: false,
        hasVisualSurface: true,
        isAtomic: false,
        order: 0,
      },
      {
        item: 'btn-1',
        tag: 'button',
        rect: { x: 110, y: 108, width: 90, height: 32 },
        parentIndex: 0,
        hasChildren: false,
        hasDirectText: true,
        hasVisualSurface: true,
        isAtomic: true,
        order: 1,
      },
      {
        item: 'btn-2',
        tag: 'button',
        rect: { x: 210, y: 108, width: 90, height: 32 },
        parentIndex: 0,
        hasChildren: false,
        hasDirectText: true,
        hasVisualSurface: true,
        isAtomic: true,
        order: 2,
      },
      {
        item: 'btn-3',
        tag: 'button',
        rect: { x: 310, y: 108, width: 90, height: 32 },
        parentIndex: 0,
        hasChildren: false,
        hasDirectText: true,
        hasVisualSurface: true,
        isAtomic: true,
        order: 3,
      },
    ]

    expect(
      selectMarqueeCandidates(candidates, { x: 90, y: 90, width: 340, height: 68 }, VIEWPORT),
    ).toEqual(['btn-1', 'btn-2', 'btn-3'])
  })

  it('returns nothing when dragging across empty whitespace of a large container', () => {
    const candidates: MarqueeCandidate<string>[] = [
      {
        item: 'main',
        tag: 'main',
        rect: { x: 0, y: 0, width: 1200, height: 800 },
        parentIndex: -1,
        hasChildren: true,
        hasDirectText: false,
        hasVisualSurface: false,
        isAtomic: false,
        order: 0,
      },
      {
        item: 'card',
        tag: 'article',
        rect: { x: 40, y: 40, width: 200, height: 120 },
        parentIndex: 0,
        hasChildren: false,
        hasDirectText: true,
        hasVisualSurface: true,
        isAtomic: false,
        order: 1,
      },
    ]

    // Empty lower-right whitespace inside <main>.
    expect(
      selectMarqueeCandidates(candidates, { x: 700, y: 500, width: 160, height: 120 }, VIEWPORT),
    ).toEqual([])
  })

  it('sorts matched elements in reading order and caps at MARQUEE_MAX', () => {
    const candidates: MarqueeCandidate<string>[] = []
    // Add 30 grid items in reverse order to verify visual reading sort and cap.
    for (let i = 29; i >= 0; i--) {
      const row = Math.floor(i / 6)
      const col = i % 6
      candidates.push({
        item: `item-${i}`,
        tag: 'button',
        rect: { x: 20 + col * 100, y: 20 + row * 60, width: 80, height: 40 },
        parentIndex: -1,
        hasChildren: false,
        hasDirectText: true,
        hasVisualSurface: true,
        isAtomic: true,
        order: 29 - i,
      })
    }

    const picked = selectMarqueeCandidates(
      candidates,
      { x: 0, y: 0, width: 700, height: 400 },
      VIEWPORT,
    )
    expect(picked).toHaveLength(MARQUEE_MAX)
    expect(picked.slice(0, 6)).toEqual(['item-0', 'item-1', 'item-2', 'item-3', 'item-4', 'item-5'])
  })
})

describe('findMarqueeElements', () => {
  it('treats buttons and svgs as atomic, skips hidden/overlay/pointer-events-none nodes, and deduplicates wrappers', () => {
    const body = makeNode(
      'body',
      'body',
      { x: 0, y: 0, width: 1200, height: 800 },
      {
        style: { backgroundColor: 'rgb(255, 255, 255)' },
      },
    )
    const overlay = makeNode(
      'overlay',
      'kettu-overlay',
      { x: 0, y: 0, width: 1200, height: 800 },
      {
        parent: body,
      },
    )
    const wrapper = makeNode(
      'wrapper',
      'div',
      { x: 40, y: 40, width: 420, height: 140 },
      {
        parent: body,
        style: { backgroundColor: 'rgba(0, 0, 0, 0)' },
      },
    )
    const button = makeNode(
      'btn',
      'button',
      { x: 50, y: 50, width: 140, height: 44 },
      {
        parent: wrapper,
        style: { backgroundColor: 'rgb(0, 96, 226)' },
      },
    )
    // Inner span inside button should never be split out.
    makeNode(
      'btn-span',
      'span',
      { x: 60, y: 60, width: 100, height: 24 },
      {
        parent: button,
        text: 'Save',
      },
    )
    const svg = makeNode(
      'icon',
      'svg',
      { x: 220, y: 50, width: 44, height: 44 },
      {
        parent: wrapper,
      },
    )
    // Inner SVG path should stay atomic with the <svg>.
    makeNode(
      'icon-path',
      'path',
      { x: 224, y: 54, width: 36, height: 36 },
      {
        parent: svg,
      },
    )
    // Hidden and decorative nodes should be ignored.
    makeNode(
      'hidden',
      'div',
      { x: 280, y: 50, width: 80, height: 44 },
      {
        parent: wrapper,
        text: 'Hidden',
        style: { display: 'none' },
      },
    )
    makeNode(
      'ghost',
      'div',
      { x: 280, y: 50, width: 80, height: 44 },
      {
        parent: wrapper,
        text: 'Ghost',
        style: { opacity: '0' },
      },
    )
    makeNode(
      'backdrop',
      'div',
      { x: 40, y: 40, width: 420, height: 140 },
      {
        parent: wrapper,
        style: { pointerEvents: 'none', backgroundColor: 'rgba(0, 0, 0, 0.2)' },
      },
    )

    const readStyle = (el: MockNode): MarqueeComputedStyle => ({
      display: el.style.display ?? 'block',
      visibility: el.style.visibility ?? 'visible',
      opacity: el.style.opacity ?? '1',
      pointerEvents: el.style.pointerEvents ?? 'auto',
      backgroundColor: el.style.backgroundColor ?? 'rgba(0, 0, 0, 0)',
      boxShadow: el.style.boxShadow ?? 'none',
      borderTopWidth: el.style.borderTopWidth ?? '0px',
      borderTopStyle: el.style.borderTopStyle ?? 'none',
      borderTopColor: el.style.borderTopColor ?? 'rgba(0, 0, 0, 0)',
    })

    const hits = findMarqueeElements(
      { body },
      { x: 30, y: 30, width: 440, height: 160 },
      VIEWPORT,
      readStyle,
      overlay,
    )
    expect(hits.map((h) => h.id)).toEqual(['btn', 'icon'])
  })
})
