import { useEffect, useEffectEvent, useId, useState, type RefObject } from 'react'
import { onAppEvent } from '@renderer/app/events'
import { usePane } from '@renderer/features/split/pane-context'
import { prefersReducedMotion } from '@renderer/stores/settings'
import {
  commentsOf,
  useReplyComments,
  useReplyCommentsStore,
} from '@renderer/stores/reply-comments'
import type { ThreadJumps } from './thread'
import { useJumpToMessage } from './outline/use-jump'
import { findPassage } from './passage-range'

// Painted over the passages of comments waiting in the composer, and more strongly over the one
// whose row is pointed at. Highlights are named once for the document, so every thread on screen
// adds its ranges to the same two.
const MARK = 'reply-comment'
const MARK_HOVER = 'reply-comment-hover'

const marked = new Map<string, { all: Range[]; hover: Range[] }>()

function paint(): void {
  const all = [...marked.values()]
  CSS.highlights.set(MARK, new Highlight(...all.flatMap((m) => m.all)))
  CSS.highlights.set(MARK_HOVER, new Highlight(...all.flatMap((m) => m.hover)))
}

function messageOf(column: HTMLElement, entryId: string): HTMLElement | null {
  return column.querySelector<HTMLElement>(
    `[data-agent-message][data-entry-id="${CSS.escape(entryId)}"]`,
  )
}

interface Badge {
  id: string
  number: number
  top: number
  left: number
}

const sameBadges = (a: Badge[], b: Badge[]): boolean =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i]!
    return x.id === y.id && x.number === y.number && x.top === y.top && x.left === y.left
  })

/**
 * The passages that comments waiting in the composer are on: a light tint over each and its
 * number at its end, without changing the messages' markup. The last child of the thread's
 * column, which it lies over.
 */
export function ReplyMarks({
  sessionId,
  viewport,
  content,
  jumps,
}: {
  sessionId: string
  viewport: RefObject<HTMLElement | null>
  content: RefObject<HTMLElement | null>
  jumps: ThreadJumps
}) {
  const key = useId()
  const paneId = usePane()?.paneId ?? null
  const comments = useReplyComments(sessionId)
  const hovered = useReplyCommentsStore((s) => s.hovered)
  const [badges, setBadges] = useState<Badge[]>([])
  const [layer, setLayer] = useState<HTMLDivElement | null>(null)
  const { jumpTo } = useJumpToMessage(sessionId, viewport, content, jumps)

  useEffect(() => {
    const column = layer?.parentElement
    if (!layer || !column) return
    let frame = 0
    const place = (): void => {
      frame = 0
      const all: Range[] = []
      const hover: Range[] = []
      const next: Badge[] = []
      const origin = column.getBoundingClientRect()
      comments.forEach((comment, index) => {
        const message = messageOf(column, comment.entryId)
        const range = message && findPassage(message, comment)
        if (!range) return
        all.push(range)
        if (comment.id === hovered) hover.push(range)
        const rects = range.getClientRects()
        const last = rects[rects.length - 1]
        if (!last || (last.width === 0 && last.height === 0)) return
        next.push({
          id: comment.id,
          number: index + 1,
          top: Math.round(last.top - origin.top),
          left: Math.round(last.right - origin.left),
        })
      })
      marked.set(key, { all, hover })
      paint()
      setBadges((current) => (sameBadges(current, next) ? current : next))
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(place)
    }
    schedule()
    // Streaming, a page rendered or a reflow moves or replaces the text the ranges are on.
    const mutations = new MutationObserver((records) => {
      if (records.some((r) => !layer.contains(r.target))) schedule()
    })
    mutations.observe(column, { childList: true, subtree: true, characterData: true })
    const sizes = new ResizeObserver(schedule)
    sizes.observe(column)
    return () => {
      cancelAnimationFrame(frame)
      mutations.disconnect()
      sizes.disconnect()
      marked.delete(key)
      paint()
    }
  }, [comments, hovered, key, layer])

  const reveal = useEffectEvent((commentId: string) => {
    const comment = commentsOf(sessionId).find((c) => c.id === commentId)
    const view = viewport.current
    const column = content.current
    if (!comment || !view || !column) return
    const show = (): boolean => {
      const message = messageOf(column, comment.entryId)
      const range = message && findPassage(message, comment)
      const rect = range?.getBoundingClientRect()
      if (!rect) return false
      const bounds = view.getBoundingClientRect()
      const top = view.scrollTop + rect.top - bounds.top - view.clientHeight / 3
      view.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
      return true
    }
    if (show()) return
    void jumpTo({ entryId: comment.entryId, pos: null }, { instant: true }).then((arrived) => {
      if (arrived) show()
    })
  })

  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.kind !== 'reveal-comment' || event.sessionId !== sessionId) return
        if (event.paneId === null || event.paneId === paneId) reveal(event.commentId)
      }),
    [sessionId, paneId],
  )

  if (comments.length === 0) return null
  return (
    <div ref={setLayer} aria-hidden className="ks-reply-marks">
      {badges.map((badge) => (
        <span
          key={badge.id}
          className="ks-reply-num ks-reply-mark"
          data-hovered={badge.id === hovered || undefined}
          style={{ top: badge.top, left: badge.left }}
        >
          {badge.number}
        </span>
      ))}
    </div>
  )
}
