import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  ArrowDown01Icon,
  Comment01Icon,
  GitCompareIcon,
  MinusSignIcon,
  MoreHorizontalIcon,
  PlusSignIcon,
  SidebarLeftIcon,
  Undo02Icon,
} from '@hugeicons/core-free-icons'
import { useReducedMotionConfig } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { CommentAnchor, CommentThread } from '@shared/artifact-comments'
import { DOCUMENT_ENTRY } from '@shared/artifact-document-anchors'
import { ARTIFACT_ENTRY } from '@shared/artifact-files'
import {
  DOC_TRACKED,
  type DocBox,
  type DocHeading,
  type DocReport,
  type DocState,
  outlineHeadings,
} from '@shared/artifact-runtime/document-sheet'
import { RUNTIME_VERSION, snippet } from '@shared/artifact-runtime/page-messages'
import { Dropdown, Icon, type MenuItem } from '@renderer/components/affect/app-shell'
import { useDark } from '@renderer/hooks/use-dark'
import { DOC_SIZES, setDocSize, stepDocSize, useDocSize } from '@renderer/stores/artifact-doc-size'
import { ArtifactIframe } from './artifact-iframe'
import {
  dropUnsaved,
  keepUnsaved,
  useArtifactUnsavedStore,
} from '@renderer/stores/artifact-unsaved'
import type { ViewerMode } from '@renderer/stores/artifact-viewer'
import { matchingOpenThread, threadNumbers } from './comment-threads'
import { FrameLink } from './frame-link'
import { OutlineCard } from './outline-card'
import type { PlaceAsk, SheetWalk } from './change-walk'
import type { SheetAgent } from './page-sheet'
import { Waiting } from './page-frame'
import { sheetSave } from './sheet-save'
import { useUnsaved } from './unsaved'
import { SaveChip } from './tool-parts'
import { framePageUrl, type ShownVersion } from './use-artifact'
import { DockButton, DockRule, ViewerSlot } from './viewer-shell'
import { useShell } from './viewer-shell-context'
import './document-sheet.css'

/** The ground around the sheet, the band a pill takes above it and the room the dock takes. */
const EDGE = 8
const BAND = 56
const DOCK = 58
const POPOVER_ROOM = 300
/** The widest the sheet grows, and the text inside it. */
const SHEET_MAX = 840
const TEXT = 680
/** Where a heading lands when the sheet is scrolled to it, under the sheet's top. */
const LAND = 32
/** A pin's size and the room between two pins on one block. */
const PIN = 26
const PIN_SMALL = 20
const PIN_GAP = 30

interface Geometry {
  left: number
  top: number
  width: number
  /** The room on either side of the text. */
  pad: number
}

function geometry(room: number, narrow: boolean, band: boolean): Geometry {
  const top = band ? BAND : EDGE
  if (narrow) return { left: EDGE, top, width: Math.max(200, room - 2 * EDGE), pad: 24 }
  const width = Math.max(320, Math.min(SHEET_MAX, room - 32))
  const pad = Math.max(40, Math.min(80, (width - TEXT) / 2))
  return { left: Math.max(EDGE, (room - width) / 2), top, width, pad }
}

/** What the sheet does with comments, which the viewer's comment tools take over from here. */
export interface DocComments {
  threads: CommentThread[] | null
  /** Pins show while comments are on screen: in Comment, or with the comments card open. */
  shown: boolean
  /** Whether the host anchors threads on a document's blocks; an older one takes the page alone. */
  blocks: boolean
  /** The comment being written under a block, pinned to `anchor`, until it saves or `close`. */
  draft: (anchor: CommentAnchor, close: () => void) => ReactNode
  /** What opens under a block for one of its threads, numbered as its pin. */
  thread: (
    thread: CommentThread,
    number: number,
    close: () => void,
    onNewThread?: (() => void) | null,
  ) => ReactNode
}

/** A box in the window, for a popover beside it. */
export type WindowBox = { left: number; top: number; right: number; bottom: number }

/** How a typed change is saving, as the document reports it. */
type Save = Extract<DocReport, { t: 'save' }>

interface Draft {
  at: number
  tag: string
  text: string
  box: DocBox
}

type Selection = Extract<DocReport, { t: 'select' }> & { at: number }

/**
 * A document artifact as one sheet at reading width on the shell's ground, never covered by it:
 * the document's own viewer in a frame as tall as the document, scrolled here, so the pins in its
 * margin, a thread under a block and the bar over selected words lie on the sheet with it. The
 * viewer reports its layout; nothing it reports is more than data.
 */
export function DocumentSheet({
  id,
  url,
  shown,
  title,
  reloads,
  since,
  band,
  latest,
  mode,
  onMode,
  walk,
  asked,
  onAsked,
  onChangesShown,
  comments,
  agent,
  onAsk,
  onHeadings,
  focusThread,
  writing = null,
}: {
  id: string
  url: string
  shown: ShownVersion
  title: string
  reloads: number
  since: number
  /** Whether a pill of the viewer's own sits above the sheet. */
  band: boolean
  latest: boolean
  mode: ViewerMode
  onMode: (mode: ViewerMode) => void
  /** What changed, which the sheet marks and the viewer's pill walks. */
  walk: SheetWalk | null
  /** A section or a changed passage to bring into view, until it is. */
  asked: PlaceAsk | null
  onAsked: (seq: number) => void
  /** Whether Changes shows the earlier words, which the viewer's pill says. */
  onChangesShown: (on: boolean) => void
  comments: DocComments
  agent: SheetAgent | null
  /** Asks the agent about the document, or about the words or block in `anchor`, beside `at`. */
  onAsk: ((anchor: CommentAnchor | null, at: WindowBox | null) => void) | null
  onHeadings: (count: number) => void
  /** A thread chosen in the comments card, to open under its block and scroll to. */
  focusThread: { thread: string; seq: number } | null
  /** An agent writing it: the section's slug, or null for all of it, and the tag's words. */
  writing?: { section: string | null; tag: string } | null
}) {
  const { t } = useTranslation('artifacts')
  const { tier, leftCard } = useShell()
  const reduce = useReducedMotionConfig()
  const dark = useDark()
  const root = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState(0)
  const size = useDocSize(id)
  const narrow = tier === 'narrow'
  const version = shown.version

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setRoom(Math.round(entry.contentRect.width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const marking = !!walk && latest && version === walk.to
  const g = geometry(room || 1280, narrow, band)

  // What the viewer reported last.
  const [layout, setLayout] = useState<Extract<DocReport, { t: 'layout' }> | null>(null)
  const [embedded, setEmbedded] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [openThread, setOpenThread] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [save, setSave] = useState<Save | null>(null)
  useUnsaved(id, !!save && ['failed', 'conflict', 'refused'].includes(save.state))
  const [loaded, setLoaded] = useState(false)
  // A block typed in that did not save before the viewer was left, which the frame shows again.
  const kept = useArtifactUnsavedStore((s) => {
    const change = s.byId[id]?.document
    return change?.kind === 'document' ? change.kept : null
  })

  // The document's frame, loaded once for the artifact; versions come in through the viewer.
  const origin = url.slice(0, -1)
  const [src] = useState(() => `${framePageUrl(url, shown)}?theme=${dark ? 'dark' : 'light'}`)
  const frame = useRef<HTMLIFrameElement | null>(null)
  const link = useMemo(() => new FrameLink(origin, () => {}), [origin])
  const [prevReloads, setPrevReloads] = useState(reloads)
  if (reloads !== prevReloads) {
    setPrevReloads(reloads)
    setEmbedded(false)
    setLayout(null)
    setLoaded(false)
  }

  // What changed, and Changes, which shows its earlier words in the text.
  const passages = useMemo(
    () => (walk?.changes.kind === 'sections' && marking ? walk.changes.passages : []),
    [walk, marking],
  )
  const [changesOn, setChangesOn] = useState(false)
  // The block landed on: a changed passage the pill walks to, or a heading a link names.
  const [step, setStep] = useState<number | null>(null)
  // Another walk starts with Changes off.
  const walkKey = walk ? `${walk.from}:${walk.to}` : null
  const [stepsOf, setStepsOf] = useState(walkKey)
  if (stepsOf !== walkKey) {
    setStepsOf(walkKey)
    setStep(null)
    setChangesOn(false)
  }
  useEffect(() => onChangesShown(changesOn), [changesOn, onChangesShown])
  const changedSlugs = useMemo(
    () => new Set(passages.map((p) => p.section).filter((s) => s !== null)),
    [passages],
  )

  // Pins: the open threads on the document's blocks, numbered as their cards are.
  const pins = useMemo(() => {
    if (!comments.shown || !latest) return []
    const all = comments.threads ?? []
    const numbers = threadNumbers(all)
    return all
      .filter((thread) => thread.resolvedAt === null)
      .map((thread) => ({ thread, n: numbers.get(thread.id) ?? 0 }))
      .filter(
        ({ thread: { anchor } }) =>
          anchor.path === DOCUMENT_ENTRY && anchor.offset !== null && !anchor.missing,
      )
  }, [comments.shown, comments.threads, latest])
  const open = pins.find((p) => p.thread.id === openThread) ?? null
  const focus = draft?.at ?? open?.thread.anchor.offset ?? null

  const track = useMemo(() => {
    const offsets = new Set<number>()
    for (const pin of pins) offsets.add(pin.thread.anchor.offset!)
    for (const passage of passages) offsets.add(passage.from)
    if (draft) offsets.add(draft.at)
    return [...offsets].slice(0, DOC_TRACKED)
  }, [pins, passages, draft])

  const marksFrom = walk?.from ?? 0
  const sectionVersions = useMemo(
    () => (walk && marking ? Object.fromEntries(walk.marks) : undefined),
    [walk, marking],
  )
  const docStep = step
  useEffect(() => {
    const state: DocState = {
      embed: embedded,
      pad: g.pad,
      size,
      theme: dark ? 'dark' : 'light',
      mode: latest ? mode : 'view',
      version,
      track,
      marks: passages.length ? { from: marksFrom, passages, sections: sectionVersions } : null,
      changes: changesOn,
      step: docStep,
      focus,
      still: !!reduce,
      writing,
      kept,
    }
    link.post({ v: RUNTIME_VERSION, kind: 'select-doc', channel: link.channel, state })
  }, [
    link,
    embedded,
    g.pad,
    size,
    dark,
    latest,
    mode,
    version,
    track,
    passages,
    marksFrom,
    sectionVersions,
    changesOn,
    docStep,
    focus,
    reduce,
    writing,
    kept,
  ])

  const onReport = useRef<(doc: DocReport) => void>(() => {})
  useEffect(() => {
    onReport.current = (doc) => {
      switch (doc.t) {
        case 'layout':
          setLayout(doc)
          // Reports reach this window, so the viewer can lay the whole document out for it.
          setEmbedded(true)
          return
        case 'pick': {
          const existing = comments.blocks
            ? matchingOpenThread(
                comments.threads ?? [],
                {
                  version,
                  path: DOCUMENT_ENTRY,
                  page: null,
                  offset: doc.at,
                  tag: doc.tag,
                  text: doc.text,
                  missing: false,
                },
                openThread,
              )
            : null
          if (existing) {
            setDraft(null)
            setOpenThread(existing.id)
          } else {
            setOpenThread(null)
            setDraft({ at: doc.at, tag: doc.tag, text: doc.text, box: doc.box })
          }
          return
        }
        case 'select':
          setSelection(doc.at === null ? null : (doc as Selection))
          return
        case 'save':
          setSave(doc)
          // What did not save is kept beyond this viewer, until it saves or is discarded.
          if (doc.kept) keepUnsaved(id, { kind: 'document', kept: doc.kept })
          else if (doc.kept === null || doc.state === 'saved') dropUnsaved(id, 'document')
      }
    }
  })
  const escape = useRef<() => boolean>(() => false)
  useEffect(() => {
    link.open()
    link.docs((doc) => onReport.current(doc))
    link.keys((key) => {
      if (key === 'Escape') escape.current()
    })
    return () => link.dispose()
  }, [link])

  const outline = useMemo(() => outlineHeadings(layout?.headings ?? []), [layout])
  const headingCount = outline.length
  useEffect(() => onHeadings(headingCount), [headingCount, onHeadings])

  // The section on screen: the last heading near the top, or the one picked in the Outline while
  // the sheet stays where the pick took it, which near the end can leave later headings in view.
  const [view, setView] = useState({ top: 0, height: 0, end: false })
  const [picked, setPicked] = useState<{ slug: string; top: number } | null>(null)
  const current = useMemo(() => {
    const heads = outline
    if (heads.length === 0) return null
    if (picked && Math.abs(view.top - picked.top) < 2) return picked.slug
    const line = view.end ? view.top + view.height * 0.8 : view.top + LAND + 24
    let slug = heads[0]!.slug
    for (const h of heads) if (h.y <= line) slug = h.slug
    return slug
  }, [outline, view, picked])
  const scrollFrame = useRef(0)
  const onScroll = useCallback(() => {
    cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = requestAnimationFrame(() => {
      const sc = scroller.current
      if (!sc) return
      setView({
        top: sc.scrollTop,
        height: sc.clientHeight,
        end: sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4,
      })
    })
  }, [])
  useEffect(() => {
    const sc = scroller.current
    if (!sc) return
    const observer = new ResizeObserver(onScroll)
    observer.observe(sc)
    if (sc.firstElementChild) observer.observe(sc.firstElementChild)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(scrollFrame.current)
    }
  }, [onScroll])

  const placeOf = useCallback(
    (at: number) => layout?.places.find((p) => p.at === at) ?? null,
    [layout],
  )
  // A box on the sheet's content in the window, read when a popover opens beside it.
  const windowBox = (box: DocBox): WindowBox | null => {
    const rect = content.current?.getBoundingClientRect()
    if (!rect) return null
    const left = rect.left + box.x
    const top = rect.top + box.y
    return { left, top, right: left + box.width, bottom: top + box.height }
  }
  const scrollTo = useCallback(
    (y: number) =>
      scroller.current?.scrollTo({
        top: Math.max(0, y - LAND),
        behavior: reduce ? 'auto' : 'smooth',
      }),
    [reduce],
  )
  const goTo = (heading: DocHeading) => {
    const sc = scroller.current
    if (sc) {
      const top = Math.min(Math.max(0, heading.y - LAND), sc.scrollHeight - sc.clientHeight)
      setPicked({ slug: heading.slug, top })
    }
    scrollTo(heading.y)
  }

  // A thread chosen in the comments card opens under its block, which comes into view once placed.
  const [focusSeen, setFocusSeen] = useState(focusThread?.seq ?? 0)
  if (focusThread && focusSeen !== focusThread.seq) {
    setFocusSeen(focusThread.seq)
    setDraft(null)
    setOpenThread(focusThread.thread)
  }
  const scrolledFor = useRef(0)
  useEffect(() => {
    if (!focusThread || scrolledFor.current === focusThread.seq) return
    const pin = pins.find((p) => p.thread.id === focusThread.thread)
    const place = pin ? placeOf(pin.thread.anchor.offset!) : null
    if (!place) return
    scrolledFor.current = focusThread.seq
    scrollTo(place.y)
  }, [focusThread, pins, placeOf, scrollTo])

  // A place asked for: a changed passage once its place is known, or a section's heading.
  const [askedSeen, setAskedSeen] = useState<{ seq: number; y: number | null } | null>(null)
  if (asked && layout && askedSeen?.seq !== asked.seq) {
    let y: number | null = null
    let at: number | null = null
    let waits = false
    if (asked.at !== undefined) {
      at = asked.at
      y = placeOf(asked.at)?.y ?? null
      // A passage not laid out yet waits for the next layout.
      waits = y === null && passages.some((p) => p.from === asked.at)
    } else if (asked.section !== undefined) {
      const heading = outline.find((h) => h.slug === asked.section)
      if (heading) {
        at = heading.at
        y = heading.y
      }
    }
    if (!waits) {
      setAskedSeen({ seq: asked.seq, y })
      setStep(asked.flash ? at : null)
    }
  }
  const askScrolled = useRef(0)
  useEffect(() => {
    if (!askedSeen || askScrolled.current === askedSeen.seq) return
    askScrolled.current = askedSeen.seq
    if (askedSeen.y !== null) scrollTo(askedSeen.y)
    onAsked(askedSeen.seq)
  }, [askedSeen, scrollTo, onAsked])

  // Esc lets go of one layer at a time: the selected words, the comment being written, the thread
  // open, then Changes.
  useEffect(() => {
    escape.current = () => {
      if (selection) setSelection(null)
      else if (draft) setDraft(null)
      else if (openThread) setOpenThread(null)
      else if (changesOn) setChangesOn(false)
      else return false
      return true
    }
  })
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const active = document.activeElement
      if (active && active !== document.body && !root.current?.contains(active)) return
      if (escape.current()) event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // What a comment or a question points at: a block of the document, or the page on older hosts.
  const anchorAt = (at: number, tag: string, text: string): CommentAnchor =>
    comments.blocks
      ? { version, path: DOCUMENT_ENTRY, page: null, offset: at, tag, text, missing: false }
      : {
          version,
          path: ARTIFACT_ENTRY,
          page: null,
          offset: null,
          tag: null,
          text: snippet(text),
          missing: false,
        }

  // Leaving Comment puts the comment being written away; a change saved leaves Edit quietly, one
  // that did not save stays said.
  const [modeWas, setModeWas] = useState(mode)
  if (modeWas !== mode) {
    setModeWas(mode)
    if (mode !== 'comment') setDraft(null)
    if (mode !== 'view') setSelection(null)
    if (mode !== 'edit' && save && ['saved', 'editing', 'saving'].includes(save.state))
      setSave(null)
  }

  // A thread opened, or a comment begun, is scrolled into view once laid out under its block.
  const shownAt = draft?.at ?? openThread
  useEffect(() => {
    if (shownAt === null) return
    const frame = requestAnimationFrame(() =>
      content.current
        ?.querySelector('.ads-pop')
        ?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' }),
    )
    return () => cancelAnimationFrame(frame)
  }, [shownAt, reduce])

  // A comment being written or a thread open under the last blocks still has room below them.
  const sheetHeight = embedded && layout ? layout.height + (draft || open ? POPOVER_ROOM : 0) : null
  // A pin sits in the right margin, from the content's edge so a scrollbar never covers it, and
  // smaller where the margin is narrow.
  const pinSize = g.pad < PIN + 8 ? PIN_SMALL : PIN
  const pinRight = Math.max(2, g.pad / 2 - pinSize / 2)

  return (
    <>
      <div ref={root} className="ads-room">
        {room > 0 && (
          <div
            ref={scroller}
            className="ads-sheet"
            data-embedded={embedded || undefined}
            style={{ left: g.left, top: g.top, width: g.width, bottom: DOCK }}
            onScroll={onScroll}
            onPointerDown={() => {
              if (narrow && leftCard?.shown) leftCard.setShown(false)
            }}
          >
            <div
              ref={content}
              className="ads-content"
              style={sheetHeight !== null ? { height: sheetHeight } : undefined}
            >
              <ArtifactIframe
                iframeRef={(el) => {
                  frame.current = el
                  link.attach(el)
                }}
                src={src}
                reloadSeq={reloads}
                title={title}
                onPortReady={() => link.loaded()}
                onLoad={() => setLoaded(true)}
                className="ads-frame"
                dataLoaded={loaded}
              />
              {pins.map(({ thread, n }) => {
                const place = placeOf(thread.anchor.offset!)
                if (!place) return null
                const before = pins.filter(
                  (p) => p.thread.anchor.offset === thread.anchor.offset && p.n < n,
                ).length
                const active = openThread === thread.id
                return (
                  <button
                    key={thread.id}
                    type="button"
                    className="ads-pin"
                    data-active={active || undefined}
                    data-small={pinSize === PIN_SMALL || undefined}
                    style={{ right: pinRight, top: place.y + 2 + before * PIN_GAP }}
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
                  const place = placeOf(open.thread.anchor.offset!)
                  if (!place) return null
                  return (
                    <div
                      className="ads-pop"
                      style={{ top: place.y + place.height + 8, right: pinRight }}
                    >
                      {comments.thread(
                        open.thread,
                        open.n,
                        () => setOpenThread(null),
                        () => {
                          const at = open.thread.anchor.offset
                          if (at === null) return
                          setOpenThread(null)
                          if (mode !== 'comment') onMode('comment')
                          setDraft({
                            at,
                            tag: open.thread.anchor.tag ?? 'p',
                            text: open.thread.anchor.text,
                            box: { x: 0, y: place.y, width: g.width, height: place.height },
                          })
                        },
                      )}
                    </div>
                  )
                })()}
              {draft &&
                (() => {
                  const anchor = anchorAt(draft.at, draft.tag, draft.text)
                  // Under its block, right edge on the pins' column.
                  const place = placeOf(draft.at)
                  const bottom = place ? place.y + place.height : draft.box.y + draft.box.height
                  return (
                    <div
                      key={`${draft.at}`}
                      className="ads-pop"
                      style={{ top: bottom + 8, right: pinRight }}
                    >
                      {comments.draft(anchor, () => setDraft(null))}
                    </div>
                  )
                })()}
              {selection && mode === 'view' && (
                <SelectionBar
                  selection={selection}
                  width={g.width}
                  agent={agent}
                  canComment={latest}
                  onComment={() => {
                    setSelection(null)
                    onMode('comment')
                    // The words selected are what the comment is on, as for Ask.
                    setDraft({
                      at: selection.at,
                      tag: selection.tag,
                      text: snippet(selection.quote) || selection.text,
                      box: selection.box,
                    })
                  }}
                  onAsk={
                    onAsk
                      ? () => {
                          onAsk(
                            anchorAt(selection.at, selection.tag, snippet(selection.quote)),
                            windowBox(selection.box),
                          )
                          setSelection(null)
                        }
                      : null
                  }
                />
              )}
            </div>
            {!loaded && <Waiting since={since} id={id} />}
          </div>
        )}
      </div>
      {layout && (
        <OutlineCard
          artifactId={id}
          headings={outline}
          current={current}
          changed={changedSlugs}
          version={walk?.to ?? version}
          marks={marking ? walk?.marks : undefined}
          comments={sectionComments(
            outline,
            pins.map((p) => p.thread.anchor.offset!),
          )}
          onPick={goTo}
          writing={latest ? writing?.section : null}
        />
      )}
      <DocDock
        id={id}
        size={size}
        outline={
          leftCard
            ? {
                shown: leftCard.shown,
                toggle: () => leftCard.setShown(!leftCard.shown),
              }
            : null
        }
        changes={
          passages.length
            ? {
                on: changesOn,
                toggle: () => setChangesOn((on) => !on),
              }
            : null
        }
        agent={agent}
        onAsk={onAsk ? () => onAsk(null, null) : null}
        save={mode === 'edit' || (save && save.state !== 'saved') ? save : null}
        onRetry={() => link.post({ v: RUNTIME_VERSION, kind: 'select-doc-do', do: 'retry' })}
        onUndo={() => link.post({ v: RUNTIME_VERSION, kind: 'select-doc-do', do: 'undo' })}
      />
    </>
  )
}

/** How many open threads each section holds, by the heading above each thread's block. */
function sectionComments(headings: readonly DocHeading[], offsets: readonly number[]) {
  const out = new Map<string, number>()
  for (const at of offsets) {
    let slug: string | null = null
    for (const h of headings) if (h.at <= at) slug = h.slug
    if (slug) out.set(slug, (out.get(slug) ?? 0) + 1)
  }
  return out
}

/** The small bar over words selected in View: comment on them, or ask the agent about them. */
function SelectionBar({
  selection,
  width,
  agent,
  canComment,
  onComment,
  onAsk,
}: {
  selection: Selection
  width: number
  agent: SheetAgent | null
  canComment: boolean
  onComment: () => void
  onAsk: (() => void) | null
}) {
  const { t } = useTranslation('artifacts')
  const center = selection.box.x + selection.box.width / 2
  return (
    <div
      role="toolbar"
      aria-label={t('doc.selection')}
      className="ads-selbar"
      style={{
        left: Math.max(90, Math.min(width - 90, center)),
        top: Math.max(4, selection.box.y - 40),
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {canComment && (
        <button type="button" className="avs-dock__btn" data-text="" onClick={onComment}>
          <Icon icon={Comment01Icon} size={15} />
          {t('doc.comment')}
        </button>
      )}
      {onAsk && agent && (
        <button type="button" className="avs-dock__btn" data-text="" onClick={onAsk}>
          <span className="aps-ask__mark" aria-hidden>
            {agent.mark}
          </span>
          {t('sheet.ask', { agent: agent.name })}
        </button>
      )}
    </div>
  )
}

/** The document's dock: the Outline, the type size, Changes, Ask, and how an edit is saving. */
function DocDock({
  id,
  size,
  outline,
  changes,
  agent,
  onAsk,
  save,
  onRetry,
  onUndo,
}: {
  id: string
  size: (typeof DOC_SIZES)[number]
  outline: { shown: boolean; toggle: () => void } | null
  changes: { on: boolean; toggle: () => void } | null
  agent: SheetAgent | null
  onAsk: (() => void) | null
  save: Save | null
  onRetry: () => void
  onUndo: () => void
}) {
  const { t } = useTranslation('artifacts')
  const { tier } = useShell()
  const narrow = tier === 'narrow'
  const words = tier === 'wide'
  const sizes: MenuItem[] = DOC_SIZES.map((n) => ({
    label: t('doc.size', { percent: n }),
    checked: n === size,
    onSelect: () => setDocSize(id, n),
  }))
  const ask =
    onAsk && agent ? { label: t('sheet.ask', { agent: agent.name }), mark: agent.mark } : null
  return (
    <ViewerSlot slot="dock">
      {outline && (
        <>
          <DockButton
            label={t('outline.title')}
            icon={SidebarLeftIcon}
            pressed={outline.shown}
            onClick={outline.toggle}
          />
          <DockRule />
        </>
      )}
      {!narrow && (
        <DockButton
          label={t('doc.smaller')}
          icon={MinusSignIcon}
          disabled={size === DOC_SIZES[0]}
          onClick={() => setDocSize(id, stepDocSize(size, -1))}
        />
      )}
      <Dropdown
        side="top"
        align="start"
        items={sizes}
        title={t('doc.sizeLabel')}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            aria-label={t('doc.sizeButton', { percent: size })}
            aria-expanded={open}
            aria-haspopup="menu"
            onClick={toggle}
            className="avs-dock__btn"
            data-text=""
          >
            <span className="avs-dock__pct">{t('doc.size', { percent: size })}</span>
            {narrow && <Icon icon={ArrowDown01Icon} size={12} />}
          </button>
        )}
      />
      {!narrow && (
        <DockButton
          label={t('doc.larger')}
          icon={PlusSignIcon}
          disabled={size === DOC_SIZES[DOC_SIZES.length - 1]}
          onClick={() => setDocSize(id, stepDocSize(size, 1))}
        />
      )}
      {changes && (
        <>
          <DockRule />
          <DockButton
            label={t('doc.changes')}
            icon={GitCompareIcon}
            pressed={changes.on}
            onClick={changes.toggle}
          >
            {words ? t('doc.changes') : undefined}
          </DockButton>
        </>
      )}
      {ask && (
        <>
          <DockRule />
          {narrow ? (
            <Dropdown
              side="top"
              align="end"
              items={[{ label: ask.label, logo: ask.mark, onSelect: onAsk! }]}
              trigger={({ open, toggle }) => (
                <button
                  type="button"
                  aria-label={t('viewer.more')}
                  title={t('viewer.more')}
                  aria-expanded={open}
                  onClick={toggle}
                  className="avs-dock__btn"
                >
                  <Icon icon={MoreHorizontalIcon} size={15} />
                </button>
              )}
            />
          ) : (
            <button
              type="button"
              title={ask.label}
              aria-label={words ? undefined : ask.label}
              onClick={onAsk!}
              className="avs-dock__btn aps-ask"
              data-text={words ? '' : undefined}
            >
              <span className="aps-ask__mark" aria-hidden>
                {ask.mark}
              </span>
              {words && ask.label}
            </button>
          )}
        </>
      )}
      {save && (
        <>
          <DockRule />
          <SaveChip save={sheetSave(save, t)} onRetry={onRetry} />
          <DockButton
            label={t('doc.undo')}
            icon={Undo02Icon}
            disabled={!save.undo || save.state === 'saving'}
            onClick={onUndo}
          />
        </>
      )}
    </ViewerSlot>
  )
}
