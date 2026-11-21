import { useState, type KeyboardEvent } from 'react'
import { Cancel01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { emitAppEvent } from '@renderer/app/events'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { Glyph } from '@renderer/features/shell/glyph'
import { usePane } from '@renderer/features/split/pane-context'
import {
  editComment,
  hoverComment,
  removeComments,
  useReplyComments,
  type ReplyComment,
} from '@renderer/stores/reply-comments'

/**
 * The comments on passages that go with the next message, on the box's upper edge, numbered in
 * thread order as the thread marks their passages.
 */
export function CommentList({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('composer')
  const comments = useReplyComments(sessionId)
  if (comments.length === 0) return null
  return (
    <section
      className="ks-comments animate-in fade-in animation-duration-(--duration-fast) motion-reduce:animate-none"
      aria-label={t('comments.label')}
      data-composer-own=""
    >
      <div className="ks-comments__head">
        <p className="min-w-0 flex-1 truncate">
          {t('comments.header', { count: comments.length })}
        </p>
        <Button variant="quiet" size="xs" onClick={() => removeComments(sessionId)}>
          {t('comments.removeAll')}
        </Button>
      </div>
      <ol className="ks-comments__list" onPointerLeave={() => hoverComment(null)}>
        {comments.map((comment, index) => (
          <CommentRow key={comment.id} sessionId={sessionId} comment={comment} number={index + 1} />
        ))}
      </ol>
    </section>
  )
}

function CommentRow({
  sessionId,
  comment,
  number,
}: {
  sessionId: string
  comment: ReplyComment
  number: number
}) {
  const { t } = useTranslation('composer')
  const paneId = usePane()?.paneId ?? null
  const [editing, setEditing] = useState<string | null>(null)

  const save = () => {
    const text = editing?.trim()
    // Emptied, the comment stays as it was; x removes it.
    if (text && text !== comment.comment) editComment(sessionId, comment.id, text)
    setEditing(null)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      // Esc in the composer stops the turn; here it only leaves the edit.
      event.preventDefault()
      event.stopPropagation()
      setEditing(null)
      return
    }
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    save()
  }

  return (
    <li
      className="ks-comments__row"
      onPointerEnter={() => hoverComment(comment.id)}
      // Keyboard focus marks the passage as pointing does; a click's focus does not hold it.
      onFocus={(event) => {
        if (event.target.matches(':focus-visible')) hoverComment(comment.id)
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hoverComment(null)
      }}
    >
      <span className="ks-reply-num" aria-hidden>
        {number}
      </span>
      <div className="min-w-0">
        <button
          type="button"
          className="ks-comments__quote"
          title={comment.passage}
          aria-label={t('comments.show', { number })}
          onClick={() =>
            emitAppEvent({ kind: 'reveal-comment', sessionId, paneId, commentId: comment.id })
          }
        >
          {comment.passage}
        </button>
        {editing === null ? (
          <button
            type="button"
            className="ks-comments__text"
            aria-label={t('comments.edit', { number })}
            onClick={() => setEditing(comment.comment)}
          >
            {comment.comment}
          </button>
        ) : (
          <Textarea
            autoFocus
            rows={1}
            value={editing}
            aria-label={t('comments.edit', { number })}
            onChange={(event) => setEditing(event.target.value)}
            onKeyDown={onKeyDown}
            onBlur={save}
            className="ks-comments__edit"
          />
        )}
      </div>
      <Button
        variant="quiet"
        size="icon-xs"
        className="ks-comments__remove"
        aria-label={t('comments.remove', { number })}
        onClick={() => removeComments(sessionId, [comment.id])}
      >
        <Glyph icon={Cancel01Icon} />
      </Button>
    </li>
  )
}
