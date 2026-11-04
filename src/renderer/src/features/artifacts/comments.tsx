import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpIcon,
  CheckIcon,
  MessageSquareIcon,
  MousePointer2Icon,
  PlusIcon,
  UserRoundIcon,
} from 'lucide-react'
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
import { Button } from '@renderer/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Textarea } from '@renderer/components/ui/textarea'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import {
  flushDraft,
  NEW_SESSION_DRAFT,
  readDraft,
  writeDraft,
} from '@renderer/features/session/composer/drafts'
import { longAgo } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { formatShortcut, isMod } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openNewSession } from '@renderer/stores/view'
import { anchorLabel, commentsPrompt } from './anchors'

const BOX_WIDTH = 340
const BOX_GAP = 14

/** The anchor a comment or selection points at, as a quiet chip of plain text. */
export function AnchorChip({ anchor, className }: { anchor: CommentAnchor; className?: string }) {
  const { t } = useTranslation('artifacts')
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1.5 rounded-lg bg-subtle px-2 py-1 text-small text-secondary',
        className,
      )}
    >
      <MousePointer2Icon className="size-3.25 shrink-0 text-tertiary" />
      <span className="min-w-0 truncate">{anchorLabel(anchor)}</span>
      {anchor.missing && (
        <span className="shrink-0 text-tertiary">{t('comments.elementGone')}</span>
      )}
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
      className={cn(
        'absolute z-20 flex animate-in flex-col gap-2.5 rounded-2xl bg-popover p-3 shadow-menu fade-in duration-(--duration-fast)',
        // Placed after its first layout; invisible would keep the text box from taking the focus.
        !at && 'pointer-events-none opacity-0',
      )}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      <AnchorChip anchor={anchor} className="self-start" />
      <Textarea
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
        className="max-h-60 min-h-20 resize-none"
      />
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-tertiary">
          {t('comments.sendHint', { keys: formatShortcut('Mod+Enter') })}
        </span>
        <Button variant="quiet" size="sm" onClick={onCancel}>
          {t('comments.cancel')}
        </Button>
        <Button size="sm" disabled={!body.trim() || busy} onClick={submit}>
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
        {error && !threads && <p className="px-1 py-2 text-xs text-danger">{error}</p>}
        {!threads && !error && (
          <div aria-busy className="flex flex-col gap-3 px-1 py-2">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        )}
        {threads && threads.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <MessageSquareIcon className="size-5 text-tertiary" />
            <p className="text-small text-secondary">{t('comments.empty')}</p>
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
            className="self-start rounded-tile px-2 py-1 text-xs text-tertiary outline-none hover:text-secondary focus-ring"
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
        <div className="flex shrink-0 flex-col gap-2 px-3 pt-3 pb-3 shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]">
          <p className="px-1 text-small text-secondary">
            {pending.length > 0
              ? t('comments.sendLead', { count: pending.length })
              : t('comments.allSent')}
          </p>
          <div className="flex items-center gap-2">
            <Select
              value={target}
              items={[
                ...targets.map((session) => ({ value: session.id, label: name(session) })),
                { value: NEW_SESSION, label: t('comments.newSession') },
              ]}
              onValueChange={(next) => {
                if (typeof next === 'string') setPicked(next)
              }}
            >
              <SelectTrigger
                aria-label={t('comments.sendTo')}
                className="h-8 min-w-0 flex-1 gap-2 rounded-xl pr-2 pl-2.5 text-control *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {targets.map((session) => (
                    <SelectItem key={session.id} value={session.id}>
                      <AgentMark agent={session.agentId} size={14} />
                      <span className="min-w-0 truncate">{name(session)}</span>
                    </SelectItem>
                  ))}
                </SelectGroup>
                {targets.length > 0 && <SelectSeparator />}
                <SelectGroup>
                  <SelectItem value={NEW_SESSION}>
                    <PlusIcon className="size-3.5" />
                    {t('comments.newSession')}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button size="sm" disabled={pending.length === 0 || sending} onClick={send}>
              <ArrowUpIcon data-icon="inline-start" />
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
    <span className="flex min-w-0 items-center gap-2 text-small text-tertiary">
      {comment.author.session === null ? (
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-tile">
          <UserRoundIcon className="size-3 text-secondary" />
        </span>
      ) : session ? (
        <AgentMark agent={session.agentId} size={16} className="shrink-0" />
      ) : (
        <span className="size-5 shrink-0 rounded-full bg-tile" />
      )}
      <span className="min-w-0 truncate">
        {who} · {longAgo(comment.createdAt, now)}
      </span>
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
    <article
      className={cn(
        'flex flex-col gap-2.5 rounded-xl bg-surface p-3 shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]',
        resolved && 'opacity-70',
      )}
    >
      <div className="flex items-center gap-2">
        {number !== null && (
          <span
            className={cn(
              'grid size-5 shrink-0 place-items-center rounded-full text-badge font-semibold tabular-nums text-canvas',
              isAnswered(thread) ? 'bg-muted-foreground' : 'bg-edit-ring',
            )}
          >
            {number}
          </span>
        )}
        <Author comment={first} />
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="quiet"
                size="icon-xs"
                aria-label={t(resolved ? 'comments.reopen' : 'comments.resolve')}
                aria-pressed={resolved}
                onClick={() =>
                  void host('artifacts.resolve', {
                    id: artifactId,
                    threadId: thread.id,
                    resolved: !resolved,
                  }).catch(failed)
                }
                className="text-tertiary aria-pressed:text-success"
              />
            }
          >
            <CheckIcon />
          </TooltipTrigger>
          <TooltipContent>{t(resolved ? 'comments.reopen' : 'comments.resolve')}</TooltipContent>
        </Tooltip>
      </div>
      <button
        type="button"
        onClick={() => onFocus(thread)}
        className="self-start rounded-lg outline-none focus-ring"
      >
        <AnchorChip anchor={thread.anchor} />
      </button>
      <p className="text-ui break-words whitespace-pre-wrap text-primary">{first.body}</p>
      {replies.map((comment, i) => (
        <div
          key={i}
          className="flex flex-col gap-1.5 pt-2.5 shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]"
        >
          <Author comment={comment} />
          <p className="text-ui break-words whitespace-pre-wrap text-primary">{comment.body}</p>
        </div>
      ))}
      {!resolved &&
        (replying ? (
          <div className="flex flex-col gap-2">
            <Textarea
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
              className="min-h-14 resize-none"
            />
            <div className="flex justify-end gap-2">
              <Button variant="quiet" size="sm" onClick={() => setReplying(false)}>
                {t('comments.cancel')}
              </Button>
              <Button size="sm" disabled={!reply.trim() || busy} onClick={send}>
                {t('comments.reply')}
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setReplying(true)}
            className="self-start rounded-tile text-xs text-tertiary outline-none hover:text-secondary focus-ring"
          >
            {t('comments.reply')}
          </button>
        ))}
    </article>
  )
}
