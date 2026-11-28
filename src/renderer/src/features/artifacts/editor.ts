import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  RUNTIME_VERSION,
  type PageBox,
  type PageKey,
  type PageSelection,
  type Pin,
  type PinColors,
  type PreviewStyle,
} from '@shared/artifact-runtime/page-messages'
import { FrameLink } from './frame-link'
import { unionRects } from './pop-place-layout'

/** How long a page has to say where an element lies. */
const LOCATE_WAIT_MS = 2000
/** How long revealing a comment waits for the frame to report its pin position before centring. */
const REVEAL_WAIT_MS = 120

export type ViewportBox = { left: number; top: number; right: number; bottom: number }

export type EditorMode = 'select' | 'comment' | null

/** Which element in which page frame an open popover is currently tracking. */
export interface AnchorTrackSpec {
  page: number | null
  target: number | 'picked'
}

/** Live window-coordinate bounds of a tracked anchor and its visible iframe clip. */
export interface TrackedAnchor {
  box: ViewportBox | null
  clip: ViewportBox | null
}

/** An element picked in a page: the canvas page it is on, or null for a single page. */
export interface Picked {
  page: number | null
  selection: PageSelection
  /** Where the pointer picked it, in the window, as fallback; null when not by pointer. */
  point: { x: number; y: number } | null
  /** Initial highlight bounding box in window coordinates, when reported with the pick. */
  box: ViewportBox | null
}

/** Multiple elements selected together via marquee drag on one page; null page for a single page. */
export interface PickedGroup {
  /** Monotonic group id; stays stable when removing individual chips so popover drafts survive. */
  id: number
  page: number | null
  selections: PageSelection[]
  /** Initial union highlight bounding box in window coordinates, when reported. */
  box: ViewportBox | null
}

/** A comment pin clicked in a page: its number, the canvas page it is on and where. */
export interface PinClick {
  n: number
  page: number | null
  point: { x: number; y: number } | null
  /** Initial bounding box of the pin's anchored element in window coordinates, when reported. */
  box: ViewportBox | null
}

export interface EditorState {
  mode: EditorMode
  picked: Picked | null
  /** Multiple elements selected via marquee drag in select mode; mutually exclusive with `picked`. */
  pickedGroup: PickedGroup | null
  /** The pin last clicked, whose thread opens beside it, until something else is picked. */
  pin: PinClick | null
  /** The picked element's text is being typed in place. */
  typing: boolean
}

/** A frame the editor drives, and the page of the canvas it shows; null for a single page. */
export interface EditorFrame {
  readonly link: FrameLink
  readonly page: number | null
  /** Points at a spot of the page, in its own pixels, outlining the element there. */
  point(x: number, y: number): void
  leave(): void
  /** Picks the element at a spot of the page; `at` is the pointer's place in the window. */
  pick(x: number, y: number, at: { x: number; y: number }): void
  /** Updates the live marquee selection rectangle in page pixels; null cancels it. */
  marquee(rect: PageBox | null): void
  /** Commits the marquee selection rectangle in page pixels. */
  marqueeCommit(rect: PageBox): void
  /** The frame loaded a page, which needs driving again. */
  loaded(): void
  /** Starts driving the frame, until `release`; it may open again after. */
  open(): void
  release(): void
  /** Where the element whose start tag lies at `src` is in the page, or null; null after a while. */
  locate(src: number): Promise<PageBox | null>
  /** Reveals the element at `src` and returns its pin box in window coordinates, or null. */
  reveal(src: number): Promise<ViewportBox | null>
  /**
   * Sets the page's declared parameters, shown at once and kept until it reloads; `hold` sets
   * them on each page the frame loads too, until they are set without it.
   */
  params(values: Record<string, string | number | boolean>, hold?: boolean): void
  /** Takes the keys the page passes on, until null. */
  keys(listener: ((key: PageKey) => void) | null): void
  /** Scrolls the page under a pick layer, which takes the wheel. */
  scroll(dx: number, dy: number): void
  /** Types the element picked in this frame in place, if it is picked here. */
  typeIn(): void
}

const themeColor = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** The picked element's outline and tag, and the open thread's pin. */
export function accent(): string {
  return themeColor('--control-on')
}

/** Pins take the same look as the comments card's numbers. */
function pinColors(): PinColors {
  return {
    ink: themeColor('--text-primary'),
    text: themeColor('--bg-surface'),
    ground: themeColor('--bg-surface'),
    done: themeColor('--success'),
  }
}

/**
 * Select and comment mode over an artifact's frames, as the viewer's mode sets it: the element picked
 * in one of them and the comment pins on each page, and the preview of an edit on the picked one.
 */
export class ArtifactEditor {
  private state: EditorState = {
    mode: null,
    picked: null,
    pickedGroup: null,
    pin: null,
    typing: false,
  }
  private readonly typedListeners = new Set<(text: string, done: boolean) => void>()
  private readonly listeners = new Set<() => void>()
  private readonly anchorListeners = new Set<() => void>()
  private readonly frames = new Set<EditorFrame>()
  private pins: (page: number | null) => Pin[] = () => []
  private pickedBy: EditorFrame | null = null
  private groupSeq = 0
  private pointing: { frame: EditorFrame; x: number; y: number } | null = null
  private pointFrame = 0
  private marqueePending: { frame: EditorFrame; rect: PageBox } | null = null
  private marqueeFrame = 0
  private wanted: { page: number | null; src: number } | null = null
  private anchorSpec: AnchorTrackSpec | null = null
  private anchorContainer: HTMLElement | null = null
  private anchorFrame: EditorFrame | null = null
  private anchorRawBox: PageBox | null = null
  private anchorState: TrackedAnchor | null = null

  /** `origin` is the artifact's URL as `artifact:open` gave it, without its last slash. */
  constructor(private readonly origin: string) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get = (): EditorState => this.state

  private set(patch: Partial<EditorState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** A frame for an iframe that shows `page`, driven once it opens. */
  frame(page: number | null): EditorFrame {
    let lastPick: { x: number; y: number } | null = null
    const locating = new Map<number, (box: PageBox | null) => void>()
    const frame: EditorFrame = {
      link: new FrameLink(
        this.origin,
        (selection, { selections, located, pin, pinBox, typed, anchor }) => {
          if (located) {
            locating.get(located.src)?.(located.box)
            locating.delete(located.src)
            return
          }
          if (anchor) {
            if (this.anchorFrame === frame) this.updateAnchor(frame, anchor.box)
            return
          }
          if (pin !== undefined) {
            if (this.state.mode) {
              this.set({
                pin: {
                  n: pin,
                  page: frame.page,
                  point: lastPick,
                  box: pinBox ? frame.link.viewportBox(pinBox) : null,
                },
              })
            }
            lastPick = null
            return
          }
          if (typed) {
            if (this.pickedBy !== frame) return
            if (typed.done) this.set({ typing: false })
            for (const listener of this.typedListeners) listener(typed.text, typed.done)
            return
          }
          if (selections) {
            lastPick = null
            this.pickedMany(frame, selections)
            return
          }
          this.picked(frame, selection, lastPick)
          lastPick = null
        },
      ),
      locate: (src) =>
        new Promise((resolve) => {
          locating.get(src)?.(null)
          locating.set(src, resolve)
          setTimeout(() => {
            if (locating.get(src) === resolve) {
              locating.delete(src)
              resolve(null)
            }
          }, LOCATE_WAIT_MS)
          frame.link.post({
            v: RUNTIME_VERSION,
            kind: 'select-locate',
            src,
            channel: frame.link.channel,
          })
        }),
      reveal: (src) => {
        if (!frame.link.hasFrame()) return Promise.resolve(null)
        return new Promise((resolve) => {
          const finish = (box: PageBox | null): void => {
            if (box) frame.link.scrollHostToBox(box, this.anchorContainer)
            resolve(box ? frame.link.viewportBox(box) : null)
          }
          locating.get(src)?.(null)
          locating.set(src, finish)
          setTimeout(() => {
            if (locating.get(src) === finish) {
              locating.delete(src)
              resolve(null)
            }
          }, REVEAL_WAIT_MS)
          frame.link.post({
            v: RUNTIME_VERSION,
            kind: 'select-reveal',
            src,
            channel: frame.link.channel,
          })
        })
      },
      params: (values, hold) => {
        const message = { v: RUNTIME_VERSION, kind: 'params', values } as const
        if (hold) frame.link.keep(message)
        else frame.link.forget('params')
        frame.link.post(message)
      },
      keys: (listener) => frame.link.keys(listener),
      scroll: (dx, dy) => frame.link.post({ v: RUNTIME_VERSION, kind: 'select-scroll', dx, dy }),
      typeIn: () => {
        if (this.pickedBy === frame && this.state.picked?.selection.textOnly) this.textEdit(true)
      },
      page,
      point: (x, y) => {
        this.pointing = { frame, x, y }
        if (this.pointFrame) return
        this.pointFrame = requestAnimationFrame(() => {
          this.pointFrame = 0
          const at = this.pointing
          if (!at) return
          at.frame.link.post({ v: RUNTIME_VERSION, kind: 'select-point', x: at.x, y: at.y })
        })
      },
      leave: () => {
        if (this.pointing?.frame === frame) this.pointing = null
        frame.link.post({ v: RUNTIME_VERSION, kind: 'select-leave' })
      },
      pick: (x, y, at) => {
        lastPick = at
        frame.link.post({ v: RUNTIME_VERSION, kind: 'select-pick', x, y })
      },
      marquee: (rect) => {
        if (rect === null) {
          if (this.marqueePending?.frame === frame) this.marqueePending = null
          if (this.marqueeFrame) {
            cancelAnimationFrame(this.marqueeFrame)
            this.marqueeFrame = 0
          }
          frame.link.post({ v: RUNTIME_VERSION, kind: 'select-marquee', rect: null })
          return
        }
        this.marqueePending = { frame, rect }
        if (this.marqueeFrame) return
        this.marqueeFrame = requestAnimationFrame(() => {
          this.marqueeFrame = 0
          const pending = this.marqueePending
          this.marqueePending = null
          if (!pending) return
          pending.frame.link.post({
            v: RUNTIME_VERSION,
            kind: 'select-marquee',
            rect: pending.rect,
            commit: false,
          })
        })
      },
      marqueeCommit: (rect) => {
        if (this.marqueePending?.frame === frame) this.marqueePending = null
        if (this.marqueeFrame) {
          cancelAnimationFrame(this.marqueeFrame)
          this.marqueeFrame = 0
        }
        frame.link.post({ v: RUNTIME_VERSION, kind: 'select-marquee', rect, commit: true })
      },
      loaded: () => {
        frame.link.loaded()
      },
      open: () => {
        frame.link.open()
        this.frames.add(frame)
        this.drive(frame)
        if (this.anchorSpec && this.anchorSpec.page === frame.page) this.syncAnchorFrame()
      },
      release: () => {
        this.frames.delete(frame)
        frame.link.dispose()
        if (this.pickedBy === frame) {
          this.pickedBy = null
          if (this.state.pickedGroup) this.set({ pickedGroup: null })
        }
        if (this.anchorFrame === frame) {
          this.anchorFrame = null
          this.anchorRawBox = null
          if (this.anchorSpec) this.syncAnchorFrame()
        }
      },
    }
    return frame
  }

  private drive(frame: EditorFrame): void {
    frame.link.post({
      v: RUNTIME_VERSION,
      kind: 'select-mode',
      mode: this.state.mode,
      channel: frame.link.channel,
      accent: accent(),
      pinColors: pinColors(),
    })
    frame.link.post({ v: RUNTIME_VERSION, kind: 'select-pins', pins: this.pins(frame.page) })
    this.want(frame)
  }

  /**
   * Picks the element whose start tag lies at `src` on `page`, once a frame shows the page in
   * select mode, as a pick by pointer would; until something else is picked or the pick let go.
   */
  repick(page: number | null, src: number): void {
    this.wanted = { page, src }
    for (const frame of this.frames) this.want(frame)
  }

  private want(frame: EditorFrame): void {
    const wanted = this.wanted
    if (!wanted || wanted.page !== frame.page || this.state.mode !== 'select') return
    frame.link.post({ v: RUNTIME_VERSION, kind: 'select-source', src: wanted.src, tell: true })
  }

  /** Sends the theme's colors again, as after the color mode changed. */
  restyle(): void {
    for (const frame of this.frames) this.drive(frame)
  }

  setMode(mode: EditorMode): void {
    if (mode === this.state.mode) return
    if (
      mode === null ||
      this.state.mode === null ||
      (mode !== 'select' && this.state.pickedGroup)
    ) {
      // Entering a mode lets go of nothing asked for meanwhile.
      const wanted = mode ? this.wanted : null
      this.clearPick()
      this.wanted = wanted
    }
    this.set({ mode, pin: null })
    for (const frame of this.frames) this.drive(frame)
  }

  /** What Esc does here: closing a pin's thread, or letting go of the pick; false for neither. */
  escape(): boolean {
    if (this.state.pin) {
      this.set({ pin: null })
      return true
    }
    if (!this.state.picked && !this.state.pickedGroup) return false
    this.clearPick()
    return true
  }

  /** Where the picked element lies in its page, or null when it cannot be found. */
  locatePicked(): Promise<PageBox | null> {
    const src = this.state.picked?.selection.src
    if (!this.pickedBy || src === null || src === undefined) return Promise.resolve(null)
    return this.pickedBy.locate(src)
  }

  /** Where the marquee-picked elements lie in their page, in document pixels, for cropped screenshots. */
  async locatePickedGroup(): Promise<PageBox[]> {
    const group = this.state.pickedGroup
    const frame = this.pickedBy
    if (!group || !frame) return []
    const srcs = group.selections
      .map((s) => s.src)
      .filter((src): src is number => src !== null && src !== undefined)
    if (srcs.length === 0) return []
    const located = await Promise.all(srcs.map((src) => frame.locate(src)))
    return located.filter((box): box is PageBox => box !== null)
  }

  /** Removes a single element from the active marquee selection by index, syncing iframe highlights. */
  removeFromPickedGroup(index: number): void {
    const group = this.state.pickedGroup
    if (!group || index < 0 || index >= group.selections.length) return
    const next = group.selections.filter((_, i) => i !== index)
    if (next.length === 0) {
      this.clearPick()
      return
    }
    this.pickedBy?.link.post({ v: RUNTIME_VERSION, kind: 'select-remove', index })
    const box = this.pickedBy ? this.unionViewportBox(this.pickedBy, next) : null
    this.set({
      pickedGroup: {
        ...group,
        selections: next,
        box,
      },
    })
  }

  /** Scrolls the element at `src` into view in the frames that show `page`. */
  reveal(page: number | null, src: number): void {
    for (const frame of this.frames) {
      if (frame.page === page) frame.link.post({ v: RUNTIME_VERSION, kind: 'select-reveal', src })
    }
  }

  /**
   * Reveals the element at `src` in the open frame for `page` and returns its highlight box in
   * window coordinates so a thread popover can anchor beside it; returns null when unavailable.
   */
  revealPin(page: number | null, src: number): Promise<ViewportBox | null> {
    const list = [...this.frames]
    for (let i = list.length - 1; i >= 0; i--) {
      const frame = list[i]!
      if (frame.page === page && frame.link.hasFrame()) return frame.reveal(src)
    }
    return Promise.resolve(null)
  }

  /** Subscribes to live anchor bounds updates without re-rendering general editor subscribers. */
  subscribeAnchor = (listener: () => void): (() => void) => {
    this.anchorListeners.add(listener)
    return () => this.anchorListeners.delete(listener)
  }

  /** Latest window-space anchor box and visible iframe clip, or null when not yet reported. */
  getAnchor = (): TrackedAnchor | null => this.anchorState

  /**
   * Starts tracking the viewport-relative bounds of an element while a popover is open, or stops
   * tracking when `spec` is null.
   */
  trackAnchor(spec: AnchorTrackSpec | null, container: HTMLElement | null = null): void {
    const same =
      this.anchorSpec?.page === spec?.page &&
      this.anchorSpec?.target === spec?.target &&
      this.anchorContainer === container
    if (same && (spec === null || this.anchorFrame !== null)) return
    this.anchorSpec = spec
    this.anchorContainer = container
    this.anchorRawBox = null
    this.setAnchorState(null)
    this.syncAnchorFrame()
  }

  /** Recomputes tracked anchor window coordinates after host-side scroll, pan, zoom, or resize. */
  recomputeAnchor(): void {
    if (!this.anchorFrame || !this.anchorRawBox) return
    this.updateAnchor(this.anchorFrame, this.anchorRawBox)
  }

  /** Smoothly scrolls the tracked anchor back into view inside both the iframe and any host scroller. */
  scrollToAnchor(): void {
    if (!this.anchorSpec) return
    const frame = this.anchorFrame ?? this.findAnchorFrame(this.anchorSpec)
    if (!frame) return
    if (this.anchorRawBox) frame.link.scrollHostToBox(this.anchorRawBox, this.anchorContainer)
    frame.link.post({
      v: RUNTIME_VERSION,
      kind: 'select-scroll-anchor',
      target: this.anchorSpec.target,
    })
  }

  private findAnchorFrame(spec: AnchorTrackSpec): EditorFrame | null {
    if (
      spec.target === 'picked' &&
      this.pickedBy &&
      this.pickedBy.page === spec.page &&
      this.pickedBy.link.hasFrame()
    ) {
      return this.pickedBy
    }
    const list = [...this.frames]
    for (let i = list.length - 1; i >= 0; i--) {
      const frame = list[i]!
      if (frame.page === spec.page && frame.link.hasFrame()) return frame
    }
    return null
  }

  private syncAnchorFrame(): void {
    const nextFrame = this.anchorSpec ? this.findAnchorFrame(this.anchorSpec) : null
    if (this.anchorFrame && this.anchorFrame !== nextFrame) {
      this.anchorFrame.link.forget('select-anchor')
      this.anchorFrame.link.post({
        v: RUNTIME_VERSION,
        kind: 'select-anchor',
        channel: this.anchorFrame.link.channel,
        target: null,
      })
    }
    this.anchorFrame = nextFrame
    if (!nextFrame || !this.anchorSpec) return
    nextFrame.link.post({
      v: RUNTIME_VERSION,
      kind: 'select-anchor',
      channel: nextFrame.link.channel,
      target: this.anchorSpec.target,
    })
  }

  private updateAnchor(frame: EditorFrame, rawBox: PageBox | null): void {
    this.anchorRawBox = rawBox
    const box = rawBox ? frame.link.viewportBox(rawBox) : null
    const clip = frame.link.visibleBounds(this.anchorContainer)
    this.setAnchorState({ box, clip })
  }

  private setAnchorState(next: TrackedAnchor | null): void {
    const prev = this.anchorState
    if (
      boxesEqual(prev?.box ?? null, next?.box ?? null) &&
      boxesEqual(prev?.clip ?? null, next?.clip ?? null)
    ) {
      if ((prev === null) === (next === null)) return
    }
    this.anchorState = next
    for (const listener of this.anchorListeners) listener()
  }

  /** Closes the thread of the pin last clicked. */
  clearPin(): void {
    if (this.state.pin) this.set({ pin: null })
  }

  /** Picks the element `levels` around the picked one, as a pick by pointer would. */
  up(levels: number): void {
    this.pickedBy?.link.post({ v: RUNTIME_VERSION, kind: 'select-up', levels })
  }

  /** Starts or ends typing the picked element's text in place, which `onTyped` hears. */
  textEdit(on: boolean): void {
    const link = this.pickedBy?.link
    if (!link || on === this.state.typing) return
    link.post({ v: RUNTIME_VERSION, kind: 'text-edit', on })
    // A page cannot take the keyboard from the window on its own.
    if (on) link.focus()
    this.set({ typing: on })
  }

  onTyped(listener: (text: string, done: boolean) => void): () => void {
    this.typedListeners.add(listener)
    return () => this.typedListeners.delete(listener)
  }

  /** The pins each page shows, from the threads; called again whenever they change. */
  setPins(pins: (page: number | null) => Pin[]): void {
    this.pins = pins
    for (const frame of this.frames) {
      frame.link.post({ v: RUNTIME_VERSION, kind: 'select-pins', pins: pins(frame.page) })
    }
  }

  private unionViewportBox(
    frame: EditorFrame,
    selections: readonly PageSelection[],
  ): ViewportBox | null {
    const boxes: ViewportBox[] = []
    for (const item of selections) {
      if (!item.box) continue
      const mapped = frame.link.viewportBox(item.box)
      if (mapped) boxes.push(mapped)
    }
    return unionRects(boxes)
  }

  private pickedMany(frame: EditorFrame, selections: PageSelection[]): void {
    if (this.state.mode !== 'select') return
    this.wanted = null
    if (this.pickedBy && this.pickedBy !== frame) {
      this.pickedBy.link.post({ v: RUNTIME_VERSION, kind: 'select-source', src: null })
    }
    frame.link.forget('select-source')
    if (selections.length === 0) {
      this.pickedBy = null
      this.set({ picked: null, pickedGroup: null, pin: null, typing: false })
      return
    }
    const box = this.unionViewportBox(frame, selections)
    this.pickedBy = frame
    this.set({
      picked: null,
      pickedGroup: {
        id: ++this.groupSeq,
        page: frame.page,
        selections,
        box,
      },
      pin: null,
      typing: false,
    })
  }

  private picked(
    frame: EditorFrame,
    selection: PageSelection | null,
    point: { x: number; y: number } | null,
  ): void {
    if (!this.state.mode) return
    if (selection) this.wanted = null
    const was = this.state.picked
    if (this.pickedBy && this.pickedBy !== frame) {
      this.pickedBy.link.post({ v: RUNTIME_VERSION, kind: 'select-source', src: null })
    }
    // The page picks the same element again when it loads, such as with the version an edit wrote.
    frame.link.keep({
      v: RUNTIME_VERSION,
      kind: 'select-source',
      src: selection?.src ?? null,
      tell: true,
    })
    const again = this.pickedBy === frame && was?.selection.src === selection?.src
    const box = selection?.box ? frame.link.viewportBox(selection.box) : null
    this.pickedBy = selection ? frame : null
    this.set({
      picked: selection
        ? {
            page: frame.page,
            selection,
            point: point ?? (again ? was!.point : null),
            box: box ?? (again ? was!.box : null),
          }
        : null,
      pickedGroup: null,
      pin: null,
      // The same element picked again, by a double click's second click, keeps being typed.
      typing: again && this.state.typing,
    })
  }

  /** Lets go of the picked element or marquee selection, putting back any preview on it. */
  clearPick(): void {
    this.wanted = null
    if (this.marqueeFrame) {
      cancelAnimationFrame(this.marqueeFrame)
      this.marqueeFrame = 0
    }
    this.marqueePending = null
    if (this.pickedBy) {
      if (this.state.typing) {
        this.pickedBy.link.post({ v: RUNTIME_VERSION, kind: 'text-edit', on: false })
      }
      this.pickedBy.link.post({ v: RUNTIME_VERSION, kind: 'preview-reset' })
      this.pickedBy.link.post({ v: RUNTIME_VERSION, kind: 'select-source', src: null })
    }
    this.pickedBy = null
    if (this.state.picked || this.state.pickedGroup || this.state.typing) {
      this.set({ picked: null, pickedGroup: null, typing: false })
    }
  }

  /** Shows a style and a text on the picked element, in its page only; nothing is written. */
  preview(style: PreviewStyle, text: string | null): void {
    const link = this.pickedBy?.link
    if (!link) return
    link.post({ v: RUNTIME_VERSION, kind: 'preview-reset' })
    link.post({ v: RUNTIME_VERSION, kind: 'preview-style', style })
    if (text !== null) link.post({ v: RUNTIME_VERSION, kind: 'preview-text', text })
  }

  resetPreview(): void {
    this.pickedBy?.link.post({ v: RUNTIME_VERSION, kind: 'preview-reset' })
  }

  dispose(): void {
    cancelAnimationFrame(this.pointFrame)
    cancelAnimationFrame(this.marqueeFrame)
    this.marqueePending = null
    this.anchorSpec = null
    this.anchorContainer = null
    this.anchorFrame = null
    this.anchorRawBox = null
    this.anchorState = null
    this.anchorListeners.clear()
    for (const frame of [...this.frames]) frame.release()
  }
}

function boxesEqual(a: ViewportBox | null, b: ViewportBox | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    Math.abs(a.left - b.left) < 0.25 &&
    Math.abs(a.top - b.top) < 0.25 &&
    Math.abs(a.right - b.right) < 0.25 &&
    Math.abs(a.bottom - b.bottom) < 0.25
  )
}

const IDLE: EditorState = {
  mode: null,
  picked: null,
  pickedGroup: null,
  pin: null,
  typing: false,
}
const idle = (): EditorState => IDLE
const noChanges = (): (() => void) => () => {}

/** The editor's state; a view without one is never editing. */
export function useEditorState(editor: ArtifactEditor | null | undefined): EditorState {
  return useSyncExternalStore(editor?.subscribe ?? noChanges, editor?.get ?? idle)
}

/**
 * The editor's frame for an iframe that shows `page`, while it is mounted: attach the iframe to
 * its link and tell it when the iframe loads, through the callbacks this returns.
 */
export function useEditorFrame(
  editor: ArtifactEditor | undefined,
  page: number | null,
): {
  frame: EditorFrame | null
  ref: (element: HTMLIFrameElement | null) => void
  onLoad: () => void
} {
  const frame = useMemo(() => editor?.frame(page) ?? null, [editor, page])
  const element = useRef<HTMLIFrameElement | null>(null)
  const loaded = useRef(false)

  useEffect(() => {
    if (!frame) return
    frame.link.attach(element.current)
    frame.open()
    // A page that loaded before the frame opened gets driven now.
    if (loaded.current) frame.loaded()
    return () => frame.release()
  }, [frame])

  return {
    frame,
    ref: useCallback(
      (el: HTMLIFrameElement | null) => {
        element.current = el
        frame?.link.attach(el)
      },
      [frame],
    ),
    onLoad: useCallback(() => {
      loaded.current = true
      frame?.loaded()
    }, [frame]),
  }
}
