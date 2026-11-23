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

/** How long a page has to say where an element lies. */
const LOCATE_WAIT_MS = 2000

export type EditorMode = 'select' | 'comment' | null

/** An element picked in a page: the canvas page it is on, or null for a single page. */
export interface Picked {
  page: number | null
  selection: PageSelection
  /** Where the pointer picked it, in the window, for the comment box; null when not by pointer. */
  point: { x: number; y: number } | null
}

/** A comment pin clicked in a page: its number, the canvas page it is on and where. */
export interface PinClick {
  n: number
  page: number | null
  point: { x: number; y: number } | null
}

export interface EditorState {
  mode: EditorMode
  picked: Picked | null
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
  /** The frame loaded a page, which needs driving again. */
  loaded(): void
  /** Starts driving the frame, until `release`; it may open again after. */
  open(): void
  release(): void
  /** Where the element whose start tag lies at `src` is in the page, or null; null after a while. */
  locate(src: number): Promise<PageBox | null>
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
  private state: EditorState = { mode: null, picked: null, pin: null, typing: false }
  private readonly typedListeners = new Set<(text: string, done: boolean) => void>()
  private readonly listeners = new Set<() => void>()
  private readonly frames = new Set<EditorFrame>()
  private pins: (page: number | null) => Pin[] = () => []
  private pickedBy: EditorFrame | null = null
  private pointing: { frame: EditorFrame; x: number; y: number } | null = null
  private pointFrame = 0
  private wanted: { page: number | null; src: number } | null = null

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
      link: new FrameLink(this.origin, (selection, { located, pin, typed }) => {
        if (located) {
          locating.get(located.src)?.(located.box)
          locating.delete(located.src)
          return
        }
        if (pin !== undefined) {
          if (this.state.mode) this.set({ pin: { n: pin, page: frame.page, point: lastPick } })
          lastPick = null
          return
        }
        if (typed) {
          if (this.pickedBy !== frame) return
          if (typed.done) this.set({ typing: false })
          for (const listener of this.typedListeners) listener(typed.text, typed.done)
          return
        }
        this.picked(frame, selection, lastPick)
        lastPick = null
      }),
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
      loaded: () => {
        frame.link.loaded()
      },
      open: () => {
        frame.link.open()
        this.frames.add(frame)
        this.drive(frame)
      },
      release: () => {
        this.frames.delete(frame)
        frame.link.dispose()
        if (this.pickedBy === frame) this.pickedBy = null
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
    if (mode === null || this.state.mode === null) {
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
    if (!this.state.picked) return false
    this.clearPick()
    return true
  }

  /** Where the picked element lies in its page, or null when it cannot be found. */
  locatePicked(): Promise<PageBox | null> {
    const src = this.state.picked?.selection.src
    if (!this.pickedBy || src === null || src === undefined) return Promise.resolve(null)
    return this.pickedBy.locate(src)
  }

  /** Scrolls the element at `src` into view in the frames that show `page`. */
  reveal(page: number | null, src: number): void {
    for (const frame of this.frames) {
      if (frame.page === page) frame.link.post({ v: RUNTIME_VERSION, kind: 'select-reveal', src })
    }
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
    this.pickedBy = selection ? frame : null
    this.set({
      picked: selection
        ? { page: frame.page, selection, point: point ?? (again ? was!.point : null) }
        : null,
      pin: null,
      // The same element picked again, by a double click's second click, keeps being typed.
      typing: again && this.state.typing,
    })
  }

  /** Lets go of the picked element, putting back any preview on it. */
  clearPick(): void {
    this.wanted = null
    if (this.pickedBy) {
      if (this.state.typing) {
        this.pickedBy.link.post({ v: RUNTIME_VERSION, kind: 'text-edit', on: false })
      }
      this.pickedBy.link.post({ v: RUNTIME_VERSION, kind: 'preview-reset' })
      this.pickedBy.link.post({ v: RUNTIME_VERSION, kind: 'select-source', src: null })
    }
    this.pickedBy = null
    if (this.state.picked || this.state.typing) this.set({ picked: null, typing: false })
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
    for (const frame of [...this.frames]) frame.release()
  }
}

const IDLE: EditorState = { mode: null, picked: null, pin: null, typing: false }
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
