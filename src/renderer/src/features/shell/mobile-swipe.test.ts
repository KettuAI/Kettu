import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/agent-host'
import { createLayout } from '@renderer/features/split/layout'
import {
  AXIS_LOCK_PX,
  DIRECTION_RATIO,
  EDGE_GUARD_PX,
  MAX_SWIPE_DURATION_MS,
  SWIPE_THRESHOLD_PX,
  attachMobileSwipeListeners,
  createMobileSwipeTracker,
  hasActiveTextSelection,
  hasBlockingOverlay,
  isHorizontallyScrollable,
  resolveMobileSwipeAction,
  shouldIgnoreSwipeTarget,
  type ComputedStyleLike,
  type MobileSwipeAction,
  type MobileSwipePanelState,
  type SelectionLike,
  type SwipeElementLike,
  type TouchEventLike,
  type TouchPointLike,
} from './mobile-swipe'

class FakeElement implements SwipeElementLike {
  readonly nodeType = 1
  readonly tagName: string
  parentElement: FakeElement | null = null
  parentNode: { readonly nodeType?: number; readonly host?: unknown } | null = null
  children: FakeElement[] = []
  attrs = new Map<string, string>()
  classes = new Set<string>()
  clientWidth: number
  scrollWidth: number
  isContentEditable = false
  style: ComputedStyleLike = {}
  visible = true

  constructor(
    tagName = 'DIV',
    options: {
      classes?: string[]
      attrs?: Record<string, string>
      clientWidth?: number
      scrollWidth?: number
      style?: ComputedStyleLike
      isContentEditable?: boolean
      visible?: boolean
    } = {},
  ) {
    this.tagName = tagName.toUpperCase()
    this.clientWidth = options.clientWidth ?? 375
    this.scrollWidth = options.scrollWidth ?? this.clientWidth
    this.style = options.style ?? {}
    this.isContentEditable = options.isContentEditable ?? false
    this.visible = options.visible ?? true
    for (const cls of options.classes ?? []) this.classes.add(cls)
    for (const [k, v] of Object.entries(options.attrs ?? {})) this.attrs.set(k, v)
  }

  readonly classList = {
    contains: (token: string): boolean => this.classes.has(token),
  }

  append(child: FakeElement): FakeElement {
    child.parentElement = this
    child.parentNode = this
    this.children.push(child)
    return child
  }

  getAttribute(name: string): string | null {
    if (name === 'class') return [...this.classes].join(' ') || null
    return this.attrs.get(name) ?? null
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }

  closest(selector: string): FakeElement | null {
    const parts = selector.split(',').map((part) => part.trim())
    if (parts.some((part) => this.matchesSimple(part))) return this
    let cur = this.parentElement
    while (cur) {
      if (parts.some((part) => cur!.matchesSimple(part))) return cur
      cur = cur.parentElement
    }
    return null
  }

  checkVisibility(): boolean {
    return this.visible && this.style.display !== 'none' && this.style.visibility !== 'hidden'
  }

  matchesSimple(selector: string): boolean {
    const attrMatch = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/)
    if (attrMatch) {
      const [, attr, value] = attrMatch
      if (!attr) return false
      if (value === undefined) return this.hasAttribute(attr)
      return this.getAttribute(attr) === value
    }
    if (selector.startsWith('.')) return this.classes.has(selector.slice(1))
    return false
  }
}

function makeTouch(clientX: number, clientY: number, identifier = 1): TouchPointLike {
  return { identifier, clientX, clientY }
}

function makeTouchEvent(options: {
  touches?: TouchPointLike[]
  changedTouches?: TouchPointLike[]
  target?: EventTarget | null
  defaultPrevented?: boolean
  composedPath?: EventTarget[]
}): TouchEventLike {
  return {
    touches: options.touches ?? [],
    changedTouches: options.changedTouches ?? options.touches ?? [],
    target: options.target ?? null,
    defaultPrevented: options.defaultPrevented ?? false,
    ...(options.composedPath ? { composedPath: () => options.composedPath! } : {}),
  }
}

describe('resolveMobileSwipeAction (three-column single-step state machine)', () => {
  it('opens the sidebar drawer on swipe right from the centered main area', () => {
    const state: MobileSwipePanelState = {
      sidebarDrawer: false,
      sidePanelOpen: false,
      canOpenSidePanel: true,
    }
    expect(resolveMobileSwipeAction('right', state)).toBe('open-sidebar')
  })

  it('opens the right side panel on swipe left from the main area only when supported', () => {
    expect(
      resolveMobileSwipeAction('left', {
        sidebarDrawer: false,
        sidePanelOpen: false,
        canOpenSidePanel: true,
      }),
    ).toBe('open-side-panel')

    expect(
      resolveMobileSwipeAction('left', {
        sidebarDrawer: false,
        sidePanelOpen: false,
        canOpenSidePanel: false,
      }),
    ).toBeNull()
  })

  it('closes the sidebar drawer back to main on swipe left and never skips to the side panel', () => {
    const drawerState: MobileSwipePanelState = {
      sidebarDrawer: true,
      sidePanelOpen: false,
      canOpenSidePanel: true,
    }
    expect(resolveMobileSwipeAction('left', drawerState)).toBe('close-sidebar')
    expect(resolveMobileSwipeAction('right', drawerState)).toBeNull()

    // Even if a side panel is also open behind the drawer, swipe left only closes the drawer.
    expect(
      resolveMobileSwipeAction('left', {
        sidebarDrawer: true,
        sidePanelOpen: true,
        canOpenSidePanel: true,
      }),
    ).toBe('close-sidebar')
  })

  it('closes the right side panel back to main on swipe right and never skips to the sidebar', () => {
    const rightState: MobileSwipePanelState = {
      sidebarDrawer: false,
      sidePanelOpen: true,
      canOpenSidePanel: true,
    }
    expect(resolveMobileSwipeAction('right', rightState)).toBe('close-side-panel')
    expect(resolveMobileSwipeAction('left', rightState)).toBeNull()
  })

  it('walks symmetrically across all three columns one column per swipe', () => {
    let state: MobileSwipePanelState = {
      sidebarDrawer: false,
      sidePanelOpen: false,
      canOpenSidePanel: true,
    }
    const apply = (direction: 'left' | 'right'): MobileSwipeAction => {
      const action = resolveMobileSwipeAction(direction, state)
      if (action === 'open-sidebar') state = { ...state, sidebarDrawer: true }
      if (action === 'close-sidebar') state = { ...state, sidebarDrawer: false }
      if (action === 'open-side-panel') state = { ...state, sidePanelOpen: true }
      if (action === 'close-side-panel') state = { ...state, sidePanelOpen: false }
      return action
    }

    expect(apply('right')).toBe('open-sidebar')
    expect(state).toMatchObject({ sidebarDrawer: true, sidePanelOpen: false })
    expect(apply('left')).toBe('close-sidebar')
    expect(state).toMatchObject({ sidebarDrawer: false, sidePanelOpen: false })
    expect(apply('left')).toBe('open-side-panel')
    expect(state).toMatchObject({ sidebarDrawer: false, sidePanelOpen: true })
    expect(apply('right')).toBe('close-side-panel')
    expect(state).toMatchObject({ sidebarDrawer: false, sidePanelOpen: false })
  })
})

describe('shouldIgnoreSwipeTarget and exemption rules', () => {
  const getStyle = (node: SwipeElementLike): ComputedStyleLike | null => (node as FakeElement).style

  it('allows plain conversation content and non-overflowing blocks', () => {
    const frame = new FakeElement('DIV')
    const message = frame.append(new FakeElement('DIV'))
    const paragraph = message.append(new FakeElement('P'))
    const shortCode = message.append(
      new FakeElement('PRE', {
        clientWidth: 320,
        scrollWidth: 321,
        style: { overflowX: 'auto' },
      }),
    )

    expect(
      shouldIgnoreSwipeTarget(paragraph as unknown as EventTarget, {
        stopAt: frame,
        getComputedStyle: getStyle,
      }),
    ).toBe(false)

    // Within the 2px tolerance, a short code block is not horizontally scrollable.
    expect(isHorizontallyScrollable(shortCode, getStyle)).toBe(false)
    expect(
      shouldIgnoreSwipeTarget(shortCode as unknown as EventTarget, {
        stopAt: frame,
        getComputedStyle: getStyle,
      }),
    ).toBe(false)
  })

  it('exempts horizontally scrollable code blocks, wide tables, and tab strips', () => {
    const frame = new FakeElement('DIV')
    const pre = frame.append(
      new FakeElement('PRE', {
        clientWidth: 320,
        scrollWidth: 680,
        style: { overflowX: 'auto' },
      }),
    )
    const codeSpan = pre.append(new FakeElement('SPAN'))

    const tableWrap = frame.append(
      new FakeElement('DIV', {
        clientWidth: 320,
        scrollWidth: 540,
        style: { overflowX: 'scroll' },
      }),
    )
    const td = tableWrap.append(new FakeElement('TD'))

    const tabStrip = frame.append(
      new FakeElement('DIV', {
        classes: ['kp-stabs'],
        clientWidth: 260,
        scrollWidth: 420,
        style: { overflowX: 'auto' },
      }),
    )
    const tabBtn = tabStrip.append(new FakeElement('BUTTON'))

    for (const target of [codeSpan, td, tabBtn]) {
      expect(
        shouldIgnoreSwipeTarget(target as unknown as EventTarget, {
          stopAt: frame,
          getComputedStyle: getStyle,
        }),
      ).toBe(true)
    }
  })

  it('ignores horizontal overflow on the frame boundary itself or document roots', () => {
    const html = new FakeElement('HTML', {
      clientWidth: 375,
      scrollWidth: 420,
      style: { overflowX: 'auto' },
    })
    const body = html.append(
      new FakeElement('BODY', {
        clientWidth: 375,
        scrollWidth: 420,
        style: { overflowX: 'auto' },
      }),
    )
    const frame = body.append(
      new FakeElement('DIV', {
        clientWidth: 375,
        scrollWidth: 420,
        style: { overflowX: 'auto' },
      }),
    )
    const leaf = frame.append(new FakeElement('DIV'))

    expect(isHorizontallyScrollable(html, getStyle)).toBe(false)
    expect(isHorizontallyScrollable(body, getStyle)).toBe(false)
    expect(
      shouldIgnoreSwipeTarget(leaf as unknown as EventTarget, {
        stopAt: frame,
        getComputedStyle: getStyle,
      }),
    ).toBe(false)
  })

  it('exempts inputs, textareas, CodeMirror editors, and contenteditable regions', () => {
    const frame = new FakeElement('DIV')
    const input = frame.append(new FakeElement('INPUT'))
    const textarea = frame.append(new FakeElement('TEXTAREA'))
    const cmEditor = frame.append(new FakeElement('DIV', { classes: ['cm-editor'] }))
    const cmLine = cmEditor.append(new FakeElement('DIV'))
    const codeEditor = frame.append(new FakeElement('DIV', { attrs: { 'data-code-editor': '' } }))
    const editable = frame.append(new FakeElement('DIV', { attrs: { contenteditable: 'true' } }))
    const editableChild = editable.append(new FakeElement('SPAN'))
    const nonEditable = frame.append(
      new FakeElement('DIV', { attrs: { contenteditable: 'false' } }),
    )

    for (const target of [input, textarea, cmLine, codeEditor, editableChild]) {
      expect(
        shouldIgnoreSwipeTarget(target as unknown as EventTarget, {
          stopAt: frame,
          getComputedStyle: getStyle,
        }),
      ).toBe(true)
    }
    expect(
      shouldIgnoreSwipeTarget(nonEditable as unknown as EventTarget, {
        stopAt: frame,
        getComputedStyle: getStyle,
      }),
    ).toBe(false)
  })

  it('exempts xterm terminals, diff blocks (including Shadow DOM), canvases, iframes, and artifact stages', () => {
    const frame = new FakeElement('DIV')

    const xterm = frame.append(new FakeElement('DIV', { classes: ['xterm'] }))
    const xtermRow = xterm.append(new FakeElement('DIV'))

    const terminalAttr = frame.append(new FakeElement('DIV', { attrs: { 'data-terminal': '' } }))
    const terminalChild = terminalAttr.append(new FakeElement('DIV'))

    const diffHost = frame.append(new FakeElement('DIFFS-CONTAINER'))
    const shadowScroller = new FakeElement('DIV', {
      clientWidth: 320,
      scrollWidth: 700,
      style: { overflowX: 'auto' },
    })
    shadowScroller.parentNode = { nodeType: 11, host: diffHost }
    const shadowLine = shadowScroller.append(new FakeElement('SPAN'))

    const canvas = frame.append(new FakeElement('CANVAS'))
    const iframe = frame.append(new FakeElement('IFRAME'))
    const artifactStage = frame.append(new FakeElement('DIV', { classes: ['avs-content'] }))
    const artifactChild = artifactStage.append(new FakeElement('DIV'))
    const reactFlow = frame.append(new FakeElement('DIV', { classes: ['react-flow'] }))
    const reactFlowPane = reactFlow.append(new FakeElement('DIV'))

    for (const target of [
      xtermRow,
      terminalChild,
      shadowLine,
      canvas,
      iframe,
      artifactChild,
      reactFlowPane,
    ]) {
      expect(
        shouldIgnoreSwipeTarget(target as unknown as EventTarget, {
          stopAt: frame,
          getComputedStyle: getStyle,
        }),
      ).toBe(true)
    }

    // ComposedPath inside a shadow tree is also honored when event.target is retargeted to host.
    const genericHost = frame.append(new FakeElement('DIV'))
    const shadowInnerScroll = new FakeElement('DIV', {
      clientWidth: 300,
      scrollWidth: 640,
      style: { overflowX: 'auto' },
    })
    expect(
      shouldIgnoreSwipeTarget(genericHost as unknown as EventTarget, {
        composedPath: [
          shadowInnerScroll as unknown as EventTarget,
          genericHost as unknown as EventTarget,
          frame as unknown as EventTarget,
        ],
        stopAt: frame,
        getComputedStyle: getStyle,
      }),
    ).toBe(true)
  })

  it('exempts dialogs, popovers, dropdown menus, context menus, and sheets while allowing inline permission cards', () => {
    const frame = new FakeElement('DIV')
    const dialog = frame.append(new FakeElement('DIV', { attrs: { role: 'dialog' } }))
    const dialogBody = dialog.append(new FakeElement('DIV'))
    const popover = frame.append(
      new FakeElement('DIV', { attrs: { 'data-slot': 'popover-content' } }),
    )
    const contextMenu = frame.append(
      new FakeElement('DIV', { attrs: { 'data-slot': 'context-menu-content' } }),
    )
    const sheet = frame.append(new FakeElement('DIV', { attrs: { 'data-slot': 'sheet-content' } }))
    const overlayLayer = frame.append(
      new FakeElement('DIV', { attrs: { 'data-overlay-layer': '' } }),
    )
    const permissionCard = frame.append(
      new FakeElement('DIV', { classes: ['ui-prc__card'], attrs: { role: 'dialog' } }),
    )
    const permissionText = permissionCard.append(new FakeElement('P'))

    for (const target of [dialogBody, popover, contextMenu, sheet, overlayLayer]) {
      expect(
        shouldIgnoreSwipeTarget(target as unknown as EventTarget, {
          stopAt: frame,
          getComputedStyle: getStyle,
        }),
      ).toBe(true)
    }

    expect(
      shouldIgnoreSwipeTarget(permissionText as unknown as EventTarget, {
        stopAt: frame,
        getComputedStyle: getStyle,
      }),
    ).toBe(false)
  })

  it('detects visible blocking overlays and ignores closed, inert, or hidden ones', () => {
    const openDialog = new FakeElement('DIV', {
      attrs: { role: 'dialog', 'data-overlay-layer': '' },
    })
    const closedPopover = new FakeElement('DIV', {
      attrs: { 'data-slot': 'popover-content', 'data-closed': '' },
    })
    const inertWrapper = new FakeElement('DIV', { attrs: { inert: '' } })
    const inertMenu = inertWrapper.append(new FakeElement('DIV', { attrs: { role: 'menu' } }))
    const hiddenSheet = new FakeElement('DIV', {
      attrs: { 'data-slot': 'sheet-content' },
      visible: false,
    })

    expect(
      hasBlockingOverlay(
        { querySelectorAll: () => [openDialog] },
        (el) => (el as FakeElement).style,
      ),
    ).toBe(true)
    expect(
      hasBlockingOverlay(
        { querySelectorAll: () => [closedPopover, inertMenu, hiddenSheet] },
        (el) => (el as FakeElement).style,
      ),
    ).toBe(false)
  })
})

describe('createMobileSwipeTracker (thresholds, guards, and lifecycle)', () => {
  function setup(
    overrides: Partial<{
      enabled: boolean
      viewportWidth: number
      panelState: MobileSwipePanelState
      selectionText: string
      selectionCollapsed: boolean
      overlayOpen: boolean
    }> = {},
  ) {
    let now = 1000
    let enabled = overrides.enabled ?? true
    let viewportWidth = overrides.viewportWidth ?? 390
    let panelState: MobileSwipePanelState = overrides.panelState ?? {
      sidebarDrawer: false,
      sidePanelOpen: false,
      canOpenSidePanel: true,
    }
    let selectionText = overrides.selectionText ?? ''
    let selectionCollapsed = overrides.selectionCollapsed ?? false
    let overlayOpen = overrides.overlayOpen ?? false
    const frame = new FakeElement('DIV')
    const content = frame.append(new FakeElement('DIV'))
    const actions: MobileSwipeAction[] = []

    const tracker = createMobileSwipeTracker({
      isEnabled: () => enabled,
      getViewportWidth: () => viewportWidth,
      getPanelState: () => panelState,
      onAction: (action) => {
        actions.push(action)
        if (action === 'open-sidebar') panelState = { ...panelState, sidebarDrawer: true }
        if (action === 'close-sidebar') panelState = { ...panelState, sidebarDrawer: false }
        if (action === 'open-side-panel') panelState = { ...panelState, sidePanelOpen: true }
        if (action === 'close-side-panel') panelState = { ...panelState, sidePanelOpen: false }
      },
      stopAt: () => frame,
      now: () => now,
      getSelection: (): SelectionLike => ({
        isCollapsed: selectionCollapsed,
        toString: () => selectionText,
      }),
      getComputedStyle: (el) => (el as FakeElement).style,
      hasBlockingOverlay: () => overlayOpen,
    })

    return {
      frame,
      content,
      tracker,
      actions,
      getState: () => panelState,
      setState: (next: MobileSwipePanelState) => {
        panelState = next
      },
      advance: (ms: number) => {
        now += ms
      },
      setEnabled: (value: boolean) => {
        enabled = value
      },
      setViewportWidth: (value: number) => {
        viewportWidth = value
      },
      setSelection: (text: string, collapsed = false) => {
        selectionText = text
        selectionCollapsed = collapsed
      },
      setOverlayOpen: (open: boolean) => {
        overlayOpen = open
      },
    }
  }

  function swipe(
    ctx: ReturnType<typeof setup>,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    durationMs = 180,
    target: EventTarget = ctx.content as unknown as EventTarget,
  ): MobileSwipeAction {
    ctx.tracker.onTouchStart(makeTouchEvent({ touches: [makeTouch(fromX, fromY)], target }))
    ctx.advance(Math.floor(durationMs / 2))
    ctx.tracker.onTouchMove(
      makeTouchEvent({
        touches: [makeTouch((fromX + toX) / 2, (fromY + toY) / 2)],
        target,
      }),
    )
    ctx.advance(durationMs - Math.floor(durationMs / 2))
    return ctx.tracker.onTouchEnd(
      makeTouchEvent({ touches: [], changedTouches: [makeTouch(toX, toY)], target }),
    )
  }

  it('commits only on touchend and navigates one column at a time', () => {
    const ctx = setup()

    // Mid-gesture move does not trigger any panel change yet.
    ctx.tracker.onTouchStart(
      makeTouchEvent({
        touches: [makeTouch(100, 300)],
        target: ctx.content as unknown as EventTarget,
      }),
    )
    ctx.advance(80)
    ctx.tracker.onTouchMove(
      makeTouchEvent({
        touches: [makeTouch(220, 305)],
        target: ctx.content as unknown as EventTarget,
      }),
    )
    expect(ctx.actions).toEqual([])
    expect(ctx.getState().sidebarDrawer).toBe(false)

    // Releasing past the threshold commits opening the left sidebar drawer.
    ctx.advance(80)
    const first = ctx.tracker.onTouchEnd(
      makeTouchEvent({
        touches: [],
        changedTouches: [makeTouch(220, 305)],
        target: ctx.content as unknown as EventTarget,
      }),
    )
    expect(first).toBe('open-sidebar')
    expect(ctx.getState()).toMatchObject({ sidebarDrawer: true, sidePanelOpen: false })

    // Swipe right-to-left closes the drawer back to main (never jumps straight to side panel).
    expect(swipe(ctx, 260, 300, 140, 305)).toBe('close-sidebar')
    expect(ctx.getState()).toMatchObject({ sidebarDrawer: false, sidePanelOpen: false })

    // Second swipe right-to-left opens the right side panel.
    expect(swipe(ctx, 260, 300, 140, 300)).toBe('open-side-panel')
    expect(ctx.getState()).toMatchObject({ sidebarDrawer: false, sidePanelOpen: true })

    // Swipe left-to-right closes the side panel back to main (never jumps straight to sidebar).
    expect(swipe(ctx, 100, 300, 220, 302)).toBe('close-side-panel')
    expect(ctx.getState()).toMatchObject({ sidebarDrawer: false, sidePanelOpen: false })
  })

  it('ignores swipe right-to-left when the current view does not support a right side panel', () => {
    const ctx = setup({
      panelState: {
        sidebarDrawer: false,
        sidePanelOpen: false,
        canOpenSidePanel: false,
      },
    })
    expect(swipe(ctx, 260, 300, 140, 300)).toBeNull()
    expect(ctx.actions).toEqual([])
  })

  it('ignores touches starting inside the left or right system edge-back guard zones', () => {
    const ctx = setup({ viewportWidth: 390 })
    // Left edge (< 24px).
    expect(swipe(ctx, EDGE_GUARD_PX - 1, 300, 180, 300)).toBeNull()
    // Right edge (> 390 - 24 = 366px).
    expect(swipe(ctx, 390 - EDGE_GUARD_PX + 1, 300, 200, 300)).toBeNull()
    // Exactly at the boundary is allowed.
    expect(swipe(ctx, EDGE_GUARD_PX, 300, EDGE_GUARD_PX + SWIPE_THRESHOLD_PX, 300)).toBe(
      'open-sidebar',
    )
  })

  it('ignores short swipes below the displacement threshold', () => {
    const ctx = setup()
    expect(swipe(ctx, 100, 300, 100 + SWIPE_THRESHOLD_PX - 1, 300)).toBeNull()
    expect(ctx.actions).toEqual([])
  })

  it('ignores vertical scrolling and overly diagonal swipes', () => {
    const ctx = setup()
    // Vertical scroll locks out during touchmove even if the finger later drifts horizontally.
    ctx.tracker.onTouchStart(
      makeTouchEvent({
        touches: [makeTouch(120, 300)],
        target: ctx.content as unknown as EventTarget,
      }),
    )
    ctx.advance(60)
    ctx.tracker.onTouchMove(
      makeTouchEvent({
        touches: [makeTouch(125, 300 + AXIS_LOCK_PX + 6)],
        target: ctx.content as unknown as EventTarget,
      }),
    )
    expect(ctx.tracker.isTracking()).toBe(false)
    ctx.advance(80)
    expect(
      ctx.tracker.onTouchEnd(
        makeTouchEvent({
          touches: [],
          changedTouches: [makeTouch(260, 310)],
          target: ctx.content as unknown as EventTarget,
        }),
      ),
    ).toBeNull()

    // Diagonal swipe failing |dx| >= |dy| * DIRECTION_RATIO (e.g. dx=80, dy=60 -> 80 < 96).
    const dy = Math.ceil(80 / DIRECTION_RATIO) + 5
    expect(swipe(ctx, 100, 300, 180, 300 + dy)).toBeNull()
    expect(ctx.actions).toEqual([])
  })

  it('ignores slow drags exceeding MAX_SWIPE_DURATION_MS', () => {
    const ctx = setup()
    expect(swipe(ctx, 100, 300, 220, 300, MAX_SWIPE_DURATION_MS + 50)).toBeNull()
    expect(ctx.actions).toEqual([])
  })

  it('cancels immediately on multi-touch (pinch/zoom or second finger landing)', () => {
    const ctx = setup()

    // Starting with two fingers.
    ctx.tracker.onTouchStart(
      makeTouchEvent({
        touches: [makeTouch(100, 300, 1), makeTouch(200, 300, 2)],
        target: ctx.content as unknown as EventTarget,
      }),
    )
    expect(ctx.tracker.isTracking()).toBe(false)

    // Starting with one finger, then a second finger lands mid-gesture.
    ctx.tracker.onTouchStart(
      makeTouchEvent({
        touches: [makeTouch(100, 300, 1)],
        target: ctx.content as unknown as EventTarget,
      }),
    )
    expect(ctx.tracker.isTracking()).toBe(true)
    ctx.tracker.onTouchStart(
      makeTouchEvent({
        touches: [makeTouch(120, 300, 1), makeTouch(220, 310, 2)],
        target: ctx.content as unknown as EventTarget,
      }),
    )
    expect(ctx.tracker.isTracking()).toBe(false)
    expect(
      ctx.tracker.onTouchEnd(
        makeTouchEvent({
          touches: [],
          changedTouches: [makeTouch(220, 300, 1)],
          target: ctx.content as unknown as EventTarget,
        }),
      ),
    ).toBeNull()
  })

  it('ignores gestures while there is an active text selection', () => {
    const ctx = setup({ selectionText: 'selected text' })
    expect(hasActiveTextSelection(() => ({ isCollapsed: false, toString: () => 'abc' }))).toBe(true)
    expect(hasActiveTextSelection(() => ({ isCollapsed: true, toString: () => 'abc' }))).toBe(false)
    expect(swipe(ctx, 100, 300, 220, 300)).toBeNull()

    // Selection formed mid-gesture also cancels the swipe.
    ctx.setSelection('')
    ctx.tracker.onTouchStart(
      makeTouchEvent({
        touches: [makeTouch(100, 300)],
        target: ctx.content as unknown as EventTarget,
      }),
    )
    ctx.setSelection('highlighted')
    ctx.advance(100)
    expect(
      ctx.tracker.onTouchEnd(
        makeTouchEvent({
          touches: [],
          changedTouches: [makeTouch(220, 300)],
          target: ctx.content as unknown as EventTarget,
        }),
      ),
    ).toBeNull()
  })

  it('ignores gestures when disabled (desktop or wide viewport) or when a blocking overlay is open', () => {
    const ctx = setup({ enabled: false })
    expect(swipe(ctx, 100, 300, 220, 300)).toBeNull()

    ctx.setEnabled(true)
    ctx.setOverlayOpen(true)
    expect(swipe(ctx, 100, 300, 220, 300)).toBeNull()

    ctx.setOverlayOpen(false)
    expect(swipe(ctx, 100, 300, 220, 300)).toBe('open-sidebar')
  })

  it('ignores gestures starting inside exempt controls (scrollable code, editor, terminal, dialog)', () => {
    const ctx = setup()
    const codeScroll = ctx.frame.append(
      new FakeElement('PRE', {
        clientWidth: 320,
        scrollWidth: 640,
        style: { overflowX: 'auto' },
      }),
    )
    const cm = ctx.frame.append(new FakeElement('DIV', { classes: ['cm-editor'] }))
    const textarea = ctx.frame.append(new FakeElement('TEXTAREA'))
    const xterm = ctx.frame.append(new FakeElement('DIV', { classes: ['xterm'] }))
    const dialog = ctx.frame.append(new FakeElement('DIV', { attrs: { role: 'dialog' } }))

    for (const el of [codeScroll, cm, textarea, xterm, dialog]) {
      expect(swipe(ctx, 100, 300, 220, 300, 160, el as unknown as EventTarget)).toBeNull()
    }
    expect(ctx.actions).toEqual([])
  })

  it('attaches and cleans up passive touch listeners cleanly', () => {
    const listeners = new Map<string, EventListener>()
    const optionsSeen: AddEventListenerOptions[] = []
    const host = {
      addEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        opts?: boolean | AddEventListenerOptions,
      ) => {
        listeners.set(type, listener as EventListener)
        if (typeof opts === 'object' && opts) optionsSeen.push(opts)
      },
      removeEventListener: (type: string) => {
        listeners.delete(type)
      },
    }
    const ctx = setup()
    const detach = attachMobileSwipeListeners(
      host as unknown as Pick<HTMLElement, 'addEventListener' | 'removeEventListener'>,
      ctx.tracker,
    )
    expect([...listeners.keys()].sort()).toEqual([
      'touchcancel',
      'touchend',
      'touchmove',
      'touchstart',
    ])
    expect(optionsSeen.every((opt) => opt.passive === true)).toBe(true)

    listeners.get('touchstart')?.(
      makeTouchEvent({
        touches: [makeTouch(100, 300)],
        target: ctx.content as unknown as EventTarget,
      }) as unknown as Event,
    )
    expect(ctx.tracker.isTracking()).toBe(true)
    listeners.get('touchcancel')?.({} as Event)
    expect(ctx.tracker.isTracking()).toBe(false)

    detach()
    expect(listeners.size).toBe(0)
  })
})

describe('resolveActiveSidePanel and workbench store integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function loadWorkbenchModules(
    options: { client?: 'web' | 'desktop'; narrow?: boolean; innerWidth?: number } = {},
  ) {
    vi.resetModules()
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    })
    const never = new Promise(() => {})
    const narrow = options.narrow ?? true
    vi.stubGlobal('window', {
      innerWidth: options.innerWidth ?? (narrow ? 390 : 1280),
      matchMedia: () => ({
        matches: narrow,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
      kettu: {
        platform: 'darwin',
        client: options.client ?? 'web',
        hostPlatform: () => 'darwin',
        agents: {
          request: vi.fn(() => never),
          onEvent: () => () => {},
          onConnection: () => () => {},
        },
        hosts: {
          request: vi.fn(() => never),
          onChanged: () => () => {},
          onSession: () => () => {},
          status: vi.fn(() => never),
        },
        settings: {
          get: vi.fn(() => never),
          update: vi.fn(() => never),
          onChanged: () => () => {},
        },
      },
    })
    const [mobileSwipe, viewStore, projectsStore, sessionsStore, overlayStore, hostPaths] =
      await Promise.all([
        import('./use-mobile-swipe'),
        import('@renderer/stores/view'),
        import('@renderer/stores/projects'),
        import('@renderer/stores/sessions'),
        import('@renderer/stores/overlays'),
        import('@renderer/lib/host-paths'),
      ])
    return {
      ...mobileSwipe,
      useViewStore: viewStore.useViewStore,
      useProjectsStore: projectsStore.useProjectsStore,
      useSessionsStore: sessionsStore.useSessionsStore,
      useOverlayStore: overlayStore.useOverlayStore,
      onHost: hostPaths.onHost,
    }
  }

  it('resolves side panel support for sessions, project new-sessions, tasks, and unsupported pages', async () => {
    const { resolveActiveSidePanel, onHost } = await loadWorkbenchModules()
    const projects: Project[] = [
      { path: '/repo/app', name: 'app', addedAt: 1, archived: false } as unknown as Project,
    ]

    // Active session with closed panel -> supported, not open.
    expect(
      resolveActiveSidePanel({
        main: { kind: 'session', sessionId: 'sess-1' },
        layout: createLayout({ kind: 'session', sessionId: 'sess-1', projectPath: '/repo/app' }),
        projectPath: '/repo/app',
        projects,
        sessions: {
          'sess-1': { projectPath: '/repo/app', worktree: undefined, scratch: false },
        },
        tasks: {},
        sidePane: {},
        terminalAllowed: () => true,
      }),
    ).toEqual({ panel: 'sess-1', projectPath: '/repo/app', open: false })

    // Active session with open files pane -> supported and open.
    expect(
      resolveActiveSidePanel({
        main: { kind: 'session', sessionId: 'sess-1' },
        layout: createLayout({ kind: 'session', sessionId: 'sess-1', projectPath: '/repo/app' }),
        projectPath: '/repo/app',
        projects,
        sessions: {
          'sess-1': { projectPath: '/repo/app', worktree: undefined, scratch: false },
        },
        tasks: {},
        sidePane: { 'sess-1': 'files' },
        terminalAllowed: () => true,
      }),
    ).toEqual({ panel: 'sess-1', projectPath: '/repo/app', open: true })

    // New session with No project -> no side panel.
    expect(
      resolveActiveSidePanel({
        main: { kind: 'new', agentId: null, noProject: true },
        layout: createLayout({
          kind: 'new',
          agentId: null,
          projectPath: null,
          noProject: true,
        }),
        projectPath: '/repo/app',
        projects,
        sessions: {},
        tasks: {},
        sidePane: {},
        terminalAllowed: () => true,
      }),
    ).toBeNull()

    // New session in a project -> supported with new-session panel key.
    expect(
      resolveActiveSidePanel({
        main: { kind: 'new', agentId: null, noProject: false },
        layout: createLayout({
          kind: 'new',
          agentId: null,
          projectPath: '/repo/app',
          noProject: false,
        }),
        projectPath: '/repo/app',
        projects,
        sessions: {},
        tasks: {},
        sidePane: {},
        terminalAllowed: () => true,
      }),
    ).toEqual({ panel: 'new-session:/repo/app', projectPath: '/repo/app', open: false })

    // Task view with a project folder -> supported.
    expect(
      resolveActiveSidePanel({
        main: { kind: 'task', taskId: 'task-42' },
        layout: createLayout(),
        projectPath: '/repo/app',
        projects,
        sessions: {},
        tasks: { 'task-42': { projectPath: '/repo/app', worktreePath: '/repo/wt-42' } },
        sidePane: { 'task:task-42': 'file' },
        terminalAllowed: () => true,
      }),
    ).toEqual({ panel: 'task:task-42', projectPath: '/repo/wt-42', open: true })

    // Standalone pages without a side panel -> null.
    for (const kind of [
      'overview',
      'usage',
      'routines',
      'artifacts',
      'marketplace',
      'launch',
    ] as const) {
      expect(
        resolveActiveSidePanel({
          main: { kind },
          layout: createLayout(),
          projectPath: '/repo/app',
          projects,
          sessions: {},
          tasks: {},
          sidePane: { 'sess-1': 'files' },
          terminalAllowed: () => true,
        }),
      ).toBeNull()
    }

    // Remote host hides terminal when disallowed and hides devices/computer.
    const remotePath = onHost('0123456789abcdef0123456789abcdef', '/srv/app')
    expect(
      resolveActiveSidePanel({
        main: { kind: 'session', sessionId: 'sess-remote' },
        layout: createLayout({
          kind: 'session',
          sessionId: 'sess-remote',
          projectPath: remotePath,
        }),
        projectPath: remotePath,
        projects: [],
        sessions: {
          'sess-remote': {
            projectPath: remotePath,
            worktree: undefined,
            scratch: false,
          },
        },
        tasks: {},
        sidePane: { 'sess-remote': 'terminal' },
        terminalAllowed: () => false,
      }),
    ).toEqual({
      panel: 'sess-remote',
      projectPath: remotePath,
      open: false,
    })

    expect(
      resolveActiveSidePanel({
        main: { kind: 'session', sessionId: 'sess-remote' },
        layout: createLayout({
          kind: 'session',
          sessionId: 'sess-remote',
          projectPath: remotePath,
        }),
        projectPath: remotePath,
        projects: [],
        sessions: {
          'sess-remote': {
            projectPath: remotePath,
            worktree: undefined,
            scratch: false,
          },
        },
        tasks: {},
        sidePane: { 'sess-remote': 'devices' },
        terminalAllowed: () => true,
      }),
    ).toEqual({
      panel: 'sess-remote',
      projectPath: remotePath,
      open: false,
    })
  })

  it('drives view store sidebar drawer and side panel on narrow web, and stays inactive on desktop or wide viewports', async () => {
    const runGesture = (
      tracker: ReturnType<
        Awaited<ReturnType<typeof loadWorkbenchModules>>['createWorkbenchSwipeTracker']
      >,
      advance: (ms: number) => void,
      target: FakeElement,
      fromX: number,
      toX: number,
    ) => {
      tracker.onTouchStart(
        makeTouchEvent({
          touches: [makeTouch(fromX, 300)],
          target: target as unknown as EventTarget,
        }),
      )
      advance(80)
      tracker.onTouchMove(
        makeTouchEvent({
          touches: [makeTouch((fromX + toX) / 2, 302)],
          target: target as unknown as EventTarget,
        }),
      )
      advance(80)
      return tracker.onTouchEnd(
        makeTouchEvent({
          touches: [],
          changedTouches: [makeTouch(toX, 304)],
          target: target as unknown as EventTarget,
        }),
      )
    }

    // 1. Narrow web client: full three-column round-trip via real stores.
    const web = await loadWorkbenchModules({ client: 'web', narrow: true, innerWidth: 390 })
    web.useProjectsStore.setState({
      projects: [
        { path: '/repo/app', name: 'app', addedAt: 1, archived: false } as unknown as Project,
      ],
    })
    web.useViewStore.setState({
      main: { kind: 'session', sessionId: 'sess-1' },
      layout: createLayout({ kind: 'session', sessionId: 'sess-1', projectPath: '/repo/app' }),
      projectPath: '/repo/app',
      sidebarDrawer: false,
      sidePane: {},
      sideLast: { 'sess-1': 'files' },
      sideTabs: { 'sess-1': ['files'] },
      settings: { open: false, section: null, item: null },
      searchOpen: false,
      shortcutsOpen: false,
      renamingIn: null,
    })
    let clock = 2000
    const frame = new FakeElement('DIV')
    const body = frame.append(new FakeElement('DIV'))
    const tracker = web.createWorkbenchSwipeTracker(() => frame, {
      now: () => clock,
      getSelection: () => null,
      getComputedStyle: (el) => (el as FakeElement).style,
    })

    // Main -> left drawer.
    expect(runGesture(tracker, (ms) => (clock += ms), body, 100, 220)).toBe('open-sidebar')
    expect(web.useViewStore.getState().sidebarDrawer).toBe(true)

    // Left drawer -> main.
    expect(runGesture(tracker, (ms) => (clock += ms), body, 260, 140)).toBe('close-sidebar')
    expect(web.useViewStore.getState().sidebarDrawer).toBe(false)
    expect(web.useViewStore.getState().sidePane['sess-1']).toBeUndefined()

    // Main -> right side panel (reopens last pane 'files').
    expect(runGesture(tracker, (ms) => (clock += ms), body, 260, 140)).toBe('open-side-panel')
    expect(web.useViewStore.getState().sidePane['sess-1']).toBe('files')

    // Right side panel -> main (closes panel while preserving tabs).
    expect(runGesture(tracker, (ms) => (clock += ms), body, 100, 220)).toBe('close-side-panel')
    expect(web.useViewStore.getState().sidePane['sess-1']).toBeUndefined()
    expect(web.useViewStore.getState().sideLast['sess-1']).toBe('files')

    // Blocking overlays/settings/search prevent swipes.
    web.useViewStore.setState({ searchOpen: true })
    expect(runGesture(tracker, (ms) => (clock += ms), body, 100, 220)).toBeNull()
    expect(web.useViewStore.getState().sidebarDrawer).toBe(false)
    web.useViewStore.setState({ searchOpen: false })

    web.useOverlayStore.getState().set('popover-1', true, { dismissible: true })
    expect(runGesture(tracker, (ms) => (clock += ms), body, 100, 220)).toBeNull()
    web.useOverlayStore.getState().set('popover-1', false)

    // 2. Desktop client: disabled even when narrow.
    const desktop = await loadWorkbenchModules({ client: 'desktop', narrow: true, innerWidth: 390 })
    let dClock = 2000
    const dTracker = desktop.createWorkbenchSwipeTracker(() => frame, {
      now: () => dClock,
      getSelection: () => null,
      getComputedStyle: (el) => (el as FakeElement).style,
    })
    expect(runGesture(dTracker, (ms) => (dClock += ms), body, 100, 220)).toBeNull()

    // 3. Wide web viewport: disabled.
    const wide = await loadWorkbenchModules({ client: 'web', narrow: false, innerWidth: 1280 })
    let wClock = 2000
    const wTracker = wide.createWorkbenchSwipeTracker(() => frame, {
      now: () => wClock,
      getSelection: () => null,
      getComputedStyle: (el) => (el as FakeElement).style,
    })
    expect(runGesture(wTracker, (ms) => (wClock += ms), body, 100, 220)).toBeNull()
  })
})
