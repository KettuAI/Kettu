import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  RUNTIME_VERSION,
  type PageBox,
  type PageSelection,
  type Pin,
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

export interface EditorState {
  mode: EditorMode
  picked: Picked | null
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
  /** Sets the page's declared parameters, shown at once and kept until it reloads. */
  params(values: Record<string, string | number | boolean>): void
}

function accent(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--edit-ring').trim()
}

/**
 * Select and comment mode over an artifact's frames: the mode they all show, the element picked
 * in one of them and the comment pins on each page, and the preview of an edit on the picked one.
 */
export class ArtifactEditor {
  private state: EditorState = { mode: null, picked: null }
  /** The mode it is in unless another is chosen: select on a canvas, none on a live page. */
  private base: EditorMode = null
  private readonly listeners = new Set<() => void>()
  private readonly frames = new Set<EditorFrame>()
  private pins: (page: number | null) => Pin[] = () => []
  private pickedBy: EditorFrame | null = null
  private pointing: { frame: EditorFrame; x: number; y: number } | null = null
  private pointFrame = 0

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
      link: new FrameLink(this.origin, (selection, located) => {
        if (located) {
          locating.get(located.src)?.(located.box)
          locating.delete(located.src)
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
      params: (values) => frame.link.post({ v: RUNTIME_VERSION, kind: 'params', values }),
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
    })
    frame.link.post({ v: RUNTIME_VERSION, kind: 'select-pins', pins: this.pins(frame.page) })
  }

  setMode(mode: EditorMode): void {
    if (mode === this.state.mode) return
    if (mode === null || this.state.mode === null) this.clearPick()
    this.set({ mode })
    for (const frame of this.frames) this.drive(frame)
  }

  /** Turns a mode on, or off back to the base mode. */
  toggle(mode: Exclude<EditorMode, null>): void {
    this.setMode(this.state.mode === mode ? this.base : mode)
  }

  /** The base mode, which it moves to when it was in the old one or in none. */
  setBase(base: EditorMode): void {
    const was = this.base
    this.base = base
    if (this.state.mode === null || this.state.mode === was) this.setMode(base)
  }

  /** What Esc does here: back to the base mode, else letting go of the pick; false for neither. */
  escape(): boolean {
    if (this.state.mode !== this.base) this.setMode(this.base)
    else if (this.state.picked) this.clearPick()
    else return false
    return true
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
    })
  }

  /** Lets go of the picked element, putting back any preview on it. */
  clearPick(): void {
    if (this.pickedBy) {
      this.pickedBy.link.post({ v: RUNTIME_VERSION, kind: 'preview-reset' })
      this.pickedBy.link.post({ v: RUNTIME_VERSION, kind: 'select-source', src: null })
    }
    this.pickedBy = null
    if (this.state.picked) this.set({ picked: null })
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

const IDLE: EditorState = { mode: null, picked: null }
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
