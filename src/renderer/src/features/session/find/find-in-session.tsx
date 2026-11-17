import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Search01Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { SearchIndexing, SessionFindMatch } from '@shared/agent-host'
import { longEnough, queryWords } from '@shared/search-fold'
import { onAppEvent } from '@renderer/app/events'
import { IconAction } from '@renderer/components/copy-action'
import { Spinner } from '@renderer/components/ui/spinner'
import { usePaneFocused } from '@renderer/features/split/pane-context'
import { errorCode, errorMessage, host } from '@renderer/lib/host'
import { showFind, useFindStore } from '@renderer/stores/find'
import { useThreadsStore } from '@renderer/stores/threads'
import { useJumpToMessage } from '../outline/use-jump'
import type { ThreadJumps } from '../thread'
import { clearMarks, MESSAGE_BODY, rangesOf, setMarks } from './find-marks'

/** How long the query rests before the host is asked. */
const REST_MS = 120
/** How long a change of the thread rests before the same query is asked again. */
const REFRESH_MS = 600
/** An answer later than this is slow, and the count shows a spinner. */
const SLOW_MS = 150
/** How often the marks are drawn again while the thread scrolls or changes. */
const MARK_MS = 200
/** A match this near the top or bottom of the view is moved in; the bar covers the top. */
const EDGE = 72
/** The longest line of selected text that fills the field when the bar opens. */
const PREFILL_CHARS = 100
/** Passes a scroll to a match may take, as the messages near it render at their real height. */
const REVEAL_PASSES = 4

type Status = 'idle' | 'searching' | 'done' | 'failed' | 'unsupported'

interface Found {
  matches: SessionFindMatch[]
  capped: boolean
  indexing: SearchIndexing | null
}

/** The match the thread is taken to; `nonce` lets a step back to the same one scroll again. */
interface Target {
  entryId: string
  pos: number
  nonce: number
}

/** The selected text of the thread when it is one short line. */
function selectedLine(view: HTMLElement | null): string | null {
  const selection = window.getSelection()
  if (!view || !selection || selection.isCollapsed || !view.contains(selection.anchorNode)) {
    return null
  }
  const text = selection.toString().trim()
  return text !== '' && !text.includes('\n') && text.length <= PREFILL_CHARS ? text : null
}

/**
 * Finding in the session on screen, as Mod+F does in a page: a bar over the thread's top right,
 * the host's list of the session's messages that hold the words, and the thread taken to each.
 * The words are marked in the messages near the view. Inside the message scroller.
 */
export function FindInSession({
  sessionId,
  viewport,
  content,
  jumps,
}: {
  sessionId: string
  viewport: RefObject<HTMLDivElement | null>
  content: RefObject<HTMLDivElement | null>
  jumps: ThreadJumps
}) {
  const { t } = useTranslation('session')
  const focused = usePaneFocused()
  const { jumpTo } = useJumpToMessage(sessionId, viewport, content, jumps)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Found | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [failure, setFailure] = useState('')
  const [slow, setSlow] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [target, setTarget] = useState<Target | null>(null)
  const [focusTick, setFocusTick] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const leftFocus = useRef<HTMLElement | null>(null)
  const nonce = useRef(0)
  const owner = useRef({})
  // What the last request was for, to tell a new query from the same one asked again.
  const asked = useRef({ text: '', version: 0 })
  const current = useRef<string | null>(null)

  const words = useMemo(() => queryWords(query.trim()), [query])
  const ready = longEnough(words)
  const text = words.join(' ')
  // A new message or turn changes what a find would list.
  const version = useThreadsStore((s) => s.replicas[sessionId]?.state?.order.length ?? 0)
  // What a query too short to ask for leaves behind is not shown.
  const shown = ready ? found : null
  const shownStatus: Status = ready ? status : 'idle'
  const matches = shown?.matches
  const ids = useMemo(() => new Set((matches ?? []).map((m) => m.entryId)), [matches])
  const index =
    matches && currentId !== null ? matches.findIndex((m) => m.entryId === currentId) : -1

  useEffect(() => {
    current.current = currentId
  }, [currentId])

  const go = useCallback((match: SessionFindMatch) => {
    setCurrentId(match.entryId)
    setTarget({ entryId: match.entryId, pos: match.pos, nonce: ++nonce.current })
  }, [])

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setFound(null)
    setStatus('idle')
    setCurrentId(null)
    setTarget(null)
    const back = leftFocus.current
    leftFocus.current = null
    if (back?.isConnected) back.focus()
  }, [])

  // Mod+F, in the pane in focus.
  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.kind !== 'find-in-session' || !focused) return
        if (!open) {
          const active = document.activeElement
          leftFocus.current = active instanceof HTMLElement ? active : null
        }
        const line = selectedLine(viewport.current)
        if (line) setQuery(line)
        setOpen(true)
        setFocusTick((tick) => tick + 1)
      }),
    [focused, open, viewport],
  )
  useEffect(() => {
    if (!open) return
    input.current?.focus()
    input.current?.select()
  }, [open, focusTick])

  // Asks the host once the query rests, and again, more slowly, as the thread changes.
  useEffect(() => {
    if (!open || !ready) {
      asked.current = { text: '', version: 0 }
      return
    }
    const same = asked.current.text === text
    asked.current = { text, version }
    let live = true
    const timer = setTimeout(
      () => {
        setStatus((now) => (now === 'done' ? now : 'searching'))
        const slowTimer = setTimeout(() => live && setSlow(true), SLOW_MS)
        host('sessions.find', { sessionId, query: text })
          .then((answer) => {
            if (!live) return
            const list = answer.matches
            setFound({ matches: list, capped: answer.capped, indexing: answer.indexing ?? null })
            setStatus('done')
            // The same query asked again keeps the match the reader is at.
            const kept = same ? list.find((m) => m.entryId === current.current) : undefined
            if (kept) return
            const newest = list.at(-1)
            if (newest) go(newest)
            else setCurrentId(null)
          })
          .catch((error: unknown) => {
            if (!live) return
            setStatus(errorCode(error) === 'unknown_method' ? 'unsupported' : 'failed')
            setFailure(errorMessage(error))
          })
          .finally(() => {
            clearTimeout(slowTimer)
            if (live) setSlow(false)
          })
      },
      same ? REFRESH_MS : REST_MS,
    )
    return () => {
      live = false
      clearTimeout(timer)
      setSlow(false)
    }
  }, [open, ready, text, version, sessionId, attempt, go])

  /** Marks the words in the messages near the view, and the current message apart. */
  const mark = (): void => {
    const view = viewport.current
    const column = content.current
    if (!view || !column || !matches || matches.length === 0 || !ready) {
      clearMarks(owner.current)
      return
    }
    const box = view.getBoundingClientRect()
    const top = box.top - box.height
    const bottom = box.bottom + box.height
    const others: Range[] = []
    const now: Range[] = []
    for (const child of column.children) {
      if (!(child instanceof HTMLElement)) continue
      const id = child.dataset.messageId
      if (!id || !ids.has(id)) continue
      const isCurrent = id === current.current
      if (!isCurrent) {
        const rect = child.getBoundingClientRect()
        if (rect.bottom < top || rect.top > bottom) continue
      }
      for (const body of child.querySelectorAll(MESSAGE_BODY)) {
        ;(isCurrent ? now : others).push(...rangesOf(body, words))
      }
    }
    setMarks(owner.current, others, now)
  }

  /** Scrolls the first word of the message into the view, if it is not in it already. */
  const reveal = (entryId: string): void => {
    const view = viewport.current
    const column = content.current
    if (!view || !column) return
    const item = [...column.children].find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.dataset.messageId === entryId,
    )
    const range = item
      ? [...item.querySelectorAll(MESSAGE_BODY)]
          .flatMap((body) => rangesOf(body, words))
          .reduce<Range | undefined>(
            (first, next) =>
              !first || next.compareBoundaryPoints(Range.START_TO_START, first) < 0 ? next : first,
            undefined,
          )
      : undefined
    if (!item || !range) return
    for (let pass = 0; pass < REVEAL_PASSES; pass++) {
      const rect = range.getBoundingClientRect()
      const box = view.getBoundingClientRect()
      if (rect.height === 0) {
        item.scrollIntoView({ block: 'start', behavior: 'instant' })
        continue
      }
      if (rect.top >= box.top + EDGE && rect.bottom <= box.bottom - EDGE) return
      view.scrollTo({
        top: view.scrollTop + rect.top - box.top - box.height / 3,
        behavior: 'instant',
      })
    }
  }

  const latest = useRef({ jumpTo, mark, reveal, matches })
  useEffect(() => {
    latest.current = { jumpTo, mark, reveal, matches }
  })

  // The outline marks the matches while the bar is open, and may ask for one of them.
  useEffect(() => {
    showFind(sessionId, open && matches && matches.length > 0 ? { matches, currentId } : null)
  }, [sessionId, open, matches, currentId])
  useEffect(() => () => showFind(sessionId, null), [sessionId])
  useEffect(() => {
    // An ask from before this bar was mounted is not its own.
    let seen = useFindStore.getState().asked[sessionId]?.nonce ?? 0
    return useFindStore.subscribe((state) => {
      const ask = state.asked[sessionId]
      if (!ask || ask.nonce === seen) return
      seen = ask.nonce
      const match = latest.current.matches?.find((m) => m.entryId === ask.entryId)
      if (match) go(match)
    })
  }, [sessionId, go])

  // Takes the thread to the match: loads and renders the message when it is not rendered yet.
  useEffect(() => {
    if (!target) return
    let live = true
    void (async () => {
      const rendered = (): boolean =>
        [...(content.current?.children ?? [])].some(
          (child) => child instanceof HTMLElement && child.dataset.messageId === target.entryId,
        )
      if (!rendered()) {
        const arrived = await latest.current.jumpTo(
          { entryId: target.entryId, pos: target.pos },
          { instant: true },
        )
        if (!live || !arrived) return
      }
      latest.current.reveal(target.entryId)
      latest.current.mark()
    })()
    return () => {
      live = false
    }
  }, [target, content])

  // Keeps the marks drawn as the thread scrolls, renders more and grows.
  useEffect(() => {
    const view = viewport.current
    const column = content.current
    if (!view || !column || !matches || matches.length === 0) {
      clearMarks(owner.current)
      return
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = (): void => {
      timer ??= setTimeout(() => {
        timer = null
        latest.current.mark()
      }, MARK_MS)
    }
    latest.current.mark()
    view.addEventListener('scroll', schedule, { passive: true })
    const observer = new MutationObserver(schedule)
    observer.observe(column, { childList: true, subtree: true, characterData: true })
    const by = owner.current
    return () => {
      if (timer) clearTimeout(timer)
      view.removeEventListener('scroll', schedule)
      observer.disconnect()
      clearMarks(by)
    }
  }, [viewport, content, matches, currentId, words])

  const step = (direction: 1 | -1): void => {
    if (!matches || matches.length === 0) return
    const at =
      index < 0
        ? direction === 1
          ? 0
          : matches.length - 1
        : (index + direction + matches.length) % matches.length
    go(matches[at]!)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === 'Enter' && event.target === input.current) {
      event.preventDefault()
      if (shownStatus === 'failed') setAttempt((count) => count + 1)
      else step(event.shiftKey ? -1 : 1)
    }
  }

  if (!open) return null

  const total = matches?.length ?? 0
  const count =
    shownStatus === 'failed'
      ? t('find.failed')
      : shown === null
        ? ''
        : total === 0
          ? t('find.none')
          : `${index + 1} / ${total}${shown.capped ? '+' : ''}`
  const note =
    shownStatus === 'unsupported'
      ? t('find.unsupported')
      : shown?.indexing
        ? t('find.indexing')
        : query.trim() !== '' && !ready
          ? t('find.short')
          : null

  return (
    <div role="search" className="ks-find" onKeyDown={onKeyDown}>
      <div className="ks-find__bar">
        <HugeiconsIcon
          icon={Search01Icon}
          strokeWidth={1.9}
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <input
          ref={input}
          value={query}
          placeholder={t('find.placeholder')}
          aria-label={t('find.placeholder')}
          spellCheck={false}
          autoComplete="off"
          className="ks-find__input"
          onChange={(event) => setQuery(event.target.value)}
        />
        <span
          role="status"
          title={shownStatus === 'failed' ? failure : undefined}
          className="ks-find__count"
          data-state={
            shownStatus === 'failed' ? 'failed' : shown && total === 0 ? 'none' : undefined
          }
        >
          {slow && shownStatus === 'searching' ? (
            <Spinner aria-hidden className="size-3.5" />
          ) : (
            count
          )}
        </span>
        <IconAction label={t('find.previous')} disabled={total === 0} onClick={() => step(-1)}>
          <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={1.9} aria-hidden />
        </IconAction>
        <IconAction label={t('find.next')} disabled={total === 0} onClick={() => step(1)}>
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={1.9} aria-hidden />
        </IconAction>
        <IconAction label={t('find.close')} onClick={close}>
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.9} aria-hidden />
        </IconAction>
      </div>
      {note && <p className="ks-find__note">{note}</p>}
    </div>
  )
}
