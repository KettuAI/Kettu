import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown01Icon,
  ArrowUp02Icon,
  Comment01Icon,
  Cursor01Icon,
  PlusSignIcon,
  Tick02Icon,
  UserIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import {
  isAnswered,
  isPending,
  type ArtifactComment,
  type CommentAnchor,
  type CommentThread,
} from '@shared/artifact-comments'
import type { SessionSummary } from '@shared/agent-host'
import { emitAppEvent } from '@renderer/app/events'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Dropdown, Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import {
  flushDraft,
  NEW_SESSION_DRAFT,
  readDraft,
  writeDraft,
} from '@renderer/features/session/composer/drafts'
import { SettingsStyles } from '@renderer/features/routines/kit'
import { longAgo } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { formatShortcut, isMod } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { openNewSession } from '@renderer/stores/view'
import { anchorLabel, commentsPrompt } from './anchors'

const BOX_WIDTH = 340
const BOX_GAP = 14

/** The anchor a comment or selection points at, as a quiet chip of plain text. */
export function AnchorChip({ anchor, className }: { anchor: CommentAnchor; className?: string }) {
  const { t } = useTranslation('artifacts')
  return (
    <span className={cn('k-av-anchor', className)}>
      <Icon icon={Cursor01Icon} size={13} />
      <span className="k-av-anchor__text">{anchorLabel(anchor)}</span>
      {anchor.missing && <em>{t('comments.elementGone')}</em>}
    </span>
  )
}

function sendKey(event: React.KeyboardEvent): boolean {
  return (
    event.key === 'Enter' &&
    isMod(event.nativeEvent) &&
    !event.nativeEvent.isComposing &&
    event.keyCode !== 229
  )
}

/**
 * The box a comment is written in, beside the element picked in comment mode: its anchor, the
 * text, and Comment, which Mod+Enter presses too. `point` is where the pick was, in the window.
 */
export function CommentBox({
  anchor,
  point,
  onCancel,
  onSubmit,
}: {
  anchor: CommentAnchor
  point: { x: number; y: number }
  onCancel: () => void
  onSubmit: (body: string) => Promise<void>
}) {
  const { t } = useTranslation('artifacts')
  const box = useRef<HTMLDivElement>(null)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)

  // Under the pick, inside the area, or above it when it would run off the bottom.
  useLayoutEffect(() => {
    const el = box.current
    const area = el?.offsetParent?.getBoundingClientRect()
    if (!el || !area) return
    const height = el.offsetHeight
    const left = Math.min(Math.max(12, point.x - area.left - 24), area.width - BOX_WIDTH - 12)
    const below = point.y - area.top + BOX_GAP
    const top = below + height > area.height - 12 ? point.y - area.top - height - BOX_GAP : below
    setAt({ left, top: Math.max(12, top) })
  }, [point])

  const submit = () => {
    if (!body.trim() || busy) return
    setBusy(true)
    onSubmit(body).then(
      () => setBusy(false),
      (reason: unknown) => {
        setBusy(false)
        setError(errorMessage(reason))
      },
    )
  }

  return (
    <div
      ref={box}
      role="dialog"
      aria-label={t('comments.new')}
      style={{ width: BOX_WIDTH, left: at?.left ?? 0, top: at?.top ?? 0 }}
      // Placed after its first layout; invisible would keep the text box from taking the focus.
      data-placed={at ? '' : undefined}
      className="k-av-compose"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <AnchorChip anchor={anchor} />
      <textarea
        autoFocus
        value={body}
        rows={3}
        maxLength={4_000}
        placeholder={t('comments.placeholder')}
        aria-label={t('comments.new')}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (!sendKey(event)) return
          event.preventDefault()
          submit()
        }}
        className="k-av-text"
      />
      {error && (
        <p role="alert" className="k-av-error">
          {error}
        </p>
      )}
      <div className="k-av-compose__foot">
        <span className="k-av-compose__hint">
          {t('comments.sendHint', { keys: formatShortcut('Mod+Enter') })}
        </span>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('comments.cancel')}
        </Button>
        <Button size="sm" disabled={!body.trim()} loading={busy} onClick={submit}>
          {t('comments.comment')}
        </Button>
      </div>
    </div>
  )
}

/** Where comments can go: a session of the artifact's project, or a new session. */
export const NEW_SESSION = 'new'

/**
 * The sessions comments can be sent to, the artifact's project's: the editing ones first, then
 * the one that wrote it last, then the rest by when they were last used.
 */
function useTargets(project: string, preferred: readonly string[]): SessionSummary[] {
  const sessions = useSessionsStore(
    useShallow((s) =>
      Object.values(s.byId).filter(
        (session) =>
          session.projectPath === project &&
          session.origin === 'user' &&
          session.parentId === null &&
          session.archivedAt === null,
      ),
    ),
  )
  return useMemo(() => {
    const rank = (id: string) => {
      const at = preferred.indexOf(id)
      return at < 0 ? preferred.length : at
    }
    return sessions.toSorted((a, b) => rank(a.id) - rank(b.id) || b.updatedAt - a.updatedAt)
  }, [sessions, preferred])
}

/** Sends the threads to a session as one user message, or opens New session with it drafted. */
async function sendThreads(
  artifact: { id: string; title: string; version: number; project: string },
  threads: CommentThread[],
  target: string,
): Promise<boolean> {
  const text = commentsPrompt(artifact, threads)
  if (target === NEW_SESSION) {
    const draft = readDraft(NEW_SESSION_DRAFT)
    writeDraft(NEW_SESSION_DRAFT, draft.trim() ? `${draft}\n\n${text}` : text)
    flushDraft(NEW_SESSION_DRAFT)
    openNewSession(artifact.project, null)
    emitAppEvent({ kind: 'draft-written', draft: NEW_SESSION_DRAFT })
    return false
  }
  await host('sessions.queue', { sessionId: target, content: [{ type: 'text', text }] })
  await host('artifacts.markSent', {
    id: artifact.id,
    threadIds: threads.map((thread) => thread.id),
    sessionId: target,
  })
  return true
}

/**
 * The viewer's Comments: a card for each thread, open ones first, and at the foot the open
 * comments not yet sent, for the session picked beside them.
 */
export function CommentsPanel({
  artifact,
  threads,
  error,
  preferred,
  onFocus,
}: {
  artifact: { id: string; title: string; version: number; project: string }
  threads: CommentThread[] | null
  error: string | null
  /** The sessions to offer first: the editing ones, then the last writer. */
  preferred: readonly string[]
  onFocus: (thread: CommentThread) => void
}) {
  const { t } = useTranslation(['artifacts', 'common'])
  const [showResolved, setShowResolved] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const targets = useTargets(artifact.project, preferred)
  const target = picked ?? targets[0]?.id ?? NEW_SESSION
  const open = threads?.filter((thread) => thread.resolvedAt === null) ?? []
  const resolved = threads?.filter((thread) => thread.resolvedAt !== null) ?? []
  const pending = open.filter(isPending)
  const name = (session: SessionSummary) => session.title ?? t('common:untitledSession')

  const send = () => {
    if (pending.length === 0 || sending) return
    setSending(true)
    const session = targets.find((s) => s.id === target)
    sendThreads(artifact, pending, target)
      .then((sent) => {
        if (sent && session) {
          toast(t('comments.sent', { count: pending.length, session: name(session) }), undefined, {
            tone: 'success',
          })
        }
      })
      .catch((reason: unknown) =>
        toast(t('comments.sendFailed', { error: errorMessage(reason) }), undefined, {
          tone: 'warning',
        }),
      )
      .finally(() => setSending(false))
  }

  const pickedSession = targets.find((session) => session.id === target)
  return (
    <div className="k-av-comments">
      <SettingsStyles />
      <div className="k-av-side__body">
        {error && !threads && <p className="k-av-error">{error}</p>}
        {!threads && !error && (
          <div aria-busy className="k-av-side__wait">
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        )}
        {threads && threads.length === 0 && (
          <div className="k-av-side__empty">
            <Icon icon={Comment01Icon} size={18} />
            <p>{t('comments.empty')}</p>
          </div>
        )}
        {open.map((thread, i) => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            number={i + 1}
            artifactId={artifact.id}
            onFocus={onFocus}
          />
        ))}
        {resolved.length > 0 && (
          <button
            type="button"
            aria-expanded={showResolved}
            onClick={() => setShowResolved((shown) => !shown)}
            className="k-av-link"
          >
            {t(showResolved ? 'comments.hideResolved' : 'comments.showResolved', {
              count: resolved.length,
            })}
          </button>
        )}
        {showResolved &&
          resolved.map((thread) => (
            <ThreadCard
              key={thread.id}
              thread={thread}
              number={null}
              artifactId={artifact.id}
              onFocus={onFocus}
            />
          ))}
      </div>
      {open.length > 0 && (
        <div className="k-av-send">
          <p>
            {pending.length > 0
              ? t('comments.sendLead', { count: pending.length })
              : t('comments.allSent')}
          </p>
          <div className="k-av-send__row">
            <Dropdown
              side="top"
              className="k-av-send__to"
              items={[
                ...targets.map((session) => ({
                  label: name(session),
                  logo: (
                    <AgentMark agent={session.agentId} size={14} hostId={hostOfSession(session)} />
                  ),
                  checked: session.id === target,
                  onSelect: () => setPicked(session.id),
                })),
                {
                  label: t('comments.newSession'),
                  icon: PlusSignIcon,
                  checked: target === NEW_SESSION,
                  divider: targets.length > 0,
                  onSelect: () => setPicked(NEW_SESSION),
                },
              ]}
              trigger={({ open: menuOpen, toggle }) => (
                <button
                  type="button"
                  aria-label={t('comments.sendTo')}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={toggle}
                  className="ui-ss-select k-av-send__pick"
                >
                  {pickedSession ? (
                    <AgentMark
                      agent={pickedSession.agentId}
                      size={14}
                      hostId={hostOfSession(pickedSession)}
                    />
                  ) : (
                    <Icon icon={PlusSignIcon} size={14} />
                  )}
                  <span>{pickedSession ? name(pickedSession) : t('comments.newSession')}</span>
                  <Icon icon={ArrowDown01Icon} size={14} />
                </button>
              )}
            />
            <Button
              size="sm"
              icon={<Icon icon={ArrowUp02Icon} size={14} />}
              disabled={pending.length === 0}
              loading={sending}
              onClick={send}
            >
              {t('comments.send')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function Author({ comment }: { comment: ArtifactComment }) {
  const { t } = useTranslation(['artifacts', 'common'])
  const now = useNow()
  const session = useSessionsStore((s) =>
    comment.author.session === null ? null : (s.byId[comment.author.session] ?? null),
  )
  const who =
    comment.author.session === null
      ? t('comments.you')
      : (session?.title ?? t('common:untitledSession'))
  return (
    <span className="k-av-author">
      {comment.author.session === null ? (
        <span className="k-av-author__you">
          <Icon icon={UserIcon} size={12} />
        </span>
      ) : session ? (
        <AgentMark agent={session.agentId} size={16} hostId={hostOfSession(session)} />
      ) : (
        <span className="k-av-author__you" />
      )}
      <b>{who}</b>
      <span className="k-av-author__time">{longAgo(comment.createdAt, now)}</span>
    </span>
  )
}

/** One thread: its comments, its anchor, Resolve, and a reply of the user's own. */
function ThreadCard({
  thread,
  number,
  artifactId,
  onFocus,
}: {
  thread: CommentThread
  /** Its pin's number; null for a resolved thread, which has none. */
  number: number | null
  artifactId: string
  onFocus: (thread: CommentThread) => void
}) {
  const { t } = useTranslation('artifacts')
  const [replying, setReplying] = useState(false)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [first, ...replies] = thread.comments
  const resolved = thread.resolvedAt !== null
  const failed = (reason: unknown) =>
    toast(t('comments.failed', { error: errorMessage(reason) }), undefined, { tone: 'warning' })

  const send = () => {
    if (!reply.trim() || busy) return
    setBusy(true)
    host('artifacts.reply', { id: artifactId, threadId: thread.id, body: reply })
      .then(() => {
        setReply('')
        setReplying(false)
      }, failed)
      .finally(() => setBusy(false))
  }

  if (!first) return null
  return (
    <article className="ui-sg-card k-av-thread" data-resolved={resolved || undefined}>
      <div className="k-av-thread__head">
        {number !== null && (
          <span className="k-av-pin" data-answered={isAnswered(thread) || undefined}>
            {number}
          </span>
        )}
        <Author comment={first} />
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={t(resolved ? 'comments.reopen' : 'comments.resolve')}
                aria-pressed={resolved}
                onClick={() =>
                  void host('artifacts.resolve', {
                    id: artifactId,
                    threadId: thread.id,
                    resolved: !resolved,
                  }).catch(failed)
                }
                className="ui-as-icon-btn k-av-btn k-av-resolve"
              />
            }
          >
            <Icon icon={Tick02Icon} size={15} />
          </TooltipTrigger>
          <TooltipContent>{t(resolved ? 'comments.reopen' : 'comments.resolve')}</TooltipContent>
        </Tooltip>
      </div>
      <button type="button" onClick={() => onFocus(thread)} className="k-av-thread__anchor">
        <AnchorChip anchor={thread.anchor} />
      </button>
      <p className="k-av-thread__body">{first.body}</p>
      {replies.map((comment, i) => (
        <div key={i} className="k-av-reply">
          <Author comment={comment} />
          <p className="k-av-thread__body">{comment.body}</p>
        </div>
      ))}
      {!resolved &&
        (replying ? (
          <div className="k-av-thread__write">
            <textarea
              autoFocus
              value={reply}
              rows={2}
              maxLength={4_000}
              aria-label={t('comments.reply')}
              placeholder={t('comments.replyPlaceholder')}
              onChange={(event) => setReply(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  setReplying(false)
                }
                if (!sendKey(event)) return
                event.preventDefault()
                send()
              }}
              className="k-av-text"
            />
            <div className="k-av-thread__acts">
              <Button variant="ghost" size="sm" onClick={() => setReplying(false)}>
                {t('comments.cancel')}
              </Button>
              <Button size="sm" disabled={!reply.trim()} loading={busy} onClick={send}>
                {t('comments.reply')}
              </Button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setReplying(true)} className="k-av-link">
            {t('comments.reply')}
          </button>
        ))}
    </article>
  )
}
