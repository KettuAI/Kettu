import { OVERLAY_LAYER } from '@renderer/stores/overlays'

export interface RectLike {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

const OVERLAY_SELECTOR = `[${OVERLAY_LAYER}]`
const POSITION_ATTRS = ['style', 'class', 'data-side', 'data-align', 'data-closed', OVERLAY_LAYER]
const TREE_ATTRS = [OVERLAY_LAYER, 'data-closed']
// Floating UI / Base UI places `transform` on the Positioner wrapping the Popup, and drag overlays
// move a wrapper around the chip. Walk up at most two non-document ancestors to catch both.
const MAX_ANCESTOR_DEPTH = 2

/** Whether two non-empty rectangles intersect. */
export function rectOverlaps(a: RectLike, b: RectLike): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)
}

/** Whether any open overlay layer currently overlaps the browser page area. */
export function covers(area: Element, root: ParentNode = document): boolean {
  const bounds = area.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) return false
  for (const overlay of root.querySelectorAll(OVERLAY_SELECTOR)) {
    if (overlay.closest('[data-closed]')) continue
    if (rectOverlaps(overlay.getBoundingClientRect(), bounds)) return true
  }
  return false
}

function isDocumentContainer(node: Element, root: ParentNode): boolean {
  if (node === root) return true
  const owner = node.ownerDocument
  return node === owner?.body || node === owner?.documentElement
}

function collectPositionTargets(overlays: Iterable<Element>, root: ParentNode): Set<Element> {
  const targets = new Set<Element>()
  for (const overlay of overlays) {
    targets.add(overlay)
    let ancestor = overlay.parentElement
    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && ancestor; depth++) {
      if (isDocumentContainer(ancestor, root)) break
      targets.add(ancestor)
      ancestor = ancestor.parentElement
    }
  }
  return targets
}

function nodeHasOverlay(node: Node): boolean {
  if (node.nodeType !== 1) return false
  const element = node as Element
  return element.hasAttribute(OVERLAY_LAYER) || element.querySelector(OVERLAY_SELECTOR) !== null
}

function sameElements(a: ReadonlySet<Element>, b: ReadonlySet<Element>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) if (!b.has(item)) return false
  return true
}

export interface ObserveOverlayGeometryOptions {
  root?: ParentNode
  ResizeObserver?: typeof ResizeObserver
  MutationObserver?: typeof MutationObserver
}

/**
 * Watches mounted overlay layers for mounts, unmounts, resizes, and positioner style/attribute
 * updates while at least one overlay is open, invoking `onChange` so the browser pane can re-check
 * whether any overlay overlaps its native WebContentsView.
 */
export function observeOverlayGeometry(
  onChange: () => void,
  options?: ObserveOverlayGeometryOptions,
): () => void {
  const doc = typeof document === 'undefined' ? null : document
  const root = options?.root ?? doc?.body ?? doc?.documentElement ?? null
  if (!root) return () => {}

  const ResizeObserverCtor =
    options?.ResizeObserver ?? (typeof ResizeObserver === 'undefined' ? null : ResizeObserver)
  const MutationObserverCtor =
    options?.MutationObserver ?? (typeof MutationObserver === 'undefined' ? null : MutationObserver)

  let trackedOverlays = new Set<Element>()
  let trackedPositioners = new Set<Element>()

  const resizeObserver = ResizeObserverCtor ? new ResizeObserverCtor(() => onChange()) : null
  const positionObserver = MutationObserverCtor ? new MutationObserverCtor(() => onChange()) : null

  const sync = (): void => {
    const nextOverlays = new Set<Element>(root.querySelectorAll(OVERLAY_SELECTOR))
    if (resizeObserver) {
      for (const prev of trackedOverlays) {
        if (!nextOverlays.has(prev)) resizeObserver.unobserve(prev)
      }
      for (const next of nextOverlays) {
        if (!trackedOverlays.has(next)) resizeObserver.observe(next)
      }
    }
    trackedOverlays = nextOverlays

    if (positionObserver) {
      const nextPositioners = collectPositionTargets(nextOverlays, root)
      if (!sameElements(trackedPositioners, nextPositioners)) {
        positionObserver.disconnect()
        for (const target of nextPositioners) {
          positionObserver.observe(target, {
            attributes: true,
            attributeFilter: POSITION_ATTRS,
          })
        }
        trackedPositioners = nextPositioners
      }
    }
  }

  sync()

  const treeObserver = MutationObserverCtor
    ? new MutationObserverCtor((mutations) => {
        let relevant = false
        for (const mutation of mutations) {
          if (mutation.type === 'attributes') {
            relevant = true
            break
          }
          for (const node of mutation.addedNodes) {
            if (nodeHasOverlay(node)) {
              relevant = true
              break
            }
          }
          if (relevant) break
          for (const node of mutation.removedNodes) {
            if (nodeHasOverlay(node)) {
              relevant = true
              break
            }
          }
          if (relevant) break
        }
        if (!relevant) {
          for (const overlay of trackedOverlays) {
            if (!overlay.isConnected) {
              relevant = true
              break
            }
          }
        }
        if (!relevant) return
        sync()
        onChange()
      })
    : null

  treeObserver?.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: TREE_ATTRS,
  })

  return () => {
    treeObserver?.disconnect()
    positionObserver?.disconnect()
    resizeObserver?.disconnect()
    trackedOverlays.clear()
    trackedPositioners.clear()
  }
}
