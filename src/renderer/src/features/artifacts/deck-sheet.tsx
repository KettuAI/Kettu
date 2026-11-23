import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Comment01Icon,
  GridViewIcon,
  MoreHorizontalIcon,
  Note01Icon,
  PlayIcon,
  SidebarLeftIcon,
  Undo02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { CommentAnchor, CommentThread } from '@shared/artifact-comments'
import { ARTIFACT_ENTRY } from '@shared/artifact-files'
import {
  DECK_NOTES_CHARS,
  DECK_TRACKED,
  type DeckBox,
  type DeckReport,
  type DeckState,
  type DeckTrack,
} from '@shared/artifact-runtime/deck-sheet'
import { RUNTIME_VERSION } from '@shared/artifact-runtime/page-messages'
import { ARTIFACT_FRAME_SANDBOX, WEB_ARTIFACT_FRAME_SANDBOX } from '@shared/artifacts'
import { Dropdown, Icon, type MenuItem } from '@renderer/components/affect/app-shell'
import { Kbd } from '@renderer/components/ui/kbd'
import { isWeb } from '@renderer/lib/platform'
import {
  setDeckNotes,
  setDeckSlide,
  useDeckNotes,
  useDeckSlide,
} from '@renderer/stores/artifact-deck'
import {
  dropUnsaved,
  keepUnsaved,
  useArtifactUnsavedStore,
} from '@renderer/stores/artifact-unsaved'
import {
  setViewerState,
  useViewerState,
  type FitMode,
  type ViewerMode,
} from '@renderer/stores/artifact-viewer'
import { prefersReducedMotion } from '@renderer/stores/settings'
import { threadNumbers } from './comment-threads'
import { CompareDock, type CompareSwitch } from './compare-dock'
import type { PlaceAsk, SheetWalk } from './change-walk'
import { sheetSave } from './sheet-save'
import { useUnsaved } from './unsaved'
import { SaveChip } from './tool-parts'
import { FitMenu } from './fit-menu'
import { FrameLink } from './frame-link'
import { isEditable } from './keys'
import { Waiting } from './page-frame'
import type { SheetAgent } from './page-sheet'
import { SlidesCard, SlideThumb } from './slides-card'
import { pageUrl, type ShownVersion } from './use-artifact'
import { slideAnchor, slideName, type DeckOutline } from './use-deck'
import { DockButton, DockRule, ViewerSlot } from './viewer-shell'
import { useShell } from './viewer-shell-context'
import { WriterTag } from './viewer-states'
import './document-sheet.css'
import './deck-sheet.css'

/** Room around the slide: at its sides, above it, above it under a pill, and the dock's below. */
const SIDE = 24
const SIDE_NARROW = 12
const TOP = 24
const BAND = 56
const DOCK = 66
/** The slides before and after show this much beside the slide, this far from it. */
const PEEK = 88
const GHOST_GAP = 32
/** The notes strip under the slide, and the gap above it. */
const NOTES_H = 102
/** How long a slide landed on flashes: two pulses. */
const FLASH_MS = 1000
const NOTES_GAP = 12
/** How long the notes rest before what was typed goes to the deck. */
const NOTES_AFTER_MS = 900
const PIN = 26

/** What the deck does with comments, which the viewer's comment tools take over from here. */
export interface DeckComments {
  threads: CommentThread[] | null
  /** Pins show while comments are on screen: in Comment, or with the comments card open. */
  shown: boolean
  /** The comment being written under an element, pinned to `anchor`, until it saves or `close`. */
  draft: (anchor: CommentAnchor, close: () => void) => ReactNode
  /** What opens under an element for one of its threads, numbered as its pin. */
  thread: (thread: CommentThread, number: number, close: () => void) => ReactNode
}

interface Draft {
  slide: number
  tag: string
  text: string
  box: DeckBox
}

type Save = Extract<DeckReport, { t: 'save' }>

/** Where the slide lies in the room and at what scale. */
interface Place {
  x: number
  y: number
  z: number
}

function slidePlace(
  deck: DeckOutline,
  room: { width: number; height: number },
  inset: { left: number; right: number },
  fit: FitMode,
  narrow: boolean,
  top: number,
  notes: boolean,
  peek: boolean,
): Place {
  const side = narrow ? SIDE_NARROW : SIDE
  const x0 = inset.left + side
  const w = Math.max(80, room.width - inset.left - inset.right - 2 * side)
  const h = Math.max(60, room.height - top - DOCK - (notes ? NOTES_H + NOTES_GAP : 0))
  let z: number
  if (fit === 'screen') z = Math.min(w / deck.width, h / deck.height)
  else if (fit === 'width') z = w / deck.width
  else if (fit === 'actual') z = 1
  else {
    // With both cards closed the slides beside it show a slice of themselves.
    const across = peek ? Math.min(w, room.width - 2 * (GHOST_GAP + PEEK)) : w
    z = Math.min(1, across / deck.width, h / deck.height)
  }
  const shownH = deck.height * z
  return {
    x: x0 + (w - deck.width * z) / 2,
    y: top + Math.max(0, (h - shownH) / 2),
    z,
  }
}

/**
 * A slides artifact in the viewer: one slide at reading size on the shell's ground, the slides
 * before and after it dimmed at its sides, its speaker notes under it, or every slide in a grid.
 * The slide itself is the deck's own viewer in a frame the window sizes and drives; it reports
 * where the elements pinned lie, an element picked and how a typed change saves, and nothing it
 * reports is more than data.
 */
export function DeckSheet({
  id,
  url,
  shown,
  title,
  reloads,
  since,
  band,
  latest,
  mode: modeAsked,
  where,
  deck,
  walk,
  comments,
  agent,
  onAsk,
  onPresent,
  asked,
  onAsked,
  focusThread,
  compare,
  writing = null,
}: {
  id: string
  url: string
  shown: ShownVersion
  title: string
  reloads: number
  since: number
  /** Whether a pill of the viewer's own sits above the slide. */
  band: boolean
  latest: boolean
  mode: ViewerMode
  where: 'main' | 'panel'
  deck: DeckOutline | null
  /** What changed, which the deck marks and the viewer's pill walks. */
  walk: SheetWalk | null
  comments: DeckComments
  agent: SheetAgent | null
  /** Asks the agent about a slide, or an element on it. */
  onAsk: ((anchor: CommentAnchor) => void) | null
  onPresent: (slide: number) => void
  /** A slide asked for by a link, a card or the pill, until it is shown. */
  asked: (Pick<PlaceAsk, 'seq' | 'slide'> & { flash?: boolean }) | null
  onAsked: (seq: number) => void
  /** A thread chosen in the comments card, to go to and open. */
  focusThread: { thread: string; seq: number } | null
  /** Before and after, where an agent's version changed the slide shown. */
  compare: CompareSwitch | null
  /** An agent writing it: the slides it holds, or null for every slide, and its name and mark. */
  writing?: { slides: readonly number[] | null; name: string; mark: ReactNode } | null
}) {
  const { t } = useTranslation('artifacts')
  const { tier, insets, leftCard } = useShell()
  const narrow = tier === 'narrow'
  const root = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState({ width: 0, height: 0 })
  const fit = useViewerState(id, (s) => s.fit)
  const notesOn = useDeckNotes(id)
  const kept = useDeckSlide(id)
  const count = deck?.slides.length ?? 0
  const current = Math.min(Math.max(1, kept), Math.max(1, count))
  const slide = deck?.slides[current - 1] ?? null
  // The slide an agent is writing takes no edit of the user's until its turn ends; comments stay.
  const writesShown =
    !!writing && latest && (writing.slides === null || writing.slides.includes(current))
  const mode: ViewerMode = modeAsked === 'edit' && writesShown ? 'view' : modeAsked
  const version = shown.version
  const [grid, setGrid] = useState(false)
  const [picked, setPicked] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setRoom({
          width: Math.round(entry.contentRect.width),
          height: Math.round(entry.contentRect.height),
        })
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // What changed, marked on the slides that changed.
  const marking = !!walk && latest && version === walk.to && walk.changes.kind === 'slides'
  const changed = useMemo(
    () =>
      new Set(
        marking && walk.changes.kind === 'slides' ? walk.changes.slides.map((s) => s.number) : [],
      ),
    [marking, walk],
  )
  const marks = marking ? walk.marks : undefined
  const changedIn = walk?.to ?? version
  const [flash, setFlash] = useState<number | null>(null)
  useEffect(() => {
    if (flash === null) return
    const timer = setTimeout(() => setFlash(null), FLASH_MS)
    return () => clearTimeout(timer)
  }, [flash])

  // The deck's frame, loaded once for the artifact; versions come in through the viewer.
  const origin = url.slice(0, -1)
  const [src] = useState(() => pageUrl(url, shown.version))
  const frame = useRef<HTMLIFrameElement | null>(null)
  const link = useMemo(() => new FrameLink(origin, () => {}), [origin])
  const [loaded, setLoaded] = useState(false)
  const [linked, setLinked] = useState(false)
  const [mountedAt] = useState(reloads)
  useEffect(() => {
    if (reloads === mountedAt || !frame.current) return
    setLoaded(false)
    frame.current.src = src
  }, [reloads, mountedAt, src])

  // Pins: the open threads on the slide shown, numbered as their cards are.
  const numbered = useMemo(() => {
    const all = comments.threads ?? []
    const numbers = threadNumbers(all)
    return all
      .filter((thread) => thread.resolvedAt === null)
      .map((thread) => ({ thread, n: numbers.get(thread.id) ?? 0 }))
  }, [comments.threads])
  const bySlide = useMemo(() => {
    const out = new Map<number, number>()
    for (const { thread } of numbered) {
      const at = thread.anchor.page?.number
      if (thread.anchor.path === ARTIFACT_ENTRY && at) out.set(at, (out.get(at) ?? 0) + 1)
    }
    return out
  }, [numbered])
  const pins = useMemo(
    () =>
      comments.shown && latest && !grid
        ? numbered.filter(
            ({ thread: { anchor } }) =>
              anchor.path === ARTIFACT_ENTRY && anchor.page?.number === current,
          )
        : [],
    [comments.shown, latest, grid, numbered, current],
  )
  const [draft, setDraft] = useState<Draft | null>(null)
  const [openThread, setOpenThread] = useState<string | null>(null)
  const open = pins.find((p) => p.thread.id === openThread) ?? null

  const track = useMemo<DeckTrack[]>(() => {
    const out: DeckTrack[] = []
    pins.forEach(({ thread: { anchor } }, i) => {
      if (anchor.tag) out.push({ key: `p${i}`, tag: anchor.tag, text: anchor.text })
    })
    if (draft && draft.slide === current)
      out.push({ key: 'draft', tag: draft.tag, text: draft.text })
    return out.slice(0, DECK_TRACKED)
  }, [pins, draft, current])
  const focusKey = draft ? 'draft' : open ? `p${pins.indexOf(open)}` : null

  // What the viewer reported last.
  const [layout, setLayout] = useState<Extract<DeckReport, { t: 'layout' }> | null>(null)
  const [save, setSave] = useState<Save | null>(null)
  useUnsaved(id, !!save && ['failed', 'conflict', 'refused'].includes(save.state))
  // Texts typed that did not save before the viewer was left, which the frame shows again.
  const keptTexts = useArtifactUnsavedStore((s) => {
    const change = s.byId[id]?.slides
    return change?.kind === 'slides' ? change.kept : null
  })

  useEffect(() => {
    if (!deck) return
    const state: DeckState = {
      slide: current,
      mode: latest ? mode : 'view',
      version,
      track,
      focus: focusKey,
      ...(keptTexts && { kept: [...keptTexts] }),
    }
    link.post({ v: RUNTIME_VERSION, kind: 'select-deck', channel: link.channel, state })
  }, [link, deck, current, latest, mode, version, track, focusKey, keptTexts])

  const onReport = useRef<(report: DeckReport) => void>(() => {})
  useEffect(() => {
    onReport.current = (report) => {
      setLinked(true)
      switch (report.t) {
        case 'layout':
          setLayout(report)
          return
        case 'pick':
          setOpenThread(null)
          setDraft({ slide: report.slide, tag: report.tag, text: report.text, box: report.box })
          return
        case 'save':
          setSave(report)
          // What did not save is kept beyond this viewer, until it saves or is discarded.
          if (report.kept?.length) keepUnsaved(id, { kind: 'slides', kept: report.kept })
          else if (report.kept || report.state === 'saved') dropUnsaved(id, 'slides')
      }
    }
  })

  // Turning: the slide slides in from its side, as presenting does.
  const slideBox = useRef<HTMLDivElement>(null)
  const go = useCallback(
    (next: number) => {
      if (!deck) return
      const to = Math.min(Math.max(1, next), deck.slides.length)
      if (to === current) return
      setDeckSlide(id, to)
      setDraft(null)
      setOpenThread(null)
      const el = slideBox.current
      if (el && !prefersReducedMotion() && !grid) {
        const dir = to > current ? 1 : -1
        el.animate(
          [
            { opacity: 0, transform: `translateX(${dir * 32}px)`, filter: 'blur(8px)' },
            { opacity: 1, transform: 'none', filter: 'blur(0px)' },
          ],
          { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        )
      }
    },
    [deck, current, id, grid],
  )
  const openSlide = useCallback(
    (n: number) => {
      setGrid(false)
      setPicked(null)
      go(n)
    },
    [go],
  )
  const toggleGrid = useCallback(() => {
    setDraft(null)
    setOpenThread(null)
    setGrid((on) => {
      if (!on) setPicked(current)
      return !on
    })
  }, [current])

  // A slide asked for by a card, a link or the pill opens once the deck is read.
  const [askedSeen, setAskedSeen] = useState(0)
  if (asked?.slide && deck && askedSeen !== asked.seq) {
    setAskedSeen(asked.seq)
    setGrid(false)
    if (asked.flash) setFlash(asked.seq)
  }
  const askedSeq = useRef(0)
  useEffect(() => {
    if (!asked?.slide || !deck || askedSeq.current === asked.seq) return
    askedSeq.current = asked.seq
    setDeckSlide(id, Math.min(asked.slide, deck.slides.length))
    onAsked(asked.seq)
  }, [asked, deck, id, onAsked])

  // A thread chosen in the comments card: its slide, with the thread open.
  const [focusSeen, setFocusSeen] = useState(focusThread?.seq ?? 0)
  if (focusThread && focusSeen !== focusThread.seq) {
    setFocusSeen(focusThread.seq)
    const thread = comments.threads?.find((th) => th.id === focusThread.thread)
    const at = thread?.anchor.page?.number
    if (at) {
      setGrid(false)
      setDraft(null)
      setDeckSlide(id, at)
      setOpenThread(thread.id)
    }
  }

  // Leaving Comment puts the comment being written away; a change saved leaves Edit quietly.
  const [modeWas, setModeWas] = useState(mode)
  if (modeWas !== mode) {
    setModeWas(mode)
    if (mode !== 'comment') setDraft(null)
    if (mode !== 'edit' && save && ['saved', 'editing', 'saving'].includes(save.state))
      setSave(null)
  }

  // Keys: the arrows turn, G shows the grid, and in it the arrows pick and Enter opens. Esc lets go
  // of one layer at a time before the viewer's own.
  const carded = insets.left > 0 || insets.right > 0
  const cols = narrow ? 2 : tier === 'middle' || carded ? 3 : 4
  const keys = useRef<(key: string, shift: boolean) => boolean>(() => false)
  useEffect(() => {
    keys.current = (key, shift) => {
      if (!deck) return false
      if (key === 'Escape') {
        if (draft) setDraft(null)
        else if (openThread) setOpenThread(null)
        else if (grid) setGrid(false)
        else return false
        return true
      }
      if (key === 'g' || key === 'G') {
        toggleGrid()
        return true
      }
      if (grid) {
        const at = picked ?? current
        const move =
          key === 'ArrowRight'
            ? 1
            : key === 'ArrowLeft'
              ? -1
              : key === 'ArrowDown'
                ? cols
                : key === 'ArrowUp'
                  ? -cols
                  : 0
        if (move) {
          setPicked(Math.min(Math.max(1, at + move), count))
          return true
        }
        if (key === 'Enter') {
          openSlide(at)
          return true
        }
        return false
      }
      const back =
        key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp' || (key === ' ' && shift)
      const forth = key === 'ArrowRight' || key === 'ArrowDown' || key === 'PageDown' || key === ' '
      if (back) go(current - 1)
      else if (forth) go(current + 1)
      else if (key === 'Home') go(1)
      else if (key === 'End') go(count)
      else return false
      return true
    }
  })
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (isEditable(event.target)) return
      const target = event.target as Element | null
      if (
        target?.closest?.('[role="menu"], [role="dialog"], [role="radiogroup"], [role="tablist"]')
      )
        return
      const shell = root.current?.closest('.avs')
      const active = document.activeElement
      const mine =
        !!shell &&
        (shell.contains(active) || (where === 'main' && (!active || active === document.body)))
      if (!mine) return
      // Buttons and rows take Enter and Space themselves.
      if (
        (event.key === 'Enter' || event.key === ' ') &&
        target?.closest?.('button, [role="option"]')
      )
        return
      if (keys.current(event.key, event.shiftKey)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [where])

  useEffect(() => {
    link.open()
    link.decks((report) => onReport.current(report))
    link.keys((key) => void keys.current(key, false))
    return () => link.dispose()
  }, [link])

  // The notes typed under the slide go to the deck after a rest; what is typed stays meanwhile.
  const notesEditable = mode === 'edit' && latest
  const [notesDraft, setNotesDraft] = useState<{ slide: number; text: string } | null>(() => {
    // Notes that did not save before the viewer was left show as typed.
    const notes = keptTexts?.find(({ path }) => path.length === 3 && path[2] === 'notes')
    return notes && typeof notes.path[1] === 'number'
      ? { slide: notes.path[1] + 1, text: notes.text }
      : null
  })
  const notesTimer = useRef(0)
  const sendNotes = useCallback(
    (at: number, text: string) => {
      clearTimeout(notesTimer.current)
      link.post({
        v: RUNTIME_VERSION,
        kind: 'select-deck-notes',
        slide: at,
        text: text.slice(0, DECK_NOTES_CHARS),
      })
    },
    [link],
  )
  useEffect(() => () => clearTimeout(notesTimer.current), [])
  const notesText =
    notesDraft && notesDraft.slide === current ? notesDraft.text : (slide?.notes ?? '')

  const ready = room.width > 0 && !!deck && !!slide
  const peek =
    !narrow && fit === 'auto' && insets.left === 0 && insets.right === 0 && !leftCard?.shown
  const top = band ? BAND : TOP
  const place = ready
    ? slidePlace(deck, room, insets, fit, narrow, top, notesOn, peek)
    : { x: 0, y: 0, z: 1 }
  const shownW = (deck?.width ?? 0) * place.z
  const shownH = (deck?.height ?? 0) * place.z
  // A slide larger than the room, at its width or its own size, scrolls.
  const contentW = Math.max(room.width, place.x + shownW + SIDE)
  const contentH = Math.max(
    room.height,
    place.y + shownH + (notesOn ? NOTES_GAP + NOTES_H : 0) + DOCK,
  )

  const anchorOf = (n: number, element: { tag: string; text: string } | null) =>
    slideAnchor(version, n, deck?.slides[n - 1]?.title ?? null, element)

  const placeOf = (i: number) => {
    const key = `p${i}`
    return layout && layout.slide === current
      ? (layout.places.find((p) => p.key === key) ?? null)
      : null
  }

  return (
    <>
      <div
        ref={root}
        className="adk-room"
        // A click on the ground takes focus, so the keys reach a deck beside a session too.
        tabIndex={-1}
        data-grid={grid || undefined}
        onPointerDown={() => {
          if (narrow && leftCard?.shown) leftCard.setShown(false)
        }}
      >
        <div className="adk-scroll" data-hidden={grid || undefined}>
          <div className="adk-content" style={{ width: contentW, height: contentH }}>
            {ready && peek && (
              <Neighbours artifactId={id} deck={deck} current={current} place={place} onGo={go} />
            )}
            {writesShown && writing && (
              <WriterTag
                className="adk-writer"
                mark={writing.mark}
                name={t('viewer.writing.tag', { agent: writing.name })}
                style={{ left: place.x, top: place.y - 28 }}
              />
            )}
            <div
              ref={slideBox}
              className="adk-slide"
              data-flash={flash !== null || undefined}
              data-writing={writesShown || undefined}
              style={{ left: place.x, top: place.y, width: shownW, height: shownH }}
            >
              <iframe
                ref={(el) => {
                  frame.current = el
                  link.attach(el)
                }}
                src={src}
                title={slide ? slideName(slide) : title}
                sandbox={isWeb ? WEB_ARTIFACT_FRAME_SANDBOX : ARTIFACT_FRAME_SANDBOX}
                allow=""
                referrerPolicy="no-referrer"
                onLoad={() => {
                  setLoaded(true)
                  link.loaded()
                }}
                className="adk-frame"
                data-loaded={(loaded && ready) || undefined}
              />
              {compare?.showingBefore && (
                <span className="k-vt-before__tag" style={{ zIndex: 1 }}>
                  {t('compare.before', { version: compare.from })}
                </span>
              )}
              {pins.map(({ thread, n }, i) => {
                // An element not found on the slide, or a comment on the whole slide, pins to its
                // top right corner, one under another.
                const found = placeOf(i)
                const lost = pins.slice(0, i).filter((_, j) => !placeOf(j)).length
                const left = found
                  ? Math.min(shownW - PIN / 2, (found.box.x + found.box.width) * place.z) - PIN / 2
                  : shownW - PIN - 8
                const topAt = found
                  ? Math.max(-PIN / 2, found.box.y * place.z - PIN / 2)
                  : 8 + lost * (PIN + 4)
                const active = openThread === thread.id
                return (
                  <button
                    key={thread.id}
                    type="button"
                    className="ads-pin"
                    data-active={active || undefined}
                    data-lost={(!found && !!thread.anchor.tag) || undefined}
                    style={{ left, top: topAt }}
                    aria-label={t('doc.pin', { number: n })}
                    aria-expanded={active}
                    onClick={() => {
                      setDraft(null)
                      setOpenThread(active ? null : thread.id)
                    }}
                  >
                    {n}
                  </button>
                )
              })}
              {open &&
                (() => {
                  const found = placeOf(pins.indexOf(open))
                  const y = found ? (found.box.y + found.box.height) * place.z + 8 : 40
                  const x = found ? found.box.x * place.z : shownW - 348
                  return (
                    <div
                      className="ads-pop"
                      style={{ top: y, left: Math.max(8, Math.min(x, shownW - 328)) }}
                    >
                      {comments.thread(open.thread, open.n, () => setOpenThread(null))}
                    </div>
                  )
                })()}
            </div>
            {ready && notesOn && (
              <Notes
                slide={current}
                text={notesText}
                editable={notesEditable}
                style={{
                  left: place.x,
                  top: place.y + shownH + NOTES_GAP,
                  width: shownW,
                  height: NOTES_H,
                }}
                onChange={(text) => {
                  setNotesDraft({ slide: current, text })
                  clearTimeout(notesTimer.current)
                  notesTimer.current = window.setTimeout(
                    () => sendNotes(current, text),
                    NOTES_AFTER_MS,
                  )
                }}
                onLeave={(text) => {
                  if (text !== (slide?.notes ?? '')) sendNotes(current, text)
                }}
              />
            )}
            {draft && draft.slide === current && (
              <div
                key={`${draft.slide}:${draft.tag}:${draft.text}`}
                className="ads-pop"
                style={{
                  left: Math.max(8, place.x + draft.box.x * place.z),
                  top: place.y + (draft.box.y + draft.box.height) * place.z + 8,
                }}
              >
                {comments.draft(anchorOf(draft.slide, draft), () => setDraft(null))}
              </div>
            )}
          </div>
        </div>
        {grid && deck && (
          <DeckGrid
            artifactId={id}
            deck={deck}
            current={current}
            picked={picked}
            cols={cols}
            insets={insets}
            changed={changed}
            changedIn={changedIn}
            marks={marks}
            comments={bySlide}
            agent={agent}
            onPick={setPicked}
            onOpen={openSlide}
            onPresent={onPresent}
            onAsk={onAsk ? (n) => onAsk(anchorOf(n, null)) : null}
          />
        )}
        {!(loaded && deck) && <Waiting since={since} id={id} look="card" />}
      </div>
      {deck && (
        <SlidesCard
          artifactId={id}
          deck={deck}
          current={current}
          changed={changed}
          changedIn={changedIn}
          marks={marks}
          comments={bySlide}
          onPick={openSlide}
          writing={latest ? writing?.slides : null}
        />
      )}
      {deck && (
        <DeckDock
          count={count}
          current={current}
          tag={changed.has(current) ? (marks?.get(`${current}`) ?? changedIn) : null}
          grid={grid}
          fit={fit}
          notes={notesOn}
          slides={
            leftCard
              ? { shown: leftCard.shown, toggle: () => leftCard.setShown(!leftCard.shown) }
              : null
          }
          agent={agent}
          save={
            // A save a later version has passed says nothing about the deck shown.
            save?.state === 'saved' && save.version !== null && save.version < version
              ? null
              : mode === 'edit' || (save && save.state !== 'saved')
                ? save
                : null
          }
          onStep={(d) => go(current + d)}
          onFit={(next) => setViewerState(id, { fit: next })}
          onNotes={() => setDeckNotes(id, !notesOn)}
          onGrid={toggleGrid}
          onAsk={onAsk ? () => onAsk(anchorOf(current, null)) : null}
          onRetry={() => link.post({ v: RUNTIME_VERSION, kind: 'select-deck-do', do: 'retry' })}
          onUndo={() => link.post({ v: RUNTIME_VERSION, kind: 'select-deck-do', do: 'undo' })}
          linked={linked}
          compare={grid ? null : compare}
        />
      )}
    </>
  )
}

/** The slides before and after the one shown: a slice of each beside it, fading away from it. */
function Neighbours({
  artifactId,
  deck,
  current,
  place,
  onGo,
}: {
  artifactId: string
  deck: DeckOutline
  current: number
  place: Place
  onGo: (slide: number) => void
}) {
  const { t } = useTranslation('artifacts')
  const w = deck.width * place.z
  const h = deck.height * place.z
  return (
    <>
      {([-1, 1] as const).map((d) => {
        const slide = deck.slides[current - 1 + d]
        if (!slide) return null
        return (
          <button
            key={`${current}:${d}`}
            type="button"
            tabIndex={-1}
            className="adk-ghost"
            data-side={d < 0 ? 'before' : 'after'}
            title={t(d < 0 ? 'deck.previousNamed' : 'deck.nextNamed', { name: slideName(slide) })}
            style={
              {
                left: d < 0 ? place.x - GHOST_GAP - w : place.x + w + GHOST_GAP,
                top: place.y,
                width: w,
                height: h,
                '--adk-peek': `${PEEK}px`,
              } as CSSProperties
            }
            onClick={() => onGo(slide.number)}
          >
            <SlideThumb artifactId={artifactId} deck={deck} slide={slide} />
          </button>
        )
      })}
    </>
  )
}

/** The speaker notes under the slide, as wide as it; typed in place in Edit. */
function Notes({
  slide,
  text,
  editable,
  style,
  onChange,
  onLeave,
}: {
  slide: number
  text: string
  editable: boolean
  style: CSSProperties
  onChange: (text: string) => void
  onLeave: (text: string) => void
}) {
  const { t } = useTranslation('artifacts')
  return (
    <div className="adk-notes" data-edit={editable || undefined} style={style}>
      <span className="adk-notes__head">
        <b>{t('deck.notes')}</b>
        <span>{t('deck.slide', { number: slide })}</span>
      </span>
      {editable ? (
        <textarea
          className="adk-notes__text"
          value={text}
          maxLength={DECK_NOTES_CHARS}
          placeholder={t('deck.notesEmpty')}
          aria-label={t('deck.notesOf', { number: slide })}
          spellCheck
          onChange={(event) => onChange(event.target.value)}
          onBlur={(event) => onLeave(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              event.currentTarget.blur()
            }
          }}
        />
      ) : (
        <p className="adk-notes__text" data-empty={!text || undefined}>
          {text || t('deck.notesEmpty')}
        </p>
      )}
    </div>
  )
}

/** Every slide at once: a click picks one and shows what to do with it, a double click opens it. */
function DeckGrid({
  artifactId,
  deck,
  current,
  picked,
  cols,
  insets,
  changed,
  changedIn,
  marks,
  comments,
  agent,
  onPick,
  onOpen,
  onPresent,
  onAsk,
}: {
  artifactId: string
  deck: DeckOutline
  current: number
  picked: number | null
  cols: number
  /** The room the open cards take at either side, which the grid keeps clear of. */
  insets: { left: number; right: number }
  changed: ReadonlySet<number>
  changedIn: number
  marks: ReadonlyMap<string, number> | undefined
  comments: ReadonlyMap<number, number>
  agent: SheetAgent | null
  onPick: (slide: number) => void
  onOpen: (slide: number) => void
  onPresent: (slide: number) => void
  onAsk: ((slide: number) => void) | null
}) {
  const { t } = useTranslation('artifacts')
  const wall = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const at = picked ?? current
    wall.current
      ?.querySelector<HTMLElement>(`[data-slide="${at}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [picked, current])
  return (
    <div
      className="adk-grid"
      role="listbox"
      aria-label={t('deck.grid')}
      style={
        {
          '--adk-cols': cols,
          '--adk-ratio': `${deck.width} / ${deck.height}`,
          '--adk-inset-l': `${insets.left}px`,
          '--adk-inset-r': `${insets.right}px`,
        } as CSSProperties
      }
    >
      <div ref={wall} className="adk-grid__wall">
        {deck.slides.map((slide) => {
          const on = slide.number === picked
          const count = comments.get(slide.number) ?? 0
          return (
            <div
              key={slide.number}
              className="adk-grid__item"
              data-slide={slide.number}
              data-on={on || undefined}
              data-current={slide.number === current || undefined}
            >
              {on && (
                <div
                  className="k-ce-fbar adk-grid__bar"
                  role="toolbar"
                  aria-label={slideName(slide)}
                >
                  <button
                    type="button"
                    className="k-ce-fbar__btn"
                    data-primary=""
                    onClick={() => onOpen(slide.number)}
                  >
                    {t('frame.open')}
                    <Kbd>↵</Kbd>
                  </button>
                  <button
                    type="button"
                    className="k-ce-fbar__btn"
                    title={t('canvas.presentFrom')}
                    aria-label={t('canvas.presentFrom')}
                    onClick={() => onPresent(slide.number)}
                  >
                    <HugeiconsIcon icon={PlayIcon} size={14} strokeWidth={1.9} />
                  </button>
                  {onAsk && agent && (
                    <button
                      type="button"
                      className="k-ce-fbar__btn"
                      title={t('sheet.ask', { agent: agent.name })}
                      aria-label={t('sheet.ask', { agent: agent.name })}
                      onClick={() => onAsk(slide.number)}
                    >
                      <span className="aps-ask__mark" aria-hidden>
                        {agent.mark}
                      </span>
                    </button>
                  )}
                </div>
              )}
              <button
                type="button"
                role="option"
                aria-selected={on}
                className="adk-grid__pick"
                onClick={() => onPick(slide.number)}
                onDoubleClick={() => onOpen(slide.number)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  onOpen(slide.number)
                }}
              >
                <span className="adk-grid__label">
                  <b>{slide.number}</b>
                  <span className="adk-grid__name">{slideName(slide)}</span>
                  {changed.has(slide.number) && (
                    <span className="k-pages__mark" data-changed="">
                      {t('pages.version', {
                        version: marks?.get(`${slide.number}`) ?? changedIn,
                      })}
                    </span>
                  )}
                  {count > 0 && (
                    <span className="k-pages__mark">
                      <HugeiconsIcon icon={Comment01Icon} size={11} strokeWidth={2} />
                      {count}
                    </span>
                  )}
                </span>
                <span className="adk-grid__tile">
                  <SlideThumb artifactId={artifactId} deck={deck} slide={slide} />
                </span>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** The deck's dock: the Slides card, the pager, the fit, Notes, the grid, Ask, and the save. */
function DeckDock({
  count,
  current,
  tag,
  grid,
  fit,
  notes,
  slides,
  agent,
  save,
  linked,
  onStep,
  onFit,
  onNotes,
  onGrid,
  onAsk,
  onRetry,
  onUndo,
  compare,
}: {
  count: number
  current: number
  /** The version that changed the slide shown, for its tag. */
  tag: number | null
  grid: boolean
  fit: FitMode
  notes: boolean
  slides: { shown: boolean; toggle: () => void } | null
  agent: SheetAgent | null
  save: Save | null
  linked: boolean
  onStep: (direction: 1 | -1) => void
  onFit: (fit: FitMode) => void
  onNotes: () => void
  onGrid: () => void
  onAsk: (() => void) | null
  onRetry: () => void
  onUndo: () => void
  compare: CompareSwitch | null
}) {
  const { t } = useTranslation('artifacts')
  const { tier } = useShell()
  const narrow = tier === 'narrow'
  const words = tier === 'wide'
  const ask =
    onAsk && agent ? { label: t('sheet.ask', { agent: agent.name }), mark: agent.mark } : null

  const slidesButton = slides && (
    <DockButton
      label={t('deck.slides')}
      icon={SidebarLeftIcon}
      pressed={slides.shown}
      onClick={slides.toggle}
    />
  )
  const gridButton = (
    <DockButton label={t('deck.gridKey')} icon={GridViewIcon} pressed={grid} onClick={onGrid} />
  )
  if (grid) {
    return (
      <ViewerSlot slot="dock">
        {slidesButton}
        {slidesButton && <DockRule />}
        {gridButton}
      </ViewerSlot>
    )
  }

  const pager = (
    <>
      <DockButton
        label={t('deck.previous')}
        icon={ArrowLeft01Icon}
        disabled={current <= 1}
        onClick={() => onStep(-1)}
      />
      <span className="avs-dock__count adk-where">
        {t('canvas.counter', { number: current, count })}
        {tag !== null && <span className="k-pages__mark" data-changed="">{`v${tag}`}</span>}
      </span>
      <DockButton
        label={t('deck.next')}
        icon={ArrowRight01Icon}
        disabled={current >= count}
        onClick={() => onStep(1)}
      />
    </>
  )
  const saveParts = save && (
    <>
      <DockRule />
      <SaveChip save={sheetSave(save, t)} onRetry={onRetry} />
      <DockButton
        label={t('doc.undo')}
        icon={Undo02Icon}
        disabled={!save.undo || save.state === 'saving' || !linked}
        onClick={onUndo}
      />
    </>
  )

  if (narrow) {
    const more: MenuItem[] = [
      ...(slides
        ? [{ label: t('deck.slides'), checked: slides.shown, onSelect: slides.toggle }]
        : []),
      { label: t('deck.notes'), checked: notes, onSelect: onNotes },
      ...(['auto', 'screen', 'width', 'actual'] as const).map((mode, i) => ({
        label: t(`reading.fit.${mode}`),
        checked: fit === mode,
        divider: i === 0,
        onSelect: () => onFit(mode),
      })),
      ...(ask ? [{ label: ask.label, logo: ask.mark, divider: true, onSelect: onAsk! }] : []),
    ]
    return (
      <ViewerSlot slot="dock">
        {pager}
        <DockRule />
        {gridButton}
        <Dropdown
          side="top"
          align="end"
          items={more}
          trigger={({ open, toggle }) => (
            <button
              type="button"
              aria-label={t('viewer.more')}
              title={t('viewer.more')}
              aria-expanded={open}
              aria-haspopup="menu"
              onClick={toggle}
              className="avs-dock__btn"
            >
              <Icon icon={MoreHorizontalIcon} size={15} />
            </button>
          )}
        />
        {saveParts}
        {compare && <CompareDock compare={compare} />}
      </ViewerSlot>
    )
  }

  return (
    <ViewerSlot slot="dock">
      {slidesButton}
      {slidesButton && <DockRule />}
      {pager}
      <DockRule />
      <FitMenu value={fit} onChange={onFit} />
      <DockButton
        label={t('deck.notes')}
        icon={words ? undefined : Note01Icon}
        pressed={notes}
        onClick={onNotes}
      >
        {words ? t('deck.notes') : undefined}
      </DockButton>
      {gridButton}
      {ask && (
        <>
          <DockRule />
          <button
            type="button"
            title={ask.label}
            aria-label={ask.label}
            onClick={onAsk!}
            className="avs-dock__btn aps-ask"
          >
            <span className="aps-ask__mark" aria-hidden>
              {ask.mark}
            </span>
          </button>
        </>
      )}
      {saveParts}
      {compare && <CompareDock compare={compare} />}
    </ViewerSlot>
  )
}
