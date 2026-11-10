import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AiMagicIcon,
  CenterFocusIcon,
  Download04Icon,
  GridIcon,
  MinusSignIcon,
  Cancel01Icon,
  PlayIcon,
  PlusSignIcon,
  SlidersHorizontalIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { animate, type AnimationPlaybackControls } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { AgentId } from '@shared/agents'
import type { ArtifactDoing, ArtifactFocus } from '@shared/artifacts'
import { strokePath } from '@shared/canvas-stroke'
import {
  canvasId,
  joinedEnds,
  noteBox,
  PAGE_MAX,
  PAGE_MIN,
  type Box,
  type CanvasNote,
  type CanvasOp,
  type CanvasPage,
  type ShapeNote,
} from '@shared/canvas-doc'
import { AgentCursorStyles, AgentPointer } from '@renderer/components/affect/agent-cursors'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { glide } from '@renderer/lib/motion'
import { cn } from '@renderer/lib/utils'
import { prefersReducedMotion } from '@renderer/stores/settings'
import {
  between,
  fitBox,
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
import { CanvasFrame, FocusedPage } from './canvas-view'
import { CanvasLayers, CanvasProps, CanvasToolbar, CanvasTweaks } from './canvas-editor-panels'
import { contains, docLayout, overlaps, snap, type DocLayout } from './canvas-model'
import { useEditorState, type ArtifactEditor, type EditorFrame } from './editor'
import { isModeKey } from './keys'
import type { CanvasDocState } from './use-canvas-doc'
import { useFrameParams } from './use-frame-params'
import { pageUrl } from './use-artifact'
import { NOTE_COLOR_VAR, type PenStyle, type ShapeKind, type Tool } from './canvas-tools'
import './canvas-editor.css'

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
/** How near, in screen pixels, a moved edge snaps to another. */
const SNAP_PX = 6
const HANDLE_PX = 8
const NEW_PAGE = { width: 1440, height: 900 }
const TOOL_KEYS: Record<string, Tool> = {
  v: 'move',
  h: 'hand',
  f: 'page',
  t: 'text',
  s: 'sticky',
  p: 'pen',
  r: 'shape',
}

type Corner = 'nw' | 'ne' | 'sw' | 'se'

interface Drag {
  kind: 'pan' | 'move' | 'resize' | 'marquee' | 'create' | 'pen'
  sx: number
  sy: number
  cx: number
  cy: number
  camera: Camera
  moved: boolean
  ids?: string[]
  corner?: Corner
  points?: number[]
  /** A press on a frame that picks the element under it unless it turns into a drag. */
  pick?: { page: string; x: number; y: number; at: { x: number; y: number } }
}

/** The ops that move an object by (dx, dy) from where `doc` has it. */
function moveOps(layout: DocLayout, id: string, dx: number, dy: number): CanvasOp[] {
  const page = layout.pages.find((p) => p.id === id)
  if (page) {
    return [
      { op: 'set', id, key: 'x', value: Math.round(page.x + dx) },
      { op: 'set', id, key: 'y', value: Math.round(page.y + dy) },
    ]
  }
  const note = layout.notes.find((n) => n.id === id)
  if (!note) return []
  switch (note.kind) {
    case 'text':
    case 'sticky':
      return [
        { op: 'set', id, key: 'x', value: note.x + dx },
        { op: 'set', id, key: 'y', value: note.y + dy },
      ]
    case 'pen':
      return [
        {
          op: 'set',
          id,
          key: 'points',
          value: note.points.map((v, i) => (i % 3 === 0 ? v + dx : i % 3 === 1 ? v + dy : v)),
        },
      ]
    default:
      return [
        { op: 'set', id, key: 'x1', value: note.x1 + dx },
        { op: 'set', id, key: 'y1', value: note.y1 + dy },
        { op: 'set', id, key: 'x2', value: note.x2 + dx },
        { op: 'set', id, key: 'y2', value: note.y2 + dy },
      ]
  }
}

function boxOf(layout: DocLayout, id: string): Box | null {
  const page = layout.pages.find((p) => p.id === id)
  if (page) return page
  const note = layout.notes.find((n) => n.id === id)
  return note ? noteBox(note) : null
}

function union(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null
  const left = Math.min(...boxes.map((b) => b.x))
  const top = Math.min(...boxes.map((b) => b.y))
  const right = Math.max(...boxes.map((b) => b.x + b.width))
  const bottom = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** The band above a frame, in screen pixels, where its name selects the whole frame. */
const LABEL_BAND = 24

/** The width from which the panels take room beside the pages instead of covering them. */
const WIDE_PX = 900

/** The room the right panel takes, which fitting leaves free. */
const SIDE_ROOM = 300

/** The room the open layers panel takes at the left, which fitting leaves free. */
const LAYERS_ROOM = 256

/** A label's action button and the gap after it, in screen pixels. */
const LABEL_ACT = 22

/** Hides a page's name row where the page is too narrow on screen for its name and actions. */
function fitLabels(layer: HTMLElement | undefined, z: number): void {
  if (!layer) return
  for (const label of layer.querySelectorAll<HTMLElement>('.k-ce-label')) {
    const acts = label.querySelector('.k-ce-label__acts')?.childElementCount ?? 0
    const needs = NAME_MIN_WIDTH + (acts > 0 ? 6 + acts * LABEL_ACT : 0)
    const visibility = Number(label.dataset.width) * z < needs ? 'hidden' : ''
    if (label.style.visibility !== visibility) label.style.visibility = visibility
  }
}

/** One note, drawn on the canvas at its own place. */
export function NoteView({
  note,
  pages,
  editing,
  doneBy,
}: {
  note: CanvasNote
  pages: readonly CanvasPage[]
  editing: boolean
  doneBy: string | null
}) {
  const color = NOTE_COLOR_VAR[note.color]
  switch (note.kind) {
    case 'text':
      return editing ? null : (
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
          {!editing && note.text}
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

/**
 * A canvas document's active canvas, edited like a design app: its pages and notes on a
 * surface that pans and zooms, the floating tools over it, and the agents at work on it.
 */
export const CanvasEditor = memo(function CanvasEditor({
  artifactId,
  url,
  version,
  title,
  canvas,
  files,
  readOnly,
  controls,
  top = 0,
  editor,
  actions,
  agents,
  following,
  onFollowDone,
  onViewPage,
  sessionName,
  reloads,
}: {
  artifactId: string
  url: string
  version: number
  title: string
  canvas: CanvasDocState
  /** The files of the version on screen; a page whose file is missing shows blank. */
  files: ReadonlySet<string>
  readOnly: boolean
  controls: CanvasControls
  top?: number
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
}) {
  const { t } = useTranslation('artifacts')
  const doc = canvas.doc
  const [activeCanvas, setActiveCanvas] = useState<string | null>(null)
  const canvasKey = doc?.canvases.some((c) => c.id === activeCanvas)
    ? activeCanvas!
    : (doc?.canvases[0]?.id ?? '')
  const layout = useMemo(() => (doc ? docLayout(doc, canvasKey) : null), [doc, canvasKey])
  const base = useMemo(
    () => (canvas.base ? docLayout(canvas.base, canvasKey) : null),
    [canvas.base, canvasKey],
  )
  const pages = useMemo(() => layout?.pages ?? [], [layout])

  const stage = useRef<HTMLDivElement>(null)
  const layers = useRef<HTMLDivElement[]>([])
  const camera = useRef<Camera>({ x: 0, y: 0, z: 1 })
  const view = useRef<Size>({ width: 0, height: 0 })
  const fitted = useRef(false)
  const atFit = useRef(false)
  const glideTo = useRef<AnimationPlaybackControls | null>(null)
  const liveFrame = useRef(0)
  const [live, setLive] = useState<ReadonlySet<string>>(new Set())
  const liveNow = useRef(live)
  // The live pages that have loaded, or loaded long enough for the next to start.
  const settled = useRef(new Set<string>())
  const frames = useRef(new Map<string, HTMLIFrameElement>())
  const editorFrames = useRef(new Map<string, EditorFrame>())
  const editing = useEditorState(editor)
  const [tool, setTool] = useState<Tool>('move')
  const [shape, setShape] = useState<ShapeKind>('rect')
  const [pen, setPen] = useState<PenStyle>({ marker: false, color: 'red', width: 3 })
  const [selection, setSelection] = useState<string[]>([])
  const [inside, setInside] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const [textEdit, setTextEdit] = useState<string | null>(null)
  // Open in the full editor, as the list of what the canvas holds; the side panel has no room.
  // Whether the canvas has room for its panels beside the pages, as in the main area; narrower,
  // as in a session's side panel, they open over the pages and the layers start closed.
  const [wide, setWide] = useState(true)
  const [layersChoice, setLayersOpen] = useState<boolean | null>(null)
  const layersOpen = layersChoice ?? (!readOnly && wide)
  // The right panel's tab the user chose; without one it shows the selection's properties.
  const [side, setSide] = useState<'props' | 'tweaks' | null>(null)
  const [guides, setGuides] = useState<ReturnType<typeof snap>['guides']>([])
  const [marquee, setMarquee] = useState<Box | null>(null)
  const [stroke, setStroke] = useState<number[] | null>(null)
  const [creating, setCreating] = useState<Box | null>(null)
  const [spaceDown, setSpaceDown] = useState(false)
  const [located, setLocated] = useState<Record<string, Box | null>>({})
  const drag = useRef<Drag | null>(null)
  // Mirrors of the drag under way for what renders: a pan's cursor, the selection's bar.
  const [panning, setPanning] = useState(false)
  const [dragging, setDragging] = useState(false)
  const pageNumber = useRef(0)

  const mode = editor ? editing.mode : null
  const hand = tool === 'hand' || spaceDown

  // Selected ids that are gone drop out.
  const shownSelection = useMemo(
    () => (layout ? selection.filter((id) => boxOf(layout, id)) : []),
    [layout, selection],
  )
  const frameParams = useFrameParams(artifactId, version, pages)
  // The right panel: the tab chosen, else the selection's properties while there is one.
  const shownSide = readOnly
    ? null
    : (side ?? (shownSelection.length > 0 && !inside ? 'props' : null))

  // Live pages follow the camera, nearest first, one more each time the last has settled; a page
  // without its file yet has nothing to load.
  const syncLive = useCallback(() => {
    cancelAnimationFrame(liveFrame.current)
    liveFrame.current = requestAnimationFrame(() => {
      const wanted = livePages(pages, camera.current, view.current)
        .map((i) => pages[i]!)
        .filter((p) => files.has(p.file))
        .map((p) => p.id)
      const next = stepLive(liveNow.current, wanted, settled.current)
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
    for (const el of layers.current) {
      if (!el) continue
      el.style.transform = `translate(${x}px, ${y}px) scale(${z})`
      el.style.setProperty('--unscale', String(1 / z))
    }
    fitLabels(layers.current[1], z)
    controls.publish({ zoom: z, fitted: atFit.current })
    syncLive()
  }, [controls, syncLive])

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
    (target: Camera, fit = false) => {
      glideTo.current?.stop()
      if (prefersReducedMotion()) return place(target, fit)
      atFit.current = fit
      const from = camera.current
      glideTo.current = animate(0, 1, {
        ...glide,
        onUpdate: (k) => {
          camera.current = between(from, target, k, view.current)
          draw()
        },
      })
    },
    [place, draw],
  )

  // Fitting leaves the open panels' room free.
  const leftRoom = layersOpen && wide ? LAYERS_ROOM : 0
  const rightRoom = shownSide && wide ? SIDE_ROOM : 0
  const fitAll = useCallback(
    (glides: boolean, rooms = { left: leftRoom, right: rightRoom }) => {
      const bounds = layout?.bounds
      if (!bounds || bounds.width === 0)
        return place({ x: view.current.width / 2, y: view.current.height / 2, z: 1 }, true)
      const target = fitBox(bounds, view.current, top + 56, 56, rooms.left, rooms.right)
      if (glides) moveTo(target, true)
      else place(target, true)
    },
    [layout, top, leftRoom, rightRoom, moveTo, place],
  )

  const fitBoxGlide = useCallback(
    (box: Box) => moveTo(fitBox(box, view.current, top + 56, 56, leftRoom, rightRoom)),
    [top, leftRoom, rightRoom, moveTo],
  )

  const zoomAround = useCallback(
    (z: number) => {
      const { width, height } = view.current
      moveTo(zoomAt(camera.current, z, width / 2, height / 2))
    },
    [moveTo],
  )

  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      if (width === view.current.width && height === view.current.height) return
      view.current = { width, height }
      const isWide = width >= WIDE_PX
      setWide(isWide)
      // The rooms this width gives, before the state above renders.
      const rooms = {
        left: (layersChoice ?? (!readOnly && isWide)) && isWide ? LAYERS_ROOM : 0,
        right: shownSide && isWide ? SIDE_ROOM : 0,
      }
      if (!fitted.current && width > 0) {
        fitted.current = true
        fitAll(false, rooms)
      } else if (atFit.current) fitAll(false, rooms)
      else draw()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [fitAll, draw, layersChoice, readOnly, shownSide])

  // A fitted view fits again in the room a panel that opened or closed leaves.
  const rooms = `${leftRoom}:${rightRoom}`
  const lastRooms = useRef(rooms)
  useEffect(() => {
    if (lastRooms.current === rooms) return
    lastRooms.current = rooms
    if (fitted.current && atFit.current) fitAll(true)
  }, [rooms, fitAll])

  // Another canvas fits its own pages.
  const lastCanvas = useRef(canvasKey)
  useEffect(() => {
    if (lastCanvas.current === canvasKey) return
    lastCanvas.current = canvasKey
    if (fitted.current) fitAll(false)
  }, [canvasKey, fitAll])

  useEffect(() => {
    draw()
  }, [draw, layout])

  useEffect(
    () =>
      controls.attach({
        zoomStep: (direction) => zoomAround(stepZoom(camera.current.z, direction)),
        fitAll: () => fitAll(true),
        fitSelected: () => {
          const box =
            layout && union(shownSelection.map((id) => boxOf(layout, id)!).filter(Boolean))
          if (box) fitBoxGlide(box)
        },
        actualSize: () => zoomAround(1),
        focus: (index) => setFocused(index === null ? null : (pages[index]?.id ?? null)),
      }),
    [controls, zoomAround, fitAll, fitBoxGlide, layout, shownSelection, pages],
  )

  useEffect(() => {
    controls.publish({
      count: pages.length,
      selected: Math.max(
        0,
        pages.findIndex((p) => p.id === shownSelection[0]),
      ),
    })
  }, [controls, pages, shownSelection])

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

  // The wheel pans, and zooms with Mod or a pinch.
  useEffect(() => {
    const el = stage.current
    if (!el || focused !== null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.current.height : 1
      const current = camera.current
      if (event.ctrlKey || event.metaKey) {
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
  }, [focused, place])

  // The move tool selects what is in the frames, outlined under the pointer, as design tools do;
  // the comment tool is comment mode; a read-only canvas selects only in a page entered.
  useEffect(() => {
    if (!editor) return
    editor.setBase(null)
    editor.setMode(
      tool === 'comment' ? 'comment' : inside || (tool === 'move' && !readOnly) ? 'select' : null,
    )
  }, [editor, tool, inside, readOnly])

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
    if (!followedPage) return
    fitBoxGlide(followedPage)
  }, [followedPage, fitBoxGlide])

  /** A spot on the screen in canvas pixels. */
  const toCanvas = (sx: number, sy: number): { x: number; y: number } => {
    const { x, y, z } = camera.current
    return { x: (sx - x) / z, y: (sy - y) / z }
  }
  const screenPoint = (event: React.PointerEvent | React.MouseEvent) => {
    const rect = stage.current!.getBoundingClientRect()
    return { sx: event.clientX - rect.left, sy: event.clientY - rect.top }
  }

  /** What lies under a canvas point: the topmost note or a page. */
  const hit = useCallback(
    (x: number, y: number): string | null => {
      if (!layout) return null
      const reach = 6 / camera.current.z
      for (let i = layout.notes.length - 1; i >= 0; i--) {
        const n = layout.notes[i]!
        const b = noteBox(n)
        if (
          contains(
            {
              x: b.x - reach,
              y: b.y - reach,
              width: b.width + 2 * reach,
              height: b.height + 2 * reach,
            },
            x,
            y,
          )
        )
          return n.id
      }
      for (let i = layout.pages.length - 1; i >= 0; i--)
        if (contains(layout.pages[i]!, x, y)) return layout.pages[i]!.id
      return null
    },
    [layout],
  )

  const handleAt = (x: number, y: number): { id: string; corner: Corner } | null => {
    if (!layout || shownSelection.length !== 1) return null
    const page = layout.pages.find((p) => p.id === shownSelection[0])
    if (!page || page.locked) return null
    const r = HANDLE_PX / camera.current.z
    const corners: Array<[Corner, number, number]> = [
      ['nw', page.x, page.y],
      ['ne', page.x + page.width, page.y],
      ['sw', page.x, page.y + page.height],
      ['se', page.x + page.width, page.y + page.height],
    ]
    for (const [corner, cx, cy] of corners)
      if (Math.abs(x - cx) <= r && Math.abs(y - cy) <= r) return { id: page.id, corner }
    return null
  }

  const apply = useCallback((ops: CanvasOp[]) => !readOnly && canvas.apply(ops), [readOnly, canvas])

  const newPage = (box: Box): void => {
    if (!layout) return
    const id = canvasId('p')
    pageNumber.current = Math.max(pageNumber.current, layout.pages.length) + 1
    apply([
      {
        op: 'add',
        object: {
          type: 'page',
          id,
          canvas: canvasKey,
          name: t('board.page.newName', { number: pageNumber.current }),
          file: `page-${id}.html`,
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(Math.min(PAGE_MAX, Math.max(PAGE_MIN, box.width))),
          height: Math.round(Math.min(PAGE_MAX, Math.max(PAGE_MIN, box.height))),
          locked: false,
        },
      },
    ])
    setSelection([id])
    setTool('move')
  }

  const newNote = (object: Record<string, unknown>): string => {
    const id = canvasId('n')
    apply([{ op: 'add', object: { type: 'note', id, canvas: canvasKey, ...object } as never }])
    return id
  }

  const remove = (): void => {
    if (!layout) return
    const ids = shownSelection.filter((id) => {
      const page = layout.pages.find((p) => p.id === id)
      const note = layout.notes.find((n) => n.id === id)
      return !(page?.locked || note?.locked)
    })
    if (ids.length === 0) return
    apply(ids.map((id): CanvasOp => ({ op: 'remove', id })))
    setSelection([])
  }

  const duplicate = (): void => {
    if (!layout || !canvas.base) return
    const ops: CanvasOp[] = []
    const fresh: string[] = []
    for (const id of shownSelection) {
      const page = layout.pages.find((p) => p.id === id)
      if (page) {
        const copy = canvasId('p')
        ops.push({
          op: 'add',
          object: {
            type: 'page',
            ...page,
            id: copy,
            name: `${page.name} 2`,
            x: page.x + 48,
            y: page.y + 48,
          },
        })
        fresh.push(copy)
        continue
      }
      const note = layout.notes.find((n) => n.id === id)
      if (note) {
        const copy = canvasId('n')
        const moved = moveOps({ ...layout, notes: [note] }, note.id, 24, 24).reduce<
          Record<string, unknown>
        >((acc, op) => (op.op === 'set' ? { ...acc, [op.key]: op.value } : acc), {})
        ops.push({
          op: 'add',
          object: { type: 'note', ...note, ...moved, id: copy, by: null } as never,
        })
        fresh.push(copy)
      }
    }
    apply(ops)
    setSelection(fresh)
  }

  const nudge = (dx: number, dy: number): void => {
    if (!layout) return
    apply(shownSelection.flatMap((id) => moveOps(layout, id, dx, dy)))
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.target !== event.currentTarget) return
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (mod && key === 'z') {
      if (event.shiftKey) canvas.redo()
      else canvas.undo()
    } else if (mod && key === 'd') duplicate()
    else if (mod) return
    else if (event.key === ' ') {
      setSpaceDown(true)
      return event.preventDefault()
    } else if (key === 'escape') {
      if (editing.picked) editor?.clearPick()
      else if (inside) setInside(null)
      else if (shownSelection.length > 0) setSelection([])
      else if (tool !== 'move') setTool('move')
      else return
    } else if (event.key === 'Delete' || event.key === 'Backspace') remove()
    else if (event.key.startsWith('Arrow') && shownSelection.length > 0) {
      const step = event.shiftKey ? 10 : 1
      nudge(
        event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
        event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0,
      )
    } else if (event.shiftKey && event.code === 'Digit1') fitAll(true)
    else if (event.shiftKey && event.code === 'Digit0') zoomAround(1)
    else if (
      key === 'enter' &&
      shownSelection.length === 1 &&
      pages.some((p) => p.id === shownSelection[0])
    )
      setFocused(shownSelection[0]!)
    else if (editor && isModeKey(event.nativeEvent) === 'comment')
      setTool(tool === 'comment' ? 'move' : 'comment')
    else if (!readOnly && TOOL_KEYS[key]) setTool(TOOL_KEYS[key]!)
    else if (key === '+' || key === '=') zoomAround(stepZoom(camera.current.z, 1))
    else if (key === '-') zoomAround(stepZoom(camera.current.z, -1))
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  const onPointerDown = (event: React.PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1) return
    if (!layout) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const { sx, sy } = screenPoint(event)
    const at = toCanvas(sx, sy)
    const start = { sx, sy, cx: at.x, cy: at.y, camera: camera.current, moved: false }
    stage.current?.focus({ preventScroll: true })
    if (event.button === 1 || hand) {
      drag.current = { ...start, kind: 'pan' }
      setPanning(true)
      return
    }
    if (readOnly && tool !== 'move' && tool !== 'comment') return
    if (tool === 'comment' || inside || (mode && tool !== 'move')) {
      // Picking inside pages goes to their runtime.
      drag.current = null
      const page = pages.find((p) => contains(p, at.x, at.y))
      const frame = page && editorFrames.current.get(page.id)
      if (inside && page?.id !== inside) {
        setInside(null)
        return
      }
      if (frame && page)
        frame.pick(at.x - page.x, at.y - page.y, { x: event.clientX, y: event.clientY })
      else editor?.clearPick()
      return
    }
    if (tool === 'pen') {
      drag.current = { ...start, kind: 'pen', points: [at.x, at.y, event.pressure || 0.5] }
      setStroke(drag.current.points!)
      return
    }
    if (tool === 'page' || tool === 'shape') {
      drag.current = { ...start, kind: 'create' }
      return
    }
    if (tool === 'text' || tool === 'sticky') {
      const id = newNote(
        tool === 'text'
          ? {
              kind: 'text',
              x: at.x,
              y: at.y,
              text: t('board.note.text'),
              size: 24,
              color: pen.color === 'yellow' ? 'ink' : pen.color,
            }
          : { kind: 'sticky', x: at.x, y: at.y, width: 240, text: '', color: 'yellow' },
      )
      setSelection([id])
      setTextEdit(id)
      setTool('move')
      drag.current = null
      return
    }
    // Move tool.
    const handle = handleAt(at.x, at.y)
    if (handle && !readOnly) {
      drag.current = { ...start, kind: 'resize', ids: [handle.id], corner: handle.corner }
      return
    }
    // A frame's name selects the frame; a press inside it picks the element there on release.
    const named = pages.find((p) =>
      contains(
        { ...p, y: p.y - LABEL_BAND / camera.current.z, height: LABEL_BAND / camera.current.z },
        at.x,
        at.y,
      ),
    )
    const id = named?.id ?? hit(at.x, at.y)
    if (!id) {
      if (!event.shiftKey) setSelection([])
      editor?.clearPick()
      drag.current = { ...start, kind: 'marquee' }
      return
    }
    const framed =
      !named && !event.shiftKey && mode === 'select' ? pages.find((p) => p.id === id) : null
    if (framed) {
      drag.current = {
        ...start,
        kind: 'move',
        ids: [framed.id],
        pick: {
          page: framed.id,
          x: at.x - framed.x,
          y: at.y - framed.y,
          at: { x: event.clientX, y: event.clientY },
        },
      }
      return
    }
    editor?.clearPick()
    const next = event.shiftKey
      ? shownSelection.includes(id)
        ? shownSelection.filter((s) => s !== id)
        : [...shownSelection, id]
      : shownSelection.includes(id)
        ? shownSelection
        : [id]
    setSelection(next)
    drag.current = readOnly ? null : { ...start, kind: 'move', ids: next }
  }

  const onPointerMove = (event: React.PointerEvent): void => {
    const held = drag.current
    const { sx, sy } = screenPoint(event)
    const at = toCanvas(sx, sy)
    if (!held) {
      // Outlining what is under the pointer inside a page, as the editor's modes do.
      if (mode && layout) {
        const page = pages.find((p) => contains(p, at.x, at.y))
        for (const [pid, frame] of editorFrames.current) if (pid !== page?.id) frame.leave()
        if (page && (!inside || inside === page.id))
          editorFrames.current.get(page.id)?.point(at.x - page.x, at.y - page.y)
      }
      return
    }
    if (!held.moved && Math.hypot(sx - held.sx, sy - held.sy) > DRAG_SLOP) {
      held.moved = true
      setDragging(true)
      // A press on a frame that drags moves the frame, which it selects.
      if (held.pick) {
        editor?.clearPick()
        setSelection(held.ids!)
      }
    }
    if (!held.moved || !layout || !base) return
    const dx = at.x - held.cx
    const dy = at.y - held.cy
    switch (held.kind) {
      case 'pan':
        place({
          ...held.camera,
          x: held.camera.x + (sx - held.sx),
          y: held.camera.y + (sy - held.sy),
        })
        return
      case 'pen':
        held.points!.push(at.x, at.y, event.pressure || 0.5)
        setStroke([...held.points!])
        return
      case 'create':
      case 'marquee': {
        const box = {
          x: Math.min(at.x, held.cx),
          y: Math.min(at.y, held.cy),
          width: Math.abs(dx),
          height: Math.abs(dy),
        }
        if (held.kind === 'marquee') {
          setMarquee(box)
          const ids = [
            ...layout.pages.filter((p) => overlaps(p, box)).map((p) => p.id),
            ...layout.notes.filter((n) => overlaps(noteBox(n), box)).map((n) => n.id),
          ]
          setSelection(ids)
        } else setCreating(box)
        return
      }
      case 'move': {
        const ids = held.ids!.filter((id) => {
          const p = base.pages.find((q) => q.id === id)
          const n = base.notes.find((q) => q.id === id)
          return !(p?.locked || n?.locked)
        })
        const moving = union(ids.map((id) => boxOf(base, id)).filter((b): b is Box => b !== null))
        if (!moving) return
        const others = base.pages.filter((p) => !ids.includes(p.id))
        const snapped = event.metaKey
          ? { dx: 0, dy: 0, guides: [] }
          : snap(
              { ...moving, x: moving.x + dx, y: moving.y + dy },
              others,
              SNAP_PX / camera.current.z,
            )
        setGuides(snapped.guides)
        canvas.preview(ids.flatMap((id) => moveOps(base, id, dx + snapped.dx, dy + snapped.dy)))
        return
      }
      case 'resize': {
        const page = base.pages.find((p) => p.id === held.ids![0])
        if (!page) return
        const west = held.corner === 'nw' || held.corner === 'sw'
        const north = held.corner === 'nw' || held.corner === 'ne'
        let left = west ? page.x + dx : page.x
        let right = west ? page.x + page.width : page.x + page.width + dx
        let topEdge = north ? page.y + dy : page.y
        let bottom = north ? page.y + page.height : page.y + page.height + dy
        const others = base.pages.filter((p) => p.id !== page.id)
        const edge = { x: west ? left : right, y: north ? topEdge : bottom, width: 0, height: 0 }
        const snapped = event.metaKey
          ? { dx: 0, dy: 0, guides: [] }
          : snap(edge, others, SNAP_PX / camera.current.z)
        if (west) left += snapped.dx
        else right += snapped.dx
        if (north) topEdge += snapped.dy
        else bottom += snapped.dy
        const width = Math.round(Math.min(PAGE_MAX, Math.max(PAGE_MIN, right - left)))
        const height = Math.round(Math.min(PAGE_MAX, Math.max(PAGE_MIN, bottom - topEdge)))
        setGuides(snapped.guides)
        canvas.preview([
          { op: 'set', id: page.id, key: 'x', value: Math.round(west ? right - width : left) },
          {
            op: 'set',
            id: page.id,
            key: 'y',
            value: Math.round(north ? bottom - height : topEdge),
          },
          { op: 'set', id: page.id, key: 'width', value: width },
          { op: 'set', id: page.id, key: 'height', value: height },
        ])
        return
      }
    }
  }

  const onPointerUp = (event: React.PointerEvent): void => {
    const held = drag.current
    drag.current = null
    setPanning(false)
    setDragging(false)
    setGuides([])
    setMarquee(null)
    if (!held || !layout) return
    const { sx, sy } = screenPoint(event)
    const at = toCanvas(sx, sy)
    switch (held.kind) {
      case 'pen': {
        setStroke(null)
        const points = held.points!
        if (points.length >= 6) {
          newNote({
            kind: 'pen',
            points: points.map((v) => Math.round(v * 100) / 100),
            width: pen.width,
            marker: pen.marker,
            color: pen.color,
          })
        }
        return
      }
      case 'create': {
        setCreating(null)
        const box = held.moved
          ? {
              x: Math.min(at.x, held.cx),
              y: Math.min(at.y, held.cy),
              width: Math.abs(at.x - held.cx),
              height: Math.abs(at.y - held.cy),
            }
          : null
        if (tool === 'page') newPage(box ?? { x: held.cx, y: held.cy, ...NEW_PAGE })
        else if (tool === 'shape' && box) {
          const from =
            shape === 'line' || shape === 'arrow'
              ? (pages.find((p) => contains(p, held.cx, held.cy))?.id ?? null)
              : null
          const to =
            shape === 'line' || shape === 'arrow'
              ? (pages.find((p) => contains(p, at.x, at.y))?.id ?? null)
              : null
          const id = newNote({
            kind: shape,
            x1: held.cx,
            y1: held.cy,
            x2: at.x,
            y2: at.y,
            width: pen.width,
            color: pen.color,
            from: from === to ? null : from,
            to: from === to ? null : to,
          })
          setSelection([id])
        }
        return
      }
      case 'move':
      case 'resize':
        if (!held.moved && held.pick) {
          setSelection([])
          editorFrames.current.get(held.pick.page)?.pick(held.pick.x, held.pick.y, held.pick.at)
          return
        }
        if (held.moved && canvas.base) {
          // The preview under way becomes the change, as one step of undo.
          const shown = canvas.doc
          canvas.preview(null)
          if (shown && base) {
            const ops: CanvasOp[] = []
            for (const id of held.ids!) {
              const before = base.pages.find((p) => p.id === id)
              const after = shown.pages.find((p) => p.id === id)
              if (before && after) {
                for (const key of ['x', 'y', 'width', 'height'] as const) {
                  if (before[key] !== after[key])
                    ops.push({ op: 'set', id, key, value: after[key] })
                }
                continue
              }
              const note = shown.notes.find((n) => n.id === id)
              const was = base.notes.find((n) => n.id === id)
              if (note && was) {
                for (const key of ['x', 'y', 'points', 'x1', 'y1', 'x2', 'y2'] as const) {
                  const a = (note as unknown as Record<string, unknown>)[key]
                  const b = (was as unknown as Record<string, unknown>)[key]
                  if (a !== undefined && JSON.stringify(a) !== JSON.stringify(b))
                    ops.push({ op: 'set', id, key, value: a })
                }
              }
            }
            apply(ops)
          }
        }
        return
      default:
    }
  }

  const onDoubleClick = (event: React.MouseEvent): void => {
    if (!layout || readOnly || tool === 'comment') return
    const { sx, sy } = screenPoint(event)
    const at = toCanvas(sx, sy)
    const id = hit(at.x, at.y)
    const note = layout.notes.find((n) => n.id === id)
    if (note && (note.kind === 'text' || note.kind === 'sticky')) {
      setSelection([note.id])
      setTextEdit(note.id)
      return
    }
    const page = pages.find((p) => p.id === id)
    if (page && editor) {
      setSelection([page.id])
      setInside(page.id)
    }
  }

  const name = (p: CanvasPage) => p.name
  const empty = layout !== null && layout.pages.length === 0 && layout.notes.length === 0
  const selectedBox = layout
    ? union(shownSelection.map((id) => boxOf(layout, id)).filter((b): b is Box => b !== null))
    : null
  const singlePage =
    layout && shownSelection.length === 1
      ? (layout.pages.find((p) => p.id === shownSelection[0]) ?? null)
      : null
  const focusedPage = focused ? pages.find((p) => p.id === focused) : undefined
  const editingNote = layout?.notes.find((n) => n.id === textEdit)
  const writingPages = new Set(
    agents
      .filter((a) => a.doing && a.doing !== 'read')
      .map((a) => agentPages.get(a.sessionId)?.id)
      .filter(Boolean) as string[],
  )
  const drawing = new Map<string, CanvasAgent>()
  for (const a of agents) {
    const p = agentPages.get(a.sessionId)
    if (a.doing === 'draw' && p) drawing.set(p.id, a)
  }

  // Pages added or resized since the camera last moved.
  useLayoutEffect(() => fitLabels(layers.current[1], camera.current.z))

  const firstLayer = useCallback((el: HTMLDivElement | null) => {
    if (el) layers.current[0] = el
  }, [])
  const secondLayer = useCallback((el: HTMLDivElement | null) => {
    if (el) layers.current[1] = el
  }, [])

  return (
    <div className="k-ce" data-narrow={wide ? undefined : ''}>
      <AgentCursorStyles />
      <div
        ref={stage}
        tabIndex={0}
        role="region"
        aria-roledescription={t('canvas.role')}
        aria-label={title}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => {
          if (event.key === ' ') setSpaceDown(false)
        }}
        className="k-ce__stage"
      >
        {/* The pages and notes; they take no pointer, but their scripts keep running. */}
        <div ref={firstLayer} inert className="k-ce__layer">
          {pages.map((p) => {
            const blank = !files.has(p.file)
            const agent = drawing.get(p.id)
            return (
              <div
                key={p.id}
                className="k-ce-page"
                data-working={writingPages.has(p.id) ? '' : undefined}
                style={{ left: p.x, top: p.y, width: p.width, height: p.height }}
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
                ) : live.has(p.id) ? (
                  <CanvasFrame
                    src={pageUrl(url, version, { group: 0, index: 1, file: p.file })}
                    title={name(p)}
                    width={p.width}
                    height={p.height}
                    editor={editor}
                    page={doc ? doc.pages.findIndex((q) => q.id === p.id) : -1}
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
                ) : (
                  <div className="k-ce-page__idle">{name(p)}</div>
                )}
              </div>
            )
          })}
          {layout?.notes.map((n) => (
            <NoteView
              key={n.id}
              note={n}
              pages={pages}
              editing={textEdit === n.id}
              doneBy={n.kind === 'sticky' && n.by ? sessionName(n.by) : null}
            />
          ))}
          {stroke && (
            <svg className="k-ce-note" style={{ left: 0, top: 0 }} width={1} height={1} aria-hidden>
              <path
                d={strokePath(stroke, pen.width, pen.marker)}
                fill={NOTE_COLOR_VAR[pen.color]}
                opacity={pen.marker ? 0.35 : 1}
              />
            </svg>
          )}
        </div>
        <div
          aria-hidden
          className={cn(
            'k-ce__overlay',
            hand
              ? panning
                ? 'cursor-grabbing'
                : 'cursor-grab'
              : tool === 'move'
                ? 'cursor-default'
                : 'cursor-crosshair',
          )}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            drag.current = null
            setPanning(false)
            setDragging(false)
            canvas.preview(null)
            setGuides([])
            setMarquee(null)
            setCreating(null)
            setStroke(null)
          }}
          onDoubleClick={onDoubleClick}
        />
        {/* What draws over the canvas: labels and their actions, the selection, guides, agents. */}
        <div ref={secondLayer} className="k-ce__layer k-ce__ui">
          {pages.map((p) => (
            <div
              key={p.id}
              className="k-ce-label"
              data-width={p.width}
              data-selected={shownSelection.includes(p.id) ? '' : undefined}
              style={{ left: p.x, top: `calc(${p.y}px - 24px * var(--unscale))`, width: p.width }}
            >
              <span className="k-ce-label__name">{name(p)}</span>
              {actions && (
                <span className="k-ce-label__acts">
                  {!readOnly && frameParams.has(p.id) && (
                    <LabelAct
                      label={t('board.page.tweak')}
                      icon={SlidersHorizontalIcon}
                      onClick={() => {
                        setSelection([p.id])
                        setSide('tweaks')
                      }}
                    />
                  )}
                  {!readOnly && (
                    <LabelAct
                      label={t('board.page.ask')}
                      icon={AiMagicIcon}
                      onClick={() => actions.handOff([p.id])}
                    />
                  )}
                  {actions.download && (
                    <LabelAct
                      label={t('canvas.downloadPng')}
                      icon={Download04Icon}
                      onClick={() => actions.download?.(p)}
                    />
                  )}
                  <LabelAct
                    label={t('canvas.presentFrom')}
                    icon={PlayIcon}
                    onClick={() => actions.present(p)}
                  />
                  <LabelAct
                    label={t('canvas.focusPage')}
                    icon={CenterFocusIcon}
                    onClick={() => setFocused(p.id)}
                  />
                </span>
              )}
            </div>
          ))}
          {shownSelection.map((id) => {
            const box = layout && boxOf(layout, id)
            return box ? (
              <div
                key={id}
                className="k-ce-sel"
                style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
              />
            ) : null
          })}
          {singlePage && !readOnly && !singlePage.locked && (
            <>
              {(
                [
                  [singlePage.x, singlePage.y],
                  [singlePage.x + singlePage.width, singlePage.y],
                  [singlePage.x, singlePage.y + singlePage.height],
                  [singlePage.x + singlePage.width, singlePage.y + singlePage.height],
                ] as const
              ).map(([x, y], i) => (
                <span key={i} className="k-ce-handle" style={{ left: x, top: y }} />
              ))}
              <span
                className="k-ce-size"
                style={{
                  left: singlePage.x + singlePage.width / 2,
                  top: `calc(${singlePage.y + singlePage.height}px + 10px * var(--unscale))`,
                }}
              >
                {`${singlePage.width} × ${singlePage.height}`}
              </span>
            </>
          )}
          {guides.map((g, i) => (
            <span
              key={i}
              className="k-ce-guide"
              style={
                g.axis === 'x'
                  ? { left: g.at, top: g.from, width: 'var(--unscale)', height: g.to - g.from }
                  : { left: g.from, top: g.at, height: 'var(--unscale)', width: g.to - g.from }
              }
            />
          ))}
          {marquee && (
            <div
              className="k-ce-marquee"
              style={{
                left: marquee.x,
                top: marquee.y,
                width: marquee.width,
                height: marquee.height,
              }}
            />
          )}
          {creating && (
            <div
              className="k-ce-marquee"
              style={{
                left: creating.x,
                top: creating.y,
                width: creating.width,
                height: creating.height,
              }}
            />
          )}
          {editingNote && (editingNote.kind === 'text' || editingNote.kind === 'sticky') && (
            <NoteEditor
              key={editingNote.id}
              note={editingNote}
              onDone={(text) => {
                setTextEdit(null)
                if (text !== editingNote.text) {
                  if (editingNote.kind === 'text' && text.trim() === '')
                    apply([{ op: 'remove', id: editingNote.id }])
                  else apply([{ op: 'set', id: editingNote.id, key: 'text', value: text }])
                }
                stage.current?.focus({ preventScroll: true })
              }}
            />
          )}
          {selectedBox && actions && !readOnly && !dragging && !textEdit && (
            <HandOffBar
              box={selectedBox}
              count={shownSelection.length}
              onHandOff={() => actions.handOff(shownSelection)}
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
      </div>

      {!readOnly && (
        <CanvasToolbar
          doc={doc}
          canvasKey={canvasKey}
          onCanvas={setActiveCanvas}
          apply={apply}
          tool={tool}
          onTool={(next) => {
            setTool(next)
            if (next !== 'move') setInside(null)
          }}
          shape={shape}
          onShape={setShape}
          pen={pen}
          onPen={setPen}
          layersOpen={layersOpen}
          onLayers={() => setLayersOpen(!layersOpen)}
          comment={Boolean(editor)}
        />
      )}
      {layersOpen && layout && doc && (
        <CanvasLayers
          layout={layout}
          selection={shownSelection}
          onSelect={(ids, reveal) => {
            setSelection(ids)
            const box =
              reveal &&
              union(ids.map((id) => boxOf(layout, id)).filter((b): b is Box => b !== null))
            if (box) moveTo(revealBox(camera.current, box, view.current))
          }}
          apply={apply}
          onClose={() => setLayersOpen(false)}
        />
      )}
      {layout && shownSide && (
        <aside className="k-ce-side" aria-label={t('board.side.tabs')}>
          <div className="k-ce-side__head">
            <div role="tablist" className="k-ce-side__tabs">
              {(['props', 'tweaks'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={shownSide === tab}
                  className="k-ce-side__tab"
                  onClick={() => setSide(tab)}
                >
                  {t(`board.side.${tab}`)}
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-label={t('board.side.close')}
              className="k-ce-tool"
              onClick={() => {
                setSide(null)
                setSelection([])
              }}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.9} />
            </button>
          </div>
          <div className="k-ce-side__body">
            {shownSide === 'tweaks' ? (
              <CanvasTweaks
                layout={layout}
                params={frameParams}
                selection={shownSelection}
                onSelect={(id) => {
                  setSelection([id])
                  const page = layout.pages.find((p) => p.id === id)
                  if (page) moveTo(revealBox(camera.current, page, view.current))
                }}
                editorFrame={(page) => editorFrames.current.get(page) ?? null}
                artifactId={artifactId}
                version={version}
              />
            ) : shownSelection.length > 0 && !inside ? (
              <CanvasProps
                layout={layout}
                selection={shownSelection}
                apply={apply}
                remove={remove}
                duplicate={duplicate}
              />
            ) : (
              <div className="k-ce-side__empty">
                <p>{t('board.side.none')}</p>
              </div>
            )}
          </div>
        </aside>
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
        <div className="k-ce-empty">
          <h3>{t('board.empty.title')}</h3>
          <p>{t('board.empty.body')}</p>
          <div className="k-ce-empty__acts">
            <button type="button" className="k-ce-tool k-ce-float" onClick={() => setTool('page')}>
              <HugeiconsIcon icon={GridIcon} size={16} strokeWidth={1.9} />
              {t('board.empty.pageTool')}
            </button>
          </div>
        </div>
      )}
      <div
        className="k-ce-zoom k-ce-float"
        role="toolbar"
        aria-label={t('board.top.toolbar')}
        style={{ right: (shownSide ? SIDE_ROOM : 0) + 12 }}
      >
        {!readOnly && (
          <>
            <ZoomButton
              label={t('board.top.tweaks')}
              icon={SlidersHorizontalIcon}
              pressed={shownSide === 'tweaks'}
              onClick={() => setSide(shownSide === 'tweaks' ? null : 'tweaks')}
            />
            <span className="k-ce-tools__sep" />
          </>
        )}
        <ZoomButton
          label={t('canvas.zoomOut')}
          icon={MinusSignIcon}
          onClick={() => zoomAround(stepZoom(camera.current.z, -1))}
        />
        <ZoomPct controls={controls} onFit={() => fitAll(true)} />
        <ZoomButton
          label={t('canvas.zoomIn')}
          icon={PlusSignIcon}
          onClick={() => zoomAround(stepZoom(camera.current.z, 1))}
        />
      </div>
      {focusedPage && (
        <FocusedPage
          key={focusedPage.id}
          src={pageUrl(url, version, { group: 0, index: 1, file: focusedPage.file })}
          page={{ ...focusedPage, number: 0, group: 0, index: 1 }}
          name={focusedPage.name}
          top={top}
          reloads={reloads}
          editor={editor}
          index={doc ? doc.pages.findIndex((q) => q.id === focusedPage.id) : 0}
          onMove={(step) => {
            const next = pages[pages.indexOf(focusedPage) + step]
            if (next) setFocused(next.id)
          }}
          onLeave={() => {
            setFocused(null)
            requestAnimationFrame(() => stage.current?.focus({ preventScroll: true }))
          }}
        />
      )}
    </div>
  )
})

function revealBox(camera: Camera, box: Box, view: Size): Camera {
  return reveal(camera, box, view)
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

function LabelAct({
  label,
  icon,
  onClick,
}: {
  label: string
  icon: IconSvgElement
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button type="button" aria-label={label} className="k-ce-label__act" onClick={onClick} />
        }
      >
        <HugeiconsIcon icon={icon} strokeWidth={1.9} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function ZoomButton({
  label,
  icon,
  pressed,
  onClick,
}: {
  label: string
  icon: IconSvgElement
  /** A panel's switch, shown on while the panel is open. */
  pressed?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={pressed}
            className={cn('k-ce-tool', pressed !== undefined && 'k-ce-tool--toggle')}
            onClick={onClick}
          />
        }
      >
        <HugeiconsIcon icon={icon} size={14} strokeWidth={1.9} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function ZoomPct({ controls, onFit }: { controls: CanvasControls; onFit: () => void }) {
  const { t } = useTranslation('artifacts')
  const { zoom } = useCanvasState(controls)
  return (
    <button
      type="button"
      className="k-ce-zoom__pct"
      aria-label={t('canvas.fitAll')}
      onClick={onFit}
    >
      {t('canvas.zoom', { percent: Math.round(zoom * 100) })}
    </button>
  )
}

/** Writes a text or sticky note's text in place. */
function NoteEditor({
  note,
  onDone,
}: {
  note: Extract<CanvasNote, { kind: 'text' | 'sticky' }>
  onDone: (text: string) => void
}) {
  const [text, setText] = useState(note.text)
  const sticky = note.kind === 'sticky'
  return (
    <textarea
      autoFocus
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => onDone(text)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
          event.preventDefault()
          onDone(text)
        }
      }}
      className={cn('k-ce-edit', sticky ? 'k-ce-sticky' : 'k-ce-text')}
      style={
        sticky
          ? { left: note.x, top: note.y, width: note.width, minHeight: noteBox(note).height }
          : {
              left: note.x,
              top: note.y,
              fontSize: note.size,
              color: NOTE_COLOR_VAR[note.color],
              width: Math.max(120, noteBox(note).width + 40),
            }
      }
    />
  )
}

/** Over a selection: hand it to the agent. Drawn in the canvas's layer, at screen size. */
function HandOffBar({ box, count, onHandOff }: { box: Box; count: number; onHandOff: () => void }) {
  const { t } = useTranslation('artifacts')
  return (
    <div
      className="k-ce-selbar k-ce-float"
      style={{
        // Under the selection, clear of its size, since page labels take the room above it.
        left: box.x + box.width / 2,
        top: box.y + box.height,
        transform: 'scale(var(--unscale)) translate(-50%, 40px)',
        transformOrigin: '0 0',
        pointerEvents: 'auto',
      }}
    >
      <span className="px-2 text-xs text-tertiary">{t('board.selection.count', { count })}</span>
      <button type="button" className="k-ce-tool" aria-pressed onClick={onHandOff}>
        <HugeiconsIcon icon={AiMagicIcon} size={14} strokeWidth={1.9} />
        <span className="ml-1 text-ui">{t('board.selection.handOff')}</span>
      </button>
    </div>
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
