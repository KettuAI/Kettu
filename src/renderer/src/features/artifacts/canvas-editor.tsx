import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  AiMagicIcon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Comment01Icon,
  Download04Icon,
  MinusSignIcon,
  MoreHorizontalIcon,
  PlayIcon,
  PlusSignIcon,
  ArrowReloadHorizontalIcon,
  SidebarLeftIcon,
  SlidersHorizontalIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { animate, type AnimationPlaybackControls, type Transition } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { AgentId } from '@shared/agents'
import type { ArtifactDoing, ArtifactFocus } from '@shared/artifacts'
import { ARTIFACT_FRAME_SANDBOX, WEB_ARTIFACT_FRAME_SANDBOX } from '@shared/artifacts'
import type { PageKey } from '@shared/artifact-runtime/page-messages'
import { strokePath } from '@shared/canvas-stroke'
import {
  joinedEnds,
  noteBox,
  type Box,
  type CanvasNote,
  type CanvasPage,
  type ShapeNote,
} from '@shared/canvas-doc'
import { AgentCursorStyles, AgentPointer } from '@renderer/components/affect/agent-cursors'
import { Dropdown } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Kbd } from '@renderer/components/ui/kbd'
import { useHostHas } from '@renderer/lib/host-features'
import { cameraGlide, openGlide } from '@renderer/lib/motion'
import { isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import {
  cameraBeforeOpen,
  keepCameraBeforeOpen,
  saveCamera,
  savedCamera,
  setViewerState,
  useViewerState,
  type ViewerMode,
} from '@renderer/stores/artifact-viewer'
import { prefersReducedMotion } from '@renderer/stores/settings'
import {
  between,
  livePages,
  NAME_MIN_WIDTH,
  reveal,
  stepLive,
  stepZoom,
  zoomAt,
  type Camera,
  type Size,
} from './camera'
import { useCanvasState, type CanvasControls } from './canvas-controls'
import { FrameThumb } from './canvas-present'
import { CanvasFrame, PickLayer } from './canvas-view'
import { TweakCard } from './canvas-editor-panels'
import { contains, docLayout } from './canvas-model'
import { useEditorState, type ArtifactEditor, type EditorFrame } from './editor'
import { CompareDock, type CompareSwitch } from './compare-dock'
import { FitMenu } from './fit-menu'
import { useKeyedFrame } from './live-frame'
import { PagesCard } from './pages-card'
import { PositionBar } from './position-bar'
import { readingFit, type Reading, type Room } from './reading'
import type { CanvasDocState } from './use-canvas-doc'
import { useFrameParams } from './use-frame-params'
import { framePageUrl } from './use-artifact'
import { NOTE_COLOR_VAR } from './canvas-tools'
import { DockButton, DockRule, ViewerSlot } from './viewer-shell'
import { useShell } from './viewer-shell-context'
import { useFailedFrames } from './frame-failures'
import { PieceFault, StageNote, WriterTag } from './viewer-states'
import './canvas-editor.css'

/** What the viewer knows of the canvas besides its document: who writes which frame, and more. */
export interface CanvasStates {
  /** The frames an agent's running turn holds, which take no direct edit until it ends. */
  held: ReadonlyMap<string, { name: string; mark: ReactNode }>
  /** What a frame not loaded says while the computer is offline, or null while it answers. */
  waitingFor: string | null
  /** Asking the agent: the whole canvas, or to repair a frame that cannot show; null for none. */
  ask: {
    agent: string
    mark: ReactNode
    whole: () => void
    repair: (file: string, reason: string) => void
  } | null
}

/** An agent working on the artifact, as its pointer shows it. */
export interface CanvasAgent {
  sessionId: string
  name: string
  agentId: AgentId
  /** The host the session is on, null for this computer. */
  hostId: string | null
  doing: ArtifactDoing | null
  focus: ArtifactFocus | null
}

/** What a page's actions do, from the editor. */
export interface DocPageActions {
  download: ((page: CanvasPage) => void) | null
  present: (page: CanvasPage) => void
  handOff: (ids: string[]) => void
}

const DRAG_SLOP = 3
/** The band above a frame, in screen pixels, where its name selects the whole frame. */
const LABEL_BAND = 24
/** The live frames at most, nearest the middle first; the others near the view show pictures. */
const LIVE_MAX = 16
/** Room kept around the frames when landing on a page and around an opened frame. */
const SIDE = 48
const LAND_TOP = 96
const OPEN_SIDE = 32
const OPEN_TOP = 24
/** Room an opened frame keeps under a pill at the content's top. */
const OPEN_PILL = 44
const OPEN_BOTTOM = 72
const ZOOM_FLOOR = 0.2
/** How long the frames of a page that is left take to fade, and those of the next to rise. */
const PAGE_OUT_MS = 140
/** How long a frame landed on flashes: two pulses. */
const FLASH_MS = 1000
const RISE_MS = 320
const RISE_STAGGER = 16

/** The ground's dots, 20 canvas pixels apart, doubled until they are at least 12 px apart. */
function dotGap(z: number): number {
  let gap = 20 * z
  while (gap < 12) gap *= 2
  return gap
}

/** Hides a frame's name row where the frame is too narrow on screen for it. */
function fitLabels(layer: HTMLElement | undefined, z: number): void {
  if (!layer) return
  for (const label of layer.querySelectorAll<HTMLElement>('.k-ce-label')) {
    const visibility = Number(label.dataset.width) * z < NAME_MIN_WIDTH ? 'hidden' : ''
    if (label.style.visibility !== visibility) label.style.visibility = visibility
  }
}

/** The most room the selected frame's bar takes over the frame, in screen pixels: wide, narrow, up. */
const FBAR_WIDE = 380
const FBAR_NARROW = 220
const FBAR_RISE = 70

function union(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null
  const left = Math.min(...boxes.map((b) => b.x))
  const top = Math.min(...boxes.map((b) => b.y))
  const right = Math.max(...boxes.map((b) => b.x + b.width))
  const bottom = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** One note, drawn on the canvas at its own place. */
export function NoteView({
  note,
  pages,
  doneBy,
}: {
  note: CanvasNote
  pages: readonly CanvasPage[]
  doneBy: string | null
}) {
  const color = NOTE_COLOR_VAR[note.color]
  switch (note.kind) {
    case 'text':
      return (
        <div
          className="k-ce-text"
          style={{ left: note.x, top: note.y, fontSize: note.size, color }}
        >
          {note.text}
        </div>
      )
    case 'sticky':
      return (
        <div
          className="k-ce-sticky"
          data-done={note.done ? '' : undefined}
          style={{ left: note.x, top: note.y, width: note.width, minHeight: noteBox(note).height }}
        >
          {note.text}
          {doneBy && <div className="k-ce-sticky__by">{doneBy}</div>}
          {note.done && (
            <span className="k-ce-sticky__done">
              <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2.2} />
            </span>
          )}
        </div>
      )
    case 'pen':
      return (
        <svg className="k-ce-note" style={{ left: 0, top: 0 }} width={1} height={1} aria-hidden>
          <path
            d={strokePath(note.points, note.width, note.marker)}
            fill={color}
            opacity={note.marker ? 0.35 : 1}
          />
        </svg>
      )
    default: {
      const shape = note as ShapeNote
      const ends = joinedEnds(shape, pages)
      const w = shape.width
      const head = `head-${note.id}`
      return (
        <svg className="k-ce-note" style={{ left: 0, top: 0 }} width={1} height={1} aria-hidden>
          {shape.kind === 'arrow' && (
            <defs>
              <marker
                id={head}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="4"
                markerHeight="4"
                orient="auto-start-reverse"
              >
                <path d="M0 0L10 5 0 10z" fill={color} />
              </marker>
            </defs>
          )}
          {shape.kind === 'rect' && (
            <rect
              x={Math.min(ends.x1, ends.x2)}
              y={Math.min(ends.y1, ends.y2)}
              width={Math.abs(ends.x2 - ends.x1)}
              height={Math.abs(ends.y2 - ends.y1)}
              rx={6}
              fill="none"
              stroke={color}
              strokeWidth={w}
            />
          )}
          {shape.kind === 'ellipse' && (
            <ellipse
              cx={(ends.x1 + ends.x2) / 2}
              cy={(ends.y1 + ends.y2) / 2}
              rx={Math.abs(ends.x2 - ends.x1) / 2}
              ry={Math.abs(ends.y2 - ends.y1) / 2}
              fill="none"
              stroke={color}
              strokeWidth={w}
            />
          )}
          {(shape.kind === 'line' || shape.kind === 'arrow') && (
            <line
              x1={ends.x1}
              y1={ends.y1}
              x2={ends.x2}
              y2={ends.y2}
              stroke={color}
              strokeWidth={w}
              strokeLinecap="round"
              markerEnd={shape.kind === 'arrow' ? `url(#${head})` : undefined}
            />
          )}
        </svg>
      )
    }
  }
}

/** An opened frame at reading size: where it lies on screen and the camera that puts it there. */
interface Opened extends Reading {
  id: string
  camera: Camera
  /** The room below the frame that the dock keeps, which a long frame scrolls clear of. */
  bottom: number
  viewHeight: number
}

type Phase = 'out' | 'in' | null

/**
 * A canvas document's page on screen: its frames as pictures on a ground that pans and zooms,
 * one camera at three distances, the page, a selected frame and an opened one at reading size.
 * Its Pages card, tweaks and dock go into the viewer's left card, right card and dock.
 */
export const CanvasEditor = memo(function CanvasEditor({
  artifactId,
  url,
  version,
  loadFrom,
  title,
  canvas,
  files,
  readOnly,
  mode: viewerMode,
  controls,
  top = 0,
  pill = false,
  editor,
  actions,
  agents,
  following,
  onFollowDone,
  onViewPage,
  sessionName,
  reloads,
  show = null,
  onShown,
  changed,
  marks,
  comments,
  compare = null,
  states = null,
}: {
  artifactId: string
  url: string
  version: number
  /** The version each page file's frame loads, as the shown version keeps it. */
  loadFrom: ReadonlyMap<string, number>
  title: string
  canvas: CanvasDocState
  /** The files of the version on screen; a page whose file is missing shows blank. */
  files: ReadonlySet<string>
  readOnly: boolean
  /** The viewer's mode: View looks, Comment pins comments, Edit picks elements to change. */
  mode: ViewerMode
  controls: CanvasControls
  top?: number
  /** A pill shows at the content's top, which an opened frame starts below. */
  pill?: boolean
  editor?: ArtifactEditor
  actions: DocPageActions | null
  agents: readonly CanvasAgent[]
  /** The session whose agent the view follows. */
  following: string | null
  onFollowDone: () => void
  /** The page in the middle of the view, for the others' faces. */
  onViewPage?: (page: string | null) => void
  /** The name of the session that drew a note. */
  sessionName: (sessionId: string) => string
  reloads: number
  /**
   * A page to bring into view, as a frame on a thread's card asks; `open` opens it at reading
   * size, and `flash` flashes its outline once it is there.
   */
  show?: { pageId: string; seq: number; open?: boolean; flash?: boolean } | null
  /** The page asked for is in view, or not in this version. */
  onShown?: (seq: number) => void
  /** The frames that count as changed, by id. */
  changed: ReadonlySet<string>
  /** The version that last changed each changed frame, when not this one. */
  marks?: ReadonlyMap<string, number>
  /** The open comment threads on each frame, by id. */
  comments: ReadonlyMap<string, number>
  /** The version an agent wrote and the one before it, which a frame it changed compares with. */
  compare?: { before: number; after: number } | null
  states?: CanvasStates | null
}) {
  const { t } = useTranslation('artifacts')
  const doc = canvas.doc
  const { insets, tier } = useShell()
  const activeCanvas = useViewerState(artifactId, (s) => s.page)
  const selection = useViewerState(artifactId, (s) => s.selection)
  const focused = useViewerState(artifactId, (s) => s.opened)
  const fit = useViewerState(artifactId, (s) => s.fit)
  const tweaksOpen = useViewerState(artifactId, (s) => s.right === 'tweaks') && !readOnly
  const setSelection = useCallback(
    (ids: readonly string[]) =>
      setViewerState(artifactId, (s) =>
        s.selection.length === 0 && ids.length === 0 ? {} : { selection: ids },
      ),
    [artifactId],
  )
  const setFocused = useCallback(
    (id: string | null) =>
      setViewerState(artifactId, id ? { opened: id, selection: [id] } : { opened: null }),
    [artifactId],
  )
  const toggleTweaks = (open: boolean) =>
    setViewerState(artifactId, (s) => ({
      right: open ? 'tweaks' : s.right === 'tweaks' ? null : s.right,
    }))
  // A page asked for shows on its own canvas.
  const askedSeq = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (!show || !doc || askedSeq.current === show.seq) return
    askedSeq.current = show.seq
    const page = doc.pages.find((p) => p.id === show.pageId)
    if (!page) return
    setViewerState(
      artifactId,
      show.open
        ? { page: page.canvas, opened: page.id, selection: [page.id] }
        : { page: page.canvas, opened: null },
    )
  }, [show, doc, artifactId])
  const canvasKey = doc?.canvases.some((c) => c.id === activeCanvas)
    ? activeCanvas!
    : (doc?.canvases[0]?.id ?? '')

  // The page on screen lags the one chosen while the old page's frames fade out.
  const [shownKey, setShownKey] = useState(canvasKey)
  const [chosenKey, setChosenKey] = useState(canvasKey)
  const [phase, setPhase] = useState<Phase>(null)
  if (chosenKey !== canvasKey) {
    setChosenKey(canvasKey)
    if (prefersReducedMotion()) setShownKey(canvasKey)
    else setPhase('out')
  }
  useEffect(() => {
    if (phase !== 'out') return
    const timer = setTimeout(() => {
      setShownKey(canvasKey)
      setPhase('in')
    }, PAGE_OUT_MS)
    return () => clearTimeout(timer)
  }, [phase, canvasKey])
  useEffect(() => {
    if (phase !== 'in') return
    const timer = setTimeout(() => setPhase(null), RISE_MS + RISE_STAGGER * 16)
    return () => clearTimeout(timer)
  }, [phase])

  const layout = useMemo(() => (doc ? docLayout(doc, shownKey) : null), [doc, shownKey])
  const pages = useMemo(() => layout?.pages ?? [], [layout])
  const pageName = doc?.canvases.find((c) => c.id === shownKey)?.name ?? ''
  const pageNumber = (doc?.canvases.findIndex((c) => c.id === shownKey) ?? 0) + 1

  const root = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const layers = useRef<HTMLDivElement[]>([])
  const camera = useRef<Camera>({ x: 0, y: 0, z: 1 })
  const view = useRef<Size>({ width: 0, height: 0 })
  const fitted = useRef(false)
  const [measured, setMeasured] = useState(false)
  const atFit = useRef(false)
  const glideTo = useRef<AnimationPlaybackControls | null>(null)
  const liveFrame = useRef(0)
  const [live, setLive] = useState<ReadonlySet<string>>(new Set())
  const [near, setNear] = useState<ReadonlySet<string>>(new Set())
  const liveNow = useRef(live)
  // The live pages that have loaded, or loaded long enough for the next to start.
  const settled = useRef(new Set<string>())
  const frames = useRef(new Map<string, HTMLIFrameElement>())
  const editorFrames = useRef(new Map<string, EditorFrame>())
  const editing = useEditorState(editor)
  const [located, setLocated] = useState<Record<string, Box | null>>({})
  const drag = useRef<{
    sx: number
    sy: number
    camera: Camera
    moved: boolean
    pick?: { page: string; x: number; y: number; at: { x: number; y: number } }
  } | null>(null)
  const [panning, setPanning] = useState(false)
  const [reading, setOpened] = useState<Opened | null>(null)
  // The reading place counts only for the frame still open.
  const opened = reading && reading.id === focused ? reading : null
  const openedRef = useRef(opened)
  useEffect(() => {
    openedRef.current = opened
  })
  const scroller = useRef<HTMLDivElement | null>(null)
  // Bumped when the view's size changes while a frame is open, which sizes it again.
  const [resized, setResized] = useState(0)
  // A pinch out of an opened frame leaves it where the camera is instead of going back.
  const leaveInPlace = useRef(false)
  const thumbnails = useHostHas('partThumbnails') === true

  const shownSelection = useMemo(
    () => selection.filter((id) => pages.some((p) => p.id === id)),
    [pages, selection],
  )
  const frameParams = useFrameParams(artifactId, version, pages)
  const indexInDoc = useCallback(
    (id: string) => (doc ? doc.pages.findIndex((q) => q.id === id) : -1),
    [doc],
  )

  // Live pages follow the camera, nearest first, one more each time the last has settled; a page
  // without its file yet has nothing to load. The others near the view show their pictures.
  const syncLive = useCallback(() => {
    cancelAnimationFrame(liveFrame.current)
    liveFrame.current = requestAnimationFrame(() => {
      const around = livePages(pages, camera.current, view.current)
        .map((i) => pages[i]!)
        .filter((p) => files.has(p.file))
        .map((p) => p.id)
      setNear((was) =>
        was.size === around.length && around.every((id) => was.has(id)) ? was : new Set(around),
      )
      const next = stepLive(liveNow.current, around.slice(0, LIVE_MAX), settled.current)
      if (next === liveNow.current) return
      for (const id of settled.current) if (!next.has(id)) settled.current.delete(id)
      liveNow.current = next
      setLive(next)
    })
  }, [pages, files])
  const pageSettled = useCallback(
    (id: string) => {
      if (settled.current.has(id) || !liveNow.current.has(id)) return
      settled.current.add(id)
      syncLive()
    },
    [syncLive],
  )

  const draw = useCallback(() => {
    const { x, y, z } = camera.current
    if (fitted.current && !openedRef.current)
      saveCamera(artifactId, shownKey, { x, y, z, fitted: atFit.current })
    for (const el of layers.current) {
      if (!el) continue
      el.style.transform = `translate(${x}px, ${y}px) scale(${z})`
      el.style.setProperty('--unscale', String(1 / z))
    }
    fitLabels(layers.current[1], z)
    const ground = root.current
    if (ground) {
      const gap = dotGap(z)
      ground.style.setProperty('--ce-dots', `${gap}px`)
      ground.style.setProperty('--ce-dots-x', `${x % gap}px`)
      ground.style.setProperty('--ce-dots-y', `${y % gap}px`)
    }
    controls.publish({ zoom: z, fitted: atFit.current })
    syncLive()
  }, [controls, syncLive, artifactId, shownKey])

  const place = useCallback(
    (next: Camera, fit = false) => {
      glideTo.current?.stop()
      atFit.current = fit
      camera.current = next
      draw()
    },
    [draw],
  )

  const moveTo = useCallback(
    (target: Camera, fit = false, transition: Transition = cameraGlide, done?: () => void) => {
      glideTo.current?.stop()
      if (prefersReducedMotion()) {
        place(target, fit)
        done?.()
        return
      }
      atFit.current = fit
      const from = camera.current
      glideTo.current = animate(0, 1, {
        ...transition,
        onUpdate: (k) => {
          camera.current = between(from, target, k, view.current)
          draw()
        },
        onComplete: done,
      })
    },
    [place, draw],
  )

  const leftRoom = insets.left
  const openTop = OPEN_TOP + (pill ? OPEN_PILL : 0)
  const rightRoom = insets.right

  // Landing on a page fits its frames' width from their top, never above 100% or under 20%.
  const landing = useCallback((): Camera => {
    const bounds = layout?.bounds
    const { width, height } = view.current
    if (!bounds || bounds.width === 0) return { x: width / 2, y: height / 2, z: 1 }
    const room = Math.max(1, width - leftRoom - rightRoom - 2 * SIDE)
    const z = Math.min(1, Math.max(ZOOM_FLOOR, room / bounds.width))
    return {
      z,
      x: leftRoom + SIDE + Math.max(0, (room - bounds.width * z) / 2) - bounds.x * z,
      y: top + LAND_TOP - bounds.y * z,
    }
  }, [layout, leftRoom, rightRoom, top])

  const land = useCallback(
    (glides: boolean) => (glides ? moveTo(landing(), true) : place(landing(), true)),
    [landing, moveTo, place],
  )

  const zoomAround = useCallback(
    (z: number) => {
      const { width, height } = view.current
      moveTo(zoomAt(camera.current, z, width / 2, height / 2))
    },
    [moveTo],
  )

  const revealFrame = useCallback(
    (box: Box) => moveTo(reveal(camera.current, box, view.current)),
    [moveTo],
  )

  // The camera the page was left at, when the viewer showed it before, else the landing.
  const restore = useCallback(() => {
    const saved = savedCamera(artifactId, shownKey)
    if (saved && !saved.fitted) place({ x: saved.x, y: saved.y, z: saved.z })
    else land(false)
  }, [artifactId, shownKey, place, land])

  // The room an opened frame is read in: the view less the cards, the top and the dock.
  const readingRoom = useCallback(
    (): Room => ({
      x: leftRoom + OPEN_SIDE,
      y: top + openTop,
      width: Math.max(1, view.current.width - leftRoom - rightRoom - 2 * OPEN_SIDE),
      height: Math.max(1, view.current.height - top - openTop - OPEN_BOTTOM),
    }),
    [leftRoom, rightRoom, top, openTop],
  )

  // Moves the camera in to a frame at reading size; the live frame takes over once it is there.
  const openAt = useCallback(
    (page: CanvasPage, transition: Transition | null) => {
      const room = readingRoom()
      const reading = readingFit(page, room, fit)
      const target = {
        z: reading.z,
        x: reading.x - page.x * reading.z,
        y: reading.y - page.y * reading.z,
      }
      const next: Opened = {
        ...reading,
        id: page.id,
        camera: target,
        bottom: view.current.height - room.y - room.height,
        viewHeight: view.current.height,
      }
      if (!transition) {
        place(target)
        setOpened(next)
        return
      }
      openedRef.current = null
      moveTo(target, false, transition, () => setOpened(next))
    },
    [readingRoom, fit, place, moveTo],
  )

  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      if (width === view.current.width && height === view.current.height) return
      view.current = { width, height }
      if (!fitted.current && width > 0) {
        fitted.current = true
        setMeasured(true)
        restore()
      } else if (openedRef.current) setResized((n) => n + 1)
      else if (atFit.current) land(false)
      else draw()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [land, draw, restore])

  // A landed view lands again in the room a card that opened or closed leaves.
  const rooms = `${leftRoom}:${rightRoom}`
  const lastRooms = useRef(rooms)
  useEffect(() => {
    if (lastRooms.current === rooms) return
    lastRooms.current = rooms
    if (fitted.current && atFit.current && !openedRef.current) land(true)
  }, [rooms, land])

  // Another page takes the camera it was left at, or lands on its frames.
  const lastCanvas = useRef(shownKey)
  useEffect(() => {
    if (lastCanvas.current === shownKey) return
    lastCanvas.current = shownKey
    if (fitted.current) restore()
  }, [shownKey, restore])

  // Opening a frame moves the camera in; closing it goes back to where the camera was.
  const lastOpened = useRef<string | null>(null)
  const focusedPage = focused ? pages.find((p) => p.id === focused) : undefined
  // The frame Tweak changes: the opened one, or the one selected.
  const tweakPage =
    focusedPage ??
    (shownSelection.length === 1 ? pages.find((p) => p.id === shownSelection[0]) : undefined)
  // Before and after, on the frame opened or else the one selected, when the agent's latest
  // version changed it; leaving the frame keeps it selected, so what shows stays.
  const compareSelection = useMemo(
    () => (shownSelection.length === 1 ? pages.find((p) => p.id === shownSelection[0]) : undefined),
    [shownSelection, pages],
  )
  const comparePage = focusedPage ?? compareSelection
  const comparing = !!compare && !!comparePage && changed.has(comparePage.id)
  const [before, setBefore] = useState<string | null>(null)
  // Another frame, or none, lets go of the earlier version: coming back shows the latest.
  const [compared, setCompared] = useState(comparePage?.id ?? null)
  if ((comparePage?.id ?? null) !== compared) {
    setCompared(comparePage?.id ?? null)
    setBefore(null)
  }
  const showingBefore = comparing && before === comparePage?.id
  const compareSwitch: CompareSwitch | null =
    comparing && compare && comparePage
      ? {
          from: compare.before,
          to: compare.after,
          showingBefore,
          onChange: (on) => setBefore(on ? comparePage.id : null),
        }
      : null
  useEffect(() => {
    if (!measured) return
    if (focused && !focusedPage) {
      // A frame on a page still coming in waits for it; one no page has is let go.
      if (doc && !doc.pages.some((p) => p.id === focused)) setFocused(null)
      return
    }
    const was = lastOpened.current
    lastOpened.current = focused
    if (focused === was) return
    if (focusedPage) {
      if (!was) {
        const c = camera.current
        keepCameraBeforeOpen(artifactId, shownKey, { ...c, fitted: atFit.current })
      }
      openAt(focusedPage, was ? cameraGlide : openGlide)
      return
    }
    const back = cameraBeforeOpen(artifactId, shownKey)
    keepCameraBeforeOpen(artifactId, shownKey, null)
    if (leaveInPlace.current) {
      leaveInPlace.current = false
      return
    }
    if (back) moveTo({ x: back.x, y: back.y, z: back.z }, back.fitted, openGlide)
    else moveTo(landing(), true, openGlide)
    requestAnimationFrame(() => stage.current?.focus({ preventScroll: true }))
  }, [
    focused,
    focusedPage,
    measured,
    doc,
    artifactId,
    shownKey,
    openAt,
    moveTo,
    landing,
    setFocused,
  ])

  // An opened frame keeps its reading size as the fit, the room or the window changes.
  const refitKey = `${fit}:${rooms}:${top}:${openTop}:${resized}`
  const lastRefit = useRef(refitKey)
  useEffect(() => {
    if (lastRefit.current === refitKey) return
    lastRefit.current = refitKey
    if (focusedPage && lastOpened.current === focusedPage.id) openAt(focusedPage, cameraGlide)
  }, [refitKey, focusedPage, openAt])

  useEffect(() => {
    draw()
  }, [draw, layout])

  const stepOpened = useCallback(
    (step: 1 | -1) => {
      const at = pages.findIndex((p) => p.id === openedRef.current?.id || p.id === focused)
      const next = pages[at + step]
      if (next) setFocused(next.id)
    },
    [pages, focused, setFocused],
  )

  // Left and right walk the page's frames: the selection, or the opened frame.
  const stepSelection = useCallback(
    (step: 1 | -1) => {
      const at = pages.findIndex((p) => p.id === shownSelection[0])
      const next = pages[at < 0 ? (step > 0 ? 0 : pages.length - 1) : at + step]
      if (!next) return
      setSelection([next.id])
      revealFrame(next)
    },
    [pages, shownSelection, setSelection, revealFrame],
  )

  useEffect(
    () =>
      controls.attach({
        zoomStep: (direction) => zoomAround(stepZoom(camera.current.z, direction)),
        fitAll: () => land(true),
        fitSelected: () => {
          const box = union(pages.filter((p) => shownSelection.includes(p.id)))
          if (box) revealFrame(box)
        },
        actualSize: () => zoomAround(1),
        focus: (index) => setFocused(index === null ? null : (pages[index]?.id ?? null)),
      }),
    [controls, zoomAround, land, revealFrame, pages, shownSelection, setFocused],
  )

  useEffect(() => {
    controls.publish({
      count: pages.length,
      selected: Math.max(
        0,
        pages.findIndex((p) => p.id === shownSelection[0]),
      ),
      focused: focusedPage ? pages.indexOf(focusedPage) : null,
    })
  }, [controls, pages, shownSelection, focusedPage])

  const [flash, setFlash] = useState<{ id: string; seq: number } | null>(null)
  const [flashedFor, setFlashedFor] = useState(0)
  if (show?.flash && flashedFor !== show.seq && measured) {
    const page = layout?.pages.find((p) => p.id === show.pageId)
    if (page) {
      setFlashedFor(show.seq)
      setFlash({ id: page.id, seq: show.seq })
    }
  }
  // A page asked for is brought into view once the view has a size and its canvas is shown; one
  // this version lacks is done with at once.
  const shownAsked = useRef<number | null>(null)
  useEffect(() => {
    if (!show || !doc || shownAsked.current === show.seq) return
    const page = layout?.pages.find((p) => p.id === show.pageId)
    const elsewhere = doc.pages.some((p) => p.id === show.pageId)
    if ((!page && elsewhere) || (page && !measured)) return
    shownAsked.current = show.seq
    // An opened frame is moved in by the opening itself.
    if (page && !show.open) revealFrame(page)
    onShown?.(show.seq)
  }, [show, doc, layout, measured, revealFrame, onShown])
  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(null), FLASH_MS)
    return () => clearTimeout(timer)
  }, [flash])

  // A frame chosen on another page in the Pages card is brought into view once that page is in.
  const revealAsked = useRef<string | null>(null)
  useEffect(() => {
    const id = revealAsked.current
    if (!id || phase === 'out' || !measured) return
    const page = pages.find((p) => p.id === id)
    if (!page) return
    revealAsked.current = null
    revealFrame(page)
  }, [pages, phase, measured, revealFrame])

  // Reload loads every live page again, in place.
  const [mountedAt] = useState(reloads)
  useEffect(() => {
    if (reloads === mountedAt) return
    for (const frame of frames.current.values()) frame.setAttribute('src', frame.src)
  }, [reloads, mountedAt])

  useEffect(() => {
    syncLive()
    return () => {
      glideTo.current?.stop()
      cancelAnimationFrame(liveFrame.current)
    }
  }, [syncLive])

  // The wheel pans, and zooms with Mod or a pinch; over an opened frame it scrolls a long one, and
  // a pinch leaves it for the page where the camera is.
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.current.height : 1
      const current = camera.current
      const zooming = event.ctrlKey || event.metaKey
      if (openedRef.current && !zooming) {
        scroller.current?.scrollBy({ top: event.deltaY * unit })
        return
      }
      if (zooming) {
        if (openedRef.current) {
          leaveInPlace.current = true
          setFocused(null)
        }
        const rect = el.getBoundingClientRect()
        const delta = Math.max(-50, Math.min(50, event.deltaY * unit))
        place(
          zoomAt(
            current,
            current.z * Math.exp(-delta * 0.01),
            event.clientX - rect.left,
            event.clientY - rect.top,
          ),
        )
      } else {
        place({
          ...current,
          x: current.x - event.deltaX * unit,
          y: current.y - event.deltaY * unit,
        })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [place, setFocused])

  // Comment pins comments and Edit picks elements, in the frames on the page and in an opened one.
  useEffect(() => {
    if (!editor) return
    editor.setMode(
      viewerMode === 'comment' ? 'comment' : viewerMode === 'edit' && !readOnly ? 'select' : null,
    )
  }, [editor, viewerMode, readOnly])
  const mode = editor ? editing.mode : null

  // The page in the middle of the view, for the faces of the user's other devices.
  const lastViewed = useRef<string | null>(null)
  useEffect(() => {
    if (!onViewPage) return
    const timer = setInterval(() => {
      const { x, y, z } = camera.current
      const cx = (view.current.width / 2 - x) / z
      const cy = (view.current.height / 2 - y) / z
      const page = pages.find((p) => contains(p, cx, cy))?.id ?? null
      if (page !== lastViewed.current) {
        lastViewed.current = page
        onViewPage(page)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [pages, onViewPage])

  // Where each agent's pointer rests: on the element its write changed, else on its page.
  const agentPages = useMemo(() => {
    const out = new Map<string, CanvasPage>()
    for (const agent of agents) {
      const focus = agent.focus
      if (!focus) continue
      const page = pages.find((p) => (focus.page ? p.id === focus.page : p.file === focus.path))
      if (page) out.set(agent.sessionId, page)
    }
    return out
  }, [agents, pages])
  const locateKey = agents
    .map(
      (a) =>
        `${a.sessionId}:${a.focus?.path}:${a.focus?.offset}:${live.has(agentPages.get(a.sessionId)?.id ?? '')}`,
    )
    .join('|')
  useEffect(() => {
    let current = true
    for (const agent of agents) {
      const page = agentPages.get(agent.sessionId)
      const offset = agent.focus?.offset
      const frame = page && editorFrames.current.get(page.id)
      if (!page || offset === null || offset === undefined || !frame) continue
      void frame.locate(offset).then((box) => {
        if (current) setLocated((was) => ({ ...was, [agent.sessionId]: box }))
      })
    }
    return () => {
      current = false
    }
    // Located again when an agent's focus or its page's frame changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locateKey])

  const pointerAt = useCallback(
    (agent: CanvasAgent): { x: number; y: number; box: Box | null } | null => {
      const page = agentPages.get(agent.sessionId)
      if (!page) return null
      const box = agent.focus?.offset != null ? (located[agent.sessionId] ?? null) : null
      if (box) {
        const inPage = {
          x: page.x + box.x,
          y: page.y + box.y,
          width: box.width,
          height: box.height,
        }
        return {
          x: inPage.x + Math.min(inPage.width * 0.6, inPage.width - 4),
          y: inPage.y + inPage.height * 0.6,
          box: inPage,
        }
      }
      return { x: page.x + 28, y: page.y + 24, box: null }
    },
    [agentPages, located],
  )

  // Following an agent keeps its page in view.
  const followed = following ? agents.find((a) => a.sessionId === following) : undefined
  const followedPage = followed ? agentPages.get(followed.sessionId) : undefined
  useEffect(() => {
    if (!followedPage || openedRef.current) return
    revealFrame(followedPage)
  }, [followedPage, revealFrame])

  /** A spot on the screen in canvas pixels. */
  const toCanvas = (sx: number, sy: number): { x: number; y: number } => {
    const { x, y, z } = camera.current
    return { x: (sx - x) / z, y: (sy - y) / z }
  }
  const screenPoint = (event: React.PointerEvent | React.MouseEvent) => {
    const rect = stage.current!.getBoundingClientRect()
    return { sx: event.clientX - rect.left, sy: event.clientY - rect.top }
  }

  /** The frame under a canvas point, or its name band above it. */
  const frameAt = (x: number, y: number): { page: CanvasPage; named: boolean } | null => {
    const band = LABEL_BAND / camera.current.z
    for (let i = pages.length - 1; i >= 0; i--) {
      const p = pages[i]!
      if (contains(p, x, y)) return { page: p, named: false }
      if (contains({ ...p, y: p.y - band, height: band }, x, y)) return { page: p, named: true }
    }
    return null
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.target !== event.currentTarget) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const key = event.key
    if (opened || focused) {
      if (key === 'ArrowRight') stepOpened(1)
      else if (key === 'ArrowLeft') stepOpened(-1)
      else return
    } else if (key === 'ArrowRight') stepSelection(1)
    else if (key === 'ArrowLeft') stepSelection(-1)
    else if (key === 'Enter' && shownSelection.length === 1) setFocused(shownSelection[0]!)
    else if (event.shiftKey && event.code === 'Digit1') land(true)
    else if (event.shiftKey && event.code === 'Digit0') zoomAround(1)
    else if (key === '+' || key === '=') zoomAround(stepZoom(camera.current.z, 1))
    else if (key === '-') zoomAround(stepZoom(camera.current.z, -1))
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  const onPointerDown = (event: React.PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const { sx, sy } = screenPoint(event)
    const at = toCanvas(sx, sy)
    stage.current?.focus({ preventScroll: true })
    drag.current = { sx, sy, camera: camera.current, moved: false }
    if (event.button === 1) return
    const under = frameAt(at.x, at.y)
    if (focused) {
      // Outside an opened frame the page comes back, as Esc does.
      if (under?.page.id !== focused) setFocused(null)
      return
    }
    if (!under) {
      if (!event.shiftKey) setSelection([])
      editor?.clearPick()
      return
    }
    const { page, named } = under
    // Comment and Edit pick what is in a frame on release, unless the press pans.
    if (mode && !named && !event.shiftKey) {
      drag.current.pick = {
        page: page.id,
        x: at.x - page.x,
        y: at.y - page.y,
        at: { x: event.clientX, y: event.clientY },
      }
      return
    }
    editor?.clearPick()
    setSelection(
      event.shiftKey
        ? shownSelection.includes(page.id)
          ? shownSelection.filter((s) => s !== page.id)
          : [...shownSelection, page.id]
        : [page.id],
    )
  }

  const onPointerMove = (event: React.PointerEvent): void => {
    const held = drag.current
    const { sx, sy } = screenPoint(event)
    if (!held) {
      // Outlining what is under the pointer inside a frame, as the editor's modes do.
      if (mode && !focused) {
        const at = toCanvas(sx, sy)
        const page = pages.find((p) => contains(p, at.x, at.y))
        for (const [pid, frame] of editorFrames.current) if (pid !== page?.id) frame.leave()
        if (page) editorFrames.current.get(page.id)?.point(at.x - page.x, at.y - page.y)
      }
      return
    }
    if (!held.moved && Math.hypot(sx - held.sx, sy - held.sy) > DRAG_SLOP) {
      held.moved = true
      setPanning(true)
      if (focused) {
        leaveInPlace.current = true
        setFocused(null)
      }
    }
    if (!held.moved) return
    place({
      ...held.camera,
      x: held.camera.x + (sx - held.sx),
      y: held.camera.y + (sy - held.sy),
    })
  }

  const onPointerUp = (): void => {
    const held = drag.current
    drag.current = null
    setPanning(false)
    if (held && !held.moved && held.pick) {
      setSelection([])
      editorFrames.current.get(held.pick.page)?.pick(held.pick.x, held.pick.y, held.pick.at)
    }
  }

  const onDoubleClick = (event: React.MouseEvent): void => {
    if (viewerMode === 'comment' || focused) return
    const { sx, sy } = screenPoint(event)
    const at = toCanvas(sx, sy)
    const under = frameAt(at.x, at.y)
    if (under) setFocused(under.page.id)
  }

  // Until the shown page is one of the document's, its empty layout says nothing about the board.
  const empty =
    layout !== null &&
    layout.pages.length === 0 &&
    layout.notes.length === 0 &&
    (doc!.canvases.length === 0 || doc!.canvases.some((c) => c.id === shownKey))
  const { failed: failedFrames, forget: forgetFailed } = useFailedFrames(url)
  // Retry loads a failed frame again, in a new frame.
  const [retries, setRetries] = useState<ReadonlyMap<string, number>>(() => new Map())
  const retryFrame = (p: { id: string; file: string }) => {
    forgetFailed(p.file)
    setRetries((was) => new Map(was).set(p.id, (was.get(p.id) ?? 0) + 1))
  }
  const selectedPages = pages.filter((p) => shownSelection.includes(p.id))
  const flashedPage = flash ? pages.find((p) => p.id === flash.id) : undefined
  const selectedBox = union(selectedPages)
  const writingPages = new Set([
    ...(agents
      .filter((a) => a.doing && a.doing !== 'read')
      .map((a) => agentPages.get(a.sessionId)?.id)
      .filter(Boolean) as string[]),
    ...(states?.held.keys() ?? []),
  ])
  // A frame whose file the host answered with an error: it says why in its place.
  const faultOf = (p: { file: string }): number | null =>
    files.has(p.file) ? (failedFrames.get(p.file) ?? null) : null
  const faults = new Set(pages.filter((p) => faultOf(p) !== null).map((p) => p.id))
  const writingMarks = states ? new Map([...states.held].map(([id, w]) => [id, w.mark])) : undefined
  const drawing = new Map<string, CanvasAgent>()
  for (const a of agents) {
    const p = agentPages.get(a.sessionId)
    if (a.doing === 'draw' && p) drawing.set(p.id, a)
  }
  const openedPage = opened ? pages.find((p) => p.id === opened.id) : undefined
  const openedAt = focusedPage ? pages.indexOf(focusedPage) : -1

  // Pages added or resized since the camera last moved.
  useLayoutEffect(() => fitLabels(layers.current[1], camera.current.z))

  const firstLayer = useCallback((el: HTMLDivElement | null) => {
    if (el) layers.current[0] = el
  }, [])
  const secondLayer = useCallback((el: HTMLDivElement | null) => {
    if (el) layers.current[1] = el
  }, [])

  const onFrameKey = useCallback(
    (key: PageKey) => {
      if (key === 'ArrowRight') stepOpened(1)
      else if (key === 'ArrowLeft') stepOpened(-1)
      else if (key === 'Escape' && !editor?.escape()) setFocused(null)
    },
    [stepOpened, editor, setFocused],
  )

  return (
    <div
      ref={root}
      className="k-ce"
      data-narrow={tier === 'narrow' ? '' : undefined}
      data-phase={phase ?? undefined}
      data-opened={focused ? '' : undefined}
    >
      <AgentCursorStyles />
      <div
        ref={stage}
        tabIndex={0}
        role="region"
        aria-roledescription={t('canvas.role')}
        aria-label={title}
        onKeyDown={onKeyDown}
        className="k-ce__stage"
      >
        {/* The frames and notes; they take no pointer, but their scripts keep running. */}
        <div ref={firstLayer} inert className="k-ce__layer">
          {pages.map((p, i) => {
            const blank = !files.has(p.file)
            const agent = drawing.get(p.id)
            return (
              <div
                key={p.id}
                className="k-ce-page"
                data-working={writingPages.has(p.id) ? '' : undefined}
                data-dim={focused && focused !== p.id ? '' : undefined}
                style={
                  {
                    left: p.x,
                    top: p.y,
                    width: p.width,
                    height: p.height,
                    '--i': Math.min(i, 16),
                  } as React.CSSProperties
                }
              >
                {blank ? (
                  <div className="k-ce-page__blank" data-agent={agent ? '' : undefined}>
                    <b>
                      {agent
                        ? t('board.page.drawing', { agent: agent.name })
                        : t('board.page.blank')}
                    </b>
                    {!agent && <span>{t('board.page.blankHint')}</span>}
                  </div>
                ) : live.has(p.id) && faultOf(p) === null ? (
                  <CanvasFrame
                    key={retries.get(p.id) ?? 0}
                    src={framePageUrl(
                      url,
                      { version, loadFrom },
                      { group: 0, index: 1, file: p.file },
                    )}
                    title={p.name}
                    width={p.width}
                    height={p.height}
                    editor={editor}
                    page={indexInDoc(p.id)}
                    onSettled={() => pageSettled(p.id)}
                    register={(frame) => {
                      if (frame) frames.current.set(p.id, frame)
                      else frames.current.delete(p.id)
                    }}
                    registerEditor={(frame) => {
                      if (frame) editorFrames.current.set(p.id, frame)
                      else editorFrames.current.delete(p.id)
                    }}
                  />
                ) : thumbnails && near.has(p.id) ? (
                  <div className="k-ce-page__thumb">
                    <FrameThumb artifactId={artifactId} version={version} frame={p.id} />
                  </div>
                ) : (
                  <div className="k-ce-page__idle">
                    {faultOf(p) === null && (states?.waitingFor ?? p.name)}
                  </div>
                )}
                {showingBefore && compare && comparePage?.id === p.id && !focused && (
                  <div className="k-vt-before" data-unscaled="">
                    <iframe
                      src={framePageUrl(
                        url,
                        { version: compare.before, loadFrom: new Map() },
                        { group: 0, index: 1, file: p.file },
                      )}
                      title={t('compare.beforeTitle', { name: p.name, version: compare.before })}
                      sandbox={isWeb ? WEB_ARTIFACT_FRAME_SANDBOX : ARTIFACT_FRAME_SANDBOX}
                      allow=""
                      referrerPolicy="no-referrer"
                      style={{ width: p.width, height: p.height }}
                    />
                    <span className="k-vt-before__tag">
                      {t('compare.before', { version: compare.before })}
                    </span>
                  </div>
                )}
              </div>
            )
          })}
          {layout?.notes.map((n) => (
            <NoteView
              key={n.id}
              note={n}
              pages={pages}
              doneBy={n.kind === 'sticky' && n.by ? sessionName(n.by) : null}
            />
          ))}
        </div>
        <div
          aria-hidden
          className={cn('k-ce__overlay', panning ? 'cursor-grabbing' : 'cursor-default')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            drag.current = null
            setPanning(false)
          }}
          onDoubleClick={onDoubleClick}
        />
        {/* What draws over the canvas: names and marks, the selection and its bar, the agents. */}
        <div ref={secondLayer} className="k-ce__layer k-ce__ui">
          {pages.map((p) => {
            const count = comments.get(p.id) ?? 0
            return (
              <div
                key={p.id}
                className="k-ce-label"
                data-width={p.width}
                data-selected={shownSelection.includes(p.id) ? '' : undefined}
                data-dim={focused && focused !== p.id ? '' : undefined}
                style={{
                  left: p.x,
                  top: `calc(${p.y}px - 24px * var(--unscale))`,
                  width: p.width,
                }}
              >
                {states?.held.get(p.id) && (
                  <WriterTag
                    className="k-ce-label__writer"
                    mark={states.held.get(p.id)!.mark}
                    name={states.held.get(p.id)!.name}
                  />
                )}
                <span className="k-ce-label__name">{p.name}</span>
                {changed.has(p.id) && (
                  <span className="k-ce-label__mark" data-changed="">
                    {t('pages.version', { version: marks?.get(p.id) ?? version })}
                  </span>
                )}
                {count > 0 && (
                  <span className="k-ce-label__mark">
                    <HugeiconsIcon icon={Comment01Icon} size={11} strokeWidth={2} />
                    {count}
                  </span>
                )}
              </div>
            )
          })}
          {pages.map((p) => {
            const status = faultOf(p)
            if (status === null) return null
            const reason = t('viewer.frameFailedWhy', { file: p.file, version })
            return (
              <div
                key={`fault:${p.id}`}
                className="k-ce-fault"
                style={{ left: p.x, top: p.y, width: p.width, height: p.height }}
              >
                <div
                  className="k-ce-fault__screen"
                  style={{
                    width: `calc(${p.width}px / var(--unscale))`,
                    height: `calc(${p.height}px / var(--unscale))`,
                  }}
                >
                  <PieceFault
                    title={t('viewer.frameFailed')}
                    retry={{ label: t('viewer.retry'), run: () => retryFrame(p) }}
                    reason={status === 503 ? t('viewer.error.unavailable') : reason}
                    actions={
                      <>
                        <Button size="sm" variant="secondary" onClick={() => retryFrame(p)}>
                          {t('viewer.retry')}
                        </Button>
                        {states?.ask && (
                          <Button
                            size="sm"
                            variant="secondary"
                            icon={<span className="aps-ask__mark">{states.ask.mark}</span>}
                            onClick={() => states.ask!.repair(p.file, reason)}
                          >
                            {t('sheet.ask', { agent: states.ask.agent })}
                          </Button>
                        )}
                      </>
                    }
                  />
                </div>
              </div>
            )
          })}
          {flashedPage && (
            <span
              key={flash!.seq}
              aria-hidden
              className="k-ce-flash"
              style={{
                left: flashedPage.x,
                top: flashedPage.y,
                width: flashedPage.width,
                height: flashedPage.height,
              }}
            />
          )}
          {!focused &&
            selectedPages.map((p) => (
              <div
                key={p.id}
                className="k-ce-sel"
                style={{ left: p.x, top: p.y, width: p.width, height: p.height }}
              />
            ))}
          {selectedBox && actions && !focused && !panning && (
            <FrameBar
              box={selectedBox}
              frames={selectedPages}
              readOnly={readOnly}
              tweaks={selectedPages.length === 1 && frameParams.has(selectedPages[0]!.id)}
              compact={tier === 'narrow'}
              controls={controls}
              faulted={pages.filter((p) => faults.has(p.id) && !shownSelection.includes(p.id))}
              onRetry={
                selectedPages.length === 1 && faults.has(selectedPages[0]!.id)
                  ? () => retryFrame(selectedPages[0]!)
                  : null
              }
              actions={actions}
              onOpen={(id) => setFocused(id)}
              onTweak={(id) => {
                setSelection([id])
                toggleTweaks(true)
              }}
            />
          )}
          <div className="ui-agc k-ce-agents">
            {agents.map((agent) => {
              const at = pointerAt(agent)
              if (!at) return null
              return (
                <div key={agent.sessionId}>
                  {at.box && agent.doing === 'write' && (
                    <span
                      className="k-ce-working"
                      style={{
                        left: at.box.x,
                        top: at.box.y,
                        width: at.box.width,
                        height: at.box.height,
                      }}
                    />
                  )}
                  <div
                    className="k-ce-pointer"
                    style={{ transform: `translate(${at.x}px, ${at.y}px) scale(var(--unscale))` }}
                  >
                    <AgentPointer
                      agent={{
                        id: agent.sessionId,
                        name: agent.name,
                        avatar: <AgentMark agent={agent.agentId} size={12} hostId={agent.hostId} />,
                      }}
                      x={0}
                      y={0}
                      doing={doingText(t, agent, agentPages.get(agent.sessionId)?.name ?? null)}
                      dim={following !== null && following !== agent.sessionId}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        {opened && openedPage && focused === opened.id && faultOf(openedPage) === null && (
          <OpenedFrame
            key={openedPage.id}
            page={openedPage}
            opened={opened}
            src={framePageUrl(
              url,
              { version, loadFrom },
              { group: 0, index: 1, file: openedPage.file },
            )}
            origin={url.slice(0, -1)}
            editor={editor}
            index={indexInDoc(openedPage.id)}
            mode={mode}
            reloads={reloads}
            scroller={scroller}
            onScroll={(scrolled) => place({ ...opened.camera, y: opened.camera.y - scrolled })}
            onKey={onFrameKey}
            onPicked={() => stage.current?.focus({ preventScroll: true })}
            before={
              showingBefore && compare
                ? {
                    version: compare.before,
                    src: framePageUrl(
                      url,
                      { version: compare.before, loadFrom: new Map() },
                      { group: 0, index: 1, file: openedPage.file },
                    ),
                  }
                : null
            }
          />
        )}
      </div>

      {doc && (
        <ViewerSlot slot="left">
          <PagesCard
            doc={doc}
            canvasKey={canvasKey}
            selection={shownSelection}
            opened={focused}
            changed={changed}
            marks={marks}
            comments={comments}
            faults={faults}
            writing={writingMarks}
            artifactId={artifactId}
            version={version}
            onPage={(id) => setViewerState(artifactId, { page: id, selection: [], opened: null })}
            onFrame={(frame) => {
              const page = doc.pages.find((p) => p.id === frame)
              if (!page) return
              revealAsked.current = frame
              setViewerState(artifactId, (s) => ({
                page: page.canvas,
                selection: [frame],
                opened: s.opened && page.canvas === canvasKey ? frame : null,
              }))
              if (page.canvas === shownKey && !focused) {
                revealAsked.current = null
                const placed = pages.find((p) => p.id === frame)
                if (placed) revealFrame(placed)
              }
            }}
            onOpen={(frame) => {
              const page = doc.pages.find((p) => p.id === frame)
              if (page)
                setViewerState(artifactId, { page: page.canvas, selection: [frame], opened: frame })
            }}
          />
        </ViewerSlot>
      )}
      {layout && tweaksOpen && (
        <ViewerSlot slot="right">
          <TweakCard
            artifactId={artifactId}
            version={version}
            page={tweakPage ?? null}
            params={tweakPage ? (frameParams.get(tweakPage.id) ?? null) : null}
            frameOf={() => (tweakPage ? (editorFrames.current.get(tweakPage.id) ?? null) : null)}
            readOnly={readOnly}
          />
        </ViewerSlot>
      )}
      {following && followed && (
        <FollowBanner
          name={followed.name}
          agentId={followed.agentId}
          hostId={followed.hostId}
          onStop={onFollowDone}
        />
      )}
      {empty && !readOnly && (
        <StageNote
          kind={null}
          title={t('viewer.noFrames')}
          text={
            states?.ask
              ? t('viewer.noFramesHint', { agent: states.ask.agent })
              : t('viewer.noFramesHintAny')
          }
        >
          {states?.ask && (
            <Button
              size="sm"
              variant="secondary"
              icon={<span className="aps-ask__mark">{states.ask.mark}</span>}
              onClick={states.ask.whole}
            >
              {t('sheet.ask', { agent: states.ask.agent })}
            </Button>
          )}
        </StageNote>
      )}
      {focusedPage ? (
        <PagerDock
          where={t('present.position', {
            name: `${pageNumber} ${pageName}`,
            number: openedAt + 1,
            count: pages.length,
          })}
          first={openedAt <= 0}
          last={openedAt >= pages.length - 1}
          fit={fit}
          onFit={(next) => setViewerState(artifactId, { fit: next })}
          tweaks={
            !readOnly && frameParams.has(focusedPage.id)
              ? { open: tweaksOpen, toggle: () => toggleTweaks(!tweaksOpen) }
              : null
          }
          onStep={stepOpened}
          onBack={() => setFocused(null)}
          compare={compareSwitch}
        />
      ) : (
        <CanvasDock
          controls={controls}
          narrow={tier === 'narrow'}
          tweaks={readOnly ? null : { open: tweaksOpen, toggle: () => toggleTweaks(!tweaksOpen) }}
          onZoom={(direction) => zoomAround(stepZoom(camera.current.z, direction))}
          onFit={() => land(true)}
          onActual={() => zoomAround(1)}
          compare={compareSwitch}
        />
      )}
      {opened && opened.long && openedPage && (
        <OpenedPosition opened={opened} page={openedPage} scroller={scroller} />
      )}
    </div>
  )
})

/**
 * An opened frame, live, at reading size over its picture on the canvas: a long one scrolls in
 * place, which moves the camera with it, so the page around stays where the frame is.
 */
function OpenedFrame({
  page,
  opened,
  src,
  origin,
  editor,
  index,
  mode,
  reloads,
  scroller,
  onScroll,
  onKey,
  onPicked,
  before,
}: {
  page: CanvasPage
  opened: Opened
  src: string
  origin: string
  editor: ArtifactEditor | undefined
  index: number
  mode: 'select' | 'comment' | null
  reloads: number
  scroller: React.RefObject<HTMLDivElement | null>
  onScroll: (scrolled: number) => void
  onKey: (key: PageKey) => void
  onPicked: () => void
  /** The version before, shown over the frame instead of it. */
  before: { version: number; src: string } | null
}) {
  const { t } = useTranslation('artifacts')
  const { frame, ref: frameRef, onLoad } = useKeyedFrame(editor, index, origin, onKey)
  const [loaded, setLoaded] = useState(false)
  const element = useRef<HTMLIFrameElement | null>(null)
  const [mountedAt] = useState(reloads)
  useEffect(() => {
    if (reloads !== mountedAt && element.current) element.current.src = src
  }, [reloads, mountedAt, src])
  const width = page.width * opened.z
  const height = page.height * opened.z
  return (
    <div
      ref={scroller}
      className="k-ce-open"
      style={{ left: opened.x, width }}
      onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
    >
      <div style={{ height: Math.max(opened.viewHeight, opened.y + height + opened.bottom) }}>
        <div className="k-ce-open__frame" style={{ top: opened.y, width, height }}>
          <iframe
            ref={(el) => {
              element.current = el
              frameRef(el)
            }}
            src={src}
            title={page.name}
            sandbox={isWeb ? WEB_ARTIFACT_FRAME_SANDBOX : ARTIFACT_FRAME_SANDBOX}
            allow=""
            referrerPolicy="no-referrer"
            onLoad={() => {
              setLoaded(true)
              onLoad()
            }}
            style={{
              width: page.width,
              height: page.height,
              transform: `scale(${opened.z})`,
              opacity: loaded ? 1 : 0,
            }}
          />
          {mode && frame && !before && (
            <PickLayer frame={frame} scale={opened.z} mode={mode} onDone={onPicked} />
          )}
          {before && (
            <div className="k-vt-before">
              <iframe
                src={before.src}
                title={t('compare.beforeTitle', { name: page.name, version: before.version })}
                sandbox={isWeb ? WEB_ARTIFACT_FRAME_SANDBOX : ARTIFACT_FRAME_SANDBOX}
                allow=""
                referrerPolicy="no-referrer"
                style={{
                  width: page.width,
                  height: page.height,
                  transform: `scale(${opened.z})`,
                }}
              />
              <span className="k-vt-before__tag">
                {t('compare.before', { version: before.version })}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** How far down a long opened frame is, beside it. */
function OpenedPosition({
  opened,
  page,
  scroller,
}: {
  opened: Opened
  page: CanvasPage
  scroller: React.RefObject<HTMLDivElement | null>
}) {
  const [scrolled, setScrolled] = useState(0)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = () => setScrolled(el.scrollTop)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scroller, opened])
  const height = page.height * opened.z
  const viewHeight = opened.viewHeight
  return (
    <PositionBar
      left={opened.x + page.width * opened.z + 8}
      top={opened.y}
      track={viewHeight - opened.y - opened.bottom}
      view={viewHeight}
      range={opened.y + height + opened.bottom - viewHeight}
      scrolled={scrolled}
    />
  )
}

function doingText(
  t: TFunction<'artifacts'>,
  agent: CanvasAgent,
  page: string | null,
): string | null {
  switch (agent.doing) {
    case 'read':
      return page ? t('board.agent.reading', { page }) : t('board.agent.readingArtifact')
    case 'write':
      return page ? t('board.agent.writing', { page }) : t('board.agent.writingArtifact')
    case 'draw':
      return page ? t('board.agent.drawing', { page }) : t('board.agent.writingArtifact')
    case 'move':
      return page ? t('board.agent.moving', { page }) : t('board.agent.writingArtifact')
    default:
      return null
  }
}

/**
 * Above the selected frame: open it, present from it, ask the agent, tweak it and download it;
 * above several, ask the agent about them. Drawn in the canvas's layer at screen size.
 */
function FrameBar({
  box,
  frames,
  readOnly,
  tweaks,
  compact,
  controls,
  faulted,
  onRetry,
  actions,
  onOpen,
  onTweak,
}: {
  box: Box
  frames: CanvasPage[]
  readOnly: boolean
  tweaks: boolean
  /** Narrow: the actions as icons alone, so the bar fits over a frame in the side panel. */
  compact: boolean
  controls: CanvasControls
  /** The other frames that cannot show, whose marks the bar leaves in sight. */
  faulted: readonly Box[]
  /** Loads the one frame again, when it could not show. */
  onRetry: (() => void) | null
  actions: DocPageActions
  onOpen: (id: string) => void
  onTweak: (id: string) => void
}) {
  const { t } = useTranslation('artifacts')
  const one = frames.length === 1 ? frames[0]! : null
  const { zoom } = useCanvasState(controls)
  // Over the selection, the bar would cover a frame that cannot show: it goes under instead.
  const below = faulted.some(
    (p) =>
      p.x < box.x + (compact ? FBAR_NARROW : FBAR_WIDE) / zoom &&
      p.x + p.width > box.x &&
      p.y < box.y &&
      p.y + p.height > box.y - FBAR_RISE / zoom,
  )
  return (
    <div
      className="k-ce-fbar"
      onPointerDown={(event) => event.stopPropagation()}
      data-below={below ? '' : undefined}
      style={{
        left: box.x,
        top: below
          ? `calc(${box.y + box.height}px + 8px * var(--unscale))`
          : `calc(${box.y}px - 30px * var(--unscale))`,
      }}
    >
      {one ? (
        <>
          {onRetry && (
            <BarAct label={t('viewer.retry')} icon={ArrowReloadHorizontalIcon} onClick={onRetry}>
              {!compact && t('viewer.retry')}
            </BarAct>
          )}
          <BarAct label={t('frame.open')} onClick={() => onOpen(one.id)} primary>
            {t('frame.open')}
            {!compact && <Kbd>↵</Kbd>}
          </BarAct>
          <BarAct
            label={t('canvas.presentFrom')}
            icon={PlayIcon}
            onClick={() => actions.present(one)}
          >
            {!compact && t('frame.present')}
          </BarAct>
          {!readOnly && (
            <BarAct
              label={t('frame.ask')}
              icon={AiMagicIcon}
              onClick={() => actions.handOff([one.id])}
            >
              {!compact && t('frame.ask')}
            </BarAct>
          )}
          {!readOnly && tweaks && (
            <BarAct
              label={t('board.page.tweak')}
              icon={SlidersHorizontalIcon}
              onClick={() => onTweak(one.id)}
            />
          )}
          {actions.download && (
            <Dropdown
              side="bottom"
              align="end"
              items={[
                {
                  label: t('canvas.downloadPng'),
                  icon: Download04Icon,
                  onSelect: () => actions.download?.(one),
                },
              ]}
              trigger={({ open, toggle }) => (
                <button
                  type="button"
                  className="k-ce-fbar__btn"
                  aria-label={t('viewer.more')}
                  title={t('viewer.more')}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  onClick={toggle}
                >
                  <HugeiconsIcon icon={MoreHorizontalIcon} size={14} strokeWidth={1.9} />
                </button>
              )}
            />
          )}
        </>
      ) : (
        <>
          <span className="k-ce-fbar__count">{t('frame.count', { count: frames.length })}</span>
          {!readOnly && (
            <BarAct
              label={t('frame.ask')}
              icon={AiMagicIcon}
              onClick={() => actions.handOff(frames.map((f) => f.id))}
            >
              {t('frame.ask')}
            </BarAct>
          )}
        </>
      )}
    </div>
  )
}

function BarAct({
  label,
  icon,
  primary,
  children,
  onClick,
}: {
  label: string
  icon?: IconSvgElement
  primary?: boolean
  children?: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="k-ce-fbar__btn"
      data-primary={primary ? '' : undefined}
      aria-label={children ? undefined : label}
      title={label}
      onClick={onClick}
    >
      {icon && <HugeiconsIcon icon={icon} size={14} strokeWidth={1.9} />}
      {children}
    </button>
  )
}

/** The dock under a page: the Pages card, landing, the zoom, then the tweaks; fewer, narrow. */
function CanvasDock({
  controls,
  narrow,
  tweaks,
  onZoom,
  onFit,
  onActual,
  compare,
}: {
  controls: CanvasControls
  narrow: boolean
  tweaks: { open: boolean; toggle: () => void } | null
  onZoom: (direction: 1 | -1) => void
  onFit: () => void
  onActual: () => void
  compare: CompareSwitch | null
}) {
  const { t } = useTranslation('artifacts')
  const { zoom } = useCanvasState(controls)
  const left = useShell().leftCard
  return (
    <ViewerSlot slot="dock">
      {left && (
        <>
          <DockButton
            label={t('pages.title')}
            icon={SidebarLeftIcon}
            pressed={left.shown}
            onClick={() => left.setShown(!left.shown)}
          />
          <DockRule />
        </>
      )}
      {!narrow && (
        <DockButton label={t('canvas.fitWidth')} onClick={onFit}>
          {t('canvas.fitWidth')}
        </DockButton>
      )}
      <DockButton label={t('canvas.zoomOut')} icon={MinusSignIcon} onClick={() => onZoom(-1)} />
      <DockButton label={t('canvas.actualSize')} onClick={onActual}>
        <span className="avs-dock__pct">
          {t('canvas.zoom', { percent: Math.round(zoom * 100) })}
        </span>
      </DockButton>
      <DockButton label={t('canvas.zoomIn')} icon={PlusSignIcon} onClick={() => onZoom(1)} />
      {narrow ? (
        <Dropdown
          align="end"
          side="top"
          items={[
            ...(tweaks
              ? [
                  {
                    label: t('board.top.tweaks'),
                    icon: SlidersHorizontalIcon,
                    onSelect: tweaks.toggle,
                  },
                ]
              : []),
            { label: t('canvas.fitWidth'), divider: !!tweaks, onSelect: onFit },
            { label: t('canvas.actualSize'), onSelect: onActual },
          ]}
          trigger={({ open, toggle }) => (
            <button
              type="button"
              aria-label={t('viewer.more')}
              title={t('viewer.more')}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={toggle}
              className="avs-dock__btn"
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} size={15} strokeWidth={1.9} />
            </button>
          )}
        />
      ) : (
        tweaks && (
          <>
            <DockRule />
            <DockButton
              label={t('board.top.tweaks')}
              icon={SlidersHorizontalIcon}
              pressed={tweaks.open}
              onClick={tweaks.toggle}
            />
          </>
        )
      )}
      {compare && <CompareDock compare={compare} />}
    </ViewerSlot>
  )
}

/** The dock while a frame is open: the page's frames one by one, the size, and back. */
function PagerDock({
  where,
  first,
  last,
  fit,
  onFit,
  tweaks,
  onStep,
  onBack,
  compare,
}: {
  where: string
  first: boolean
  last: boolean
  fit: Parameters<typeof FitMenu>[0]['value']
  onFit: (fit: Parameters<typeof FitMenu>[0]['value']) => void
  tweaks: { open: boolean; toggle: () => void } | null
  onStep: (step: 1 | -1) => void
  onBack: () => void
  compare: CompareSwitch | null
}) {
  const { t } = useTranslation('artifacts')
  const { tier } = useShell()
  return (
    <ViewerSlot slot="dock">
      <DockButton
        label={t('canvas.previous')}
        icon={ArrowLeft01Icon}
        disabled={first}
        onClick={() => onStep(-1)}
      />
      <span className="avs-dock__count">{where}</span>
      <DockButton
        label={t('canvas.next')}
        icon={ArrowRight01Icon}
        disabled={last}
        onClick={() => onStep(1)}
      />
      <DockRule />
      <FitMenu value={fit} onChange={onFit} />
      {compare && <CompareDock compare={compare} />}
      {tweaks && (
        <DockButton
          label={t('board.top.tweaks')}
          icon={SlidersHorizontalIcon}
          pressed={tweaks.open}
          onClick={tweaks.toggle}
        />
      )}
      <DockRule />
      <DockButton label={t('frame.back')} onClick={onBack}>
        {tier === 'narrow' ? t('frame.backShort') : t('frame.back')}
        <Kbd>Esc</Kbd>
      </DockButton>
    </ViewerSlot>
  )
}

function FollowBanner({
  name,
  agentId,
  hostId,
  onStop,
}: {
  name: string
  agentId: AgentId
  hostId: string | null
  onStop: () => void
}) {
  const { t } = useTranslation('artifacts')
  return (
    <div className="k-ce-banner k-ce-float">
      <AgentMark agent={agentId} size={14} hostId={hostId} />
      <span>{t('board.agent.following', { agent: name })}</span>
      <button type="button" className="k-ce-tool" onClick={onStop}>
        {t('board.agent.stop')}
      </button>
    </div>
  )
}
