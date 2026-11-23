// A deck in the artifact viewer: the one slide the window asks for, filling the frame the window
// sized for it. The window draws the pager, the notes, the pins and every card; this page shows the
// slide, finds elements on it, reports a pick and saves the text typed into it.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  DECK_KEPT_TEXTS,
  DECK_TEXT_CHARS,
  DECK_TRACKED,
  type DeckBox,
  type DeckKept,
  type DeckPlace,
  type DeckReport,
  type DeckSaveState,
  type DeckState,
} from '@shared/artifact-runtime/deck-sheet'
import { parseDeck, slideSize, type Deck } from '@shared/artifact-slides'
import type { ViewerConfig } from '@shared/artifact-types'
import { Empty, EmptyDescription, EmptyHeader } from '@renderer/components/ui/empty'
import { useSource, type Loaded } from '../common/use-source'
import { deckStyle, withText, type TextPath } from './deck'
import { SlideView, type SlideEditing } from './slide'
import { Stage } from './stage'
import { report, type DeckAsk } from './use-drive'

/** How long typing rests before it is saved as a version. */
const SAVE_AFTER_MS = 900
/** What a click may pick on a slide: a text, or a picture. */
const PICKABLE = '[data-text], img'

function wordsOf(element: Element): string {
  const words =
    element instanceof HTMLImageElement ? element.alt : ((element as HTMLElement).innerText ?? '')
  return Array.from(words.replace(/\s+/g, ' ').trim()).slice(0, DECK_TEXT_CHARS).join('')
}

/** An element's place on the slide, in the slide's own pixels. */
function boxOn(slide: HTMLElement, element: Element, width: number): DeckBox {
  const frame = slide.getBoundingClientRect()
  const rect = element.getBoundingClientRect()
  const scale = frame.width / width || 1
  return {
    x: (rect.left - frame.left) / scale,
    y: (rect.top - frame.top) / scale,
    width: rect.width / scale,
    height: rect.height / scale,
  }
}

/** The deck with `text` at `path`, or the notes at `path` gone when they are emptied. */
function withTyped(deck: Deck, path: TextPath, text: string): Deck {
  if (path.at(-1) === 'notes' && text.trim() === '') {
    const copy = structuredClone(deck)
    delete copy.slides[path[1] as number]?.notes
    return copy
  }
  return withText(deck, path, text)
}

/** Whether `path` names a text of the deck, or the notes of one of its slides. */
function hasText(deck: Deck, path: TextPath): boolean {
  let at: unknown = deck
  for (const key of path.slice(0, -1)) {
    if (typeof at !== 'object' || at === null || !Object.hasOwn(at, key)) return false
    at = (at as Record<string | number, unknown>)[key]
  }
  if (typeof at !== 'object' || at === null) return false
  const last = path.at(-1)!
  if (last === 'notes' && path.length === 3 && path[0] === 'slides') return true
  return (
    Object.hasOwn(at, last) && typeof (at as Record<string | number, unknown>)[last] === 'string'
  )
}

function deckOf(text: string | undefined): Deck | null {
  if (text === undefined) return null
  const parsed = parseDeck(text)
  return 'deck' in parsed ? parsed.deck : null
}

export function DrivenDeck({
  config,
  state,
  asksRef,
}: {
  config: ViewerConfig
  state: DeckState
  asksRef: RefObject<(ask: DeckAsk) => void>
}) {
  const { t } = useTranslation('viewers')
  const source = useSource(config, state.version)
  const deck = useMemo(() => deckOf(source.loaded?.text), [source.loaded?.text])
  const version = source.loaded?.version ?? config.version
  const count = deck?.slides.length ?? 0
  const index = Math.min(Math.max(0, state.slide - 1), Math.max(0, count - 1))
  const size = slideSize(deck?.aspect)
  const mode = state.mode
  const slideRef = useRef<HTMLDivElement>(null)

  // Saving what was typed: every text changed since the last save, by its path.
  const run = useRef<{
    pending: Map<string, { path: TextPath; text: string }>
    timer: number
    busy: boolean
    again: boolean
    /** The deck before the first save of this run, which Undo writes back. */
    before: Loaded | null
    last: number | null
    state: DeckSaveState | null
  }>({
    pending: new Map(),
    timer: 0,
    busy: false,
    again: false,
    before: null,
    last: null,
    state: null,
  })
  const sourceRef = useRef(source)
  useEffect(() => {
    sourceRef.current = source
  })

  // What an earlier frame typed and could not save, shown over the deck until it saves.
  const [shownKept, setShownKept] = useState<readonly DeckKept[] | null>(null)
  const showsKept = useRef(false)

  const tell = useCallback((next: DeckSaveState, saved: number | null = run.current.last) => {
    run.current.state = next
    // Once a save ends, what still waits is the window's to keep; nothing, once all is written.
    const ended = next !== 'editing' && next !== 'saving'
    report({
      t: 'save',
      state: next,
      version: saved,
      undo: run.current.before !== null,
      ...(ended && { kept: [...run.current.pending.values()].slice(0, DECK_KEPT_TEXTS) }),
    })
  }, [])

  // A save asked for while one ran, once it is done.
  const againRef = useRef<() => Promise<void>>(async () => {})
  const save = useCallback(async (): Promise<void> => {
    const now = run.current
    clearTimeout(now.timer)
    if (now.pending.size === 0) return
    if (now.busy) {
      now.again = true
      return
    }
    const src = sourceRef.current
    const base = src.loaded
    if (!base || src.head === null) return tell('failed')
    const typed = [...now.pending.entries()]
    const apply = (text: string): string | null => {
      let next = deckOf(text)
      if (!next) return null
      for (const [, change] of typed) next = withTyped(next, change.path, change.text)
      return `${JSON.stringify(next, null, 2)}\n`
    }
    let text = apply(base.text)
    if (text === null) return tell('refused')
    if (text === base.text) {
      for (const [key, change] of typed) {
        if (now.pending.get(key)?.text === change.text) now.pending.delete(key)
      }
      return tell(now.last === null ? 'editing' : 'saved')
    }
    now.busy = true
    tell('saving')
    let written = await src.write(src.head, text)
    if (!written.ok && written.code === 'conflict') {
      // Another version came first: the same changes on it.
      const latest = await sourceRef.current.latest()
      text = latest ? apply(latest.text) : null
      written =
        latest && text !== null
          ? await sourceRef.current.write(latest.version, text)
          : { ok: false, code: 'conflict' }
    }
    now.busy = false
    if (!written.ok) {
      tell(
        written.code === 'invalid'
          ? 'refused'
          : written.code === 'conflict'
            ? 'conflict'
            : 'failed',
      )
    } else {
      now.before ??= base
      now.last = written.version
      // What was typed while it saved stays to save next.
      for (const [key, change] of typed) {
        if (now.pending.get(key)?.text === change.text) now.pending.delete(key)
      }
      showsKept.current = false
      setShownKept(null)
      tell('saved', written.version)
    }
    if (now.again) {
      now.again = false
      void againRef.current()
    }
  }, [tell])
  useEffect(() => {
    againRef.current = save
  })

  const undo = useCallback(async (): Promise<void> => {
    const now = run.current
    const src = sourceRef.current
    const before = now.before
    if (!before || src.head === null || now.busy) return
    clearTimeout(now.timer)
    now.pending.clear()
    showsKept.current = false
    setShownKept(null)
    now.busy = true
    tell('saving')
    const written = await src.write(src.head, before.text)
    now.busy = false
    if (!written.ok) return tell(written.code === 'conflict' ? 'conflict' : 'failed')
    now.before = null
    now.last = written.version
    // A text still focused shows what it typed; the version it went back to shows once it is left.
    ;(document.activeElement as HTMLElement | null)?.blur()
    tell('saved', written.version)
  }, [tell])

  const typed = useCallback(
    (path: TextPath, text: string, at: 'input' | 'leave') => {
      const now = run.current
      now.pending.set(JSON.stringify(path), { path, text })
      if (showsKept.current) setShownKept([...now.pending.values()])
      clearTimeout(now.timer)
      if (at === 'leave') {
        void save()
        return
      }
      if (now.state !== 'editing') tell('editing')
      now.timer = window.setTimeout(() => void save(), SAVE_AFTER_MS)
    },
    [save, tell],
  )

  useEffect(() => {
    asksRef.current = (ask) => {
      if (ask.do === 'notes') typed(['slides', ask.slide - 1, 'notes'], ask.text, 'input')
      else if (ask.do === 'undo') void undo()
      else void save()
    }
  }, [asksRef, undo, save, typed])

  // Leaving Edit saves what was typed; a run of saves ends with it.
  useEffect(() => {
    if (mode === 'edit') return
    ;(document.activeElement as HTMLElement | null)?.blur()
    void save().then(() => {
      if (run.current.pending.size === 0) run.current.before = null
    })
  }, [mode, save])

  const keptAsked = state.kept
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !keptAsked?.length || !deck || mode !== 'edit') return
    if (source.head === null || source.head !== version) return
    restored.current = true
    const now = run.current
    if (now.pending.size > 0) return
    // A text a newer version no longer has is left out; with none left, nothing can show.
    const found = keptAsked.filter(({ path }) => hasText(deck, path))
    for (const change of found) now.pending.set(JSON.stringify(change.path), change)
    showsKept.current = found.length > 0
    // After this pass, as typing would set it.
    queueMicrotask(() => {
      if (found.length > 0) setShownKept(found)
      tell(found.length > 0 ? 'failed' : 'conflict')
    })
  }, [keptAsked, deck, mode, source.head, version, tell])
  const shownDeck = useMemo(() => {
    if (!deck || !shownKept) return deck
    let next = deck
    for (const { path, text } of shownKept)
      if (hasText(next, path)) next = withText(next, path, text)
    return next
  }, [deck, shownKept])

  const editing = useMemo<SlideEditing | null>(
    () =>
      mode === 'edit' && source.head !== null && source.head === version
        ? {
            input: (path, text) => typed(path, text, 'input'),
            leave: (path, text) => typed(path, text, 'leave'),
          }
        : null,
    [mode, source.head, version, typed],
  )

  // Where the tracked elements lie on the shown slide, for the window's pins.
  const lastLayout = useRef('')
  const measure = useCallback(() => {
    const slide = slideRef.current?.querySelector<HTMLElement>('.slide')
    if (!slide || !deck) return
    const elements = [...slide.querySelectorAll(PICKABLE)]
    const places: DeckPlace[] = []
    const taken = new Map<Element, string>()
    for (const track of state.track.slice(0, DECK_TRACKED)) {
      const found = elements.find(
        (el) =>
          !taken.has(el) &&
          el.tagName.toLowerCase() === track.tag &&
          wordsOf(el).startsWith(track.text),
      )
      if (!found) continue
      taken.set(found, track.key)
      places.push({ key: track.key, box: boxOn(slide, found, size.width) })
    }
    for (const el of elements) {
      el.toggleAttribute('data-focus', state.focus !== null && taken.get(el) === state.focus)
    }
    const layout: DeckReport = { t: 'layout', version, slide: index + 1, places }
    const json = JSON.stringify(layout)
    if (json === lastLayout.current) return
    lastLayout.current = json
    report(layout)
  }, [deck, state.track, state.focus, version, index, size.width])
  const frame = useRef(0)
  useLayoutEffect(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(measure)
  })
  useEffect(() => {
    const el = slideRef.current
    if (!el) return
    const again = () => {
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(again)
    observer.observe(el)
    // Pictures change where the elements after them lie as they load.
    el.addEventListener('load', again, true)
    return () => {
      observer.disconnect()
      el.removeEventListener('load', again, true)
    }
  }, [measure])

  if (source.failed || (source.loaded && !deck)) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyDescription>{t('load.failed')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  if (!deck || count === 0) return null

  const onClick = (event: MouseEvent): void => {
    if (mode !== 'comment') return
    const slide = slideRef.current?.querySelector<HTMLElement>('.slide')
    const picked = (event.target as Element).closest(PICKABLE)
    if (!slide || !picked || !slide.contains(picked)) return
    event.preventDefault()
    report({
      t: 'pick',
      slide: index + 1,
      tag: picked.tagName.toLowerCase(),
      text: wordsOf(picked),
      box: boxOn(slide, picked, size.width),
    })
  }

  return (
    <main
      ref={slideRef}
      className="deck-driven"
      data-mode={mode}
      style={deckStyle(deck)}
      onClick={onClick}
    >
      <Stage size={size}>
        <SlideView
          slide={(shownDeck ?? deck).slides[index]!}
          index={index}
          editing={editing}
          label={t('slides.slide', { number: index + 1 })}
        />
      </Stage>
    </main>
  )
}
