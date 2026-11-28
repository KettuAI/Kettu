import { useRef, useState } from 'react'
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  Comment01Icon,
  Delete02Icon,
  Location01Icon,
  PlusSignIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { motion, useReducedMotionConfig } from 'motion/react'
import { useTranslation } from 'react-i18next'
import {
  COMMENT_CHARS,
  isPending,
  type CommentAnchor,
  type CommentThread,
} from '@shared/artifact-comments'
import type { VersionSummary } from '@shared/artifacts'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { longAgo } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { formatShortcut } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { anchorLabel } from './anchors'
import { StateTag, Writer } from './comments-card'
import { threadState } from './comment-threads'
import { sendKey, usePopPlace, type LiveAnchor, type OffscreenEdge } from './pop-place'

const POP_W = 320

type Box = { left: number; top: number; right: number; bottom: number }

const OFFSCREEN_ICON: Record<OffscreenEdge, typeof ArrowUp01Icon> = {
  top: ArrowUp01Icon,
  bottom: ArrowDown01Icon,
  left: ArrowLeft01Icon,
  right: ArrowRight01Icon,
}

/** A popover in the content area, beside `at`, rising in as the cards do. */
export function ToolPop({
  at,
  clip = null,
  liveAnchor = null,
  onReturnToAnchor = null,
  offscreenNote,
  backLabel,
  inline = false,
  width = POP_W,
  label,
  onClose,
  className,
  children,
}: {
  /** What it is beside; null for the middle of the content area. */
  at: Box | null
  /** Optional visible viewport clip in window coordinates. */
  clip?: Box | null
  /** Live anchor tracker for dynamic repositioning during iframe/host scrolling. */
  liveAnchor?: LiveAnchor | null
  /** Scrolls the anchored element back into view when the popover docks at a viewport edge. */
  onReturnToAnchor?: (() => void) | null
  /** Custom status line shown when the tracked anchor scrolls out of view. */
  offscreenNote?: string
  /** Custom action label for scrolling back to the tracked anchor. */
  backLabel?: string
  /** Laid out by what holds it, as under a document's block, instead of placed beside `at`. */
  inline?: boolean
  width?: number
  label: string
  onClose: () => void
  className?: string
  children: () => React.ReactNode
}) {
  const { t } = useTranslation('artifacts')
  const ref = useRef<HTMLDivElement>(null)
  const offscreen = usePopPlace(ref, at, width, !inline, { clip, live: liveAnchor })
  const reduce = useReducedMotionConfig()
  return (
    <motion.div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={`k-vt-pop ${className ?? ''}`}
      data-inline={inline || undefined}
      data-offscreen={offscreen ?? undefined}
      style={inline ? undefined : { width }}
      initial={reduce ? false : { y: 6, filter: 'blur(6px)' }}
      animate={{ y: 0, filter: 'blur(0px)', transition: { duration: reduce ? 0 : 0.24 } }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    >
      {!inline && offscreen && onReturnToAnchor && (
        <div className="k-vt-pop__dock" data-edge={offscreen}>
          <span className="k-vt-pop__dock-note">
            <Icon icon={OFFSCREEN_ICON[offscreen]} size={13} />
            <span>{offscreenNote ?? t('comments.anchorOffscreen')}</span>
          </span>
          <button type="button" className="k-vt-pop__dock-back" onClick={onReturnToAnchor}>
            <Icon icon={Location01Icon} size={13} />
            <span>{backLabel ?? t('comments.backToAnchor')}</span>
          </button>
        </div>
      )}
      {children()}
    </motion.div>
  )
}

/**
 * A comment being written beside the pin it drops: what it is pinned to, the text, Cancel and
 * Comment. A failed save keeps what was typed and says why.
 */
export function CommentDraft({
  anchor,
  at,
  liveAnchor = null,
  onReturnToAnchor = null,
  inline = false,
  waiting = null,
  onCancel,
  onSave,
}: {
  anchor: CommentAnchor
  /** What it is beside; null for the middle of the content area. */
  at: Box | null
  liveAnchor?: LiveAnchor | null
  onReturnToAnchor?: (() => void) | null
  inline?: boolean
  /** Said while the computer is away: the comment is saved once it is back. */
  waiting?: string | null
  onCancel: () => void
  onSave: (body: string) => Promise<void>
}) {
  const { t } = useTranslation('artifacts')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = () => {
    if (!body.trim() || busy) return
    setBusy(true)
    setError(null)
    onSave(body).then(
      () => setBusy(false),
      (reason: unknown) => {
        setBusy(false)
        setError(errorMessage(reason))
      },
    )
  }
  return (
    <ToolPop
      at={at}
      liveAnchor={liveAnchor}
      onReturnToAnchor={onReturnToAnchor}
      inline={inline}
      label={t('comments.new')}
      onClose={onCancel}
      className="k-vt-draft"
    >
      {() => (
        <>
          <span className="k-vt-draft__on">
            <Icon icon={Comment01Icon} size={14} />
            <span>{anchorLabel(anchor)}</span>
          </span>
          <textarea
            autoFocus
            value={body}
            rows={2}
            maxLength={COMMENT_CHARS}
            placeholder={t('comments.placeholder')}
            aria-label={t('comments.new')}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (!sendKey(event)) return
              event.preventDefault()
              save()
            }}
            className="k-av-text k-vt-field"
          />
          {error && (
            <p role="alert" className="k-av-error">
              {t('comments.saveFailed', { error })}
            </p>
          )}
          {waiting && !error && <p className="k-vt-waiting">{waiting}</p>}
          <span className="k-vt-pop__foot">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {t('comments.cancel')}
            </Button>
            <Button size="sm" disabled={!body.trim()} loading={busy} onClick={save}>
              {error ? t('viewer.retry') : t('comments.comment')}
              <kbd className="k-vt-kbd">{formatShortcut('Mod+Enter')}</kbd>
            </Button>
          </span>
        </>
      )}
    </ToolPop>
  )
}

/**
 * A pin's thread beside it: what it is pinned to, Resolve, every comment, and a reply of the
 * user's own; a thread whose element is gone offers to pin it again.
 */
export function ThreadPop({
  artifactId,
  thread,
  n,
  versions,
  at,
  liveAnchor = null,
  onReturnToAnchor = null,
  inline = false,
  canResolve = true,
  onClose,
  onRepin,
  onReopened,
  onDelete = null,
  onNewThread = null,
}: {
  artifactId: string
  thread: CommentThread
  n: number
  versions: readonly VersionSummary[] | null
  /** What it is beside; null for the middle of the content area. */
  at: Box | null
  liveAnchor?: LiveAnchor | null
  onReturnToAnchor?: (() => void) | null
  inline?: boolean
  /** Whether the artifact allows changing comment state; false in Recently deleted. */
  canResolve?: boolean
  onClose: () => void
  /** Starts pinning it again with the next click; null where the host cannot. */
  onRepin: (() => void) | null
  /** Called after a resolved thread is reopened from inside the popover. */
  onReopened?: () => void
  /** Requests deleting this thread with confirmation; null when unavailable. */
  onDelete?: (() => void) | null
  /** Starts a separate new comment thread on the same element; null when unavailable. */
  onNewThread?: (() => void) | null
}) {
  const { t } = useTranslation('artifacts')
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const state = threadState(thread, versions)
  const resolved = thread.resolvedAt !== null

  const send = () => {
    if (!reply.trim() || busy) return
    setBusy(true)
    setError(null)
    host('artifacts.reply', { id: artifactId, threadId: thread.id, body: reply })
      .then(
        () => setReply(''),
        (reason: unknown) => setError(errorMessage(reason)),
      )
      .finally(() => setBusy(false))
  }
  const resolve = () =>
    void host('artifacts.resolve', { id: artifactId, threadId: thread.id, resolved: !resolved })
      .then(() => {
        if (!resolved) onClose()
        else onReopened?.()
      })
      .catch((reason: unknown) => setError(errorMessage(reason)))

  return (
    <ToolPop
      at={at}
      liveAnchor={liveAnchor}
      onReturnToAnchor={onReturnToAnchor}
      inline={inline}
      label={t('comments.threadLabel', { n })}
      onClose={onClose}
      className="k-vt-thread"
    >
      {() => (
        <>
          <span className="k-vt-thread__head">
            <b title={anchorLabel(thread.anchor)}>{anchorLabel(thread.anchor)}</b>
            {canResolve && (
              <Button
                variant="ghost"
                size="sm"
                icon={<Icon icon={Tick02Icon} size={14} />}
                onClick={resolve}
              >
                {resolved ? t('comments.reopen') : t('comments.resolve')}
              </Button>
            )}
            {onDelete && (
              <button
                type="button"
                aria-label={t('comments.delete')}
                title={t('comments.delete')}
                onClick={onDelete}
                className="k-vt-icon k-vt-icon--danger"
              >
                <Icon icon={Delete02Icon} size={14} />
              </button>
            )}
            <button
              type="button"
              aria-label={t('comments.close')}
              title={t('comments.close')}
              onClick={onClose}
              className="k-vt-icon"
            >
              <Icon icon={Cancel01Icon} size={14} />
            </button>
          </span>
          <div className="k-vt-thread__list">
            {thread.comments.map((comment, i) => (
              <Message
                key={i}
                comment={comment}
                unsent={
                  isPending(thread) &&
                  i === thread.comments.length - 1 &&
                  comment.author.session === null
                }
              />
            ))}
          </div>
          {state.kind === 'gone' && (
            <div className="k-vt-lost">
              <p>{t('comments.goneText')}</p>
              {onRepin && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Icon icon={Location01Icon} size={14} />}
                  onClick={onRepin}
                >
                  {t('comments.repin')}
                </Button>
              )}
            </div>
          )}
          {state.kind === 'resolved' && (
            <p className="k-vt-thread__done">
              <StateTag state={state} />
            </p>
          )}
          {error && (
            <p role="alert" className="k-av-error k-vt-thread__error">
              {error}
            </p>
          )}
          {!resolved && canResolve && (
            <span className="k-vt-reply">
              <textarea
                value={reply}
                rows={1}
                maxLength={COMMENT_CHARS}
                aria-label={t('comments.reply')}
                placeholder={t('comments.replyPlaceholder')}
                onChange={(event) => setReply(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    !(event.key === 'Enter' && !event.shiftKey) ||
                    event.nativeEvent.isComposing ||
                    event.keyCode === 229
                  ) {
                    return
                  }
                  event.preventDefault()
                  send()
                }}
                className="k-vt-reply__field"
              />
              <button
                type="button"
                aria-label={t('comments.reply')}
                title={t('comments.reply')}
                disabled={!reply.trim() || busy}
                onClick={send}
                className="k-vt-reply__send"
              >
                <Icon icon={ArrowUp02Icon} size={14} />
              </button>
            </span>
          )}
          {onNewThread && (
            <div className="k-vt-thread__foot">
              <Button
                variant="ghost"
                size="sm"
                icon={<Icon icon={PlusSignIcon} size={14} />}
                onClick={onNewThread}
              >
                {t('comments.newThread')}
              </Button>
            </div>
          )}
        </>
      )}
    </ToolPop>
  )
}

/** Explicit confirmation dialog before permanently deleting a comment thread. */
export function DeleteCommentDialog({
  thread,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  thread: CommentThread | null
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation('artifacts')
  const count = thread?.comments.length ?? 0
  return (
    <AlertDialog
      open={thread !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {count > 1 ? t('comments.deleteTitleReplies') : t('comments.deleteTitle')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {count > 1
              ? t('comments.deleteDescriptionReplies', { count })
              : t('comments.deleteDescription')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="k-av-error">
            {t('comments.deleteFailed', { error })}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('comments.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy ? t('comments.deleting') : t('comments.deleteConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function Message({
  comment,
  unsent,
}: {
  comment: CommentThread['comments'][number]
  unsent: boolean
}) {
  const { t } = useTranslation('artifacts')
  const now = useNow()
  return (
    <div className="k-vt-msg">
      <span className="k-vt-msg__meta">
        <Writer comment={comment} />
        <time>{longAgo(comment.createdAt, now)}</time>
        {unsent && (
          <span className="k-vt-tag" data-tone="warning">
            {t('comments.state.notSent')}
          </span>
        )}
      </span>
      <p className="k-vt-msg__text">{comment.body}</p>
    </div>
  )
}
