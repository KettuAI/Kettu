import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { css as appShellCss } from '@renderer/components/affect/app-shell'
import { css as dateRangePickerCss } from '@renderer/components/affect/date-range-picker'
import { clampSubmenuTop, css as profileMenuCss } from '@renderer/components/affect/profile-menu'
import {
  POPOVER_GAP,
  POPOVER_MARGIN,
  applyDateRangePanelLayout,
  applyPopoverLayout,
  intersectClipAxes,
  resolveHorizontalPlacement,
  resolvePopoverAnchor,
  resolvePopoverClipAncestors,
  resolvePopoverClipBox,
  resolvePopoverLayout,
  resolvePopoverMaxWidth,
  type PopoverRect,
} from './affect-popover'

/** Computes the rendered popover bounds inside the clip box for verification assertions. */
function renderedBounds(
  layout: ReturnType<typeof resolvePopoverLayout>,
  anchor: PopoverRect,
  contentWidth: number,
  contentHeight: number,
) {
  const height =
    layout.maxHeight === null ? contentHeight : Math.min(contentHeight, layout.maxHeight)
  const top =
    layout.side === 'bottom'
      ? anchor.bottom + POPOVER_GAP + layout.dy
      : layout.side === 'top'
        ? anchor.top - POPOVER_GAP - height + layout.dy
        : anchor.bottom - height + layout.dy
  const bottom = top + height
  const left =
    layout.side === 'right'
      ? anchor.right + 12 + layout.dx
      : layout.align === 'start'
        ? anchor.left + layout.dx
        : anchor.right - contentWidth + layout.dx
  const right = left + contentWidth
  return { top, right, bottom, left, height }
}

describe('intersectClipAxes', () => {
  const viewport: PopoverRect = { top: 0, right: 1280, bottom: 800, left: 0 }

  it('intersects both axes when both overflowX and overflowY clip', () => {
    const modal: PopoverRect = { top: 56, right: 1170, bottom: 744, left: 110 }
    expect(intersectClipAxes(viewport, modal, true, true)).toEqual(modal)
  })

  it('intersects only the clipping axis so horizontal-only clips do not constrain height', () => {
    const narrowTall: PopoverRect = { top: 200, right: 900, bottom: 260, left: 200 }
    expect(intersectClipAxes(viewport, narrowTall, true, false)).toEqual({
      top: 0,
      right: 900,
      bottom: 800,
      left: 200,
    })
  })

  it('clamps non-overlapping intersections to empty non-inverted rects', () => {
    const outside: PopoverRect = { top: 900, right: 2000, bottom: 1200, left: 1500 }
    const result = intersectClipAxes(viewport, outside, true, true)
    expect(result.right).toBe(result.left)
    expect(result.bottom).toBe(result.top)
  })
})

describe('resolvePopoverLayout', () => {
  // Typical Settings modal `.kettu-settings__page` bounds on a 1280x800 desktop window.
  const settingsClip: PopoverRect = { top: 56, right: 1170, bottom: 744, left: 346 }

  it('flips upward and clamps maxHeight inside the clip box when many projects overflow below', () => {
    // ProjectPicker sits in the lower half of Settings › Memory with ~15 rich items (44px each).
    const anchor: PopoverRect = { top: 520, right: 980, bottom: 552, left: 770 }
    const contentWidth = 220
    const contentHeight = 15 * 45 + 8 // 683px

    const layout = resolvePopoverLayout({
      preferredSide: 'bottom',
      preferredAlign: 'end',
      anchor,
      clip: settingsClip,
      contentWidth,
      contentHeight,
    })

    // Below room: 744 - 552 - 6 - 8 = 178px; above room: 520 - 56 - 6 - 8 = 450px.
    expect(layout.side).toBe('top')
    expect(layout.align).toBe('end')
    expect(layout.overflow).toBe(true)
    expect(layout.maxHeight).toBe(450)
    expect(layout.dy).toBe(0)

    const bounds = renderedBounds(layout, anchor, contentWidth, contentHeight)
    expect(bounds.top).toBeGreaterThanOrEqual(settingsClip.top + POPOVER_MARGIN)
    expect(bounds.bottom).toBeLessThanOrEqual(settingsClip.bottom - POPOVER_MARGIN)
    expect(bounds.height).toBe(450)
  })

  it('picks the larger side instead of flipping into a cramped space above when both sides overflow', () => {
    // Trigger near the top of the settings pane: 578px below vs only 50px above.
    const anchor: PopoverRect = { top: 120, right: 980, bottom: 152, left: 770 }
    const contentWidth = 220
    const contentHeight = 683

    const layout = resolvePopoverLayout({
      preferredSide: 'bottom',
      preferredAlign: 'end',
      anchor,
      clip: settingsClip,
      contentWidth,
      contentHeight,
    })

    expect(layout.side).toBe('bottom')
    expect(layout.overflow).toBe(true)
    expect(layout.maxHeight).toBe(578)
    expect(layout.dy).toBe(0)

    const bounds = renderedBounds(layout, anchor, contentWidth, contentHeight)
    expect(bounds.top).toBeGreaterThanOrEqual(settingsClip.top + POPOVER_MARGIN)
    expect(bounds.bottom).toBeLessThanOrEqual(settingsClip.bottom - POPOVER_MARGIN)
  })

  it('keeps the preferred side when both sides overflow equally', () => {
    const clip: PopoverRect = { top: 0, right: 800, bottom: 400, left: 0 }
    // Centered anchor: 184 - 6 - 8 = 170px above, 400 - 216 - 6 - 8 = 170px below.
    const anchor: PopoverRect = { top: 184, right: 300, bottom: 216, left: 100 }

    const bottomPreferred = resolvePopoverLayout({
      preferredSide: 'bottom',
      preferredAlign: 'start',
      anchor,
      clip,
      contentWidth: 200,
      contentHeight: 500,
    })
    expect(bottomPreferred.side).toBe('bottom')
    expect(bottomPreferred.maxHeight).toBe(170)
    expect(bottomPreferred.overflow).toBe(true)

    const topPreferred = resolvePopoverLayout({
      preferredSide: 'top',
      preferredAlign: 'start',
      anchor,
      clip,
      contentWidth: 200,
      contentHeight: 500,
    })
    expect(topPreferred.side).toBe('top')
    expect(topPreferred.maxHeight).toBe(170)
    expect(topPreferred.overflow).toBe(true)
  })

  it('keeps short menus at full natural height with overflow=false and no unnecessary scrollbar', () => {
    const anchor: PopoverRect = { top: 240, right: 980, bottom: 272, left: 770 }
    const contentHeight = 140

    const layout = resolvePopoverLayout({
      preferredSide: 'bottom',
      preferredAlign: 'end',
      anchor,
      clip: settingsClip,
      contentWidth: 210,
      contentHeight,
    })

    expect(layout.side).toBe('bottom')
    expect(layout.overflow).toBe(false)
    expect(layout.maxHeight).toBeGreaterThanOrEqual(contentHeight)
    expect(layout.dy).toBe(0)

    const bounds = renderedBounds(layout, anchor, 210, contentHeight)
    expect(bounds.height).toBe(contentHeight)
  })

  it('flips a short menu cleanly without overflow when it fits on the opposite side', () => {
    const anchor: PopoverRect = { top: 620, right: 980, bottom: 652, left: 770 }
    const contentHeight = 180

    const layout = resolvePopoverLayout({
      preferredSide: 'bottom',
      preferredAlign: 'end',
      anchor,
      clip: settingsClip,
      contentWidth: 210,
      contentHeight,
    })

    // Below has 78px (< 180px), above has 550px (>= 180px).
    expect(layout.side).toBe('top')
    expect(layout.overflow).toBe(false)
    expect(layout.maxHeight).toBe(550)
  })

  it('clamps top-preferred sidebar popovers when the window is very short', () => {
    const shortViewport: PopoverRect = { top: 0, right: 1024, bottom: 280, left: 0 }
    const anchor: PopoverRect = { top: 232, right: 260, bottom: 268, left: 12 }

    const layout = resolvePopoverLayout({
      preferredSide: 'top',
      preferredAlign: 'start',
      anchor,
      clip: shortViewport,
      contentWidth: 260,
      contentHeight: 360,
    })

    // Above: 232 - 0 - 6 - 8 = 218px; below: 0px.
    expect(layout.side).toBe('top')
    expect(layout.overflow).toBe(true)
    expect(layout.maxHeight).toBe(218)

    const bounds = renderedBounds(layout, anchor, 260, 360)
    expect(bounds.top).toBe(POPOVER_MARGIN)
    expect(bounds.bottom).toBe(anchor.top - POPOVER_GAP)
  })

  it('handles scaled ancestor containers accurately', () => {
    const clip: PopoverRect = { top: 0, right: 1000, bottom: 600, left: 0 }
    const anchor: PopoverRect = { top: 400, right: 500, bottom: 440, left: 300 }

    // 2x visual scale: 400px above in viewport pixels => 200px in CSS pixels minus 6 gap minus 8 margin = 186px.
    const layout = resolvePopoverLayout({
      preferredSide: 'bottom',
      preferredAlign: 'start',
      anchor,
      clip,
      contentWidth: 200,
      contentHeight: 300,
      scaleX: 2,
      scaleY: 2,
    })

    expect(layout.side).toBe('top')
    expect(layout.overflow).toBe(true)
    expect(layout.maxHeight).toBe(186)
  })

  it('keeps right-side popovers within vertical clip bounds and slides down when near the top', () => {
    const clip: PopoverRect = { top: 0, right: 1000, bottom: 400, left: 0 }
    const anchor: PopoverRect = { top: 40, right: 200, bottom: 72, left: 40 }

    const layout = resolvePopoverLayout({
      preferredSide: 'right',
      preferredAlign: 'start',
      anchor,
      clip,
      contentWidth: 240,
      contentHeight: 260,
    })

    expect(layout.side).toBe('right')
    expect(layout.overflow).toBe(false)
    expect(layout.maxHeight).toBe(384)
    const bounds = renderedBounds(layout, anchor, 240, 260)
    expect(bounds.top).toBeGreaterThanOrEqual(clip.top + POPOVER_MARGIN)
    expect(bounds.bottom).toBeLessThanOrEqual(clip.bottom - POPOVER_MARGIN)
  })

  it('shifts vertically inside clip bounds if the anchor is partially scrolled past the top edge', () => {
    const anchor: PopoverRect = { top: 20, right: 980, bottom: 52, left: 770 }
    const layout = resolvePopoverLayout({
      preferredSide: 'bottom',
      preferredAlign: 'end',
      anchor,
      clip: settingsClip,
      contentWidth: 220,
      contentHeight: 700,
    })

    expect(layout.side).toBe('bottom')
    expect(layout.overflow).toBe(true)
    const bounds = renderedBounds(layout, anchor, 220, 700)
    expect(bounds.top).toBeGreaterThanOrEqual(settingsClip.top + POPOVER_MARGIN)
    expect(bounds.bottom).toBeLessThanOrEqual(settingsClip.bottom - POPOVER_MARGIN)
  })

  it('returns unconstrained defaults when clip box has zero dimensions', () => {
    const empty: PopoverRect = { top: 0, right: 0, bottom: 0, left: 0 }
    const anchor: PopoverRect = { top: 100, right: 200, bottom: 132, left: 100 }
    expect(
      resolvePopoverLayout({
        preferredSide: 'bottom',
        preferredAlign: 'end',
        anchor,
        clip: empty,
        contentWidth: 200,
        contentHeight: 400,
      }),
    ).toEqual({
      side: 'bottom',
      align: 'end',
      maxHeight: null,
      overflow: false,
      dx: 0,
      dy: 0,
    })
  })
})

describe('resolveHorizontalPlacement', () => {
  it('flips alignment when preferred side overflows horizontally and shifts on narrow clips', () => {
    const clip: PopoverRect = { top: 0, right: 320, bottom: 600, left: 0 }
    const anchor: PopoverRect = { top: 100, right: 300, bottom: 132, left: 220 }

    const flipped = resolveHorizontalPlacement({
      preferredAlign: 'start',
      side: 'bottom',
      anchor,
      clip,
      contentWidth: 200,
    })
    expect(flipped).toEqual({ align: 'end', dx: 0 })

    // Too wide for either edge: clamps cleanly inside clip margins.
    const wide = resolveHorizontalPlacement({
      preferredAlign: 'start',
      side: 'bottom',
      anchor,
      clip,
      contentWidth: 300,
    })
    const left = wide.align === 'start' ? anchor.left + wide.dx : anchor.right - 300 + wide.dx
    expect(left).toBe(POPOVER_MARGIN)
  })
})

describe('app-shell popover and menu CSS contract', () => {
  it('bounds .ui-as-popover height via --as-popover-max-h and makes .ui-as-menu__list scrollable', () => {
    expect(appShellCss).toMatch(
      /\.ui-as-popover\s*\{[^}]*max-height:\s*var\(--as-popover-max-h,\s*none\)/,
    )
    expect(appShellCss).toMatch(
      /\.ui-as-menu\s*\{[^}]*display:\s*flex;\s*flex-direction:\s*column;/,
    )
    expect(appShellCss).toMatch(
      /\.ui-as-menu\s*>\s*:not\(\.ui-as-menu__list\)\s*\{\s*flex:\s*none;\s*\}/,
    )
    expect(appShellCss).toMatch(
      /\.ui-as-menu__list\s*\{[^}]*flex:\s*1\s+1\s+auto;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/,
    )
    // Unconstrained menus with submenus keep overflow visible so side subpanels are not clipped.
    expect(appShellCss).toMatch(
      /\.ui-as-popover:not\(\[data-overflow\]\)\s+\.ui-as-menu__list:has\(>\s*\.ui-as-menu__sub\)\s*\{\s*overflow:\s*visible;\s*\}/,
    )
  })

  it('keeps .ui-as-popover[data-overflow] unclipped for ProfileMenu (.ui-pmc) and scrolls .ui-pmc__card instead', () => {
    expect(appShellCss).toMatch(
      /\.ui-as-popover\[data-overflow\]:not\(:has\(>\s*\.ui-as-menu__list,\s*\.ui-pmc\)\)\s*\{\s*overflow-y:\s*auto;\s*overscroll-behavior:\s*contain;\s*\}/,
    )
    expect(appShellCss).toMatch(
      /\.ui-as-popover\[data-overflow\]\s+\.ui-pmc__card\s*\{\s*max-height:\s*var\(--as-popover-max-h\);\s*overflow-y:\s*auto;\s*overscroll-behavior:\s*contain;\s*\}/,
    )
    expect(appShellCss).toMatch(
      /\.ui-as-popover\[data-overflow\]\s+\.ui-pmc__items\s*\{\s*max-height:\s*none;\s*overflow:\s*visible;\s*\}/,
    )
    expect(profileMenuCss).toMatch(
      /\.ui-pmc__side\s*\{[^}]*max-height:\s*calc\(100dvh - 16px\);[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/,
    )
  })

  it('keeps Popover outside-click, focusout, and refocus anchored to the direct wrapper el.parentElement', () => {
    const appShellSource = readFileSync(
      new URL('../components/affect/app-shell.tsx', import.meta.url),
      'utf8',
    )
    const popoverStart = appShellSource.indexOf('export function Popover(')
    const popoverEnd = appShellSource.indexOf('export type MenuItem =', popoverStart)
    expect(popoverStart).toBeGreaterThan(-1)
    expect(popoverEnd).toBeGreaterThan(popoverStart)
    const popoverBody = appShellSource.slice(popoverStart, popoverEnd)

    // Layout uses applyPopoverLayout (which skips display: contents wrappers).
    expect(popoverBody).toContain('applyPopoverLayout(el, side, align)')
    // Focus restoration and outside-click/focusout dismissal stay scoped to the direct wrapper
    // (e.g. `.kettu-plan-ring`) so clicking the trigger button toggles cleanly without double-toggling.
    expect(popoverBody).toContain('const anchor = el.parentElement;')
    expect(popoverBody).toContain('const anchor = ref.current?.parentElement;')
    expect(popoverBody).toContain('if (anchor && !anchor.contains(e.target as Node)) onClose();')
  })
})

interface FakeStyle {
  display?: string
  overflow?: string
  overflowX?: string
  overflowY?: string
}

class FakeElement {
  parentElement: FakeElement | null = null
  dataset: Record<string, string | undefined> = {}
  scrollTop = 0
  offsetWidth: number
  offsetHeight: number
  private readonly rect: DOMRect
  private readonly classes: Set<string>
  private readonly attrs = new Map<string, string>()
  private readonly props = new Map<string, string>()
  private readonly queryMap = new Map<string, FakeElement>()
  readonly computed: FakeStyle

  style = {
    left: '',
    right: '',
    translate: '',
    setProperty: (name: string, value: string) => {
      this.props.set(name, value)
    },
    getPropertyValue: (name: string) => this.props.get(name) ?? '',
    removeProperty: (name: string) => {
      this.props.delete(name)
    },
  }

  classList = {
    contains: (name: string) => this.classes.has(name),
  }

  constructor({
    rect = { top: 0, right: 0, bottom: 0, left: 0 },
    offsetWidth,
    offsetHeight,
    classes = [],
    computed = {
      display: 'block',
      overflow: 'visible',
      overflowX: 'visible',
      overflowY: 'visible',
    },
  }: {
    rect?: PopoverRect
    offsetWidth?: number
    offsetHeight?: number
    classes?: string[]
    computed?: FakeStyle
  } = {}) {
    const width = rect.right - rect.left
    const height = rect.bottom - rect.top
    this.rect = {
      ...rect,
      x: rect.left,
      y: rect.top,
      width,
      height,
      toJSON: () => rect,
    } as DOMRect
    this.offsetWidth = offsetWidth ?? width
    this.offsetHeight = offsetHeight ?? height
    this.classes = new Set(classes)
    this.computed = computed
  }

  append(child: FakeElement): FakeElement {
    child.parentElement = this
    return child
  }

  registerQuery(selector: string, el: FakeElement): void {
    this.queryMap.set(selector, el)
  }

  querySelector(selector: string): FakeElement | null {
    return this.queryMap.get(selector) ?? null
  }

  getBoundingClientRect(): DOMRect {
    return this.rect
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }

  toggleAttribute(name: string, force?: boolean): boolean {
    const next = force ?? !this.attrs.has(name)
    if (next) this.attrs.set(name, '')
    else this.attrs.delete(name)
    return next
  }
}

function stubDomEnv({
  width = 1280,
  height = 800,
  body,
  documentElement,
}: {
  width?: number
  height?: number
  body?: FakeElement
  documentElement?: FakeElement
} = {}) {
  const docEl =
    documentElement ?? new FakeElement({ rect: { top: 0, right: width, bottom: height, left: 0 } })
  const docBody =
    body ?? new FakeElement({ rect: { top: 0, right: width, bottom: height, left: 0 } })
  docEl.append(docBody)
  vi.stubGlobal('window', { innerWidth: width, innerHeight: height })
  vi.stubGlobal('document', { body: docBody, documentElement: docEl })
  vi.stubGlobal('getComputedStyle', (node: FakeElement) => ({
    display: node.computed.display ?? 'block',
    overflow: node.computed.overflow ?? 'visible',
    overflowX: node.computed.overflowX ?? node.computed.overflow ?? 'visible',
    overflowY: node.computed.overflowY ?? node.computed.overflow ?? 'visible',
  }))
  return { docEl, docBody }
}

describe('DOM popover anchor, clipBox, and layout integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolvePopoverAnchor skips display: contents wrappers (such as .kettu-plan-ring)', () => {
    const { docBody } = stubDomEnv()
    const userMenu = docBody.append(
      new FakeElement({
        rect: { top: 748, right: 252, bottom: 788, left: 8 },
        computed: { display: 'flex' },
      }),
    )
    const planRing = userMenu.append(
      new FakeElement({
        rect: { top: 0, right: 0, bottom: 0, left: 0 },
        computed: { display: 'contents' },
      }),
    )
    const nestedContents = planRing.append(
      new FakeElement({
        rect: { top: 0, right: 0, bottom: 0, left: 0 },
        computed: { display: 'contents' },
      }),
    )
    const popover = nestedContents.append(new FakeElement())

    expect(resolvePopoverAnchor(popover as unknown as HTMLElement)).toBe(userMenu)
  })

  it('resolvePopoverAnchor returns the direct parent when it generates a box', () => {
    const { docBody } = stubDomEnv()
    const anchor = docBody.append(
      new FakeElement({
        rect: { top: 100, right: 200, bottom: 132, left: 100 },
        computed: { display: 'inline-flex' },
      }),
    )
    const popover = anchor.append(new FakeElement())

    expect(resolvePopoverAnchor(popover as unknown as HTMLElement)).toBe(anchor)
  })

  it('resolvePopoverClipBox skips display: contents ancestors even when they declare overflow', () => {
    const { docBody } = stubDomEnv({ width: 1280, height: 800 })
    const shell = docBody.append(
      new FakeElement({
        rect: { top: 0, right: 1280, bottom: 800, left: 0 },
        classes: ['ui-as'],
        computed: { display: 'grid', overflow: 'hidden' },
      }),
    )
    const scrollPane = shell.append(
      new FakeElement({
        rect: { top: 48, right: 1200, bottom: 760, left: 260 },
        computed: { display: 'block', overflowY: 'auto', overflowX: 'visible' },
      }),
    )
    // A display: contents wrapper with overflow: hidden produces an all-zero rect in browsers;
    // clipBox must skip it instead of collapsing the clip rect to 0x0.
    const contentsWrapper = scrollPane.append(
      new FakeElement({
        rect: { top: 0, right: 0, bottom: 0, left: 0 },
        classes: ['ui-as'],
        computed: {
          display: 'contents',
          overflow: 'hidden',
          overflowX: 'hidden',
          overflowY: 'hidden',
        },
      }),
    )
    const popover = contentsWrapper.append(new FakeElement())

    expect(resolvePopoverClipBox(popover as unknown as HTMLElement)).toEqual({
      top: 48,
      right: 1280,
      bottom: 760,
      left: 0,
    })
  })

  it('applyPopoverLayout keeps PlanRing popover above .ui-as-user-menu instead of flipping off-screen to bottom', () => {
    const { docBody } = stubDomEnv({ width: 1280, height: 800 })
    const shell = docBody.append(
      new FakeElement({
        rect: { top: 0, right: 1280, bottom: 800, left: 0 },
        classes: ['ui-as'],
        computed: { display: 'grid', overflow: 'hidden' },
      }),
    )
    const userMenu = shell.append(
      new FakeElement({
        rect: { top: 748, right: 252, bottom: 788, left: 8 },
        computed: { display: 'flex' },
      }),
    )
    const planRing = userMenu.append(
      new FakeElement({
        rect: { top: 0, right: 0, bottom: 0, left: 0 },
        computed: { display: 'contents' },
      }),
    )
    const popover = planRing.append(
      new FakeElement({
        rect: { top: 422, right: 288, bottom: 742, left: 8 },
        offsetWidth: 280,
        offsetHeight: 320,
      }),
    )

    const layout = applyPopoverLayout(popover as unknown as HTMLElement, 'top', 'start')

    expect(layout).not.toBeNull()
    expect(layout?.side).toBe('top')
    expect(layout?.overflow).toBe(false)
    // Available space above .ui-as-user-menu: 748 - 6 (gap) - 8 (margin) = 734px.
    expect(layout?.maxHeight).toBe(734)
    expect(popover.dataset.side).toBe('top')
    expect(popover.hasAttribute('data-overflow')).toBe(false)
    expect(popover.style.getPropertyValue('--as-popover-max-h')).toBe('734px')
  })

  it('applyPopoverLayout clamps PlanRing above .ui-as-user-menu in a short window without flipping off-screen', () => {
    const { docBody } = stubDomEnv({ width: 1280, height: 260 })
    const userMenu = docBody.append(
      new FakeElement({
        rect: { top: 212, right: 252, bottom: 252, left: 8 },
        computed: { display: 'flex' },
      }),
    )
    const planRing = userMenu.append(
      new FakeElement({
        rect: { top: 0, right: 0, bottom: 0, left: 0 },
        computed: { display: 'contents' },
      }),
    )
    const popover = planRing.append(
      new FakeElement({
        rect: { top: 0, right: 288, bottom: 320, left: 8 },
        offsetWidth: 280,
        offsetHeight: 320,
      }),
    )

    const layout = applyPopoverLayout(popover as unknown as HTMLElement, 'top', 'start')

    expect(layout?.side).toBe('top')
    expect(layout?.overflow).toBe(true)
    expect(layout?.maxHeight).toBe(198)
    expect(popover.dataset.side).toBe('top')
    expect(popover.hasAttribute('data-overflow')).toBe(true)
    expect(popover.style.getPropertyValue('--as-popover-max-h')).toBe('198px')
  })

  it('applyPopoverLayout preserves .ui-pmc__card scrollTop across re-measurements when constrained', () => {
    const { docBody } = stubDomEnv({ width: 1280, height: 260 })
    const userMenu = docBody.append(
      new FakeElement({
        rect: { top: 212, right: 268, bottom: 252, left: 8 },
        computed: { display: 'flex' },
      }),
    )
    const popover = userMenu.append(
      new FakeElement({
        rect: { top: 0, right: 268, bottom: 380, left: 8 },
        offsetWidth: 260,
        offsetHeight: 380,
      }),
    )
    const profileCard = new FakeElement()
    profileCard.scrollTop = 96
    popover.registerQuery('.ui-pmc__card', profileCard)

    const layout = applyPopoverLayout(popover as unknown as HTMLElement, 'top', 'start')

    expect(layout?.side).toBe('top')
    expect(layout?.overflow).toBe(true)
    expect(popover.hasAttribute('data-overflow')).toBe(true)
    expect(profileCard.scrollTop).toBe(96)
  })
})

describe('ProfileMenu flyout submenu clamping (clampSubmenuTop)', () => {
  it('keeps the submenu aligned with its row when there is enough vertical space', () => {
    expect(
      clampSubmenuTop({
        preferredTop: 120,
        rootTop: 200,
        sideHeight: 160,
        viewportHeight: 800,
      }),
    ).toBe(120)
  })

  it('shifts the submenu upward when opening from a bottom row in a short window', () => {
    // Card sits at rootTop=12 in a 260px window; Help row wants top=160 for a 164px submenu.
    // Bottom would reach 12 + 160 + 164 = 336 > 252 (260 - 8), so top clamps to 252 - 164 - 12 = 76.
    const top = clampSubmenuTop({
      preferredTop: 160,
      rootTop: 12,
      sideHeight: 164,
      viewportHeight: 260,
    })
    expect(top).toBe(76)
    expect(12 + top + 164).toBe(252)
    expect(12 + top).toBeGreaterThanOrEqual(8)
  })

  it('pins the submenu to the top viewport margin when the window is shorter than the submenu', () => {
    const top = clampSubmenuTop({
      preferredTop: 80,
      rootTop: 20,
      sideHeight: 180,
      viewportHeight: 140,
    })
    // minTop = 8 - 20 = -12 so rendered top = 20 + (-12) = 8px.
    expect(top).toBe(-12)
  })
})

describe('DateRangePicker panel placement and clamping', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolvePopoverMaxWidth computes usable CSS width inside clip margins', () => {
    expect(resolvePopoverMaxWidth({ top: 0, right: 1042, bottom: 760, left: 272 })).toBe(754)
    expect(resolvePopoverMaxWidth({ top: 0, right: 872, bottom: 700, left: 272 })).toBe(584)
    expect(resolvePopoverMaxWidth({ top: 0, right: 800, bottom: 600, left: 0 }, 2)).toBe(384)
    expect(resolvePopoverMaxWidth({ top: 0, right: 100, bottom: 600, left: 100 })).toBeNull()
  })

  it('resolvePopoverClipAncestors collects clipping boxes while skipping display: contents', () => {
    const { docBody } = stubDomEnv({ width: 1050, height: 760 })
    const shell = docBody.append(
      new FakeElement({
        rect: { top: 0, right: 1050, bottom: 760, left: 0 },
        classes: ['ui-as'],
        computed: { display: 'grid', overflow: 'hidden' },
      }),
    )
    const sheet = shell.append(
      new FakeElement({
        rect: { top: 8, right: 1042, bottom: 752, left: 272 },
        computed: { display: 'block', overflow: 'clip' },
      }),
    )
    const contents = sheet.append(
      new FakeElement({
        rect: { top: 0, right: 0, bottom: 0, left: 0 },
        computed: { display: 'contents', overflow: 'hidden' },
      }),
    )
    const usageScroll = contents.append(
      new FakeElement({
        rect: { top: 8, right: 1042, bottom: 752, left: 272 },
        computed: { display: 'block', overflowX: 'auto', overflowY: 'auto' },
      }),
    )
    const panel = usageScroll.append(new FakeElement())

    expect(resolvePopoverClipAncestors(panel as unknown as HTMLElement)).toEqual([
      usageScroll,
      sheet,
      shell,
    ])
  })

  it('shifts an end-aligned Usage date picker rightward so its left presets rail is never clipped (issue #2875)', () => {
    // Desktop window with sidebar open (272px): Usage sheet spans x=[272..1042] (width 770px <= 1000px).
    // Wrapped left-aligned controls place the calendar button at x=[718..746], leaving only 474px to the
    // sheet's left edge while the dual-month panel is 652px wide.
    const { docBody } = stubDomEnv({ width: 1050, height: 760 })
    const sheet = docBody.append(
      new FakeElement({
        rect: { top: 8, right: 1042, bottom: 752, left: 272 },
        computed: { display: 'block', overflow: 'clip' },
      }),
    )
    const usage = sheet.append(
      new FakeElement({
        rect: { top: 8, right: 1042, bottom: 752, left: 272 },
        computed: { display: 'block', overflowX: 'auto', overflowY: 'auto' },
      }),
    )
    const anchor = usage.append(
      new FakeElement({
        rect: { top: 104, right: 746, bottom: 132, left: 718 },
        computed: { display: 'inline-block' },
      }),
    )
    const panel = anchor.append(
      new FakeElement({
        rect: { top: 138, right: 746, bottom: 478, left: 94 },
        offsetWidth: 652,
        offsetHeight: 340,
      }),
    )

    const layout = applyDateRangePanelLayout(panel as unknown as HTMLElement, 'end')

    expect(layout).not.toBeNull()
    expect(panel.style.getPropertyValue('--ui-drpc-panel-max-w')).toBe('754px')
    expect(layout?.side).toBe('bottom')
    expect(layout?.align).toBe('end')
    // endLeft = 746 - 652 = 94, usableLeft = 272 + 8 = 280 => dx = +186px.
    expect(layout?.dx).toBe(186)
    expect(panel.style.translate).toBe('186px 0px')

    const bounds = renderedBounds(
      layout!,
      { top: 104, right: 746, bottom: 132, left: 718 },
      652,
      340,
    )
    expect(bounds.left).toBe(272 + POPOVER_MARGIN)
    expect(bounds.right).toBeLessThanOrEqual(1042 - POPOVER_MARGIN)
    expect(bounds.bottom).toBeLessThanOrEqual(752 - POPOVER_MARGIN)
  })

  it('flips an end-aligned Usage date picker to align="start" when the trigger wraps near the left edge', () => {
    const { docBody } = stubDomEnv({ width: 1050, height: 760 })
    const sheet = docBody.append(
      new FakeElement({
        rect: { top: 8, right: 1042, bottom: 752, left: 272 },
        computed: { display: 'block', overflow: 'clip' },
      }),
    )
    const anchor = sheet.append(
      new FakeElement({
        rect: { top: 140, right: 320, bottom: 168, left: 292 },
        computed: { display: 'inline-block' },
      }),
    )
    const panel = anchor.append(
      new FakeElement({
        rect: { top: 174, right: 944, bottom: 514, left: 292 },
        offsetWidth: 652,
        offsetHeight: 340,
      }),
    )

    const layout = applyDateRangePanelLayout(panel as unknown as HTMLElement, 'end')

    expect(layout?.align).toBe('start')
    expect(layout?.dx).toBe(0)
    expect(panel.dataset.align).toBe('start')
    expect(panel.style.translate).toBe('')
  })

  it('caps panel width to narrow pane clip width so single-month layout fits without clipping either edge', () => {
    const { docBody } = stubDomEnv({ width: 880, height: 720 })
    const sheet = docBody.append(
      new FakeElement({
        rect: { top: 8, right: 872, bottom: 712, left: 272 },
        computed: { display: 'block', overflow: 'clip' },
      }),
    )
    const anchor = sheet.append(
      new FakeElement({
        rect: { top: 140, right: 560, bottom: 168, left: 532 },
        computed: { display: 'inline-block' },
      }),
    )
    // Simulate container query narrowing the panel to the 584px max width applied via --ui-drpc-panel-max-w.
    const panel = anchor.append(
      new FakeElement({
        rect: { top: 174, right: 560, bottom: 554, left: -24 },
        offsetWidth: 652,
        offsetHeight: 380,
      }),
    )
    const origSetProp = panel.style.setProperty
    panel.style.setProperty = (name: string, value: string) => {
      origSetProp(name, value)
      if (name === '--ui-drpc-panel-max-w') {
        const px = Number.parseFloat(value)
        if (Number.isFinite(px)) panel.offsetWidth = Math.min(652, px)
      }
    }

    const layout = applyDateRangePanelLayout(panel as unknown as HTMLElement, 'end')

    expect(panel.style.getPropertyValue('--ui-drpc-panel-max-w')).toBe('584px')
    expect(panel.offsetWidth).toBe(584)
    const bounds = renderedBounds(
      layout!,
      { top: 140, right: 560, bottom: 168, left: 532 },
      584,
      380,
    )
    expect(bounds.left).toBe(272 + POPOVER_MARGIN)
    expect(bounds.right).toBe(872 - POPOVER_MARGIN)
  })

  it('keeps wide desktop end-aligned date picker flush right with zero translation', () => {
    const { docBody } = stubDomEnv({ width: 1440, height: 900 })
    const sheet = docBody.append(
      new FakeElement({
        rect: { top: 8, right: 1432, bottom: 892, left: 272 },
        computed: { display: 'block', overflow: 'clip' },
      }),
    )
    const anchor = sheet.append(
      new FakeElement({
        rect: { top: 12, right: 1368, bottom: 40, left: 1340 },
        computed: { display: 'inline-block' },
      }),
    )
    const panel = anchor.append(
      new FakeElement({
        rect: { top: 46, right: 1368, bottom: 386, left: 716 },
        offsetWidth: 652,
        offsetHeight: 340,
      }),
    )

    const layout = applyDateRangePanelLayout(panel as unknown as HTMLElement, 'end')

    expect(layout?.side).toBe('bottom')
    expect(layout?.align).toBe('end')
    expect(layout?.dx).toBe(0)
    expect(layout?.dy).toBe(0)
    expect(layout?.overflow).toBe(false)
    expect(panel.style.translate).toBe('')
  })

  it('constrains height, scrolls .ui-drpc__clip, and preserves scrollTop in short windows', () => {
    const { docBody } = stubDomEnv({ width: 1050, height: 360 })
    const sheet = docBody.append(
      new FakeElement({
        rect: { top: 8, right: 1042, bottom: 352, left: 272 },
        computed: { display: 'block', overflow: 'clip' },
      }),
    )
    const anchor = sheet.append(
      new FakeElement({
        rect: { top: 96, right: 746, bottom: 124, left: 718 },
        computed: { display: 'inline-block' },
      }),
    )
    const panel = anchor.append(
      new FakeElement({
        rect: { top: 130, right: 746, bottom: 470, left: 94 },
        offsetWidth: 652,
        offsetHeight: 340,
      }),
    )
    const clipEl = new FakeElement()
    clipEl.scrollTop = 48
    panel.registerQuery(':scope > .ui-drpc__clip', clipEl)

    const layout = applyDateRangePanelLayout(panel as unknown as HTMLElement, 'end')

    expect(layout?.side).toBe('bottom')
    expect(layout?.overflow).toBe(true)
    // Below space: 352 - 8 (margin) - 124 - 6 (gap) = 214px.
    expect(layout?.maxHeight).toBe(214)
    expect(panel.style.getPropertyValue('--ui-drpc-panel-max-h')).toBe('214px')
    expect(panel.hasAttribute('data-overflow')).toBe(true)
    expect(clipEl.scrollTop).toBe(48)
  })

  it('keeps DateRangePicker CSS and positioning integration contract intact', () => {
    expect(dateRangePickerCss).toMatch(
      /\.ui-drpc__panel\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*width:\s*min\(var\(--ui-drpc-panel-width,\s*min\(652px,\s*calc\(100vw - 32px\)\)\),\s*var\(--ui-drpc-panel-max-w,\s*100vw\)\);[^}]*max-height:\s*var\(--ui-drpc-panel-max-h,\s*none\);/,
    )
    expect(dateRangePickerCss).toMatch(
      /\.ui-drpc\[data-align="end"\]\s+\.ui-drpc__panel:not\(\[data-align="start"\]\),\s*\.ui-drpc__panel\[data-align="end"\]\s*\{\s*left:\s*auto;\s*right:\s*0;\s*transform-origin:\s*top right;\s*\}/,
    )
    expect(dateRangePickerCss).toMatch(
      /\.ui-drpc__panel\[data-side="top"\]\s*\{\s*top:\s*auto;\s*bottom:\s*calc\(100% \+ 6px\);/,
    )
    expect(dateRangePickerCss).toMatch(
      /\.ui-drpc__panel\[data-overflow\]\s+\.ui-drpc__clip\s*\{\s*overflow-y:\s*auto;\s*overscroll-behavior:\s*contain;\s*\}/,
    )
    expect(dateRangePickerCss).toMatch(/\.ui-drpc__foot\s*\{[^}]*flex:\s*none;/)
    expect(dateRangePickerCss).toContain('@container (max-width: 639px)')

    const source = readFileSync(
      new URL('../components/affect/date-range-picker.tsx', import.meta.url),
      'utf8',
    )
    expect(source).toContain('applyDateRangePanelLayout(el, align)')
    expect(source).toContain('resolvePopoverClipAncestors(el)')
    expect(source).toContain('data-side={place.side}')
    expect(source).toContain('data-align={place.align}')
  })
})
