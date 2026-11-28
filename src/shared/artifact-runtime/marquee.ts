// Pure marquee hit-testing, container filtering, ancestor deduplication, and union-box geometry
// for multi-element selection inside artifact iframes.

import { MAX_MULTI_SELECT, type PageBox } from './page-messages'

export const MARQUEE_MAX = MAX_MULTI_SELECT

/** Tags never selected directly during marquee sweeps. */
const IGNORED_TAGS = new Set([
  'html',
  'body',
  'head',
  'script',
  'style',
  'link',
  'meta',
  'noscript',
  'template',
  'title',
  'base',
  'br',
  'wbr',
  'param',
  'source',
  'track',
  'col',
  'colgroup',
])

/**
 * Interactive or vector elements treated as atomic units: marquee selection picks the element
 * itself rather than its inner icons, spans, or SVG primitives.
 */
const ATOMIC_TAGS = new Set([
  'svg',
  'button',
  'a',
  'select',
  'textarea',
  'input',
  'label',
  'summary',
  'option',
  'img',
  'video',
  'audio',
  'canvas',
  'iframe',
])

/** Structural landmark or collection containers that should yield to matched child components. */
const LANDMARK_CONTAINERS = new Set([
  'main',
  'section',
  'nav',
  'header',
  'footer',
  'aside',
  'ul',
  'ol',
  'dl',
  'table',
  'tbody',
  'thead',
  'tfoot',
  'form',
])

/** Semantic discrete component tags that should not be unwrapped as plain layout wrappers. */
const SEMANTIC_ITEMS = new Set([
  'article',
  'li',
  'tr',
  'figure',
  'blockquote',
  'fieldset',
  'details',
])

/** Fraction of an element's area that must lie inside the marquee to treat it as enclosed. */
const ENCLOSED_COVER = 0.75
/** Pixel tolerance when checking whether a container encloses the entire marquee rectangle. */
const ENCLOSE_EPS = 2

export interface MarqueeCandidate<T> {
  item: T
  tag: string
  rect: PageBox
  /** Index of the nearest candidate ancestor in the candidates array, or -1 if none. */
  parentIndex: number
  /** Whether the element has child elements in the DOM (even if not all children matched). */
  hasChildren: boolean
  /** Whether the element has direct non-whitespace text nodes. */
  hasDirectText: boolean
  /** Whether the element paints its own visible background, border, or shadow surface. */
  hasVisualSurface: boolean
  /** Whether the element is an atomic interactive/media/vector unit. */
  isAtomic: boolean
  /** Original traversal order for deterministic tie-breaking. */
  order: number
}

/** Computes the union bounding box enclosing all non-empty boxes, or null when empty. */
export function unionPageBoxes(boxes: readonly PageBox[]): PageBox | null {
  if (boxes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const box of boxes) {
    if (box.width <= 0 && box.height <= 0) continue
    if (box.x < minX) minX = box.x
    if (box.y < minY) minY = box.y
    if (box.x + box.width > maxX) maxX = box.x + box.width
    if (box.y + box.height > maxY) maxY = box.y + box.height
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function intersectionArea(a: PageBox, b: PageBox): number {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= left || bottom <= top) return 0
  return (right - left) * (bottom - top)
}

function rectsOverlap(a: PageBox, b: PageBox): boolean {
  return intersectionArea(a, b) > 0
}

function encloses(outer: PageBox, inner: PageBox): boolean {
  const outerArea = outer.width * outer.height
  const innerArea = inner.width * inner.height
  if (outerArea <= innerArea * 1.15) return false
  return (
    outer.x <= inner.x + ENCLOSE_EPS &&
    outer.y <= inner.y + ENCLOSE_EPS &&
    outer.x + outer.width >= inner.x + inner.width - ENCLOSE_EPS &&
    outer.y + outer.height >= inner.y + inner.height - ENCLOSE_EPS
  )
}

/**
 * Selects representative, non-nested elements intersecting `marquee` while avoiding whole-page and
 * layout-wrapper containers. Returns items in reading order, capped at `maxCount`.
 */
export function selectMarqueeCandidates<T>(
  candidates: readonly MarqueeCandidate<T>[],
  marquee: PageBox,
  viewport: { width: number; height: number },
  maxCount = MARQUEE_MAX,
): T[] {
  const marqueeArea = marquee.width * marquee.height
  if (marqueeArea <= 0 || candidates.length === 0 || maxCount <= 0) return []
  const viewportArea = Math.max(1, viewport.width * viewport.height)

  interface NodeInfo {
    index: number
    candidate: MarqueeCandidate<T>
    area: number
    interArea: number
    coverEl: number
    enclosesMarquee: boolean
    depth: number
    matchedChildren: number[]
    hasMatchedDescendant: boolean
    drilledDown: boolean
  }

  // First pass: keep only candidates whose rect intersects the marquee with positive area.
  const matched = new Map<number, NodeInfo>()
  const depthMemo = new Map<number, number>()
  const depthOf = (idx: number): number => {
    const cached = depthMemo.get(idx)
    if (cached !== undefined) return cached
    const parent = candidates[idx]?.parentIndex ?? -1
    const d = parent >= 0 && parent !== idx ? depthOf(parent) + 1 : 0
    depthMemo.set(idx, d)
    return d
  }

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!
    const area = candidate.rect.width * candidate.rect.height
    if (area < 1) continue
    const interArea = intersectionArea(candidate.rect, marquee)
    if (interArea <= 0) continue
    matched.set(i, {
      index: i,
      candidate,
      area,
      interArea,
      coverEl: interArea / area,
      enclosesMarquee: encloses(candidate.rect, marquee),
      depth: depthOf(i),
      matchedChildren: [],
      hasMatchedDescendant: false,
      drilledDown: false,
    })
  }

  if (matched.size === 0) return []

  // Link each matched node to its nearest matched ancestor.
  for (const node of matched.values()) {
    let up = node.candidate.parentIndex
    while (up >= 0) {
      const ancestor = matched.get(up)
      if (ancestor) {
        ancestor.matchedChildren.push(node.index)
        ancestor.hasMatchedDescendant = true
        break
      }
      const next = candidates[up]?.parentIndex ?? -1
      if (next === up) break
      up = next
    }
  }

  // Mark every ancestor above a matched descendant.
  const byDepthDesc = [...matched.values()].sort((a, b) => b.depth - a.depth)
  for (const node of byDepthDesc) {
    if (!node.hasMatchedDescendant) continue
    let up = node.candidate.parentIndex
    while (up >= 0) {
      const ancestor = matched.get(up)
      if (ancestor) {
        ancestor.hasMatchedDescendant = true
        break
      }
      const next = candidates[up]?.parentIndex ?? -1
      if (next === up) break
      up = next
    }
  }

  // Decide which containers should yield (drill down) to their matched descendants vs stay intact.
  const excluded = new Set<number>()
  for (const node of matched.values()) {
    const { candidate } = node
    if (candidate.isAtomic) continue

    if (node.hasMatchedDescendant) {
      // 1. Container encloses the marquee (user dragged inside it) -> always drill down.
      if (node.enclosesMarquee) {
        node.drilledDown = true
        excluded.add(node.index)
        continue
      }
      // 2. Container is only partially intersected -> drill down to the matched items inside.
      if (node.coverEl < ENCLOSED_COVER) {
        node.drilledDown = true
        excluded.add(node.index)
        continue
      }
      // 3. Large page-scale container holding multiple matched items -> drill down.
      if (node.area >= viewportArea * 0.65 && node.matchedChildren.length >= 2) {
        node.drilledDown = true
        excluded.add(node.index)
        continue
      }
      // 4. Landmark or list containers (main, section, ul, nav, ...) yield to enclosed child items.
      if (
        LANDMARK_CONTAINERS.has(candidate.tag) &&
        node.matchedChildren.some((ci) => (matched.get(ci)?.coverEl ?? 0) >= ENCLOSED_COVER)
      ) {
        node.drilledDown = true
        excluded.add(node.index)
        continue
      }
      // 5. Plain transparent layout wrapper (no direct text, no visual surface, not a semantic item).
      if (
        !candidate.hasDirectText &&
        !candidate.hasVisualSurface &&
        !SEMANTIC_ITEMS.has(candidate.tag)
      ) {
        node.drilledDown = true
        excluded.add(node.index)
        continue
      }
      // 6. Styled container holding >= 2 discrete enclosed peer components (cards or controls)
      //    so sweeping across a card strip or button bar picks those peers instead of the bar.
      if (!candidate.hasDirectText && !SEMANTIC_ITEMS.has(candidate.tag)) {
        const discretePeers = node.matchedChildren
          .map((ci) => matched.get(ci)!)
          .filter(
            (child) =>
              child.coverEl >= ENCLOSED_COVER &&
              (child.candidate.isAtomic ||
                child.candidate.hasChildren ||
                child.candidate.hasVisualSurface ||
                SEMANTIC_ITEMS.has(child.candidate.tag)),
          )
        if (discretePeers.length >= 2) {
          let overlapping = false
          for (let a = 0; a < discretePeers.length && !overlapping; a++) {
            for (let b = a + 1; b < discretePeers.length; b++) {
              if (
                rectsOverlap(discretePeers[a]!.candidate.rect, discretePeers[b]!.candidate.rect)
              ) {
                overlapping = true
                break
              }
            }
          }
          if (!overlapping) {
            node.drilledDown = true
            excluded.add(node.index)
            continue
          }
        }
      }
    } else if (node.enclosesMarquee) {
      // Sweeping across empty whitespace inside a large background container should select nothing.
      if (
        node.area > marqueeArea * 3 &&
        (candidate.hasChildren ||
          LANDMARK_CONTAINERS.has(candidate.tag) ||
          node.area >= viewportArea * 0.4)
      ) {
        excluded.add(node.index)
      }
    }
  }

  // Ancestor-descendant deduplication: keep outermost surviving nodes so no pair nests.
  const kept: NodeInfo[] = []
  const keptIndices = new Set<number>()
  const byDepthAsc = [...matched.values()].sort(
    (a, b) => a.depth - b.depth || a.candidate.order - b.candidate.order,
  )

  for (const node of byDepthAsc) {
    if (excluded.has(node.index)) continue
    let ancestorKept = false
    let up = node.candidate.parentIndex
    while (up >= 0) {
      if (keptIndices.has(up)) {
        ancestorKept = true
        break
      }
      const next = candidates[up]?.parentIndex ?? -1
      if (next === up) break
      up = next
    }
    if (ancestorKept) continue
    keptIndices.add(node.index)
    kept.push(node)
  }

  // Sort in visual reading order (top-to-bottom rows, left-to-right within the same row).
  kept.sort((a, b) => {
    const ra = a.candidate.rect
    const rb = b.candidate.rect
    const overlapY = Math.min(ra.y + ra.height, rb.y + rb.height) - Math.max(ra.y, rb.y)
    const minH = Math.min(ra.height, rb.height)
    if (minH > 0 && overlapY > minH * 0.5) {
      if (Math.abs(ra.x - rb.x) > 2) return ra.x - rb.x
    } else if (Math.abs(ra.y - rb.y) > 2) {
      return ra.y - rb.y
    }
    return a.candidate.order - b.candidate.order
  })

  return kept.slice(0, maxCount).map((n) => n.candidate.item)
}

function isOpaqueColor(color: string | undefined): boolean {
  if (!color || color === 'transparent' || color === 'none') return false
  const rgba = /^rgba?\(\s*[\d.]+[,\s]+[\d.]+[,\s]+[\d.]+(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
    color.trim(),
  )
  if (!rgba) return true
  if (rgba[1] === undefined) return true
  const alpha = rgba[1].endsWith('%') ? parseFloat(rgba[1]) / 100 : parseFloat(rgba[1])
  return Number.isFinite(alpha) && alpha > 0.02
}

export interface MarqueeComputedStyle {
  display?: string
  visibility?: string
  opacity?: string
  pointerEvents?: string
  backgroundColor?: string
  boxShadow?: string
  borderTopWidth?: string
  borderTopStyle?: string
  borderTopColor?: string
  borderRightWidth?: string
  borderRightStyle?: string
  borderRightColor?: string
  borderBottomWidth?: string
  borderBottomStyle?: string
  borderBottomColor?: string
  borderLeftWidth?: string
  borderLeftStyle?: string
  borderLeftColor?: string
}

export interface MarqueeDomRect {
  left: number
  top: number
  width: number
  height: number
}

export interface MarqueeDomNode {
  nodeType: number
  nodeValue?: string | null
}

export interface MarqueeDomElement {
  readonly localName: string
  readonly parentElement: MarqueeDomElement | null
  readonly children: ArrayLike<MarqueeDomElement>
  readonly childNodes: ArrayLike<MarqueeDomNode>
  readonly childElementCount: number
  getBoundingClientRect(): MarqueeDomRect
}

export interface MarqueeDomDocument<E extends MarqueeDomElement = MarqueeDomElement> {
  readonly body: E | null
}

function hasVisibleBorder(css: MarqueeComputedStyle): boolean {
  const sides = [
    [css.borderTopWidth, css.borderTopStyle, css.borderTopColor],
    [css.borderRightWidth, css.borderRightStyle, css.borderRightColor],
    [css.borderBottomWidth, css.borderBottomStyle, css.borderBottomColor],
    [css.borderLeftWidth, css.borderLeftStyle, css.borderLeftColor],
  ] as const
  for (const [width, style, color] of sides) {
    if (!style || style === 'none' || style === 'hidden') continue
    const px = parseFloat(width || '0')
    if (px > 0 && (color === undefined || color === '' || isOpaqueColor(color))) return true
  }
  return false
}

function hasDirectTextContent(element: MarqueeDomElement): boolean {
  const nodes = element.childNodes
  if (!nodes || nodes.length === 0) return false
  for (let i = 0; i < nodes.length; i++) {
    const child = nodes[i]
    if (child && child.nodeType === 3 && (child.nodeValue ?? '').trim().length > 0) return true
  }
  return false
}

function collectElements<E extends MarqueeDomElement>(root: E, exclude?: E | null): E[] {
  const out: E[] = []
  const stack: E[] = []
  const pushChildren = (el: E): void => {
    const children = el.children
    if (!children) return
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i] as E | undefined
      if (child) stack.push(child)
    }
  }
  pushChildren(root)
  while (stack.length > 0) {
    const el = stack.pop()!
    if (el === exclude) continue
    const tag = el.localName.toLowerCase()
    if (IGNORED_TAGS.has(tag)) continue
    out.push(el)
    // Do not descend into atomic controls or SVG internals.
    if (!ATOMIC_TAGS.has(tag)) pushChildren(el)
  }
  return out
}

/**
 * Finds all representative visible DOM elements inside `doc.body` matched by `marquee`
 * (viewport CSS pixels), skipping `exclude` (the runtime overlay host).
 */
export function findMarqueeElements<E extends MarqueeDomElement>(
  doc: MarqueeDomDocument<E>,
  marquee: PageBox,
  viewport: { width: number; height: number },
  getStyle?: ((element: E) => MarqueeComputedStyle | null) | null,
  exclude?: E | null,
  maxCount = MARQUEE_MAX,
): E[] {
  const body = doc.body
  if (!body || marquee.width <= 0 || marquee.height <= 0) return []

  const raw = collectElements(body, exclude)
  if (raw.length === 0) return []

  const readStyle = getStyle ?? null
  const bodyBg = readStyle ? readStyle(body)?.backgroundColor : undefined
  const indexByElement = new Map<E, number>()
  const candidates: MarqueeCandidate<E>[] = []

  for (let i = 0; i < raw.length; i++) {
    const el = raw[i]!
    const tag = el.localName.toLowerCase()
    const css = readStyle ? readStyle(el) : null
    if (css) {
      if (
        css.display === 'none' ||
        css.visibility === 'hidden' ||
        css.visibility === 'collapse' ||
        css.pointerEvents === 'none'
      ) {
        continue
      }
      if (css.opacity !== undefined && css.opacity !== '' && parseFloat(css.opacity) <= 0) continue
    }
    const rect = el.getBoundingClientRect()
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) continue
    if (rect.width < 1 || rect.height < 1) continue

    let parentIndex = -1
    let up = el.parentElement as E | null
    while (up && up !== body) {
      const found = indexByElement.get(up)
      if (found !== undefined) {
        parentIndex = found
        break
      }
      up = up.parentElement as E | null
    }

    const bg = css?.backgroundColor
    const hasBg = isOpaqueColor(bg) && (!bodyBg || bg !== bodyBg)
    const hasShadow = !!css?.boxShadow && css.boxShadow !== 'none'
    const hasVisualSurface = hasBg || hasShadow || (css !== null && hasVisibleBorder(css))

    const idx = candidates.length
    indexByElement.set(el, idx)
    candidates.push({
      item: el,
      tag,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      parentIndex,
      hasChildren: el.childElementCount > 0,
      hasDirectText: hasDirectTextContent(el),
      hasVisualSurface,
      isAtomic: ATOMIC_TAGS.has(tag),
      order: idx,
    })
  }

  return selectMarqueeCandidates(candidates, marquee, viewport, maxCount)
}
