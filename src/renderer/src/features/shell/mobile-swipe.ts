/**
 * Lightweight horizontal swipe gesture detection for switching between the three
 * narrow-screen web panels: left sidebar drawer <-> main area <-> right side panel.
 *
 * The gesture only commits on `touchend` after horizontal displacement exceeds the
 * threshold and clearly dominates vertical movement, stepping at most one panel at a
 * time. Edge starts, multi-touch, text selection, overlays, horizontally scrollable
 * containers, editors, terminals, and interactive canvases/iframes are all ignored.
 */

/** Minimum distance from the left/right viewport edges so browser edge-back gestures stay untouched. */
export const EDGE_GUARD_PX = 24

/** Minimum horizontal travel in pixels required on `touchend` to trigger a panel switch. */
export const SWIPE_THRESHOLD_PX = 64

/** Horizontal travel must be at least this multiple of vertical travel (`|dx| >= |dy| * ratio`). */
export const DIRECTION_RATIO = 1.6

/** Maximum gesture duration in ms so slow drags or long-press selections do not trigger switches. */
export const MAX_SWIPE_DURATION_MS = 900

/** Minimum vertical drift before locking out the gesture as a vertical scroll. */
export const AXIS_LOCK_PX = 14

/** Pixel tolerance when checking whether a container actually overflows horizontally. */
export const SCROLL_EPSILON_PX = 2

/** Finger travel direction: `'right'` is left-to-right (`dx > 0`), `'left'` is right-to-left (`dx < 0`). */
export type SwipeDirection = 'left' | 'right'

/** Current panel state in the narrow three-column model. */
export interface MobileSwipePanelState {
  sidebarDrawer: boolean
  sidePanelOpen: boolean
  canOpenSidePanel: boolean
}

/** Single-step navigation action produced when a swipe gesture commits. */
export type MobileSwipeAction =
  'open-sidebar' | 'close-sidebar' | 'open-side-panel' | 'close-side-panel' | null

/**
 * Resolves the single-step panel transition for a committed horizontal swipe.
 *
 * - Sidebar drawer open: swipe left closes the drawer back to the main area (never jumps to the side panel).
 * - Side panel open: swipe right closes the side panel back to the main area (never jumps to the sidebar).
 * - Main area centered: swipe right opens the sidebar drawer; swipe left opens the side panel only when supported.
 */
export function resolveMobileSwipeAction(
  direction: SwipeDirection,
  state: MobileSwipePanelState,
): MobileSwipeAction {
  if (state.sidebarDrawer) {
    return direction === 'left' ? 'close-sidebar' : null
  }
  if (state.sidePanelOpen) {
    return direction === 'right' ? 'close-side-panel' : null
  }
  if (direction === 'right') {
    return 'open-sidebar'
  }
  return state.canOpenSidePanel ? 'open-side-panel' : null
}

/** Minimal style surface needed for scroll and visibility checks (works with real DOM and fakes). */
export interface ComputedStyleLike {
  overflowX?: string
  display?: string
  visibility?: string
}

/** Minimal element surface inspected during target exemption checks. */
export interface SwipeElementLike {
  readonly nodeType: number
  readonly tagName: string
  readonly parentElement: SwipeElementLike | null
  readonly parentNode?: { readonly nodeType?: number; readonly host?: unknown } | null
  readonly clientWidth?: number
  readonly scrollWidth?: number
  readonly isContentEditable?: boolean
  readonly classList?: { contains(token: string): boolean }
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
  closest?(selector: string): SwipeElementLike | null
  checkVisibility?(options?: { visibilityProperty?: boolean }): boolean
}

/** Minimal touch point surface compatible with browser `Touch` objects and test doubles. */
export interface TouchPointLike {
  readonly identifier: number
  readonly clientX: number
  readonly clientY: number
}

/** Minimal touch event surface compatible with browser `TouchEvent` objects and test doubles. */
export interface TouchEventLike {
  readonly touches: ArrayLike<TouchPointLike>
  readonly changedTouches: ArrayLike<TouchPointLike>
  readonly target: EventTarget | null
  readonly defaultPrevented?: boolean
  composedPath?: () => EventTarget[]
}

/** Minimal selection surface compatible with `window.getSelection()`. */
export interface SelectionLike {
  readonly isCollapsed?: boolean
  toString(): string
}

const EXEMPT_TAGS = new Set([
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'OPTION',
  'CANVAS',
  'IFRAME',
  'DIFFS-CONTAINER',
])

const EXEMPT_CLASSES = [
  'cm-editor',
  'xterm',
  'kp-tscreen',
  'kp-tscreen__xterm',
  'files-diff',
  'avs-content',
  'react-flow',
  'kp-resizer',
  'kp-split-handle',
  'ui-as-cmd',
  'ui-as-popover',
  'ui-as-menu',
  'kettu-settings',
] as const

const EXEMPT_ROLES = new Set(['alertdialog', 'menu', 'menubar', 'listbox', 'slider', 'separator'])

const EXEMPT_SLOTS = new Set([
  'dialog-content',
  'dialog-overlay',
  'alert-dialog-content',
  'alert-dialog-overlay',
  'popover-content',
  'dropdown-menu-content',
  'context-menu-content',
  'select-content',
  'combobox-content',
  'sheet-content',
  'sheet-overlay',
])

const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay'])

const BLOCKING_OVERLAY_SELECTOR = [
  '[role="dialog"]:not(.ui-prc__card)',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-slot="dialog-content"]',
  '[data-slot="alert-dialog-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="context-menu-content"]',
  '[data-slot="select-content"]',
  '[data-slot="combobox-content"]',
  '[data-slot="sheet-content"]',
  '[data-overlay-layer]:not([data-slot="tooltip-content"])',
  '.ui-as-cmd',
  '.ui-as-popover',
].join(', ')

function isElementLike(node: unknown): node is SwipeElementLike {
  return (
    typeof node === 'object' &&
    node !== null &&
    'nodeType' in node &&
    (node as { nodeType: unknown }).nodeType === 1 &&
    'tagName' in node &&
    typeof (node as { tagName: unknown }).tagName === 'string'
  )
}

function hasClass(el: SwipeElementLike, name: string): boolean {
  if (el.classList) return el.classList.contains(name)
  const attr = el.getAttribute('class')
  if (!attr) return false
  return attr.split(/\s+/).includes(name)
}

function defaultGetComputedStyle(el: SwipeElementLike): ComputedStyleLike | null {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null
  try {
    return window.getComputedStyle(el as unknown as Element)
  } catch {
    return null
  }
}

/**
 * Checks whether an element has horizontal overflow and allows horizontal scrolling.
 * Excludes document roots and the frame boundary so page-level quirks do not disable gestures.
 */
export function isHorizontallyScrollable(
  el: SwipeElementLike,
  getComputedStyle: (node: SwipeElementLike) => ComputedStyleLike | null = defaultGetComputedStyle,
): boolean {
  const tag = el.tagName.toUpperCase()
  if (tag === 'HTML' || tag === 'BODY') return false
  const clientWidth = el.clientWidth ?? 0
  const scrollWidth = el.scrollWidth ?? 0
  if (clientWidth <= 0 || scrollWidth <= clientWidth + SCROLL_EPSILON_PX) return false
  const style = getComputedStyle(el)
  if (!style?.overflowX) return false
  return SCROLLABLE_OVERFLOW.has(style.overflowX)
}

function isExemptElement(el: SwipeElementLike): boolean {
  if (el.hasAttribute('data-no-swipe')) return true

  const tag = el.tagName.toUpperCase()
  if (EXEMPT_TAGS.has(tag)) return true

  if (el.isContentEditable === true) return true
  const editable = el.getAttribute('contenteditable')
  if (editable !== null && editable.toLowerCase() !== 'false') return true

  if (
    el.hasAttribute('data-code-editor') ||
    el.hasAttribute('data-terminal') ||
    el.hasAttribute('data-diffs') ||
    el.hasAttribute('data-separator') ||
    el.hasAttribute('data-settings-dialog')
  ) {
    return true
  }

  for (const cls of EXEMPT_CLASSES) {
    if (hasClass(el, cls)) return true
  }

  const slot = el.getAttribute('data-slot')
  if (slot && EXEMPT_SLOTS.has(slot)) return true

  if (
    el.hasAttribute('data-overlay-layer') &&
    slot !== 'tooltip-content' &&
    !el.hasAttribute('data-closed')
  ) {
    return true
  }

  const role = el.getAttribute('role')
  if (role === 'dialog') {
    // Thread permission cards sit inline inside the conversation flow rather than as modal dialogs.
    if (!hasClass(el, 'ui-prc__card')) return true
  } else if (role && EXEMPT_ROLES.has(role)) {
    return true
  }

  return false
}

/** Collects elements from the touch target up through Shadow DOM hosts and light DOM ancestors. */
function collectTargetElements(
  target: EventTarget | null,
  composedPath?: readonly EventTarget[],
  stopAt?: SwipeElementLike | null,
): SwipeElementLike[] {
  const result: SwipeElementLike[] = []
  const seen = new Set<SwipeElementLike>()

  const push = (node: unknown): boolean => {
    if (!isElementLike(node)) return false
    if (stopAt && node === stopAt) return true
    if (!seen.has(node)) {
      seen.add(node)
      result.push(node)
    }
    return false
  }

  if (composedPath && composedPath.length > 0) {
    for (const node of composedPath) {
      if (push(node)) break
    }
  }

  // Always walk ancestors from `target` as well in case `composedPath` was omitted or partial.
  let current: unknown = target
  if (current && typeof current === 'object' && !isElementLike(current)) {
    const asNode = current as {
      parentElement?: unknown
      parentNode?: { nodeType?: number; host?: unknown } | null
    }
    if (isElementLike(asNode.parentElement)) {
      current = asNode.parentElement
    } else if (asNode.parentNode?.nodeType === 11 && isElementLike(asNode.parentNode.host)) {
      current = asNode.parentNode.host
    }
  }
  while (isElementLike(current)) {
    if (stopAt && current === stopAt) break
    if (!seen.has(current)) {
      seen.add(current)
      result.push(current)
    }
    if (current.parentElement) {
      current = current.parentElement
    } else if (current.parentNode?.nodeType === 11 && isElementLike(current.parentNode.host)) {
      // Cross an open ShadowRoot boundary (for example, `@pierre/diffs` custom elements).
      current = current.parentNode.host
    } else {
      break
    }
  }

  return result
}

export interface TargetExemptionOptions {
  composedPath?: readonly EventTarget[]
  stopAt?: SwipeElementLike | null
  getComputedStyle?: (node: SwipeElementLike) => ComputedStyleLike | null
}

/**
 * Returns true when a touch starting on `target` belongs to an editor, terminal,
 * horizontally scrollable region, interactive canvas/iframe, diff block, or overlay.
 */
export function shouldIgnoreSwipeTarget(
  target: EventTarget | null,
  options: TargetExemptionOptions = {},
): boolean {
  const getStyle = options.getComputedStyle ?? defaultGetComputedStyle
  const nodes = collectTargetElements(target, options.composedPath, options.stopAt)
  for (const el of nodes) {
    if (isExemptElement(el)) return true
    if (isHorizontallyScrollable(el, getStyle)) return true
  }
  return false
}

/** Returns true when the user currently has a non-empty text selection. */
export function hasActiveTextSelection(
  getSelection: () => SelectionLike | null = () =>
    typeof window !== 'undefined' && typeof window.getSelection === 'function'
      ? window.getSelection()
      : null,
): boolean {
  const selection = getSelection()
  if (!selection) return false
  if (selection.isCollapsed === true) return false
  return selection.toString().length > 0
}

/** Minimal root surface for querying open blocking overlays in the document. */
export interface OverlayQueryRoot {
  querySelectorAll(selector: string): ArrayLike<SwipeElementLike>
}

function isOverlayVisible(
  el: SwipeElementLike,
  getComputedStyle: (node: SwipeElementLike) => ComputedStyleLike | null,
): boolean {
  if (el.getAttribute('aria-hidden') === 'true') return false
  if (el.closest?.('[inert], [data-closed], [hidden]')) return false
  if (el.hasAttribute('inert') || el.hasAttribute('data-closed') || el.hasAttribute('hidden')) {
    return false
  }
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ visibilityProperty: true })
  }
  const style = getComputedStyle(el)
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false
  return true
}

/**
 * Returns true when a visible dialog, alert dialog, sheet, menu, popover, or other modal
 * overlay is currently open over the workbench.
 */
export function hasBlockingOverlay(
  root: OverlayQueryRoot | null = typeof document !== 'undefined'
    ? (document as unknown as OverlayQueryRoot)
    : null,
  getComputedStyle: (node: SwipeElementLike) => ComputedStyleLike | null = defaultGetComputedStyle,
): boolean {
  if (!root) return false
  const matches = root.querySelectorAll(BLOCKING_OVERLAY_SELECTOR)
  for (let i = 0; i < matches.length; i++) {
    const el = matches[i]
    if (el && isOverlayVisible(el, getComputedStyle)) return true
  }
  return false
}

interface ActiveGesture {
  identifier: number
  startX: number
  startY: number
  startTime: number
}

export interface MobileSwipeTrackerOptions {
  /** Whether swipe navigation is currently enabled (narrow web layout, no blocking modals). */
  isEnabled: () => boolean
  /** Current viewport width in CSS pixels, used for left/right edge-back avoidance. */
  getViewportWidth: () => number
  /** Reads the live three-column state when a gesture commits. */
  getPanelState: () => MobileSwipePanelState
  /** Executes the resolved single-step panel transition. */
  onAction: (action: Exclude<MobileSwipeAction, null>) => void
  /** Boundary element above which target scroll checks stop. */
  stopAt?: () => SwipeElementLike | null
  /** Optional clock override for deterministic tests. */
  now?: () => number
  /** Optional selection override for deterministic tests. */
  getSelection?: () => SelectionLike | null
  /** Optional computed-style override for deterministic tests. */
  getComputedStyle?: (node: SwipeElementLike) => ComputedStyleLike | null
  /** Optional blocking-overlay predicate override. */
  hasBlockingOverlay?: () => boolean
}

export interface MobileSwipeTracker {
  onTouchStart: (event: TouchEventLike) => void
  onTouchMove: (event: TouchEventLike) => void
  onTouchEnd: (event: TouchEventLike) => MobileSwipeAction
  onTouchCancel: () => void
  isTracking: () => boolean
}

function findTouch(
  list: ArrayLike<TouchPointLike>,
  identifier: number,
): TouchPointLike | undefined {
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (item && item.identifier === identifier) return item
  }
  return undefined
}

/**
 * Creates a lightweight single-finger horizontal swipe tracker that only commits
 * on `touchend` after crossing distance, direction-ratio, and timing guards.
 */
export function createMobileSwipeTracker(options: MobileSwipeTrackerOptions): MobileSwipeTracker {
  const now = options.now ?? (() => Date.now())
  const checkOverlay = options.hasBlockingOverlay ?? (() => hasBlockingOverlay())
  let active: ActiveGesture | null = null

  const cancel = (): void => {
    active = null
  }

  const onTouchStart = (event: TouchEventLike): void => {
    // Any multi-touch gesture immediately cancels tracking (including a second finger landing mid-swipe).
    if (event.touches.length !== 1) {
      cancel()
      return
    }
    if (event.defaultPrevented || !options.isEnabled() || checkOverlay()) {
      cancel()
      return
    }
    if (hasActiveTextSelection(options.getSelection)) {
      cancel()
      return
    }

    const touch = event.touches[0]
    if (!touch) {
      cancel()
      return
    }

    const viewportWidth = options.getViewportWidth()
    if (
      viewportWidth <= EDGE_GUARD_PX * 2 ||
      touch.clientX < EDGE_GUARD_PX ||
      touch.clientX > viewportWidth - EDGE_GUARD_PX
    ) {
      cancel()
      return
    }

    const path = typeof event.composedPath === 'function' ? event.composedPath() : undefined
    if (
      shouldIgnoreSwipeTarget(event.target, {
        composedPath: path,
        stopAt: options.stopAt?.() ?? null,
        getComputedStyle: options.getComputedStyle,
      })
    ) {
      cancel()
      return
    }

    active = {
      identifier: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      startTime: now(),
    }
  }

  const onTouchMove = (event: TouchEventLike): void => {
    if (!active) return
    if (event.touches.length !== 1) {
      cancel()
      return
    }
    const touch = findTouch(event.touches, active.identifier)
    if (!touch) {
      cancel()
      return
    }
    if (now() - active.startTime > MAX_SWIPE_DURATION_MS) {
      cancel()
      return
    }
    if (hasActiveTextSelection(options.getSelection)) {
      cancel()
      return
    }
    const dx = Math.abs(touch.clientX - active.startX)
    const dy = Math.abs(touch.clientY - active.startY)
    // Lock out early once vertical scrolling clearly leads so diagonal scroll-ends never fire.
    if (dy >= AXIS_LOCK_PX && dy > dx) {
      cancel()
    }
  }

  const onTouchEnd = (event: TouchEventLike): MobileSwipeAction => {
    if (!active) return null
    const gesture = active
    if (event.touches.length > 0) {
      cancel()
      return null
    }
    const touch = findTouch(event.changedTouches, gesture.identifier)
    cancel()
    if (!touch) return null

    if (event.defaultPrevented || !options.isEnabled() || checkOverlay()) {
      return null
    }
    if (hasActiveTextSelection(options.getSelection)) {
      return null
    }

    const elapsed = now() - gesture.startTime
    if (elapsed < 0 || elapsed > MAX_SWIPE_DURATION_MS) {
      return null
    }

    const dx = touch.clientX - gesture.startX
    const dy = touch.clientY - gesture.startY
    const absX = Math.abs(dx)
    const absY = Math.abs(dy)
    if (absX < SWIPE_THRESHOLD_PX || absX < absY * DIRECTION_RATIO) {
      return null
    }

    const direction: SwipeDirection = dx > 0 ? 'right' : 'left'
    const action = resolveMobileSwipeAction(direction, options.getPanelState())
    if (action) options.onAction(action)
    return action
  }

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel: cancel,
    isTracking: () => active !== null,
  }
}

/** Attaches passive touch listeners to `element` and returns a cleanup function. */
export function attachMobileSwipeListeners(
  element: Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>,
  tracker: MobileSwipeTracker,
): () => void {
  const onStart = (event: Event) => tracker.onTouchStart(event as unknown as TouchEventLike)
  const onMove = (event: Event) => tracker.onTouchMove(event as unknown as TouchEventLike)
  const onEnd = (event: Event) => {
    tracker.onTouchEnd(event as unknown as TouchEventLike)
  }
  const onCancel = () => tracker.onTouchCancel()

  const opts: AddEventListenerOptions = { passive: true }
  element.addEventListener('touchstart', onStart, opts)
  element.addEventListener('touchmove', onMove, opts)
  element.addEventListener('touchend', onEnd, opts)
  element.addEventListener('touchcancel', onCancel, opts)

  return () => {
    tracker.onTouchCancel()
    element.removeEventListener('touchstart', onStart, opts)
    element.removeEventListener('touchmove', onMove, opts)
    element.removeEventListener('touchend', onEnd, opts)
    element.removeEventListener('touchcancel', onCancel, opts)
  }
}
